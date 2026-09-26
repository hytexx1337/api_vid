// Matrix test: titulos conocidos x todos los endpoints de ambos backends.
import { decryptVidy } from "../vendor/vidy-crypto.js";

const H = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0",
  Referer: "https://www.vidy.st/",
  Origin: "https://www.vidy.st",
};

const HOSTS = {
  "wecollege": { base: "https://api.wecollege.net", routes: ["miami", "boise", "seattle", "denver"], suffix: "sources" },
  "speedrace": { base: "https://api.speedracelight.com", routes: ["cdn", "m4uhd", "hdmovie", "lamovie", "superflix", "meine"], suffix: "sources-with-title" },
};

const TITLES = [
  { name: "Breaking Bad S01E01", title: "Breaking Bad", mediaType: "tv", year: "2008", tmdbId: "1396", imdbId: "tt0903747", season: "1", episode: "1" },
  { name: "Game of Thrones S01E01", title: "Game of Thrones", mediaType: "tv", year: "2011", tmdbId: "1399", imdbId: "tt0944947", season: "1", episode: "1" },
  { name: "The Dark Knight", title: "The Dark Knight", mediaType: "movie", year: "2008", tmdbId: "155", imdbId: "tt0468569" },
  { name: "Inception", title: "Inception", mediaType: "movie", year: "2010", tmdbId: "27205", imdbId: "tt1375666" },
  { name: "Fight Club", title: "Fight Club", mediaType: "movie", year: "1999", tmdbId: "550", imdbId: "tt0137523" },
];

const seeds = new Map();
async function getSeed(host, mediaId) {
  const key = `${host}|${mediaId}`;
  const e = seeds.get(key);
  if (e && e.exp > Date.now() - 5000) return e.seed;
  const r = await fetch(`${host}/seed?mediaId=${mediaId}`, { headers: H });
  const j = await r.json();
  seeds.set(key, { seed: j.seed, exp: Date.now() + (j.ttlMs ?? 30000) });
  return j.seed;
}

for (const t of TITLES) {
  console.log(`\n===== ${t.name} =====`);
  for (const [hname, h] of Object.entries(HOSTS)) {
    const seed = await getSeed(h.base, t.tmdbId).catch(() => null);
    if (!seed) { console.log(`  ${hname}: seed FAIL`); continue; }
    const jobs = h.routes.map(async (route) => {
      try {
      const params = new URLSearchParams({
        title: encodeURIComponent(t.title),
        mediaType: t.mediaType, year: t.year,
        tmdbId: t.tmdbId, imdbId: t.imdbId ?? "",
        enc: "2", seed,
      });
      if (t.mediaType === "tv") {
        params.set("episodeId", t.episode);
        params.set("seasonId", t.season);
      }
      const r = await fetch(`${h.base}/${route}/${h.suffix}?${params}`, { headers: H, signal: AbortSignal.timeout(15000) });
      const body = await r.text();
      if (!r.ok) return `${hname}/${route}: HTTP ${r.status}`;
      try {
        const p = JSON.parse(decryptVidy(body, seed, t.tmdbId));
        const n = p.sources?.length ?? 0;
        const q = (p.sources ?? []).map(s => s.quality ?? "?").slice(0, 5).join(",");
        return `${hname}/${route}: ${n} src [${q}] ${p.subtitles?.length ?? 0} subs`;
      } catch (e) {
        return `${hname}/${route}: decrypt FAIL (${e.message.slice(0, 60)})`;
      }
      } catch (e) {
        return `${hname}/${route}: ERR ${e.message.slice(0, 60)}`;
      }
    });
    for (const line of await Promise.all(jobs)) console.log(`  ${line}`);
  }
}
