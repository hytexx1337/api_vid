import { Router } from "express";
import { STREAM_TTL, isProviderEnabled, HEADERS } from "../config/constants.js";
import { cacheGet, cacheSet, timed } from "../lib/cache.js";
import { getProxyBase } from "../lib/proxy.js";
import { buildTracks, readVdrkIndex, writeVdrkIndex, vdrkKey, getVidrkSubsWithIndex, normalizeSubLabel } from "../lib/subtitles.js";
import { sealProxyUrls } from "../lib/proxy-seal.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import {
  makeCuevanaStream,
  makeVidsrcStream,
  makeGenericStream,
  makeVixsrcStream,
  makeAnimeStream,
  sortStreams,
  assignDisplayProviders,
  mapMovieTvLang,
} from "../lib/stream-formatter.js";
import { fetchTmdbMeta } from "../metadata/tmdb.js";
import { anilistToMal, getAnimeSkip, getIntroSkip } from "../metadata/anilist.js";
import {
  getLatinoStream,
  getCuevanaAnime,
  getCuevanaStreams,
  getCuevanaMovieStreams,
  getMegaplayStreams,
  getCRSubsForAnime,
  getMiruroStreams,
  getAnikotoStreams,
  getVaplayerStream,
  getVidupStream,
  getCinejoyStream,
  getVideasyStream,
  getVixsrcStream,
  WANTED_ASS_LANGS,
} from "../providers/index.js";

const router = Router();

// Rate limit para endpoints JSON: 60 req/min por IP.
router.use(createRateLimiter({ windowMs: 60_000, max: 60, message: "Too many stream requests" }));

function handleError(res, err) {
  const status = err.status ?? 502;
  res.status(status).json({ error: err.message });
}

async function buildMovieTvTracks(tmdbId, type, season, episode, proxyBase) {
  const vidrkSubs = await getVidrkSubsWithIndex(tmdbId, type, +season, +episode, null).then(r => r ?? []).catch(() => []);
  if (!vidrkSubs?.length) return [];
  return buildTracks(vidrkSubs, proxyBase);
}

async function buildAnimeTracks(anilistId, episode, proxyBase, megaplayDub, megaplaySub) {
  const [crTracks] = await Promise.all([
    getCRSubsForAnime(anilistId, parseInt(episode)).then(r => r ?? []).catch(() => []),
  ]);
  const ASS_LABELS = { "en-US": "English", "es-419": "Español latino", "es-ES": "Español" };

  const vttTracks = (crTracks || []).filter(t => t.format === "vtt").map(t => ({
    label: t.lang === "en-US" ? "English CC" : normalizeSubLabel(t.label, t.lang),
    lang: t.lang,
    file: t.file,
    kind: "captions",
    ...(t.default && { default: true }),
  }));

  const assTracks = (crTracks || []).filter(t => t.format === "ass" && WANTED_ASS_LANGS.has(t.lang)).map(t => ({
    label: ASS_LABELS[t.lang] || t.label || t.lang,
    lang: t.lang,
    file: t.file,
    kind: "subtitles",
    ...(t.default && { default: true }),
  }));

  const megaplayTracks = [];
  const seenMpUrls = new Set();
  for (const mp of [megaplayDub, megaplaySub]) {
    if (!mp?.subtitles?.length) continue;
    for (const s of mp.subtitles) {
      const key = s.url || s.file;
      if (!key || seenMpUrls.has(key)) continue;
      seenMpUrls.add(key);
      megaplayTracks.push({ label: s.label, lang: s.lang, url: s.url, kind: "subtitles", referer: s.referer, ...(s.default && { default: s.default }) });
    }
  }
  const rawTracks = [...vttTracks, ...assTracks, ...megaplayTracks];
  if (!rawTracks.length) return [];
  return buildTracks(rawTracks, proxyBase);
}

