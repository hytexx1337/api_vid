import { Router } from "express";
import fs from "fs";
import { STREAM_TTL, REANIME_STREAM_TTL, isProviderEnabled, HEADERS } from "../config/constants.js";
import { cacheGet, cacheSet, cacheDelete, timed, getR2Archive, getManualTracks, getEpisodeThumbnails, upsertEpisodeThumbnail } from "../lib/cache.js";
import { buildPublicR2Url, buildSignedR2Url } from "../lib/r2-seal.js";
import { enqueueArchiveJob, isQueuedOrArchiving } from "../lib/r2-queue.js";
import { isR2Configured } from "../lib/hls-to-r2.js";
import { archiveSubtitleTracksToR2, archiveThumbnailVttToR2 } from "../lib/reanime-r2.js";
import { getProxyBase } from "../lib/proxy.js";
import { buildTracks, readVdrkIndex, writeVdrkIndex, vdrkKey, getVidrkSubsWithIndex, normalizeSubLabel, detectTrackLang } from "../lib/subtitles.js";
import { sealProxyUrls } from "../lib/proxy-seal.js";
import { filterPlayableStreams, prewarmVerify } from "../lib/stream-verify.js";
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
  getVidyStream,
  getVidstuckStream,
  getVixsrcStream,
  getReanimeStreams,
  getAniwavesStreams,
  getAnimeheavenStreams,
  WANTED_ASS_LANGS,
} from "../providers/index.js";

const router = Router();

// Rate limit para endpoints JSON: 60 req/min por IP.
router.use(createRateLimiter({ windowMs: 60_000, max: 60, message: "Too many stream requests" }));

// Coalescing de resoluciones en vuelo: N requests concurrentes al mismo
// cacheKey awaitan la misma promesa en vez de disparar N scrapeos paralelos
// (un episodio recién emitido popular = stampede contra los providers).
const inflight = new Map();
function coalesce(key, fn) {
  let p = inflight.get(key);
  if (!p) {
    // #region debug-point C:coalesce-create
    reportAnimeRouteDebug("C", "src/routes/streams.js:coalesce:new", "[DEBUG] route coalesce create", { key });
    // #endregion
    p = Promise.resolve().then(fn).finally(() => inflight.delete(key));
    inflight.set(key, p);
  } else {
    // #region debug-point C:coalesce-join
    reportAnimeRouteDebug("C", "src/routes/streams.js:coalesce:join", "[DEBUG] route coalesce join", { key });
    // #endregion
  }
  return p;
}

// Respuesta final sellada+serializada por (cacheKey, proxyBase): absorbe
// ráfagas sobre el mismo recurso salteando build de streams + verify filter
// + seal AES + stringify. 60s — el verify cachea 5min así que no se congela
// nada que no estuviera ya congelado. Prefijo "resp:" → solo memoria.
const RESP_TTL = 60_000;
const reanimeSidecarInflight = new Map();
const ANIME_PERF_DEBUG = process.env.REANIME_DEBUG === "1";

// #region debug-point A:anime-route-debug-helper
let animeRouteDebugConfig = null;
function reportAnimeRouteDebug(hypothesisId, location, msg, data = {}) {
  if (!ANIME_PERF_DEBUG) return;
  try {
    if (!animeRouteDebugConfig) {
      let url = "http://127.0.0.1:7777/event";
      let sessionId = "api-cache-capacity";
      try {
        const env = fs.readFileSync(".dbg/api-cache-capacity.env", "utf8");
        url = env.match(/DEBUG_SERVER_URL=(.+)/)?.[1]?.trim() || url;
        sessionId = env.match(/DEBUG_SESSION_ID=(.+)/)?.[1]?.trim() || sessionId;
      } catch {}
      animeRouteDebugConfig = { url, sessionId };
    }
    fetch(animeRouteDebugConfig.url, {
      method: "POST",
      body: JSON.stringify({
        sessionId: animeRouteDebugConfig.sessionId,
        runId: "pre-fix",
        hypothesisId,
        location,
        msg,
        data,
        ts: Date.now(),
      }),
    }).catch(() => {});
  } catch {}
}
// #endregion

function handleError(res, err) {
  const status = err.status ?? 502;
  res.status(status).json({ error: err.message });
}

function createAnimePerfLogger(anilistId, episode) {
  const start = Date.now();
  let last = start;
  return {
    lap(label, extra = null) {
      if (!ANIME_PERF_DEBUG) return;
      const now = Date.now();
      const suffix = extra ? ` ${JSON.stringify(extra)}` : "";
      console.log(`[anime:perf ${anilistId}/${episode}] ${label}: +${now - last}ms total=${now - start}ms${suffix}`);
      last = now;
    },
  };
}

function collectReanimeSubtitleTracks(reanime) {
  const reanimeTracks = [];
  const seenReanimeUrls = new Set();
  for (const item of [reanime?.sub, reanime?.dub]) {
    if (!item?.subtitles?.length) continue;
    for (const s of item.subtitles) {
      const url = s.url || s.file;
      if (!url || seenReanimeUrls.has(url)) continue;
      seenReanimeUrls.add(url);
      const subLabel = s.language || s.label || "";
      reanimeTracks.push({
        label: normalizeSubLabel(subLabel, null) || subLabel || "Unknown",
        lang: s.lang || detectTrackLang(url, subLabel),
        sourceUrl: url,
        url,
        r2Key: s.r2_key ?? null,
        kind: (s.format === "ass" || /\.ass(\?|$)/i.test(url)) ? "subtitles" : "captions",
        referer: "https://flixcloud.cc/",
        ...(s.format === "ass" || /\.ass(\?|$)/i.test(url)
          ? {
              available_fonts: item.available_fonts ?? {},
              extracted_fonts: item.extracted_fonts ?? [],
            }
          : {}),
        ...(s.default && { default: true }),
      });
    }
  }
  return reanimeTracks;
}

function buildReanimeSubtitleFallbackTrack(track, proxyBase) {
  const ext = (() => {
    try {
      return new URL(track.url).pathname.split(".").pop()?.toLowerCase() || "";
    } catch {
      return "";
    }
  })();
  const ct = ext === "ass"
    ? "text/x-ssa"
    : ext === "vtt"
      ? "text/vtt"
      : "text/plain";
  const proxyUrl = `${proxyBase}/fetch?url=${encodeURIComponent(track.url)}&ref=${encodeURIComponent(track.referer || "https://flixcloud.cc/")}&ct=${encodeURIComponent(ct)}`;
  const { sourceUrl: _sourceUrl, r2Key: _r2Key, referer: _referer, url: _url, ...rest } = track;
  return { ...rest, url: proxyUrl };
}

function buildStableSubtitleUrl(proxyBase, file) {
  return `${proxyBase}/subs/${file}`;
}

function buildSubtitleDeliveryUrl(proxyBase, file, fromR2 = false) {
  return fromR2 ? buildPublicR2Url(`subs/${file}`) : buildStableSubtitleUrl(proxyBase, file);
}

