import { Router } from "express";
import { SUB_TTL } from "../config/constants.js";
import { cacheGet, cacheSet } from "../lib/cache.js";
import { getProxyBase } from "../lib/proxy.js";
import { buildTracks, getVidrkSubsWithIndex } from "../lib/subtitles.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import { buildSignedR2Url } from "../lib/r2-seal.js";

const router = Router();

// Rate limit para subtítulos: 60 req/min por IP.
router.use(createRateLimiter({ windowMs: 60_000, max: 60, message: "Too many subtitle requests" }));

async function resolveMovieTvSubs(tmdbId, type, season, episode, proxyBase) {
  const cacheKey = `subs:${type}:${tmdbId}:${season}:${episode}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const vidrkSubs = await getVidrkSubsWithIndex(tmdbId, type, +season, +episode, null).catch(() => []);
  const tracks = vidrkSubs?.length ? await buildTracks(vidrkSubs, proxyBase) : [];

  const result = { subtitles: tracks };
  if (tracks.length > 0) cacheSet(cacheKey, result, SUB_TTL);
  return result;
}

async function resolveAnimeSubs(anilistId, episode, proxyBase) {
  const { getCRSubsForAnime } = await import("../providers/index.js");
  const cacheKey = `subs:anime:${anilistId}:${episode}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const crTracks = await getCRSubsForAnime(anilistId, parseInt(episode)).catch(() => []);
  // Los tracks de CR ya vienen descargados/archivados por getCRSubsForAnime
  // (a R2 o a disco local, ver scraper-crunchyroll.js) — no hace falta
  // pasarlos por buildTracks/downloadSubtitles (ese pipeline es para
  // providers que dan URLs externas crudas sin cachear).
  const tracks = crTracks?.length
    ? crTracks.map(t => ({
        label: t.label,
        lang: t.lang,
        url: t.r2 ? buildSignedR2Url(`subs/${t.file}`) : `${proxyBase}/subs/${t.file}`,
        kind: t.format === "vtt" ? "captions" : "subtitles",
        ...(t.default && { default: true }),
      }))
    : [];

  const result = { subtitles: tracks };
  if (tracks.length > 0) cacheSet(cacheKey, result, SUB_TTL);
  return result;
}

router.get("/subtitles/movie/:tmdbId", async (req, res) => {
  try {
    const proxyBase = getProxyBase(req);
    res.json(await resolveMovieTvSubs(req.params.tmdbId, "movie", 1, 1, proxyBase));
  } catch (err) { res.status(err.status ?? 502).json({ error: err.message }); }
});

router.get("/subtitles/tv/:tmdbId/:season/:episode", async (req, res) => {
  try {
    const { tmdbId, season, episode } = req.params;
    const proxyBase = getProxyBase(req);
    res.json(await resolveMovieTvSubs(tmdbId, "tv", season, episode, proxyBase));
  } catch (err) { res.status(err.status ?? 502).json({ error: err.message }); }
});

router.get("/subtitles/anime/:anilistId/:episode", async (req, res) => {
  try {
    const { anilistId, episode } = req.params;
    const proxyBase = getProxyBase(req);
    res.json(await resolveAnimeSubs(anilistId, episode, proxyBase));
  } catch (err) { res.status(err.status ?? 502).json({ error: err.message }); }
});

export default router;