// ── Movie endpoint ────────────────────────────────────────────────────────────
router.get("/movie/:tmdbId", async (req, res) => {
  const { tmdbId } = req.params;
  try {
    const cacheKey = `streams:movie:${tmdbId}`;
    let data = cacheGet(cacheKey);

    if (!data) {
      const tmdbMetaPromise = timed("movie/tmdbMeta", () => fetchTmdbMeta(tmdbId, "movie")).catch(e => { console.warn("[movie] tmdbMeta:", e.message); return null; });
      const othersPromise = Promise.all([
        isProviderEnabled("vaplayer") ? timed("movie/vaplayer", () => getVaplayerStream(tmdbId, "movie")).catch(e => { console.warn("[movie] vaplayer:", e.message); return null; }) : Promise.resolve(null),
        isProviderEnabled("vidup") ? timed("movie/vidup", () => getVidupStream(tmdbId, "movie")).catch(e => { console.warn("[movie] vidup:", e.message); return null; }) : Promise.resolve(null),
      ]);
      const tmdbMeta = await tmdbMetaPromise;
      const dependentPromise = Promise.all([
        tmdbMeta?.imdbId ? getCuevanaMovieStreams(tmdbMeta.imdbId).catch(e => { console.warn("[movie] cuevana:", e.message); return []; }) : Promise.resolve([]),
        isProviderEnabled("cinejoy") && tmdbMeta?.title ? timed("movie/cinejoy", () => getCinejoyStream({ tmdbId, mediaType: "movie", title: tmdbMeta.title, year: tmdbMeta.year, imdbId: tmdbMeta.imdbId })).catch(e => { console.warn("[movie] cinejoy:", e.message); return null; }) : Promise.resolve(null),
        isProviderEnabled("videasy") ? (tmdbMeta?.title ? timed("movie/videasy", () => getVideasyStream(tmdbId, "movie", 1, 1, { title: tmdbMeta.title, year: tmdbMeta.year, imdbId: tmdbMeta.imdbId })).catch(e => { console.warn("[movie] videasy:", e.message); return null; }) : timed("movie/videasy", () => getVideasyStream(tmdbId, "movie", 1, 1, {})).catch(e => { console.warn("[movie] videasy:", e.message); return null; })) : Promise.resolve(null),
        isProviderEnabled("vixsrc") ? timed("movie/vixsrc", () => getVixsrcStream(tmdbId, "movie")).catch(e => { console.warn("[movie] vixsrc:", e.message); return null; }) : Promise.resolve(null),
      ]);
      const [[vaplayerResult, vidupResult], [cuevanaStreams, cinejoyResult, videasyResult, vixsrcResult]] = await Promise.all([othersPromise, dependentPromise]);
      data = { tmdbMeta, cuevanaStreams, cinejoy: cinejoyResult, vaplayer: vaplayerResult, vidup: vidupResult, videasy: videasyResult, vixsrc: vixsrcResult };
      cacheSet(cacheKey, data, STREAM_TTL);
    }

    const { tmdbMeta, cuevanaStreams, cinejoy, vaplayer, vidup, videasy, vixsrc } = data;
    const proxyBase = getProxyBase(req);
    const originalLang = tmdbMeta?.lang ?? "en";

    const tracks = await buildMovieTvTracks(tmdbId, "movie", 1, 1, proxyBase);

    const streams = [];
    for (const c of cuevanaStreams) streams.push(makeCuevanaStream(c, proxyBase));
    if (vaplayer?.url) streams.push(makeVidsrcStream(vaplayer, proxyBase, mapMovieTvLang(vaplayer.lang, originalLang)));
    if (vidup?.url) streams.push(makeVidsrcStream(vidup, proxyBase, mapMovieTvLang(vidup.lang, originalLang)));
    if (cinejoy?.url) streams.push(makeGenericStream(cinejoy, proxyBase, mapMovieTvLang(cinejoy.lang, originalLang)));
    if (videasy?.url) streams.push(makeGenericStream(videasy, proxyBase, mapMovieTvLang(videasy.lang, originalLang)));
    if (vixsrc?.masterUrl) streams.push(makeVixsrcStream(vixsrc, proxyBase, mapMovieTvLang("en", originalLang)));
    const sorted = sortStreams(streams);
    const withDisplay = assignDisplayProviders(sorted);
    const response = { streams: withDisplay, tracks, meta: tmdbMeta ? { title: tmdbMeta.title, year: tmdbMeta.year, originalLang } : null };
    res.json(sealProxyUrls(response, proxyBase));
  } catch (err) { handleError(res, err); }
});

