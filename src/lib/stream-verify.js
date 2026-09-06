/**
 * stream-verify.js — Verifica en runtime que un stream sea reproducible
 * antes de devolverlo en la respuesta (mismo criterio que
 * scripts/verify-streams.js): para HLS, descarga el master (y la variant
 * playlist si aplica) y confirma que el primer segmento devuelva bytes;
 * para mp4/progresivo, un GET con Range sobre la url directa.
 *
 * El resultado se cachea unos minutos por url upstream para no re-verificar
 * en cada pedido de la misma página/episodio.
 */
import { cacheGet, cacheSet } from "./cache.js";

const REQUEST_TIMEOUT_MS = 6_000;
const SEGMENTS_TO_CHECK = 1;
const VERIFY_TTL_MS = 5 * 60 * 1000;

async function fetchWithTimeout(url, opts = {}) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
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

async function verifyHls(fetchUrl, headers) {
  const masterRes = await fetchWithTimeout(fetchUrl, { headers });
  if (!masterRes.ok) throw new Error(`HTTP ${masterRes.status} en master`);
  const masterText = await masterRes.text();
  if (!masterText.includes("#EXTM3U")) throw new Error("respuesta no es un m3u8 válido");

  const masterUrl = masterRes.url || fetchUrl;
  let { variantUris, segmentUris } = parseM3u8(masterText);
  let playlistUrl = masterUrl;

  if (segmentUris.length === 0 && variantUris.length > 0) {
    const variantUrl = resolveUri(variantUris[0], masterUrl);
    const variantRes = await fetchWithTimeout(variantUrl, { headers });
    if (!variantRes.ok) throw new Error(`HTTP ${variantRes.status} en variant playlist`);
    const variantText = await variantRes.text();
    playlistUrl = variantRes.url || variantUrl;
    segmentUris = parseM3u8(variantText).segmentUris;
  }

  if (segmentUris.length === 0) throw new Error("sin segmentos en el playlist");

  const toCheck = segmentUris.slice(0, SEGMENTS_TO_CHECK).map(u => resolveUri(u, playlistUrl));
  await Promise.all(toCheck.map(u => checkSegment(u, headers)));
}

async function verifyOne(stream) {
  const fetchUrl = stream.proxy_url || stream.url;
  const headers = stream.proxy_url ? {} : (stream.headers || {});
  if (!fetchUrl) return false;
  try {
    if (stream.type === "mp4") await checkSegment(fetchUrl, headers);
    else await verifyHls(fetchUrl, headers);
    return true;
  } catch {
    return false;
  }
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
      ok = await verifyOne(s);
      cacheSet(cacheKey, ok, VERIFY_TTL_MS);
    }
    return ok;
  }));
  const playable = streams.filter((_, i) => results[i]);
  return playable.length > 0 ? playable : streams;
}
