import { extractFlixcloud } from "../extractors/flixcloud.js";
import { cacheGet, cacheSet } from "../lib/cache.js";
import { curlWorkerFetch } from "../lib/http.js";
import { ANILIST_HEADERS, PROVIDER_TTL, REANIME_CF_WORKER } from "../config/constants.js";

const BASE = "https://reanime.to";
const FLIX = "https://flixcloud.cc";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const H = { "User-Agent": UA, Accept: "application/json, */*" };

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
  if (cached) { console.log(`  [reanime:resolveSeries ${anilistId}] fetchAnilistMedia cache hit`); return cached; }
  const t1 = Date.now();
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
  console.log(`  [reanime:resolveSeries ${anilistId}] fetchAnilistMedia graphql: +${Date.now()-t1}ms`);
  cacheSet(cacheKey, media, PROVIDER_TTL);
  return media;
}

function buildTitles(media) {
  return [media?.title?.english, media?.title?.romaji, media?.title?.native, ...(media?.synonyms ?? [])].filter(Boolean);
}

async function searchReanime(query) {
  const t1 = Date.now();
  const data = await reanimeFetch(`${BASE}/api/v1/search?${new URLSearchParams({ q: query, limit: 10 })}`, { timeoutMs: 15000, responseType: "json" });
  const results = Array.isArray(data?.results) ? data.results : [];
  console.log(`  [reanime:resolveSeries] search query="${query.slice(0,35)}" → +${Date.now()-t1}ms (${results.length} results)`);
  return results;
}

async function fetchAnimeDetail(animeId) {
  try {
    return await reanimeFetch(`${BASE}/api/v1/anime/${animeId}`, { timeoutMs: 15000, responseType: "json" });
  } catch (error) {
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
  if (cached) { console.log(`  [reanime:resolveSeries ${anilistId}] cache hit series=${cached.animeId}`); return cached; }
  const t0 = Date.now();
  const sl = (s) => console.log(`  [reanime:resolveSeries ${anilistId}] ${s}: +${Date.now()-t0}ms`);
  sl("start cache miss");

  const media = await fetchAnilistMedia(anilistId);
  const malId = media?.idMal ?? null;
  const queries = buildTitles(media).slice(0, 5);
  sl(`built ${queries.length} search queries: ${queries.map(q => q.slice(0,25)).join(" | ")}`);

  const candidates = new Map();
  // HOTPATH: solo los primeros 2 queries más probables (English + Romaji)
  // en el 99% de los casos estos matchean via coverId y salimos 400ms antes.
  const hotQueries = queries.slice(0, 2);
  await Promise.all(hotQueries.map(async (q) => {
    for (const r of await searchReanime(q).catch(() => [])) {
      if (r?.anime_id && !candidates.has(r.anime_id)) candidates.set(r.anime_id, r);
    }
  }));
  sl(`hotpath search (${hotQueries.length}q) done candidates=${candidates.size}`);

  // CoverId early-exit with hotpath candidates only:
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
      sl(`matched via coverId id=${id} TOTAL +${Date.now()-t0}ms (early-exit hotpath)`);
      // background: seguir los searches restantes no nos afecta; exit ya
      const tailQ = queries.slice(2);
      if (tailQ.length) (async () => {
        try { await Promise.all(tailQ.map(q => searchReanime(q).catch(()=>[]))); } catch {}
      })();
      return data;
    }
  }

  // Si no salió por hotpath coverId, corremos los queries restantes y el resto del flujo
  const tailQ = queries.slice(2);
  if (tailQ.length) {
    await Promise.all(tailQ.map(async (q) => {
      for (const r of await searchReanime(q).catch(() => [])) {
        if (r?.anime_id && !candidates.has(r.anime_id)) candidates.set(r.anime_id, r);
      }
    }));
    sl(`full search (${queries.length}q) done candidates=${candidates.size}`);
  }

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
      sl(`matched via coverId id=${id} TOTAL +${Date.now()-t0}ms`);
      return data;
    }
  }

  const needsDetail = [...candidates.keys()].filter(
    (id) => extractAnilistIdFromCover(candidates.get(id)?.cover_image) === null
  );
  sl(`coverId no-match, needsDetail fetch x${needsDetail.length}`);
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
      sl(`matched via anilist_id id=${id} TOTAL +${Date.now()-t0}ms`);
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
        sl(`matched via malId id=${id} TOTAL +${Date.now()-t0}ms`);
        return data;
      }
    }
  }

  sl(`NO MATCH TOTAL +${Date.now()-t0}ms`);
  throw new Error(`No confirmed reanime match for AniList ${anilistId}`);
}

