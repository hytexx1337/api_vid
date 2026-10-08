import crypto from "node:crypto";

const API = "http://localhost:8000";
const KEY = process.env.TEST_API_KEY || "Monitor1337!";

function b64urlToBuf(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function tryDecryptEnvelope(body) {
  if (!body || body.encrypted !== true) return body;
  const iv = b64urlToBuf(body.iv);
  const dek = b64urlToBuf(body.key);
  const raw = b64urlToBuf(body.data);
  const tag = raw.subarray(raw.length - 16);
  const ct = raw.subarray(0, raw.length - 16);
  const d = crypto.createDecipheriv("aes-256-gcm", dek, iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8"));
}

function b64u(b) { return Buffer.from(b).toString("base64url"); }
function tryUnsealToken(tok) {
  try {
    const secret = process.env.PROXY_SEAL_SECRET || process.env.API_ENCRYPT_KEY || "";
    const key = crypto.createHash("sha256").update(secret).digest().subarray(0, 32);
    const raw = b64urlToBuf(tok);
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const ct = raw.subarray(12, raw.length - 16);
    const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
    d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8"));
  } catch { return null; }
}

const r1 = await fetch(`${API}/anime/170130/2?key=${encodeURIComponent(KEY)}`);
const body1 = await r1.json();
console.log("[1] /anime status:", r1.status, "envelope?", !!body1.encrypted);
const inner = tryDecryptEnvelope(body1);
console.log("    streams totales:", inner.streams?.length);

const rean = inner.streams?.find(s => (s.originalProvider || "").startsWith("reanime"));
console.log("    stream reanime? ", !!rean, rean?.originalProvider);
const vttProxy = rean?.thumbnailVttProxy;
if (!vttProxy) { console.log("FAIL: no hay thumbnailVttProxy"); process.exit(1); }

console.log("[2] thumbnailVttProxy length:", vttProxy.length, "\n    preview: ", vttProxy.slice(0, 160) + "...");
const r2 = await fetch(vttProxy);
console.log("    /fetch VTT status:", r2.status, "ct:", r2.headers.get("content-type"));
if (r2.status !== 200) { console.log("    FAIL body:", await r2.text().slice(0, 500)); process.exit(2); }
const vtt = await r2.text();
console.log("\n=== VTT real (primeras 12 líneas) ===");
vtt.split("\n").slice(0, 12).forEach(l => console.log("   ", l));

const spriteUrls = [...vtt.matchAll(/(http:\/\/localhost:8000\/fetch\?s=([A-Za-z0-9_\-]+))/g)].map(m => ({ full: m[1], tok: m[2] }));
console.log("\n[3] Sprites reescritos (sellados) encontrados:", spriteUrls.length);
if (!spriteUrls.length) { console.log("FAIL: cero sprites encontrados"); process.exit(3); }

for (let i = 0; i < Math.min(2, spriteUrls.length); i++) {
  const { full, tok } = spriteUrls[i];
  const unsealed = tryUnsealToken(tok);
  console.log(`\n   Spr #${i} token descifrado →`, unsealed ? JSON.stringify(unsealed) : "?? invalido");
  const r3 = await fetch(full, { redirect: "follow" });
  console.log(`   Spr #${i} status: ${r3.status}  ct: ${r3.headers.get("content-type")}  length=${r3.headers.get("content-length")}`);
  if (r3.status === 200) {
    const buf = Buffer.from(await r3.arrayBuffer());
    const header = buf.slice(0, 16).toString("hex");
    const isWebp = buf.length >= 12 && buf.toString("utf8", 0, 4) === "RIFF" && buf.toString("utf8", 8, 12) === "WEBP";
    console.log(`   Spr #${i} bytes: ${buf.length}   is-webp? ${isWebp}   header-hex: ${header.slice(0,24)}`);
  } else {
    console.log("   body snippet:", await r3.text().then(x => x.slice(0, 300)));
  }
}
