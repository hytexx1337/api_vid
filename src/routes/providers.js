import { Router } from "express";
import { PROVIDER_TTL } from "../config/constants.js";
import { cacheGet, cacheSet } from "../lib/cache.js";
import { getProxyBase } from "../lib/proxy.js";
import { buildTracks, getVidrkSubsWithIndex } from "../lib/subtitles.js";
import { makeCuevanaStream, makeVidsrcStream, makeGenericStream, makeVixsrcStream, sortStreams, assignDisplayProviders, mapMovieTvLang } from "../lib/stream-formatter.js";
import { sealProxyUrls } from "../lib/proxy-seal.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import { fetchTmdbMeta } from "../metadata/tmdb.js";
import {
  getCuevanaMovieStreams,
  getCuevanaStreams,
  getVaplayerStream,
  getVidupStream,
  getCinejoyStream,
  getVixsrcStream,
} from "../providers/index.js";

const router = Router();

// Rate limit para endpoints per-provider: 60 req/min por IP.
router.use(createRateLimiter({ windowMs: 60_000, max: 60, message: "Too many provider requests" }));

async function buildTracksForProvider(tmdbId, mediaType, season, episode, proxyBase) {
  const vidrkSubs = await getVidrkSubsWithIndex(tmdbId, mediaType, +season, +episode, null).then(r => r ?? []).catch(() => []);
  if (!vidrkSubs?.length) return [];
  return buildTracks(vidrkSubs, proxyBase);
}

function handleError(res, err) {
  const status = err.status ?? 502;
  res.status(status).json({ error: err.message });
}

router.get("/movie/:tmdbId/:provider", async (req, res) => {
  const { tmdbId, provider } = req.params;
  const cacheKey = `provider:movie:${tmdbId}:${provider}`;
  const proxyBase = getProxyBase(req);
  try {
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(sealProxyUrls(structuredClone(cached), proxyBase));

    const tmdbMeta = await fetchTmdbMeta(tmdbId, "movie").catch(() => null);
    let streams = [];

    switch (provider) {
      case "cuevana": {
        if (!tmdbMeta?.imdbId) break;
        const cuevanaStreams = await getCuevanaMovieStreams(tmdbMeta.imdbId).catch(() => []);
        streams = cuevanaStreams.map(c => makeCuevanaStream(c, proxyBase));
        break;
      }
      case "vaplayer": {
        const result = await getVaplayerStream(tmdbId, "movie");
        if (!result?.url) break;
        streams = [makeVidsrcStream(result, proxyBase, mapMovieTvLang(result.lang, tmdbMeta?.lang))];
        break;
      }
      case "vidup": {
        const result = await getVidupStream(tmdbId, "movie");
        if (!result?.url) break;
        streams = [makeVidsrcStream(result, proxyBase, mapMovieTvLang(result.lang, tmdbMeta?.lang))];
        break;
      }
      case "cinejoy": {
        if (!tmdbMeta?.title) break;
        const result = await getCinejoyStream({ tmdbId, mediaType: "movie", title: tmdbMeta.title, year: tmdbMeta.year, imdbId: tmdbMeta.imdbId });
        if (!result?.url) break;
        streams = [makeGenericStream(result, proxyBase, mapMovieTvLang(result.lang, tmdbMeta?.lang))];
        break;
      }
      case "vixsrc": {
        const result = await getVixsrcStream(tmdbId, "movie").catch(() => null);
        if (!result?.masterUrl) break;
        streams = [makeVixsrcStream(result, proxyBase, mapMovieTvLang("en", tmdbMeta?.lang))];
        break;
      }
      default:
        return res.status(410).json({ error: `Provider removed: ${provider}` });
    }

    const tracks = await buildTracksForProvider(tmdbId, "movie", 1, 1, proxyBase);
    const sorted = sortStreams(streams);
    const withDisplay = assignDisplayProviders(sorted);
    const body = { tmdbId, mediaType: "movie", provider, streams: withDisplay, tracks };
    if (streams.length > 0) cacheSet(cacheKey, body, PROVIDER_TTL);
    res.json(sealProxyUrls(structuredClone(body), proxyBase));
  } catch (err) { handleError(res, err); }
});

router.get("/tv/:tmdbId/:season/:episode/:provider", async (req, res) => {
  const { tmdbId, season, episode, provider } = req.params;
  const cacheKey = `provider:tv:${tmdbId}:${season}:${episode}:${provider}`;
  const proxyBase = getProxyBase(req);
  try {
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(sealProxyUrls(structuredClone(cached), proxyBase));

    const tmdbMeta = await fetchTmdbMeta(tmdbId, "tv").catch(() => null);
    let streams = [];

    switch (provider) {
      case "cuevana": {
        if (!tmdbMeta?.imdbId) break;
        const cuevanaStreams = await getCuevanaStreams(tmdbMeta.imdbId, +season, +episode).catch(() => []);
        streams = cuevanaStreams.map(c => makeCuevanaStream(c, proxyBase));
        break;
      }
      case "vaplayer": {
        const result = await getVaplayerStream(tmdbId, "tv", +season, +episode);
        if (!result?.url) break;
        streams = [makeVidsrcStream(result, proxyBase, mapMovieTvLang(result.lang, tmdbMeta?.lang))];
        break;
      }
      case "vidup": {
        const result = await getVidupStream(tmdbId, "tv", +season, +episode);
        if (!result?.url) break;
        streams = [makeVidsrcStream(result, proxyBase, mapMovieTvLang(result.lang, tmdbMeta?.lang))];
        break;
      }
      case "cinejoy": {
        if (!tmdbMeta?.title) break;
        const result = await getCinejoyStream({ tmdbId, mediaType: "tv", title: tmdbMeta.title, year: tmdbMeta.year, imdbId: tmdbMeta.imdbId, season: +season, episode: +episode });
        if (!result?.url) break;
        streams = [makeGenericStream(result, proxyBase, mapMovieTvLang(result.lang, tmdbMeta?.lang))];
        break;
      }
      case "vixsrc": {
        const result = await getVixsrcStream(tmdbId, "tv", +season, +episode).catch(() => null);
        if (!result?.masterUrl) break;
        streams = [makeVixsrcStream(result, proxyBase, mapMovieTvLang("en", tmdbMeta?.lang))];
        break;
      }
      default:
        return res.status(410).json({ error: `Provider removed: ${provider}` });
    }

    const tracks = await buildTracksForProvider(tmdbId, "tv", +season, +episode, proxyBase);
    const sorted = sortStreams(streams);
    const withDisplay = assignDisplayProviders(sorted);
    const body = { tmdbId, mediaType: "tv", season, episode, provider, streams: withDisplay, tracks };
    if (streams.length > 0) cacheSet(cacheKey, body, PROVIDER_TTL);
    res.json(sealProxyUrls(structuredClone(body), proxyBase));
  } catch (err) { handleError(res, err); }
});

export default router;
