import { extractFlixcloud } from "../extractors/flixcloud.js";
import { cacheGet, cacheSet } from "../lib/cache.js";
import { ANILIST_HEADERS, PROVIDER_TTL } from "../config/constants.js";
import { fetchReanime } from "../lib/http.js";

const BASE = "https://reanime.to";
const FLIX = "https://flixcloud.cc";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const H = { "User-Agent": UA, Accept: "application/json, */*" };
const REANIME_DEBUG = /^(1|true|yes|on)$/i.test(process.env.REANIME_DEBUG || "");
const seriesInFlight = new Map();
const episodeSourcesInFlight = new Map();

function dbg(message, extra = null) {
  if (!REANIME_DEBUG) return;
  if (extra) console.info(`[reanime] ${message}`, extra);
  else console.info(`[reanime] ${message}`);
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

  const query = `query($id:Int){Media(id:$id,type:ANIME){id idMal title{english romaji native} synonyms}}`;
  dbg("fetchAnilistMedia start", { anilistId });
  const res = await fetchReanime("https://graphql.anilist.co", {
    method: "POST",
    headers: ANILIST_HEADERS,
    body: JSON.stringify({ query, variables: { id: parseInt(anilistId) } }),
    timeoutMs: 8000,
  });
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
  const json = await res.json();
  const media = json?.data?.Media;
  if (!media) throw new Error(`AniList: no media for ${anilistId}`);
  dbg("fetchAnilistMedia ok", { anilistId, idMal: media?.idMal ?? null, synonyms: media?.synonyms?.length ?? 0 });
  cacheSet(cacheKey, media, PROVIDER_TTL);
  return media;
}

function buildTitles(media) {
  return [media?.title?.english, media?.title?.romaji, media?.title?.native, ...(media?.synonyms ?? [])].filter(Boolean);
}

async function searchReanime(query) {
  dbg("searchReanime start", { query });
  const data = await fetchReanime(`${BASE}/api/v1/search?${new URLSearchParams({ q: query, limit: 10 })}`, { headers: H, timeoutMs: 15000 }).then(async (r) => {
    if (!r.ok) throw new Error(`reanime search ${r.status}`);
    return r.json();
  });
  dbg("searchReanime ok", { query, results: Array.isArray(data?.results) ? data.results.length : 0 });
  return Array.isArray(data?.results) ? data.results : [];
}

async function fetchAnimeDetail(animeId) {
  dbg("fetchAnimeDetail start", { animeId });
  const res = await fetchReanime(`${BASE}/api/v1/anime/${animeId}`, { headers: H, timeoutMs: 15000 });
  if (!res.ok) {
    dbg("fetchAnimeDetail miss", { animeId, status: res.status });
    return null;
  }
  const detail = await res.json().catch(() => null);
  dbg("fetchAnimeDetail ok", { animeId, anilistId: detail?.anilist_id ?? null, malId: detail?.mal_id ?? null });
  return detail;
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
    dbg("resolveSeries cache hit", { anilistId, animeId: cached?.animeId, title: cached?.title });
    return cached;
  }

  if (seriesInFlight.has(cacheKey)) {
    dbg("resolveSeries in-flight hit", { anilistId, cacheKey });
    return seriesInFlight.get(cacheKey);
  }

  const run = (async () => {
    const media = await fetchAnilistMedia(anilistId);
    const malId = media?.idMal ?? null;
    const queries = buildTitles(media).slice(0, 5);
    dbg("resolveSeries start", { anilistId, malId, queries });

    const candidates = new Map();
    for (const q of queries) {
      for (const r of await searchReanime(q).catch(() => [])) {
        if (r?.anime_id && !candidates.has(r.anime_id)) candidates.set(r.anime_id, r);
      }
    }
    dbg("resolveSeries candidates", { anilistId, count: candidates.size, ids: [...candidates.keys()].slice(0, 10) });

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
    dbg("resolveSeries no match", { anilistId, malId, candidateIds: [...candidates.keys()] });
    throw new Error(`No confirmed reanime match for AniList ${anilistId}`);
  })().finally(() => {
    seriesInFlight.delete(cacheKey);
  });

  seriesInFlight.set(cacheKey, run);
  return run;
}

const SERVER_PRIORITY = { "HD-2": 0, "HD-1": 1 };
const sortByPriority = (arr) => arr.slice().sort((a, b) => (SERVER_PRIORITY[a.serverName] ?? 9) - (SERVER_PRIORITY[b.serverName] ?? 9));

