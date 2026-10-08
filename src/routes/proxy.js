import { Router } from "express";
import { HttpsProxyAgent } from "https-proxy-agent";
import { createGunzip, createInflate, createBrotliDecompress, gunzipSync } from "zlib";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import path from "path";
import { sealProxyUrlsInText, unsealProxyPath, tryUnsealQueryPayload, sealedQueryParam, sealedQueryParamDeterministic } from "../lib/proxy-seal.js";
import { buildPublicR2Url } from "../lib/r2-seal.js";
import { HEADERS, MIRURO_API, CC_MEDIA, CC_PLAYLIST, CC_SUBS } from "../config/constants.js";
import { getProxyBase, setCacheForResponse, rewriteM3U8, parsHeaders } from "../lib/proxy.js";
import { proxyFetch } from "../lib/http.js";
import { request as undiciRequest } from "undici";
import { SUBS_DIR } from "../lib/subtitles.js";
import { removeSpamLines } from "../lib/subtitle-cleaner.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import { invalidateStreamsContainingUrl } from "../lib/cache.js";
import { fetchAndDecryptFlixcloudManifest, decryptFlixcloudSegment } from "../lib/flixcloud-decrypt.js";

const router = Router();

// Rate limit para proxies (segmentos/playlists): 1200 req/min por IP.
const proxyLimiter = createRateLimiter({ windowMs: 60_000, max: 1200, message: "Too many proxy requests" });

// CORS para que el reproductor (volumen booster, Web Audio, etc.) pueda consumir
// segmentos/playlists desde cualquier origen sin problemas.
router.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range, Accept, Accept-Language, Content-Language, Content-Type, Origin");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

router.use(proxyLimiter);

// CDNs de megaplay bloqueados por IP/fingerprint → mirrors con el mismo
// contenido. Los streams cacheados (persisten en disco) pueden traer URLs
// viejas de nexabloom/mewstream; el rewrite acá las salva sin re-scrapear.
// Solo se tocan playlists — los segmentos ya vienen en hosts propios
// (tyrionx.top, tiktokcdn.com, etc.) que responden bien.
function rewriteBlockedCdnHost(url) {
  try {
    const u = new URL(url);
    if (u.hostname === "fetch.nexabloom.top") {
      return `https://megap.norami.top${u.pathname.replace(/^\/anime/, "")}${u.search}`;
    }
    if (u.hostname === "cdn.mewstream.buzz") {
      const m = u.pathname.match(/^\/anime\/(.+)/);
      if (m) return `https://9hjkrt.nekostream.site/${m[1]}${u.search}`;
    }
    return url;
  } catch { return url; }
}

// ── UPNShare HLS proxy ───────────────────────────────────────────────────────
function rewriteUpnPlaylist(text, baseUrl, proxyBase, tokenQs = "") {
  const withToken = (abs) => (tokenQs && !abs.includes("?") ? `${abs}?${tokenQs}` : abs);
  return text
    .split("\n")
    .map(line => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#")) {
        return trimmed.replace(/URI="([^"]+)"/g, (_, uri) => {
          try {
            const abs = withToken(new URL(uri, baseUrl).href);
            return `URI="${proxyBase}/upn-seg?u=${encodeURIComponent(abs)}"`;
          } catch { return _; }
        });
      }
      try {
        const abs = withToken(new URL(trimmed, baseUrl).href);
        return `${proxyBase}/upn-seg?u=${encodeURIComponent(abs)}`;
      } catch { return line; }
    })
    .join("\n");
}

