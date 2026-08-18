import { cacheGet, cacheSet } from "../lib/cache.js";

export async function anilistToMal(anilistId) {
  const cacheKey = `mal:${anilistId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const r = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      query: "query($id:Int){Media(id:$id,type:ANIME){idMal}}",
      variables: { id: parseInt(anilistId) },
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`AniList HTTP ${r.status}`);
  const data = await r.json();
  const malId = data?.data?.Media?.idMal;
  if (!malId) throw new Error(`No MAL ID for anilist/${anilistId}`);

  cacheSet(cacheKey, malId, 24 * 60 * 60 * 1000);
  return malId;
}

export async function getAnimeSkip(malId, episode) {
  const cacheKey = `animeskip:${malId}:${episode}`;
  const cached = cacheGet(cacheKey);
  if (cached !== null) return cached;

  const r = await fetch(
    `https://api.aniskip.com/v1/skip-times/${malId}/${episode}?types=op&types=ed`,
    { signal: AbortSignal.timeout(5000) }
  );
  if (!r.ok) { cacheSet(cacheKey, null, 30 * 60 * 1000); return null; }

  const data = await r.json();
  if (!data.found || !data.results?.length) { cacheSet(cacheKey, null, 30 * 60 * 1000); return null; }

  const result = {};
  for (const item of data.results) {
    if (item.skip_type === "op") result.intro = [Math.round(item.interval.start_time), Math.round(item.interval.end_time)];
    if (item.skip_type === "ed") result.outro = [Math.round(item.interval.end_time), Math.round(item.interval.end_time)];
  }
  const value = Object.keys(result).length > 0 ? result : null;
  cacheSet(cacheKey, value, 6 * 60 * 60 * 1000);
  return value;
}

export async function getIntroSkip(imdbId, season, episode) {
  const cacheKey = `skip:${imdbId}:${season}:${episode}`;
  const cached = cacheGet(cacheKey);
  if (cached !== null) return cached;

  const r = await fetch(
    `https://api.introdb.app/segments?imdb_id=${imdbId}&season=${season}&episode=${episode}`,
    { signal: AbortSignal.timeout(5000) }
  );
  if (!r.ok) { cacheSet(cacheKey, null, 30 * 60 * 1000); return null; }

  const data = await r.json();
  const result = {};
  if (data.intro?.start_sec != null) result.intro = [data.intro.start_sec, data.intro.end_sec];
  if (data.outro?.start_sec != null) result.outro = [data.outro.start_sec, data.outro.end_sec];
  if (data.recap?.start_sec != null) result.recap = [data.recap.start_sec, data.recap.end_sec];

  const value = Object.keys(result).length > 0 ? result : null;
  cacheSet(cacheKey, value, 6 * 60 * 60 * 1000);
  return value;
}
