// scraper-cinejoy.js
//
// cinejoy.to — flujo cifrado via ECDH P-256 + AES-GCM + WASM (crush.wasm)
// sobre api.shegu.st. Se usa el módulo de criptografía local
// vendor/cinejoy-crypto2.js (basado en el chunk DUnJ-byT.js de CineJoy) para
// resolver /g y los endpoints de sources sin browser automation.

import { D0 } from "../../vendor/cinejoy-crypto2.js";

const FETCH_TIMEOUT = 30000;

const PRIORITY_SERVERS = new Set(
  (process.env.CINEJOY_PRIORITY_SERVERS || "Lisbon")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

function normalizeCaptions(captions = []) {
  return captions.map((c) => ({
    label: c.label ?? c.language ?? "Unknown",
    lang: c.language ?? c.lang ?? "en",
    url: c.file ?? c.url,
  })).filter((c) => c.url);
}

// ---------- cache ----------

const _cache = new Map();
function cacheGet(k) {
  const e = _cache.get(k);
  if (!e) return null;
  if (Date.now() > e.exp) { _cache.delete(k); return null; }
  return e.val;
}
function cacheSet(k, v, ttl) { _cache.set(k, { val: v, exp: Date.now() + ttl }); }

const TTL_OK = 30 * 60 * 1000;
const TTL_ERR = 5 * 60 * 1000;

function withTimeout(promise, ms, reason) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(reason)), ms)),
  ]);
}

// ---------- export principal ----------

/**
 * @param {object} opts
 * @param {string|number} opts.tmdbId
 * @param {"tv"|"movie"} opts.mediaType
 * @param {string} opts.title - título (en inglés, original) requerido por la API de cinejoy
 * @param {string|number} [opts.year]
 * @param {string} [opts.imdbId]
 * @param {string|number} [opts.season]
 * @param {string|number} [opts.episode]
 * @returns {Promise<{url:string,type:string,provider:string,referer:string,subtitles:Array}|null>}
 */
export async function getCinejoyStream({ tmdbId, mediaType, title, year, imdbId, season, episode }) {
  if (!title) return null;
  const type = mediaType === "tv" ? "series" : "movie";
  const cacheKey = type === "series"
    ? `cinejoy:tv:${tmdbId}:${season}:${episode}`
    : `cinejoy:movie:${tmdbId}`;

  const cached = cacheGet(cacheKey);
  if (cached !== null) return cached;

  const params = {
    tmdb: String(tmdbId),
    tmdbId: String(tmdbId),
    id: String(tmdbId),
    title,
    year: year ? String(year) : undefined,
    imdb: imdbId,
    imdbId,
    season: season ? Number(season) : undefined,
    s: season ? Number(season) : undefined,
    episode: episode ? Number(episode) : undefined,
    e: episode ? Number(episode) : undefined,
  };

  const preferred = [...PRIORITY_SERVERS][0];

  try {
    const result = await withTimeout(
      D0(type, params, (ev) => {
        if (ev?.status === "failed" && ev?.error) {
          console.warn(`[cinejoy] ${ev.provider}: ${ev.error}`);
        }
      }, preferred),
      FETCH_TIMEOUT,
      `cinejoy: timeout para ${cacheKey}`
    );

    if (result?.result?.url) {
      const stream = {
        url: result.result.url,
        type: result.result.sourceType === "mp4" ? "mp4" : "hls",
        provider: `cinejoy/${preferred || "auto"}`,
        referer: "https://cinejoy.to/",
        subtitles: normalizeCaptions(result.result.captions),
      };
      console.log(`[cinejoy] stream para ${cacheKey}: ${stream.url}`);
      cacheSet(cacheKey, stream, TTL_OK);
      return stream;
    }

    console.warn(`[cinejoy] sin sources para ${cacheKey}: ${result?.failure || "unknown"}`);
    cacheSet(cacheKey, null, TTL_ERR);
    return null;
  } catch (err) {
    console.warn(`[cinejoy] error para ${cacheKey}:`, err.message);
    cacheSet(cacheKey, null, TTL_ERR);
    return null;
  }
}