router.get("/upn-stream.m3u8", async (req, res) => {
  const cfUrl = req.query.u;
  if (!cfUrl) return res.status(400).json({ error: "Missing u param" });
  const proxyBase = getProxyBase(req);
  const qIdx = cfUrl.indexOf("?");
  const cfPath = qIdx === -1 ? cfUrl : cfUrl.slice(0, qIdx);
  const tokenQs = qIdx === -1 ? "" : cfUrl.slice(qIdx + 1);
  const baseUrl = cfPath.substring(0, cfPath.lastIndexOf("/") + 1);
  try {
    const upstream = await fetch(`${MIRURO_API}/raw-proxy?u=${encodeURIComponent(cfUrl)}&ref=${encodeURIComponent("https://animeav1.uns.bio/")}`, { signal: AbortSignal.timeout(20000) });
    if (!upstream.ok) return res.status(upstream.status).json({ error: `UPNShare upstream: ${upstream.status}` });
    const playlist = rewriteUpnPlaylist(await upstream.text(), baseUrl, proxyBase, tokenQs);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    setCacheForResponse(res, "application/vnd.apple.mpegurl", ".m3u8");
    res.send(playlist);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/upn-seg", async (req, res) => {
  const targetUrl = req.query.u;
  if (!targetUrl) return res.status(400).json({ error: "Missing u param" });
  const proxyBase = getProxyBase(req);
  try {
    const upstream = await fetch(`${MIRURO_API}/raw-proxy?u=${encodeURIComponent(targetUrl)}&ref=${encodeURIComponent("https://animeav1.uns.bio/")}`, { signal: AbortSignal.timeout(25000) });
    if (!upstream.ok) return res.status(upstream.status).end();
    const ct = upstream.headers.get("content-type") || "";
    const qIdx = targetUrl.indexOf("?");
    const targetPath = qIdx === -1 ? targetUrl : targetUrl.slice(0, qIdx);
    const tokenQs = qIdx === -1 ? "" : targetUrl.slice(qIdx + 1);
    if (ct.includes("mpegurl") || ct.includes("x-mpegurl") || targetPath.endsWith(".txt")) {
      const baseUrl = targetPath.substring(0, targetPath.lastIndexOf("/") + 1);
      const content = rewriteUpnPlaylist(await upstream.text(), baseUrl, proxyBase, tokenQs);
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      setCacheForResponse(res, "application/vnd.apple.mpegurl", ".m3u8");
      return res.send(content);
    }
    res.setHeader("Content-Type", "video/mp2t");
    setCacheForResponse(res, "video/mp2t", ".ts");
    upstream.body.pipeTo(new WritableStream({ write(chunk) { res.write(chunk); }, close() { res.end(); }, abort() { res.end(); } }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── FlixCloud manifest proxy ─────────────────────────────────────────────────
// flixcloud.cc (usado por reanime.to) sirve sus .m3u8 (master/video/audio)
// con un doble cifrado: Content-Encoding: zstd a nivel transporte + el body
// destapado es texto base64 que decodeado es el m3u8 real XOReado con una
// clave fija global de 32 bytes (reverseada el 2026-09-06, ver
// lib/flixcloud-decrypt.js). Los segmentos (.webp/.png) tienen SU PROPIO
// cifrado (header falso + XOR de 16 bytes, ver decryptFlixcloudSegment) y
// pasan por /river-seg, no por el /ts-proxy genérico.
const FLIXCLOUD_REFERER = "https://flixcloud.cc/";

function rewriteFlixcloudPlaylist(text, baseUrl, proxyBase, onlyAudioLang, manifestKey) {
  const rewriteAbsolute = (absolute) => {
    if (absolute.includes(".m3u8")) {
      const payload = { u: absolute };
      if (onlyAudioLang) payload.audio = onlyAudioLang;
      if (manifestKey) payload.k = manifestKey;
      return `${proxyBase}/river.m3u8?${sealedQueryParam(payload)}`;
    }
    return `${proxyBase}/river-seg?${sealedQueryParam({ u: absolute })}`;
  };
  const lines = text.split("\n");
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { out.push(line); continue; }
    if (trimmed.startsWith("#")) {
      if (onlyAudioLang && /^#EXT-X-MEDIA:TYPE=AUDIO/.test(trimmed)) {
        const langMatch = trimmed.match(/LANGUAGE="([^"]+)"/);
        if (langMatch && langMatch[1] !== onlyAudioLang) continue;
      }
      let rewritten = line.replace(/URI="([^"]+)"/g, (_, uri) => {
        try {
          return `URI="${rewriteAbsolute(new URL(uri, baseUrl).href)}"`;
        } catch {
          return _;
        }
      });
      if (onlyAudioLang && /^#EXT-X-MEDIA:TYPE=AUDIO/.test(trimmed)) {
        rewritten = rewritten.replace(/DEFAULT=(YES|NO)/, "DEFAULT=YES").replace(/AUTOSELECT=(YES|NO)/, "AUTOSELECT=YES");
      }
      out.push(rewritten);
      continue;
    }
    out.push(rewriteAbsolute(new URL(trimmed, baseUrl).href));
  }
  return out.join("\n");
}

async function handleRiverManifest(req, res) {
  const sealed = tryUnsealQueryPayload(req.query.s);
  const target = (sealed?.u) || req.query.u;
  const onlyAudioLang = sealed?.audio ?? req.query.audio ?? null;
  const manifestKey = sealed?.k ?? req.query.k ?? null;
  if (!target) return res.status(400).json({ error: "Missing target" });
  try {
    const plainText = await fetchAndDecryptFlixcloudManifest(target, FLIXCLOUD_REFERER, manifestKey);
    const proxyBase = getProxyBase(req);
    const rewritten = rewriteFlixcloudPlaylist(plainText, target, proxyBase, onlyAudioLang, manifestKey);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    setCacheForResponse(res, "application/vnd.apple.mpegurl", ".m3u8");
    res.send(rewritten);
  } catch (e) {
    console.warn(`[river.m3u8] ERROR: ${e.message}`);
    if (e.status === 403 || e.status === 404) invalidateStreamsContainingUrl(target);
    res.status(e.status || 500).json({ error: e.message });
  }
}

async function handleRiverSegment(req, res) {
  const sealed = tryUnsealQueryPayload(req.query.s);
  const target = (sealed?.u) || req.query.u;
  if (!target) return res.status(400).json({ error: "Missing target" });
  try {
    const upstream = await fetch(target, {
      headers: { "User-Agent": HEADERS["User-Agent"], Referer: FLIXCLOUD_REFERER, Origin: "https://flixcloud.cc" },
      signal: AbortSignal.timeout(20000),
    });
    if (!upstream.ok) {
      if (upstream.status === 403 || upstream.status === 404) invalidateStreamsContainingUrl(target);
      return res.status(upstream.status).json({ error: `Upstream error: ${upstream.status}` });
    }
    const raw = Buffer.from(await upstream.arrayBuffer());
    const decrypted = decryptFlixcloudSegment(raw);
    res.setHeader("Content-Type", "video/mp2t");
    setCacheForResponse(res, "video/mp2t", target);
    res.send(decrypted);
  } catch (e) {
    console.warn(`[river-seg] ERROR: ${e.message}`);
    res.status(e.status || 500).json({ error: e.message });
  }
}

// Nombre público (canónico):
router.get("/river.m3u8", handleRiverManifest);
router.get("/river-seg", handleRiverSegment);
// Alias legacy (no romper URLs que quedaron cacheadas en respuestas antiguas):
router.get("/flixcloud-m3u8", handleRiverManifest);
router.get("/flixcloud-seg", handleRiverSegment);

// ── Shortlink /dl: redirect 302 a URL de descarga sellada ──────────────────
// Evita que el cliente exponga "sealed:..." ni la URL cruda flixcloud en el body.
// /dl?x=<sealedQueryPayload({ url })> → 302 Location: <url real>
// /dl/info?x=<same> → JSON { url, contentType, hint } (sin redirect, solo metadata)
const dlLimiter = createRateLimiter({ windowMs: 60_000, max: 60, message: "Too many dl requests" });

function unsealDlParam(queryX) {
  if (!queryX) return null;
  try {
    const s = String(queryX);
    const r = tryUnsealQueryPayload(s);
    if (!r || !r.url || typeof r.url !== "string") return null;
    if (!/^https?:\/\//i.test(r.url)) return null;
    return { url: r.url, hint: r.hint || null };
  } catch { return null; }
}

router.get("/dl/info", dlLimiter, (req, res) => {
  const u = unsealDlParam(req.query.x);
  if (!u) return res.status(400).json({ error: "invalid or missing sealed download url" });
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  try {
    const parsed = new URL(u.url);
    return res.json({
      url: u.url,
      hostname: parsed.hostname,
      pathname: parsed.pathname,
      hint: u.hint || null,
    });
  } catch {
    return res.json({ url: u.url, hint: u.hint });
  }
});

router.get("/dl", dlLimiter, (req, res) => {
  const u = unsealDlParam(req.query.x);
  if (!u) return res.status(400).send("Invalid download link");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Pequeña protección anti-leak: Referrer-Policy: no-referrer evita que el
  // server destino vea de qué página vino el link (podría leakear nuestra
  // URL /dl con el token sellado en el Referer si se sigue desde el cliente).
  res.setHeader("Referrer-Policy", "no-referrer");
  try {
    // Validar URL antes de redirect
    new URL(u.url);
  } catch {
    return res.status(400).send("Invalid download destination");
  }
  return res.redirect(302, u.url);
});

// ── Generic HLS proxy ────────────────────────────────────────────────────────
const genericMediaCache = new Map();
function genericHeaders(referer, targetUrl = "") {
  const isZilla = targetUrl.includes("player.zilla-networks.com");
  if (isZilla) {
    return {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
      "Accept": "*/*",
      "Accept-Language": "es-419,es-US;q=0.9,es;q=0.8,en;q=0.7",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
    };
  }
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    "Accept": "*/*",
    ...(referer && { "Referer": referer, "Origin": referer.replace(/\/$/, "") }),
  };
}
function resolveGenericUrl(raw, baseUrl) {
  try { return new URL(raw).href; } catch { return new URL(raw, baseUrl).href; }
}

// Algunos CDNs (vmbox/vmcld de vidmoly, echovideo — los que usan
// animenosub/aniwaves vía Anivexa) sirven el m3u8 ofuscado: cada línea es el
// código ASCII decimal de un caracter ("35 69 88 84 77 51 85" = "#EXTM3U").
// Se detecta porque el body son solo dígitos/espacios y decodifica a #EXTM3U.
function decodeDecimalPlaylist(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("#EXTM3U")) return text;
  if (!/^[0-9\s]+$/.test(trimmed)) return text;
  const decoded = trimmed.split(/\s+/).map((n) => String.fromCharCode(Number(n))).join("");
  return decoded.includes("#EXTM3U") ? decoded : text;
}

