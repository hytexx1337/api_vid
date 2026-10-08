import crypto from "node:crypto";
const API = "http://localhost:8000";
const KEY = process.env.TEST_API_KEY || "Monitor1337!";
const b64d = s => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
function dec(b) {
  if (!b || b.encrypted !== true) return b;
  const iv = b64d(b.iv), dek = b64d(b.key), raw = b64d(b.data);
  const tag = raw.subarray(raw.length - 16), ct = raw.subarray(0, raw.length - 16);
  const d = crypto.createDecipheriv("aes-256-gcm", dek, iv); d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8"));
}

async function runTest(name, url) {
  console.log(`\n========== ${name} ==========`);
  const r = await fetch(url);
  const body = dec(await r.json());
  console.log("status:", r.status, " streams finales:", body.streams?.length);
  let typeMp4 = 0, typeHls = 0, typeOtros = 0, fixeadosReanime = 0;
  for (const s of body.streams || []) {
    const op = String(s.originalProvider || "");
    const isReanime = /^(reanime|flixcloud)($|[-/])/i.test(op);
    if (s.type === "hls") typeHls++;
    else if (s.type === "mp4") { typeMp4++; if (isReanime) fixeadosReanime++; }
    else typeOtros++;
    console.log(`   ${String(s.originalProvider || "").padEnd(22," ")}  ${String(s.lang || "").padEnd(12," ")}  type=[${String(s.type||"?").padEnd(4," ")}]  ${(s.proxy_url||"").slice(0,70)}${(s.proxy_url||"").length>70?"...":""}`);
  }
  console.log(`\nCuenta de types: hls=${typeHls}  mp4=${typeMp4}  otros=${typeOtros}`);
  console.log(`Streams de reanime-HD-2/flixcloud CON type=mp4 ERRÓNEO: ${fixeadosReanime}  ${fixeadosReanime === 0 ? "✅ 0, todo hls como corresponde" : "❌ TODAVÍA HAY"}`);
}

await runTest("Catgirl 139587/1", `${API}/anime/139587/1?key=${encodeURIComponent(KEY)}`);
await runTest("Frieren 170130/2", `${API}/anime/170130/2?key=${encodeURIComponent(KEY)}`);
