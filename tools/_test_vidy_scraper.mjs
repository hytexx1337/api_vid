import { getVidyStream } from "../src/providers/scraper-vidy.js";
const t0 = Date.now();
const s = await getVidyStream({
  tmdbId: "1396", mediaType: "tv", title: "Breaking Bad",
  year: "2008", imdbId: "tt0903747", season: 1, episode: 1,
});
console.log(`(${Date.now() - t0}ms)`, JSON.stringify(s)?.slice(0, 400));
// m3u8 con referer — verificar que el playlist responde
if (s?.url) {
  const r = await fetch(s.url, { headers: { Referer: s.referer, "User-Agent": "Mozilla/5.0" } });
  const body = await r.text();
  console.log(`playlist: ${r.status} (${body.length}b) ${body.slice(0, 60).replace(/\n/g, " | ")}`);
}
