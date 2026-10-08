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
const assertOk = (cond, msg) => {
  console.log(`${cond ? "✅" : "❌"} ${msg}`);
  if (!cond) process.exitCode = 1;
};

const r1 = await fetch(`${API}/anime/170130/2?key=${encodeURIComponent(KEY)}`);
const inner = tryDecEnv(await r1.json());
const rean = inner.streams.find(s => (s.originalProvider || "").startsWith("reanime"));
console.log("reanime encontrado:", !!rean);

// Hit thumbnailVttProxy
const vttResp = await fetch(rean.thumbnailVttProxy);
assertOk(vttResp.status === 200, "VTT status=200");
const vtt = await vttResp.text();
const sprites = [...vtt.matchAll(/(http:\/\/localhost:8000\/fetch\?s=([A-Za-z0-9_\-]+))/g)].map(m => ({ line: m[1], tok: m[2] }));
console.log(`Sprites totales encontrados: ${sprites.length}`);

// Map: token -> listado de lineas donde aparece
const byToken = new Map();
const byAbsUrl = new Map();

// Usamos unseal para saber cuál es la URL absoluta del sprite.
const secret = process.env.PROXY_SEAL_SECRET || process.env.API_ENCRYPT_KEY || "";
const key2 = crypto.createHash("sha256").update(secret).digest().subarray(0, 32);
function tryUnseal(tok) {
  try {
    const raw = b64urlToBuf(tok); const iv = raw.subarray(0, 12); const tag = raw.subarray(raw.length - 16);
    const ct = raw.subarray(12, raw.length - 16);
    const d = crypto.createDecipheriv("aes-256-gcm", key2, iv); d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8"));
  } catch { return null; }
}

let unsealFails = 0;
for (const s of sprites) {
  byToken.set(s.tok, (byToken.get(s.tok) || 0) + 1);
  const u = tryUnseal(s.tok);
  if (!u) { unsealFails++; continue; }
  const abs = u.url;
  if (!byAbsUrl.has(abs)) byAbsUrl.set(abs, new Set());
  byAbsUrl.get(abs).add(s.tok);
}
console.log(`Tokens /fetch?s= únicos distintos (por sprite): ${byToken.size}`);
console.log(`Fallos de unseal: ${unsealFails}`);
console.log(`Sprites (URLs absolutas imagenes) distintos: ${byAbsUrl.size}`);
console.log("");

// El TEST CLAVE: cada URL absoluta distinta (cada archivo sprite_0.webp único)
// debería tener EXACTAMENTE 1 token único. Si hay >=2, hay colisión de IV.
let conColisiones = 0;
const ejemploColisiones = [];
for (const [abs, tokens] of byAbsUrl.entries()) {
  if (tokens.size > 1) {
    conColisiones++;
    if (ejemploColisiones.length < 3) ejemploColisiones.push({ abs, distinctTokens: tokens.size, previewFirst: [...tokens][0].slice(0, 60), previewSecond: [...tokens][1].slice(0, 60) });
  }
}

// Ahora cuantos sprites APUNTAN a la MISMA imagen (misma abs url).
// Esto es: cada sprite_0.webp se referencia 20 veces. Todas esas veces deberían
// tener el MISMO token (byToken.size debe ser ~= byAbsUrl.size).
const repeticionesPorImg = [...byAbsUrl.values()].map(set => {
  // tokens.size = 1 (bien) si todo es deterministico. Después cuento
  // cuántas líneas apuntan a esta abs url:
  const abs = [...byAbsUrl.entries()].find(([, s]) => s === set)?.[0];
  const repeticiones = sprites.filter(s => tryUnseal(s.tok)?.url === abs).length;
  return { abs, repeticiones, tokensDistintos: set.size };
}).filter(x => x.repeticiones > 1).sort((a, b) => b.repeticiones - a.repeticiones);

console.log(`Sprites referenciados MÁS DE UNA VEZ: ${repeticionesPorImg.length}`);
if (repeticionesPorImg.length) {
  console.log("Top 3 sprites más repetidos (misma img):");
  repeticionesPorImg.slice(0, 3).forEach(r => console.log(`   repeticiones=${r.repeticiones} tokensDistintos=${r.tokensDistintos} url=${r.abs.slice(0,130)}...`));
}
console.log("");

console.log(`=== RESULTADO: Imágenes con >= 2 TOKENS DISTINTOS (si>0 => BUG!): ${conColisiones}`);
assertOk(conColisiones === 0, `Sin colisiones de IV: misma imagen = Mismo token (esperado 0, encontrados ${conColisiones})`);

if (ejemploColisiones.length) {
  console.log("Ejemplos colisiones (BUG):");
  ejemploColisiones.forEach(e => console.log(JSON.stringify(e, null, 2)));
}

// Extra: 2 respuestas IDÉNTICAS de thumbnailVttProxy a streams endpoint.
// Mismo episodio → mismo thumbnailVttProxy (mismo s=). Lo probamos:
const rA = await fetch(`${API}/anime/170130/2?key=${encodeURIComponent(KEY)}`);
const rB = await fetch(`${API}/anime/170130/2?key=${encodeURIComponent(KEY)}`);
const iA = tryDecEnv(await rA.json());
const iB = tryDecEnv(await rB.json());
const tpA = iA.streams.find(x=>(x.originalProvider||"").startsWith("reanime"))?.thumbnailVttProxy;
const tpB = iB.streams.find(x=>(x.originalProvider||"").startsWith("reanime"))?.thumbnailVttProxy;
console.log("");
console.log("=== thumbnailVttProxy en 2 llamadas DISTINTAS al mismo episodio ===");
console.log("A:", (tpA||"").slice(0, 120)+"...");
console.log("B:", (tpB||"").slice(0, 120)+"...");
assertOk(!!tpA && tpA === tpB, "Mismo episodio → Mismo thumbnailVttProxy (token determinístico)");

console.log("");
console.log("FIN test determinismo sprites");
