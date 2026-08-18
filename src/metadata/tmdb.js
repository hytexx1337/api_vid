import { TMDB_BEARER } from "../config/constants.js";
import { cacheGet, cacheSet } from "../lib/cache.js";

export async function fetchTmdbMeta(tmdbId, mediaType = "movie") {
  const cacheKey = `tmdbmeta:${mediaType}:${tmdbId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const type = mediaType === "tv" ? "tv" : "movie";
  const r = await fetch(`https://api.themoviedb.org/3/${type}/${tmdbId}?append_to_response=external_ids`, {
    headers: { Authorization: `Bearer ${TMDB_BEARER}`, Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`TMDB HTTP ${r.status}`);
  const data = await r.json();
  const imdbId = data.imdb_id ?? data.external_ids?.imdb_id ?? null;
  const dateStr = data.release_date ?? data.first_air_date ?? null;
  const year = dateStr ? parseInt(dateStr.slice(0, 4)) : null;
  const result = { imdbId, lang: data.original_language ?? "en", title: data.title ?? data.name ?? null, year };

  cacheSet(cacheKey, result, 24 * 60 * 60 * 1000);
  return result;
}