function isDubLikeLang(lang) {
  return /DUB|LAT/.test(lang || "");
}

function enqueueReanimeSidecarArchive({ anilistId, episode, reanime, reanimeCacheKey, respKey }) {
  if (!isR2Configured() || !reanime || reanimeSidecarInflight.has(reanimeCacheKey)) return;

  const needsThumbs = [reanime?.sub, reanime?.dub].some((item) => item?.thumbnails_vtt && !item?.r2_thumbnail_vtt_key);
  const subtitleTracks = collectReanimeSubtitleTracks(reanime).filter((t) => !t.r2Key);
  if (!needsThumbs && !subtitleTracks.length) return;

  const job = Promise.resolve().then(async () => {
    let changed = false;

    for (const [item, variant] of [[reanime?.sub, "sub"], [reanime?.dub, "dub"]]) {
      if (!item?.thumbnails_vtt || item?.r2_thumbnail_vtt_key) continue;
      const key = await archiveThumbnailVttToR2(item.thumbnails_vtt, { animeId: anilistId, episode, variant });
      if (key) {
        item.r2_thumbnail_vtt_key = key;
        upsertEpisodeThumbnail({
          animeId: anilistId,
          episode,
          variant,
          vttKey: key,
          sourceProvider: item.server ? `reanime-${item.server}` : "reanime",
        });
        changed = true;
      }
    }

    if (subtitleTracks.length) {
      const archivedTracks = await archiveSubtitleTracksToR2(subtitleTracks);
      const r2KeyBySourceUrl = new Map(
        archivedTracks
          .filter((t) => t.r2Key)
          .map((t) => [String(t.sourceUrl || t.url || ""), t.r2Key])
      );

      for (const item of [reanime?.sub, reanime?.dub]) {
        if (!item?.subtitles?.length) continue;
        for (const s of item.subtitles) {
          const key = r2KeyBySourceUrl.get(String(s.url || s.file || ""));
          if (key && s.r2_key !== key) {
            s.r2_key = key;
            changed = true;
          }
        }
      }
    }

    if (changed) {
      cacheSet(reanimeCacheKey, reanime, REANIME_STREAM_TTL);
      if (respKey) cacheDelete(respKey);
    }
  }).catch((error) => {
    console.warn("[reanime-r2] background archive error:", error.message);
  }).finally(() => {
    reanimeSidecarInflight.delete(reanimeCacheKey);
  });

  reanimeSidecarInflight.set(reanimeCacheKey, job);
}

function syncReanimeThumbnailMetadata(anilistId, episode, reanime) {
  if (!anilistId || !episode || !reanime) return;
  for (const [item, variant] of [[reanime?.sub, "sub"], [reanime?.dub, "dub"]]) {
    if (!item?.r2_thumbnail_vtt_key) continue;
    upsertEpisodeThumbnail({
      animeId: anilistId,
      episode,
      variant,
      vttKey: item.r2_thumbnail_vtt_key,
      sourceProvider: item.server ? `reanime-${item.server}` : "reanime",
    });
  }
}

// ── Auto-archivado a R2 ──────────────────────────────────────────────────────
// Mismo criterio de prioridad de provider por idioma que scripts/r2-select.js.
const R2_AUTO_ARCHIVE_PRIORITY = {
  "ESP-LAT": ["animeav1", "cuevana"],
  "ENG-DUB": ["reanime", "megaplay", "anikoto", "megavid", "miruro"],
  "JAP-ES-HS": ["animeav1"],
  "JAP-EN-HS": ["anikoto-hsub", "aniwaves", "animeheaven", "miruro"],
};

