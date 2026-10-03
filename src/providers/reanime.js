import { extractFlixcloud } from "../extractors/flixcloud.js";
import { cacheGet, cacheSet } from "../lib/cache.js";
import { curlWorkerFetch } from "../lib/http.js";
import { ANILIST_HEADERS, PROVIDER_TTL, REANIME_CF_WORKER } from "../config/constants.js";

const BASE = "https://reanime.to";
const FLIX = "https://flixcloud.cc";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const H = { "User-Agent": UA, Accept: "application/json, */*" };
const REANIME_DEBUG = /^(1|true|yes|on)$/i.test(process.env.REANIME_DEBUG || "");

function dbg(message, data) {
  if (!REANIME_DEBUG) return;
  if (data === undefined) console.log(`[reanime] ${message}`);
  else console.log(`[reanime] ${message}`, data);
}

async function reanimeFetch(url, { timeoutMs = 15000, responseType = "json", headers = H } = {}) {
  if (!REANIME_CF_WORKER) {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`reanime upstream ${response.status}`);
    return responseType === "text" ? response.text() : response.json();
  }

  const response = await curlWorkerFetch(url, { workerBase: REANIME_CF_WORKER, timeoutMs });
  if (!response.ok) throw new Error(`reanime worker ${response.status}`);
  return responseType === "text" ? response.text() : response.json();
}

function makeWorkerFetchImpl(timeoutMs = 15000) {
  return async (url, options = {}) => {
    if (!REANIME_CF_WORKER) {
      return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    }
    return curlWorkerFetch(url, { workerBase: REANIME_CF_WORKER, timeoutMs });
  };
}

