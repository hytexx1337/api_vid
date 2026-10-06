import crypto from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 16;
const TAG_LEN = 16;

let _key = null;
function getKey() {
  if (_key) return _key;
  const secret = process.env.PROXY_SEAL_SECRET;
  if (!secret) {
    throw new Error("PROXY_SEAL_SECRET no está configurado");
  }
  _key = crypto.createHash("sha256").update(secret).digest();
  return _key;
}

function base64url(buf) {
  return buf.toString("base64url");
}

function base64urlDecode(s) {
  return Buffer.from(s, "base64url");
}

/**
 * Cifra un string (generalmente path+query del proxy interno) en un token
 * opaco de una sola ruta.
 *
 * IV DETERMINÍSTICO = SHA-256(path).slice(0, IV_LEN):
 *   Esto garantiza que el MISMO path siempre produzca el MISMO token,
 *   fundamental para que la CDN (Bunny) haga HIT en vez de MISS en cada
 *   request. AES-GCM exige IV único por (key, plaintext) — se cumple porque
 *   el IV deriva del plaintext mismo: misma key + mismo plaintext = mismo IV
 *   = mismo ciphertext. Esto NO es una vulnerabilidad mientras no tengamos
 *   que esconder que dos requests son del mismo recurso (justo lo OPUESTO
 *   a lo que queremos: queremos colapsar caché).
 */
export function sealProxyPath(path) {
  const iv = crypto.createHash("sha256").update(path, "utf8").digest().slice(0, IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([cipher.update(path, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return base64url(Buffer.concat([iv, tag, enc]));
}

/**
 * Descifra un token opaco y devuelve el path+query original.
 */
export function unsealProxyPath(token) {
  const buf = base64urlDecode(token);
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error("token too short");
  }
  const iv = buf.slice(0, IV_LEN);
  const tag = buf.slice(IV_LEN, IV_LEN + TAG_LEN);
  const enc = buf.slice(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(enc), decipher.final()]);
  return out.toString("utf8");
}

const PROXY_PATH_PATTERN =
  "(?:" +
  "proxy|ts-proxy|fetch|mp4-proxy|ghost-proxy|" +
  "upn-stream\\.m3u8|upn-seg|" +
  "kai-stream\\.m3u8|kai-seg|" +
  "vix-stream\\.m3u8|" +
  "generic-stream\\.m3u8|generic-media\\.m3u8|generic-seg|" +
  "vixsrc-stream\\.m3u8|vixsrc-seg\\.m3u8|vixsrc-seg|" +
  "dash-proxy\\.mpd|dash-seg(?:\\/[^?\"'\\s]*)?|" +
  "aes-key" +
  ")";

const PROXY_PATH_RE = new RegExp(`^(/${PROXY_PATH_PATTERN})(?:\\?|$)`);

// Endpoints que siempre devuelven playlists y necesitan conservar una
// extensión reconocible para que ffmpeg/reproductores las traten como
// manifests en vez de descargas genéricas.
const PLAYLIST_PATH_PATTERN =
  "(?:" +
  "vixsrc-stream\\.m3u8|vixsrc-seg\\.m3u8|dash-proxy\\.mpd" +
  ")";
const PLAYLIST_PATH_RE = new RegExp(`^(/${PLAYLIST_PATH_PATTERN})(?:\\?|$)`);

function sealedExtForPath(rest) {
  if (/^\/dash-proxy\.mpd(?:\?|$)/.test(rest)) return ".mpd";
  return PLAYLIST_PATH_RE.test(rest) ? ".m3u8" : "";
}

function buildSealedUrl(pathAndQuery, proxyBase) {
  return `${proxyBase}/sealed/${sealProxyPath(pathAndQuery)}${sealedExtForPath(pathAndQuery)}`;
}

/**
 * Extrae path+query de una URL interna (localhost/127/proxyBase).
 * Devuelve null si no es una URL de proxy válida.
 */
function extractProxyPath(value, proxyBase) {
  if (typeof value !== "string" || !value.startsWith("http")) return null;
  let rest = null;
  if (proxyBase && value.startsWith(proxyBase)) {
    rest = value.slice(proxyBase.length);
  } else {
    const m = value.match(/^https?:\/\/[^/]+(\/[^?#]*(?:\?[^#]*)?)/);
    if (m) rest = m[1];
  }
  if (!rest) return null;
  return PROXY_PATH_RE.test(rest) ? rest : null;
}

function maybeSeal(value, proxyBase) {
  const rest = extractProxyPath(value, proxyBase);
  if (!rest) return value;
  return buildSealedUrl(rest, proxyBase);
}

function shouldSkipTextSeal(pathAndQuery) {
  // DASH SegmentTemplate necesita que placeholders como
  // $RepresentationID$ / $Number%05d$ sigan visibles para que el player los
  // sustituya antes de pedir el segmento. Si sellamos /dash-seg, el template
  // queda atrapado dentro del token opaco y el CDN recibe el literal "$...$".
  return /^\/dash-seg(?:\/|$)/.test(pathAndQuery);
}

/**
 * Reemplaza URLs internas de proxy que aparezcan dentro de texto (playlists
 * HLS/DASH, VTT, JSON, etc.) por URLs selladas absolutas proxyBase/sealed/:token.
 * Reconoce URLs absolutas contra localhost/127/proxyBase y paths relativos.
 */
export function sealProxyUrlsInText(text, proxyBase) {
  if (typeof text !== "string" || !text.includes("/")) return text;
  const escapedBase = proxyBase
    ? proxyBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    : null;
  // Origen interno: localhost, 127.0.0.1 o proxyBase configurado.
  const originPart = escapedBase
    ? `(?:https?:\/\/(?:127\.0\.0\.1|localhost)(?::\\d+)?|${escapedBase})`
    : `(?:https?:\/\/(?:127\.0\.0\.1|localhost)(?::\\d+)?)`;
  const re = new RegExp(
    `${originPart}?(/${PROXY_PATH_PATTERN}(?:\\?[^\\s"']*)?)`,
    "g"
  );
  return text.replace(re, (_, pathAndQuery) => (
    shouldSkipTextSeal(pathAndQuery)
      ? `${proxyBase}${pathAndQuery}`
      : buildSealedUrl(pathAndQuery, proxyBase)
  ));
}

function walkAndSeal(obj, proxyBase) {
  if (!obj || typeof obj !== "object") return;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    // Los thumbnails quedan con el proxy normal /fetch: la URL /sealed/ rompe
    // la preview de algunos reproductores (el token opaco no termina en .vtt/.jpg).
    if (typeof val === "string" && (key === "proxy_url" || (key.endsWith("Proxy") && !key.startsWith("thumbnail")))) {
      obj[key] = maybeSeal(val, proxyBase);
    } else if (Array.isArray(val)) {
      for (const item of val) walkAndSeal(item, proxyBase);
    } else if (typeof val === "object") {
      walkAndSeal(val, proxyBase);
    }
  }
}

/**
 * Reemplaza recursivamente los proxy_url (y campos *Proxy) de una respuesta
 * por URLs selladas al endpoint /sealed/:token.
 */
export function sealProxyUrls(body, proxyBase) {
  if (!body || typeof body !== "object") return body;
  walkAndSeal(body, proxyBase);
  return body;
}
