import { get } from "curl-cffi-node";
import { gunzipSync } from "zlib";

const VIXSRC_HEADERS = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36", "Referer": "https://vixsrc.to/" };

async function fetchText(url) {
  const r = await get(url, { impersonate: "chrome124", headers: VIXSRC_HEADERS, timeout: 20, verify: false });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  let b = r.buffer();
  if (/gzip/i.test(r.headers.get("content-encoding") || "")) b = gunzipSync(b);
  return b.toString("utf8");
}

async function main() {
  const { getVixsrcStream } = await import("./src/providers/scraper-vixsrc.js");
  const s = await getVixsrcStream("550", "movie");
  console.log("master URL:", s.masterUrl);
  const master = await fetchText(s.masterUrl);
  const lines = master.split("\n");

  const audioEngLine = lines.find((l) => l.includes("TYPE=AUDIO") && l.includes('LANGUAGE="eng"'));
  const variantLineIndex = lines.findIndex((l) => l.trim() && !l.startsWith("#") && lines[lines.indexOf(l) - 1]?.startsWith("#EXT-X-STREAM-INF"));
  const variantUrl = lines[variantLineIndex];
  const audioUrl = audioEngLine.match(/URI="([^"]+)"/)[1];

  console.log("audio URL:", audioUrl);
  console.log("variant URL:", variantUrl);

  const [audioPl, variantPl] = await Promise.all([fetchText(audioUrl), fetchText(variantUrl)]);
  console.log("\n--- AUDIO playlist first lines ---");
  console.log(audioPl.split("\n").slice(0, 12).join("\n"));
  console.log("\n--- VARIANT playlist first lines ---");
  console.log(variantPl.split("\n").slice(0, 12).join("\n"));
}

main().catch((e) => { console.error(e); process.exit(1); });
