/**
 * stream-verify.js — Verifica en runtime que un stream sea reproducible
 * antes de devolverlo en la respuesta (mismo criterio que
 * scripts/verify-streams.js): para HLS, descarga el master (y la variant
 * playlist si aplica) y confirma que liste segmentos — el segmento en sí no
 * se baja porque siempre pasa por el proxy local; para mp4/progresivo, un
 * GET con Range sobre la url directa.
 *
 * El resultado se cachea unos minutos por url upstream para no re-verificar
 * en cada pedido de la misma página/episodio.
 */
import { cacheGet, cacheSet } from "./cache.js";

const REQUEST_TIMEOUT_MS = 6_000;
const VERIFY_TTL_MS = 5 * 60 * 1000;

// UA de browser por defecto: varios CDNs (embed69/meadowbrook, etc.) devuelven
// 404 al UA de Node/undici aunque la URL sea válida.
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

async function fetchWithTimeout(url, opts = {}) {
  const headers = { "User-Agent": BROWSER_UA, ...(opts.headers || {}) };
  return fetch(url, { ...opts, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

function resolveUri(uri, baseUrl) {
  return new URL(uri.trim(), baseUrl).toString();
}

function parseM3u8(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const variantUris = [];
  const segmentUris = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
      const next = lines[i + 1];
      if (next && !next.startsWith("#")) variantUris.push(next);
    } else if (lines[i].startsWith("#EXTINF")) {
      const next = lines[i + 1];
      if (next && !next.startsWith("#")) segmentUris.push(next);
    }
  }
  return { variantUris, segmentUris };
}

async function checkSegment(url, headers) {
  const res = await fetchWithTimeout(url, { headers: { ...headers, Range: "bytes=0-65535" } });
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} en segmento`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength === 0) throw new Error("segmento devolvió 0 bytes");
}

// Solo se verifica master + variant playlist (que liste segmentos). No se
// baja el segmento: los segmentos siempre se sirven vía proxy local, que
// corrige Referer/headers y strippea prefijos PNG falsos — un hit directo al
// segmento da 403 falsos (animeav1, upnshare, megaplay).
async function verifyHls(fetchUrl, headers) {
  const masterRes = await fetchWithTimeout(fetchUrl, { headers });
  if (!masterRes.ok) throw new Error(`HTTP ${masterRes.status} en master`);
  const masterText = await masterRes.text();
  if (!masterText.includes("#EXTM3U")) throw new Error("respuesta no es un m3u8 válido");

  const masterUrl = masterRes.url || fetchUrl;
  let { variantUris, segmentUris } = parseM3u8(masterText);

  if (segmentUris.length === 0 && variantUris.length > 0) {
    const variantUrl = resolveUri(variantUris[0], masterUrl);
    const variantRes = await fetchWithTimeout(variantUrl, { headers });
    if (!variantRes.ok) throw new Error(`HTTP ${variantRes.status} en variant playlist`);
    const variantText = await variantRes.text();
    segmentUris = parseM3u8(variantText).segmentUris;
  }

  if (segmentUris.length === 0) throw new Error("sin segmentos en el playlist");
}

async function verifyOne(stream) {
  const fetchUrl = stream.proxy_url || stream.url;
  const headers = stream.proxy_url ? {} : (stream.headers || {});
  if (!fetchUrl) return false;
  try {
    if (stream.type === "mp4") await checkSegment(fetchUrl, headers);
    else await verifyHls(fetchUrl, headers);
    return true;
  } catch (e) {
    const who = stream.originalProvider || stream.provider || "?";
    console.warn(`[verify] ${who} ✗ ${e.message} — ${fetchUrl.slice(0, 140)}`);
    return false;
  }
}

// Verificaciones en vuelo disparadas por prewarmVerify — filterPlayableStreams
// las awaita en vez de re-verificar, así el verify corre solapado con el
// scrapeo de los providers restantes.
const pendingVerify = new Map();

function verifyAndCache(stream) {
  const cacheKey = `verify:${stream.url}`;
  const p = verifyOne(stream)
    .then(ok => { cacheSet(cacheKey, ok, VERIFY_TTL_MS); return ok; })
    .catch(() => true) // error inesperado → no penalizar el stream
    .finally(() => pendingVerify.delete(cacheKey));
  pendingVerify.set(cacheKey, p);
  return p;
}

/**
 * Dispara la verificación de un stream en background apenas su provider
 * resuelve. Usa la URL upstream directa (sin proxy_url) con los headers del
 * stream — para pass/fail equivale a verificar por el proxy local.
 * No usar con URLs que solo funcionan vía proxy local (ej. flixcloud cifrado).
 */
export function prewarmVerify(stream) {
  if (!stream?.url) return;
  const cacheKey = `verify:${stream.url}`;
  if (cacheGet(cacheKey) !== null && cacheGet(cacheKey) !== undefined) return;
  if (pendingVerify.has(cacheKey)) return;
  verifyAndCache(stream);
}

/**
 * Filtra streams no reproducibles verificando todos en paralelo. Si TODOS
 * fallan (ej. un blip transitorio de red del propio VPS) devuelve la lista
 * original sin filtrar — mejor mostrar algo que un 404 falso.
 */
export async function filterPlayableStreams(streams) {
  const results = await Promise.all(streams.map(async (s) => {
    const cacheKey = `verify:${s.url}`;
    let ok = cacheGet(cacheKey);
    if (ok === null || ok === undefined) {
      ok = pendingVerify.has(cacheKey) ? await pendingVerify.get(cacheKey) : await verifyAndCache(s);
    }
    return ok;
  }));
  const playable = streams.filter((_, i) => results[i]);
  const dropped = streams.filter((_, i) => !results[i]);
  if (dropped.length) {
    console.warn(`[verify] filtrados ${dropped.length}/${streams.length}: ${dropped.map(s => s.originalProvider || s.provider || "?").join(", ")}`);
  }
  return playable.length > 0 ? playable : streams;
}
