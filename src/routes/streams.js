import { Router } from "express";
import crypto from "node:crypto";
import fs from "fs";
import { STREAM_TTL, REANIME_STREAM_TTL, isProviderEnabled, HEADERS } from "../config/constants.js";
import { cacheGet, cacheSet, cacheDelete, timed, getR2Archive, getManualTracks, getEpisodeThumbnails, upsertEpisodeThumbnail } from "../lib/cache.js";
import { buildPublicR2Url, buildSignedR2Url } from "../lib/r2-seal.js";
import { enqueueArchiveJob, isQueuedOrArchiving } from "../lib/r2-queue.js";
import { isR2Configured } from "../lib/hls-to-r2.js";
import { archiveSubtitleTracksToR2, archiveThumbnailVttToR2 } from "../lib/reanime-r2.js";
import { getProxyBase } from "../lib/proxy.js";
import { buildTracks, readVdrkIndex, writeVdrkIndex, vdrkKey, getVidrkSubsWithIndex, normalizeSubLabel, detectTrackLang, normalizeSubtitleTracks } from "../lib/subtitles.js";
import { sealProxyUrls, sealedQueryParam, sealedQueryParamDeterministic, sealQueryPayload, maskRawUrl, unmaskRawUrl } from "../lib/proxy-seal.js";
import { filterPlayableStreams, prewarmVerify } from "../lib/stream-verify.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import {
  makeCuevanaStream,
  makeVidsrcStream,
  makeGenericStream,
  makeVixsrcStream,
  makeAnimeStream,
  sortStreams,
  filterBrokenProviderLangCombos,
  normalizeProxyStreamTypes,
  assignDisplayProviders,
  publicDownloadServer,
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
} from "../providers/index.js";

const router = Router();

