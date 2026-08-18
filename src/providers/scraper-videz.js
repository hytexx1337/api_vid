/**
 * scraper-videz.js
 *
 * Scraper VIDEASY desde 0, basado en el sample oficial de Python:
 *   EncDecEndpoints/samples/videasy.py
 *
 * ── FLUJO ──────────────────────────────────────────────────────────────────
 *  1. GET https://api.speedracelight.com/seed?mediaId={tmdbId}
 *        -> { seed: "<alphanumeric>" }
 *
 *  2. Para cada server deseado, armar URL con:
 *        title  DOBLE URL-encode (title -> encodeURIComponent -> encodeURIComponent)
 *        mediaType = "movie" | "tv"
 *        year / tmdbId / imdbId
 *        + episodeId / seasonId en caso de TV
 *        + enc=2  (version algoritmo)
 *        + seed={seed}
 *
 *     GET -> devuelve TEXTO CRIPTOGRAFADO (no JSON)
 *
 *  3. POST a https://enc-dec.app/api/dec-videasy
 *        body: { text: "<ciphertext>", id: tmdbId, seed: seed }
 *     -> { status: 200, result: <JSON con array de sources> }
 *
 * ── SERVERS ─────────────────────────────────────────────────────────────────
 *  Key       Ruta base                   Idioma        Notas
 *  ──────────────────────────────────────────────────────────────────────────
 *  yoru      cdn/sources-with-title      Original      4K a veces
 *  breach    m4uhd/sources-with-title    Original
 *  neon      vsrc/sources-with-title     Original
 *  vyse      hdmovie/sources-with-title  Original      filtrar quality English
 *  omen      lamovie/sources-with-title  Spanish (LAT) IMPORTANTE
 *  raze      superflix/sources-with-title Portuguese
 *
 * ── FORMATO DE SOURCE ───────────────────────────────────────────────────────
 * Cada entry decriptada tiene:
 *   { title, link?: "<direct m3u8/mp4>", sources?: [{ name, file: m3u8 }],
 *     tracks?: [{ label, file, kind }], quality?, language?, ... }
 *
 * Normalizamos a la misma estructura que el resto de la API:
 *   { url, type: "hls"|"mp4", provider: "videasy:<serverKey>",
 *     lang: "en"|"es"|"pt"|"de"|"hi"|..., quality?: "1080p"|...,
 *     referer: "https://player.videasy.to/",
 *     subtitles?: [{ label, file, kind, language }] }
 */

import { ProxyAgent, fetch as undiciFetch } from "undici";

// ── Configurable desde entorno ──────────────────────────────────────────────
const VIDEZ_HTTP_PROXY   = process.env.VIDEZ_HTTP_PROXY   || process.env.HTTP_PROXY || "";
const VIDEZ_CF_WORKER    = process.env.VIDEZ_CF_WORKER    || "";
const KAI_HTTP_PROXY     = process.env.KAI_HTTP_PROXY     || "";
const KAI_CF_WORKER      = process.env.KAI_CF_WORKER      || "";

// Preferimos proxy de Videasy, si no, re-usamos el de Kai (evita IPs bloqueadas)
const PROXY_URL = VIDEZ_HTTP_PROXY || KAI_HTTP_PROXY;
const CF_WORKER = VIDEZ_CF_WORKER  || KAI_CF_WORKER;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
const DEFAULT_REFERER = "https://player.videasy.to/";
const DEFAULT_ORIGIN  = "https://player.videasy.to";

const SEED_API    = "https://api.speedracelight.com/seed";
const SOURCE_API  = (server) => `https://api.speedracelight.com/${server}/sources-with-title`;
const DEC_API     = "https://enc-dec.app/api/dec-videasy";
const ENC_VERSION = "2";

// ── Servers que scrapeamos ───────────────────────────────────────────────────
//   ⚡ FÁCIL DE EXTENDER EN EL FUTURO: descomentá uno o agregá una entrada.
//   Cada server tiene su propio path de API y idioma default.
//   Si un server se cae temporalmente → retorna [] y no rompe el Promise.all.
//
//   Key       Ruta base                    Idioma default   Notas
//   ─────────────────────────────────────────────────────────────────────────
const SERVERS = [
  { key: "yoru", path: "cdn",  langDefault: "en", label: "Yoru (ORIG, 4K a veces)" },
  //
  // ──────────────────────────────── (futuro) ────────────────────────────────
  // { key: "breach",  path: "m4uhd",       langDefault: "en", label: "Breach (ORIG)" },
  // { key: "neon",    path: "vsrc",         langDefault: "en", label: "Neon (ORIG)" },
  // { key: "omen",    path: "lamovie",      langDefault: "es", label: "Omen (LAT-ES)"    },
  // { key: "raze",    path: "superflix",    langDefault: "pt", label: "Raze (PT-BR)"     },
  // { key: "vyse",    path: "hdmovie",      langDefault: "en", label: "Vyse (ORIG ENG only)" },
  // { key: "killjoy", path: "meine",        langDefault: "de", label: "Killjoy (ALE)"    },
  // { key: "fade",    path: "hdmovie",      langDefault: "hi", label: "Fade (HINDI)"     },
  // ──────────────────────────────────────────────────────────────────────────
];

