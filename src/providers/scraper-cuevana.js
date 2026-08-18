import vm from "vm";
import crypto from "crypto";

/**
 * scraper-cuevana.js
 * 
 * Fuente: embed69.org
 * Formato URL: /f/{imdbId}-{season}x{episode}/
 * 
 * Flujo:
 *  1. Fetch embed69.org → extraer `dataLink` (array en JS inline)
 *  2. Decodear JWTs del payload → URLs de servidores
 *  3. Para idioma LAT: preferir streamwish → vidhide
 *  4. Extraer m3u8 del embed (directo o via eval-packer)
 *
 * Todo el scraping pasa por el CF Worker (IPs de Cloudflare, nunca la IP del VPS).
 */

const BASE69       = "https://embed69.org";
const VIDHIDE_BASE = "https://minochinos.com";

// Worker de Cloudflare — proxy para scraping + /check para validación
const CF_WORKER = "https://cuevana-proxy.vidify-proxy.workers.dev";

const SW_MIRRORS = ["https://wishonly.site", "https://swdyu.com", "https://audinifer.com"];

// Todas las requests a embed69/vidhide/streamwish pasan por el Worker
// El Worker recibe ?url=<encoded>&ref=<referer> y retorna el body tal cual
async function cfFetch(url, options = {}) {
  const ref = options.headers?.Referer ?? options.headers?.referer ?? "";
  const qs = `url=${encodeURIComponent(url)}${ref ? `&ref=${encodeURIComponent(ref)}` : ""}`;
  return fetch(`${CF_WORKER}/?${qs}`, {
    signal: options.signal ?? AbortSignal.timeout(15000),
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function decodeJwt(token) {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(part, "base64").toString("utf8"));
  } catch { return null; }
}

function extractPowParams(html) {
  const challenge = html.match(/POW_CHALLENGE\s*=\s*'([^']+)'/)?.[1] ?? null;
  const difficultyRaw = html.match(/POW_DIFFICULTY\s*=\s*(\d+)/)?.[1] ?? null;
  const salt = html.match(/POW_SALT\s*=\s*'([^']+)'/)?.[1] ?? null;
  const difficulty = difficultyRaw != null ? parseInt(difficultyRaw, 10) : null;
  if (!challenge || !salt || difficulty == null || Number.isNaN(difficulty)) return null;
  return { challenge, difficulty, salt };
}

function sha256Hex(str) {
  return crypto.createHash("sha256").update(str, "utf8").digest("hex");
}

function sha256Bytes(str) {
  return crypto.createHash("sha256").update(str, "utf8").digest();
}

function solvePowNonce(challenge, difficulty, { maxIterations = 15_000_000, maxMs = 12_000 } = {}) {
  const prefix = "0".repeat(Math.max(0, difficulty));
  const t0 = Date.now();
  for (let nonce = 0; nonce < maxIterations; nonce++) {
    if (Date.now() - t0 > maxMs) throw new Error("PoW timeout");
    if (sha256Hex(challenge + nonce).startsWith(prefix)) return nonce;
  }
  throw new Error("PoW no resuelto");
}