// AniList con solo lo necesario para armar queries de búsqueda (títulos +
// synonyms) y matching por idMal/anilistId. No usa la misma cache que
// metadata/anilist.js (anilistToMal) para no pisar TTLs distintos.
async function fetchAnilistMedia(anilistId) {
  const cacheKey = `reanime:al-media:${anilistId}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    dbg("fetchAnilistMedia cache hit", { anilistId, cacheKey });
    return cached;
  }

  dbg("fetchAnilistMedia start", { anilistId });

  const query = `query($id:Int){Media(id:$id,type:ANIME){id idMal title{english romaji native} synonyms}}`;
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: ANILIST_HEADERS,
    body: JSON.stringify({ query, variables: { id: parseInt(anilistId) } }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
  const json = await res.json();
  const media = json?.data?.Media;
  if (!media) throw new Error(`AniList: no media for ${anilistId}`);
  dbg("fetchAnilistMedia ok", { anilistId, idMal: media.idMal ?? null, synonyms: media.synonyms?.length ?? 0 });
  cacheSet(cacheKey, media, PROVIDER_TTL);
  return media;
}

function buildTitles(media) {
  return [media?.title?.english, media?.title?.romaji, media?.title?.native, ...(media?.synonyms ?? [])].filter(Boolean);
}

async function searchReanime(query) {
  dbg("searchReanime start", { query });
  const data = await reanimeFetch(`${BASE}/api/v1/search?${new URLSearchParams({ q: query, limit: 10 })}`, { timeoutMs: 15000, responseType: "json" });
  const results = Array.isArray(data?.results) ? data.results : [];
  dbg("searchReanime ok", { query, results: results.length });
  return results;
}

async function fetchAnimeDetail(animeId) {
  dbg("fetchAnimeDetail start", { animeId });
  try {
    const data = await reanimeFetch(`${BASE}/api/v1/anime/${animeId}`, { timeoutMs: 15000, responseType: "json" });
    dbg("fetchAnimeDetail ok", { animeId, anilistId: data?.anilist_id ?? null, malId: data?.mal_id ?? null });
    return data;
  } catch (error) {
    const status = Number(String(error.message || "").match(/(\d+)$/)?.[1] || 0) || null;
    dbg("fetchAnimeDetail miss", { animeId, status });
    return null;
  }
}

// AniList CDN cover images embed el AniList ID como bx{id}-*.
function extractAnilistIdFromCover(coverImage) {
  const urls = [coverImage?.extra_large, coverImage?.large, coverImage?.medium].filter(Boolean);
  for (const url of urls) {
    const m = url.match(/anilist\.co\/.*\/bx(\d+)-/);
    if (m) return Number(m[1]);
  }
  return null;
}

async function resolveSeries(anilistId) {
  const cacheKey = `reanime:series:${anilistId}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    dbg("resolveSeries cache hit", { anilistId, cacheKey, animeId: cached.animeId });
    return cached;
  }

  const media = await fetchAnilistMedia(anilistId);
  const malId = media?.idMal ?? null;
  const queries = buildTitles(media).slice(0, 5);
  dbg("resolveSeries start", { anilistId, malId, queries });

  const candidates = new Map();
  await Promise.all(queries.map(async (q) => {
    for (const r of await searchReanime(q).catch(() => [])) {
      if (r?.anime_id && !candidates.has(r.anime_id)) candidates.set(r.anime_id, r);
    }
  }));

  for (const [id, r] of candidates) {
    const coverId = extractAnilistIdFromCover(r.cover_image);
    if (coverId && coverId === Number(anilistId)) {
      const data = {
        animeId: id,
        title: r.title?.english || r.title?.romaji || id,
        anilistId: Number(anilistId),
        subbed: Number.isFinite(r.subbed) ? r.subbed : null,
        dubbed: Number.isFinite(r.dubbed) ? r.dubbed : null,
      };
      dbg("resolveSeries matched by cover", { anilistId, animeId: id, title: data.title });
      cacheSet(cacheKey, data, PROVIDER_TTL);
      return data;
    }
  }

  dbg("resolveSeries candidates", { anilistId, count: candidates.size, ids: [...candidates.keys()].slice(0, 10) });
  const needsDetail = [...candidates.keys()].filter(
    (id) => extractAnilistIdFromCover(candidates.get(id)?.cover_image) === null
  );
  const details = await Promise.all(
    needsDetail.map(async (id) => ({ id, detail: await fetchAnimeDetail(id).catch(() => null) }))
  );
  dbg("resolveSeries details fetched", { anilistId, count: details.length });

  for (const { id, detail } of details) {
    if (detail?.anilist_id && Number(detail.anilist_id) === Number(anilistId)) {
      const data = {
        animeId: id,
        title: detail.title?.english || detail.title?.romaji || candidates.get(id)?.title?.english || id,
        anilistId: Number(anilistId),
        subbed: Number.isFinite(detail.subbed) ? detail.subbed : null,
        dubbed: Number.isFinite(detail.dubbed) ? detail.dubbed : null,
      };
      dbg("resolveSeries matched by detail anilist_id", { anilistId, animeId: id, title: data.title });
      cacheSet(cacheKey, data, PROVIDER_TTL);
      return data;
    }
  }

  if (malId) {
    for (const { id, detail } of details) {
      const detailMal = detail?.mal_id;
      if (detailMal && Number(detailMal) === Number(malId)) {
        const data = {
          animeId: id,
          title: detail.title?.english || detail.title?.romaji || id,
          anilistId: Number(anilistId),
          subbed: Number.isFinite(detail.subbed) ? detail.subbed : null,
          dubbed: Number.isFinite(detail.dubbed) ? detail.dubbed : null,
        };
        dbg("resolveSeries matched by mal_id", { anilistId, animeId: id, malId, title: data.title });
        cacheSet(cacheKey, data, PROVIDER_TTL);
        return data;
      }
    }
  }

  dbg("resolveSeries no match", { anilistId, malId, candidateIds: [...candidates.keys()].slice(0, 10) });
  throw new Error(`No confirmed reanime match for AniList ${anilistId}`);
}

const SERVER_PRIORITY = { "HD-2": 0, "HD-1": 1 };
const sortByPriority = (arr) => arr.slice().sort((a, b) => (SERVER_PRIORITY[a.serverName] ?? 9) - (SERVER_PRIORITY[b.serverName] ?? 9));

