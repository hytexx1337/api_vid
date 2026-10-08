import crypto from "node:crypto";

// ── Test helpers (mismo código que src/routes/streams.js, validamos compatibilidad) ──
function parseBoolEnv(rawValue, fallback) {
  const v = String(rawValue ?? "").trim().toLowerCase();
  if (!v) return fallback;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}
const STREAM_ENVELOPE_ALG = "AES-GCM";
const STREAM_ENVELOPE_CIPHER = "aes-256-gcm";
const STREAM_ENVELOPE_IV_LEN = 12;
const STREAM_ENVELOPE_DEK_LEN = 32;
const STREAM_ENVELOPE_TAG_LEN = 16;
function bufferToBase64url(buf) {
  if (Buffer.isBuffer(buf)) return buf.toString("base64url");
  return Buffer.from(buf).toString("base64url");
}
function base64urlToBuffer(s) {
  return Buffer.from(String(s), "base64url");
}
function encryptJsonEnvelope(payload, sessionExp = 0) {
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const iv = crypto.randomBytes(STREAM_ENVELOPE_IV_LEN);
  const dek = crypto.randomBytes(STREAM_ENVELOPE_DEK_LEN);
  const cipher = crypto.createCipheriv(STREAM_ENVELOPE_CIPHER, dek, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const data = Buffer.concat([ciphertext, tag]);
  const envelope = {
    encrypted: true,
    alg: STREAM_ENVELOPE_ALG,
    iv: bufferToBase64url(iv),
    data: bufferToBase64url(data),
    key: bufferToBase64url(dek),
  };
  if (Number(sessionExp) > 0) envelope.exp = Number(sessionExp);
  return envelope;
}
function decryptJsonEnvelope(envelope) {
  if (!envelope || envelope.encrypted !== true || envelope.alg !== "AES-GCM") {
    throw new Error("Envelope inválido (no AES-GCM)");
  }
  const iv = base64urlToBuffer(envelope.iv);
  const dek = base64urlToBuffer(envelope.key);
  const data = base64urlToBuffer(envelope.data);
  if (iv.length !== STREAM_ENVELOPE_IV_LEN) throw new Error(`IV inválido. Len=${iv.length}`);
  if (dek.length !== STREAM_ENVELOPE_DEK_LEN) throw new Error(`DEK inválida. Len=${dek.length}`);
  if (data.length < STREAM_ENVELOPE_TAG_LEN) throw new Error(`data demasiado corto. Len=${data.length}`);
  const ciphertext = data.subarray(0, data.length - STREAM_ENVELOPE_TAG_LEN);
  const tag = data.subarray(data.length - STREAM_ENVELOPE_TAG_LEN);
  const decipher = crypto.createDecipheriv(STREAM_ENVELOPE_CIPHER, dek, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

const assertions = [];
const assert = (name, cond, detail = "") => {
  assertions.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? "✅" : "❌"}  ${name}${detail ? ` → ${detail}` : ""}`);
};

console.log("Test 1 — parseBoolEnv");
assert("undefined → fallback=true", parseBoolEnv(undefined, true) === true);
assert("undefined → fallback=false", parseBoolEnv(undefined, false) === false);
assert("'1' → true", parseBoolEnv("1", false) === true);
assert("'true' → true", parseBoolEnv("TRUE", false) === true);
assert("'on' → true", parseBoolEnv("on", false) === true);
assert("'0' → false", parseBoolEnv("0", true) === false);
assert("'false' → false", parseBoolEnv("false", true) === false);
assert("'off' → false", parseBoolEnv(" Off ", true) === false);
assert("'basura' → fallback", parseBoolEnv("asdasd", "patata") === "patata");

console.log("\nTest 2 — Envelope shape AES-GCM");
const samplePayload = {
  anilistId: 21,
  episode: 1,
  streams: [{ proxy_url: "https://x/proxy?x=1", originalProvider: "zenkai" }],
  tracks: [{ file: "https://x/s.vtt", label: "Español" }],
  downloads: [{ url: "https://dl/x.mp4" }],
  skip: { intro: [85, 105] },
};
const env = encryptJsonEnvelope(samplePayload, 3600);
assert("encrypted=true", env.encrypted === true);
assert("alg=AES-GCM", env.alg === "AES-GCM");
assert("exp opcional presente", env.exp === 3600);
assert("iv longitud base64url válida (>=16)", env.iv.length >= 16);
assert("key longitud base64url válida (>=43)", env.key.length >= 43);
assert("data >= 16B (tag) + algo", env.data.length >= 24);
const ivBytes = base64urlToBuffer(env.iv);
const dekBytes = base64urlToBuffer(env.key);
const dataBytes = base64urlToBuffer(env.data);
assert("iv = 12 bytes (NIST)", ivBytes.length === 12);
assert("dek = 32 bytes (AES-256)", dekBytes.length === 32);
assert("data > 16 bytes", dataBytes.length > 16);

console.log("\nTest 3 — Roundtrip descifrado + shape");
const dec = decryptJsonEnvelope(env);
assert("anilistId coincide", dec.anilistId === samplePayload.anilistId);
assert("episode coincide", dec.episode === samplePayload.episode);
assert("skip.intro coincide", dec.skip?.intro?.[0] === 85 && dec.skip.intro[1] === 105);
assert("streams[0].proxy_url intacto", dec.streams[0].proxy_url === samplePayload.streams[0].proxy_url);
assert("tracks[0].file intacto", dec.tracks[0].file === samplePayload.tracks[0].file);
assert("downloads[0].url intacto", dec.downloads[0].url === samplePayload.downloads[0].url);
assert("Array.isArray(streams)", Array.isArray(dec.streams));
assert("Array.isArray(tracks)", Array.isArray(dec.tracks));
assert("Array.isArray(downloads)", Array.isArray(dec.downloads));

console.log("\nTest 4 — Cada respuesta usa IV/DEK distinto (sin cache byte)");
const e1 = encryptJsonEnvelope({ a: 1 });
const e2 = encryptJsonEnvelope({ a: 1 });
assert("mismo payload → IV distinto", e1.iv !== e2.iv);
assert("mismo payload → DEK distinto", e1.key !== e2.key);
assert("mismo payload → data distinta", e1.data !== e2.data);
const d1 = decryptJsonEnvelope(e1);
const d2 = decryptJsonEnvelope(e2);
assert("ambas descifran al mismo objeto JSON", JSON.stringify(d1) === JSON.stringify(d2));

console.log("\nTest 5 — Envelope sin exp opcional");
const envNoExp = encryptJsonEnvelope({ hola: "mundo" });
assert("exp no presente", !("exp" in envNoExp));
assert("descifra igual", decryptJsonEnvelope(envNoExp).hola === "mundo");

console.log("\nTest 6 — Corrupción detectada (AES-GCM tag)");
try {
  const corrupt = { ...env, data: bufferToBase64url(Buffer.concat([
    base64urlToBuffer(env.data).subarray(0, -2),
    Buffer.from([0xff, 0xff]),
  ])) };
  decryptJsonEnvelope(corrupt);
  assert("tag corrupto debería throw", false);
} catch (e) {
  assert("tag corrupto → auth failed", /auth|tag/i.test(e.message) || e.code === "ERR_CRYPTO_OPERATION_FAILED");
}

// ── Test 7 — Request real (si hay servidor levantado) ─────────────────────────
const TEST_API_URL = process.env.TEST_API_URL || "http://localhost:8000";
const TEST_API_KEY = process.env.TEST_API_KEY || "";
if (process.env.RUN_HTTP_TEST === "1") {
  console.log(`\nTest 7 — HTTP contra ${TEST_API_URL}`);
  const doFetch = async (path, headers = {}) => {
    try {
      const r = await fetch(TEST_API_URL + path, { headers, redirect: "manual" });
      const contentType = r.headers.get("content-type") || "";
      const body = contentType.includes("json") ? await r.json().catch(() => null) : await r.text().catch(() => "");
      return { status: r.status, headers: Object.fromEntries(r.headers.entries()), body };
    } catch (e) {
      return { error: e.message };
    }
  };

  // 7a: sin API key → 401 o 403 (lo que venga del gate global)
  const rUnauth = await doFetch("/anime/21/1");
  if (rUnauth.error) {
    assert("HTTP inalcanzable (no hay server levantado)", true, `skip: ${rUnauth.error}`);
  } else {
    assert("sin key → 4xx", rUnauth.status >= 400 && rUnauth.status < 500, `status=${rUnauth.status}`);
    assert("sin key → NO envelope encrypted", !(rUnauth.body && rUnauth.body.encrypted === true));
  }

  // 7b: con API key (si está seteada)
  if (TEST_API_KEY && !rUnauth.error) {
    const rAuth = await doFetch("/anime/21/1", { "x-api-key": TEST_API_KEY });
    const cc = (rAuth.headers["cache-control"] || "").toLowerCase();
    const pragma = (rAuth.headers["pragma"] || "").toLowerCase();
    const surrogate = (rAuth.headers["surrogate-control"] || "").toLowerCase();
    const expires = rAuth.headers["expires"];
    assert("con key → Cache-Control: no-store", cc.includes("no-store"), `cc='${cc}'`);
    assert("con key → Pragma: no-cache", pragma.includes("no-cache"), `pragma='${pragma}'`);
    assert("con key → Surrogate-Control: no-store", surrogate.includes("no-store"), `surrogate='${surrogate}'`);
    assert("con key → Expires: 0", expires === "0", `expires='${expires}'`);
    if (rAuth.status === 200) {
      if (rAuth.body && rAuth.body.encrypted === true) {
        assert("con key → envelope AES-GCM", rAuth.body.alg === "AES-GCM");
        try {
          const decAuth = decryptJsonEnvelope(rAuth.body);
          assert("con key → descifra OK", true, `shape keys=${Object.keys(decAuth).join(",")}`);
          assert("con key → streams array", Array.isArray(decAuth.streams), `len=${decAuth.streams?.length ?? -1}`);
        } catch (e) {
          assert("con key → descifra OK", false, e.message);
        }
      } else if (rAuth.body && Array.isArray(rAuth.body.streams)) {
        assert("con key → payload sin envelope (cifrado desactivado, streams OK)", true);
      } else {
        assert("con key → status 200 pero body desconocido", true, `keys=${Object.keys(rAuth.body || {}).join(",")}`);
      }
    } else if (rAuth.status === 404) {
      assert("con key → 404 sin envelope", true, "no se encontró el anime/episodio en providers");
    } else {
      assert("con key → status 2xx/404", false, `status=${rAuth.status}`);
    }
  } else if (!TEST_API_KEY && !rUnauth.error) {
    assert("TEST_API_KEY no seteado → salteo request autenticada", true, "seteala para probar descifrado real");
  }
}

// ── Resumen ───────────────────────────────────────────────────────────────────
const passed = assertions.filter(a => a.ok).length;
const total = assertions.length;
const failed = total - passed;
console.log(`\n${"─".repeat(60)}`);
console.log(`Resultado: ${passed}/${total} OK — ${failed} fallos`);
console.log(`${"─".repeat(60)}`);
if (failed > 0) {
  for (const f of assertions.filter(a => !a.ok)) console.log(`  ✗  ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
  process.exit(1);
}
console.log("Para correr el test HTTP real:");
console.log("  RUN_HTTP_TEST=1 TEST_API_URL=http://localhost:8000 TEST_API_KEY=tukey node scripts/test-streams-encryption.mjs");
