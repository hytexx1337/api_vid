// Test api.speedracelight.com — mismo esquema seed+enc que wecollege.
import { decryptVidy } from "../vendor/vidy-crypto.js";

const API = "https://api.speedracelight.com";
const H = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0",
  Referer: "https://www.vidy.st/",
  Origin: "https://www.vidy.st",
};

// Game of Thrones S01E01
const args = { title: "Game of Thrones", mediaType: "tv", year: "2011", tmdbId: "1399", imdbId: "tt0944947", season: "1", episode: "1" };

const seed = await fetch(`${API}/seed?mediaId=${args.tmdbId}`, { headers: H }).then(r => r.json());
console.log("seed:", JSON.stringify(seed));

const servers = {
  cdn: "Yoru (original/4K)",
  m4uhd: "Breach",
  vsrc: "Neon",
  hdmovie: "Vyse/Fade",
  lamovie: "Omen (Spanish)",
  superflix: "Raze (PT)",
  meine: "Killjoy (DE)",
};

for (const [server, label] of Object.entries(servers)) {
  try {
    const params = new URLSearchParams({
      title: encodeURIComponent(args.title),
      mediaType: args.mediaType, year: args.year,
      episodeId: args.episode, seasonId: args.season,
      tmdbId: args.tmdbId, imdbId: args.imdbId,
      enc: "2", seed: seed.seed,
    });
    const r = await fetch(`${API}/${server}/sources-with-title?${params}`, { headers: H, signal: AbortSignal.timeout(15000) });
    const body = await r.text();
    if (!r.ok) { console.log(`\n${server} (${label}): HTTP ${r.status} ${body.slice(0, 100)}`); continue; }
    const parsed = JSON.parse(decryptVidy(body, seed.seed, args.tmdbId));
    console.log(`\n=== ${server} (${label}): ${parsed.sources?.length ?? 0} sources, ${parsed.subtitles?.length ?? 0} subs`);
    for (const s of (parsed.sources ?? []).slice(0, 6)) {
      console.log(`  ${s.quality ?? "?"} ${String(s.url ?? s.file).slice(0, 90)}`);
    }
    for (const s of (parsed.subtitles ?? []).slice(0, 4)) {
      console.log(`  sub: ${s.label ?? s.lang} ${String(s.url ?? s.file).slice(0, 70)}`);
    }
  } catch (e) {
    console.log(`\n${server} (${label}): ERR ${e.message.slice(0, 120)}`);
  }
}