function rewriteGenericPlaylist(text, baseUrl, refEnc) {
  return text
    .split("\n")
    .map(line => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (!trimmed.startsWith("#")) {
        const abs = resolveGenericUrl(trimmed, baseUrl);
        return `/generic-seg?u=${encodeURIComponent(abs)}${refEnc}`;
      }
      if (trimmed.startsWith("#EXT-X-KEY") || trimmed.startsWith("#EXT-X-MAP") || trimmed.startsWith("#EXT-X-MEDIA") || trimmed.startsWith("#EXT-X-I-FRAME-STREAM-INF")) {
        return trimmed.replace(/URI="([^"]+)"/g, (_, uri) => {
          const abs = resolveGenericUrl(uri, baseUrl);
          if (abs.includes("ultracloud.cc") || abs.includes("piltover.li") || abs.includes("keeply.top")) return `URI="/aes-key?u=${encodeURIComponent(abs)}${refEnc}"`;
          return `URI="/generic-seg?u=${encodeURIComponent(abs)}${refEnc}"`;
        });
      }
      return line;
    })
    .join("\n");
}

router.get("/generic-stream.m3u8", async (req, res) => {
  const targetUrl = req.query.u ? decodeURIComponent(req.query.u) : null;
  if (!targetUrl) return res.status(400).json({ error: "Missing u param" });
  const referer = req.query.ref ? decodeURIComponent(req.query.ref) : null;
  res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
  setCacheForResponse(res, "application/vnd.apple.mpegurl", ".m3u8");
  try {
    const r = await fetch(targetUrl, { headers: genericHeaders(referer, targetUrl), signal: AbortSignal.timeout(20000) });
    if (!r.ok) {
      if (r.status === 403 || r.status === 404) invalidateStreamsContainingUrl(targetUrl);
      return res.status(502).json({ error: `generic upstream: ${r.status}` });
    }
    const refEnc = referer ? `&ref=${encodeURIComponent(referer)}` : "";
    const master = decodeDecimalPlaylist(await r.text());
    const isMaster = master.includes("#EXT-X-STREAM-INF");
    const isMedia = !isMaster && master.includes("#EXT-X-TARGETDURATION");
    if (isMedia) {
      const rewrittenMedia = rewriteGenericPlaylist(master, targetUrl, refEnc);
      const mediaKey = Buffer.from(targetUrl).toString("base64url").slice(0, 40);
      genericMediaCache.set(mediaKey, { text: rewrittenMedia, exp: Date.now() + 60000 });
      const mediaUrl = `/generic-media.m3u8?k=${mediaKey}`;
      const syntheticMaster = ["#EXTM3U", `#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.640028,mp4a.40.2"`, mediaUrl].join("\n");
      return res.send(syntheticMaster);
    }
    res.send(rewriteGenericPlaylist(master, targetUrl, refEnc));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/generic-media.m3u8", (req, res) => {
  const entry = genericMediaCache.get(req.query.k);
  if (!entry || Date.now() > entry.exp) return res.status(404).json({ error: "expired" });
  res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
  setCacheForResponse(res, "application/vnd.apple.mpegurl", ".m3u8");
  res.send(entry.text);
});

router.get("/aes-key", async (req, res) => {
  const targetUrl = req.query.u ? decodeURIComponent(req.query.u) : null;
  if (!targetUrl) return res.status(400).end();
  const referer = req.query.ref ? decodeURIComponent(req.query.ref) : "https://strm.cx/";
  try {
    const r = await fetch(targetUrl, {
      headers: genericHeaders(referer, targetUrl),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return res.status(r.status).end();
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", "application/octet-stream");
    setCacheForResponse(res, "application/octet-stream", ".key");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(buf);
  } catch (e) { res.status(500).end(); }
});

router.get("/generic-seg", async (req, res) => {
  const targetUrl = req.query.u ? decodeURIComponent(req.query.u) : null;
  if (!targetUrl) return res.status(400).json({ error: "Missing u param" });
  const referer = req.query.ref ? decodeURIComponent(req.query.ref) : null;
  const isPlaylistUrl = /\.m3u8(\?|$)/i.test(targetUrl.split("?")[0]);
  try {
    const r = await fetch(targetUrl, { headers: genericHeaders(referer, targetUrl), signal: AbortSignal.timeout(20000) });
    if (!r.ok) {
      if (r.status === 403 || r.status === 404) invalidateStreamsContainingUrl(targetUrl);
      return res.status(r.status).end();
    }
    const ct = r.headers.get("content-type") ?? "";
    const reader = r.body.getReader();
    const first = await reader.read();

    // Sniff del primer chunk: echovideo (aniwaves) sirve las sub-playlists con
    // content-type image/jpeg en paths /cdn/ sin extensión, y vmbox/vmcld las
    // sirve ofuscadas en decimal ASCII — ni el ct ni la URL las delatan.
    const headText = first.value ? new TextDecoder().decode(first.value.subarray(0, 4096)) : "";
    const headTrim = headText.trim();
    const looksPlaylist = headTrim.startsWith("#EXTM3U") || (/^[0-9\s]+$/.test(headTrim) && headTrim.length > 0);

    const buffered = first.value ? [first.value] : [];
    let bufferedLen = first.value?.byteLength ?? 0;
    let streamDone = first.done ?? false;

    if (looksPlaylist || ct.includes("mpegurl") || ct.includes("x-mpegurl") || isPlaylistUrl) {
      // Los playlists son chicos; si pasa de 4MB no es un playlist → binario.
      while (!streamDone && bufferedLen <= 4 * 1024 * 1024) {
        const { done, value } = await reader.read();
        if (done) { streamDone = true; break; }
        buffered.push(value);
        bufferedLen += value.byteLength;
      }
      if (streamDone) {
        const refEnc = referer ? `&ref=${encodeURIComponent(referer)}` : "";
        const content = decodeDecimalPlaylist(Buffer.concat(buffered.map((b) => Buffer.from(b))).toString("utf8"));
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        setCacheForResponse(res, "application/vnd.apple.mpegurl", ".m3u8");
        return res.send(rewriteGenericPlaylist(content, targetUrl, refEnc));
      }
    }

    const isUltracloud = targetUrl.includes("ultracloud.cc") || targetUrl.includes("piltover.li");
    let forcedCt = isUltracloud ? "application/octet-stream" : "video/mp2t";
    res.setHeader("Content-Type", forcedCt);
    setCacheForResponse(res, forcedCt, targetUrl);
    const pump = async () => {
      for (const chunk of buffered) {
        if (!res.write(Buffer.from(chunk))) await new Promise(ok => res.once("drain", ok));
      }
      while (!streamDone) {
        const { done, value } = await reader.read();
        if (done) { streamDone = true; break; }
        if (!res.write(value)) await new Promise(ok => res.once("drain", ok));
      }
      res.end();
    };
    pump().catch(() => { if (!res.headersSent) res.destroy(); });
  } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ── Vixsrc HLS proxy ───────────────────────────────────────────────────────────
const VIXSRC_BASE = "https://vixsrc.to";
const VIXSRC_HEADERS = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36", "Referer": `${VIXSRC_BASE}/` };

function rewriteVixsrcPlaylist(text, baseUrl, proxyBase) {
  const audioLines = [];
  const out = [];
  let audioInserted = false;

  for (const rawLine of text.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) { out.push(rawLine); continue; }

    let line = rawLine;

    // Reescribir URIs. Los playlists (audio/subs/variant) usan /vixsrc-seg.m3u8
    // para que la extensión .m3u8 aparezca en las URLs selladas y los players
    // /ffmpeg las acepten. Las claves AES y segmentos .ts usan /vixsrc-seg.
    if (/^#EXT-X-(KEY|MAP|MEDIA)/.test(trimmed)) {
      const isPlaylistMedia = /^#EXT-X-MEDIA:TYPE=(AUDIO|SUBTITLES)/.test(trimmed);
      line = line.replace(/URI="([^"]+)"/g, (_, uri) => {
        const abs = resolveGenericUrl(uri, baseUrl);
        const proxyPath = isPlaylistMedia ? "vixsrc-seg.m3u8" : "vixsrc-seg";
        return `URI="${proxyBase}/${proxyPath}?u=${encodeURIComponent(abs)}"`;
      });
    }

    // Guardar líneas de audio para reordenarlas antes de las variantes
    if (trimmed.startsWith("#EXT-X-MEDIA:TYPE=AUDIO")) {
      audioLines.push(line);
      continue;
    }

    // Insertar audios justo antes del primer #EXT-X-STREAM-INF, inglés primero
    if (!audioInserted && trimmed.startsWith("#EXT-X-STREAM-INF")) {
      audioLines.sort((a, b) => {
        const aEn = /LANGUAGE="en/i.test(a) ? 1 : 0;
        const bEn = /LANGUAGE="en/i.test(b) ? 1 : 0;
        return bEn - aEn;
      });
      out.push(...audioLines);
      audioInserted = true;
    }

    // El video "variant" es solo video aunque CODECS anuncie audio; limpiar CODECS para que
    // los players usen el grupo de audio alterno y no busquen audio dentro del variant.
    if (trimmed.startsWith("#EXT-X-STREAM-INF") && /AUDIO="audio"/.test(trimmed)) {
      line = line.replace(/CODECS="([^"]+)"/g, (_, codecs) => {
        const cleaned = codecs.split(",").filter((c) => !/mp4a|ec-3|ac-3/.test(c)).join(",");
        return `CODECS="${cleaned}"`;
      });
      if (!/CLOSED-CAPTIONS=/i.test(line)) line += ",CLOSED-CAPTIONS=NONE";
    }

    if (!trimmed.startsWith("#")) {
      const abs = resolveGenericUrl(trimmed, baseUrl);
      // Las URLs no-comentario en el master son variant playlists; forzar .m3u8
      const proxyPath = abs.includes("type=video") ? "vixsrc-seg.m3u8" : "vixsrc-seg";
      line = `${proxyBase}/${proxyPath}?u=${encodeURIComponent(abs)}`;
    }
    out.push(line);
  }

  return out.join("\n");
}