// ── Encryption helpers ────────────────────────────────────────────────────────
function parseBoolEnv(rawValue, fallback) {
  const v = String(rawValue ?? "").trim().toLowerCase();
  if (!v) return fallback;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

const PLAYER_STREAM_ENCRYPTION_ENABLED = parseBoolEnv(
  process.env.PLAYER_STREAM_ENCRYPTION_ENABLED,
  process.env.NODE_ENV === "production"
);

const STREAM_ENVELOPE_ALG = "AES-GCM";
const STREAM_ENVELOPE_CIPHER = "aes-256-gcm";
const STREAM_ENVELOPE_IV_LEN = 12;
const STREAM_ENVELOPE_DEK_LEN = 32;
const STREAM_ENVELOPE_TAG_LEN = 16;

function bufferToBase64url(buf) {
  if (Buffer.isBuffer(buf)) return buf.toString("base64url");
  return Buffer.from(buf).toString("base64url");
}

function createRandomStreamDek() {
  return crypto.randomBytes(STREAM_ENVELOPE_DEK_LEN);
}

function encryptJsonEnvelope(payload, sessionExp = 0) {
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const iv = crypto.randomBytes(STREAM_ENVELOPE_IV_LEN);
  const dek = createRandomStreamDek();
  const cipher = crypto.createCipheriv(STREAM_ENVELOPE_CIPHER, dek, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const data = Buffer.concat([ciphertext, tag]);
  const envelope = {
    encrypted: true,
    alg: STREAM_ENVELOPE_ALG,
    iv: bufferToBase64url(iv),
    data: bufferToBase64url(data),
    key: bufferToBase64url(dek),
  };
  if (Number(sessionExp) > 0) envelope.exp = Number(sessionExp);
  return envelope;
}

function setSensitiveResponseHeaders(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
}

// ── Rate limit más estricto para streams endpoints ────────────────────────────
function getStreamsAuthKey(req) {
  const raw = (req.headers["x-api-key"] ?? req.query?.key ?? "unknown-key");
  return crypto.createHash("sha256").update(String(raw)).digest("hex").slice(0, 24);
}

const limitStreamsByIp = createRateLimiter({
  windowMs: 60_000,
  max: 60,
  message: "Too many stream requests (ip)",
});

const limitStreamsByAuth = createRateLimiter({
  windowMs: 60_000,
  max: 150,
  message: "Too many stream requests (key)",
  keyGenerator: (req) => `streams-auth:${getStreamsAuthKey(req)}`,
});

router.use((req, res, next) => {
  limitStreamsByIp(req, res, (errA) => {
    if (errA) return next(errA);
    if (res.headersSent) return;
    limitStreamsByAuth(req, res, next);
  });
});

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
    t0: start,
    lap(label, extra = null) {
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
  const ref = track.referer || "https://flixcloud.cc/";
  const s = sealedQueryParam({ url: track.url, ref, ct });
  const proxyUrl = `${proxyBase}/fetch?${s}`;
  const { sourceUrl: _sourceUrl, r2Key: _r2Key, referer: _referer, url: _url, ...rest } = track;
  return { ...rest, url: proxyUrl };
}

function buildStableSubtitleUrl(proxyBase, file) {
  return `${proxyBase}/subs/${file}`;
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
  "ENG-DUB": ["megaplay", "anikoto", "megavid", "miruro"],
  "JAP-ES-HS": ["animeav1"],
  "JAP-EN-HS": ["anikoto-hsub", "aniwaves", "animeheaven", "miruro"],
};

const REANIME_MULTI_AUDIO_TRACKS = [
  { id: "ja", lang: "ja", code: "JAP-SUB", label: "Japonés", original: true, default: true },
  { id: "en", lang: "en", code: "ENG-DUB", label: "Inglés", dub: true },
];

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

function multiArchiveCoversLang(r2Archived, lang) {
  const tracks = r2Archived?.MULTI?.audioTracks;
  if (!Array.isArray(tracks) || !tracks.length) return false;
  return tracks.some((track) => {
    const code = String(track?.code || "").toUpperCase();
    const rawLang = String(track?.lang || track?.id || "").toLowerCase();
    if (code === lang) return true;
    if (lang === "ENG-DUB") return rawLang === "en" || rawLang === "en-us";
    if (lang === "ESP-LAT") return rawLang === "es" || rawLang === "es-mx" || rawLang === "es-419";
    return false;
  });
}

function archiveLangAlreadyCovered(r2Archived, lang) {
  if (r2Archived?.[lang]) return true;
  if (lang === "ENG-DUB" || lang === "ESP-LAT") {
    return multiArchiveCoversLang(r2Archived, lang);
  }
  return false;
}

function reanimeMultiSource(reanime) {
  if (!reanime?.dub?.url) return null;
  return reanime.dub;
}

function reanimeSkipOf(item) {
  if (!item) return null;
  const introRange = item.intro ? [item.intro.start, item.intro.end] : (item.introStart != null ? [item.introStart, item.introEnd] : null);
  const outroRange = item.outro ? [item.outro.start, item.outro.end] : (item.outroStart != null ? [item.outroStart, item.outroEnd] : null);
  return (introRange || outroRange) ? { ...(introRange && { intro: introRange }), ...(outroRange && { outro: outroRange }) } : null;
}

function buildReanimeRiverProxyUrl(proxyBase, item, { multi = false, audio = null } = {}) {
  const flixPayload = { u: item.url };
  if (!multi && audio) flixPayload.audio = audio;
  if (item.manifest_key) flixPayload.k = item.manifest_key;
  return `${proxyBase}/river.m3u8?${sealedQueryParam(flixPayload)}`;
}

// Encola a R2 los idiomas que todavía no están archivados. proxy_url apunta
// al dominio público (proxyBase); para el fetch interno del archivador se usa
// loopback directo, evitando un salto de ida y vuelta por internet.
function autoArchiveMissingLangs(anilistId, episode, streams, r2Archived, proxyBase) {
  // Sin credenciales R2 (ej. .env comentado en dev local) no encolar nada:
  // archiveHlsToR2 fallaría en assertR2Env por cada candidato y solo
  // ensuciaría el log.
  if (!isR2Configured()) return;
  const internalBase = `http://127.0.0.1:${process.env.PORT || 1337}`;
  let multiQueuedOrCovered = multiArchiveCoversLang(r2Archived, "ENG-DUB");
  if (!r2Archived.MULTI && !isQueuedOrArchiving(anilistId, episode, "MULTI")) {
    const multiCandidates = pickArchiveCandidates(streams, "MULTI", ["reanime"]);
    if (multiCandidates.length) {
      const jobCandidates = multiCandidates.map((c) => ({
        streamUrl: c.proxy_url.startsWith(proxyBase)
          ? internalBase + c.proxy_url.slice(proxyBase.length)
          : c.proxy_url,
        sourceProvider: c.originalProvider,
      }));
      enqueueArchiveJob({
        animeId: anilistId,
        episode,
        lang: "MULTI",
        candidates: jobCandidates,
        tracks: { audioTracks: REANIME_MULTI_AUDIO_TRACKS },
      });
      multiQueuedOrCovered = true;
    }
  }
  for (const [lang, priorityList] of Object.entries(R2_AUTO_ARCHIVE_PRIORITY)) {
    if (lang === "ENG-DUB" && multiQueuedOrCovered) continue;
    if (archiveLangAlreadyCovered(r2Archived, lang)) continue;
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
  const built = await buildTracks(vidrkSubs, proxyBase);
  return normalizeSubtitleTracks(built || []);
}

async function buildAnimeTracks(anilistId, episode, proxyBase, megaplayDub, megaplaySub, reanime) {
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

  // Tracks manuales: subs subidos a R2 (subs/{file}) desde el downloader
  // y registrados en manual_tracks. No disparamos scraper-crunchyroll.js.
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

  const rawTracks = [...processedMegaplay, ...manualTracks, ...processedReanime];
  return normalizeSubtitleTracks(rawTracks);
}

// ── Movie endpoint ────────────────────────────────────────────────────────────
router.get("/movie/:tmdbId", async (req, res) => {
  const { tmdbId } = req.params;
  try {
    const cacheKey = `streams:movie:${tmdbId}`;
    const proxyBase = getProxyBase(req);
    const respKey = `resp:${cacheKey}:${proxyBase}`;
    setSensitiveResponseHeaders(res);

    if (!PLAYER_STREAM_ENCRYPTION_ENABLED) {
      const cachedBody = cacheGet(respKey);
      if (cachedBody) return res.type("application/json").send(cachedBody);
    }

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
    const normalized = normalizeProxyStreamTypes(streams);
    const filtered = filterBrokenProviderLangCombos(normalized, { context: `movie/${tmdbId}` });
    const sorted = sortStreams(filtered);
    const withDisplay = assignDisplayProviders(sorted);
    const sealed = sealProxyUrls({ streams: withDisplay, tracks, meta: tmdbMeta ? { title: tmdbMeta.title, year: tmdbMeta.year, originalLang } : null }, proxyBase);

    if (!PLAYER_STREAM_ENCRYPTION_ENABLED) {
      const body = JSON.stringify(sealed);
      cacheSet(respKey, body, RESP_TTL);
      return res.type("application/json").send(body);
    }

    const envelope = encryptJsonEnvelope(sealed);
    res.type("application/json").send(JSON.stringify(envelope));
  } catch (err) { handleError(res, err); }
});

// ── TV endpoint ─────────────────────────────────────────────────────────────────
router.get("/tv/:tmdbId/:season/:episode", async (req, res) => {
  const { tmdbId, season, episode } = req.params;
  try {
    const cacheKey = `streams:tv:${tmdbId}:${season}:${episode}`;
    const proxyBase = getProxyBase(req);
    const respKey = `resp:${cacheKey}:${proxyBase}`;
    setSensitiveResponseHeaders(res);

    if (!PLAYER_STREAM_ENCRYPTION_ENABLED) {
      const cachedBody = cacheGet(respKey);
      if (cachedBody) return res.type("application/json").send(cachedBody);
    }

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

    const normalized = normalizeProxyStreamTypes(streams);
    const filtered = filterBrokenProviderLangCombos(normalized, { context: `tv/${tmdbId}/${season}/${episode}` });
    const sorted = sortStreams(filtered);
    const withDisplay = assignDisplayProviders(sorted);
    const sealed = sealProxyUrls({ streams: withDisplay, tracks, skip: skip || null, meta: tmdbMeta ? { title: tmdbMeta.title, year: tmdbMeta.year, originalLang } : null }, proxyBase);

    if (!PLAYER_STREAM_ENCRYPTION_ENABLED) {
      const body = JSON.stringify(sealed);
      cacheSet(respKey, body, RESP_TTL);
      return res.type("application/json").send(body);
    }

    const envelope = encryptJsonEnvelope(sealed);
    res.type("application/json").send(JSON.stringify(envelope));
  } catch (err) { handleError(res, err); }
});

// ── Anime endpoint ─────────────────────────────────────────────────────────────
async function resolveAnimeData(anilistId, episode, skipProviders = new Set(), opts = {}) {
  const t0 = Date.now();
  const lap = (label) => console.log(`  [resolveAnime ${anilistId}/${episode}] ${label}: ${Date.now() - t0}ms`);
  // #region debug-point B:resolve-start
  reportAnimeRouteDebug("B", "src/routes/streams.js:resolveAnimeData:start", "[DEBUG] resolveAnimeData start", { anilistId, episode, skipProviders: [...skipProviders] });
  // #endregion

  const { cacheKey = null, globalStartTs = 0, globalBudgetMs = 0 } = opts;
  let budgetMs = opts.budgetMs ?? 3_000;
  if (globalStartTs && globalBudgetMs) {
    const elapsed = Date.now() - globalStartTs;
    const remain = globalBudgetMs - elapsed;
    budgetMs = Math.max(500, remain);
    console.log(`  [resolveAnime] global budget: total=${globalBudgetMs}ms elapsed=${elapsed}ms → effective resolve budget=${budgetMs}ms`);
  }

  const timed2 = (name, promise) => {
    const ts = Date.now();
    return promise.then(
      v => { console.log(`  [resolveAnime] ${name} OK: ${Date.now() - ts}ms`); return v; },
      e => { console.warn(`  [resolveAnime] ${name} ✗ (${Date.now() - ts}ms):`, e.message); throw e; }
    );
  };

  const HARDSUB_TIMEOUT = 6_000;
  const SCRAPER_TIMEOUT_FAST = 1_800;   // megaplay/megavid/cuevana/aniskip
  const SCRAPER_TIMEOUT_MED = 8_000;    // animeav1 (búsqueda + servers)
  const withTimeout = (name, ms, promise) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${name} timeout ${ms}ms`)), ms)),
  ]);

  const vk = (u) => `vk:${crypto.createHash("sha1").update(String(u)).digest("hex").slice(0,24)}`;
  const pw = (s) => { try { if (!s?.url) return; prewarmVerify({ ...s, verifyKey: vk(s.url) }); } catch { /* nunca romper el flujo */ } };

  const skip = (name) => skipProviders.has(name);

  const providerDefs = [
    ["animeav1",    () => skip("animeav1") ? Promise.resolve(null) : timed2("animeav1", withTimeout("animeav1", SCRAPER_TIMEOUT_MED, getLatinoStream(anilistId, episode).then(v => {
      for (const s of v?.streams ?? []) {
        const isMp4u = s.provider === "mp4upload";
        pw({
          url: s.cfUrl ?? s.url,
          headers: isMp4u ? { Referer: "https://mp4upload.com/" } : undefined,
          type: isMp4u ? "mp4" : "hls",
          originalProvider: s.provider ?? "animeav1",
        });
      }
      return v;
    })))],
    ["megaplay",    () => skip("megaplay") ? Promise.resolve({ dub: null, sub: null }) : timed2("megaplay", withTimeout("megaplay", SCRAPER_TIMEOUT_FAST, getMegaplayStreams(anilistId, parseInt(episode)).then(v => {
      for (const it of [v?.dub, v?.sub]) if (it?.url) pw({ url: it.url, headers: it.headers, type: "hls", originalProvider: "megaplay" });
      return v;
    })))],
    ["megavid",     () => skip("megavid") ? Promise.resolve(null) : timed2("megavid", withTimeout("megavid", SCRAPER_TIMEOUT_FAST, (isProviderEnabled("megavid") ? getMegavidStream(anilistId, parseInt(episode)).then(v => {
      if (v?.url) pw({ url: v.url, headers: { Referer: "https://megavid.buzz/" }, type: "hls", originalProvider: "megavid" });
      return v;
    }) : Promise.resolve(null))))],
    ["cuevana",     () => skip("cuevana") ? Promise.resolve([]) : timed2("cuevana", withTimeout("cuevana", SCRAPER_TIMEOUT_FAST, getCuevanaAnime(anilistId, parseInt(episode)).then(v => {
      for (const c of v ?? []) if (c?.url) pw({ url: c.url, headers: c.headers, type: c.url.includes(".mp4") ? "mp4" : "hls", originalProvider: "embed69" });
      return v;
    })))],
    ["miruro",      () => skip("miruro") ? Promise.resolve({ dub: [], sub: [] }) : timed2("miruro", withTimeout("miruro", SCRAPER_TIMEOUT_MED, (isProviderEnabled("miruro") ? getMiruroStreams(anilistId, parseInt(episode)) : Promise.resolve({ dub: [], sub: [] })).then(v => {
      for (const s of [...(v?.dub ?? []), ...(v?.sub ?? [])]) if (s?.url) pw({ url: s.url, headers: s.headers, type: "hls", originalProvider: `miruro-${s.provider}` });
      return v;
    })))],
    ["anikoto",     () => skip("anikoto") ? Promise.resolve({ sub: [], dub: [], hsub: [] }) : timed2("anikoto", withTimeout("anikoto", SCRAPER_TIMEOUT_FAST, (isProviderEnabled("anikoto") ? getAnikotoStreams(anilistId, parseInt(episode)) : Promise.resolve({ sub: [], dub: [], hsub: [] })).then(v => {
      for (const s of [...(v?.sub ?? []), ...(v?.dub ?? []), ...(v?.hsub ?? [])]) {
        if (s?.url && (s.type === "hls" || s.url.includes(".m3u8"))) pw({ url: s.url, headers: { Referer: s.referer }, type: "hls", originalProvider: `anikoto-${s.server}` });
      }
      return v;
    })))],
    ["aniskip",     () => timed2("aniskip", withTimeout("aniskip", SCRAPER_TIMEOUT_FAST, anilistToMal(anilistId).then(malId => getAnimeSkip(malId, parseInt(episode)))))],
    ["aniwaves",    () => skip("aniwaves") ? Promise.resolve({ sub: [] }) : timed2("aniwaves", (isProviderEnabled("aniwaves") ? withTimeout("aniwaves", HARDSUB_TIMEOUT, getAniwavesStreams(anilistId, parseInt(episode))) : Promise.resolve({ sub: [] })))],
    ["animeheaven", () => skip("animeheaven") ? Promise.resolve({ sub: [] }) : timed2("animeheaven", (isProviderEnabled("animeheaven") ? withTimeout("animeheaven", HARDSUB_TIMEOUT, getAnimeheavenStreams(anilistId, parseInt(episode))) : Promise.resolve({ sub: [] })))],
  ];

  // ── Hybrid budget: RACE providers all-settled × budgetMs ──────────────
  // Si todos terminan antes de budgetMs = data FULL. Si budgetMs vence,
  // liberamos la response con lo que ya llegó y los providers lentos
  // (aniwaves, animeheaven, mp4upload slow) siguen en background
  // actualizando el cacheSet para el próximo hit.
  const settled = new Map(); // name → {status, value?, reason?}
  const pendingNames = new Set();
  const wrapped = providerDefs.map(([name, fn]) => {
    pendingNames.add(name);
    const p = Promise.resolve().then(fn);
    return p.then(
      value => { const rec = { status: "fulfilled", value }; settled.set(name, rec); pendingNames.delete(name); return { name, ...rec }; },
      reason => { const rec = { status: "rejected", reason }; settled.set(name, rec); pendingNames.delete(name); return { name, ...rec }; }
    );
  });
  const allSettledPromise = Promise.all(wrapped);
  const budgetPromise = new Promise(res => setTimeout(() => res({ tag: "hot" }), budgetMs));
  const race = await Promise.race([
    allSettledPromise.then(arr => ({ tag: "full", arr })),
    budgetPromise,
  ]);

  let mode;
  if (race.tag === "full") {
    mode = "FULL";
    lap("allSettled done");
  } else {
    mode = `HOT-only (budget ${budgetMs}ms, pending=[${[...pendingNames].join(",")}] seguirán en bg)`;
    lap(`allSettled hybrid HOT (pending=[${[...pendingNames].join(",")}]) budget=${budgetMs}ms`);
    // ── Background update: cuando allSettled termine, cacheSet full para prox hit
    if (cacheKey) {
      (async () => {
        try { await allSettledPromise; } catch { /* ignore */ }
        const fullData = buildResolveResult(settled, anilistId, episode, skipProviders);
        const hasAny = fullData.megaplayDub || fullData.megaplaySub || fullData.megavid || fullData.latino || fullData.cuevanaStreams?.length || fullData.anikoto?.sub?.length || fullData.anikoto?.dub?.length || fullData.anikoto?.hsub?.length || fullData.aniwaves?.sub?.length || fullData.animeheaven?.sub?.length;
        if (hasAny) {
          const t0c = Date.now();
          cacheSet(cacheKey, fullData, STREAM_TTL);
          console.log(`[cache:perf] streams BG cacheSet FULL (${cacheKey}): +${Date.now()-t0c}ms — (aniwaves/animeheaven finalizados)`);
        }
      })();
    } else {
      // No hay cacheKey: igual esperamos un rato más en bg para no perder
      // logs, pero no cacheamos.
      allSettledPromise.catch(() => {});
    }
  }

  const data = buildResolveResult(settled, anilistId, episode, skipProviders, mode);
  return data;
}

function buildResolveResult(settled, anilistId, episode, skipProviders, mode = "") {
  const t0 = Date.now();
  const lap = (label) => console.log(`  [resolveAnime ${anilistId}/${episode}] ${label}: ${Date.now() - t0}ms`);

  const read = (name, fallback) => {
    const r = settled.get(name);
    if (!r) return fallback;
    if (r.status === "fulfilled") return r.value ?? fallback;
    return fallback;
  };
  const reasonOf = (name) => settled.get(name)?.status === "rejected" ? settled.get(name).reason : null;

  // Resumen consolidado
  const providerSummary = [
    ["animeav1",   read("animeav1", null),    v => `${v?.streams?.length ?? 0} streams`],
    ["megaplay",   read("megaplay", { dub: null, sub: null }),  v => `dub=${!!v?.dub} sub=${!!v?.sub}`],
    ["megavid",    read("megavid", null),   v => (v?.url ? "ok" : "null")],
    ["cuevana",    read("cuevana", []),   v => `${v?.length ?? 0} streams`],
    ["miruro",     read("miruro", { dub: [], sub: [] }),    v => `dub=${v?.dub?.length ?? 0} sub=${v?.sub?.length ?? 0}`],
    ["anikoto",    read("anikoto", { sub: [], dub: [], hsub: [] }),   v => `sub=${v?.sub?.length ?? 0} dub=${v?.dub?.length ?? 0}`],
    ["aniwaves",   read("aniwaves", { sub: [] }),  v => `sub=${v?.sub?.length ?? 0}`],
    ["animeheaven", read("animeheaven", { sub: [] }), v => `sub=${v?.sub?.length ?? 0}`],
    ["aniskip",    read("aniskip", null),   v => (v ? "ok" : "null")],
  ].map(([name, value, fmt]) => {
    if (skipProviders.has(name)) return `${name}⊘zenkai`;
    const reason = reasonOf(name);
    if (reason) return `${name}✗(${reason.message ?? "?"})`;
    return `${name}✓(${fmt(value)})`;
  }).join(" ");
  console.log(`  [resolveAnime] providers: ${providerSummary}` + (mode ? ` [mode=${mode}]` : ""));
  lap("summary+unpack start");
  reportAnimeRouteDebug("B", "src/routes/streams.js:resolveAnimeData:done", "[DEBUG] resolveAnimeData done", { anilistId, episode, ms: Date.now() - t0, providerSummary, mode });

  const aniskipVal = read("aniskip", null);
  if (reasonOf("aniskip")) console.warn("[anime] aniskip ✗:", reasonOf("aniskip")?.message);

  const latino = read("animeav1", null);
  const hasDubLatino = latino?.streams.some(s => s.type === "dub") ?? false;
  const cuevanaStreams = read("cuevana", []);
  if (reasonOf("cuevana")) console.warn(`[anime] embed69 ✗:`, reasonOf("cuevana")?.message);

  const megaplayBoth = read("megaplay", { dub: null, sub: null });
  const miruro = read("miruro", { dub: null, sub: null });
  if (reasonOf("miruro")) console.warn("[anime] miruro ✗:", reasonOf("miruro")?.message);
  const anikoto = read("anikoto", { sub: [], dub: [] });
  if (reasonOf("anikoto")) console.warn("[anime] anikoto ✗:", reasonOf("anikoto")?.message);
  const megavid = read("megavid", null);
  if (reasonOf("megavid")) console.warn("[anime] megavid ✗:", reasonOf("megavid")?.message);
  const aniwaves = read("aniwaves", { sub: [] });
  if (reasonOf("aniwaves")) console.warn("[anime] aniwaves ✗:", reasonOf("aniwaves")?.message);
  const animeheaven = read("animeheaven", { sub: [] });
  if (reasonOf("animeheaven")) console.warn("[anime] animeheaven ✗:", reasonOf("animeheaven")?.message);

  lap("summary+unpack done");
  return { megaplayDub: megaplayBoth.dub, megaplaySub: megaplayBoth.sub, megavid, latino, cuevanaStreams, hasDubLatino, miruro, anikoto, aniwaves, animeheaven, aniskip: aniskipVal };
}

async function getReanimeCached(anilistId, episode, cacheKey) {
  const t0 = Date.now();
  const rlap = (s) => console.log(`  [reanime:perf ${anilistId}/${episode}] ${s}: +${Date.now()-t0}ms`);
  const hit = cacheGet(cacheKey);
  if (hit) {
    // #region debug-point D:reanime-cache-hit
    reportAnimeRouteDebug("D", "src/routes/streams.js:getReanimeCached:hit", "[DEBUG] reanime cache hit", { anilistId, episode, cacheKey });
    // #endregion
    rlap("cache hit");
    return hit;
  }
  if (!isProviderEnabled("reanime")) { rlap("disabled"); return { sub: null, dub: null }; }
  return coalesce(cacheKey, async () => {
    const secondHit = cacheGet(cacheKey);
    if (secondHit) {
      // #region debug-point D:reanime-cache-hit-after-coalesce
      reportAnimeRouteDebug("D", "src/routes/streams.js:getReanimeCached:hit-after-coalesce", "[DEBUG] reanime cache hit after coalesce", { anilistId, episode, cacheKey });
      // #endregion
      rlap("cache hit (after coalesce)");
      return secondHit;
    }
    try {
      const start = Date.now();
      // #region debug-point D:reanime-cache-miss
      reportAnimeRouteDebug("D", "src/routes/streams.js:getReanimeCached:miss", "[DEBUG] reanime cache miss", { anilistId, episode, cacheKey });
      // #endregion
      rlap("getReanimeStreams start");
      const value = await getReanimeStreams(anilistId, episode);
      rlap(`getReanimeStreams done sub=${value?.sub?.items?.length??'n'} dub=${value?.dub?.items?.length??'n'}`);
      cacheSet(cacheKey, value, REANIME_STREAM_TTL);
      // #region debug-point D:reanime-cache-store
      reportAnimeRouteDebug("D", "src/routes/streams.js:getReanimeCached:store", "[DEBUG] reanime resolved and cached", { anilistId, episode, cacheKey, ms: Date.now() - start, hasSub: Boolean(value?.sub), hasDub: Boolean(value?.dub) });
      // #endregion
      rlap("stored ok");
      return value;
    } catch (e) {
      rlap(`FAIL: ${e.message}`);
      console.warn("[anime] reanime ✗:", e.message);
      return { sub: null, dub: null };
    }
  });
}

const R2_LANG_LABELS = {
  "MULTI": "Multi audio",
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
      const isMulti = lang === "MULTI";
      const thumbnailKey = isMulti ? (subThumbnailKey || dubThumbnailKey) : (isDubLikeLang(lang) ? dubThumbnailKey : subThumbnailKey);
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
        ...(isMulti && { multiAudio: true }),
        ...(isMulti && Array.isArray(entry.audioTracks) && entry.audioTracks.length && { audioTracks: entry.audioTracks }),
        ...(isMulti && Array.isArray(entry.subtitleTracks) && entry.subtitleTracks.length && { subtitleTracks: entry.subtitleTracks }),
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

      // v16: deshabilita scraper-crunchyroll.js; tracks Crunchy ahora entran como manual/R2.
      const cacheKey = `streams:anime:v16:${anilistId}:${episode}`;
  const reanimeCacheKey = `reanime:streams:v11:${anilistId}:${episode}`;
  const respKey = `resp:${cacheKey}:${proxyBase}`;
  perf.lap("route start (headers set)");
  setSensitiveResponseHeaders(res);
  perf.lap("headers set");

  if (!PLAYER_STREAM_ENCRYPTION_ENABLED) {
    const cachedBody = cacheGet(respKey);
    if (cachedBody) { perf.lap("resp cache hit, sending"); return res.type("application/json").send(cachedBody); }
    perf.lap("resp cache miss");
  }

  perf.lap("before r2 archive + thumbs");
  const r2Archived = getR2Archive(anilistId, episode);
  let episodeThumbnails = getEpisodeThumbnails(anilistId, episode);
  perf.lap("r2Archived + episodeThumbnails from cache", { archivedLangs: Object.keys(r2Archived).length, hasThumbs: Boolean(episodeThumbnails) });
  const coveredLangs = new Set();
  if (Object.keys(r2Archived).length) {
    const zenkaiStreams = buildZenkaiStreams(r2Archived, episodeThumbnails);
    perf.lap("buildZenkaiStreams done", { count: zenkaiStreams.length, r2Keys: Object.keys(r2Archived) });
    console.log(`[anime:zenkai] r2 keys raw=${JSON.stringify(Object.keys(r2Archived))} | built langs=${zenkaiStreams.map(s=>s.lang).join(",")}`);
    if (zenkaiStreams.length) {
      const ok = await filterPlayableStreams(zenkaiStreams, { allowEmpty: true });
      for (const s of ok) {
        coveredLangs.add(s.lang);
        if (s.lang === "MULTI" && Array.isArray(s.audioTracks)) {
          for (const track of s.audioTracks) {
            if (track?.code) coveredLangs.add(String(track.code).toUpperCase());
          }
        }
      }
      console.log(`[anime:zenkai] AFTER verify coveredLangs=${[...coveredLangs].join(",")} | dropped=${zenkaiStreams.length-ok.length} (stream(s) R2 con signature muerta? verify KO)`);
    } else {
      console.warn(`[anime] zenkai ${anilistId}/${episode}: archivado pero sin URLs firmadas (falta R2_SEAL_SECRET/R2_WORKER_BASE)`);
    }
  }
  perf.lap("r2 coverage ready", { archivedLangs: Object.keys(r2Archived).length, coveredLangs: coveredLangs.size });
  const skipProviders = new Set(
    Object.entries(PROVIDER_LANGS)
      // EXCEPCIONES HARD user (2026-10-07): animeav1 NUNCA se skippea, incluso si
      // Zenkai cubre sus idiomas. User lo requiere "sí o sí". Los demás siguen la regla.
      .filter(([name]) => name !== "animeav1")
      .filter(([, langs]) => langs.every((l) => coveredLangs.has(l)))
      .map(([name]) => name)
  );
  if (skipProviders.size) {
    console.log(`[anime] zenkai cubre ${[...coveredLangs].join(",")} — skip: ${[...skipProviders].join(",")}`);
  }
  perf.lap("skipProviders computed", { skipSize: skipProviders.size });

  perf.lap("before cacheGet providers");
  let data = cacheGet(cacheKey);
  let reanimeData = skipProviders.has("reanime") ? null : cacheGet(reanimeCacheKey);
  perf.lap("after cacheGet providers", { dataCacheHit: Boolean(data), reanimeCacheHit: Boolean(reanimeData) });
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
  if (data) console.log(`[anime] ${anilistId}/${episode} servido desde cache (providers no corrieron)`);
  if (reanimeData) console.log(`[anime] ${anilistId}/${episode} reanime servido desde cache`);

  if (!data) {
    perf.lap("data cache miss: will coalesce resolveAnime");
    const dataPromise = coalesce(cacheKey, async () => {
      const hit = cacheGet(cacheKey);
      if (hit) return hit;
      const d = await resolveAnimeData(anilistId, episode, skipProviders, { cacheKey, globalStartTs: perf.t0, globalBudgetMs: 5000 });
      const hasAny = d.megaplayDub || d.megaplaySub || d.megavid || d.latino || d.cuevanaStreams?.length || d.anikoto?.sub?.length || d.anikoto?.dub?.length || d.anikoto?.hsub?.length || d.aniwaves?.sub?.length || d.animeheaven?.sub?.length;
      if (hasAny && !skipProviders.size) {
        const t0 = Date.now();
        cacheSet(cacheKey, d, STREAM_TTL);
        console.log(`[cache:perf] streams cacheSet (${cacheKey}): +${Date.now() - t0}ms — JSON approx ${Math.round(JSON.stringify(d).length/1024)}KB`);
      }
      return d;
    });
    const reanimePromise = (!reanimeData && !skipProviders.has("reanime"))
      ? getReanimeCached(anilistId, episode, reanimeCacheKey)
      : Promise.resolve(reanimeData);
    perf.lap("about to await Promise.all dataPromise+reanimePromise");
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

  perf.lap("before data.reanime + thumb sync");
  data.reanime = reanimeData;
  if (reanimeData) {
    syncReanimeThumbnailMetadata(anilistId, episode, reanimeData);
    episodeThumbnails = getEpisodeThumbnails(anilistId, episode);
  }
  perf.lap("after data.reanime + thumb sync");
  perf.lap("about to coalesce respKey");
  const bodyOrSealed = await coalesce(respKey, async () => {
    perf.lap("resp coalesce body start");
    if (!PLAYER_STREAM_ENCRYPTION_ENABLED) {
      const cachedResp = cacheGet(respKey);
      if (cachedResp) { perf.lap("resp coalesce inner cache hit"); return { kind: "cached", body: cachedResp }; }
      perf.lap("resp coalesce inner cache miss");
    }

    const { megaplayDub, megaplaySub, megavid, latino, cuevanaStreams, miruro, anikoto, aniwaves, animeheaven, aniskip, reanime } = data;
    perf.lap("about to start buildAnimeTracks (in parallel with stream build)");
    const tracksPromise = buildAnimeTracks(anilistId, episode, proxyBase, megaplayDub, megaplaySub, reanime);
    if (reanimeData) cacheSet(reanimeCacheKey, reanimeData, REANIME_STREAM_TTL);
    if (reanimeData) enqueueReanimeSidecarArchive({ anilistId, episode, reanime: reanimeData, reanimeCacheKey, respKey });
    perf.lap("after enqueue reanime sidecar");

    let streams = [];

    streams.push(...buildZenkaiStreams(r2Archived, episodeThumbnails));
    perf.lap("buildZenkaiStreams push done", { count: streams.length });

    const downloads = [];
    const reanimeMulti = reanimeMultiSource(reanime);
    if (reanimeMulti?.url) {
      const originalProvider = `reanime-${reanimeMulti.server}`;
      const s = makeAnimeStream(proxyBase, maskRawUrl(reanimeMulti.url), "auto", "MULTI", originalProvider, { skip: reanimeSkipOf(reanimeMulti) });
      s.langLabel = "Multi audio";
      s.multiAudio = true;
      s.audioTracks = REANIME_MULTI_AUDIO_TRACKS;
      s.proxy_url = buildReanimeRiverProxyUrl(proxyBase, reanimeMulti, { multi: true });
      if (reanimeMulti.downloadLink) {
        const rawDl = typeof reanimeMulti.downloadLink === "string" && reanimeMulti.downloadLink.startsWith("sealed:")
          ? (unmaskRawUrl(reanimeMulti.downloadLink) || reanimeMulti.downloadLink)
          : reanimeMulti.downloadLink;
        downloads.push({ lang: "MULTI", langLabel: "Multi audio", server: publicDownloadServer(originalProvider), url: `${proxyBase}/dl?x=${sealQueryPayload({ url: rawDl, hint: originalProvider })}` });
      }
      if (reanimeMulti.available_fonts && Object.keys(reanimeMulti.available_fonts).length) {
        s.available_fonts = reanimeMulti.available_fonts;
      }
      if (Array.isArray(reanimeMulti.extracted_fonts) && reanimeMulti.extracted_fonts.length) {
        s.extracted_fonts = reanimeMulti.extracted_fonts;
      }
      const r2ThumbnailVtt = reanimeMulti.r2_thumbnail_vtt_key
        ? buildPublicR2Url(reanimeMulti.r2_thumbnail_vtt_key)
        : reanimeMulti.r2_thumbnail_vtt;
      if (r2ThumbnailVtt) {
        s.thumbnailVtt = r2ThumbnailVtt;
        s.thumbnailVttProxy = r2ThumbnailVtt;
      } else if (reanimeMulti.thumbnails_vtt) {
        s.thumbnailVtt = maskRawUrl(reanimeMulti.thumbnails_vtt);
        s.thumbnailVttProxy = `${proxyBase}/fetch?${sealedQueryParamDeterministic({ url: reanimeMulti.thumbnails_vtt, ref: "https://flixcloud.cc/", ct: "text/vtt" })}`;
      }
      streams.push(s);
    }

    for (const [item, lang, audioTrack] of reanimeMulti ? [] : [
      [reanime?.sub, "japanese", "jpn"],
      [reanime?.dub, "en-dub", "eng"],
    ]) {
      if (!item?.url) continue;
      const originalProvider = `reanime-${item.server}`;
      const s = makeAnimeStream(proxyBase, maskRawUrl(item.url), "auto", lang, originalProvider, { skip: reanimeSkipOf(item) });
      s.proxy_url = buildReanimeRiverProxyUrl(proxyBase, item, { audio: audioTrack });
      if (item.downloadLink) {
        const rawDl = typeof item.downloadLink === "string" && item.downloadLink.startsWith("sealed:")
          ? (unmaskRawUrl(item.downloadLink) || item.downloadLink)
          : item.downloadLink;
        downloads.push({ lang: s.lang, langLabel: s.langLabel, server: publicDownloadServer(originalProvider), url: `${proxyBase}/dl?x=${sealQueryPayload({ url: rawDl, hint: originalProvider })}` });
      }
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
        s.thumbnailVtt = maskRawUrl(item.thumbnails_vtt);
        s.thumbnailVttProxy = `${proxyBase}/fetch?${sealedQueryParamDeterministic({ url: item.thumbnails_vtt, ref: "https://flixcloud.cc/", ct: "text/vtt" })}`;
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
      for (const { server, url } of list) {
        if (!url || typeof url !== "string") continue;
        let rawUrl = url;
        if (rawUrl.startsWith("sealed:")) rawUrl = unmaskRawUrl(rawUrl) || url;
        if (!/^https?:\/\//i.test(rawUrl)) continue;
        const dlProviderLabel = publicDownloadServer("animeav1");
        downloads.push({ lang, langLabel, server: dlProviderLabel, url: `${proxyBase}/dl?x=${sealQueryPayload({ url: rawUrl, hint: `animeav1:${server || "s1"}` })}` });
      }
    }

    if (latino) {
      for (const { url, type, server, provider: streamProvider, cfUrl, thumbnailVtt, thumbnailJpg } of latino.streams) {
        const lang = type === "dub" ? "es-lat" : "ja-sub-lat";
        const originalProvider = streamProvider ?? (server > 1 ? `animeav1-s${server}` : "animeav1");
        const s = makeAnimeStream(proxyBase, url, "auto", lang, originalProvider);
        if (streamProvider === "upnshare") {
          s.proxy_url = `${proxyBase}/upn-stream.m3u8?u=${encodeURIComponent(cfUrl)}`;
        } else if (url?.includes("player.zilla-networks.com")) {
          s.proxy_url = `${proxyBase}/generic-stream.m3u8?u=${encodeURIComponent(url)}&ref=${encodeURIComponent("https://player.zilla-networks.com/")}`;
        } else if (streamProvider === "voe") {
          s.proxy_url = `${proxyBase}/generic-stream.m3u8?u=${encodeURIComponent(url)}`;
        } else if (streamProvider === "mp4upload") {
          s.proxy_url = `${proxyBase}/mp4-proxy?url=${encodeURIComponent(url)}&headers=${encodeURIComponent(JSON.stringify({ Referer: "https://mp4upload.com/" }))}`;
        } else if (url) {
          s.proxy_url = `${proxyBase}/upn-stream.m3u8?u=${encodeURIComponent(url)}`;
        }
        if (thumbnailVtt) {
          s.thumbnailVtt = maskRawUrl(thumbnailVtt);
          s.thumbnailVttProxy = `${proxyBase}/fetch?${sealedQueryParamDeterministic({ url: thumbnailVtt, ref: new URL(thumbnailVtt).origin + "/", ct: "text/vtt" })}`;
        }
        if (thumbnailJpg) {
          s.thumbnailJpg = maskRawUrl(thumbnailJpg);
          s.thumbnailJpgProxy = `${proxyBase}/fetch?${sealedQueryParamDeterministic({ url: thumbnailJpg, ref: new URL(thumbnailJpg).origin + "/", ct: "image/jpeg" })}`;
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
          let dlUrl = String(miruroStream.download);
          if (dlUrl.startsWith("sealed:")) dlUrl = unmaskRawUrl(dlUrl) || dlUrl;
          const sealedDl = /^https?:\/\//i.test(dlUrl)
            ? `${proxyBase}/dl?x=${sealQueryPayload({ url: dlUrl, hint: originalProvider })}`
            : dlUrl;
          downloads.push({ lang: dlLang, langLabel: dlLangLabel, server: publicDownloadServer(originalProvider), url: sealedDl });
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
    perf.lap("after all stream builder loops (megaplay/reanime/latino/megavid/cuevana/miruro/anikoto/aniwaves/animeheaven)", { count: streams.length });

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
    const reanimeDubSkip = reanimeSkipOf(reanime?.dub);
    const reanimeSubSkip = reanimeSkipOf(reanime?.sub);
    for (const s of streams) {
      const isReanime = String(s.originalProvider || "").startsWith("reanime");
      if (isReanime && s.skip) continue;
      const preferred = isDubLang(s.lang) ? (megaplayDubSkip ?? reanimeDubSkip) : (megaplaySubSkip ?? reanimeSubSkip);
      if (preferred) s.skip = preferred;
      else if (!s.skip && aniskip) s.skip = aniskip;
    }

    const normalized = normalizeProxyStreamTypes(streams);
    const cleaned = filterBrokenProviderLangCombos(normalized, { context: `anime/${anilistId}/${episode}` });
    const sorted = sortStreams(cleaned);
    const isZenkaiStream = (s) => String(s.originalProvider || "") === "zenkai";
    const grouped = [
      ...sorted.filter(s => isZenkaiStream(s)),
      ...sorted.filter(s => !isZenkaiStream(s) && isDubLang(s.lang)),
      ...sorted.filter(s => !isZenkaiStream(s) && !isDubLang(s.lang)),
    ];
    const playable = await filterPlayableStreams(grouped);
    perf.lap("filterPlayableStreams done", { inCount: grouped.length, outCount: playable.length });
    const withDisplay = assignDisplayProviders(playable);
    perf.lap("assignDisplayProviders done", { count: withDisplay.length });
    const tracks = await tracksPromise;
    perf.lap("buildAnimeTracks done", { trackCount: tracks?.length ?? 0 });
    const sealed = sealProxyUrls({ anilistId, episode: parseInt(episode), streams: withDisplay, tracks, downloads }, proxyBase);

    if (!PLAYER_STREAM_ENCRYPTION_ENABLED) {
      const builtBody = JSON.stringify(sealed);
      perf.lap("seal+stringify done", { bytes: builtBody.length, downloads: downloads.length });
      cacheSet(respKey, builtBody, RESP_TTL);
      perf.lap("resp cache stored");
      return { kind: "built", body: builtBody };
    }

    perf.lap("seal done (no cache, encrypt mode)", { downloads: downloads.length });
    return { kind: "sealed", sealed };
  });

  if (bodyOrSealed.kind === "cached" || bodyOrSealed.kind === "built") {
    res.type("application/json").send(bodyOrSealed.body);
  } else {
    const envelope = encryptJsonEnvelope(bodyOrSealed.sealed);
    res.type("application/json").send(JSON.stringify(envelope));
  }
  perf.lap("response sent");
});

export default router;