async function resolveEpisodeSources(anilistId, ep, series) {
  const key = `${anilistId}:${ep}`;
  if (episodeSourcesInFlight.has(key)) {
    dbg("resolveEpisodeSources in-flight hit", { anilistId, episode: ep, key });
    return episodeSourcesInFlight.get(key);
  }

  const run = (async () => {
    const slug = series.animeId;
    dbg("resolveEpisodeSources start", { anilistId, episode: ep, slug, title: series.title });
    const [watchRes, flixRes] = await Promise.allSettled([
      fetchReanime(`${BASE}/api/watch/${slug}/${ep}`, { headers: H, timeoutMs: 20000 }).then((r) => {
        if (!r.ok) throw new Error(`watch ${r.status}`);
        return r.json();
      }),
      fetchReanime(`${BASE}/api/flix/${anilistId}/${ep}`, { headers: H, timeoutMs: 20000 }).then((r) => {
        if (!r.ok) throw new Error(`flix ${r.status}`);
        return r.json();
      }),
    ]);
    const watchData = watchRes.status === "fulfilled" ? watchRes.value : null;
    const flixData = flixRes.status === "fulfilled" ? flixRes.value : null;
    dbg("resolveEpisodeSources upstream summary", {
      anilistId,
      episode: ep,
      watch: watchRes.status === "fulfilled" ? { ok: true, links: watchData?.episode_links?.length ?? 0 } : { ok: false, error: watchRes.reason?.message || String(watchRes.reason) },
      flix: flixRes.status === "fulfilled" ? { ok: true, servers: flixData?.servers?.length ?? 0, success: Boolean(flixData?.success) } : { ok: false, error: flixRes.reason?.message || String(flixRes.reason) },
    });

    const links = [...(watchData?.episode_links ?? [])];
    if (flixData?.success && flixData?.servers) {
      const seen = new Set(links.map((s) => s["$id"]));
      for (const s of flixData.servers) if (!seen.has(s["$id"])) links.push(s);
    }

    return { watchData, flixData, links };
  })().finally(() => {
    episodeSourcesInFlight.delete(key);
  });

  episodeSourcesInFlight.set(key, run);
  return run;
}

async function resolveReanimeStream(anilistId, audio, ep, series = null, episodeSources = null) {
  dbg("resolveReanimeStream start", { anilistId, audio, episode: ep });
  const resolvedSeries = series || await resolveSeries(anilistId);
  const slug = resolvedSeries.animeId;
  dbg("resolveReanimeStream series resolved", { anilistId, audio, episode: ep, slug, title: resolvedSeries.title });
  const sources = episodeSources || await resolveEpisodeSources(anilistId, ep, resolvedSeries);
  const { watchData, links } = sources;
  const audioTypes = audio === "sub" ? ["sub", "s-sub"] : ["dub", "s-dub"];
  const servers = sortByPriority(links.filter((s) => audioTypes.includes(s.dataType)));
  dbg("resolveReanimeStream server candidates", {
    anilistId,
    audio,
    episode: ep,
    count: servers.length,
    servers: servers.map((s) => ({ serverName: s.serverName, dataType: s.dataType, dataLink: s.dataLink })),
  });
  if (!servers.length) throw Object.assign(new Error(`No ${audio} servers for ep ${ep}`), { status: 404 });

  // Probar servers en orden hasta que uno decripte OK (no en paralelo: cada
  // fetch al embed + /api/m3u8/:token pega directo a flixcloud.cc, mejor no
  // reventarlo con requests simultáneos si el primero ya sirve).
  const errors = [];
  for (const server of servers) {
    try {
      dbg("resolveReanimeStream embed start", {
        anilistId,
        audio,
        episode: ep,
        serverName: server.serverName,
        dataType: server.dataType,
        dataLink: server.dataLink,
      });
      const embedRes = await fetchReanime(server.dataLink, { headers: { ...H, Referer: `${BASE}/` }, timeoutMs: 20000 });
      if (!embedRes.ok) throw new Error(`Embed fetch failed: ${embedRes.status}`);
      const stream = await extractFlixcloud(await embedRes.text(), { fetchImpl: fetchReanime, apiBase: FLIX, headers: H, referer: `${BASE}/` });
      const downloadLink = server.dataLink.replace("/e/", "/d/");
      dbg("resolveReanimeStream embed ok", {
        anilistId,
        audio,
        episode: ep,
        serverName: server.serverName,
        streamUrl: stream.url,
        subtitles: stream.subtitles?.length ?? 0,
        hasManifestKey: Boolean(stream.manifest_key),
        hasThumbs: Boolean(stream.thumbnails_vtt),
      });
      return {
        title: resolvedSeries.title,
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
      dbg("resolveReanimeStream embed error", {
        anilistId,
        audio,
        episode: ep,
        serverName: server.serverName,
        error: e.message,
      });
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
  const series = await resolveSeries(anilistId);
  const episodeSources = await resolveEpisodeSources(anilistId, ep, series);
  let subResult;
  let dubResult;
  try {
    subResult = { status: "fulfilled", value: await resolveReanimeStream(anilistId, "sub", ep, series, episodeSources) };
  } catch (error) {
    subResult = { status: "rejected", reason: error };
  }
  try {
    dubResult = { status: "fulfilled", value: await resolveReanimeStream(anilistId, "dub", ep, series, episodeSources) };
  } catch (error) {
    dubResult = { status: "rejected", reason: error };
  }
  dbg("getReanimeStreams result", {
    anilistId,
    episode: ep,
    sub: subResult.status === "fulfilled" ? { ok: Boolean(subResult.value), server: subResult.value?.server ?? null } : { ok: false, error: subResult.reason?.message || String(subResult.reason) },
    dub: dubResult.status === "fulfilled" ? { ok: Boolean(dubResult.value), server: dubResult.value?.server ?? null } : { ok: false, error: dubResult.reason?.message || String(dubResult.reason) },
  });
  return {
    sub: subResult.status === "fulfilled" ? subResult.value : null,
    dub: dubResult.status === "fulfilled" ? dubResult.value : null,
  };
}
