/**
 * stream-verify.js — Verifica en runtime que un stream sea reproducible
 * antes de devolverlo en la respuesta (mismo criterio que
 * scripts/verify-streams.js): para HLS, descarga solo el master y confirma
 * que sea un m3u8 válido — ni variants ni segmentos se bajan porque todo
 * pasa por el proxy local; para mp4/progresivo, un GET con Range sobre la
 * url directa.
 *
 * El resultado se cachea unos minutos por url upstream para no re-verificar
 * en cada pedido de la misma página/episodio.
 */
import { cacheGet, cacheSet } from "./cache.js";

const REQUEST_TIMEOUT_MS = 4_000;
const VERIFY_TTL_MS = 5 * 60 * 1000;
const PER_STREAM_TIMEOUT_MS = 1_200;

// UA de browser por defecto: varios CDNs (embed69/meadowbrook, etc.) devuelven
// 404 al UA de Node/undici aunque la URL sea válida.
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

async function fetchWithTimeout(url, opts = {}) {
  const headers = { "User-Agent": BROWSER_UA, ...(opts.headers || {}) };
  const hardDeadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signals = [hardDeadline];
  if (opts.signal) signals.push(opts.signal);
  const combined = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  const finalOpts = { ...opts, headers, signal: combined };
  delete finalOpts.signals;
  return fetch(url, finalOpts);
}