router.get("/vixsrc-stream.m3u8", async (req, res) => {
  const targetUrl = req.query.u ? decodeURIComponent(req.query.u) : null;
  if (!targetUrl) return res.status(400).json({ error: "Missing u param" });
  const proxyBase = getProxyBase(req);
  try {
    const r = await undiciRequest(targetUrl, {
      method: "GET",
      headers: VIXSRC_HEADERS,
      signal: AbortSignal.timeout(20000),
    });
    if (r.statusCode >= 400) return res.status(r.statusCode).json({ error: `vixsrc upstream: ${r.statusCode}` });
    const chunks = [];
    for await (const chunk of r.body) chunks.push(chunk);
    let raw = Buffer.concat(chunks);
    if (/gzip/i.test(r.headers["content-encoding"] || "")) raw = gunzipSync(raw);
    const text = raw.toString("utf8");
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    setCacheForResponse(res, "application/vnd.apple.mpegurl", ".m3u8");
    return res.send(rewriteVixsrcPlaylist(text, targetUrl, proxyBase));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

router.get(["/vixsrc-seg", "/vixsrc-seg.m3u8"], async (req, res) => {
  const targetUrl = req.query.u ? decodeURIComponent(req.query.u) : null;
  if (!targetUrl) return res.status(400).json({ error: "Missing u param" });
  try {
    const r = await undiciRequest(targetUrl, {
      method: "GET",
      headers: VIXSRC_HEADERS,
      signal: AbortSignal.timeout(30000),
    });
    const status = r.statusCode;
    const headers = r.headers;
    if (status >= 400) return res.status(status).end();
    const ct = headers["content-type"] ?? "";
    const contentEncoding = headers["content-encoding"] ?? "";
    const body = r.body;

    const qIdx = targetUrl.indexOf("?");
    const targetPath = qIdx === -1 ? targetUrl : targetUrl.slice(0, qIdx);
    const isPlaylist = /mpegurl|x-mpegurl/i.test(ct) || targetPath.endsWith(".m3u8") || targetPath.endsWith(".m3u") || targetPath.endsWith(".txt");
    if (isPlaylist) {
      const proxyBase = getProxyBase(req);
      const chunks = [];
      for await (const chunk of body) chunks.push(chunk);
      let raw = Buffer.concat(chunks);
      if (/gzip/i.test(contentEncoding)) raw = gunzipSync(raw);
      const text = raw.toString("utf8");
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      setCacheForResponse(res, "application/vnd.apple.mpegurl", ".m3u8");
      return res.send(rewriteVixsrcPlaylist(text, targetUrl, proxyBase));
    }

    // vixsrc sirve los segmentos como .html con content-type text/html —
    // /sealed clasificaría eso como texto y el decode UTF-8 corrompe los
    // bytes AES-128. Solo se fuerza mp2t en ese caso; los subs .vtt conservan
    // su content-type real.
    const segCt = /html/i.test(ct) ? "video/mp2t" : (ct || "video/mp2t");
    res.status(status);
    res.setHeader("Content-Type", segCt);
    setCacheForResponse(res, segCt, targetUrl);
    body.on("error", (err) => { console.error("[vixsrc-seg] pipe error:", err.message); if (!res.headersSent) res.status(502).end(); });
    body.pipe(res);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ── DASH proxy ────────────────────────────────────────────────────────────────
function encodeDashOrigin(origin) { return Buffer.from(origin).toString("base64url"); }
function decodeDashOrigin(token) { return Buffer.from(token, "base64url").toString("utf8"); }
function escapeXmlAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function rewriteDashAttr(attrName, manifestUrl, proxyBase) {
  return (full, value) => {
    try {
      const resolved = new URL(value, manifestUrl);
      const token = encodeDashOrigin(resolved.origin);
      return `${attrName}="${escapeXmlAttr(`${proxyBase}/dash-seg/${token}${resolved.pathname}${resolved.search}`)}"`;
    } catch { return full; }
  };
}

router.get("/dash-proxy.mpd", async (req, res) => {
  const targetUrl = req.query.u ? decodeURIComponent(req.query.u) : null;
  if (!targetUrl) return res.status(400).json({ error: "Missing u param" });
  const referer = req.query.ref ? decodeURIComponent(req.query.ref) : null;
  const proxyBase = getProxyBase(req);
  try {
    const r = await fetch(targetUrl, { headers: genericHeaders(referer, targetUrl), signal: AbortSignal.timeout(20000) });
    if (!r.ok) return res.status(r.status).json({ error: `dash upstream: ${r.status}` });
    let mpd = await r.text();
    const firstPeriodIdx = mpd.indexOf("<Period");
    if (firstPeriodIdx !== -1) {
      const head = mpd.slice(0, firstPeriodIdx).replace(/<BaseURL>[\s\S]*?<\/BaseURL>/g, "");
      mpd = head + mpd.slice(firstPeriodIdx);
    }
    mpd = mpd
      .replace(/initialization="([^"]+)"/g, rewriteDashAttr("initialization", targetUrl, proxyBase))
      .replace(/media="([^"]+)"/g, rewriteDashAttr("media", targetUrl, proxyBase));
    res.setHeader("Content-Type", "application/dash+xml");
    setCacheForResponse(res, "application/dash+xml", ".mpd");
    res.send(mpd);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/dash-seg/:origin/*", async (req, res) => {
  try {
    const origin = decodeDashOrigin(req.params.origin);
    const prefix = `/dash-seg/${req.params.origin}/`;
    const idx = req.originalUrl.indexOf(prefix);
    const rest = idx !== -1 ? req.originalUrl.slice(idx + prefix.length) : "";
    const targetUrl = `${origin}/${rest}`;
    const range = req.headers.range;
    const r = await fetch(targetUrl, {
      headers: { "User-Agent": genericHeaders(null)["User-Agent"], ...(range ? { Range: range } : {}) },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok && r.status !== 206) return res.status(r.status).end();
    res.status(r.status);
    res.setHeader("Content-Type", r.headers.get("content-type") ?? "video/iso.segment");
    res.setHeader("Accept-Ranges", "bytes");
    const cl = r.headers.get("content-length");
    const cr = r.headers.get("content-range");
    if (cl) res.setHeader("Content-Length", cl);
    if (cr) res.setHeader("Content-Range", cr);
    setCacheForResponse(res, r.headers.get("content-type") ?? "video/iso.segment", targetUrl);
    const reader = r.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); break; }
        if (!res.write(value)) await new Promise(ok => res.once("drain", ok));
      }
    };
    pump().catch(() => { if (!res.headersSent) res.destroy(); });
  } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ── Legacy proxy routes ───────────────────────────────────────────────────────
router.get("/proxy", async (req, res) => {
  const { url: rawUrl, headers: rawHeaders } = req.query;
  if (!rawUrl) return res.status(400).json({ error: "url is required" });
  const url = rewriteBlockedCdnHost(rawUrl);
  const extraHeaders = parsHeaders(rawHeaders);
  try {
    const { statusCode, body } = await proxyFetch(url, { ...HEADERS, ...extraHeaders }, 20000);
    if (statusCode >= 400) return res.status(statusCode).json({ error: `Upstream error: ${statusCode}` });
    const chunks = [];
    for await (const chunk of body) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf-8");
    const proxyBase = getProxyBase(req);
    const rewritten = rewriteM3U8(text, url, proxyBase, extraHeaders);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    setCacheForResponse(res, "application/vnd.apple.mpegurl", ".m3u8");
    res.send(rewritten);
  } catch (err) { res.status(502).json({ error: err.message }); }
});

router.get("/ts-proxy", async (req, res) => {
  const { url, headers: rawHeaders } = req.query;
  if (!url) return res.status(400).json({ error: "url is required" });
  const extraHeaders = parsHeaders(rawHeaders);
  // req.query.url ya viene decodificado por Express — un decodeURIComponent
  // extra corrompe las firmas (%2F → /) de URLs como las de tiktokcdn → 403.
  const decodedUrl = rewriteBlockedCdnHost(url);
  try {
    const outHeaders = { ...HEADERS, ...extraHeaders };
    const { statusCode, headers: upHeaders, body } = await proxyFetch(decodedUrl, outHeaders);
    if (statusCode >= 400) {
      console.warn(`[ts-proxy] ${statusCode} ${decodedUrl.slice(0, 120)}\n  out-headers: ${JSON.stringify(outHeaders)}`);
    }
    if (statusCode >= 300 && statusCode < 400 && upHeaders.location) {
      for await (const _ of body) {}
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.redirect(302, upHeaders.location);
    }
    if (statusCode >= 400) return res.status(statusCode).json({ error: `Upstream error: ${statusCode}` });
    const upstreamCt = upHeaders["content-type"] ?? "";
    const isPlaylistUrl = /\.m3u8(?:$|[?#])|\.txt(?:$|[?#])/i.test(decodedUrl);
    const isPlaylistCt = /mpegurl|x-mpegurl/i.test(upstreamCt);
    const STRIP_HOSTS_RE = /ibyteimg\.com|tiktokcdn\.com|ipstatp\.com|yoot\.akirax\.buzz/i;
    const needsStrip = STRIP_HOSTS_RE.test(decodedUrl);
    if (!isPlaylistUrl && !isPlaylistCt && !needsStrip) {
      let contentType = upstreamCt || "video/mp2t";
      if (!contentType || /^application\/octet-stream/i.test(contentType) || /^font\/woff2/i.test(contentType)) {
        contentType = /\.m4s(?:$|[?#])|\.mp4(?:$|[?#])|\/init-[^/]*\.mp4(?:$|[?#])/i.test(decodedUrl)
          ? "video/mp4"
          : "video/mp2t";
      }
      if (/^image\//i.test(contentType) || /^text\/html/i.test(contentType)) {
        contentType = /\.m4s(?:$|[?#])|\.mp4(?:$|[?#])|\/init-[^/]*\.mp4(?:$|[?#])/i.test(decodedUrl)
          ? "video/mp4"
          : "video/mp2t";
      }
      res.status(statusCode);
      res.setHeader("Content-Type", contentType);
      if (upHeaders["content-length"]) res.setHeader("Content-Length", upHeaders["content-length"]);
      if (upHeaders["content-range"]) res.setHeader("Content-Range", upHeaders["content-range"]);
      if (upHeaders["accept-ranges"]) res.setHeader("Accept-Ranges", upHeaders["accept-ranges"]);
      setCacheForResponse(res, contentType, decodedUrl);
      body.on("error", () => { if (!res.headersSent) res.destroy(); });
      res.on("close", () => body.destroy());
      return body.pipe(res);
    }
    const chunks = [];
    for await (const chunk of body) chunks.push(chunk);
    let buffer = Buffer.concat(chunks);
    // Megaplay CDN (tiktokcdn/akirax/etc): los segmentos TS vienen con 252
    // bytes de PNG falso al inicio — el player los corta (SegmentStrip,
    // STRIP_BYTES=252). Sin esto el segmento es un PNG inválido.
    if (STRIP_HOSTS_RE.test(decodedUrl) && buffer.length > 252) {
      buffer = buffer.subarray(252);
    }
    const text = buffer.toString("utf-8");
    const trimmed = text.trimStart();
    if (trimmed.startsWith("#EXTM3U") || trimmed.startsWith("#EXT-X-")) {
      const proxyBase = getProxyBase(req);
      const rewritten = rewriteM3U8(text, decodedUrl, proxyBase, extraHeaders);
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      setCacheForResponse(res, "application/vnd.apple.mpegurl", ".m3u8");
      return res.send(rewritten);
    }
    let contentType = upHeaders["content-type"] ?? "video/mp2t";
    const contentLength = buffer.length; // post-strip: el upstream ya no aplica
    const firstByte = buffer[0];
    const isTS = firstByte === 0x47;
    if (isTS || /^image\//.test(contentType) || /^text\/html/.test(contentType) || contentType === "application/octet-stream") contentType = "video/mp2t";
    res.setHeader("Content-Type", contentType);
    if (contentLength) res.setHeader("Content-Length", contentLength);
    setCacheForResponse(res, contentType, decodedUrl);
    res.send(buffer);
  } catch (err) {
    console.warn(`[ts-proxy] ERROR: ${err.message}`);
    if (!res.headersSent) res.status(502).json({ error: err.message });
  }
});

router.get("/fetch", async (req, res) => {
  const sealed = tryUnsealQueryPayload(req.query.s);
  const url = (sealed?.url) || req.query.url;
  const ref = (sealed?.ref) || req.query.ref;
  const ctRaw = (sealed?.ct) || req.query.ct;
  if (!url) return res.status(400).json({ error: "url is required" });
  try {
    const { statusCode, headers: upHeaders, body } = await proxyFetch(url, {
      ...HEADERS,
      "Accept-Encoding": "identity",
      ...(ref ? { Referer: ref, Origin: new URL(ref).origin } : {}),
    }, 20000);
    if (statusCode >= 400) {
      if (body && typeof body.cancel === "function") body.cancel();
      else if (body && typeof body.destroy === "function") body.destroy();
      return res.status(statusCode).json({ error: `Upstream error: ${statusCode}` });
    }
    const contentType = ctRaw ? decodeURIComponent(ctRaw) : (upHeaders["content-type"] ?? "application/octet-stream");
    res.setHeader("Content-Type", contentType);
    const chunks = [];
    for await (const chunk of body) chunks.push(chunk);
    let buf = Buffer.concat(chunks);
    const encoding = upHeaders["content-encoding"];
    if (encoding === "gzip" || encoding === "br" || encoding === "deflate") {
      buf = await new Promise((resolve, reject) => {
        const out = [];
        const transform = encoding === "gzip" ? createGunzip() : encoding === "br" ? createBrotliDecompress() : createInflate();
        transform.on("data", (c) => out.push(c));
        transform.on("end", () => resolve(Buffer.concat(out)));
        transform.on("error", reject);
        transform.end(buf);
      });
    }
    let text;
    const decodedUrl = url; // req.query ya viene decodificado por Express
    const hasSpam = buf.includes(Buffer.from("hoofoot.ru"));
    const isVtt = contentType.includes("vtt") || decodedUrl.endsWith(".vtt");
    if (hasSpam || isVtt) {
      text = buf.toString("utf-8");
      if (hasSpam) {
        const lines = text.split("\n");
        const spamLines = lines.filter((l) => l.includes("hoofoot.ru"));
        if (spamLines.length) {
          console.log(`[fetch-filter] eliminando ${spamLines.length} línea(s) con hoofoot.ru (${url.slice(0, 80)})`);
          text = lines.filter((l) => !l.includes("hoofoot.ru")).join("\n");
        }
      }
    }
    if (isVtt && text !== undefined) {
      // Base para resolver rutas relativas de sprites. Si la URL del VTT no
      // tiene extensión (flixcloud: /thumbnails_vtt/{uuid}), el UUID actúa
      // como directorio → base = url + "/". Si termina en archivo (.vtt),
      // base = directorio contenedor.
      const lastSeg = decodedUrl.split("/").pop().split("?")[0];
      const basePath = lastSeg.includes(".")
        ? decodedUrl.substring(0, decodedUrl.lastIndexOf("/") + 1)
        : decodedUrl.replace(/\/$/, "") + "/";
      // Reescribir a /fetch sellado: hosts como fetch8.flixcloud.cc exigen
      // Referer y devuelven 403/404 sin él, además no queremos leakear la
      // URL cruda en el body del VTT.
      const proxyBase = getProxyBase(req);
      const refDefault = ref || "https://flixcloud.cc/";
      // NOTA: el pattern de la línea entera incluye hash y fragmento
      // (#xywh=0,0,160,90). Los paths a veces tienen ./../thumbnails/... o
      // bien thumbnails/sprite_X.webp con cualquier cosa después del #.
      // Capturamos TODO menos whitespace y caracteres rotos de URL.
      text = text.replace(/^([\w./\\-][^\s"'<>|]*\.(?:webp|jpg|jpeg|png)(?:#[^\s]*)?)$/gim, (match, rel) => {
        try {
          // rel viene con #fragmento tipo #xywh=0,0,160,90.
          //  - El #xywh es 100% cliente-side (nunca se envía al servidor).
          //  - Para TOKEN DETERMINÍSTICO: sellamos solo la URL SIN hash.
          //  - Para RENDER VTT correcto: el #xywh se PRESERVA como
          //    fragmento DEL LINK DEL PROXY (fuera del s= token).
          const hashIdx = rel.indexOf("#");
          const pre = hashIdx === -1 ? rel : rel.slice(0, hashIdx);
          const frag = hashIdx === -1 ? "" : rel.slice(hashIdx);
          const ext = pre.split(".").pop().toLowerCase();
          const imgCt = (ext === "jpg" || ext === "jpeg") ? "image/jpeg" : ext === "png" ? "image/png" : "image/webp";
          const absNoHash = new URL(pre, basePath).href;
          return `${proxyBase}/fetch?${sealedQueryParamDeterministic({ url: absNoHash, ref: refDefault, ct: imgCt })}${frag}`;
        } catch { return match; }
      });
    }
    if (text !== undefined) {
      res.removeHeader("Content-Encoding");
      res.setHeader("Content-Length", Buffer.byteLength(text));
      setCacheForResponse(res, contentType, isVtt ? ".vtt" : decodedUrl);
      return res.send(text);
    }
    res.removeHeader("Content-Encoding");
    res.setHeader("Content-Length", buf.length);
    setCacheForResponse(res, contentType, decodedUrl);
    res.send(buf);
  } catch (err) { if (!res.headersSent) res.status(502).json({ error: err.message }); }
});

router.get("/mp4-proxy", async (req, res) => {
  const { url, headers: rawHeaders } = req.query;
  if (!url) return res.status(400).json({ error: "url is required" });
  const extraHeaders = parsHeaders(rawHeaders);
  const range = req.headers.range;
  try {
    const { statusCode, headers: upHeaders, body } = await proxyFetch(url, { ...HEADERS, ...extraHeaders, ...(range ? { Range: range } : {}) });
    if (statusCode >= 400 && statusCode !== 206) return res.status(statusCode).json({ error: `Upstream error: ${statusCode}` });
    // Forzar video/mp4 siempre: mp4upload.com (y otros) sirven
    // application/octet-stream, que hace que el navegador descargue el
    // archivo en vez de reproducirlo inline. Este endpoint es SOLO para mp4.
    const contentType = "video/mp4";
    const contentLength = upHeaders["content-length"];
    const contentRange = upHeaders["content-range"];
    res.status(statusCode);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Accept-Ranges", "bytes");
    if (contentLength) res.setHeader("Content-Length", contentLength);
    if (contentRange) res.setHeader("Content-Range", contentRange);
    setCacheForResponse(res, contentType, url);
    body.on("error", (e) => { if (!res.headersSent) res.destroy(); });
    res.on("close", () => body.destroy());
    body.pipe(res);
  } catch (err) { if (!res.headersSent) res.status(502).json({ error: err.message }); }
});

router.get("/ghost-proxy", async (req, res) => {
  const { url, proxy, headers: rawHeaders } = req.query;
  if (!url) return res.status(400).json({ error: "url is required" });
  if (!proxy) return res.status(400).json({ error: "proxy is required" });
  const extraHeaders = parsHeaders(rawHeaders);
  try {
    const agent = new HttpsProxyAgent(decodeURIComponent(proxy));
    const upstream = await fetch(url, {
      headers: { ...HEADERS, ...extraHeaders },
      signal: AbortSignal.timeout(30000),
      agent,
    });
    if (!upstream.ok) return res.status(upstream.status).json({ error: `Upstream error: ${upstream.status}` });
    const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    setCacheForResponse(res, contentType, url);
    const buffer = await upstream.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// ── Sealed proxy endpoint ─────────────────────────────────────────────────────
router.get("/sealed/:token", async (req, res, next) => {
  const token = String(req.params.token).replace(/\.(?:m3u8|mpd)$/i, "");
  let originalPath;
  try {
    originalPath = unsealProxyPath(token);
  } catch {
    // Token inválido/truncado (bots/scanners probando paths al azar, o un
    // link viejo). No es un error de servidor real: 400 y sin log de stack.
    return res.status(400).json({ error: "invalid or expired token" });
  }
  try {
    const internalUrl = `http://127.0.0.1:${req.socket.localPort}${originalPath}`;
    const proxyBase = getProxyBase(req);
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    headers["x-proxy-base"] = proxyBase;
    headers["cache-control"] = "no-store";
    const r = await fetch(internalUrl, { method: req.method, headers, cache: "no-store" });
    res.status(r.status);
    const ct = r.headers.get("content-type") || "";
    // text/html queda afuera: algunos upstreams sirven binario (segmentos
    // .html de vixsrc, etc.) con ese CT y el decode UTF-8 los corrompe.
    const isText = /mpegurl|json|xml|vtt|x-ass|subrip|plain/i.test(ct) || (/^text\//i.test(ct) && !/html/i.test(ct));
    const _hdr = {};
    r.headers.forEach((v, k) => {
      const kl = k.toLowerCase();
      if (["content-encoding", "transfer-encoding", "connection", "cache-control", "access-control-allow-origin", "access-control-allow-headers", "access-control-allow-methods", "vary", "etag", "last-modified"].includes(kl)) return;
      _hdr[k] = v;
    });
    _hdr["Content-Type"] = ct;

    if (!isText) {
      // Binario (mp4, ts, imágenes): streamear — bufferar haría que el
      // endpoint descargue el archivo completo antes de responder, y el
      // player nunca ve ni Content-Length ni 206 parciales.
      res.writeHead(r.status, _hdr);
      res.on("close", () => r.body?.cancel().catch(() => {}));
      const reader = r.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.write(value)) await new Promise(ok => res.once("drain", ok));
        }
      } finally { res.end(); }
      return;
    }

    const body = sealProxyUrlsInText(await r.text(), proxyBase);
    // El body resealado tiene largo distinto al upstream — descartar el
    // Content-Length original o el cliente recibe largo incorrecto.
    delete _hdr["content-length"];
    delete _hdr["Content-Length"];
    const ext = String(originalPath || "").toLowerCase().match(/\.([a-z0-9]{1,6})(?:\?|#|$)/i)?.[1] || "";
    const isPlaylist = /mpegurl|dash|xml/i.test(ct || "") || ["m3u8", "mpd"].includes(ext);
    const isSubs = /vtt|text\/track|subrip|ass\/octet/i.test(ct || "") || ["vtt", "ass", "srt"].includes(ext);
    let CC = CC_MEDIA;
    if (isPlaylist) CC = CC_PLAYLIST;
    else if (isSubs) CC = CC_SUBS;
    _hdr["Cache-Control"] = CC;
    ["Cache-Control", "ETag", "Last-Modified"].forEach(h => { try { res.removeHeader(h); } catch {} });
    res.writeHead(r.status, _hdr);
    res.end(body);
  } catch (e) { next(e); }
});

// ── Sub cache endpoint ─────────────────────────────────────────────────────────
router.get("/subs/:file", async (req, res) => {
  const file = path.basename(req.params.file);
  const filepath = path.join(SUBS_DIR, file);
  if (!existsSync(filepath)) {
    try {
      return res.redirect(302, buildPublicR2Url(`subs/${file}`));
    } catch {
      return res.status(404).end();
    }
  }
  try {
    const raw = await readFile(filepath, "utf8");
    const content = removeSpamLines(raw);
    res.setHeader("Access-Control-Allow-Origin", "*");
    const ext = path.extname(file).toLowerCase();
    res.setHeader("Content-Type", ext === ".ass" ? "text/x-ass; charset=utf-8" : "text/vtt; charset=utf-8");
    setCacheForResponse(res, ext === ".ass" ? "text/x-ass; charset=utf-8" : "text/vtt; charset=utf-8", ext);
    res.send(content);
  } catch { res.status(500).end(); }
});

export default router;