async function resolveReanimeStream(anilistId, audio, ep) {
  dbg("resolveReanimeStream start", { anilistId, audio, episode: ep });
  const series = await resolveSeries(anilistId);
  const slug = series.animeId;
  dbg("resolveReanimeStream series", { anilistId, audio, episode: ep, slug, title: series.title });

  const [watchRes, flixRes] = await Promise.allSettled([
    reanimeFetch(`${BASE}/api/watch/${slug}/${ep}`, { timeoutMs: 15000, responseType: "json" }),
    reanimeFetch(`${BASE}/api/flix/${anilistId}/${ep}`, { timeoutMs: 15000, responseType: "json" }),
  ]);
  const watchData = watchRes.status === "fulfilled" ? watchRes.value : null;
  const flixData = flixRes.status === "fulfilled" ? flixRes.value : null;
  dbg("resolveReanimeStream upstream summary", {
    anilistId,
    audio,
    episode: ep,
    watchOk: watchRes.status === "fulfilled",
    flixOk: flixRes.status === "fulfilled",
    watchLinks: watchData?.episode_links?.length ?? 0,
    flixServers: flixData?.servers?.length ?? 0,
  });

  const links = [...(watchData?.episode_links ?? [])];
  if (flixData?.success && flixData?.servers) {
    const seen = new Set(links.map((s) => s["$id"]));
    for (const s of flixData.servers) if (!seen.has(s["$id"])) links.push(s);
  }

  const audioTypes = audio === "sub" ? ["sub", "s-sub"] : ["dub", "s-dub"];
  const servers = sortByPriority(links.filter((s) => audioTypes.includes(s.dataType)));
  dbg("resolveReanimeStream servers", {
    anilistId,
    audio,
    episode: ep,
    count: servers.length,
    servers: servers.map((s) => ({ id: s["$id"], name: s.serverName, type: s.dataType })),
  });
  if (!servers.length) throw Object.assign(new Error(`No ${audio} servers for ep ${ep}`), { status: 404 });

  // Probar servers en orden hasta que uno decripte OK (no en paralelo: cada
  // fetch al embed + /api/m3u8/:token pega directo a flixcloud.cc, mejor no
  // reventarlo con requests simultáneos si el primero ya sirve).
  const errors = [];
  for (const server of servers) {
    try {
      dbg("embed start", { anilistId, audio, episode: ep, server: server.serverName, link: server.dataLink });
      const embedHtml = await reanimeFetch(server.dataLink, { timeoutMs: 15000, responseType: "text" });
      const stream = await extractFlixcloud(embedHtml, {
        fetchImpl: makeWorkerFetchImpl(15000),
        apiBase: FLIX,
        headers: H,
        referer: `${BASE}/`,
      });
      const downloadLink = server.dataLink.replace("/e/", "/d/");
      dbg("embed ok", {
        anilistId,
        audio,
        episode: ep,
        server: server.serverName,
        hasUrl: Boolean(stream.url),
        subtitles: stream.subtitles?.length ?? 0,
        thumbnails: Boolean(stream.thumbnails_vtt),
        manifestKey: Boolean(stream.manifest_key),
      });
      return {
        title: series.title,
        slug,
        server: server.serverName,
        url: stream.url,
        downloadLink,
        subtitles: stream.subtitles ?? [],
        thumbnails_vtt: stream.thumbnails_vtt ?? null,
        intro: stream.intro_chapter ?? null,
        outro: stream.outro_chapter ?? null,
        introStart: watchData?.intro_start ?? null,
        introEnd: watchData?.intro_end ?? null,
        outroStart: watchData?.outro_start ?? null,
        outroEnd: watchData?.outro_end ?? null,
        manifest_key: stream.manifest_key ?? null,
      };
    } catch (e) {
      dbg("embed error", { anilistId, audio, episode: ep, server: server.serverName, error: e.message });
      errors.push(`${server.serverName}: ${e.message}`);
    }
  }
  dbg("resolveReanimeStream all servers failed", { anilistId, audio, episode: ep, errors });
  throw Object.assign(new Error(`All reanime servers failed for ${audio} ep ${ep}: ${errors.join(" | ")}`), { status: 502 });
}

// Devuelve { sub, dub } — cada uno null si no hay stream disponible para ese audio.
export async function getReanimeStreams(anilistId, episode) {
  const ep = parseInt(episode);
  dbg("getReanimeStreams start", { anilistId, episode: ep });
  const [subResult, dubResult] = await Promise.allSettled([
    resolveReanimeStream(anilistId, "sub", ep),
    resolveReanimeStream(anilistId, "dub", ep),
  ]);
  const result = {
    sub: subResult.status === "fulfilled" ? subResult.value : null,
    dub: dubResult.status === "fulfilled" ? dubResult.value : null,
  };
  dbg("getReanimeStreams result", {
    anilistId,
    episode: ep,
    sub: subResult.status === "fulfilled"
      ? { ok: true, server: subResult.value?.server ?? null, url: subResult.value?.url ?? null }
      : { ok: false, error: subResult.reason?.message ?? null },
    dub: dubResult.status === "fulfilled"
      ? { ok: true, server: dubResult.value?.server ?? null, url: dubResult.value?.url ?? null }
      : { ok: false, error: dubResult.reason?.message ?? null },
  });
  return result;
}
