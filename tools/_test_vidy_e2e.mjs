// End-to-end: api.wecollege.net directo desde Node + decrypt real.
import { decryptVidy } from "../vendor/vidy-crypto.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0";
const h = { "User-Agent": UA, Referer: "https://www.vidy.st/", Origin: "https://www.vidy.st" };

const seed = await fetch("https://api.wecollege.net/seed?mediaId=1396", { headers: h }).then(r => r.json());
console.log("seed:", seed.seed);

const params = new URLSearchParams({
  title: encodeURIComponent("Breaking Bad"), mediaType: "tv", year: "2008",
  episodeId: "1", seasonId: "1", tmdbId: "1396", imdbId: "tt0903747",
  enc: "2", seed: seed.seed,
});
const body = await fetch(`https://api.wecollege.net/miami/sources?${params}`, { headers: h }).then(r => r.text());
const parsed = JSON.parse(decryptVidy(body, seed.seed, "1396"));
console.log("sources:", parsed.sources?.length ?? 0);
for (const s of parsed.sources ?? []) console.log(`  ${s.quality}: ${s.url.slice(0, 90)}`);
console.log("subtitles:", parsed.subtitles?.length ?? 0);
console.log("playlist:", parsed.playlist?.slice(0, 90));
