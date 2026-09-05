/**
 * scraper-megavid.js
 *
 * Provider directo para English DUB de anime via megavid.buzz.
 * Endpoint público, sin scraping ni tokens:
 *
 *   GET https://megavid.buzz/ani/{anilistId}/{episode}/dub/source
 *   → { status: "ok", source: "<m3u8>", tracks: [{file,label,kind}], type: "hls" }
 *
 * La playlist (cp.megavid.buzz) no exige Referer — se puede servir directo
 * o a través de nuestro proxy genérico.
 */

const BASE = "https://megavid.buzz";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 horas
const cache = new Map();

function cacheGet(k) {
  const e = cache.get(k);
  if (!e || Date.now() > e.exp) { cache.delete(k); return null; }
  return e.val;
}
function cacheSet(k, v) { cache.set(k, { val: v, exp: Date.now() + CACHE_TTL }); }

/**
 * Devuelve { url, tracks } para el episodio en dub, o null si no existe.
 */
export async function getMegavidStream(anilistId, episode) {
  const cacheKey = `megavid:${anilistId}:${episode}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const r = await fetch(`${BASE}/ani/${anilistId}/${episode}/dub/source`, {
    headers: { "User-Agent": UA, "Referer": `${BASE}/` },
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok) throw new Error(`megavid HTTP ${r.status}`);

  const data = await r.json();
  if (data?.status !== "ok" || !data?.source) return null;

  const result = {
    url: data.source,
    tracks: (data.tracks || [])
      .filter(t => t.file && t.kind !== "thumbnails")
      .map(t => ({ label: t.label || "English", lang: "en", file: t.file, kind: "captions", ...(t.default && { default: true }) })),
  };

  cacheSet(cacheKey, result);
  return result;
}
