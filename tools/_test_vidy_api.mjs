// Test end-to-end: api.wecollege.net directo desde Node.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0";
const REF = "https://www.vidy.st/";

const h = { "User-Agent": UA, Referer: REF, Origin: REF.replace(/\/$/, "") };

// 1. seed
const seed = await fetch("https://api.wecollege.net/seed?mediaId=1396", { headers: h }).then(r => r.json());
console.log("seed:", JSON.stringify(seed));

// 2. sources — ojo: title va DOUBLE-encoded (encodeURIComponent x2)
const params = new URLSearchParams({
  title: encodeURIComponent("Breaking Bad"),
  mediaType: "tv", year: "2008",
  episodeId: "1", seasonId: "1",
  tmdbId: "1396", imdbId: "tt0903747",
  enc: "2", seed: seed.seed,
});
const r = await fetch(`https://api.wecollege.net/miami/sources?${params}`, { headers: h });
const body = await r.text();
console.log(`sources: ${r.status} (${body.length}b) ${body.slice(0, 120)}`);
