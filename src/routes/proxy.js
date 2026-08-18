import { Router } from "express";
import { HttpsProxyAgent } from "https-proxy-agent";
import { get } from "curl-cffi-node";
import { createGunzip, createInflate, createBrotliDecompress, gunzipSync } from "zlib";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import path from "path";
import { sealProxyUrlsInText, unsealProxyPath } from "../lib/proxy-seal.js";
import { HEADERS, MIRURO_API, CC_MEDIA, CC_PLAYLIST, CC_SUBS } from "../config/constants.js";
import { getProxyBase, setCacheForResponse, rewriteM3U8, parsHeaders } from "../lib/proxy.js";
import { proxyFetch } from "../lib/http.js";
import { request as undiciRequest } from "undici";
import { SUBS_DIR } from "../lib/subtitles.js";
import { removeSpamLines } from "../lib/subtitle-cleaner.js";
import { createRateLimiter } from "../lib/rate-limit.js";

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

// ── Generic HLS proxy ────────────────────────────────────────────────────────
const genericMediaCache = new Map();
function genericHeaders(referer) {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    "Accept": "*/*",
    ...(referer && { "Referer": referer, "Origin": referer.replace(/\/$/, "") }),
  };
}
function resolveGenericUrl(raw, baseUrl) {
  try { return new URL(raw).href; } catch { return new URL(raw, baseUrl).href; }
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
      if (trimmed.startsWith("#EXT-X-KEY") || trimmed.startsWith("#EXT-X-MAP") || trimmed.startsWith("#EXT-X-MEDIA")) {
        return trimmed.replace(/URI="([^"]+)"/g, (_, uri) => {
          const abs = resolveGenericUrl(uri, baseUrl);
          if (abs.includes("ultracloud.cc") || abs.includes("piltover.li")) return `URI="/aes-key?u=${encodeURIComponent(abs)}"`;
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
    const r = await fetch(targetUrl, { headers: genericHeaders(referer), signal: AbortSignal.timeout(20000) });
    if (!r.ok) return res.status(502).json({ error: `generic upstream: ${r.status}` });
    const refEnc = referer ? `&ref=${encodeURIComponent(referer)}` : "";
    const master = await r.text();
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
  try {
    const r = await fetch(targetUrl, {
      headers: { "Referer": "https://www.miruro.tv/", "Origin": "https://www.miruro.tv", "User-Agent": "Mozilla/5.0 Chrome/137" },
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
  const isPlaylist = /\.m3u8(\?|$)/i.test(targetUrl.split("?")[0]);
  try {
    const r = await fetch(targetUrl, { headers: genericHeaders(referer), signal: AbortSignal.timeout(20000) });
    if (!r.ok) return res.status(r.status).end();
    const ct = r.headers.get("content-type") ?? "";
    if (ct.includes("mpegurl") || ct.includes("x-mpegurl") || isPlaylist) {
      const refEnc = referer ? `&ref=${encodeURIComponent(referer)}` : "";
      const content = await r.text();
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      setCacheForResponse(res, "application/vnd.apple.mpegurl", ".m3u8");
      return res.send(rewriteGenericPlaylist(content, targetUrl, refEnc));
    }
    const isUltracloud = targetUrl.includes("ultracloud.cc") || targetUrl.includes("piltover.li");
    const isFakeCt = ct.startsWith("image/") || ct.startsWith("text/html");
    let forcedCt = ct || "video/mp2t";
    if (isUltracloud) forcedCt = "application/octet-stream";
    else if (isFakeCt) forcedCt = "video/mp2t";
    res.setHeader("Content-Type", forcedCt);
    setCacheForResponse(res, forcedCt, targetUrl);
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
    const r = await get(targetUrl, { impersonate: "chrome124", headers: VIXSRC_HEADERS, timeout: 20, verify: false });
    if (!r.ok) return res.status(r.status).json({ error: `vixsrc upstream: ${r.status}` });
    let raw = r.buffer();
    if (/gzip/i.test(r.headers.get("content-encoding") || "")) raw = gunzipSync(raw);
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
    const targetHost = new URL(targetUrl).hostname.toLowerCase();
    const needsImpersonate = targetHost.endsWith("vixsrc.to");

    let status, headers, body, ct, contentEncoding;
    if (needsImpersonate) {
      const r = await get(targetUrl, { impersonate: "chrome124", headers: VIXSRC_HEADERS, timeout: 30, verify: false });
      if (!r.ok) return res.status(r.status).end();
      ct = r.headers.get("content-type") ?? "";
      contentEncoding = r.headers.get("content-encoding") ?? "";
      status = r.status;
      body = r.buffer();
    } else {
      const r = await undiciRequest(targetUrl, {
        method: "GET",
        headers: VIXSRC_HEADERS,
        signal: AbortSignal.timeout(30000),
      });
      status = r.statusCode;
      headers = r.headers;
      if (status >= 400) return res.status(status).end();
      ct = headers["content-type"] ?? "";
      contentEncoding = headers["content-encoding"] ?? "";
      body = r.body;
    }

    const qIdx = targetUrl.indexOf("?");
    const targetPath = qIdx === -1 ? targetUrl : targetUrl.slice(0, qIdx);
    const isPlaylist = /mpegurl|x-mpegurl/i.test(ct) || targetPath.endsWith(".m3u8") || targetPath.endsWith(".m3u") || targetPath.endsWith(".txt");
    if (isPlaylist) {
      const proxyBase = getProxyBase(req);
      let raw = Buffer.isBuffer(body) ? body : await body.arrayBuffer?.() ? Buffer.from(await body.arrayBuffer()) : null;
      if (!raw) {
        const chunks = [];
        for await (const chunk of body) chunks.push(chunk);
        raw = Buffer.concat(chunks);
      }
      if (/gzip/i.test(contentEncoding)) raw = gunzipSync(raw);
      const text = raw.toString("utf8");
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      setCacheForResponse(res, "application/vnd.apple.mpegurl", ".m3u8");
      return res.send(rewriteVixsrcPlaylist(text, targetUrl, proxyBase));
    }

    res.status(status);
    res.setHeader("Content-Type", ct || "video/mp2t");
    setCacheForResponse(res, ct || "video/mp2t", targetUrl);
    if (Buffer.isBuffer(body)) {
      res.send(body);
    } else {
      body.on("error", (err) => { console.error("[vixsrc-seg] pipe error:", err.message); if (!res.headersSent) res.status(502).end(); });
      body.pipe(res);
    }
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ── DASH proxy ────────────────────────────────────────────────────────────────
function encodeDashOrigin(origin) { return Buffer.from(origin).toString("base64url"); }
function decodeDashOrigin(token) { return Buffer.from(token, "base64url").toString("utf8"); }
function rewriteDashAttr(attrName, manifestUrl, proxyBase) {
  return (full, value) => {
    try {
      const resolved = new URL(value, manifestUrl);
      const token = encodeDashOrigin(resolved.origin);
      return `${attrName}="${proxyBase}/dash-seg/${token}${resolved.pathname}${resolved.search}"`;
    } catch { return full; }
  };
}

router.get("/dash-proxy.mpd", async (req, res) => {
  const targetUrl = req.query.u ? decodeURIComponent(req.query.u) : null;
  if (!targetUrl) return res.status(400).json({ error: "Missing u param" });
  const referer = req.query.ref ? decodeURIComponent(req.query.ref) : null;
  const proxyBase = getProxyBase(req);
  try {
    const r = await fetch(targetUrl, { headers: genericHeaders(referer), signal: AbortSignal.timeout(20000) });
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
  const { url, headers: rawHeaders } = req.query;
  if (!url) return res.status(400).json({ error: "url is required" });
  const extraHeaders = parsHeaders(rawHeaders);
  try {
    const { statusCode, body } = await proxyFetch(decodeURIComponent(url), { ...HEADERS, ...extraHeaders }, 20000);
    if (statusCode >= 400) return res.status(statusCode).json({ error: `Upstream error: ${statusCode}` });
    const chunks = [];
    for await (const chunk of body) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf-8");
    const proxyBase = getProxyBase(req);
    const rewritten = rewriteM3U8(text, decodeURIComponent(url), proxyBase, extraHeaders);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    setCacheForResponse(res, "application/vnd.apple.mpegurl", ".m3u8");
    res.send(rewritten);
  } catch (err) { res.status(502).json({ error: err.message }); }
});

router.get("/ts-proxy", async (req, res) => {
  const { url, headers: rawHeaders } = req.query;
  if (!url) return res.status(400).json({ error: "url is required" });
  const extraHeaders = parsHeaders(rawHeaders);
  const decodedUrl = decodeURIComponent(url);
  try {
    const { statusCode, headers: upHeaders, body } = await proxyFetch(decodedUrl, { ...HEADERS, ...extraHeaders });
    if (statusCode >= 300 && statusCode < 400 && upHeaders.location) {
      for await (const _ of body) {}
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.redirect(302, upHeaders.location);
    }
    if (statusCode >= 400) return res.status(statusCode).json({ error: `Upstream error: ${statusCode}` });
    const chunks = [];
    for await (const chunk of body) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
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
    const contentLength = upHeaders["content-length"];
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
  const { url, ref, ct } = req.query;
  if (!url) return res.status(400).json({ error: "url is required" });
  try {
    const { statusCode, headers: upHeaders, body } = await proxyFetch(decodeURIComponent(url), {
      ...HEADERS,
      "Accept-Encoding": "identity",
      ...(ref ? { Referer: ref, Origin: new URL(ref).origin } : {}),
    }, 20000);
    if (statusCode >= 400) {
      if (body && typeof body.cancel === "function") body.cancel();
      else if (body && typeof body.destroy === "function") body.destroy();
      return res.status(statusCode).json({ error: `Upstream error: ${statusCode}` });
    }
    const contentType = ct ? decodeURIComponent(ct) : (upHeaders["content-type"] ?? "application/octet-stream");
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
    if (buf.includes(Buffer.from("hoofoot.ru"))) {
      text = buf.toString("utf-8");
      const lines = text.split("\n");
      const spamLines = lines.filter((l) => l.includes("hoofoot.ru"));
      if (spamLines.length) {
        console.log(`[fetch-filter] eliminando ${spamLines.length} línea(s) con hoofoot.ru (${decodeURIComponent(url).slice(0, 80)})`);
        text = lines.filter((l) => !l.includes("hoofoot.ru")).join("\n");
      }
    }
    const decodedUrl = decodeURIComponent(url);
    const isVtt = contentType.includes("vtt") || decodedUrl.endsWith(".vtt");
    if (isVtt && text !== undefined) {
      const vttBase = new URL(decodedUrl);
      const basePath = vttBase.href.substring(0, vttBase.href.lastIndexOf("/") + 1);
      text = text.replace(/^([\w.-]+\.webp(?:#[^\s]*)?)$/gm, (_, rel) => basePath + rel);
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
    const { statusCode, headers: upHeaders, body } = await proxyFetch(decodeURIComponent(url), { ...HEADERS, ...extraHeaders, ...(range ? { Range: range } : {}) });
    if (statusCode >= 400 && statusCode !== 206) return res.status(statusCode).json({ error: `Upstream error: ${statusCode}` });
    const contentType = upHeaders["content-type"] ?? "video/mp4";
    const contentLength = upHeaders["content-length"];
    const contentRange = upHeaders["content-range"];
    res.status(statusCode);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Accept-Ranges", "bytes");
    if (contentLength) res.setHeader("Content-Length", contentLength);
    if (contentRange) res.setHeader("Content-Range", contentRange);
    setCacheForResponse(res, contentType, decodeURIComponent(url));
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
    const upstream = await fetch(decodeURIComponent(url), {
      headers: { ...HEADERS, ...extraHeaders },
      signal: AbortSignal.timeout(30000),
      agent,
    });
    if (!upstream.ok) return res.status(upstream.status).json({ error: `Upstream error: ${upstream.status}` });
    const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    setCacheForResponse(res, contentType, decodeURIComponent(url));
    const buffer = await upstream.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// ── Sealed proxy endpoint ─────────────────────────────────────────────────────
router.get("/sealed/:token", async (req, res, next) => {
  try {
    const token = String(req.params.token).replace(/\.m3u8$/i, "");
    const originalPath = unsealProxyPath(token);
    const internalUrl = `http://127.0.0.1:${req.socket.localPort}${originalPath}${originalPath.includes("?") ? "&" : "?"}_cb=${Date.now()}`;
    const proxyBase = getProxyBase(req);
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    headers["x-proxy-base"] = proxyBase;
    headers["cache-control"] = "no-store";
    const r = await fetch(internalUrl, { method: req.method, headers, cache: "no-store" });
    res.status(r.status);
    const ct = r.headers.get("content-type") || "";
    const isText = /mpegurl|text|json|xml|vtt/i.test(ct);
    let body;
    if (isText) {
      body = sealProxyUrlsInText(await r.text(), proxyBase);
    } else {
      body = Buffer.from(await r.arrayBuffer());
    }
    const _hdr = {};
    r.headers.forEach((v, k) => {
      const kl = k.toLowerCase();
      if (["content-encoding", "transfer-encoding", "connection", "content-length", "cache-control", "access-control-allow-origin", "access-control-allow-headers", "access-control-allow-methods", "vary", "etag", "last-modified"].includes(kl)) return;
      _hdr[k] = v;
    });
    _hdr["Content-Type"] = ct;
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
  if (!existsSync(filepath)) return res.status(404).end();
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