// ── Cache local 3h (mismos TTL que vaplayer/cuevana) ───────────────────────
const CACHE_TTL = 3 * 60 * 60 * 1000;
const NEG_TTL   = 5 * 60 * 1000; // 5min si no hay sources
const cache = new Map();

// ── Helper fetch CON o SIN proxy ────────────────────────────────────────────
//   Si hay CF_WORKER configurado, pasamos por Cloudflare (evita bans de IP).
const PROXY_AGENT = PROXY_URL ? new ProxyAgent(PROXY_URL) : null;

async function kaiFetch(url, { timeoutMs = 15000, extraHeaders = {}, method = "GET", body = null } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  const headers = {
    "User-Agent": UA,
    "Accept": "*/*",
    ...extraHeaders,
  };
  // Si hay worker, forwardeamos por el
  if (CF_WORKER) {
    const qs = new URLSearchParams({
      url,
      ref: headers.Referer ?? DEFAULT_REFERER,
      method,
    });
    const finalUrl = `${CF_WORKER}/?${qs}`;
    const reqInit = {
      method: body ? "POST" : "GET",
      signal,
      headers: { "User-Agent": UA },
    };
    if (body) {
      reqInit.headers["Content-Type"] = "application/json";
      reqInit.body = (typeof body === "string") ? body : JSON.stringify(body);
    }
    return undiciFetch(finalUrl, reqInit);
  }
  const init = {
    method,
    signal,
    headers,
    dispatcher: PROXY_AGENT || undefined,
  };
  if (body) {
    init.headers["Content-Type"] = "application/json";
    init.body = (typeof body === "string") ? body : JSON.stringify(body);
  }
  return undiciFetch(url, init);
}

// ── Helpers de formato ──────────────────────────────────────────────────────
function doubleEncode(s) {
  if (!s) return "";
  return encodeURIComponent(encodeURIComponent(String(s)));
}

function pickQuality(quality, fileOrLink = "") {
  // Si viene explicitamente ej "1080p" OK
  if (quality && typeof quality === "string") return quality.trim();
  // Sino intentamos deducir de la URL (archivo 1080.m3u8 o /1080p/)
  const m = fileOrLink.match(/\b(2160|1440|1080|720|480|360)p?\b/i);
  if (m) return `${m[1]}p`;
  return undefined;
}

function pickLang(serverLangDefault, langField) {
  if (langField && typeof langField === "string") {
    const short = langField.toLowerCase();
    if (short.includes("esp") || short.includes("spa") || short.includes("lat")) return "es";
    if (short.includes("por") || short.includes("pt")) return "pt";
    if (short.includes("ing") || short === "en") return "en";
    if (short.includes("ale") || short === "de") return "de";
    if (short.includes("hin") || short === "hi") return "hi";
    return short.slice(0, 2);
  }
  return serverLangDefault || "en";
}

function getSubsFromTracks(tracks) {
  if (!Array.isArray(tracks)) return undefined;
  const mapped = tracks
    .filter(t => t && (t.file || t.src))
    .map(t => ({
      label:    t.label || t.name || t.language || "Subs",
      file:     t.file  || t.src,
      kind:     t.kind  || "captions",
      language: t.language || t.lang || t.label || "en",
    }));
  return mapped.length ? mapped : undefined;
}

// ── Paso 1: Seed ────────────────────────────────────────────────────────────
async function fetchSeed(tmdbId) {
  const url = `${SEED_API}?mediaId=${encodeURIComponent(tmdbId)}`;
  const r = await kaiFetch(url, {
    timeoutMs: 10000,
    extraHeaders: { Referer: DEFAULT_REFERER, Origin: DEFAULT_ORIGIN },
  });
  if (!r.ok) throw new Error(`seed HTTP ${r.status}`);
  const data = await r.json().catch(() => ({}));
  if (!data.seed || typeof data.seed !== "string") {
    throw new Error(`seed vacío, respuesta: ${JSON.stringify(data).slice(0, 150)}`);
  }
  return String(data.seed);
}

