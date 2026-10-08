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

for (const [name, url] of Object.entries({
  "Frieren 170130 ep 2": `${API}/anime/170130/2?key=${encodeURIComponent(KEY)}`,
  "Catgirl Meets Sword 139587 ep 1": `${API}/anime/139587/1?key=${encodeURIComponent(KEY)}`,
})) {
  console.log(`\n========== ${name} ==========`);
  const r = await fetch(url);
  const inner = tryDecEnv(await r.json());
  console.log("status:", r.status, " streams:", inner.streams?.length, " downloads:", inner.downloads?.length);
  console.log("Orden final (posicion / originalProvider / lang / display provider):");
  (inner.streams || []).forEach((s, i) => {
    const idx = String(i + 1).padStart(2, "0");
    console.log(`   #${idx}  ${(s.originalProvider || "").padEnd(18," ")}  ${(s.lang || "???").padEnd(12," ")}  → provider=[${s.provider}]  type=${s.type} q=${s.quality}`);
  });

  // Validación orden según regla. Espero que si hay zenkai aparezca ANTES que
  // reanime, que aparezca antes que megaplay, que aparezca antes que miruro.
  const ranks = { zenkai: 1, reanime: 2, megaplay: 3, miruro: 4, animeav1: 5 };
  let lastRank = 0;
  let ok = true;
  for (const s of inner.streams || []) {
    const op = String(s.originalProvider || "").toLowerCase();
    let thisRank = 99;
    for (const [k, v] of Object.entries(ranks)) if (op.startsWith(k)) { thisRank = v; break; }
    // Dentro del mismo provider, el orden de idioma tiene que ser ENG-DUB primero.
    // Esto lo chequeamos solo mostrando.
    if (thisRank < lastRank) {
      console.log(`   ❌ FAIL orden: ${s.originalProvider} (rank ${thisRank}) aparece DESPUÉS de un provider rank ${lastRank}.`);
      ok = false;
    }
    if (thisRank > lastRank) lastRank = thisRank;
  }
  if (ok) console.log("   ✅ Orden providers general (zenkai → reanime → megaplay → miruro → ...) correcto.");
}
console.log("\nFin.");
