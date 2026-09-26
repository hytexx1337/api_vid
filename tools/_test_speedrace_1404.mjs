// Todos los servers para Chuck S01E12 (tmdb 1404, tt0934814)
import { decryptVidy } from "../vendor/vidy-crypto.js";

const H = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0",
  Referer: "https://www.vidy.st/",
  Origin: "https://www.vidy.st",
};

const HOSTS = {
  "wecollege": { base: "https://api.wecollege.net", routes: ["miami", "boise", "seattle", "denver"], suffix: "sources" },
  "speedrace": { base: "https://api.speedracelight.com", routes: ["cdn", "m4uhd", "hdmovie", "lamovie", "superflix", "meine", "vsrc"], suffix: "sources-with-title" },
};

const t = { title: "Chuck", mediaType: "tv", year: "2007", tmdbId: "1404", imdbId: "tt0934814", season: "1", episode: "12" };

const seeds = new Map();
async function getSeed(host) {
  const e = seeds.get(host);
  if (e && e.exp > Date.now() - 5000) return e.seed;
  const r = await fetch(`${host}/seed?mediaId=${t.tmdbId}`, { headers: H });
  const j = await r.json();
  seeds.set(host, { seed: j.seed, exp: Date.now() + (j.ttlMs ?? 30000) });
  return j.seed;
}

for (const [hname, h] of Object.entries(HOSTS)) {
  const seed = await getSeed(h.base).catch(() => null);
  if (!seed) { console.log(`${hname}: seed FAIL`); continue; }
  const jobs = h.routes.map(async (route) => {
    try {
      const params = new URLSearchParams({
        title: encodeURIComponent(t.title), mediaType: t.mediaType, year: t.year,
        episodeId: t.episode, seasonId: t.season,
        tmdbId: t.tmdbId, imdbId: t.imdbId, enc: "2", seed,
      });
      const r = await fetch(`${h.base}/${route}/${h.suffix}?${params}`, { headers: H, signal: AbortSignal.timeout(15000) });
      const body = await r.text();
      if (!r.ok) return `${hname}/${route}: HTTP ${r.status} ${body.slice(0, 120)}`;
      const p = JSON.parse(decryptVidy(body, seed, t.tmdbId));
      const q = (p.sources ?? []).map(s => s.quality ?? "?").join(",");
      return `${hname}/${route}: ${p.sources?.length ?? 0} src [${q}] ${p.subtitles?.length ?? 0} subs`;
    } catch (e) {
      return `${hname}/${route}: ERR ${e.message.slice(0, 70)}`;
    }
  });
  for (const line of await Promise.all(jobs)) console.log(`  ${line}`);
}
