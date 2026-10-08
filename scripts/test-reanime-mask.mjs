import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── cargar .env manual sin dep de dotenv ────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, "..", ".env");
try {
  const raw = fs.readFileSync(envPath, "utf8");
  for (const ln of raw.split(/\r?\n/)) {
    const l = ln.trim();
    if (!l || l.startsWith("#")) continue;
    const eq = l.indexOf("=");
    if (eq <= 0) continue;
    let k = l.slice(0, eq).trim();
    let v = l.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
} catch (_) { /* ignorar si no existe .env */ }

import {
  sealProxyPath,
  unsealProxyPath,
  sealQueryPayload,
  tryUnsealQueryPayload,
  sealedQueryParam,
  maskRawUrl,
  unmaskRawUrl,
} from "../src/lib/proxy-seal.js";

const passed = [];
const failed = [];
const assert = (name, cond, detail = "") => {
  const info = { name, ok: !!cond, detail };
  if (cond) passed.push(info); else failed.push(info);
  console.log(`  ${cond ? "✅" : "❌"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

console.log("=== 1) sealQueryPayload / tryUnsealQueryPayload (AES-GCM PROXY_SEAL_SECRET) ===");
const P1 = { u: "https://fetch8.flixcloud.cc/_v7/abc/master.m3u8?token=XYZ123", audio: "jpn", k: "/zp2k9thBZg==" };
const tok = sealQueryPayload(P1);
console.log("  token preview:", tok.slice(0, 60) + "...");
assert("token es string base64url largo", typeof tok === "string" && tok.length > 40, `len=${tok.length}`);
assert("token NO contiene 'flixcloud'", !/flixcloud/i.test(tok));
assert("token NO contiene 'https://'", !/https?:\/\//i.test(tok));
const u1 = tryUnsealQueryPayload(tok);
assert("unseal OK", u1 && typeof u1 === "object");
assert("u1.u === P1.u", u1.u === P1.u);
assert("u1.audio === jpn", u1.audio === "jpn");
assert("u1.k igual", u1.k === P1.k);
const u2 = tryUnsealQueryPayload(tok + "basura");
assert("corrupt → null", u2 === null);
const u3 = tryUnsealQueryPayload(null);
assert("null → null", u3 === null);
const u4 = tryUnsealQueryPayload("");
assert("empty → null", u4 === null);
// Misma key → mismo payload != tokens (IV random)
const tokB = sealQueryPayload(P1);
assert("mismo payload, 2 tokens DISTINTOS", tok !== tokB, `A=${tok.slice(0,20)} B=${tokB.slice(0,20)}`);
const uB = tryUnsealQueryPayload(tokB);
assert("ambos tokens descifran al mismo objeto", JSON.stringify(uB) === JSON.stringify(u1));

console.log("\n=== 2) sealedQueryParam (URL safe) ===");
const qs = sealedQueryParam(P1);
assert("empieza con s=", qs.startsWith("s="));
const parsed = new URLSearchParams(qs).get("s");
assert("parsed OK", !!parsed);
const uQ = tryUnsealQueryPayload(parsed);
assert("parsed s= unsealed OK", uQ && uQ.u === P1.u);
// NO contiene leaks visibles
assert("qs NO tiene flixcloud", !/flixcloud/i.test(qs));
assert("qs NO tiene token=XYZ", !/XYZ123/.test(qs));
assert("qs NO tiene audio=jpn crudo", !/audio=jpn/.test(qs));

console.log("\n=== 3) maskRawUrl / unmaskRawUrl ===");
const RAW = "https://fetch8.flixcloud.cc/_v7/XYZ/master.m3u8?token=SECRETO";
const masked = maskRawUrl(RAW);
assert("masked empieza sealed:", masked.startsWith("sealed:"));
assert("masked NO tiene flixcloud crudo", !masked.includes("flixcloud.cc"));
assert("masked NO tiene token=SECRETO crudo", !masked.includes("SECRETO"));
const unmasked = unmaskRawUrl(masked);
assert("roundtrip OK", unmasked === RAW);
assert("passthrough → string normal = identity", unmaskRawUrl("hola") === "hola");
assert("passthrough → null", unmaskRawUrl(null) === null);
assert("passthrough → number (falsy no string)", unmaskRawUrl(42) === 42);

console.log("\n=== 4) Compatibilidad con sealProxyPath existente (no rompimos nada) ===");
const pp = "/flixcloud-m3u8?u=hola&audio=jpn";
const se = sealProxyPath(pp);
const us = unsealProxyPath(se);
assert("sealProxyPath → unsealProxyPath idem", us === pp);
const se2 = sealProxyPath(pp);
assert("sealProxyPath DETERMINÍSTICO (mismo IV sha256) → mismo token", se === se2);

console.log("\n=== 5) Simulación completa: player descarta leaks en campos reanime ===");
const fakeStream = {
  url: maskRawUrl(RAW),
  proxy_url: "http://localhost:8000/flixcloud-m3u8?" + sealedQueryParam({ u: RAW, audio: "jpn" }),
  thumbnailVtt: maskRawUrl("https://fetch8.flixcloud.cc/thumbnails_vtt/abc"),
  thumbnailVttProxy: "http://localhost:8000/fetch?" + sealedQueryParam({ url: "https://fetch8.flixcloud.cc/thumbnails_vtt/abc", ref: "https://flixcloud.cc/", ct: "text/vtt" }),
};
const flat = JSON.stringify(fakeStream);
console.log("  preview flat JSON:", flat.slice(0, 300) + "...");
assert("flat NO contiene 'flixcloud.cc' CRUDO en url/tumbnailVtt",
  // Las rutas /flixcloud-m3u8 SON nombres internos, así que 'flixcloud-m3u8' puede aparecer
  // Pero 'flixcloud.cc' NO debe aparecer en crudo
  !/(?<!flixcloud\-m3u8)(flixcloud\.cc)/i.test(flat.replace(/flixcloud\-m3u8|flixcloud-seg/g, ""))
);
assert("flat NO contiene SEARCH PARAM tipo '?u=https://'", !/\?u=https?:\/\//i.test(flat));
assert("flat NO contiene '?url=https://'", !/\?url=https?:\/\//i.test(flat));
assert("flat NO contiene token=SECRETO", !flat.includes("SECRETO"));

// Validar que todos los sealed: tokens descifran OK
for (const k of ["url", "thumbnailVtt"]) {
  if (fakeStream[k].startsWith("sealed:")) {
    const inner = tryUnsealQueryPayload(fakeStream[k].slice(7));
    assert(`campo ${k}: sealed → descifra`, inner && typeof inner.u === "string", inner?.u?.slice(0, 40));
  }
}
for (const k of ["proxy_url", "thumbnailVttProxy"]) {
  const u = new URL(fakeStream[k]);
  const s = u.searchParams.get("s");
  assert(`campo ${k}: query s= existente`, !!s, s ? s.slice(0, 30) + "..." : "MISSING");
  if (s) {
    const inner = tryUnsealQueryPayload(s);
    assert(`campo ${k}: s= descifra objeto`, inner && (inner.u || inner.url), inner ? JSON.stringify(inner).slice(0, 80) : "null");
  }
}

console.log("\n=== 6) Request real HTTP (si server levantado y TEST_API_URL seteado) ===");
const TEST_API_URL = process.env.TEST_API_URL || "http://localhost:8000";
const TEST_API_KEY = process.env.TEST_API_KEY || "Monitor1337!";
const ANIME_PATH = process.env.TEST_ANIME_PATH || "/anime/170130/2";
async function httpTest() {
  try {
    const r = await fetch(`${TEST_API_URL}${ANIME_PATH}?key=${TEST_API_KEY}`);
    if (r.status !== 200) {
      console.log(`  ⚠  status=${r.status} — salteando HTTP smoke test`);
      const t = await r.text();
      console.log("  body preview:", t.slice(0, 200));
      return;
    }
    const json = await r.json();
    const body = json.encrypted === true ? (() => {
      const b = (s) => Buffer.from(s, "base64url");
      const iv = b(json.iv), dek = b(json.key), raw = b(json.data);
      const ct = raw.subarray(0, raw.length - 16);
      const tag = raw.subarray(raw.length - 16);
      const d = crypto.createDecipheriv("aes-256-gcm", dek, iv);
      d.setAuthTag(tag);
      return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8"));
    })() : json;

    if (!Array.isArray(body.streams)) {
      console.log("  ⚠  streams no es array — salteando leak check");
      return;
    }
    const reanime = body.streams.filter(s => String(s.originalProvider || "").startsWith("reanime"));
    if (!reanime.length) {
      console.log("  ⚠  no hay streams reanime en este episodio — salteando leak check");
      return;
    }
    console.log(`  encontrados ${reanime.length} streams reanime; chequeando leaks...`);
    let allFlat = "";
    for (const s of reanime) allFlat += JSON.stringify(s);
    for (const dl of (body.downloads || [])) allFlat += JSON.stringify(dl);
    for (const t of (body.tracks || [])) allFlat += JSON.stringify(t);

    // Check 1: NO url/token crudos visible
    const BAD1 = allFlat.match(/https?:\/\/[^\s"']*flixcloud\.cc[^\s"']*/g);
    const BAD2 = allFlat.match(/[?&](u|url)=https?/g);
    assert("NO hay URLs crudas flixcloud.cc", !BAD1, BAD1 ? BAD1.slice(0,3).join(" | ") : "ok");
    assert("NO hay ?u=http ni ?url=http crudos en proxy_fallback", !BAD2, BAD2 ? BAD2.slice(0,5).join(" | ") : "ok");

    // Check 2: sealed: tokens y s= parsean OK
    let sealedCount = 0, parsedSealed = 0;
    for (const m of (allFlat.match(/sealed:[A-Za-z0-9_\-]+/g) || [])) {
      sealedCount++;
      const inner = tryUnsealQueryPayload(m.slice(7));
      if (inner && typeof inner.u === "string") parsedSealed++;
    }
    if (sealedCount) assert(`sealed: tokens parseables OK (${parsedSealed}/${sealedCount})`, parsedSealed === sealedCount);
    else console.log("  (sin sealed: tokens en este payload — todo OK)");

    let sCount = 0, parsedS = 0;
    for (const m of (allFlat.match(/s=([A-Za-z0-9_\-~%.]+)/g) || [])) {
      const tok = decodeURIComponent(m.slice(2));
      sCount++;
      const inner = tryUnsealQueryPayload(tok);
      if (inner && (inner.u || inner.url)) parsedS++;
    }
    if (sCount) assert(`s= tokens parseables OK (${parsedS}/${sCount})`, parsedS === sCount);
  } catch (e) {
    if (/ECONNREFUSED/i.test(e.message)) console.log("  ⚠  server NO levantado — salteando");
    else {
      assert("HTTP test falló inesperadamente", false, `${e.code||""} ${e.message}`);
    }
  }
}
if (process.env.RUN_HTTP_TEST === "1" || true) {
  await httpTest();
}

// Resumen
console.log("\n" + "═".repeat(60));
console.log(`PASSED: ${passed.length}  |  FAILED: ${failed.length}`);
console.log("═".repeat(60));
for (const f of failed) console.log("  ✗", f.name, f.detail ? `→ ${f.detail}` : "");
process.exit(failed.length ? 1 : 0);
