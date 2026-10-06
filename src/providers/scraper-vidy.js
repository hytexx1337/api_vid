// scraper-vidy.js
//
// vidy.st (movy.sx) — backend encriptado:
//   GET {host}/seed?mediaId={tmdb} → {seed, ttlMs} (cache ~30s por mediaId)
//   GET {host}/{route}/{suffix}?title&mediaType&year&episodeId&seasonId&tmdbId&imdbId&enc=2&seed
//     → blob base64url cifrado → decryptVidy(seed, tmdbId) → {sources, subtitles, playlist}
//
// wecollege.net: mirrors por ciudad (/sources). Revisado en Oct 2026 contra
// el player real de vidy: seattle/denver ya no existen, speedracelight está
// devolviendo 502/sin seed y no aporta cobertura real. El HLS final sale por
// moon.zenoak.top / olivewave.top y exige Referer: https://www.vidy.st/.

import { decryptVidy } from "../../vendor/vidy-crypto.js";

const REFERER = "https://www.vidy.st/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0";
const H = { "User-Agent": UA, Referer: REFERER, Origin: "https://www.vidy.st" };

// Targets por prioridad. Los primeros mirrors son los que mejor cobertura
// dieron en pruebas reales; el resto queda como fallback porque hay títulos
// que aparecen solo en algunos mirrors.
const TARGETS = [
  { host: "https://api.wecollege.net", route: "miami", suffix: "sources" },
  { host: "https://api.wecollege.net", route: "boise", suffix: "sources" },
  { host: "https://api.wecollege.net", route: "vegas", suffix: "sources" },
  { host: "https://api.wecollege.net", route: "phoenix", suffix: "sources" },
  { host: "https://api.wecollege.net", route: "atlanta", suffix: "sources" },
  { host: "https://api.wecollege.net", route: "portland", suffix: "sources" },
  { host: "https://api.wecollege.net", route: "dallas", suffix: "sources" },
  { host: "https://api.wecollege.net", route: "paris", suffix: "sources" },
  { host: "https://api.wecollege.net", route: "cancun", suffix: "sources" },
  { host: "https://api.wecollege.net", route: "tampa", suffix: "sources" },
  { host: "https://api.wecollege.net", route: "orlando", suffix: "sources" },
  { host: "https://api.wecollege.net", route: "munich", suffix: "sources" },
];

const FETCH_TIMEOUT = 15000;

// ---------- cache ----------

const _cache = new Map();
const TTL_OK = 30 * 60 * 1000;   // 30min
const TTL_ERR = 5 * 60 * 1000;   // 5min
function cacheGet(k) {
  const e = _cache.get(k);
  if (!e) return null;
  if (Date.now() > e.exp) { _cache.delete(k); return null; }
  return e.val;
}
function cacheSet(k, v, ttl) { _cache.set(k, { val: v, exp: Date.now() + ttl }); }

// ---------- seed (cache corto, por host+mediaId como la página) ----------

