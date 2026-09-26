// ¿Qué pide el CDN de vidy para servir el playlist? Token decodificado +
// matriz de referers (none / vidy.st / movy.sx / arbitrary / cineparatodos).
import { getVidyStream } from "../src/providers/scraper-vidy.js";

const s = await getVidyStream({
  tmdbId: "1396", mediaType: "tv", title: "Breaking Bad",
  year: "2008", imdbId: "tt0903747", season: 1, episode: 1,
});
const url = s.url;
console.log("url:", url.slice(0, 130));

// 1. decodificar el token /vd/<b64>/
const tok = url.split("/vd/")[1]?.split("/")[0];
const decoded = Buffer.from(tok.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();
console.log("token dec:", decoded);
// la parte izquierda suele ser otro b64 o un id — probar decodificar de nuevo
try {
  const inner = Buffer.from(decoded.split(":")[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();
  console.log("token inner:", JSON.stringify(inner));
} catch {}

// 2. matriz de referers sobre el master playlist
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0.0.0 Safari/537.36" };
for (const [label, headers] of Object.entries({
  "sin headers": {},
  "vidy.st": { Referer: "https://www.vidy.st/", Origin: "https://www.vidy.st" },
  "movy.sx": { Referer: "https://www.movy.sx/", Origin: "https://www.movy.sx" },
  "dominio random": { Referer: "https://ejemplo.com/", Origin: "https://ejemplo.com" },
  "cineparatodos": { Referer: "https://cineparatodos.lat/", Origin: "https://cineparatodos.lat" },
  "referer vacio": { Referer: "" },
})) {
  try {
    const r = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(8000) });
    console.log(`${label.padEnd(16)} -> ${r.status}`);
  } catch (e) {
    console.log(`${label.padEnd(16)} -> ERR ${e.message.slice(0, 50)}`);
  }
}