// Devuelve TODOS los candidatos ordenados por prioridad de provider, para que
// el job de archivado pueda caer al siguiente si el primero falla (ej. la URL
// de megaplay existe pero está muerta al momento de descargar).
function pickArchiveCandidates(streams, lang, priorityList) {
  // archiveHlsToR2 solo sabe parsear playlists m3u8: descarta candidatos mp4
  // (ej. upnshare) para no gastar un intento que va a fallar seguro.
  const candidates = streams.filter((s) => s.lang === lang && s.originalProvider !== "zenkai" && s.proxy_url && s.type !== "mp4");
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
  // Sin credenciales R2 (ej. .env comentado en dev local) no encolar nada:
  // archiveHlsToR2 fallaría en assertR2Env por cada candidato y solo
  // ensuciaría el log.
  if (!isR2Configured()) return;
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

async function buildAnimeTracks(anilistId, episode, proxyBase, megaplayDub, megaplaySub, reanime) {
  const [crTracks] = await Promise.all([
    getCRSubsForAnime(anilistId, parseInt(episode)).then(r => r ?? []).catch(() => []),
  ]);
  const ASS_LABELS = { "en-US": "English", "es-419": "Español latino", "es-ES": "Español" };

  // Tracks de CR ya vienen descargados/archivados por getCRSubsForAnime (a
  // R2 o a disco local) — resolver la url final directo, sin pasar por
  // buildTracks/downloadSubtitles (ese pipeline re-descargaría cualquier
  // url con .file ausente, pisando la url de R2 con una copia local).
  const vttTracks = (crTracks || []).filter(t => t.format === "vtt").map(t => ({
    label: t.lang === "en-US" ? "English CC" : normalizeSubLabel(t.label, t.lang),
    lang: t.lang,
    url: buildSubtitleDeliveryUrl(proxyBase, t.file, t.r2),
    kind: "captions",
    ...(t.default && { default: true }),
  }));

  const assTracks = (crTracks || []).filter(t => t.format === "ass" && WANTED_ASS_LANGS.has(t.lang)).map(t => ({
    label: ASS_LABELS[t.lang] || t.label || t.lang,
    lang: t.lang,
    url: buildSubtitleDeliveryUrl(proxyBase, t.file, t.r2),
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
  // Solo los tracks de megaplay (urls externas crudas) necesitan el
  // pipeline genérico de descarga/cacheo local.
  const processedMegaplay = megaplayTracks.length ? await buildTracks(megaplayTracks, proxyBase) : [];

  // Tracks manuales: subs subidos a R2 (subs/{file}) desde el panel externo
  // y registrados en manual_tracks. Se sirven con URL firmada como los de CR.
  const manualTracks = getManualTracks(anilistId, episode).map(t => ({
    label: t.label,
    lang: t.lang,
    url: buildPublicR2Url(`subs/${t.file}`),
    kind: t.kind || "subtitles",
  }));

  // Subtítulos de reanime.to (flixcloud.cc): se extraen del embed ANTES de
  // decriptar la URL final del stream, así que quedan disponibles aunque el
  // stream en sí termine dando 403 al reproducir (token de flixcloud vencido,
  // ver /flixcloud-m3u8 en routes/proxy.js) — mejor tener subs sueltos que
  // nada. La mayoría vienen en .srt (se convierten a .vtt en downloadSubtitles)
  // y algunos en .ass por idioma.
  const reanimeTracks = collectReanimeSubtitleTracks(reanime);
  let processedReanime = [];
  if (reanimeTracks.length) {
    const readyInR2 = reanimeTracks
      .filter((t) => t.r2Key)
      .map(({ sourceUrl: _sourceUrl, r2Key, referer: _referer, ...rest }) => ({
        ...rest,
        url: buildPublicR2Url(String(r2Key)),
      }));
    const notArchivedYet = reanimeTracks.filter((t) => !t.r2Key);
    const fallbackTracks = notArchivedYet.map((t) => buildReanimeSubtitleFallbackTrack(t, proxyBase));
    processedReanime = [...readyInR2, ...fallbackTracks];
  }

  const rawTracks = [...vttTracks, ...assTracks, ...processedMegaplay, ...manualTracks, ...processedReanime];
  return rawTracks;
}

// ── Movie endpoint ────────────────────────────────────────────────────────────
router.get("/movie/:tmdbId", async (req, res) => {
  const { tmdbId } = req.params;
  try {
    const cacheKey = `streams:movie:${tmdbId}`;
    const proxyBase = getProxyBase(req);
    const respKey = `resp:${cacheKey}:${proxyBase}`;
    const cachedBody = cacheGet(respKey);
    if (cachedBody) return res.type("application/json").send(cachedBody);
    let data = cacheGet(cacheKey);

    if (!data) {
      data = await coalesce(cacheKey, async () => {
        const hit = cacheGet(cacheKey);
        if (hit) return hit;
      const tmdbMetaPromise = timed("movie/tmdbMeta", () => fetchTmdbMeta(tmdbId, "movie")).catch(e => { console.warn("[movie] tmdbMeta:", e.message); return null; });
      const othersPromise = Promise.all([
        isProviderEnabled("vaplayer") ? timed("movie/vaplayer", () => getVaplayerStream(tmdbId, "movie")).catch(e => { console.warn("[movie] vaplayer:", e.message); return null; }) : Promise.resolve(null),
        isProviderEnabled("vidup") ? timed("movie/vidup", () => getVidupStream(tmdbId, "movie")).catch(e => { console.warn("[movie] vidup:", e.message); return null; }) : Promise.resolve(null),
      ]);
      const tmdbMeta = await tmdbMetaPromise;
      const dependentPromise = Promise.all([
        tmdbMeta?.imdbId ? getCuevanaMovieStreams(tmdbMeta.imdbId).catch(e => { console.warn("[movie] cuevana:", e.message); return []; }) : Promise.resolve([]),
        isProviderEnabled("cinejoy") && tmdbMeta?.title ? timed("movie/cinejoy", () => getCinejoyStream({ tmdbId, mediaType: "movie", title: tmdbMeta.title, year: tmdbMeta.year, imdbId: tmdbMeta.imdbId })).catch(e => { console.warn("[movie] cinejoy:", e.message); return null; }) : Promise.resolve(null),
        isProviderEnabled("vidstuck") && tmdbMeta?.title && tmdbMeta?.date ? timed("movie/vidstuck", () => getVidstuckStream({ tmdbId, mediaType: "movie", title: tmdbMeta.title, year: tmdbMeta.year, date: tmdbMeta.date, latestDate: tmdbMeta.latestDate, imdbId: tmdbMeta.imdbId })).catch(e => { console.warn("[movie] vidstuck:", e.message); return null; }) : Promise.resolve(null),
        isProviderEnabled("vidy") && tmdbMeta?.title ? timed("movie/vidy", () => getVidyStream({ tmdbId, mediaType: "movie", title: tmdbMeta.title, year: tmdbMeta.year, imdbId: tmdbMeta.imdbId })).catch(e => { console.warn("[movie] vidy:", e.message); return null; }) : Promise.resolve(null),
        isProviderEnabled("vixsrc") ? timed("movie/vixsrc", () => getVixsrcStream(tmdbId, "movie")).catch(e => { console.warn("[movie] vixsrc:", e.message); return null; }) : Promise.resolve(null),
      ]);
      const [[vaplayerResult, vidupResult], [cuevanaStreams, cinejoyResult, vidstuckResult, vidyResult, vixsrcResult]] = await Promise.all([othersPromise, dependentPromise]);
      const d = { tmdbMeta, cuevanaStreams, cinejoy: cinejoyResult, vidy: vidyResult, vidstuck: vidstuckResult, vaplayer: vaplayerResult, vidup: vidupResult, vixsrc: vixsrcResult };
      cacheSet(cacheKey, d, STREAM_TTL);
      return d;
      });
    }

    const { tmdbMeta, cuevanaStreams, cinejoy, vidy, vidstuck, vaplayer, vidup, vixsrc } = data;
    const originalLang = tmdbMeta?.lang ?? "en";

    const tracks = await buildMovieTvTracks(tmdbId, "movie", 1, 1, proxyBase);

    const streams = [];
    for (const c of cuevanaStreams) streams.push(makeCuevanaStream(c, proxyBase));
    if (vaplayer?.url) streams.push(makeVidsrcStream(vaplayer, proxyBase, mapMovieTvLang(vaplayer.lang, originalLang)));
    if (vidup?.url) streams.push(makeVidsrcStream(vidup, proxyBase, mapMovieTvLang(vidup.lang, originalLang)));
    if (cinejoy?.url) streams.push(makeGenericStream(cinejoy, proxyBase, mapMovieTvLang(cinejoy.lang, originalLang)));
    if (vidstuck?.url) streams.push(makeGenericStream(vidstuck, proxyBase, mapMovieTvLang("en", originalLang)));
    for (const vs of vidy?.streams ?? []) streams.push(makeGenericStream(vs, proxyBase, mapMovieTvLang(vs.lang, originalLang)));
    if (vixsrc?.masterUrl) streams.push(makeVixsrcStream(vixsrc, proxyBase, mapMovieTvLang("en", originalLang)));
    const sorted = sortStreams(streams);
    const withDisplay = assignDisplayProviders(sorted);
    const response = { streams: withDisplay, tracks, meta: tmdbMeta ? { title: tmdbMeta.title, year: tmdbMeta.year, originalLang } : null };
    const body = JSON.stringify(sealProxyUrls(response, proxyBase));
    cacheSet(respKey, body, RESP_TTL);
    res.type("application/json").send(body);
  } catch (err) { handleError(res, err); }
});

// ── TV endpoint ─────────────────────────────────────────────────────────────────
router.get("/tv/:tmdbId/:season/:episode", async (req, res) => {
  const { tmdbId, season, episode } = req.params;
  try {
    const cacheKey = `streams:tv:${tmdbId}:${season}:${episode}`;
    const proxyBase = getProxyBase(req);
    const respKey = `resp:${cacheKey}:${proxyBase}`;
    const cachedBody = cacheGet(respKey);
    if (cachedBody) return res.type("application/json").send(cachedBody);
    let data = cacheGet(cacheKey);

    if (!data) {
      data = await coalesce(cacheKey, async () => {
        const hit = cacheGet(cacheKey);
        if (hit) return hit;
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
        isProviderEnabled("vidstuck") && tmdbMeta?.title && tmdbMeta?.date ? timed("tv/vidstuck", () => getVidstuckStream({ tmdbId, mediaType: "tv", title: tmdbMeta.title, year: tmdbMeta.year, date: tmdbMeta.date, latestDate: tmdbMeta.latestDate, imdbId: tmdbMeta.imdbId, season: +season, episode: +episode })).catch(e => { console.warn("[tv] vidstuck:", e.message); return null; }) : Promise.resolve(null),
        isProviderEnabled("vidy") && tmdbMeta?.title ? timed("tv/vidy", () => getVidyStream({ tmdbId, mediaType: "tv", title: tmdbMeta.title, year: tmdbMeta.year, imdbId: tmdbMeta.imdbId, season: +season, episode: +episode })).catch(e => { console.warn("[tv] vidy:", e.message); return null; }) : Promise.resolve(null),
        isProviderEnabled("vixsrc") ? timed("tv/vixsrc", () => getVixsrcStream(tmdbId, "tv", +season, +episode)).catch(e => { console.warn("[tv] vixsrc:", e.message); return null; }) : Promise.resolve(null),
      ]);
      const [[vaplayerResult, vidupResult], [cuevanaStreams, skipData, cinejoyResult, vidstuckResult, vidyResult, vixsrcResult]] = await Promise.all([othersPromise, dependentPromise]);
      const d = { tmdbMeta, cuevanaStreams, cinejoy: cinejoyResult, vidy: vidyResult, vidstuck: vidstuckResult, skip: skipData, vaplayer: vaplayerResult, vidup: vidupResult, vixsrc: vixsrcResult };
      cacheSet(cacheKey, d, STREAM_TTL);
      return d;
      });
    }

    const { tmdbMeta, cuevanaStreams, cinejoy, vidy, vidstuck, skip, vaplayer, vidup, vixsrc } = data;
    const originalLang = tmdbMeta?.lang ?? "en";

    const tracks = await buildMovieTvTracks(tmdbId, "tv", +season, +episode, proxyBase);

    const streams = [];
    for (const c of cuevanaStreams) streams.push(makeCuevanaStream(c, proxyBase));
    if (vaplayer?.url) streams.push(makeVidsrcStream(vaplayer, proxyBase, mapMovieTvLang(vaplayer.lang, originalLang)));
    if (vidup?.url) streams.push(makeVidsrcStream(vidup, proxyBase, mapMovieTvLang(vidup.lang, originalLang)));
    if (cinejoy?.url) streams.push(makeGenericStream(cinejoy, proxyBase, mapMovieTvLang(cinejoy.lang, originalLang)));
    if (vidstuck?.url) streams.push(makeGenericStream(vidstuck, proxyBase, mapMovieTvLang("en", originalLang)));
    for (const vs of vidy?.streams ?? []) streams.push(makeGenericStream(vs, proxyBase, mapMovieTvLang(vs.lang, originalLang)));
    if (vixsrc?.masterUrl) streams.push(makeVixsrcStream(vixsrc, proxyBase, mapMovieTvLang("en", originalLang)));

    const sorted = sortStreams(streams);
    const withDisplay = assignDisplayProviders(sorted);
    const response = { streams: withDisplay, tracks, skip: skip || null, meta: tmdbMeta ? { title: tmdbMeta.title, year: tmdbMeta.year, originalLang } : null };
    const body = JSON.stringify(sealProxyUrls(response, proxyBase));
    cacheSet(respKey, body, RESP_TTL);
    res.type("application/json").send(body);
  } catch (err) { handleError(res, err); }
});

// ── Anime endpoint ─────────────────────────────────────────────────────────────
async function resolveAnimeData(anilistId, episode, skipProviders = new Set()) {
  const t0 = Date.now();
  const lap = (label) => console.log(`  [resolveAnime ${anilistId}/${episode}] ${label}: ${Date.now() - t0}ms`);
  // #region debug-point B:resolve-start
  reportAnimeRouteDebug("B", "src/routes/streams.js:resolveAnimeData:start", "[DEBUG] resolveAnimeData start", { anilistId, episode, skipProviders: [...skipProviders] });
  // #endregion

  const timed2 = (name, promise) => {
    const ts = Date.now();
    return promise.then(
      v => { console.log(`  [resolveAnime] ${name} OK: ${Date.now() - ts}ms`); return v; },
      e => { console.warn(`  [resolveAnime] ${name} ✗ (${Date.now() - ts}ms):`, e.message); throw e; }
    );
  };

  // Los scrapers de hardsub hacen muchas requests externas (búsqueda, detalle,
  // servers, extractores con PoW). Sin un techo, un provider lento/colgado
  // retrasa la respuesta entera del endpoint.
  const HARDSUB_TIMEOUT = 90_000;
  const withScraperTimeout = (name, promise) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${name} timeout ${HARDSUB_TIMEOUT}ms`)), HARDSUB_TIMEOUT)),
  ]);

  // Prewarm del verify: apenas cada provider resuelve, disparamos la
  // verificación de sus URLs upstream en background (queda cacheada bajo
  // verify:{url}). Así el filterPlayableStreams del final es casi todo
  // cache-hit en vez de empezar recién cuando el provider más lento termina.
  // reanime/flixcloud NO se prewarma: su URL cruda está cifrada, solo se
  // puede verificar a través del proxy local.
  const pw = (s) => { try { prewarmVerify(s); } catch { /* nunca romper el flujo */ } };

  // Providers salteados porque zenkai ya cubre sus langs: devuelven el
  // empty shape que espera el build de abajo, sin scrapear.
  const skip = (name) => skipProviders.has(name);

  const [latinoResult, megaplayResult, megavidResult, cuevanaResult, crSubsResult, miruroResult, anikotoResult, aniskipResult, aniwavesResult, animeheavenResult] = await Promise.allSettled([
    skip("animeav1") ? Promise.resolve(null) : timed2("animeav1", getLatinoStream(anilistId, episode).then(v => {
      for (const s of v?.streams ?? []) {
        // MP4Upload: mp4 directo — su CDN exige Referer del embed. Verificar
        // sin headers da 403 y cachea false bajo verify:{url}, excluyendo el
        // stream antes de que filterPlayableStreams pruebe proxy_url.
        const isMp4u = s.provider === "mp4upload";
        pw({
          url: s.cfUrl ?? s.url,
          headers: isMp4u ? { Referer: "https://mp4upload.com/" } : undefined,
          type: isMp4u ? "mp4" : "hls",
          originalProvider: s.provider ?? "animeav1",
        });
      }
      return v;
    })),
    skip("megaplay") ? Promise.resolve({ dub: null, sub: null }) : timed2("megaplay", getMegaplayStreams(anilistId, parseInt(episode)).then(v => {
      for (const it of [v?.dub, v?.sub]) if (it?.url) pw({ url: it.url, headers: it.headers, type: "hls", originalProvider: "megaplay" });
      return v;
    })),
    skip("megavid") ? Promise.resolve(null) : timed2("megavid", (isProviderEnabled("megavid") ? getMegavidStream(anilistId, parseInt(episode)).then(v => {
      if (v?.url) pw({ url: v.url, headers: { Referer: "https://megavid.buzz/" }, type: "hls", originalProvider: "megavid" });
      return v;
    }) : Promise.resolve(null))),
    skip("cuevana") ? Promise.resolve([]) : timed2("cuevana", getCuevanaAnime(anilistId, parseInt(episode)).then(v => {
      for (const c of v ?? []) if (c?.url) pw({ url: c.url, headers: c.headers, type: c.url.includes(".mp4") ? "mp4" : "hls", originalProvider: "embed69" });
      return v;
    })),
    timed2("cr-subs", getCRSubsForAnime(anilistId, parseInt(episode))),
    skip("miruro") ? Promise.resolve({ dub: [], sub: [] }) : timed2("miruro", (isProviderEnabled("miruro") ? getMiruroStreams(anilistId, parseInt(episode)) : Promise.resolve({ dub: [], sub: [] })).then(v => {
      for (const s of [...(v?.dub ?? []), ...(v?.sub ?? [])]) if (s?.url) pw({ url: s.url, headers: s.headers, type: "hls", originalProvider: `miruro-${s.provider}` });
      return v;
    })),
    skip("anikoto") ? Promise.resolve({ sub: [], dub: [], hsub: [] }) : timed2("anikoto", (isProviderEnabled("anikoto") ? getAnikotoStreams(anilistId, parseInt(episode)) : Promise.resolve({ sub: [], dub: [], hsub: [] })).then(v => {
      for (const s of [...(v?.sub ?? []), ...(v?.dub ?? []), ...(v?.hsub ?? [])]) {
        if (s?.url && (s.type === "hls" || s.url.includes(".m3u8"))) pw({ url: s.url, headers: { Referer: s.referer }, type: "hls", originalProvider: `anikoto-${s.server}` });
      }
      return v;
    })),
    timed2("aniskip", anilistToMal(anilistId).then(malId => getAnimeSkip(malId, parseInt(episode)))),
    // aniwaves: hardsub EN. NO se prewarmea: sus playlists m3u8 pueden venir
    // ofuscados en decimal ASCII y el verify directo fallaría con "no es un
    // m3u8 válido" — se verifica a través del proxy local en
    // filterPlayableStreams (usa proxy_url).
    skip("aniwaves") ? Promise.resolve({ sub: [] }) : timed2("aniwaves", (isProviderEnabled("aniwaves") ? withScraperTimeout("aniwaves", getAniwavesStreams(anilistId, parseInt(episode))) : Promise.resolve({ sub: [] }))),
    // animeheaven: hardsub EN, mp4 directo — rápido (~1s), sin extractores.
    skip("animeheaven") ? Promise.resolve({ sub: [] }) : timed2("animeheaven", (isProviderEnabled("animeheaven") ? withScraperTimeout("animeheaven", getAnimeheavenStreams(anilistId, parseInt(episode))) : Promise.resolve({ sub: [] }))),
  ]);
  lap("allSettled done");

  // Resumen consolidado: qué devolvió cada provider (o por qué falló).
  // Sin esto, un provider caído solo se nota por ausencia de streams.
  const providerSummary = [
    ["animeav1",   latinoResult,    v => `${v?.streams?.length ?? 0} streams`],
    ["megaplay",   megaplayResult,  v => `dub=${!!v?.dub} sub=${!!v?.sub}`],
    ["megavid",    megavidResult,   v => (v?.url ? "ok" : "null")],
    ["cuevana",    cuevanaResult,   v => `${v?.length ?? 0} streams`],
    ["cr-subs",    crSubsResult,    v => `${v?.length ?? 0} tracks`],
    ["miruro",     miruroResult,    v => `dub=${v?.dub?.length ?? 0} sub=${v?.sub?.length ?? 0}`],
    ["anikoto",    anikotoResult,   v => `sub=${v?.sub?.length ?? 0} dub=${v?.dub?.length ?? 0}`],
    ["aniwaves",   aniwavesResult,  v => `sub=${v?.sub?.length ?? 0}`],
    ["animeheaven", animeheavenResult, v => `sub=${v?.sub?.length ?? 0}`],
    ["aniskip",    aniskipResult,   v => (v ? "ok" : "null")],
  ].map(([name, r, fmt]) =>
    skipProviders.has(name) ? `${name}⊘zenkai` :
    r.status === "fulfilled" ? `${name}✓(${fmt(r.value)})` : `${name}✗(${r.reason?.message ?? "?"})`
  ).join(" ");
  console.log(`  [resolveAnime] providers: ${providerSummary}`);
  // #region debug-point B:resolve-summary
  reportAnimeRouteDebug("B", "src/routes/streams.js:resolveAnimeData:done", "[DEBUG] resolveAnimeData done", { anilistId, episode, ms: Date.now() - t0, providerSummary });
  // #endregion

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
  const aniwaves = aniwavesResult.status === "fulfilled" ? aniwavesResult.value : { sub: [] };
  if (aniwavesResult.status === "rejected") console.warn("[anime] aniwaves ✗:", aniwavesResult.reason?.message);
  const animeheaven = animeheavenResult.status === "fulfilled" ? animeheavenResult.value : { sub: [] };
  if (animeheavenResult.status === "rejected") console.warn("[anime] animeheaven ✗:", animeheavenResult.reason?.message);

  return { megaplayDub: megaplayBoth.dub, megaplaySub: megaplayBoth.sub, megavid, latino, cuevanaStreams, hasDubLatino, crTracks, miruro, anikoto, aniwaves, animeheaven, aniskip };
}

async function getReanimeCached(anilistId, episode, cacheKey) {
  const hit = cacheGet(cacheKey);
  if (hit) {
    // #region debug-point D:reanime-cache-hit
    reportAnimeRouteDebug("D", "src/routes/streams.js:getReanimeCached:hit", "[DEBUG] reanime cache hit", { anilistId, episode, cacheKey });
    // #endregion
    return hit;
  }
  if (!isProviderEnabled("reanime")) return { sub: null, dub: null };
  return coalesce(cacheKey, async () => {
    const secondHit = cacheGet(cacheKey);
    if (secondHit) {
      // #region debug-point D:reanime-cache-hit-after-coalesce
      reportAnimeRouteDebug("D", "src/routes/streams.js:getReanimeCached:hit-after-coalesce", "[DEBUG] reanime cache hit after coalesce", { anilistId, episode, cacheKey });
      // #endregion
      return secondHit;
    }
    try {
      const start = Date.now();
      // #region debug-point D:reanime-cache-miss
      reportAnimeRouteDebug("D", "src/routes/streams.js:getReanimeCached:miss", "[DEBUG] reanime cache miss", { anilistId, episode, cacheKey });
      // #endregion
      const value = await getReanimeStreams(anilistId, episode);
      cacheSet(cacheKey, value, REANIME_STREAM_TTL);
      // #region debug-point D:reanime-cache-store
      reportAnimeRouteDebug("D", "src/routes/streams.js:getReanimeCached:store", "[DEBUG] reanime resolved and cached", { anilistId, episode, cacheKey, ms: Date.now() - start, hasSub: Boolean(value?.sub), hasDub: Boolean(value?.dub) });
      // #endregion
      return value;
    } catch (e) {
      console.warn("[anime] reanime ✗:", e.message);
      return { sub: null, dub: null };
    }
  });
}

const R2_LANG_LABELS = {
  "ESP-LAT": "Español latino",
  "ENG-DUB": "Inglés (doblado)",
  "JAP-SUB": "Japonés (sub por separado)",
  "JAP-ES-HS": "Japonés (sub español quemado)",
  "JAP-EN-HS": "Japonés (sub inglés quemado)",
};

// Streams archivados en R2 (bucket propio, ver scripts/r2-select.js). Van
// primero en el array para quedar como "CPT CDN 1" de su idioma: no dependen
// de que el provider original siga vivo. verifyKey estable por slug — la URL
// firmada rota (exp en la firma) y sin esto el verify cache nunca pegaría.
function buildZenkaiStreams(r2Archived, episodeThumbnails = {}) {
  const out = [];
  const subThumbnailKey = episodeThumbnails.sub?.vttKey ?? episodeThumbnails.dub?.vttKey ?? null;
  const dubThumbnailKey = episodeThumbnails.dub?.vttKey ?? episodeThumbnails.sub?.vttKey ?? null;
  for (const [lang, entry] of Object.entries(r2Archived)) {
    try {
      const signedUrl = buildSignedR2Url(`${entry.slug}/master.m3u8`);
      const thumbnailKey = isDubLikeLang(lang) ? dubThumbnailKey : subThumbnailKey;
      const thumbnailUrl = thumbnailKey ? buildPublicR2Url(thumbnailKey) : null;
      // Mismo formato `skip` que usan los demás providers (ver makeAnimeStream):
      // { intro: [start,end], outro: [start,end] } en segundos.
      const skip = (entry.skipIntro || entry.skipOutro)
        ? { ...(entry.skipIntro && { intro: entry.skipIntro }), ...(entry.skipOutro && { outro: entry.skipOutro }) }
        : null;
      out.push({
        url: signedUrl,
        quality: "auto",
        lang,
        langLabel: R2_LANG_LABELS[lang] || lang,
        type: "hls",
        provider: "zenkai",
        originalProvider: "zenkai",
        sourceProvider: entry.sourceProvider,
        proxy_url: signedUrl,
        verifyKey: `r2:${entry.slug}`,
        ...(skip && { skip }),
        ...(thumbnailUrl && { thumbnailVtt: thumbnailUrl, thumbnailVttProxy: thumbnailUrl }),
      });
    } catch (e) {
      console.warn(`[anime] r2 archive ${lang} sin firmar: ${e.message}`);
    }
  }
  return out;
}

// Langs normalizados que cada provider puede producir (ver normalizeLang).
// Si TODOS los langs de un provider están cubiertos por zenkai verificado,
// el provider no se scrapea. JAP-SUB nunca está archivado → megaplay,
// anikoto y reanime corren siempre.
const PROVIDER_LANGS = {
  animeav1: ["ESP-LAT", "JAP-ES-HS"],
  megaplay: ["ENG-DUB", "JAP-SUB"],
  megavid: ["ENG-DUB"],
  cuevana: ["ESP-LAT"],
  miruro: ["ENG-DUB", "JAP-EN-HS"],
  anikoto: ["ENG-DUB", "JAP-SUB", "JAP-EN-HS"],
  aniwaves: ["JAP-EN-HS"],
  animeheaven: ["JAP-EN-HS"],
  reanime: ["JAP-SUB", "ENG-DUB"],
};

router.get("/anime/:anilistId/:episode", async (req, res) => {
  const { anilistId, episode } = req.params;
  const proxyBase = getProxyBase(req);
  const perf = createAnimePerfLogger(anilistId, episode);

  // v14: invalida bundles viejos tras mejorar el matching de animeav1
  // (temporadas con II / Season 2 / 2nd Season, etc.).
  const cacheKey = `streams:anime:v14:${anilistId}:${episode}`;
  const reanimeCacheKey = `reanime:streams:v11:${anilistId}:${episode}`;
  const respKey = `resp:${cacheKey}:${proxyBase}`;
  const cachedBody = cacheGet(respKey);
  if (cachedBody) return res.type("application/json").send(cachedBody);

  // Zenkai (R2 archive) por lang: los streams archivados que pasan verify
  // cubren su lang — los providers que solo sirven langs cubiertos no se
  // scrapean. JAP-SUB nunca se archiva → sus providers corren siempre.
  // Si un zenkai falla verify, su lang queda descubierto y vuelve a scrapear.
  const r2Archived = getR2Archive(anilistId, episode);
  let episodeThumbnails = getEpisodeThumbnails(anilistId, episode);
  const coveredLangs = new Set();
  if (Object.keys(r2Archived).length) {
    const zenkaiStreams = buildZenkaiStreams(r2Archived, episodeThumbnails);
    if (zenkaiStreams.length) {
      const ok = await filterPlayableStreams(zenkaiStreams, { allowEmpty: true });
      for (const s of ok) coveredLangs.add(s.lang);
    } else {
      console.warn(`[anime] zenkai ${anilistId}/${episode}: archivado pero sin URLs firmadas (falta R2_SEAL_SECRET/R2_WORKER_BASE)`);
    }
  }
  perf.lap("r2 coverage ready", { archivedLangs: Object.keys(r2Archived).length, coveredLangs: coveredLangs.size });
  const skipProviders = new Set(
    Object.entries(PROVIDER_LANGS)
      .filter(([, langs]) => langs.every((l) => coveredLangs.has(l)))
      .map(([name]) => name)
  );
  if (skipProviders.size) {
    console.log(`[anime] zenkai cubre ${[...coveredLangs].join(",")} — skip: ${[...skipProviders].join(",")}`);
  }

  let data = cacheGet(cacheKey);
  let reanimeData = skipProviders.has("reanime") ? null : cacheGet(reanimeCacheKey);
  // #region debug-point A:cache-snapshot
  reportAnimeRouteDebug("A", "src/routes/streams.js:anime-route:cache-snapshot", "[DEBUG] anime route cache snapshot", {
    anilistId,
    episode,
    cacheKey,
    reanimeCacheKey,
    respKey,
    dataCacheHit: Boolean(data),
    reanimeCacheHit: Boolean(reanimeData),
    skipProviders: [...skipProviders],
  });
  // #endregion
  if (data) console.log(`[anime] ${anilistId}/${episode} servido desde cache (providers no corrieron)`);
  if (reanimeData) console.log(`[anime] ${anilistId}/${episode} reanime servido desde cache`);

  if (!data) {
    const dataPromise = coalesce(cacheKey, async () => {
      const hit = cacheGet(cacheKey);
      if (hit) return hit;
      const d = await resolveAnimeData(anilistId, episode, skipProviders);
      const hasAny = d.megaplayDub || d.megaplaySub || d.megavid || d.latino || d.cuevanaStreams?.length || d.anikoto?.sub?.length || d.anikoto?.dub?.length || d.anikoto?.hsub?.length || d.aniwaves?.sub?.length || d.animeheaven?.sub?.length;
      // Scrape parcial (providers salteados por zenkai) NO se persiste: si
      // un zenkai muere, el próximo build lo detecta por verify y re-scrapea
      // los providers de ese lang en vez de servir data incompleta cacheada.
      if (hasAny && !skipProviders.size) cacheSet(cacheKey, d, STREAM_TTL);
      return d;
    });
    const reanimePromise = (!reanimeData && !skipProviders.has("reanime"))
      ? getReanimeCached(anilistId, episode, reanimeCacheKey)
      : Promise.resolve(reanimeData);
    [data, reanimeData] = await Promise.all([dataPromise, reanimePromise]);
    perf.lap("resolveAnimeData done", { fromCache: false });
    if (!skipProviders.has("reanime")) perf.lap("getReanimeCached done", { fromCache: Boolean(reanimeData) });
  } else if (!reanimeData && !skipProviders.has("reanime")) {
    perf.lap("provider data cache hit", { fromCache: true });
    reanimeData = await getReanimeCached(anilistId, episode, reanimeCacheKey);
    cacheSet(reanimeCacheKey, reanimeData, REANIME_STREAM_TTL);
    perf.lap("getReanimeCached done", { fromCache: Boolean(reanimeData) });
  } else {
    perf.lap("provider caches ready", { dataCache: Boolean(data), reanimeCache: Boolean(reanimeData) });
  }

  data.reanime = reanimeData;
  if (reanimeData) {
    syncReanimeThumbnailMetadata(anilistId, episode, reanimeData);
    episodeThumbnails = getEpisodeThumbnails(anilistId, episode);
  }
  const body = await coalesce(respKey, async () => {
    const cachedResp = cacheGet(respKey);
    if (cachedResp) return cachedResp;

    const { megaplayDub, megaplaySub, megavid, latino, cuevanaStreams, crTracks, miruro, anikoto, aniwaves, animeheaven, aniskip, reanime } = data;
    const tracksPromise = buildAnimeTracks(anilistId, episode, proxyBase, megaplayDub, megaplaySub, reanime);
    if (reanimeData) cacheSet(reanimeCacheKey, reanimeData, REANIME_STREAM_TTL);
    if (reanimeData) enqueueReanimeSidecarArchive({ anilistId, episode, reanime: reanimeData, reanimeCacheKey, respKey });

    let streams = [];

    streams.push(...buildZenkaiStreams(r2Archived, episodeThumbnails));

    const downloads = [];

    for (const [item, lang, audioTrack] of [
      [reanime?.sub, "japanese", "jpn"],
      [reanime?.dub, "en-dub", "eng"],
    ]) {
      if (!item?.url) continue;
      const originalProvider = `reanime-${item.server}`;
      const introRange = item.intro ? [item.intro.start, item.intro.end] : (item.introStart != null ? [item.introStart, item.introEnd] : null);
      const outroRange = item.outro ? [item.outro.start, item.outro.end] : (item.outroStart != null ? [item.outroStart, item.outroEnd] : null);
      const skip = (introRange || outroRange) ? { ...(introRange && { intro: introRange }), ...(outroRange && { outro: outroRange }) } : null;
      const s = makeAnimeStream(proxyBase, item.url, "auto", lang, originalProvider, { skip });
      s.proxy_url = `${proxyBase}/flixcloud-m3u8?u=${encodeURIComponent(item.url)}&audio=${audioTrack}${item.manifest_key ? `&k=${encodeURIComponent(item.manifest_key)}` : ""}`;
      if (item.downloadLink) downloads.push({ lang: s.lang, langLabel: s.langLabel, server: `reanime-${item.server}`, url: item.downloadLink });
      if (item.available_fonts && Object.keys(item.available_fonts).length) {
        s.available_fonts = item.available_fonts;
      }
      if (Array.isArray(item.extracted_fonts) && item.extracted_fonts.length) {
        s.extracted_fonts = item.extracted_fonts;
      }
      const r2ThumbnailVtt = item.r2_thumbnail_vtt_key
        ? buildPublicR2Url(item.r2_thumbnail_vtt_key)
        : item.r2_thumbnail_vtt;
      if (r2ThumbnailVtt) {
        s.thumbnailVtt = r2ThumbnailVtt;
        s.thumbnailVttProxy = r2ThumbnailVtt;
      } else if (item.thumbnails_vtt) {
        s.thumbnailVtt = item.thumbnails_vtt;
        s.thumbnailVttProxy = `${proxyBase}/fetch?url=${encodeURIComponent(item.thumbnails_vtt)}&ref=${encodeURIComponent("https://flixcloud.cc/")}&ct=${encodeURIComponent("text/vtt")}`;
      }
      streams.push(s);
    }

    if (megaplayDub) {
      const s = makeAnimeStream(proxyBase, megaplayDub.url, "auto", "en-dub", "megaplay", { skip: Object.keys(megaplayDub.skip).length ? megaplayDub.skip : null });
      s.proxy_url = `${proxyBase}/proxy?url=${encodeURIComponent(megaplayDub.url)}&headers=${encodeURIComponent(JSON.stringify(megaplayDub.headers || {}))}`;
      streams.push(s);
    }

    if (megaplaySub) {
      const s = makeAnimeStream(proxyBase, megaplaySub.url, "auto", "japanese", "megaplay", { skip: Object.keys(megaplaySub.skip).length ? megaplaySub.skip : null });
      s.proxy_url = `${proxyBase}/proxy?url=${encodeURIComponent(megaplaySub.url)}&headers=${encodeURIComponent(JSON.stringify(megaplaySub.headers || {}))}`;
      streams.push(s);
    }

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

    for (const [list, type] of [[latino?.downloads?.dub ?? [], "dub"], [latino?.downloads?.sub ?? [], "sub"]]) {
      if (!list.length) continue;
      const { lang, langLabel } = normalizeLang(type === "dub" ? "es-lat" : "japanese", "animeav1");
      for (const { server, url } of list) downloads.push({ lang, langLabel, server, url });
    }

    if (latino) {
      for (const { url, type, server, provider: streamProvider, cfUrl, thumbnailVtt, thumbnailJpg } of latino.streams) {
        const lang = type === "dub" ? "es-lat" : "ja-sub-lat";
        const originalProvider = streamProvider ?? (server > 1 ? `animeav1-s${server}` : "animeav1");
        const s = makeAnimeStream(proxyBase, url, "auto", lang, originalProvider);
        if (streamProvider === "upnshare") {
          s.proxy_url = `${proxyBase}/upn-stream.m3u8?u=${encodeURIComponent(cfUrl)}`;
        } else if (streamProvider === "voe") {
          s.proxy_url = `${proxyBase}/generic-stream.m3u8?u=${encodeURIComponent(url)}`;
        } else if (streamProvider === "mp4upload") {
          s.proxy_url = `${proxyBase}/mp4-proxy?url=${encodeURIComponent(url)}&headers=${encodeURIComponent(JSON.stringify({ Referer: "https://mp4upload.com/" }))}`;
        } else if (url) {
          s.proxy_url = `${proxyBase}/upn-stream.m3u8?u=${encodeURIComponent(url)}`;
        }
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

    const MIRURO_HIDDEN_PROVIDERS = new Set(["bee", "ally"]);
    for (const [miruroList, lang] of [
      [miruro?.dub ?? [], "en-dub"],
      [miruro?.sub ?? [], "japanese"],
    ]) {
      for (const miruroStream of miruroList) {
        if (!miruroStream?.url) continue;
        const originalProvider = `miruro-${miruroStream.provider}`;

        if (miruroStream.download) {
          const { lang: dlLang, langLabel: dlLangLabel } = normalizeLang(lang, originalProvider);
          downloads.push({ lang: dlLang, langLabel: dlLangLabel, server: miruroStream.provider, url: miruroStream.download });
        }

        if (MIRURO_HIDDEN_PROVIDERS.has(miruroStream.provider)) continue;
        const s = makeAnimeStream(proxyBase, miruroStream.url, "auto", lang, originalProvider, {
          skip: miruroStream.skip && (miruroStream.skip.intro || miruroStream.skip.outro) ? miruroStream.skip : null,
          headers: Object.keys(miruroStream.headers ?? {}).length ? miruroStream.headers : null,
        });
        const miruroRef = miruroStream.headers?.Referer || "https://strm.cx/";
        s.proxy_url = `${proxyBase}/generic-stream.m3u8?u=${encodeURIComponent(miruroStream.url)}&ref=${encodeURIComponent(miruroRef)}`;
        streams.push(s);
      }
    }

    for (const [list, providerName] of [
      [aniwaves?.sub ?? [], "aniwaves"],
      [animeheaven?.sub ?? [], "animeheaven"],
    ]) {
      for (const src of list) {
        const originalProvider = `${providerName}-hsub-${src.server}`;
        const s = makeAnimeStream(proxyBase, src.url, "auto", "japanese", originalProvider, {
          headers: src.referer ? { Referer: src.referer, Origin: src.referer.replace(/\/$/, ""), "User-Agent": HEADERS["User-Agent"] } : null,
          skip: src.skip ?? null,
        });
        s.proxy_url = src.type === "mp4"
          ? `${proxyBase}/mp4-proxy?url=${encodeURIComponent(src.url)}&headers=${encodeURIComponent(JSON.stringify(src.referer ? { Referer: src.referer } : {}))}`
          : `${proxyBase}/generic-stream.m3u8?u=${encodeURIComponent(src.url)}${src.referer ? `&ref=${encodeURIComponent(src.referer)}` : ""}`;
        streams.push(s);
      }
    }

    for (const c of (cuevanaStreams ?? [])) streams.push(makeCuevanaStream(c, proxyBase));

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

    const seenUrls = new Set();
    streams = streams.filter((s) => { const key = s.proxy_url || s.url; if (seenUrls.has(key)) return false; seenUrls.add(key); return true; });

    if (coveredLangs.size) {
      streams = streams.filter((s) => s.originalProvider === "zenkai" || !coveredLangs.has(s.lang));
    }

    if (streams.length === 0) throw Object.assign(new Error("No streams found for this episode"), { status: 404 });

    autoArchiveMissingLangs(anilistId, episode, streams, r2Archived, proxyBase);

    const isDubLang = (lang) => isDubLikeLang(lang);
    const megaplayDubSkip = megaplayDub && Object.keys(megaplayDub.skip || {}).length ? megaplayDub.skip : null;
    const megaplaySubSkip = megaplaySub && Object.keys(megaplaySub.skip || {}).length ? megaplaySub.skip : null;
    const reanimeSkipOf = (item) => {
      if (!item) return null;
      const intro = item.intro ? [item.intro.start, item.intro.end] : (item.introStart != null ? [item.introStart, item.introEnd] : null);
      const outro = item.outro ? [item.outro.start, item.outro.end] : (item.outroStart != null ? [item.outroStart, item.outroEnd] : null);
      return (intro || outro) ? { ...(intro && { intro }), ...(outro && { outro }) } : null;
    };
    const reanimeDubSkip = reanimeSkipOf(reanime?.dub);
    const reanimeSubSkip = reanimeSkipOf(reanime?.sub);
    for (const s of streams) {
      const isReanime = String(s.originalProvider || "").startsWith("reanime");
      if (isReanime && s.skip) continue;
      const preferred = isDubLang(s.lang) ? (megaplayDubSkip ?? reanimeDubSkip) : (megaplaySubSkip ?? reanimeSubSkip);
      if (preferred) s.skip = preferred;
      else if (!s.skip && aniskip) s.skip = aniskip;
    }

    const sorted = sortStreams(streams);
    const grouped = [...sorted.filter(s => isDubLang(s.lang)), ...sorted.filter(s => !isDubLang(s.lang))];
    const playable = await filterPlayableStreams(grouped);
    perf.lap("filterPlayableStreams done", { inCount: grouped.length, outCount: playable.length });
    const withDisplay = assignDisplayProviders(playable);
    perf.lap("assignDisplayProviders done", { count: withDisplay.length });
    const tracks = await tracksPromise;
    perf.lap("buildAnimeTracks done", { trackCount: tracks?.length ?? 0 });
    const builtBody = JSON.stringify(sealProxyUrls({ anilistId, episode: parseInt(episode), streams: withDisplay, tracks, downloads }, proxyBase));
    perf.lap("seal+stringify done", { bytes: builtBody.length, downloads: downloads.length });
    cacheSet(respKey, builtBody, RESP_TTL);
    perf.lap("resp cache stored");
    return builtBody;
  });
  res.type("application/json").send(body);
  perf.lap("response sent");
});

export default router;
