/**
 * miruro.js — Cliente para el microservicio Python de Miruro
 * El servidor vive en ./miruro/server.py (Flask) y expone:
 *   GET /watch/<anilist_id>/<episode> -> { dub: [...], sub: [...] }
 */

const MIRURO_API = process.env.MIRURO_API_URL || "http://localhost:8001";

const cache = new Map();
function cacheGet(k) {
  const e = cache.get(k);
  if (!e || Date.now() > e.exp) { cache.delete(k); return null; }
  return e.val;
}
function cacheSet(k, v, ttlMs) { cache.set(k, { val: v, exp: Date.now() + ttlMs }); }

function normalizeStream(raw, category) {
  if (!raw?.url) return null;
  const headers = raw.headers && Object.keys(raw.headers).length > 0 ? raw.headers : null;
  return {
    url: raw.proxyUrl || raw.url,
    originalUrl: raw.url,
    provider: raw.provider || "miruro",
    headers,
    skip: raw.skip && (raw.skip.intro || raw.skip.outro) ? raw.skip : null,
    // Los subs de Miruro vienen quemados; no los usamos como tracks globales
    tracks: [],
    category,
  };
}

export async function getMiruroStreams(anilistId, episode) {
  const cacheKey = `miruro:streams:${anilistId}:${episode}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const r = await fetch(`${MIRURO_API}/watch/${anilistId}/${episode}`, {
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`Miruro API ${r.status}`);

  const data = await r.json();
  const dub = (data.dub || []).map(s => normalizeStream(s, "dub")).filter(Boolean);
  const sub = (data.sub || []).map(s => normalizeStream(s, "sub")).filter(Boolean);

  const result = { dub, sub };
  cacheSet(cacheKey, result, 15 * 60 * 1000);
  return result;
}

export async function getMiruroStream(anilistId, episode) {
  const { dub } = await getMiruroStreams(anilistId, episode);
  if (!dub?.length) throw new Error(`Miruro: no dub para ${anilistId} ep${episode}`);
  return dub[0];
}
