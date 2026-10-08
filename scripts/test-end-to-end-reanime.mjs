import crypto from "node:crypto";
const API = "http://localhost:8000";
const KEY = process.env.TEST_API_KEY || "Monitor1337!";

function b64urlToBuf(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}
function tryDecryptEnv(body) {
  if (!body || body.encrypted !== true) return body;
  const iv = b64urlToBuf(body.iv); const dek = b64urlToBuf(body.key);
  const raw = b64urlToBuf(body.data); const tag = raw.subarray(raw.length - 16);
  const ct = raw.subarray(0, raw.length - 16);
  const d = crypto.createDecipheriv("aes-256-gcm", dek, iv); d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8"));
}
function secret() { return process.env.PROXY_SEAL_SECRET || process.env.API_ENCRYPT_KEY || ""; }
function key() { return crypto.createHash("sha256").update(secret()).digest().subarray(0, 32); }
function unseal(tok) {
  try {
    const raw = b64urlToBuf(tok); const iv = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16); const ct = raw.subarray(12, raw.length - 16);
    const d = crypto.createDecipheriv("aes-256-gcm", key(), iv); d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8"));
  } catch { return null; }
}
const assertEq = (a, b, msg) => {
  const ok = a === b;
  console.log(`${ok ? "✅" : "❌"} ${msg}  actual=${JSON.stringify(a)} esperado=${JSON.stringify(b)}`);
  if (!ok) process.exitCode = 1;
  return ok;
};
const assertLike = (cond, msg) => {
  console.log(`${cond ? "✅" : "❌"} ${msg}`);
  if (!cond) process.exitCode = 1;
  return cond;
};

// (1) Hit /anime/170130/2 y descifrar envelope
const r1 = await fetch(`${API}/anime/170130/2?key=${encodeURIComponent(KEY)}`);
assertEq(r1.status, 200, "[1] /anime status 200");
const envelope = await r1.json();
const inner = tryDecryptEnv(envelope);
console.log("    envelope?", !!envelope.encrypted, "streams:", inner.streams?.length, "downloads:", inner.downloads?.length);

// (2) Labels display streams (no CPT CDN, deben ser RIVER/RACING/BOCA/zenkai...)
for (const s of inner.streams || []) {
  console.log(`    stream provider=[${s.provider}] original=[${s.originalProvider}] lang=${s.lang}`);
}
const hayCptCDN = (inner.streams || []).some(s => /CPT CDN/i.test(s.provider || ""));
assertLike(hayCptCDN === false, "[2] No aparece 'CPT CDN' en labels display providers");

// (3) Downloads: NO "sealed:" scheme, SÍ empiezan por /dl?x=, server = RIVER/BOCA/RACING...
for (const d of inner.downloads || []) {
  const isSealed = String(d.url || "").startsWith("sealed:");
  const isDlShort = String(d.url || "").includes("/dl?x=");
  console.log(`    dl server=[${d.server}] url=${isSealed?"SEALED❌":isDlShort?"/dl?x= ✅":"OTRO"}  → urlPreview=${String(d.url).slice(0,80)}${String(d.url).length>80?"...":""}`);
  assertLike(!isSealed, `[3a] url NO tiene 'sealed:' scheme → server=${d.server}`);
  assertLike(isDlShort, `[3b] url usa /dl?x= shortener → server=${d.server}`);
}

