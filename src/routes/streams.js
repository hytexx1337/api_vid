import { Router } from "express";
import { STREAM_TTL, REANIME_STREAM_TTL, isProviderEnabled, HEADERS } from "../config/constants.js";
import { cacheGet, cacheSet, timed, getR2Archive, getManualTracks } from "../lib/cache.js";
import { buildSignedR2Url } from "../lib/r2-seal.js";
import { enqueueArchiveJob, isQueuedOrArchiving } from "../lib/r2-queue.js";
import { isR2Configured } from "../lib/hls-to-r2.js";
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
  getVideasyStream,
  getVixsrcStream,
  getReanimeStreams,
  getAniwavesStreams,
  getAnimeheavenStreams,
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
    url: t.r2 ? buildSignedR2Url(`subs/${t.file}`) : `${proxyBase}/subs/${t.file}`,
    kind: "captions",
    ...(t.default && { default: true }),
  }));

  const assTracks = (crTracks || []).filter(t => t.format === "ass" && WANTED_ASS_LANGS.has(t.lang)).map(t => ({
    label: ASS_LABELS[t.lang] || t.label || t.lang,
    lang: t.lang,
    url: t.r2 ? buildSignedR2Url(`subs/${t.file}`) : `${proxyBase}/subs/${t.file}`,
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
    url: buildSignedR2Url(`subs/${t.file}`),
    kind: t.kind || "subtitles",
  }));

  // Subtítulos de reanime.to (flixcloud.cc): se extraen del embed ANTES de
  // decriptar la URL final del stream, así que quedan disponibles aunque el
  // stream en sí termine dando 403 al reproducir (token de flixcloud vencido,
  // ver /flixcloud-m3u8 en routes/proxy.js) — mejor tener subs sueltos que
  // nada. La mayoría vienen en .srt (se convierten a .vtt en downloadSubtitles)
  // y algunos en .ass por idioma.
  const reanimeTracks = [];
  const seenReanimeUrls = new Set();
  for (const item of [reanime?.sub, reanime?.dub]) {
    if (!item?.subtitles?.length) continue;
    for (const s of item.subtitles) {
      const url = s.url || s.file;
      if (!url || seenReanimeUrls.has(url)) continue;
      seenReanimeUrls.add(url);
      // El embed de flixcloud expone { url, language, format, default } —
      // `language` es el label completo ("English (Full Subtitles [...])"),
      // no hay `label`/`lang` separados. detectTrackLang saca el código de
      // idioma del propio texto del label.
      const subLabel = s.language || s.label || "";
      reanimeTracks.push({
        label: normalizeSubLabel(subLabel, null) || subLabel || "Unknown",
        lang: s.lang || detectTrackLang(url, subLabel),
        url,
        kind: (s.format === "ass" || /\.ass(\?|$)/i.test(url)) ? "subtitles" : "captions",
        referer: "https://flixcloud.cc/",
        ...(s.default && { default: true }),
      });
    }
  }
  const processedReanime = reanimeTracks.length ? await buildTracks(reanimeTracks, proxyBase) : [];

  const rawTracks = [...vttTracks, ...assTracks, ...processedMegaplay, ...manualTracks, ...processedReanime];
  return rawTracks;
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

  const [latinoResult, megaplayResult, megavidResult, cuevanaResult, crSubsResult, miruroResult, anikotoResult, aniskipResult, aniwavesResult, animeheavenResult] = await Promise.allSettled([
    timed2("animeav1", getLatinoStream(anilistId, episode).then(v => {
      for (const s of v?.streams ?? []) pw({ url: s.cfUrl ?? s.url, type: "hls", originalProvider: s.provider ?? "animeav1" });
      return v;
    })),
    timed2("megaplay", getMegaplayStreams(anilistId, parseInt(episode)).then(v => {
      for (const it of [v?.dub, v?.sub]) if (it?.url) pw({ url: it.url, headers: it.headers, type: "hls", originalProvider: "megaplay" });
      return v;
    })),
    timed2("megavid", (isProviderEnabled("megavid") ? getMegavidStream(anilistId, parseInt(episode)).then(v => {
      if (v?.url) pw({ url: v.url, headers: { Referer: "https://megavid.buzz/" }, type: "hls", originalProvider: "megavid" });
      return v;
    }) : Promise.resolve(null))),
    timed2("cuevana", getCuevanaAnime(anilistId, parseInt(episode)).then(v => {
      for (const c of v ?? []) if (c?.url) pw({ url: c.url, headers: c.headers, type: c.url.includes(".mp4") ? "mp4" : "hls", originalProvider: "embed69" });
      return v;
    })),
    timed2("cr-subs", getCRSubsForAnime(anilistId, parseInt(episode))),
    timed2("miruro", (isProviderEnabled("miruro") ? getMiruroStreams(anilistId, parseInt(episode)) : Promise.resolve({ dub: [], sub: [] })).then(v => {
      for (const s of [...(v?.dub ?? []), ...(v?.sub ?? [])]) if (s?.url) pw({ url: s.url, headers: s.headers, type: "hls", originalProvider: `miruro-${s.provider}` });
      return v;
    })),
    timed2("anikoto", getAnikotoStreams(anilistId, parseInt(episode)).then(v => {
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
    timed2("aniwaves", (isProviderEnabled("aniwaves") ? withScraperTimeout("aniwaves", getAniwavesStreams(anilistId, parseInt(episode))) : Promise.resolve({ sub: [] }))),
    // animeheaven: hardsub EN, mp4 directo — rápido (~1s), sin extractores.
    timed2("animeheaven", (isProviderEnabled("animeheaven") ? withScraperTimeout("animeheaven", getAnimeheavenStreams(anilistId, parseInt(episode))) : Promise.resolve({ sub: [] }))),
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
    r.status === "fulfilled" ? `${name}✓(${fmt(r.value)})` : `${name}✗(${r.reason?.message ?? "?"})`
  ).join(" ");
  console.log(`  [resolveAnime] providers: ${providerSummary}`);

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
  if (hit) return hit;
  if (!isProviderEnabled("reanime")) return { sub: null, dub: null };
  try {
    const value = await getReanimeStreams(anilistId, episode);
    cacheSet(cacheKey, value, REANIME_STREAM_TTL);
    return value;
  } catch (e) {
    console.warn("[anime] reanime ✗:", e.message);
    return { sub: null, dub: null };
  }
}

router.get("/anime/:anilistId/:episode", async (req, res) => {
  const { anilistId, episode } = req.params;
  const proxyBase = getProxyBase(req);

  // v11: + aniwaves (hardsub EN, scraper propio)
  const cacheKey = `streams:anime:v11:${anilistId}:${episode}`;
  const reanimeCacheKey = `reanime:streams:v10:${anilistId}:${episode}`;
  let data = cacheGet(cacheKey);
  let reanimeData = cacheGet(reanimeCacheKey);
  if (data) console.log(`[anime] ${anilistId}/${episode} servido desde cache (providers no corrieron)`);
  if (reanimeData) console.log(`[anime] ${anilistId}/${episode} reanime servido desde cache`);

  if (!data) {
    data = await resolveAnimeData(anilistId, episode);
    const hasAny = data.megaplayDub || data.megaplaySub || data.megavid || data.latino || data.cuevanaStreams?.length || data.anikoto?.sub?.length || data.anikoto?.dub?.length || data.anikoto?.hsub?.length || data.aniwaves?.sub?.length || data.animeheaven?.sub?.length;
    if (hasAny) cacheSet(cacheKey, data, STREAM_TTL);
    if (!reanimeData) reanimeData = await getReanimeCached(anilistId, episode, reanimeCacheKey);
  } else if (!reanimeData) {
    reanimeData = await getReanimeCached(anilistId, episode, reanimeCacheKey);
    cacheSet(reanimeCacheKey, reanimeData, REANIME_STREAM_TTL);
  }

  data.reanime = reanimeData;

  const { megaplayDub, megaplaySub, megavid, latino, cuevanaStreams, crTracks, miruro, anikoto, aniwaves, animeheaven, aniskip, reanime } = data;
  const tracks = await buildAnimeTracks(anilistId, episode, proxyBase, megaplayDub, megaplaySub, reanime);

  let streams = [];

  // Streams archivados en R2 (bucket propio, ver scripts/r2-select.js).
  // Van primero en el array para quedar como "CPT CDN 1" de su idioma: no
  // dependen de que el provider original siga vivo, no hace falta re-scrapear.
  const R2_LANG_LABELS = {
    "ESP-LAT": "Español latino",
    "ENG-DUB": "Inglés (doblado)",
    "JAP-SUB": "Japonés (sub por separado)",
    "JAP-ES-HS": "Japonés (sub español quemado)",
    "JAP-EN-HS": "Japonés (sub inglés quemado)",
  };
  const r2Archived = getR2Archive(anilistId, episode);
  for (const [lang, entry] of Object.entries(r2Archived)) {
    try {
      const signedUrl = buildSignedR2Url(`${entry.slug}/master.m3u8`);
      // Mismo formato `skip` que usan los demás providers (ver makeAnimeStream):
      // { intro: [start,end], outro: [start,end] } en segundos.
      const skip = (entry.skipIntro || entry.skipOutro)
        ? { ...(entry.skipIntro && { intro: entry.skipIntro }), ...(entry.skipOutro && { outro: entry.skipOutro }) }
        : null;
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
        ...(skip && { skip }),
      });
    } catch (e) {
      console.warn(`[anime] r2 archive ${lang} sin firmar: ${e.message}`);
    }
  }

  const downloads = [];

  // reanime.to (flixcloud.cc) — provider principal para ENG-DUB y JAP-SUB
  // cuando está disponible: va primero que el resto de los providers vivos
  // (después de los archivados en R2, que son nuestro propio CDN).
  // El .m3u8 real viene cifrado (zstd + base64 + XOR fijo global, ver
  // lib/flixcloud-decrypt.js); proxy_url apunta a nuestra ruta
  // /flixcloud-m3u8 que lo descifra y reescribe sub-playlists/segmentos.
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
    // El master de flixcloud trae ambas pistas (jpn+eng) en el mismo m3u8;
    // ?audio= le dice a /flixcloud-m3u8 que tire la pista que no corresponde.
    s.proxy_url = `${proxyBase}/flixcloud-m3u8?u=${encodeURIComponent(item.url)}&audio=${audioTrack}${item.manifest_key ? `&k=${encodeURIComponent(item.manifest_key)}` : ""}`;
    if (item.downloadLink) downloads.push({ lang: s.lang, langLabel: s.langLabel, server: `reanime-${item.server}`, url: item.downloadLink });
    if (item.thumbnails_vtt) {
      s.thumbnailVtt = item.thumbnails_vtt;
      s.thumbnailVttProxy = `${proxyBase}/fetch?url=${encodeURIComponent(item.thumbnails_vtt)}&ref=${encodeURIComponent("https://flixcloud.cc/")}&ct=${encodeURIComponent("text/vtt")}`;
    }
    streams.push(s);
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

  // aniwaves: el "sub" del sitio es japonés con subs en inglés QUEMADOS — el
  // "-hsub" en originalProvider hace que normalizeLang lo etiquete JAP-EN-HS
  // (misma convención que anikoto-hsub). Sus playlists pueden venir ofuscados
  // en decimal ASCII; /generic-stream los decodifica antes de reescribir (ver
  // routes/proxy.js).
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
      // animeheaven devuelve mp4 directo → /mp4-proxy (soporta Range);
      // aniwaves devuelve hls → /generic-stream.
      s.proxy_url = src.type === "mp4"
        ? `${proxyBase}/mp4-proxy?url=${encodeURIComponent(src.url)}&headers=${encodeURIComponent(JSON.stringify(src.referer ? { Referer: src.referer } : {}))}`
        : `${proxyBase}/generic-stream.m3u8?u=${encodeURIComponent(src.url)}${src.referer ? `&ref=${encodeURIComponent(src.referer)}` : ""}`;
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

  // Dedupe por URL final (proxy_url): anikoto y megaplay pueden resolver al
  // mismo master, pero reanime sub/dub comparten el mismo upstream master
  // y se diferencian en la query ?audio= del proxy.
  const seenUrls = new Set();
  streams = streams.filter((s) => { const key = s.proxy_url || s.url; if (seenUrls.has(key)) return false; seenUrls.add(key); return true; });

  if (streams.length === 0) return res.status(404).json({ error: "No streams found for this episode" });

  // Fire-and-forget: no bloquea la respuesta, corre en background.
  autoArchiveMissingLangs(anilistId, episode, streams, r2Archived, proxyBase);

  // Megaplay tiene los timestamps de intro/outro más precisos (por episodio,
  // no una estimación genérica). Se propagan a todos los streams del mismo
  // grupo dub/sub: megaplayDub.skip -> ESP-LAT, ENG-DUB, etc; megaplaySub.skip
  // -> JAP-SUB, JAP-ES-HS, JAP-EN-HS. Reanime conserva su propio skip (viene
  // del embed de flixcloud, también por episodio) y sirve de fallback del
  // grupo cuando megaplay no tiene datos. aniskip queda como último fallback.
  const isDubLang = (lang) => /DUB|LAT/.test(lang || "");
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
  const withDisplay = assignDisplayProviders(playable);
  res.json(sealProxyUrls({ anilistId, episode: parseInt(episode), streams: withDisplay, tracks, downloads }, proxyBase));
});

export default router;