async function checkSegment(url, headers, opts = {}) {
  const res = await fetchWithTimeout(url, { ...opts, headers: { ...headers, Range: "bytes=0-65535" } });
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} en segmento`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength === 0) throw new Error("segmento devolvió 0 bytes");
}

// Solo se verifica el master (200 + #EXTM3U). Ni variants ni segmentos se
// bajan: todo se sirve vía proxy local, que corrige Referer/headers y
// strippea prefijos PNG falsos — un hit directo da 403 falsos (animeav1,
// upnshare, megaplay).
async function verifyHls(fetchUrl, headers, opts = {}) {
  const masterRes = await fetchWithTimeout(fetchUrl, { ...opts, headers });
  if (!masterRes.ok) throw new Error(`HTTP ${masterRes.status} en master`);
  const masterText = await masterRes.text();
  if (!masterText.includes("#EXTM3U")) throw new Error("respuesta no es un m3u8 válido");
}

async function verifyOne(stream, opts = {}) {
  const fetchUrl = stream.proxy_url || stream.url;
  const headers = stream.proxy_url ? {} : (stream.headers || {});
  const who = stream.originalProvider || stream.provider || "?";
  const start = Date.now();
  if (!fetchUrl) return false;
  try {
    if (stream.type === "mp4") await checkSegment(fetchUrl, headers, opts);
    else await verifyHls(fetchUrl, headers, opts);
    console.log(`[verify:perf] ✅ ${who} ${stream.type} (+${Date.now() - start}ms) ${fetchUrl.slice(0, 100)}`);
    return true;
  } catch (e) {
    console.warn(`[verify:perf] ✗ ${who} ${stream.type} (+${Date.now() - start}ms) ${e.message} — ${fetchUrl.slice(0, 100)}`);
    return false;
  }
}

// Verificaciones en vuelo disparadas por prewarmVerify — filterPlayableStreams
// las awaita en vez de re-verificar, así el verify corre solapado con el
// scrapeo de los providers restantes.
const pendingVerify = new Map();

function verifyAndCache(stream, opts = {}) {
  const cacheKey = `verify:${stream.verifyKey || stream.url}`;
  const p = verifyOne(stream, opts)
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
  const cacheKey = `verify:${stream.verifyKey || stream.url}`;
  if (cacheGet(cacheKey) !== null && cacheGet(cacheKey) !== undefined) return;
  if (pendingVerify.has(cacheKey)) return;
  verifyAndCache(stream);
}

// Presupuesto total para verificar en el build de la respuesta: un stream
// colgado (ni 200 ni 403, conexión estancada) bloqueaba hasta el timeout de
// 6s. Si no resuelve a tiempo entra optimista — el player cae al siguiente
// si está muerto — y el verify sigue en background cacheando para el
// próximo build.
const VERIFY_BUDGET_MS = 2_500;

/**
 * Filtra streams no reproducibles verificando todos en paralelo. Si TODOS
 * fallan (ej. un blip transitorio de red del propio VPS) devuelve la lista
 * original sin filtrar — mejor mostrar algo que un 404 falso.
 */
export async function filterPlayableStreams(streams, { budgetMs = VERIFY_BUDGET_MS, allowEmpty = false } = {}) {
  const start = Date.now();
  const deadline = start + budgetMs;
  let timedOut = 0;
  const results = await Promise.all(streams.map(async (s) => {
    const sStart = Date.now();
    const cacheKey = `verify:${s.verifyKey || s.url}`;
    const cached = cacheGet(cacheKey);
    const who = s.originalProvider || s.provider || "?";
    let proxyTest = null;
    try { proxyTest = new URL(s.proxy_url || ""); } catch {}
    const isRiverAlias = Boolean(proxyTest && (proxyTest.pathname === "/river.m3u8" || proxyTest.pathname.startsWith("/river-seg")));
    if (isRiverAlias) {
      console.log(`[verify:perf] 🏠 skip river-alias ${who} (proxy local sellado)`);
      return true;
    }
    if (s.type === "mp4") {
      console.log(`[verify:perf] 🎥 skip mp4-verify ${who} (HEAD caro, incluimos optimista)`);
      return true;
    }
    if (cached !== null && cached !== undefined) {
      console.log(`[verify:perf] ⚡ cache ${who}: ${cached ? "OK" : "KO"}`);
      return cached;
    }
    const perStreamBudget = PER_STREAM_TIMEOUT_MS;
    const perStreamDeadline = Date.now() + perStreamBudget;
    const globalDeadline = deadline;
    const effectiveDeadline = Math.min(perStreamDeadline, globalDeadline);
    const remaining = effectiveDeadline - Date.now();
    if (remaining <= 0) { timedOut++; console.warn(`[verify:perf] ⏱ PER-STREAM-TIMEOUT ${who}`); return true; }
    const ac = new AbortController();
    const abortTimer = setTimeout(() => ac.abort(), remaining);
    const inFlight = pendingVerify.get(cacheKey);
    const p = inFlight ?? verifyAndCache(s, { signal: ac.signal });
    try {
      const r = await Promise.race([p, new Promise((res) => setTimeout(() => res("__timeout__"), remaining))]);
      clearTimeout(abortTimer);
      if (r === "__timeout__") {
        if (!inFlight) ac.abort();
        timedOut++;
        console.warn(`[verify:perf] ⏱ PER-STREAM-TIMEOUT ${who} (budget=${perStreamBudget}) (+${Date.now() - sStart}ms)`);
        return true;
      }
      return r;
    } catch {
      clearTimeout(abortTimer);
      return true;
    }
  }));
  const playable = streams.filter((_, i) => results[i]);
  const dropped = streams.filter((_, i) => !results[i]);
  console.log(`[verify:perf] total ${streams.length} streams — budget=${budgetMs}ms elapsed=+${Date.now() - start}ms — ✅${playable.length} ✗${dropped.length} ⏱${timedOut}`);
  if (dropped.length) {
    console.warn(`[verify] filtrados ${dropped.length}/${streams.length}: ${dropped.map(s => s.originalProvider || s.provider || "?").join(", ")}`);
  }
  if (timedOut) {
    console.warn(`[verify] budget ${budgetMs}ms — ${timedOut} stream(s) sin verificar a tiempo (incluidos optimistas)`);
  }
  return (playable.length > 0 || allowEmpty) ? playable : streams;
}
