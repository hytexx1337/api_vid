import crypto from "node:crypto";

const API = "http://localhost:8000";
const KEY = process.env.TEST_API_KEY || "Monitor1337!";

function b64urlToBuf(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}
function tryDecEnv(body) {
  if (!body || body.encrypted !== true) return body;
  const iv = b64urlToBuf(body.iv); const dek = b64urlToBuf(body.key);
  const raw = b64urlToBuf(body.data); const tag = raw.subarray(raw.length - 16);
  const ct = raw.subarray(0, raw.length - 16);
  const d = crypto.createDecipheriv("aes-256-gcm", dek, iv); d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8"));
}
const secret = process.env.PROXY_SEAL_SECRET || process.env.API_ENCRYPT_KEY || "";
const key2 = crypto.createHash("sha256").update(secret).digest().subarray(0, 32);
function tryUnseal(tok) {
  try {
    const raw = b64urlToBuf(tok); const iv = raw.subarray(0, 12); const tag = raw.subarray(raw.length - 16);
    const ct = raw.subarray(12, raw.length - 16);
    const d = crypto.createDecipheriv("aes-256-gcm", key2, iv); d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8"));
  } catch (e) { return null; }
}

const r1 = await fetch(`${API}/anime/170130/2?key=${encodeURIComponent(KEY)}`);
const inner = tryDecEnv(await r1.json());
const rean = inner.streams.find(s => (s.originalProvider || "").startsWith("reanime"));
console.log("reanime stream:", !!rean, rean?.thumbnailVttProxy?.slice(0, 80) + "...");

const rvtt = await fetch(rean.thumbnailVttProxy);
console.log("VTT status:", rvtt.status, rvtt.headers.get("content-type"));
const vtt = await rvtt.text();
console.log("\n=== Primeras 12 líneas del VTT reescrito ===");
vtt.split("\n").slice(0, 12).forEach(l => console.log("   ", l));

const lines = vtt.split("\n");
const sprites = [];
const tokenRegex = /^https?:\/\/[^\s]+\/fetch\?s=([A-Za-z0-9_\-]+)(#[^\s]*)?$/;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i].trim();
  const m = line.match(tokenRegex);
  if (m) sprites.push({ lineNo: i + 1, line, token: m[1], frag: m[2] || "" });
}
console.log(`\nSprites VTT parseados: ${sprites.length}`);
if (!sprites.length) process.exit(2);

// Cuenta tokens únicos
const uniqueTokens = new Map();
const uniqueAbsNoFrag = new Map();
const fragsByToken = new Map();

for (const s of sprites) {
  uniqueTokens.set(s.token, (uniqueTokens.get(s.token) || 0) + 1);
  if (!fragsByToken.has(s.token)) fragsByToken.set(s.token, new Set());
  if (s.frag) fragsByToken.get(s.token).add(s.frag);
  const u = tryUnseal(s.token);
  if (u?.url) {
    if (!uniqueAbsNoFrag.has(u.url)) uniqueAbsNoFrag.set(u.url, 0);
    uniqueAbsNoFrag.set(u.url, uniqueAbsNoFrag.get(u.url) + 1);
  }
}

console.log("\n=== ANÁLISIS ESPERADO (fix correcto) ===");
console.log(`Cantidad de tokens /fetch?s= únicos DISTINTOS = ${uniqueTokens.size}`);
console.log(`Cantidad de URLs absolutas (archivos webp) DISTINTAS (descifradas) = ${uniqueAbsNoFrag.size}`);
console.log(`Total líneas sprite = ${sprites.length}`);
console.log("");

// Test A: #xywh NO entró al token (se preserva en frag)
const conFrag = sprites.filter(s => s.frag.startsWith("#"));
console.log(`Líneas con #xywh preservado: ${conFrag.length}/${sprites.length}`);
console.assert(conFrag.length === sprites.length, "FAIL: No todos los sprites tienen #xywh al final del link");

