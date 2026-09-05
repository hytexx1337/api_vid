import { Router } from "express";
import { STREAM_TTL, isProviderEnabled, HEADERS } from "../config/constants.js";
import { cacheGet, cacheSet, timed, getR2Archive } from "../lib/cache.js";
import { buildSignedR2Url } from "../lib/r2-seal.js";
import { enqueueArchiveJob, isQueuedOrArchiving } from "../lib/r2-queue.js";
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
  normalizeLang,
} from "../lib/stream-formatter.js";
import { fetchTmdbMeta } from "../metadata/tmdb.js";
import { anilistToMal, getAnimeSkip, getIntroSkip } from "../metadata/anilist.js";
import {
  getLatinoStream,
  getCuevanaAnime,
  getCuevanaStreams,
  getCuevanaMovieStreams,
  getMegaplayStreams,
  getMegavidStream,
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

// ── Auto-archivado a R2 ──────────────────────────────────────────────────────
// Mismo criterio de prioridad de provider por idioma que scripts/r2-select.js.
const R2_AUTO_ARCHIVE_PRIORITY = {
  "ESP-LAT": ["animeav1", "cuevana"],
  "ENG-DUB": ["megaplay", "anikoto", "megavid", "miruro"],
};

// Devuelve TODOS los candidatos ordenados por prioridad de provider, para que
// el job de archivado pueda caer al siguiente si el primero falla (ej. la URL
// de megaplay existe pero está muerta al momento de descargar).
function pickArchiveCandidates(streams, lang, priorityList) {
  const candidates = streams.filter((s) => s.lang === lang && s.originalProvider !== "zenkai" && s.proxy_url);
  const ordered = [];
  for (const prefix of priorityList) {
    for (const s of candidates) {
      if (String(s.originalProvider || "").toLowerCase().includes(prefix) && !ordered.includes(s)) {
        ordered.push(s);
      }
    }
  }
  for (const s of candidates) {
    if (!ordered.includes(s)) ordered.push(s);
  }
  return ordered;
}

// Encola a R2 los idiomas que todavía no están archivados. proxy_url apunta
// al dominio público (proxyBase); para el fetch interno del archivador se usa
// loopback directo, evitando un salto de ida y vuelta por internet.
function autoArchiveMissingLangs(anilistId, episode, streams, r2Archived, proxyBase) {
  const internalBase = `http://127.0.0.1:${process.env.PORT || 8000}`;
  for (const [lang, priorityList] of Object.entries(R2_AUTO_ARCHIVE_PRIORITY)) {
    if (r2Archived[lang]) continue;
    if (isQueuedOrArchiving(anilistId, episode, lang)) continue;
    const candidates = pickArchiveCandidates(streams, lang, priorityList);
    if (!candidates.length) continue;
    const jobCandidates = candidates.map((c) => ({
      streamUrl: c.proxy_url.startsWith(proxyBase)
        ? internalBase + c.proxy_url.slice(proxyBase.length)
        : c.proxy_url,
      sourceProvider: c.originalProvider,
    }));
    enqueueArchiveJob({ animeId: anilistId, episode, lang, candidates: jobCandidates });
  }
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

  const [latinoResult, megaplayResult, megavidResult, cuevanaResult, crSubsResult, miruroResult, anikotoResult, aniskipResult] = await Promise.allSettled([
    timed2("animeav1", getLatinoStream(anilistId, episode)),
    timed2("megaplay", getMegaplayStreams(anilistId, parseInt(episode))),
    timed2("megavid", getMegavidStream(anilistId, parseInt(episode))),
    timed2("cuevana", getCuevanaAnime(anilistId, parseInt(episode))),
    timed2("cr-subs", getCRSubsForAnime(anilistId, parseInt(episode))),
    timed2("miruro", getMiruroStreams(anilistId, parseInt(episode))),
    timed2("anikoto", getAnikotoStreams(anilistId, parseInt(episode))),
    timed2("aniskip", anilistToMal(anilistId).then(malId => getAnimeSkip(malId, parseInt(episode)))),
  ]);
  lap("allSettled done");

  const aniskip = aniskipResult.status === "fulfilled" ? aniskipResult.value : null;
  if (aniskipResult.status === "rejected") console.warn("[anime] aniskip ✗:", aniskipResult.reason?.message);

  const latino = latinoResult.status === "fulfilled" ? latinoResult.value : null;
  const hasDubLatino = latino?.streams.some(s => s.type === "dub") ?? false;
  const cuevanaStreams = cuevanaResult.status === "fulfilled" ? cuevanaResult.value : [];
  if (cuevanaResult.status === "rejected") console.warn(`[anime] embed69 ✗:`, cuevanaResult.reason?.message);

  const crTracks = crSubsResult.status === "fulfilled" && crSubsResult.value?.length ? crSubsResult.value : null;
  if (crSubsResult.status === "rejected") console.warn("[anime] cr-subs ✗:", crSubsResult.reason?.message);

  const megaplayBoth = megaplayResult.status === "fulfilled" ? megaplayResult.value : { dub: null, sub: null };
  const miruro = miruroResult.status === "fulfilled" ? miruroResult.value : { dub: null, sub: null };
  if (miruroResult.status === "rejected") console.warn("[anime] miruro ✗:", miruroResult.reason?.message);
  const anikoto = anikotoResult.status === "fulfilled" ? anikotoResult.value : { sub: [], dub: [] };
  if (anikotoResult.status === "rejected") console.warn("[anime] anikoto ✗:", anikotoResult.reason?.message);
  const megavid = megavidResult.status === "fulfilled" ? megavidResult.value : null;
  if (megavidResult.status === "rejected") console.warn("[anime] megavid ✗:", megavidResult.reason?.message);

  return { megaplayDub: megaplayBoth.dub, megaplaySub: megaplayBoth.sub, megavid, latino, cuevanaStreams, hasDubLatino, crTracks, miruro, anikoto, aniskip };
}

router.get("/anime/:anilistId/:episode", async (req, res) => {
  const { anilistId, episode } = req.params;
  const proxyBase = getProxyBase(req);

  // v3: agrega provider megavid (ENG-DUB) — bump para invalidar entradas
  // persistidas de antes de este cambio.
  const cacheKey = `streams:anime:v3:${anilistId}:${episode}`;
  let data = cacheGet(cacheKey);

  if (!data) {
    data = await resolveAnimeData(anilistId, episode);
    const hasAny = data.megaplayDub || data.megaplaySub || data.megavid || data.latino || data.cuevanaStreams?.length || data.anikoto?.sub?.length || data.anikoto?.dub?.length || data.anikoto?.hsub?.length;
    if (hasAny) cacheSet(cacheKey, data, STREAM_TTL);
  }

  const { megaplayDub, megaplaySub, megavid, latino, cuevanaStreams, crTracks, miruro, anikoto, aniskip } = data;
  const tracks = await buildAnimeTracks(anilistId, episode, proxyBase, megaplayDub, megaplaySub);

  const streams = [];

  // Streams archivados en R2 (bucket propio, ver scripts/r2-select.js).
  // Van primero en el array para quedar como "CPT CDN 1" de su idioma: no
  // dependen de que el provider original siga vivo, no hace falta re-scrapear.
  const R2_LANG_LABELS = { "ESP-LAT": "Español latino", "ENG-DUB": "Inglés (doblado)" };
  const r2Archived = getR2Archive(anilistId, episode);
  for (const [lang, entry] of Object.entries(r2Archived)) {
    try {
      const signedUrl = buildSignedR2Url(`${entry.slug}/master.m3u8`);
      streams.push({
        url: signedUrl,
        quality: "auto",
        lang,
        langLabel: R2_LANG_LABELS[lang] || lang,
        type: "hls",
        provider: "zenkai",
        originalProvider: "zenkai",
        sourceProvider: entry.sourceProvider,
        proxy_url: signedUrl,
      });
    } catch (e) {
      console.warn(`[anime] r2 archive ${lang} sin firmar: ${e.message}`);
    }
  }

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

  // Megavid DUB — el CDN (cp.megavid.buzz) bloquea referers ajenos
    // (player.zenkai.live da 403). Si hay worker de CF (MEGAVID_WORKER) el
    // stream sale por ahí directo — el VPS tiene conectividad rota con
    // megavid, así que ni la API ni el CDN le responden bien; si no, cae
    // al proxy genérico con Referer megavid.buzz.
    if (megavid?.url) {
      const s = makeAnimeStream(proxyBase, megavid.url, "auto", "en-dub", "megavid", {
        headers: { Referer: "https://megavid.buzz/", "User-Agent": HEADERS["User-Agent"] },
      });
      const worker = (process.env.MEGAVID_WORKER || "").replace(/\/$/, "");
      s.proxy_url = worker
        ? worker + new URL(megavid.url).pathname + new URL(megavid.url).search
        : `${proxyBase}/generic-stream.m3u8?u=${encodeURIComponent(megavid.url)}&ref=${encodeURIComponent("https://megavid.buzz/")}`;
      streams.push(s);
    }

  // animeav1 — links de descarga directa (Mega, 1Fichier, MP4Upload, StreamTape)
  const downloads = [];
  for (const [list, type] of [[latino?.downloads?.dub ?? [], "dub"], [latino?.downloads?.sub ?? [], "sub"]]) {
    if (!list.length) continue;
    const { lang, langLabel } = normalizeLang(type === "dub" ? "es-lat" : "japanese", "animeav1");
    for (const { server, url } of list) downloads.push({ lang, langLabel, server, url });
  }

  // animeav1
  if (latino) {
    for (const { url, type, server, provider: streamProvider, cfUrl, thumbnailVtt, thumbnailJpg } of latino.streams) {
      const lang = type === "dub" ? "es-lat" : "ja-sub-lat";
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
      const originalProvider = `miruro-${miruroStream.provider}`;

      // Link de descarga directa (pahe.win, bysekoze.com, etc) — independiente
      // de si el stream del provider está oculto/roto para reproducción directa.
      if (miruroStream.download) {
        const { lang: dlLang, langLabel: dlLangLabel } = normalizeLang(lang, originalProvider);
        downloads.push({ lang: dlLang, langLabel: dlLangLabel, server: miruroStream.provider, url: miruroStream.download });
      }

      if (MIRURO_HIDDEN_PROVIDERS.has(miruroStream.provider)) continue;
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

  // Anikoto (hsub = japonés con subs en inglés quemados; normalizeLang lo
  // mapea a JAP-EN-HS porque el provider contiene "anikoto")
  for (const [list, lang, prefix] of [
    [anikoto?.dub ?? [], "en-dub", "anikoto"],
    [anikoto?.sub ?? [], "japanese", "anikoto"],
    [anikoto?.hsub ?? [], "japanese", "anikoto-hsub"],
  ]) {
    for (const src of list) {
      const isHLS = src.type === "hls" || src.url.includes(".m3u8");
      if (!isHLS) continue;
      const originalProvider = `${prefix}-${src.server}`;
      const s = makeAnimeStream(proxyBase, src.url, "auto", lang, originalProvider, {
        headers: { Referer: src.referer, Origin: src.referer.replace(/\/$/, ""), "User-Agent": HEADERS["User-Agent"] },
        skip: src.skip ?? null,
      });
      s.proxy_url = `${proxyBase}/generic-stream.m3u8?u=${encodeURIComponent(src.url)}&ref=${encodeURIComponent(src.referer)}`;
      streams.push(s);
    }
  }

  if (streams.length === 0) return res.status(404).json({ error: "No streams found for this episode" });

  // Fire-and-forget: no bloquea la respuesta, corre en background.
  autoArchiveMissingLangs(anilistId, episode, streams, r2Archived, proxyBase);

  // Megaplay tiene los timestamps de intro/outro más precisos (por episodio,
  // no una estimación genérica). Se propagan a todos los streams del mismo
  // grupo dub/sub: megaplayDub.skip -> ESP-LAT, ENG-DUB, etc; megaplaySub.skip
  // -> JAP-SUB, JAP-ES-HS, JAP-EN-HS. aniskip queda como último fallback solo
  // si megaplay no tiene datos para ese grupo.
  const isDubLang = (lang) => /DUB|LAT/.test(lang || "");
  const megaplayDubSkip = megaplayDub && Object.keys(megaplayDub.skip || {}).length ? megaplayDub.skip : null;
  const megaplaySubSkip = megaplaySub && Object.keys(megaplaySub.skip || {}).length ? megaplaySub.skip : null;
  for (const s of streams) {
    const preferred = isDubLang(s.lang) ? megaplayDubSkip : megaplaySubSkip;
    if (preferred) s.skip = preferred;
    else if (!s.skip && aniskip) s.skip = aniskip;
  }

  const sorted = sortStreams(streams);
  const grouped = [...sorted.filter(s => isDubLang(s.lang)), ...sorted.filter(s => !isDubLang(s.lang))];
  const withDisplay = assignDisplayProviders(grouped);
  res.json(sealProxyUrls({ anilistId, episode: parseInt(episode), streams: withDisplay, tracks, downloads }, proxyBase));
});

export default router;