function decryptEmbedLink(encryptedBase64, aesKeyBytes) {
  const raw = Buffer.from(encryptedBase64, "base64");
  if (raw.length <= 16) return null;
  const iv = raw.subarray(0, 16);
  const ciphertext = raw.subarray(16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", aesKeyBytes.subarray(0, 32), iv);
  const out = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  return out?.trim() || null;
}

function decodeEmbed69Link(rawLink, aesKeyBytes) {
  if (!rawLink) return null;
  if (/^https?:\/\//i.test(rawLink)) return rawLink;
  if (rawLink.split(".").length === 3) {
    const payload = decodeJwt(rawLink);
    if (payload?.link) return payload.link;
  }
  if (aesKeyBytes) return decryptEmbedLink(rawLink, aesKeyBytes);
  return null;
}

function unpackEval(html) {
  // Extraer el bloque completo eval(function(p,a,c,k,e,d){...}(...))
  const start = html.indexOf("eval(function(p,a,c,k,e,d)");
  if (start === -1) return null;

  // Encontrar el paréntesis de cierre balanceando
  let depth = 0, i = start + 4; // empezar después de "eval"
  for (; i < html.length; i++) {
    if (html[i] === "(") depth++;
    else if (html[i] === ")") { depth--; if (depth === 0) { i++; break; } }
  }
  const packerCall = html.slice(start, i);

  try {
    // Ejecutar en sandbox — el packer devuelve una string con el código desofuscado
    const sandbox = { result: "" };
    vm.runInNewContext(
      `result = (function() { var _out = ""; var _eval = eval; eval = function(s){ _out = s; }; ${packerCall}; return _out; })()`,
      sandbox,
      { timeout: 1000 }
    );
    return sandbox.result || null;
  } catch {
    return null;
  }
}

/**
 * Desempaqueta el HTML y extrae streams HLS + thumbnail del JWPlayer setup.
 * Devuelve { candidates: [{url, headers}], thumbnailVtt, thumbnailJpg }
 *
 * Orden de preferencia de streams:
 *   hls3 = CDN externo sin token IP (streamwish master.txt) — mejor opción
 *   hls2 = CDN externo con token largo (~36h), no IP-restringido
 *   hls4 = URL del servidor del mirror — IP-restringida, última opción
 *
 * Thumbnails (JWPlayer tracks kind:"thumbnails"):
 *   thumbnailVtt = URL completa del endpoint get_slides (devuelve VTT con sprites)
 *   thumbnailJpg = URL del sprite base (parámetro url= dentro del file)
 */
function extractStreamData(html, baseUrl) {
  const up = unpackEval(html) ?? html;
  const mirrorOrigin = new URL(baseUrl).origin;
  const embedReferer = baseUrl.startsWith("http") ? baseUrl : mirrorOrigin + "/";
  const streamHeaders = { "Referer": embedReferer, "Origin": mirrorOrigin };

  // ── Streams ───────────────────────────────────────────────────────────────
  const candidates = [];
  const linksMatch = up.match(/var\s+links\s*=\s*(\{[^}]+\})/);
  if (linksMatch) {
    const links = {};
    for (const [, key, val] of linksMatch[1].matchAll(/"(\w+)"\s*:\s*"([^"]+)"/g)) {
      links[key] = val;
    }
    if (links.hls4?.startsWith("/")) links.hls4 = new URL(links.hls4, baseUrl).href;
    if (links.hls3) candidates.push({ url: links.hls3, headers: streamHeaders });
    if (links.hls2) candidates.push({ url: links.hls2, headers: streamHeaders });
    if (links.hls4) candidates.push({ url: links.hls4, headers: streamHeaders });
  } else {
    const direct = up.match(/["'`](https?:\/\/[^"'`\s]+\.m3u8[^"'`\s]*)/)?.[1];
    if (direct) candidates.push({ url: direct, headers: streamHeaders });
  }

  // ── Thumbnails ────────────────────────────────────────────────────────────
  // JWPlayer: tracks:[{file:"/dl?op=get_slides&length=XXX&url=https://...0000.jpg",kind:"thumbnails"}]
  const trackFile = up.match(/file:"([^"]+)",kind:"thumbnails"/)?.[1] ?? null;
  let thumbnailVtt = null;
  let thumbnailJpg = null;
  if (trackFile) {
    thumbnailVtt = trackFile.startsWith("http") ? trackFile : `${mirrorOrigin}${trackFile}`;
    const qs = trackFile.includes("?") ? trackFile.split("?")[1] : "";
    thumbnailJpg = new URLSearchParams(qs).get("url") ?? null;
  }

  return { candidates, thumbnailVtt, thumbnailJpg };
}

// Verifica que una URL responde 2xx/206 usando el CF Worker (IPs de Cloudflare)
async function checkUrl(url, headers = {}) {
  try {
    const ref    = headers["Referer"] ?? headers["referer"] ?? "";
    const origin = headers["Origin"]  ?? headers["origin"]  ?? (ref ? new URL(ref).origin : "");
    const params = new URLSearchParams({ url });
    if (ref)    params.set("ref", ref);
    if (origin) params.set("origin", origin);
    const r = await fetch(`${CF_WORKER}/check?${params}`, { signal: AbortSignal.timeout(10000) });
    const data = await r.json();
    return data.ok === true;
  } catch { return false; }
}

// Devuelve el primer candidato válido.
// master.txt (hls3) se confía directamente — funciona en player aunque el CDN
// rechace HEAD/GET simples. El resto se valida via CF Worker.
async function firstWorking(candidates) {
  for (const candidate of candidates) {
    if (candidate.url.endsWith(".txt")) return candidate;
    if (await checkUrl(candidate.url, candidate.headers)) return candidate;
    console.warn(`[cuevana] no responde → ${candidate.url.slice(0, 80)}...`);
  }
  return null;
}

// ── Paso 1: Obtener links de embed69 ─────────────────────────────────────────

async function fetchEmbed69Links(embed69Url) {
  const r = await cfFetch(embed69Url, {
    headers: { "Referer": BASE69 + "/" },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`embed69 HTTP ${r.status}`);
  const html = await r.text();

  const match =
    html.match(/let\s+dataLink\s*=\s*(\[[\s\S]+?\]);/i) ??
    html.match(/const\s+dataLink\s*=\s*(\[[\s\S]+?\]);/i) ??
    html.match(/var\s+dataLink\s*=\s*(\[[\s\S]+?\]);/i) ??
    html.match(/dataLink\s*=\s*(\[[\s\S]+?\]);/i) ??
    null;
  if (!match) throw new Error("dataLink no encontrado en embed69");
  const dataLink = JSON.parse(match[1]);

  const pow = extractPowParams(html);
  const aesKeyBytes = pow
    ? sha256Bytes(pow.challenge + solvePowNonce(pow.challenge, pow.difficulty) + pow.salt)
    : null;

  const result = {};
  for (const file of dataLink) {
    const lang = file.video_language; // LAT, ESP, SUB, ENG...
    result[lang] = (file.sortedEmbeds || []).flatMap(embed => {
      const url = decodeEmbed69Link(embed.link, aesKeyBytes);
      if (!url) return [];
      return [{ server: embed.servername, url }];
    });
  }
  return result;
}

// ── Paso 2: Extraer m3u8 de un embed de servidor ─────────────────────────────

async function extractFromEmbed(embedUrl, referer, name = "embed") {
  const r = await cfFetch(embedUrl, {
    headers: { "Referer": referer },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`${name} HTTP ${r.status}`);
  const html = await r.text();
  const { candidates, thumbnailVtt, thumbnailJpg } = extractStreamData(html, embedUrl);
  if (!candidates.length) throw new Error(`No se encontraron streams en ${name}`);
  const result = await firstWorking(candidates);
  if (!result) throw new Error(`Todos los streams de ${name} dieron 404`);
  return { ...result, thumbnailVtt, thumbnailJpg };
}

async function extractFromVidhide(embedUrl, referer) {
  return extractFromEmbed(embedUrl, referer, "vidhide");
}

function base64urlDecode(str) {
  const s = str.replace(/-/g, "+").replace(/_/g, "/").padEnd(str.length + (4 - str.length % 4) % 4, "=");
  return Buffer.from(s, "base64");
}

function filemoonSelectKeyParts(keyParts, version) {
  const len = keyParts.length;
  const a = version ^ 0;
  const b = 31 - (version ^ 0);
  const indices = [a, b].filter(i => Number.isInteger(i) && i >= 1 && i <= len);
  if (indices.length === 0) return keyParts;
  const selected = indices.map(i => keyParts[i - 1]).filter(p => typeof p === "string" && p.length > 0);
  return selected.length > 0 ? selected : keyParts;
}

async function extractFromFilemoon(embedUrl, referer) {
  const fileCode = embedUrl.split("/").filter(Boolean).pop();
  const origin = new URL(embedUrl).origin;
  const apiUrl = `${origin}/api/videos/${fileCode}`;

  // Fetch directo — el CF Worker no permite este dominio
  const r = await fetch(apiUrl, {
    headers: {
      "Referer": embedUrl, "Origin": origin,
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`filemoon API HTTP ${r.status}`);

  const data = await r.json();
  const playback = data.playback;
  if (!playback) throw new Error("filemoon: no playback en respuesta API");

  const selectedParts = filemoonSelectKeyParts(playback.key_parts ?? [], playback.version ?? 0);
  const key = Buffer.concat(selectedParts.map(base64urlDecode));
  if (key.length === 0) throw new Error("filemoon: key vacía tras selección");

  for (const [ivProp, payloadProp] of [["iv", "payload"], ["iv2", "payload2"]]) {
    if (!playback[ivProp] || !playback[payloadProp]) continue;
    try {
      const iv      = base64urlDecode(playback[ivProp]);
      const ciphered = base64urlDecode(playback[payloadProp]);
      const tag = ciphered.slice(-16);
      const ct  = ciphered.slice(0, -16);
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
      const sources = JSON.parse(plain.toString("utf8"));

      let url = null;
      if (Array.isArray(sources.sources)) {
        url = sources.sources.sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0]?.url ?? null;
      }
      url ??= sources.source ?? sources.file ?? null;
      if (!url) throw new Error("filemoon: no URL en sources descifradas");

      return { url, headers: { "Referer": embedUrl, "Origin": origin }, thumbnailVtt: null, thumbnailJpg: null };
    } catch (e) {
      // intentar con el otro par iv/payload
    }
  }
  throw new Error("filemoon: no se pudo descifrar ningún payload");
}

async function extractFromStreamwish(originalUrl, referer) {
  const embedId = originalUrl.split("/").filter(Boolean).pop();

  // Todos los mirrors de Streamwish sirven el mismo embed ID con HTML completo.
  // hglink.to solo tiene una página de "Loading..." con JS client-side, así que
  // iteramos mirrors reales hasta encontrar uno con el eval-packer.
  for (const mirror of SW_MIRRORS) {
    const mirrorUrl = `${mirror}/e/${embedId}`;
    try {
      const r = await cfFetch(mirrorUrl, {
        headers: { "Referer": referer },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) { console.warn(`[cuevana] ${mirror} HTTP ${r.status}`); continue; }
      const html = await r.text();
      const { candidates, thumbnailVtt, thumbnailJpg } = extractStreamData(html, mirrorUrl);
      if (!candidates.length) { console.warn(`[cuevana] ${mirror} sin eval-packer`); continue; }
      const result = await firstWorking(candidates);
      if (!result) { console.warn(`[cuevana] ${mirror} streams 404`); continue; }
      console.log(`[cuevana] streamwish OK via ${mirror}`);
      return { ...result, thumbnailVtt, thumbnailJpg };
    } catch (e) {
      console.warn(`[cuevana] ${mirror} error: ${e.message}`);
    }
  }
  throw new Error("Todos los mirrors de streamwish fallaron");
}

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Resuelve todos los servidores LAT en paralelo y devuelve los que funcionan.
 * @returns {Promise<Array<{url, headers, server, thumbnailVtt?, thumbnailJpg?}>>}
 */
async function resolveAllLat(allLinks) {
  const latServers = allLinks["LAT"];
  if (!latServers?.length) throw new Error("No hay servidores LAT disponibles");

  const referer = `${BASE69}/`;

  const resolvers = [
    {
      name: "streamwish",
      entry: latServers.find(s => s.server === "streamwish"),
      resolve: async (entry) => {
        const result = await extractFromStreamwish(entry.url, referer);
        return {
          url: result.url, headers: result.headers, server: "streamwish",
          ...(result.thumbnailVtt && { thumbnailVtt: result.thumbnailVtt }),
          ...(result.thumbnailJpg && { thumbnailJpg: result.thumbnailJpg }),
        };
      },
    },
    {
      name: "vidhide",
      entry: latServers.find(s => s.server === "vidhide"),
      resolve: async (entry) => {
        const result = await extractFromVidhide(entry.url, referer);
        return {
          url: result.url, headers: result.headers, server: "vidhide",
          ...(result.thumbnailVtt && { thumbnailVtt: result.thumbnailVtt }),
          ...(result.thumbnailJpg && { thumbnailJpg: result.thumbnailJpg }),
        };
      },
    },
    {
      name: "filemoon",
      entry: latServers.find(s => s.server === "filemoon"),
      resolve: async (entry) => {
        const result = await extractFromFilemoon(entry.url, referer);
        return {
          url: result.url, headers: result.headers, server: "filemoon",
          ...(result.thumbnailVtt && { thumbnailVtt: result.thumbnailVtt }),
          ...(result.thumbnailJpg && { thumbnailJpg: result.thumbnailJpg }),
        };
      },
    },
  ];

  const results = await Promise.all(
    resolvers.map(({ name, entry, resolve }) => {
      if (!entry) return Promise.resolve(null);
      return resolve(entry).catch(e => {
        console.warn(`[cuevana] ${name} falló:`, e.message);
        return null;
      });
    })
  );

  const working = results.filter(Boolean);
  if (!working.length) throw new Error("Todos los servidores LAT fallaron (" + resolvers.filter(r=>r.entry).map(r=>r.name).join(", ") + ")");
  console.log(`[cuevana] OK → ${working.map(s=>s.server).join(", ")}`);
  return working;
}

/**
 * Todos los streams LAT disponibles de un episodio de serie.
 */
export async function getCuevanaStreams(imdbId, season, episode) {
  const s = String(season);
  const e = String(episode).padStart(2, "0");
  console.log(`[cuevana] tv imdb=${imdbId} S${s}E${e}...`);
  const allLinks = await fetchEmbed69Links(`${BASE69}/f/${imdbId}-${s}x${e}/`);
  const langs = Object.keys(allLinks);
  const latCount = allLinks["LAT"]?.length ?? 0;
  console.log(`[cuevana] links: langs=[${langs}] LAT=${latCount}`);
  return resolveAllLat(allLinks);
}

/**
 * Todos los streams LAT disponibles de una película.
 */
export async function getCuevanaMovieStreams(imdbId) {
  console.log(`[cuevana] movie imdb=${imdbId}...`);
  const allLinks = await fetchEmbed69Links(`${BASE69}/f/${imdbId}/`);
  const langs = Object.keys(allLinks);
  const latCount = allLinks["LAT"]?.length ?? 0;
  console.log(`[cuevana] links: langs=[${langs}] LAT=${latCount}`);
  return resolveAllLat(allLinks);
}

/** @deprecated Usa getCuevanaStreams */
export async function getCuevanaStream(imdbId, season, episode) {
  const streams = await getCuevanaStreams(imdbId, season, episode);
  return streams[0];
}

/** @deprecated Usa getCuevanaMovieStreams */
export async function getCuevanaMovie(imdbId) {
  const streams = await getCuevanaMovieStreams(imdbId);
  return streams[0];
}

// ── AniList → IMDB (via Fribb anime-lists) ───────────────────────────────────

const FRIBB_URL = "https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json";
let fribbMap = null; // Map<anilistId, imdbId>
let fribbLoading = null;

async function loadFribbMap() {
  if (fribbMap) return fribbMap;
  if (fribbLoading) return fribbLoading;
  fribbLoading = fetch(FRIBB_URL, { signal: AbortSignal.timeout(15000) })
    .then(r => r.json())
    .then(list => {
      fribbMap = new Map();
      for (const entry of list) {
        if (entry.anilist_id && entry.imdb_id)
          fribbMap.set(entry.anilist_id, {
            imdb_id: entry.imdb_id,
            type: entry.type ?? "TV",
            // Preferimos el season de tvdb (numera temporadas reales dentro de la serie)
            // tmdb trata cada temporada como una serie nueva → siempre devuelve 1
            season: entry.season?.tvdb ?? entry.season?.tmdb ?? 1,
          });
      }
      console.log(`[cuevana] Fribb anime-list cargado: ${fribbMap.size} entradas`);
      return fribbMap;
    });
  return fribbLoading;
}

export async function anilistToImdb(anilistId) {
  const map = await loadFribbMap();
  return map.get(parseInt(anilistId)) ?? null;
}

const MOVIE_TYPES = new Set(["Movie", "movie", "MOVIE"]);

/**
 * Stream LAT de anime via embed69, usando AniList ID.
 * Detecta automáticamente si es película o serie y qué temporada usar.
 * @param {string|number} anilistId
 * @param {number} episode
 */
/**
 * Todos los streams LAT de anime via embed69, usando AniList ID.
 * @returns {Promise<Array>}
 */
export async function getCuevanaAnime(anilistId, episode) {
  const entry = await anilistToImdb(anilistId);
  if (!entry) throw new Error(`No se encontró IMDB ID para AniList ${anilistId}`);

  const { imdb_id, type, season } = entry;

  if (MOVIE_TYPES.has(type)) {
    return getCuevanaMovieStreams(imdb_id);
  }

  return getCuevanaStreams(imdb_id, season, episode);
}

// ── Test rápido ───────────────────────────────────────────────────────────────
if (process.argv[1].includes("scraper-cuevana")) {
  const args = process.argv.slice(2);
  const getArg = (name) => {
    const idx = args.indexOf(`--${name}`);
    if (idx === -1) return null;
    return args[idx + 1] ?? null;
  };
  const hasFlag = (name) => args.includes(`--${name}`);

  if (hasFlag("debug-embed69")) {
    const url = getArg("debug-embed69") ?? args.find((a) => /^https?:\/\//i.test(a)) ?? null;
    if (!url) throw new Error("Falta URL: --debug-embed69 <url>");
    const r = await cfFetch(url, { headers: { Referer: BASE69 + "/" }, signal: AbortSignal.timeout(15000) });
    const html = await r.text();
    const idx = html.indexOf("dataLink");
    const around = idx === -1 ? null : html.slice(Math.max(0, idx - 250), idx + 750);
    const dataLinkMatch =
      html.match(/let\s+dataLink\s*=\s*(\[[\s\S]+?\]);/i) ??
      html.match(/const\s+dataLink\s*=\s*(\[[\s\S]+?\]);/i) ??
      html.match(/var\s+dataLink\s*=\s*(\[[\s\S]+?\]);/i) ??
      html.match(/dataLink\s*=\s*(\[[\s\S]+?\]);/i) ??
      null;
    const dataLinkRaw = dataLinkMatch?.[1] ?? null;
    let dataLinkParsed = null;
    let dataLinkParseError = null;
    if (dataLinkRaw) {
      try {
        dataLinkParsed = JSON.parse(dataLinkRaw);
      } catch (e) {
        dataLinkParseError = e?.message ?? String(e);
      }
    }
    const sample =
      Array.isArray(dataLinkParsed) && dataLinkParsed.length
        ? dataLinkParsed.slice(0, 1).map((f) => ({
            file_id: f.file_id,
            video_language: f.video_language,
            sortedEmbedsCount: Array.isArray(f.sortedEmbeds) ? f.sortedEmbeds.length : null,
            sortedEmbeds: Array.isArray(f.sortedEmbeds)
              ? f.sortedEmbeds.slice(0, 6).map((x) => ({
                  servername: x.servername,
                  type: x.type,
                  linkSample: typeof x.link === "string" ? x.link.slice(0, 50) : null,
                  linkLooksLikeJwt: typeof x.link === "string" ? x.link.split(".").length === 3 : false,
                }))
              : null,
          }))
        : null;
    console.log(JSON.stringify({
      ok: r.ok,
      status: r.status,
      url,
      hasDataLink: idx !== -1,
      dataLinkContext: around,
      dataLinkRegexMatched: !!dataLinkMatch,
      dataLinkParseOk: Array.isArray(dataLinkParsed),
      dataLinkParseError,
      dataLinkSample: sample,
    }, null, 2));
    if (!r.ok) process.exit(1);
    try {
      const links = await fetchEmbed69Links(url);
      const decoded = Object.fromEntries(Object.entries(links).map(([lang, arr]) => [
        lang,
        arr.map(x => ({ server: x.server, url: x.url })),
      ]));
      console.log(JSON.stringify({ parsed: true, languages: Object.keys(links), decoded }, null, 2));
    } catch (e) {
      console.log(JSON.stringify({ parsed: false, error: e.message }, null, 2));
      process.exit(2);
    }
    process.exit(0);
  }

  if (hasFlag("debug-anilist")) {
    const anilistId = getArg("debug-anilist");
    const episode = parseInt(getArg("episode") ?? "1");
    if (!anilistId) throw new Error("Falta anilistId: --debug-anilist <id> --episode <n>");
    console.log(`\nBuscando AniList ${anilistId} ep ${episode}...`);
    const streams = await getCuevanaAnime(anilistId, episode);
    console.log("\n✓ RESULTADO:");
    console.log(JSON.stringify(streams, null, 2));
    process.exit(0);
  }

  if (args.length === 1) {
    console.log(`\nBuscando película ${args[0]}...`);
    const stream = await getCuevanaMovie(args[0]);
    console.log("\n✓ RESULTADO:");
    console.log(JSON.stringify(stream, null, 2));
    process.exit(0);
  }

  const [imdb, s, e] = args.length === 3 ? args : ["tt30460310", "1", "1"];
  console.log(`\nBuscando ${imdb} S${s}E${e}...`);
  const streams = await getCuevanaStreams(imdb, +s, +e);
  console.log(`\n✓ RESULTADO (${streams.length} streams):`);
  console.log(JSON.stringify(streams, null, 2));
  process.exit(0);
}
