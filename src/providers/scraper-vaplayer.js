/**
 * scraper-vaplayer.js
 *
 * vaplayer.ru (embed real servido por nextgencloudfabric.com) — sin auth, sin
 * WASM, sin PoW. El endpoint streamdata.vaplayer.ru es CORS abierto y devuelve
 * URLs de master.m3u8 directamente usables (CDN highperformancebrands.site).
 *
 * Acepta tanto tmdb= como imdb= como identificador; usamos tmdb ya que el resto
 * de la API funciona con TMDB IDs.
 *
 * GET https://streamdata.vaplayer.ru/api.php?tmdb={id}&type=movie
 * GET https://streamdata.vaplayer.ru/api.php?tmdb={id}&type=tv&season={s}&episode={e}
 *  -> { status_code, data: { stream_urls: [master.m3u8, ...] } }
 */

const API_BASE = "https://streamdata.vaplayer.ru/api.php";
const REFERER  = "https://nextgencloudfabric.com/";
const UA       = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const CACHE_TTL = 3 * 60 * 60 * 1000; // 3h
const cache = new Map();

/**
 * @param {string|number} tmdbId
 * @param {"tv"|"movie"} mediaType
 * @param {string|number} [season]
 * @param {string|number} [episode]
 * @returns {Promise<{url:string,type:"hls",provider:string,referer:string}|null>}
 */
export async function getVaplayerStream(tmdbId, mediaType, season, episode) {
  const cacheKey = mediaType === "tv"
    ? `vaplayer:tv:${tmdbId}:${season}:${episode}`
    : `vaplayer:movie:${tmdbId}`;

  const hit = cache.get(cacheKey);
  if (hit && Date.now() < hit.expiresAt) return hit.data;

  try {
    const params = new URLSearchParams({ tmdb: String(tmdbId), type: mediaType });
    if (mediaType === "tv") {
      params.set("season", String(season));
      params.set("episode", String(episode));
    }

    const r = await fetch(`${API_BASE}?${params}`, {
      headers: { "User-Agent": UA, Referer: REFERER, Origin: "https://nextgencloudfabric.com" },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`vaplayer HTTP ${r.status}`);
    const body = await r.json();

    const streamUrls = body?.data?.stream_urls;
    if (!Array.isArray(streamUrls) || !streamUrls.length) {
      throw new Error("vaplayer: sin stream_urls en la respuesta");
    }

    const result = {
      url: streamUrls[0], // master.m3u8 multi-bitrate, no hace falta elegir variante
      type: "hls",
      provider: "vaplayer",
      referer: REFERER,
    };

    cache.set(cacheKey, { data: result, expiresAt: Date.now() + CACHE_TTL });
    return result;
  } catch (err) {
    console.warn(`[vaplayer] error para ${cacheKey}:`, err.message);
    cache.set(cacheKey, { data: null, expiresAt: Date.now() + 5 * 60 * 1000 });
    return null;
  }
}