// ── TV endpoint ─────────────────────────────────────────────────────────────────
router.get("/tv/:tmdbId/:season/:episode", async (req, res) => {
  const { tmdbId, season, episode } = req.params;
  try {
    const cacheKey = `streams:tv:${tmdbId}:${season}:${episode}`;
    let data = cacheGet(cacheKey);

    if (!data) {
      const tmdbMetaPromise = timed("tv/tmdbMeta", () => fetchTmdbMeta(tmdbId, "tv")).catch(e => { console.warn("[tv] tmdbMeta:", e.message); return null; });
      const othersPromise = Promise.all([
        isProviderEnabled("vaplayer") ? timed("tv/vaplayer", () => getVaplayerStream(tmdbId, "tv", +season, +episode)).catch(e => { console.warn("[tv] vaplayer:", e.message); return null; }) : Promise.resolve(null),
        isProviderEnabled("vidup") ? timed("tv/vidup", () => getVidupStream(tmdbId, "tv", +season, +episode)).catch(e => { console.warn("[tv] vidup:", e.message); return null; }) : Promise.resolve(null),
      ]);
      const tmdbMeta = await tmdbMetaPromise;
      const dependentPromise = Promise.all([
        tmdbMeta?.imdbId ? getCuevanaStreams(tmdbMeta.imdbId, +season, +episode).catch(e => { console.warn("[tv] cuevana:", e.message); return []; }) : Promise.resolve([]),
        tmdbMeta?.imdbId ? getIntroSkip(tmdbMeta.imdbId, +season, +episode).catch(e => { console.warn("[tv] introdb:", e.message); return null; }) : Promise.resolve(null),
        isProviderEnabled("cinejoy") && tmdbMeta?.title ? timed("tv/cinejoy", () => getCinejoyStream({ tmdbId, mediaType: "tv", title: tmdbMeta.title, year: tmdbMeta.year, imdbId: tmdbMeta.imdbId, season: +season, episode: +episode })).catch(e => { console.warn("[tv] cinejoy:", e.message); return null; }) : Promise.resolve(null),
        isProviderEnabled("videasy") ? (tmdbMeta?.title ? timed("tv/videasy", () => getVideasyStream(tmdbId, "tv", +season, +episode, { title: tmdbMeta.title, year: tmdbMeta.year, imdbId: tmdbMeta.imdbId })).catch(e => { console.warn("[tv] videasy:", e.message); return null; }) : timed("tv/videasy", () => getVideasyStream(tmdbId, "tv", +season, +episode, {})).catch(e => { console.warn("[tv] videasy:", e.message); return null; })) : Promise.resolve(null),
        isProviderEnabled("vixsrc") ? timed("tv/vixsrc", () => getVixsrcStream(tmdbId, "tv", +season, +episode)).catch(e => { console.warn("[tv] vixsrc:", e.message); return null; }) : Promise.resolve(null),
      ]);
      const [[vaplayerResult, vidupResult], [cuevanaStreams, skipData, cinejoyResult, videasyResult, vixsrcResult]] = await Promise.all([othersPromise, dependentPromise]);
      data = { tmdbMeta, cuevanaStreams, cinejoy: cinejoyResult, skip: skipData, vaplayer: vaplayerResult, vidup: vidupResult, videasy: videasyResult, vixsrc: vixsrcResult };
      cacheSet(cacheKey, data, STREAM_TTL);
    }

    const { tmdbMeta, cuevanaStreams, cinejoy, skip, vaplayer, vidup, videasy, vixsrc } = data;
    const proxyBase = getProxyBase(req);
    const originalLang = tmdbMeta?.lang ?? "en";

    const tracks = await buildMovieTvTracks(tmdbId, "tv", +season, +episode, proxyBase);

    const streams = [];
    for (const c of cuevanaStreams) streams.push(makeCuevanaStream(c, proxyBase));
    if (vaplayer?.url) streams.push(makeVidsrcStream(vaplayer, proxyBase, mapMovieTvLang(vaplayer.lang, originalLang)));
    if (vidup?.url) streams.push(makeVidsrcStream(vidup, proxyBase, mapMovieTvLang(vidup.lang, originalLang)));
    if (cinejoy?.url) streams.push(makeGenericStream(cinejoy, proxyBase, mapMovieTvLang(cinejoy.lang, originalLang)));
    if (videasy?.url) streams.push(makeGenericStream(videasy, proxyBase, mapMovieTvLang(videasy.lang, originalLang)));
    if (vixsrc?.masterUrl) streams.push(makeVixsrcStream(vixsrc, proxyBase, mapMovieTvLang("en", originalLang)));

    const sorted = sortStreams(streams);
    const withDisplay = assignDisplayProviders(sorted);
    const response = { streams: withDisplay, tracks, skip: skip || null, meta: tmdbMeta ? { title: tmdbMeta.title, year: tmdbMeta.year, originalLang } : null };
    res.json(sealProxyUrls(response, proxyBase));
  } catch (err) { handleError(res, err); }
});