const SERVER_PRIORITY = { "HD-2": 0, "HD-1": 1 };
const sortByPriority = (arr) => arr.slice().sort((a, b) => (SERVER_PRIORITY[a.serverName] ?? 9) - (SERVER_PRIORITY[b.serverName] ?? 9));

async function resolveReanimeStream(anilistId, audio, ep) {
  const t0 = Date.now();
  const sl = (s) => console.log(`  [reanime:stream ${anilistId}/${ep} ${audio}] ${s}: +${Date.now()-t0}ms`);
  sl("start");
  const series = await resolveSeries(anilistId);
  sl(`resolved series slug=${series.animeId}`);
  const slug = series.animeId;

  const t1 = Date.now();
  const [watchRes, flixRes] = await Promise.allSettled([
    reanimeFetch(`${BASE}/api/watch/${slug}/${ep}`, { timeoutMs: 15000, responseType: "json" }),
    reanimeFetch(`${BASE}/api/flix/${anilistId}/${ep}`, { timeoutMs: 15000, responseType: "json" }),
  ]);
  sl(`Promise.all watch+flix: +${Date.now()-t1}ms watch=${watchRes.status} flix=${flixRes.status}`);
  const watchData = watchRes.status === "fulfilled" ? watchRes.value : null;
  const flixData = flixRes.status === "fulfilled" ? flixRes.value : null;

  const links = [...(watchData?.episode_links ?? [])];
  if (flixData?.success && flixData?.servers) {
    const seen = new Set(links.map((s) => s["$id"]));
    for (const s of flixData.servers) if (!seen.has(s["$id"])) links.push(s);
  }

  const audioTypes = audio === "sub" ? ["sub", "s-sub"] : ["dub", "s-dub"];
  const servers = sortByPriority(links.filter((s) => audioTypes.includes(s.dataType)));
  sl(`candidate servers: ${servers.map(s => `${s.serverName}(${s.dataType})`).join(" / ")}`);
  if (!servers.length) throw Object.assign(new Error(`No ${audio} servers for ep ${ep}`), { status: 404 });

  const errors = [];
  for (let i = 0; i < servers.length; i++) {
    const server = servers[i];
    try {
      const tembed = Date.now();
      sl(`[${i+1}/${servers.length}] fetch embed ${server.serverName} → ${server.dataLink.slice(0,70)}`);
      const embedHtml = await reanimeFetch(server.dataLink, { timeoutMs: 15000, responseType: "text" });
      sl(`[${i+1}/${servers.length}] embed html: +${Date.now()-tembed}ms size=${embedHtml?.length??0}B`);
      const textract = Date.now();
      const stream = await extractFlixcloud(embedHtml, {
        fetchImpl: makeWorkerFetchImpl(15000),
        apiBase: FLIX,
        headers: H,
        referer: `${BASE}/`,
      });
      sl(`[${i+1}/${servers.length}] extractFlixcloud: +${Date.now()-textract}ms subs=${stream.subtitles?.length??0} fonts=${Object.keys(stream.available_fonts??{}).length} vtt=${Boolean(stream.thumbnails_vtt)}`);
      const downloadLink = server.dataLink.replace("/e/", "/d/");
      sl(`SUCCESS ${server.serverName} TOTAL: +${Date.now()-t0}ms`);
      return {
        title: series.title,
        slug,
        server: server.serverName,
        url: stream.url,
        downloadLink,
        subtitles: stream.subtitles ?? [],
        available_fonts: stream.available_fonts ?? {},
        extracted_fonts: stream.extracted_fonts ?? [],
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
      sl(`[${i+1}/${servers.length}] FAIL ${server.serverName}: ${e.message}`);
      errors.push(`${server.serverName}: ${e.message}`);
    }
  }
  throw Object.assign(new Error(`All reanime servers failed for ${audio} ep ${ep}: ${errors.join(" | ")}`), { status: 502 });
}

// Devuelve { sub, dub } — cada uno null si no hay stream disponible para ese audio.
// Refactor: una sola resolveSeries + una sola watch+flix + dedup embeds entre sub/dub
// para no enviar N requests paralelas a la MISMA URL embed de flixcloud (que throttla >7s).
export async function getReanimeStreams(anilistId, episode) {
  const t0 = Date.now();
  const rlap = (s) => console.log(`  [reanime:getStreams ${anilistId}/${episode}] ${s}: +${Date.now()-t0}ms`);
  rlap("start");
  const ep = parseInt(episode);

  const series = await resolveSeries(anilistId);
  const slug = series.animeId;
  rlap(`series resolved slug=${slug}`);

  const t1 = Date.now();
  // HOTPATH: solo /api/flix (confiable). /api/watch suele dar 404 por 800ms
  // y bloquea el Promise.all. Lo corremos en bg async; si llega A tiempo lo mergeamos.
  const flixPromise = (async () => {
    try {
      const v = await reanimeFetch(`${BASE}/api/flix/${anilistId}/${ep}`, { timeoutMs: 15000, responseType: "json" });
      return { status: "fulfilled", value: v };
    } catch (e) {
      return { status: "rejected", reason: e };
    }
  })();
  let watchDataLive = null;
  let watchSettled = false;
  const watchPromise = (async () => {
    try {
      const r = await reanimeFetch(`${BASE}/api/watch/${slug}/${ep}`, { timeoutMs: 6000, responseType: "json" });
      watchDataLive = r;
      watchSettled = true;
      rlap(`bg /api/watch OK (late)`);
    } catch (e) {
      watchSettled = true;
      rlap(`bg /api/watch rejected: ${e.message}`);
    }
  })();
  // No await watchPromise — fire-and-forget with capture.

  const flixRes = await flixPromise;
  const flixElapsed = Date.now() - t1;
  rlap(`flix resolved: +${flixElapsed}ms ${flixRes.status==='rejected'?`REJECTED (${flixRes.reason?.message})`:'fulfilled'}. (watch still in bg, will merge later if arrives before pickBest)`);
  // Esperar MÁXIMO 200ms extra si /api/watch está por llegar (porque reanime a veces sí trae episode_links útiles).
  // No más de 200ms: el 99% de los casos /api/watch ya falló o no vale la pena.
  if (!watchSettled) {
    await new Promise(r => setTimeout(r, 200));
  }
  const watchData = watchDataLive;
  const flixData = flixRes.status === "fulfilled" ? flixRes.value : null;

  const links = [...(watchData?.episode_links ?? [])];
  if (flixData?.success && flixData?.servers) {
    const seen = new Set(links.map((s) => s["$id"]));
    for (const s of flixData.servers) if (!seen.has(s["$id"])) links.push(s);
  }

  const subTypes = ["sub", "s-sub"];
  const dubTypes = ["dub", "s-dub"];
  const subServers = sortByPriority(links.filter((s) => subTypes.includes(s.dataType)));
  const dubServers = sortByPriority(links.filter((s) => dubTypes.includes(s.dataType)));
  rlap(`servers candidate sub=${subServers.length} dub=${dubServers.length}`);

  const allServersDedup = new Map();
  for (const s of subServers) allServersDedup.set(s.dataLink, s);
  for (const s of dubServers) if (!allServersDedup.has(s.dataLink)) allServersDedup.set(s.dataLink, s);
  rlap(`embeds UNIQUE to fetch=${allServersDedup.size} (sub+dub combined, dedup by dataLink)`);

  const streamByDataLink = new Map();
  // HOTPATH: solo el embed de MAYOR prioridad (1 solo) por server. Los fallbacks en bg.
  // Sino 2 embeds secuenciales = 700ms extra. Fallbacks se resuelven en bg (prox hit lo tiene).
  const serverList = [...allServersDedup];
  const [firstDataLink, firstServer] = serverList[0] ?? [];
  const fallbackServers = serverList.slice(1);

  async function processEmbed(dataLink, server, tag = "") {
    try {
      const tembed = Date.now();
      rlap(`[embed${tag ? ` ${tag}`: ""}] ${server.serverName} → ${dataLink.slice(0,70)}`);
      const embedHtml = await reanimeFetch(dataLink, { timeoutMs: 15000, responseType: "text" });
      rlap(`[embed${tag ? ` ${tag}`: ""}] html: +${Date.now()-tembed}ms size=${embedHtml?.length??0}B`);
      const textract = Date.now();
      const stream = await extractFlixcloud(embedHtml, {
        fetchImpl: makeWorkerFetchImpl(15000),
        apiBase: FLIX,
        headers: H,
        referer: `${BASE}/`,
      });
      rlap(`[embed${tag ? ` ${tag}`: ""}] extract: +${Date.now()-textract}ms subs=${stream.subtitles?.length??0} fonts=${Object.keys(stream.available_fonts??{}).length} vtt=${Boolean(stream.thumbnails_vtt)}`);
      const downloadLink = dataLink.replace("/e/", "/d/");
      const entry = {
        server: server.serverName,
        url: stream.url,
        downloadLink,
        subtitles: stream.subtitles ?? [],
        available_fonts: stream.available_fonts ?? {},
        extracted_fonts: stream.extracted_fonts ?? [],
        thumbnails_vtt: stream.thumbnails_vtt ?? null,
        intro: stream.intro_chapter ?? null,
        outro: stream.outro_chapter ?? null,
        introStart: watchData?.intro_start ?? null,
        introEnd: watchData?.intro_end ?? null,
        outroStart: watchData?.outro_start ?? null,
        outroEnd: watchData?.outro_end ?? null,
        manifest_key: stream.manifest_key ?? null,
      };
      streamByDataLink.set(dataLink, entry);
      return true;
    } catch (e) {
      rlap(`[embed${tag ? ` ${tag}`: ""}] FAIL ${server.serverName}: ${e.message}`);
      return false;
    }
  }

  // HOTPATH v2: RACE paralelo entre TODOS los embeds únicos (HD-2 vs HD-1, etc).
  // Tomamos el PRIMERO que termine OK. El/los resto(s) siguen en bg async no-await
  // para cachear valor en prox hit. Esto evita que un solo embed colgado 6s
  // bloquee toda la respuesta (último test HD-2 = +6256ms vs HD-1 = ~300ms).
  if (serverList.length > 0) {
    rlap(`embed RACE paralelo x${serverList.length} embeds — winner-takes-all, rest bg async`);
    let winnerResolved = false;
    const winnerLock = Promise.withResolvers();
    const racers = serverList.map(async ([dataLink, server], i) => {
      try {
        const ok = await processEmbed(dataLink, server, `RACE ${i+1}/${serverList.length}`);
        if (ok && !winnerResolved) {
          winnerResolved = true;
          winnerLock.resolve({ dataLink, server });
        }
        return { ok, dataLink, server };
      } catch (e) {
        return { ok: false, dataLink, server };
      }
    });
    // Esperamos al primero que sea OK. Si todos fallan, devuelve el último reject.
    const anyResolvedOkOrAllRejected = (async () => {
      const results = await Promise.allSettled(racers);
      const ok = results.find(r => r.status === "fulfilled" && r.value?.ok);
      if (ok) return ok.value;
      throw new Error("todos los embeds fallaron");
    })();
    let winner = null;
    try {
      winner = await Promise.race([winnerLock.promise, anyResolvedOkOrAllRejected]);
    } catch {
      winner = null;
    }
    if (winner) {
      rlap(`🏆 embed RACE winner: ${winner.server.serverName} ${winner.dataLink.slice(0, 60)} — resto sigue en bg async para prox hit`);
    } else if (streamByDataLink.size === 0) {
      rlap(`⚠ embed RACE: sin winner ni en streamByDataLink (todos fallaron)`);
    }
  }

  function pickBest(servers) {
    for (const s of servers) {
      const val = streamByDataLink.get(s.dataLink);
      if (val) return { title: series.title, slug, ...val };
    }
    return null;
  }

  const sub = pickBest(subServers);
  const dub = pickBest(dubServers);
  rlap(`done sub=${Boolean(sub)} dub=${Boolean(dub)} TOTAL +${Date.now()-t0}ms`);
  return { sub, dub };
}
