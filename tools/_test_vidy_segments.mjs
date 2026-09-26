// El playlist da 200 con ref vidy.st pero el usuario reporta 403 en segmentos.
// Bajo un playlist real, extraigo el 1er segmento y lo testeo con distintos
// referers — el host de los segmentos puede tener whitelist distinta.
import { getVidyStream } from "../src/providers/scraper-vidy.js";

const REFERER = "https://www.vidy.st/";
const H = (ref) => ({
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0.0.0 Safari/537.36",
  "Accept": "*/*",
  ...(ref ? { Referer: ref, Origin: ref.replace(/\/$/, "") } : {}),
});

const s = await getVidyStream({
  tmdbId: "1396", mediaType: "tv", title: "Breaking Bad",
  year: "2008", imdbId: "tt0903747", season: 1, episode: 1,
});

for (const st of s.streams.slice(0, 4)) {
  console.log(`\n=== ${st.provider} ${st.url.slice(0, 80)}`);
  // 1. playlist con ref vidy
  const r = await fetch(st.url, { headers: H(REFERER), signal: AbortSignal.timeout(10000) });
  if (!r.ok) { console.log(`  playlist ${r.status}`); continue; }
  const text = await r.text();
  console.log(`  playlist ${r.status} host=${new URL(st.url).host}`);

  // 2. si es master, bajar al primer variant
  let mediaUrl = st.url;
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const variant = text.includes("#EXT-X-STREAM-INF")
    ? lines.find(l => !l.startsWith("#"))
    : null;
  if (variant) {
    mediaUrl = new URL(variant, st.url).href;
    const r2 = await fetch(mediaUrl, { headers: H(REFERER), signal: AbortSignal.timeout(10000) });
    console.log(`  variant ${r2.status} ${mediaUrl.slice(0, 90)}`);
    if (!r2.ok) continue;
    const mediaText = await r2.text();
    const seg = mediaText.split("\n").map(l => l.trim()).find(l => l && !l.startsWith("#"));
    if (!seg) { console.log("  sin segmentos"); continue; }
    const segUrl = new URL(seg, mediaUrl).href;
    console.log(`  1er seg host=${new URL(segUrl).host} path=${new URL(segUrl).pathname.slice(-40)}`);
    for (const ref of [REFERER, "https://player.videasy.to/", null]) {
      const rs = await fetch(segUrl, { headers: H(ref), signal: AbortSignal.timeout(10000) });
      const head = (await rs.arrayBuffer()).byteLength;
      console.log(`    ref=${ref ?? "none"} -> ${rs.status} (${head}b)`);
    }
  } else {
    // media playlist directo
    const seg = lines.find(l => !l.startsWith("#"));
    if (!seg) { console.log("  sin segmentos"); continue; }
    const segUrl = new URL(seg, st.url).href;
    console.log(`  1er seg host=${new URL(segUrl).host} path=${new URL(segUrl).pathname.slice(-40)}`);
    for (const ref of [REFERER, "https://player.videasy.to/", null]) {
      const rs = await fetch(segUrl, { headers: H(ref), signal: AbortSignal.timeout(10000) });
      const head = (await rs.arrayBuffer()).byteLength;
      console.log(`    ref=${ref ?? "none"} -> ${rs.status} (${head}b)`);
    }
  }
}
