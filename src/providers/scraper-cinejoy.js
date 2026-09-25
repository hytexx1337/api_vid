// scraper-cinejoy.js
//
// cinejoy.pk — flujo cifrado via ECDH P-256 + AES-GCM + WASM (crush.wasm)
// sobre api.wing.st (antes api.shegu.st — el dominio viejo quedó embebido
// en el chunk ofuscado, se reescribe en fetch abajo). Se usa el módulo de
// criptografía local vendor/cinejoy-crypto2.js (basado en el chunk
// DUnJ-byT.js de CineJoy) para resolver /g y los endpoints de sources sin
// browser automation.

import { D0 } from "../../vendor/cinejoy-crypto2.js";

// Migración de dominio: el vendor tiene api.shegu.st hardcodeado (ofuscado).
// Durante D0 se envuelve globalThis.fetch reescribiendo el host — refcount
// para que D0s concurrentes no restauren el fetch antes de tiempo.
const CINEJOY_HOST_FIX = { "api.shegu.st": "api.wing.st" };
const realFetch = globalThis.fetch;
let cjFetchRefs = 0;
function cjFetchAcquire() {
  if (cjFetchRefs++ === 0) {
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input?.url;
      const fixed = url?.replace(/api\.shegu\.st|api\.wing\.st/, (h) => CINEJOY_HOST_FIX[h] ?? h);
      if (fixed === url) return realFetch(input, init);
      return realFetch(typeof input === "string" ? fixed : new Request(fixed, input), init);
    };
  }
}
function cjFetchRelease() {
  if (--cjFetchRefs === 0) globalThis.fetch = realFetch;
}

const FETCH_TIMEOUT = 30000;

// Lista de servers por prioridad. Todos se resuelven y verifican en paralelo
// (cada uno sale por su propio CDN) — gana el primero en este orden cuyo
// playlist responda. Así un CDN caído no suma latencia.
const PRIORITY_SERVERS = (
  process.env.CINEJOY_PRIORITY_SERVERS || "Lisbon,Solara,Nebula,Athens"
).split(",").map((s) => s.trim()).filter(Boolean);

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

  // El /g puede resolver un server cuyo CDN está caído (playlist 403).
  // Todos los servers se resuelven + verifican en paralelo — gana el
  // primero en orden de prioridad cuyo playlist responda.
  const attempts = await Promise.all(PRIORITY_SERVERS.map(async (preferred) => {
    let result;
    cjFetchAcquire();
    try {
      result = await withTimeout(
        D0(type, params, (ev) => {
          if (ev?.status === "failed" && ev?.error) {
            console.warn(`[cinejoy] ${ev.provider}: ${ev.error}`);
          }
        }, preferred),
        FETCH_TIMEOUT,
        `cinejoy: timeout para ${cacheKey}`
      );
    } catch (err) {
      console.warn(`[cinejoy] error para ${cacheKey} (${preferred}):`, err.message);
      return null;
    } finally {
      cjFetchRelease();
    }

    if (!result?.result?.url) {
      console.warn(`[cinejoy] ${cacheKey} (${preferred}): sin sources — ${result?.failure || "unknown"}`);
      return null;
    }

    const alive = await probePlaylist(result.result.url);
    if (!alive) {
      console.warn(`[cinejoy] ${cacheKey} (${preferred}): playlist no responde`);
      return null;
    }
    return { preferred, result };
  }));

  const ok = attempts.find(Boolean);
  if (ok) {
    const { preferred, result } = ok;
    const stream = {
      url: result.result.url,
      type: result.result.sourceType === "mp4" ? "mp4" : "hls",
      provider: `cinejoy/${preferred}`,
      referer: "https://cinejoy.pk/",
      subtitles: normalizeCaptions(result.result.captions),
    };
    console.log(`[cinejoy] stream para ${cacheKey} (${preferred}): ${stream.url}`);
    cacheSet(cacheKey, stream, TTL_OK);
    return stream;
  }

  console.warn(`[cinejoy] sin sources para ${cacheKey}: todos los servers fallaron`);
  cacheSet(cacheKey, null, TTL_ERR);
  return null;
}

// GET acotado al playlist: los CDN de cinejoy no contestan HEAD, y el
// playlist es chico. 403 = CDN del server caído para este contenido.
async function probePlaylist(url) {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36", Referer: "https://cinejoy.pk/" },
      signal: AbortSignal.timeout(8000),
    });
    return r.ok;
  } catch {
    return false;
  }
}