// ── Paso 2: Encrypted blob ──────────────────────────────────────────────────
async function fetchEncrypted(serverPath, { tmdbId, imdbId, title, year, mediaType, season, episode, seed }) {
  const params = new URLSearchParams({
    title: doubleEncode(title),
    mediaType,
    year:   String(year || ""),
    tmdbId: String(tmdbId),
    imdbId: imdbId ? String(imdbId) : "",
    enc:    ENC_VERSION,
    seed,
  });
  if (mediaType === "tv") {
    params.set("seasonId",  String(season));
    params.set("episodeId", String(episode));
  } else if (mediaType === "movie") {
    // los de movie no necesitan nada más que ya está arriba
  }
  const url = `${SOURCE_API(serverPath)}?${params.toString()}`;
  const r = await kaiFetch(url, {
    timeoutMs: 15000,
    extraHeaders: { Referer: DEFAULT_REFERER, Origin: DEFAULT_ORIGIN },
  });
  if (!r.ok) throw new Error(`encrypted HTTP ${r.status} server=${serverPath}`);
  const text = await r.text();
  if (!text || text.length < 32) {
    throw new Error(`encrypted vacío server=${serverPath}`);
  }
  return text;
}

// ── Paso 3: Decrypt via API oficial ─────────────────────────────────────────
async function decryptVideasy({ encText, tmdbId, seed }) {
  const payload = { text: encText, id: String(tmdbId), seed };
  const r = await kaiFetch(DEC_API, {
    method: "POST",
    timeoutMs: 15000,
    extraHeaders: {
      Referer: DEFAULT_REFERER,
      Origin:  "https://enc-dec.app",
      Accept:  "application/json",
    },
    body: payload,
  });
  if (!r.ok) throw new Error(`decrypt HTTP ${r.status}`);
  const data = await r.json().catch(() => null);
  if (!data || typeof data !== "object") throw new Error("decrypt: JSON inválido");
  if (data.status !== 200) {
    throw new Error(`decrypt status=${data.status} error=${data.error || "desconocido"}`);
  }
  if (data.result === undefined || data.result === null) {
    throw new Error("decrypt sin campo result");
  }
  return data.result;
}

// ── Paso 4: Normalizar sources decriptadas al formato de la API ─────────────
function normalizeSources(decryptedResult, serverKey, serverLangDefault) {
  const out = [];
  if (!decryptedResult) return out;

  // El result puede ser un solo source o un array de sources según server
  const list = Array.isArray(decryptedResult)
    ? decryptedResult
    : (Array.isArray(decryptedResult.sources) ? decryptedResult.sources : [decryptedResult]);

  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;

    const quality = pickQuality(entry.quality, entry.link || "");
    const lang = pickLang(serverLangDefault, entry.language);
    const subtitles = getSubsFromTracks(entry.tracks || entry.subtitles || entry.tracks_list);

    // Caso A: entry.sources = [{ file, name }] (multi-bitrate)
    if (Array.isArray(entry.sources) && entry.sources.length) {
      for (const src of entry.sources) {
        if (!src) continue;
        const url = src.file || src.src || src.url;
        if (!url) continue;
        const type = /\.mp4(\?|$)/i.test(url) ? "mp4" : "hls";
        out.push({
          url,
          type,
          provider: `videasy:${serverKey}`,
          lang,
          quality: pickQuality(src.name || src.quality || quality, url),
          referer: DEFAULT_REFERER,
          ...(subtitles ? { subtitles } : {}),
        });
      }
      continue;
    }

    // Caso B: entry.link directo (master único)
    if (entry.link || entry.url || entry.file) {
      const url = entry.link || entry.url || entry.file;
      const type = /\.mp4(\?|$)/i.test(url) ? "mp4" : "hls";
      out.push({
        url,
        type,
        provider: `videasy:${serverKey}`,
        lang,
        quality,
        referer: DEFAULT_REFERER,
        ...(subtitles ? { subtitles } : {}),
      });
    }
  }

  return out;
}

