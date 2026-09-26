// End-to-end: seed + sources + decrypt, todo desde Node.
import { readFileSync } from "fs";

// --- decrypt verbatim de _test_vidy_decrypt.mjs ---
const src = readFileSync("tools/_test_vidy_decrypt.mjs", "utf8");
eval(src.slice(src.indexOf("let l="), src.indexOf("// function(e,t,a)")) +
  src.slice(src.indexOf("const decrypt ="), src.indexOf("const payload")));

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0";
const h = { "User-Agent": UA, Referer: "https://www.vidy.st/", Origin: "https://www.vidy.st" };

const seed = await fetch("https://api.wecollege.net/seed?mediaId=1396", { headers: h }).then(r => r.json());
const params = new URLSearchParams({
  title: encodeURIComponent("Breaking Bad"), mediaType: "tv", year: "2008",
  episodeId: "1", seasonId: "1", tmdbId: "1396", imdbId: "tt0903747",
  enc: "2", seed: seed.seed,
});
const body = await fetch(`https://api.wecollege.net/miami/sources?${params}`, { headers: h }).then(r => r.text());
const out = decrypt(body, seed.seed, "1396");
const parsed = JSON.parse(out);
console.log(JSON.stringify(parsed.sources, null, 1).slice(0, 1200));
console.log("subtitles:", parsed.subtitles?.length ?? 0);