// (4) Endpoint /dl?x= real: hit real /dl SIN API key, comprobar 302 Location:
const reanimeDl = (inner.downloads || []).find(d => d.server === "RIVER");
if (reanimeDl) {
  console.log("\n[4] Probando shortlink /dl real redirect (no seguimos redirect):");
  const r2 = await fetch(reanimeDl.url, { redirect: "manual" });
  console.log("    status:", r2.status, "location:", r2.headers.get("location")?.slice(0, 120) + ((r2.headers.get("location")?.length || 0) > 120 ? "..." : ""));
  console.log("    pragma:", r2.headers.get("pragma"));
  console.log("    cache-control:", r2.headers.get("cache-control"));
  assertEq(r2.status, 302, "[4a] /dl?x= devuelve 302");
  const loc = r2.headers.get("location") || "";
  assertLike(/^https?:\/\//i.test(loc), "[4b] Location es URL absoluta (flixcloud u host descarga)");
  assertLike(!/sealed/i.test(loc), "[4c] Location no tiene 'sealed'");

  // (5) /dl/info?x= JSON con URL unsealada
  const infoUrl = reanimeDl.url.replace(/\/dl(\?|\/info\?)/, "/dl/info$1");
  const r3 = await fetch(infoUrl, { redirect: "manual" });
  console.log("\n[5] /dl/info status:", r3.status, "ct:", r3.headers.get("content-type"));
  assertEq(r3.status, 200, "[5a] /dl/info status 200");
  const infoJson = r3.status === 200 ? await r3.json() : null;
  if (infoJson) {
    console.log("    info:", JSON.stringify(infoJson).slice(0, 250));
    assertLike(/^https?:\/\//.test(infoJson.url), "[5b] info.url es URL absoluta descifrada");
  }
} else {
  console.log("    no hay reanime downloads, saltando /dl test");
}

// (6) Hits sprite thumbnails real (los primeros 3 sprites del VTT reescrito):
const rean = (inner.streams || []).find(s => (s.originalProvider || "").startsWith("reanime"));
if (rean?.thumbnailVttProxy) {
  const rvtt = await fetch(rean.thumbnailVttProxy);
  console.log(`\n[6] VTT thumbnails reescrito status=${rvtt.status} ct=${rvtt.headers.get("content-type")}`);
  assertEq(rvtt.status, 200, "[6a] VTT fetch 200");
  const vtt = await rvtt.text();
  const sprites = [...vtt.matchAll(/(http:\/\/localhost:8000\/fetch\?s=([A-Za-z0-9_\-]+))/g)].map(m => ({ full: m[1], tok: m[2] }));
  console.log(`    sprites sellados totales=${sprites.length}`);
  assertLike(sprites.length > 3, `[6b] >3 sprites reescritos /fetch?s= (encontrados=${sprites.length})`);
  for (let i = 0; i < Math.min(2, sprites.length); i++) {
    const sp = sprites[i];
    const u = unseal(sp.tok);
    console.log(`    Spr #${i} descifrado → ${u ? u.url.slice(0,140)+"..." : "invalido"}`);
    const rsp = await fetch(sp.full);
    console.log(`    Spr #${i} status=${rsp.status} ct=${rsp.headers.get("content-type")} len=${rsp.headers.get("content-length")}`);
    assertEq(rsp.status, 200, `[6c] sprite #${i} status 200`);
    const ctOk = /image\/webp/i.test(rsp.headers.get("content-type") || "");
    assertLike(ctOk, `[6d] sprite #${i} content-type=image/webp`);
    if (rsp.status === 200) {
      const buf = Buffer.from(await rsp.arrayBuffer());
      const isWebp = buf.length >= 12 && buf.toString("utf8",0,4)==="RIFF" && buf.toString("utf8",8,12)==="WEBP";
      assertLike(isWebp, `[6e] sprite #${i} ${buf.length} bytes RIFF WEBP header OK`);
    }
  }
}

// (7) leaks generales flat JSON descifrado:
const flat = JSON.stringify(inner);
const tests = [
  { name: "no 'flixcloud.cc' crudo en flat JSON", re: /flixcloud\.cc/i },
  { name: "no '?u=https://' crudo", re: /(\?u=|\&u=)https?/i },
  { name: "no '?url=https://' crudo", re: /(\?url=|\&url=)https?/i },
  { name: "no 'sealed:' scheme en urls de descarga", re: /"url"\s*:\s*"sealed:/g },
  { name: "no 'CPT CDN' crudo en labels providers", re: /"provider"\s*:\s*"CPT CDN/i },
];
for (const t of tests) {
  const hay = t.re.test(flat);
  console.log(`${hay ? "❌" : "✅"} [7] ${t.name}: ${hay ? "HAY LEAK" : "OK"}`);
  if (hay) process.exitCode = 1;
}

console.log("\nFIN");
