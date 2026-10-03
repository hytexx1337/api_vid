/**
 * src/lib/r2-seal.js — Firma HMAC de paths de objetos R2 para servir vía
 * el Worker "r2-cdn" (ver workers/r2-cdn/index.js).
 *
 * A diferencia de proxy-seal.js (AES-GCM, oculta el path completo), acá NO
 * hace falta ocultar el path: solo necesitamos probar que la API lo generó
 * a propósito y que no expiró. Por eso alcanza con HMAC-SHA256 sobre
 * `${path}:${exp}`, igual que hace el Worker (con Web Crypto) para validar.
 *
 * Requiere en .env:
 *   R2_SEAL_SECRET   — secreto compartido con el Worker (wrangler secret)
 *   R2_WORKER_BASE   — ej: https://r2-cdn.tuusuario.workers.dev
 */
import crypto from "node:crypto";

function getSecret() {
  const secret = process.env.R2_SEAL_SECRET;
  if (!secret) throw new Error("R2_SEAL_SECRET no está configurado");
  return secret;
}

function hmac(path, exp) {
  return crypto.createHmac("sha256", getSecret()).update(`${path}:${exp}`).digest("base64url");
}

/**
 * Firma un path de objeto R2 (ej: "/21202-3-esp-lat/master.m3u8").
 * Devuelve { exp, sig }.
 */
export function signR2Path(objectPath, ttlSeconds = 86400) {
  const path = objectPath.startsWith("/") ? objectPath : `/${objectPath}`;
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = hmac(path, exp);
  return { exp, sig };
}

/**
 * Arma la URL completa firmada apuntando al Worker.
 */
export function buildSignedR2Url(objectPath, ttlSeconds = 86400) {
  const workerBase = (process.env.R2_WORKER_BASE || "").replace(/\/$/, "");
  if (!workerBase) throw new Error("R2_WORKER_BASE no está configurado");
  const path = objectPath.startsWith("/") ? objectPath : `/${objectPath}`;
  const { exp, sig } = signR2Path(path, ttlSeconds);
  return `${workerBase}${path}?exp=${exp}&sig=${sig}`;
}

export function buildPublicR2Url(objectPath) {
  const workerBase = (process.env.R2_WORKER_BASE || "").replace(/\/$/, "");
  if (!workerBase) throw new Error("R2_WORKER_BASE no está configurado");
  const path = objectPath.startsWith("/") ? objectPath : `/${objectPath}`;
  return `${workerBase}${path}`;
}

/**
 * Verifica una firma (uso interno / debug / tests). El Worker tiene su
 * propia implementación equivalente en Web Crypto.
 */
export function verifyR2Sig(objectPath, exp, sig) {
  if (!exp || !sig) return false;
  if (Math.floor(Date.now() / 1000) > Number(exp)) return false;
  const path = objectPath.startsWith("/") ? objectPath : `/${objectPath}`;
  const expected = hmac(path, exp);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(sig)));
  } catch {
    return false;
  }
}