// ── Anime endpoint ─────────────────────────────────────────────────────────────
async function resolveAnimeData(anilistId, episode) {
  const t0 = Date.now();
  const lap = (label) => console.log(`  [resolveAnime ${anilistId}/${episode}] ${label}: ${Date.now() - t0}ms`);

  const timed2 = (name, promise) => {
    const ts = Date.now();
    return promise.then(
      v => { console.log(`  [resolveAnime] ${name} OK: ${Date.now() - ts}ms`); return v; },
      e => { console.warn(`  [resolveAnime] ${name} ✗ (${Date.now() - ts}ms):`, e.message); throw e; }
    );
  };

  const [latinoResult, megaplayResult, cuevanaResult, crSubsResult, miruroResult, anikotoResult] = await Promise.allSettled([
    timed2("animeav1", getLatinoStream(anilistId, episode)),
    timed2("megaplay", getMegaplayStreams(anilistId, parseInt(episode))),
    timed2("cuevana", getCuevanaAnime(anilistId, parseInt(episode))),
    timed2("cr-subs", getCRSubsForAnime(anilistId, parseInt(episode))),
    timed2("miruro", getMiruroStreams(anilistId, parseInt(episode))),
    timed2("anikoto", getAnikotoStreams(anilistId, parseInt(episode))),
  ]);
  lap("allSettled done");

  const latino = latinoResult.status === "fulfilled" ? latinoResult.value : null;
  const hasDubLatino = latino?.streams.some(s => s.type === "dub") ?? false;
  const cuevanaStreams = (!hasDubLatino && cuevanaResult.status === "fulfilled") ? cuevanaResult.value : [];
  if (cuevanaResult.status === "rejected") console.warn(`[anime] embed69 ✗:`, cuevanaResult.reason?.message);

  const crTracks = crSubsResult.status === "fulfilled" && crSubsResult.value?.length ? crSubsResult.value : null;
  if (crSubsResult.status === "rejected") console.warn("[anime] cr-subs ✗:", crSubsResult.reason?.message);

  const megaplayBoth = megaplayResult.status === "fulfilled" ? megaplayResult.value : { dub: null, sub: null };
  const miruro = miruroResult.status === "fulfilled" ? miruroResult.value : { dub: null, sub: null };
  if (miruroResult.status === "rejected") console.warn("[anime] miruro ✗:", miruroResult.reason?.message);
  const anikoto = anikotoResult.status === "fulfilled" ? anikotoResult.value : { sub: [], dub: [] };
  if (anikotoResult.status === "rejected") console.warn("[anime] anikoto ✗:", anikotoResult.reason?.message);

  return { megaplayDub: megaplayBoth.dub, megaplaySub: megaplayBoth.sub, latino, cuevanaStreams, hasDubLatino, crTracks, miruro, anikoto };
}

