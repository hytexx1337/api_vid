import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tryUnsealQueryPayload } from "../src/lib/proxy-seal.js";

// ── cargar .env (igual que otros tests) ─────────────────────────────────────
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
} catch {}

const BASE = process.env.TEST_API_URL || "http://localhost:8000";
const KEY  = process.env.TEST_API_KEY || "Monitor1337!";

// ── 1) Prueba unitaria regex de sprite VTT ──────────────────────────────────
console.log("=== 1) Parser regex sprite VTT (sintético) ===");
const regex = /^([\w./-][^\s#"'<>|]*?\.(?:webp|jpg|jpeg|png)(#[^\s]*)?)$/gim;
const sample = `WEBVTT

NOTE This is a thumbnail VTT file

00:00:00.000 --> 00:00:05.000
thumbnails/sprite_0.webp#xywh=0,0,160,90

00:00:05.000 --> 00:00:10.000
thumbnails/sprite_0.webp#xywh=160,0,160,90

00:00:10.000 --> 00:00:15.000
./sprites/sprite-1.jpg#xywh=0,0,160,90

00:00:15.000 --> 00:00:20.000
../sprites/other.png
`;
let hits = [];
sample.replace(regex, (m) => { hits.push(m); return m; });
console.log("  sprites capturados:", hits.length, "→", hits);
const esperados = [
  "thumbnails/sprite_0.webp#xywh=0,0,160,90",
  "thumbnails/sprite_0.webp#xywh=160,0,160,90",
  "./sprites/sprite-1.jpg#xywh=0,0,160,90",
  "../sprites/other.png",
];
let ok_regex = esperados.length === hits.length && esperados.every((e, i) => e === hits[i]);
console.log(`  ${ok_regex ? "✅" : "❌"}  captura exacta`);

// ── 2) Ping server y prueba rutas alias ─────────────────────────────────────
console.log("\n=== 2) Alias routes: river.m3u8 == /flixcloud-m3u8 (legacy) ===");
const assertEqual = async (name, a, b) => {
  const ok = a === b;
  console.log(`  ${ok ? "✅" : "❌"}  ${name} → ${a} ${ok ? "==" : "≠"} ${b}`);
};

// Ping
const ping = await (async () => { try { const r = await fetch(`${BASE}/healthz`); return r.status; } catch (e) { return "OFFLINE ("+e.code+")"; } })();
console.log("  server status:", ping, ping === 200 || ping === 404 || ping === 401 ? "OK" : "");

// Test alias handler: usar una URL dummy con ?u= legacy + también con ?s=
// Para no pegarle a un flixcloud real (403 si el token no sirve), solo probamos
// que AMBAS rutas rechacen igualmente cuando la URL es basura → mismo código.
const dummy = `${BASE}/river.m3u8?u=http%3A%2F%2Finvalid-host-xyz.test%2Fx.m3u8`;
const dummyLeg = `${BASE}/flixcloud-m3u8?u=http%3A%2F%2Finvalid-host-xyz.test%2Fx.m3u8`;
try {
  const [rA, rB] = await Promise.all([
    fetch(dummy).then(r => r.status),
    fetch(dummyLeg).then(r => r.status)
  ]);
  console.log(`  /river.m3u8     (invalid) → ${rA}`);
  console.log(`  /flixcloud-m3u8 (invalid) → ${rB}`);
  console.log(`  ${rA === rB ? "✅" : "❌"}  ambas rutas devuelven mismo status (handler compartido OK)`);
} catch (e) {
  console.log("  ⚠  offline:", e.code);
}

// ── 3) Pequeño test de /fetch re-escribiendo VTT (con una URL flixcloud real ─
//    de las que devuelve el streams endpoint si existe reanime, o si no, mock).
console.log("\n=== 3) /anime listado buscando uno con reanime-HD... ===");
const candidatos = [
  "/anime/21/1",         // attack on titan / one punch / genérico
  "/anime/170130/2",     // el tuyo actual
  "/anime/164958/1",     // boku no hero
  "/anime/1535/1",       // death note
  "/anime/31964/1",      // boku no hero S1
];
let hitReanime = null;
for (const p of candidatos) {
  try {
    const r = await fetch(`${BASE}${p}?key=${encodeURIComponent(KEY)}`);
    if (r.status !== 200) continue;
    const j = await r.json();
    const streams = j.streams || (j.encrypted === true ? [] : []);
    const re = streams.find(s => String(s.originalProvider || "").startsWith("reanime"));
    if (re) {
      hitReanime = { path: p, stream: re, full: j };
      console.log(`  ✅  ${p} → originalProvider=${re.originalProvider}, proxy_url=${(re.proxy_url||"").slice(0, 90)}...`);
      break;
    }
  } catch {}
}

if (hitReanime) {
  const { path, stream, full } = hitReanime;
  console.log("\n=== 4) Validaciones leak en stream reanime ===");
  const pu = stream.proxy_url || "";
  console.log("  proxy_url usa /river.m3u8 ? :", /\/river\.m3u8(\?|#|$)/.test(pu));
  console.log("  proxy_url NO contiene 'flixcloud' en path :", !/\/flixcloud/.test(pu.split("?")[0]));
  const qp = new URL(pu).searchParams.get("s");
  if (qp) {
    const inner = tryUnsealQueryPayload(qp);
    console.log("  s= descifra? :", !!(inner && inner.u));
    if (inner) console.log("     → audio=", inner.audio, "k?=", inner.k ? "present" : "null", "u preview=", inner.u.slice(0, 70));
  }
  // Validar thumbnailVttProxy si existe:
  const tvp = stream.thumbnailVttProxy || "";
  if (tvp && tvp.includes("/fetch")) {
    const q = new URL(tvp).searchParams;
    if (q.get("s")) {
      const inner = tryUnsealQueryPayload(q.get("s"));
      console.log(`  thumbnailVttProxy s= descifra? : ${!!(inner && inner.url)} ct=${inner?.ct} ref=${inner?.ref}`);
    } else if (q.get("url")) {
      console.log(`  thumbnailVttProxy usa ?url= (legacy) → ${q.get("url").slice(0, 70)}`);
    }
    // Ahora probamos GETear el thumbnailVttProxy y ver si CONTIENE sprites
    // relativos reescritos a /fetch s=
    console.log("\n=== 5) GET thumbnailVttProxy → rewrite sprites a /fetch s= ===");
    try {
      const r = await fetch(tvp);
      console.log("  status:", r.status, "ct:", r.headers.get("content-type"));
      if (r.status === 200) {
        const txt = await r.text();
        const head = txt.split("\n").slice(0, 15).join("\n");
        console.log("  preview:\n" + head.split("\n").map(l => "   " + l).join("\n"));
        // Regex en VTT de salida para detectar sprites relativos NO reescritos
        const leftovers = txt.match(/^[./]?[\w./-]*\.(webp|jpg|jpeg|png)(#[^\s]*)?$/gim) || [];
        if (leftovers.length === 0) console.log("  ✅  0 sprites relativos restantes → todos reescritos a /fetch");
        else console.log("  ❌  leftovers =", leftovers.slice(0, 5));
        // Contar lineas con /fetch?s= para confirmar
        const rewrites = (txt.match(/\/fetch\?s=/g) || []).length;
        console.log(`  ✔  líneas con /fetch?s= : ${rewrites}`);
      }
    } catch (e) {
      console.log("  ⚠  GET falló:", e.code, e.message);
    }
  }
} else {
  console.log("  ⚠  ningún candidato tuvo reanime con data hoy (saltando live-test VTT)");
}

console.log("\n=== DONE ===");
process.exit(ok_regex ? 0 : 2);
