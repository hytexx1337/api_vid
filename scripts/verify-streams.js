/**
 * scripts/verify-streams.js — Verifica que una lista de streams (como la
 * que devuelve /anime/:id/:episode en `streams`) sea realmente reproducible:
 * para HLS, descarga el master (y la variant playlist si aplica) y baja los
 * primeros 1-2 segmentos con Range; para mp4/progresivo, hace un GET con
 * Range sobre la url directa. Todos los streams se verifican EN PARALELO.
 *
 * Uso:
 *   node scripts/verify-streams.js [ruta-al-json]
 *   (default: streams.txt en el cwd desde donde se ejecuta)
 *
 * El archivo de entrada puede ser:
 *   - un array JSON de streams: [ {...}, {...} ]
 *   - un objeto { "streams": [ {...}, ... ] }
 *   - un array "pelado" sin los [ ] (como streams.txt) — se auto-repara.
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const REQUEST_TIMEOUT_MS = 12_000;
const SEGMENTS_TO_CHECK = 2;

function loadStreams(path) {
  const raw = readFileSync(path, "utf-8").trim();
  const candidates = [];
  candidates.push(raw);
  if (!raw.startsWith("[")) candidates.push(`[${raw.replace(/,\s*$/, "")}]`);

  for (const candidate of candidates) {
    const cleaned = candidate.replace(/,\s*([\]}])/g, "$1"); // trailing commas
    try {
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed?.streams)) return parsed.streams;
    } catch { /* probar siguiente candidato */ }
  }
  throw new Error(`No pude parsear ${path} como JSON de streams. Revisá que sea un array válido (con [ ] al inicio/final).`);
}

async function fetchWithTimeout(url, opts = {}) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

function resolveUri(uri, baseUrl) {
  return new URL(uri.trim(), baseUrl).toString();
}

// Extrae la primera URI de variant-playlist (#EXT-X-STREAM-INF) o, si ya es
// una media playlist, las primeras N URIs de segmento (#EXTINF).
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
  return buf.byteLength;
}

async function verifyHls(fetchUrl, headers) {
  const masterRes = await fetchWithTimeout(fetchUrl, { headers });
  if (!masterRes.ok) throw new Error(`HTTP ${masterRes.status} en master`);
  const masterText = await masterRes.text();
  if (!masterText.includes("#EXTM3U")) throw new Error("respuesta no parece un m3u8 (falta #EXTM3U)");

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

  if (segmentUris.length === 0) throw new Error("no se encontraron segmentos (#EXTINF) en el playlist");

  const toCheck = segmentUris.slice(0, SEGMENTS_TO_CHECK).map(u => resolveUri(u, playlistUrl));
  const sizes = await Promise.all(toCheck.map(u => checkSegment(u, headers)));
  return `master OK, ${sizes.length} segmento(s) OK (${sizes.join("/")} bytes)`;
}

async function verifyMp4(fetchUrl, headers) {
  const bytes = await checkSegment(fetchUrl, headers);
  return `GET con Range OK (${bytes} bytes)`;
}

async function verifyStream(stream, index) {
  const t0 = Date.now();
  const label = `[${index}] ${stream.provider ?? "?"} / ${stream.lang ?? "?"} (${stream.originalProvider ?? stream.sourceProvider ?? "?"})`;
  const fetchUrl = stream.proxy_url || stream.url;
  const headers = stream.proxy_url ? {} : (stream.headers || {});

  if (!fetchUrl) return { label, ok: false, detail: "sin url/proxy_url", ms: 0 };

  try {
    const detail = stream.type === "mp4"
      ? await verifyMp4(fetchUrl, headers)
      : await verifyHls(fetchUrl, headers);
    return { label, ok: true, detail, ms: Date.now() - t0 };
  } catch (e) {
    return { label, ok: false, detail: e.message, ms: Date.now() - t0 };
  }
}

async function main() {
  const path = resolve(process.argv[2] || "streams.txt");
  const streams = loadStreams(path);
  console.log(`Verificando ${streams.length} streams en paralelo (timeout ${REQUEST_TIMEOUT_MS}ms c/u)...\n`);

  const results = await Promise.all(streams.map((s, i) => verifyStream(s, i)));

  for (const r of results) {
    const icon = r.ok ? "✅" : "❌";
    console.log(`${icon} ${r.label} — ${r.detail} (${r.ms}ms)`);
  }

  const okCount = results.filter(r => r.ok).length;
  console.log(`\nListo. OK=${okCount} FAIL=${results.length - okCount} de ${results.length}`);
}

main().catch(e => { console.error("Error fatal:", e.message); process.exit(1); });
