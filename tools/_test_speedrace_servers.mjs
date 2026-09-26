// ¿speedracelight expone /servers o lista de rutas? + fuzz de slugs conocidos
import { decryptVidy } from "../vendor/vidy-crypto.js";

const API = "https://api.speedracelight.com";
const H = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0",
  Referer: "https://www.vidy.st/",
  Origin: "https://www.vidy.st",
};

// 1. endpoints de descubrimiento típicos
for (const path of ["/servers", "/api/servers", "/routes", "/health", "/status", "/"]) {
  try {
    const r = await fetch(`${API}${path}`, { headers: H, signal: AbortSignal.timeout(8000) });
    const body = (await r.text()).slice(0, 400);
    console.log(`GET ${path} -> ${r.status} ${body.replace(/\s+/g, " ")}`);
  } catch (e) {
    console.log(`GET ${path} -> ERR ${e.message.slice(0, 60)}`);
  }
}

// 2. slugs candidatos — nombres de servers que videasy listaba
const t = { title: "Chuck", mediaType: "tv", year: "2007", tmdbId: "1404", imdbId: "tt0934814", season: "1", episode: "12" };
const seed = await fetch(`${API}/seed?mediaId=${t.tmdbId}`, { headers: H }).then(r => r.json()).then(j => j.seed);

const slugs = [
  "yoru", "breach", "neon", "vyse", "killjoy", "fade", "omen", "raze",
  "vidsrc", "vsrc2", "embed", "movie", "tv", "hindi", "spanish", "german",
  "aurolog", "hdlink", "maple", "stratus", "anime", "zync", "parade", "surge",
  "4k", "uhd", "hd", "cam", "multi", "dub", "latino", "cast2tv", "w1x", "primewire",
];

for (const slug of slugs) {
  try {
    const params = new URLSearchParams({
      title: encodeURIComponent(t.title), mediaType: t.mediaType, year: t.year,
      episodeId: t.episode, seasonId: t.season,
      tmdbId: t.tmdbId, imdbId: t.imdbId, enc: "2", seed,
    });
    const r = await fetch(`${API}/${slug}/sources-with-title?${params}`, { headers: H, signal: AbortSignal.timeout(10000) });
    const body = await r.text();
    if (r.status === 404) continue; // ruta no existe
    if (r.status === 500) { console.log(`${slug}: 500 ${body.slice(0, 80)}`); continue; }
    try {
      const p = JSON.parse(decryptVidy(body, seed, t.tmdbId));
      console.log(`${slug}: OK ${p.sources?.length ?? 0} src ${p.subtitles?.length ?? 0} subs`);
    } catch {
      console.log(`${slug}: ${r.status} no-decrypt ${body.slice(0, 80)}`);
    }
  } catch (e) {
    console.log(`${slug}: ERR ${e.message.slice(0, 60)}`);
  }
}
console.log("done");
