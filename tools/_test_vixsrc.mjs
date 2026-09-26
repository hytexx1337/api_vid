// ¿Por qué no reproducen los vixsrc? Testear la cadena completa:
// scraper → master playlist → variant → segmento, con los mismos headers
// que usa /vixsrc-stream.m3u8 en routes/proxy.js.
import { request } from "undici";
import { getVixsrcStream } from "../src/providers/index.js";

const VIXSRC_BASE = "https://vixsrc.to";
const VIXSRC_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Referer: `${VIXSRC_BASE}/`,
};

const r = await getVixsrcStream("1396", "tv", 1, 1).catch(e => ({ err: e.message }));
console.log("scraper:", JSON.stringify(r).slice(0, 300));
if (!r?.masterUrl) process.exit(0);

const get = async (u) => {
  const res = await request(u, { method: "GET", headers: VIXSRC_HEADERS, signal: AbortSignal.timeout(15000) });
  const chunks = [];
  for await (const c of res.body) chunks.push(c);
  return { status: res.statusCode, ct: res.headers["content-type"], body: Buffer.concat(chunks) };
};

const m = await get(r.masterUrl);
console.log(`\nmaster: ${m.status} ct=${m.ct} bytes=${m.body.length}`);
console.log(m.body.toString("utf8").slice(0, 600));

// primer variant + primer segmento
const lines = m.body.toString("utf8").split("\n").map(l => l.trim());
const variant = lines.find(l => l && !l.startsWith("#"));
if (variant) {
  const vUrl = new URL(variant, r.masterUrl).href;
  const v = await get(vUrl);
  console.log(`\nvariant: ${v.status} ${vUrl.slice(0, 110)}`);
  console.log(v.body.toString("utf8").slice(0, 400));
  // key AES (URI relativo /storage/enc.key) + segmento .html con ct real
  const keyLine = v.body.toString("utf8").split("\n").find(l => l.includes("EXT-X-KEY"));
  if (keyLine) {
    const keyUri = keyLine.match(/URI="([^"]+)"/)?.[1];
    const keyUrl = new URL(keyUri, vUrl).href;
    const k = await get(keyUrl);
    console.log(`\nkey: ${k.status} ${keyUrl} bytes=${k.body.length} head=${k.body.subarray(0, 8).toString("hex")}`);
  }
  const seg = v.body.toString("utf8").split("\n").map(l => l.trim()).find(l => l && !l.startsWith("#"));
  if (seg) {
    const sUrl = new URL(seg, vUrl).href;
    const s = await get(sUrl);
    console.log(`\nsegment: ${s.status} ct=${s.ct} bytes=${s.body.length} head=${s.body.subarray(0, 8).toString("hex")}`);
    console.log(`  ${sUrl.slice(0, 110)}`);
  }
}