router.get("/anime/:anilistId/:episode", async (req, res) => {
  const { anilistId, episode } = req.params;
  const proxyBase = getProxyBase(req);

  const cacheKey = `streams:anime:${anilistId}:${episode}`;
  let data = cacheGet(cacheKey);

  if (!data) {
    data = await resolveAnimeData(anilistId, episode);
    const hasAny = data.megaplayDub || data.megaplaySub || data.latino || data.cuevanaStreams?.length || data.anikoto?.sub?.length || data.anikoto?.dub?.length;
    if (hasAny) cacheSet(cacheKey, data, STREAM_TTL);
  }

  const { megaplayDub, megaplaySub, latino, cuevanaStreams, crTracks, miruro, anikoto } = data;
  const tracks = await buildAnimeTracks(anilistId, episode, proxyBase, megaplayDub, megaplaySub);

  const streams = [];

  // Megaplay DUB
  if (megaplayDub) {
    const s = makeAnimeStream(proxyBase, megaplayDub.url, "auto", "en-dub", "megaplay", { skip: Object.keys(megaplayDub.skip).length ? megaplayDub.skip : null });
    s.proxy_url = `${proxyBase}/proxy?url=${encodeURIComponent(megaplayDub.url)}&headers=${encodeURIComponent(JSON.stringify(megaplayDub.headers || {}))}`;
    streams.push(s);
  }

  // Megaplay SUB
  if (megaplaySub) {
    const s = makeAnimeStream(proxyBase, megaplaySub.url, "auto", "japanese", "megaplay", { skip: Object.keys(megaplaySub.skip).length ? megaplaySub.skip : null });
    s.proxy_url = `${proxyBase}/proxy?url=${encodeURIComponent(megaplaySub.url)}&headers=${encodeURIComponent(JSON.stringify(megaplaySub.headers || {}))}`;
    streams.push(s);
  }

  // animeav1
  if (latino) {
    for (const { url, type, server, provider: streamProvider, cfUrl, thumbnailVtt, thumbnailJpg } of latino.streams) {
      const lang = type === "dub" ? "es-dub" : "ja-sub-lat";
      const originalProvider = streamProvider ?? (server > 1 ? `animeav1-s${server}` : "animeav1");
      const s = makeAnimeStream(proxyBase, url, "auto", lang, originalProvider);
      const upnStreamTarget = streamProvider === "upnshare" ? cfUrl : url;
      if (upnStreamTarget) s.proxy_url = `${proxyBase}/upn-stream.m3u8?u=${encodeURIComponent(upnStreamTarget)}`;
      if (thumbnailVtt) {
        s.thumbnailVtt = thumbnailVtt;
        s.thumbnailVttProxy = `${proxyBase}/fetch?url=${encodeURIComponent(thumbnailVtt)}&ref=${encodeURIComponent(new URL(thumbnailVtt).origin + "/")}&ct=${encodeURIComponent("text/vtt")}`;
      }
      if (thumbnailJpg) {
        s.thumbnailJpg = thumbnailJpg;
        s.thumbnailJpgProxy = `${proxyBase}/fetch?url=${encodeURIComponent(thumbnailJpg)}&ref=${encodeURIComponent(new URL(thumbnailJpg).origin + "/")}&ct=${encodeURIComponent("image/jpeg")}`;
      }
      streams.push(s);
    }
  }

  // Miruro
  const MIRURO_HIDDEN_PROVIDERS = new Set(["bee", "ally"]);
  for (const [miruroList, lang] of [
    [miruro?.dub ?? [], "en-dub"],
    [miruro?.sub ?? [], "japanese"],
  ]) {
    for (const miruroStream of miruroList) {
      if (!miruroStream?.url) continue;
      if (MIRURO_HIDDEN_PROVIDERS.has(miruroStream.provider)) continue;
      const originalProvider = `miruro-${miruroStream.provider}`;
      const s = makeAnimeStream(proxyBase, miruroStream.url, "auto", lang, originalProvider, {
        skip: miruroStream.skip && (miruroStream.skip.intro || miruroStream.skip.outro) ? miruroStream.skip : null,
        headers: Object.keys(miruroStream.headers ?? {}).length ? miruroStream.headers : null,
      });
      // La URL ya viene proxiada por Miruro; la pasamos por nuestro proxy para evitar bloqueos directos
      s.proxy_url = `${proxyBase}/generic-stream.m3u8?u=${encodeURIComponent(miruroStream.url)}&ref=${encodeURIComponent("https://www.miruro.tv/")}`;
      streams.push(s);
    }
  }

  // cuevana
  for (const c of (cuevanaStreams ?? [])) streams.push(makeCuevanaStream(c, proxyBase));

  // Anikoto
  for (const [list, lang] of [
    [anikoto?.dub ?? [], "en-dub"],
    [anikoto?.sub ?? [], "japanese"],
  ]) {
    for (const src of list) {
      const isHLS = src.type === "hls" || src.url.includes(".m3u8");
      if (!isHLS) continue;
      const originalProvider = `anikoto-${src.server}`;
      const s = makeAnimeStream(proxyBase, src.url, "auto", lang, originalProvider, {
        headers: { Referer: src.referer, Origin: src.referer.replace(/\/$/, ""), "User-Agent": HEADERS["User-Agent"] },
        skip: src.skip ?? null,
      });
      s.proxy_url = `${proxyBase}/generic-stream.m3u8?u=${encodeURIComponent(src.url)}&ref=${encodeURIComponent(src.referer)}`;
      streams.push(s);
    }
  }

  if (streams.length === 0) return res.status(404).json({ error: "No streams found for this episode" });

  const sorted = sortStreams(streams);
  const isDubLang = (lang) => /DUB|LAT/.test(lang || "");
  const grouped = [...sorted.filter(s => isDubLang(s.lang)), ...sorted.filter(s => !isDubLang(s.lang))];
  const withDisplay = assignDisplayProviders(grouped);
  res.json(sealProxyUrls({ anilistId, episode: parseInt(episode), streams: withDisplay, tracks }, proxyBase));
});

export default router;
