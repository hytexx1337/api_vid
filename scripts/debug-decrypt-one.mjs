import crypto from "node:crypto";
const STREAM_ENVELOPE_CIPHER = "aes-256-gcm";
const STREAM_ENVELOPE_TAG_LEN = 16;
const b64u = (s) => Buffer.from(String(s), "base64url");

const URL = process.argv[2] || "http://localhost:8000/anime/170130/2?key=Monitor1337!";
console.log("Fetch →", URL, "\n");

try {
  const r = await fetch(URL);
  console.log("HTTP status       :", r.status);
  console.log("Content-Type      :", r.headers.get("content-type"));
  console.log("Cache-Control     :", r.headers.get("cache-control"));
  console.log("Pragma            :", r.headers.get("pragma"));
  console.log("Surrogate-Control :", r.headers.get("surrogate-control"));
  console.log("Expires           :", r.headers.get("expires"));
  const raw = await r.text();
  let body;
  try { body = JSON.parse(raw); } catch {
    console.log("\n❌ Body no es JSON. Preview:", raw.slice(0, 300));
    process.exit(1);
  }

  if (!body || body.encrypted !== true) {
    console.log("\n── PAYLOAD SIN CIFRAR (cifrado desactivado, o ruta no lo soporta) ──");
    console.log("Top-level keys:", Object.keys(body || {}));
    if (body?.error) console.log("  error:", body.error);
    if (Array.isArray(body?.streams)) console.log("  streams.length:", body.streams.length);
    if (Array.isArray(body?.tracks)) console.log("  tracks.length:", body.tracks.length);
    if (Array.isArray(body?.downloads)) console.log("  downloads.length:", body.downloads.length);
    if (body?.anilistId) console.log("  anilistId:", body.anilistId);
    if (body?.episode) console.log("  episode:", body.episode);
    if (body?.streams?.[0]) {
      const s = body.streams[0];
      console.log("  streams[0].originalProvider:", s.originalProvider);
      console.log("  streams[0].lang:", s.lang);
      console.log("  streams[0].proxy_url preview:", (s.proxy_url || "").slice(0, 100));
    }
    process.exit(0);
  }

  console.log("\n── ENVELOPE CRUDO (cifrado ACTIVO) ──");
  console.log("  encrypted :", body.encrypted);
  console.log("  alg       :", body.alg);
  console.log("  iv        :", body.iv.slice(0, 20) + "... (len=" + body.iv.length + ")");
  console.log("  key (DEK) :", body.key.slice(0, 20) + "... (len=" + body.key.length + ")");
  console.log("  data      :", "(len=" + body.data.length + " chars base64url)");
  if (body.exp) console.log("  exp       :", new Date(body.exp * 1000).toISOString(), `(${body.exp})`);

  const iv = b64u(body.iv);
  const dek = b64u(body.key);
  const data = b64u(body.data);
  console.log("\n── BYTE CHECKS ──");
  console.log("  IV len  :", iv.length, "(debe ser 12)");
  console.log("  DEK len :", dek.length, "(debe ser 32 = AES-256)");
  console.log("  data len:", data.length, "(debe ser > 16)");

  if (iv.length !== 12 || dek.length !== 32 || data.length <= 16) {
    throw new Error("longitudes inválidas en envelope");
  }

  const ciphertext = data.subarray(0, data.length - STREAM_ENVELOPE_TAG_LEN);
  const tag = data.subarray(data.length - STREAM_ENVELOPE_TAG_LEN);
  const decipher = crypto.createDecipheriv(STREAM_ENVELOPE_CIPHER, dek, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const dec = JSON.parse(plaintext.toString("utf8"));

  console.log("\n── ✅ PAYLOAD DESCIFRADO ──");
  console.log("  Top-level keys :", Object.keys(dec));
  for (const k of ["anilistId", "episode"]) if (dec[k] !== undefined) console.log(`  ${k.padEnd(15)}:`, dec[k]);
  for (const k of ["streams", "tracks", "downloads"]) if (Array.isArray(dec[k])) console.log(`  ${k.padEnd(15)}:`, dec[k].length, "items");
  if (dec.skip) console.log("  skip           :", JSON.stringify(dec.skip));
  if (dec.meta) console.log("  meta           :", JSON.stringify(dec.meta).slice(0, 150));

  if (Array.isArray(dec.streams) && dec.streams.length) {
    console.log("\n── Streams (primeros 4) ──");
    let i = 0;
    for (const s of dec.streams) {
      if (++i > 4) break;
      const parts = [];
      if (s.originalProvider) parts.push(`prov=${s.originalProvider}`);
      if (s.lang) parts.push(`lang=${s.lang}`);
      if (s.displayName) parts.push(`display=${s.displayName}`);
      if (s.proxy_url) parts.push(`proxy_url_preview=${s.proxy_url.slice(0, 60)}...`);
      console.log("  #" + i, parts.join(" | "));
    }
  }

  if (Array.isArray(dec.tracks) && dec.tracks.length) {
    console.log("\n── Subtitle tracks (primeros 4) ──");
    let i = 0;
    for (const t of dec.tracks) {
      if (++i > 4) break;
      const name = t.label || t.name || t.srclang || "unknown";
      const kind = t.kind || t.type || "subs";
      const has = [];
      if (t.file) has.push("file");
      if (t.proxy_file) has.push("proxy_file");
      if (t.url) has.push("url");
      console.log("  #" + i, kind, "→", name, has.length ? `(campos: ${has.join(",")})` : "(sin url)");
    }
  }

  if (Array.isArray(dec.downloads) && dec.downloads.length) {
    console.log("\n── Downloads ──");
    for (const d of dec.downloads) {
      console.log("  •", `lang=${d.lang || d.langLabel || "?"}`, `server=${d.server || "?"}`, `url_preview=${(d.url || "").slice(0, 60)}...`);
    }
  }

  console.log("\n✅ Descifrado OK — autenticidad AES-GCM + tag 16B verificada. Payload intacto.");
} catch (e) {
  if (e.cause?.code === "ECONNREFUSED" || /ECONNREFUSED/.test(e.message)) {
    console.log("\n❌ Servidor NO levantado en localhost:8000. Levantalo con: npm start");
  } else if (e.code === "ERR_CRYPTO_OPERATION_FAILED") {
    console.log("\n❌ Tag AES-GCM INVALIDA — el payload fue alterado, o key/iv no corresponden.");
  } else {
    console.log("\n❌ ERROR:", e.code || "", e.message);
    console.log(e.stack.split("\n").slice(0, 6).join("\n"));
  }
  process.exit(1);
}