// ── Scraper de UN server particular ─────────────────────────────────────────
async function scrapeOneServer(server, ctx) {
  try {
    const encText = await fetchEncrypted(server.path, ctx);
    const dec = await decryptVideasy({ encText, tmdbId: ctx.tmdbId, seed: ctx.seed });
    const normalized = normalizeSources(dec, server.key, server.langDefault);
    if (normalized.length === 0) {
      console.warn(`[videasy:${server.key}] decriptado OK pero 0 sources normalizados`);
    }
    return normalized;
  } catch (e) {
    console.warn(`[videasy:${server.key}] falló:`, e.message);
    return [];
  }
}

// ── API pública: Streams de Videasy para movie/tv ───────────────────────────
/**
 * @param {string|number} tmdbId
 * @param {"tv"|"movie"} mediaType
 * @param {{season?:string|number,episode?:string|number,year?:string|number,title?:string,imdbId?:string|number}} meta
 * @returns {Promise<Array<{
 *   url:string, type:"hls"|"mp4", provider:string,
 *   lang:string, quality?:string, referer:string, subtitles?:any[]
 * }>>}
 */
export async function getVideasyStreams(tmdbId, mediaType, meta = {}) {
  const title = meta.title || "";
  const year  = meta.year  || "";
  const cacheKey = mediaType === "tv"
    ? `videz:tv:${tmdbId}:${meta.season}:${meta.episode}`
    : `videz:movie:${tmdbId}`;

  const hit = cache.get(cacheKey);
  if (hit) {
    if (Date.now() < hit.expiresAt) return hit.data;
  }

  let out = [];
  try {
    // Paso 1: seed (una sola vez, compartido por todos los servers)
    const seed = await fetchSeed(tmdbId);

    const ctx = {
      tmdbId: String(tmdbId),
      imdbId: meta.imdbId ? String(meta.imdbId) : "",
      title,
      year: String(year),
      mediaType,
      season:  meta.season  ? String(meta.season)  : "1",
      episode: meta.episode ? String(meta.episode) : "1",
      seed,
    };

    // Paso 2+3+4: todos los servers EN PARALELO (igual que el resto de scrapers)
    const results = await Promise.all(SERVERS.map(srv => scrapeOneServer(srv, ctx)));
    out = results.flat();

    // Pequeño re-orden: latinos primero
    out.sort((a, b) => {
      const rk = (x) => ({ es: 0, pt: 1, en: 2, de: 3, hi: 4 }[x.lang] ?? 5);
      return rk(a) - rk(b);
    });
  } catch (e) {
    console.warn(`[videasy] error global ${cacheKey}:`, e.message);
  }

  cache.set(cacheKey, {
    data: out,
    expiresAt: Date.now() + (out.length ? CACHE_TTL : NEG_TTL),
  });
  return out;
}

// Helpers monofunción como tienen los otros scrapers (conveniencia)
export async function getVideasyMovieStreams(tmdbId, meta = {}) {
  return getVideasyStreams(tmdbId, "movie", meta);
}
export async function getVideasyTvStreams(tmdbId, season, episode, meta = {}) {
  return getVideasyStreams(tmdbId, "tv", { ...meta, season, episode });
}

/**
 * Helper SINGULAR (1 stream por provider), MISMA INTERFAZ que getVaplayerStream / getVidupStream.
 * Necesario para que la integración en index.js sea 1 a 1 igual que el resto:
 *   index.js espera un objeto: { url, type:"hls"|"mp4", provider, referer, lang?, quality? }
 *                                    ↑ lo transforma luego en effectiveUrl/proxiedUrl via sealProxyPath
 *
 * Devuelve el MEJOR stream de la lista:
 *   - Preferencia 1: ES/PT si hay
 *   - Preferencia 2: mayor resolución (2160 > 1080 > 720 > 480)
 */
const _qRank = { "2160p": 8, "1440p": 7, "1080p": 6, "720p": 5, "480p": 4, "360p": 3 };
function _qualityScore(s) {
  if (s?.quality && _qRank[s.quality]) return _qRank[s.quality];
  const m = String(s.url + (s.quality || "")).match(/\b(2160|1440|1080|720|480|360)p?\b/i);
  return m ? _qRank[`${m[1]}p`] ?? 0 : 0;
}
export async function getVideasyStream(tmdbId, mediaType, season, episode, meta = {}) {
  const all = await getVideasyStreams(tmdbId, mediaType, { ...meta, season, episode });
  if (!all.length) return null;
  const sorted = [...all].sort((a, b) => {
    const rk = (x) => ({ es: 0, pt: 1, en: 2, de: 3, hi: 4 }[x.lang] ?? 5);
    if (rk(a) !== rk(b)) return rk(a) - rk(b);
    return _qualityScore(b) - _qualityScore(a);
  });
  return sorted[0];
}