// Test B: mismo archivo imagen → mismo token.
// Ver: si cada token aparece >= 1 veces, y el #1 token TOP aparece N veces (20).
const topN = [...uniqueTokens.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
console.log("\nTop 5 tokens con MÁS repeticiones (un mismo s= repetido N veces):");
topN.forEach(([tok, count]) => {
  const frags = [...(fragsByToken.get(tok) || new Set())].slice(0, 5);
  const unsealed = tryUnseal(tok)?.url;
  console.log(`   repeticiones=${count}  frags distintos=${fragsByToken.get(tok)?.size}  frags=${frags.join(" ")}${fragsByToken.get(tok)?.size > 5 ? " +" + (fragsByToken.get(tok).size-5) + " más" : ""}`);
  console.log(`     url(descifrada, sin hash) = ${unsealed}`);
});

// Test C: para cada URL abs distinta → 1 solo token.
// Armamos map abs_url → Set(tokens). Esperamos todos los sets de size 1.
const tokensPorAbs = new Map();
for (const s of sprites) {
  const u = tryUnseal(s.token)?.url;
  if (!u) continue;
  if (!tokensPorAbs.has(u)) tokensPorAbs.set(u, new Set());
  tokensPorAbs.get(u).add(s.token);
}
let urlsConMultiTokens = 0;
for (const [u, set] of tokensPorAbs.entries()) {
  if (set.size > 1) urlsConMultiTokens++;
}
console.log(`\nArchivos de imagen (URLs abs) con >=2 tokens DISTINTOS = ${urlsConMultiTokens}`);
console.assert(urlsConMultiTokens === 0, "FAIL: hay colisiones → mismo .webp con >1 token distinto");

// Test D: sample 1. Agarramos sprite_0.webp (el primer archivo). Todas sus
// referencias deberían tener el MISMO token.
const sampleEntry = [...tokensPorAbs.entries()].find(([u]) => u.includes("sprite_0.webp"));
if (sampleEntry) {
  const [sampleUrl, sampleTokens] = sampleEntry;
  const repeticiones = [...sprites].filter(s => tryUnseal(s.token)?.url === sampleUrl).length;
  console.log(`\nSprite sample: ${sampleUrl.split("/").pop()}`);
  console.log(`   Referencias totales en todo el VTT → ${repeticiones}`);
  console.log(`   Tokens distintos usados → ${sampleTokens.size}  (idealmente 1)`);
  console.assert(sampleTokens.size === 1, `FAIL: sprite_0.webp tiene ${sampleTokens.size} tokens distintos en vez de 1`);
}

// Test E: hit 1 sprite con y sin fragmento → misma respuesta HTTP.
if (sprites[0]) {
  const urlConFrag = `${API}/fetch?s=${sprites[0].token}${sprites[0].frag}`;
  const urlSinFrag = `${API}/fetch?s=${sprites[0].token}`;
  console.log("\n=== Hit real sprite #0 (misma img, con y sin #xywh) ===");
  const rA = await fetch(urlSinFrag);
  const rB = await fetch(urlConFrag);
  console.log(`   sin #xywh → ${rA.status} ${rA.headers.get("content-type")} ${rA.headers.get("content-length")} bytes`);
  console.log(`   con #xywh → ${rB.status} ${rB.headers.get("content-type")} ${rB.headers.get("content-length")} bytes (fragmento NUNCA viaja al server, igual responde)`);
  console.assert(rA.status === 200 && rB.status === 200, "FAIL: sprite no 200 OK");
  const bA = Buffer.from(await rA.arrayBuffer());
  const bB = Buffer.from(await rB.arrayBuffer());
  console.assert(bA.length === bB.length && crypto.timingSafeEqual ? crypto.timingSafeEqual(bA, bB) : bA.equals(bB), "FAIL: contenido distinto entre con/sin fragmento");
}

console.log("");
console.log("✅ Fin análisis determinismo + #xywh preservation");