const _seeds = new Map();
async function getSeed(host, mediaId) {
  const key = `${host}|${mediaId}`;
  const e = _seeds.get(key);
  if (e && e.expiresAt - 5000 > Date.now()) return e.seed;
  const r = await fetch(`${host}/seed?mediaId=${mediaId}`, { headers: H, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`vidy seed HTTP ${r.status}`);
  const j = await r.json();
  const ttl = j.ttlMs ?? 30000;
  _seeds.set(key, { seed: j.seed, expiresAt: Date.now() + ttl });
  return j.seed;
}

function dropSeeds(mediaId) {
  for (const k of [..._seeds.keys()]) if (k.endsWith(`|${mediaId}`)) _seeds.delete(k);
}

// ---------- sources por target ----------

async function fetchTargetSources(t, { title, mediaType, year, tmdbId, imdbId, season, episode }, seed) {
  const params = new URLSearchParams({
    // la página doble-encodea el title (encodeURIComponent + URLSearchParams)
    title: encodeURIComponent(title),
    mediaType,
    year: String(year ?? ""),
    tmdbId: String(tmdbId),
    imdbId: imdbId ?? "",
    enc: "2",
    seed,
  });
  // para movies NO se mandan episodeId/seasonId (axios omite undefined;
  // la API 500ea si llegan vacíos)
  if (mediaType === "tv") {
    params.set("episodeId", String(episode));
    params.set("seasonId", String(season));
  }
  const r = await fetch(`${t.host}/${t.route}/${t.suffix}?${params}`, { headers: H, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!r.ok) {
    const e = new Error(`vidy ${t.route} HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  const body = await r.text();
  return JSON.parse(decryptVidy(body, seed, String(tmdbId)));
}

// Un solo stream por target: preferimos el master adaptativo (el player elige
// calidad solo). Si no hay master, mejor calidad <=1080p — evitamos 2160p
// para que no haya entradas duplicadas del mismo stream por calidad.
function bestStream(data, tag) {
  if (data.playlist) return { url: data.playlist, quality: "master", tag };
  const srcs = (data.sources ?? []).filter(s => s.url ?? s.file);
  if (!srcs.length) return null;
  const rankQ = (q) => {
    q = String(q).toLowerCase();
    if (/master|auto|adaptive/.test(q)) return 0;
    if (q === "1080p" || /english|hindi|tamil|telugu|latino/.test(q)) return 1; // hdmovie usa quality=idioma
    if (/720|480|360|240/.test(q)) return 2;
    if (/2160|4k|uhd/.test(q)) return 3;
    return 4;
  };
  srcs.sort((a, b) => rankQ(a.quality) - rankQ(b.quality));
  const s = srcs[0];
  const url = s.url ?? s.file;
  return { url, quality: s.quality ?? "auto", tag, isMp4: /\.mp4(\?|$)/i.test(url) };
}

function normSubs(subs) {
  return (subs ?? [])
    .map(s => ({ label: s.label ?? s.lang ?? "Unknown", lang: s.lang ?? "en", url: s.url ?? s.file }))
    .filter(s => s.url);
}

// Resuelve todos los targets en paralelo y mergea. Devuelve
// { url, type, provider, referer, subtitles, streams } — `url` es el mejor
// (primer target con playlist/master) y `streams` la lista completa para
// que el endpoint pueda meter varias entradas si quiere.
async function resolveAll({ tmdbId, mediaType, title, year, imdbId, season, episode }) {
  const type = mediaType === "tv" ? "tv" : "movie";
  const useTargets = TARGETS.filter(t => !t.movieOnly || type === "movie");

  // un seed por host
  const seedByHost = new Map();
  for (const t of useTargets) {
    if (!seedByHost.has(t.host)) {
      seedByHost.set(t.host, await getSeed(t.host, tmdbId).catch(() => null));
    }
  }

  const results = await Promise.allSettled(useTargets.map(async (t) => {
    const seed = seedByHost.get(t.host);
    if (!seed) throw new Error(`${t.route}: sin seed`);
    const data = await fetchTargetSources(t, { title, mediaType: type, year, tmdbId, imdbId, season, episode }, seed);
    return { t, data };
  }));

  const allStreams = [];
  const allSubs = [];
  const seenUrls = new Set();
  const seenSubs = new Set();
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const t = useTargets[i];
    if (r.status !== "fulfilled") {
      console.warn(`[vidy] ${t.route}: ${r.reason?.message}`);
      continue;
    }
    const { data } = r.value;
    const best = bestStream(data, t.route);
    if (best && !seenUrls.has(best.url)) {
      seenUrls.add(best.url);
      allStreams.push(best);
    }
    for (const sub of normSubs(data.subtitles)) {
      if (seenSubs.has(sub.url)) continue;
      seenSubs.add(sub.url);
      allSubs.push(sub);
    }
  }

  if (!allStreams.length) return null;
  // mejor global: master/adaptive primero, después 1080p/auto; 2160p al fondo
  const rank = (s) => /master|auto|adaptive/i.test(s.quality) ? 0 : /1080/i.test(s.quality) ? 1 : /2160|4k|uhd/i.test(s.quality) ? 3 : 2;
  allStreams.sort((a, b) => rank(a) - rank(b));
  const best = allStreams[0];
  return {
    url: best.url,
    type: best.isMp4 ? "mp4" : "hls",
    provider: `vidy/${best.tag}`,
    referer: REFERER,
    subtitles: allSubs,
    streams: allStreams.map(s => ({
      url: s.url, type: s.isMp4 ? "mp4" : "hls", quality: s.quality,
      provider: `vidy/${s.tag}`, referer: REFERER, subtitles: allSubs,
    })),
  };
}

/**
 * getVidyStream({ tmdbId, mediaType, title, year, imdbId, season, episode })
 * mediaType: "movie" | "tv"
 */
export async function getVidyStream({ tmdbId, mediaType, title, year, imdbId, season, episode }) {
  if (!title || !tmdbId) return null;
  const type = mediaType === "tv" ? "tv" : "movie";
  const cacheKey = type === "tv"
    ? `vidy:tv:${tmdbId}:${season}:${episode}`
    : `vidy:movie:${tmdbId}`;

  const cached = cacheGet(cacheKey);
  if (cached !== null) return cached;

  try {
    const result = await resolveAll({ tmdbId, mediaType, title, year, imdbId, season, episode });
    if (!result) throw new Error("todos los targets fallaron");
    console.log(`[vidy] ${cacheKey}: ${result.streams.length} streams, best=${result.provider}`);
    cacheSet(cacheKey, result, TTL_OK);
    return result;
  } catch (err) {
    // 401 = seed vencido o rechazado — invalidar seeds del mediaId y reintentar
    if (err?.status === 401 || err?.errors?.some?.(e => e?.status === 401)) {
      dropSeeds(tmdbId);
      const retry = await resolveAll({ tmdbId, mediaType, title, year, imdbId, season, episode }).catch(() => null);
      if (retry) { cacheSet(cacheKey, retry, TTL_OK); return retry; }
    }
    console.warn(`[vidy] error para ${cacheKey}:`, err.message);
    cacheSet(cacheKey, null, TTL_ERR);
    return null;
  }
}
