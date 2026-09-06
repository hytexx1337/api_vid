import { extractFlixcloud } from "../extractors/flixcloud.js";
import { cacheGet, cacheSet } from "../lib/cache.js";
import { ANILIST_HEADERS, PROVIDER_TTL } from "../config/constants.js";

const BASE = "https://reanime.to";
const FLIX = "https://flixcloud.cc";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const H = { "User-Agent": UA, Accept: "application/json, */*" };

// AniList con solo lo necesario para armar queries de búsqueda (títulos +
// synonyms) y matching por idMal/anilistId. No usa la misma cache que
// metadata/anilist.js (anilistToMal) para no pisar TTLs distintos.
async function fetchAnilistMedia(anilistId) {
  const cacheKey = `reanime:al-media:${anilistId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

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
  cacheSet(cacheKey, media, PROVIDER_TTL);
  return media;
}

function buildTitles(media) {
  return [media?.title?.english, media?.title?.romaji, media?.title?.native, ...(media?.synonyms ?? [])].filter(Boolean);
}

async function searchReanime(query) {
  const data = await fetch(`${BASE}/api/v1/search?${new URLSearchParams({ q: query, limit: 10 })}`, { headers: H }).then(async (r) => {
    if (!r.ok) throw new Error(`reanime search ${r.status}`);
    return r.json();
  });
  return Array.isArray(data?.results) ? data.results : [];
}

async function fetchAnimeDetail(animeId) {
  const res = await fetch(`${BASE}/api/v1/anime/${animeId}`, { headers: H });
  if (!res.ok) return null;
  return res.json().catch(() => null);
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
  if (cached) return cached;

  const media = await fetchAnilistMedia(anilistId);
  const malId = media?.idMal ?? null;
  const queries = buildTitles(media).slice(0, 5);

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

  for (const { id, detail } of details) {
    if (detail?.anilist_id && Number(detail.anilist_id) === Number(anilistId)) {
      const data = {
        animeId: id,
        title: detail.title?.english || detail.title?.romaji || candidates.get(id)?.title?.english || id,
        anilistId: Number(anilistId),
        subbed: Number.isFinite(detail.subbed) ? detail.subbed : null,
        dubbed: Number.isFinite(detail.dubbed) ? detail.dubbed : null,
      };
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
        cacheSet(cacheKey, data, PROVIDER_TTL);
        return data;
      }
    }
  }

  throw new Error(`No confirmed reanime match for AniList ${anilistId}`);
}

const SERVER_PRIORITY = { "HD-2": 0, "HD-1": 1 };
const sortByPriority = (arr) => arr.slice().sort((a, b) => (SERVER_PRIORITY[a.serverName] ?? 9) - (SERVER_PRIORITY[b.serverName] ?? 9));

async function resolveReanimeStream(anilistId, audio, ep) {
  const series = await resolveSeries(anilistId);
  const slug = series.animeId;

  const [watchRes, flixRes] = await Promise.allSettled([
    fetch(`${BASE}/api/watch/${slug}/${ep}`, { headers: H }).then((r) => {
      if (!r.ok) throw new Error(`watch ${r.status}`);
      return r.json();
    }),
    fetch(`${BASE}/api/flix/${anilistId}/${ep}`, { headers: H }).then((r) => {
      if (!r.ok) throw new Error(`flix ${r.status}`);
      return r.json();
    }),
  ]);
  const watchData = watchRes.status === "fulfilled" ? watchRes.value : null;
  const flixData = flixRes.status === "fulfilled" ? flixRes.value : null;

  const links = [...(watchData?.episode_links ?? [])];
  if (flixData?.success && flixData?.servers) {
    const seen = new Set(links.map((s) => s["$id"]));
    for (const s of flixData.servers) if (!seen.has(s["$id"])) links.push(s);
  }

  const audioTypes = audio === "sub" ? ["sub", "s-sub"] : ["dub", "s-dub"];
  const servers = sortByPriority(links.filter((s) => audioTypes.includes(s.dataType)));
  if (!servers.length) throw Object.assign(new Error(`No ${audio} servers for ep ${ep}`), { status: 404 });

  // Probar servers en orden hasta que uno decripte OK (no en paralelo: cada
  // fetch al embed + /api/m3u8/:token pega directo a flixcloud.cc, mejor no
  // reventarlo con requests simultáneos si el primero ya sirve).
  const errors = [];
  for (const server of servers) {
    try {
      const embedRes = await fetch(server.dataLink, { headers: { ...H, Referer: `${BASE}/` } });
      if (!embedRes.ok) throw new Error(`Embed fetch failed: ${embedRes.status}`);
      const stream = await extractFlixcloud(await embedRes.text(), { apiBase: FLIX, headers: H, referer: `${BASE}/` });
      return {
        title: series.title,
        slug,
        server: server.serverName,
        url: stream.url,
        subtitles: stream.subtitles ?? [],
        thumbnails_vtt: stream.thumbnails_vtt ?? null,
        intro: stream.intro_chapter ?? null,
        outro: stream.outro_chapter ?? null,
        introStart: watchData?.intro_start ?? null,
        introEnd: watchData?.intro_end ?? null,
        outroStart: watchData?.outro_start ?? null,
        outroEnd: watchData?.outro_end ?? null,
      };
    } catch (e) {
      errors.push(`${server.serverName}: ${e.message}`);
    }
  }
  throw Object.assign(new Error(`All reanime servers failed for ${audio} ep ${ep}: ${errors.join(" | ")}`), { status: 502 });
}

// Devuelve { sub, dub } — cada uno null si no hay stream disponible para ese audio.
export async function getReanimeStreams(anilistId, episode) {
  const ep = parseInt(episode);
  const [subResult, dubResult] = await Promise.allSettled([
    resolveReanimeStream(anilistId, "sub", ep),
    resolveReanimeStream(anilistId, "dub", ep),
  ]);
  return {
    sub: subResult.status === "fulfilled" ? subResult.value : null,
    dub: dubResult.status === "fulfilled" ? dubResult.value : null,
  };
}
