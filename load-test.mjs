#!/usr/bin/env node
/**
 * load-test.mjs — Bombardea /anime/:anilistId/:episode y mide cuánto aguanta.
 *
 * Modos:
 *   warm  — mismo episodio siempre (cache hit): mide throughput puro de la API
 *           (express + cache lookup + serialización JSON).
 *   cold  — pool de episodios con cache invalidada antes de empezar: mide el
 *           path de scrapeo real. OJO: pega contra sitios externos (anilist,
 *           animeheaven, aniwaves...) — puede rate-limitar la IP del server.
 *   mixed — pool de episodios sin invalidar: mezcla realista de hits y scrapes.
 *
 * Uso:
 *   node load-test.mjs --mode=warm --levels=1,5,10,25,50 --duration=10
 *   node load-test.mjs --mode=cold --levels=1,5,10 --duration=15
 *   node load-test.mjs --base=http://localhost:8000 --key=Monitor1337!
 *
 * Mide por nivel de concurrencia: req/s, p50/p95/p99/max, errores por tipo,
 * y latencia de /health durante la carga (detecta event loop bloqueado).
 */

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));

const BASE       = (args.base ?? "http://localhost:8000").replace(/\/$/, "");
const KEY        = args.key ?? "Monitor1337!";
const MODE       = args.mode ?? "warm";
const LEVELS     = String(args.levels ?? "1,5,10,25,50").split(",").map(Number);
const DURATION_S = Number(args.duration ?? 10);
const TIMEOUT_MS = Number(args.timeout ?? 95000); // scrapeo frío puede tardar ~90s
const WARM_ID    = String(args.id ?? "170130");
const WARM_EP    = String(args.ep ?? "2");
// El rate limiter (60 req/min) keyea por x-forwarded-for → spoofearlo simula
// usuarios reales detrás de IPs distintas. --no-xff para medir el limiter.
const SPOOF_XFF  = args["no-xff"] === undefined;
const randIp = () => `${(Math.random()*223|0)+1}.${Math.random()*256|0}.${Math.random()*256|0}.${Math.random()*256|0}`;

// Pool de anilistIds verificados (id, maxEps) — eps 1..3 por id para cold/mixed.
const POOL = [
  [170130, 12], [21202, 10], [21699, 10], [136804, 11], [9253, 24],
  [16498, 25], [112608, 24], [1535, 37], [11061, 148], [5114, 64],
];
const EPS_PER_ID = 3;

const epUrl = (id, ep) => `${BASE}/anime/${id}/${ep}?key=${encodeURIComponent(KEY)}`;

const poolUrls = POOL.flatMap(([id, max]) =>
  Array.from({ length: Math.min(EPS_PER_ID, max) }, (_, i) => epUrl(id, i + 1)));

function nextUrlFactory() {
  if (MODE === "warm") { const u = epUrl(WARM_ID, WARM_EP); return () => u; }
  let i = 0;
  return () => poolUrls[i++ % poolUrls.length];
}

async function invalidatePool() {
  const keys = [];
  for (const [id, max] of POOL) {
    for (let ep = 1; ep <= Math.min(EPS_PER_ID, max); ep++) {
      keys.push(`streams:anime:v11:${id}:${ep}`, `reanime:streams:v10:${id}:${ep}`, `resp:streams:anime:v11:${id}:${ep}:${BASE}`);
    }
  }
  let ok = 0;
  await Promise.all(keys.map(async k => {
    try {
      const r = await fetch(`${BASE}/admin/api/stream-cache/${encodeURIComponent(k)}`, { method: "DELETE" });
      if (r.ok) ok++;
    } catch {}
  }));
  console.log(`[cold] cache invalidada: ${ok}/${keys.length} keys borradas`);
}

const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)] : 0;
const fmt = n => n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`;

async function runLevel(concurrency, nextUrl) {
  const stats = { lat: [], statuses: {}, errors: {}, bytes: 0, healthLat: [] };
  const end = Date.now() + DURATION_S * 1000;

  // Sonda de /health: si su latencia explota bajo carga, el event loop está
  // bloqueado (serialización JSON grande, cache sync, etc.).
  const probe = setInterval(async () => {
    const t0 = performance.now();
    try { await fetch(`${BASE}/health`); stats.healthLat.push(performance.now() - t0); } catch {}
  }, 1000);

  const workers = Array.from({ length: concurrency }, async () => {
    while (Date.now() < end) {
      const t0 = performance.now();
      try {
        const r = await fetch(nextUrl(), {
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: SPOOF_XFF ? { "X-Forwarded-For": randIp() } : {},
        });
        const body = await r.arrayBuffer();
        stats.lat.push(performance.now() - t0);
        stats.statuses[r.status] = (stats.statuses[r.status] ?? 0) + 1;
        stats.bytes += body.byteLength;
      } catch (e) {
        stats.lat.push(performance.now() - t0);
        const k = e.name === "TimeoutError" || e.name === "AbortError" ? "timeout"
          : (e.cause?.code ?? e.name ?? "unknown");
        stats.errors[k] = (stats.errors[k] ?? 0) + 1;
      }
    }
  });
  await Promise.all(workers);
  clearInterval(probe);
  return stats;
}

function report(conc, s) {
  const lat = s.lat.slice().sort((a, b) => a - b);
  const total = lat.length;
  const ok = Object.entries(s.statuses).filter(([c]) => +c < 400).reduce((a, [, n]) => a + n, 0);
  const errStr = [
    ...Object.entries(s.statuses).filter(([c]) => +c >= 400).map(([c, n]) => `HTTP${c}×${n}`),
    ...Object.entries(s.errors).map(([k, n]) => `${k}×${n}`),
  ].join(" ") || "-";
  const hlat = s.healthLat.slice().sort((a, b) => a - b);
  console.log(
    `conc=${String(conc).padStart(3)} | reqs=${String(total).padStart(4)} ok=${String(ok).padStart(4)} ` +
    `| ${(total / DURATION_S).toFixed(1).padStart(6)} req/s ` +
    `| p50=${fmt(pct(lat, 50))} p95=${fmt(pct(lat, 95))} p99=${fmt(pct(lat, 99))} max=${fmt(lat.at(-1) ?? 0)} ` +
    `| avg=${(s.bytes / Math.max(1, total) / 1024).toFixed(0)}KB ` +
    `| health p95=${fmt(pct(hlat, 95))} | err: ${errStr}`
  );
  return { conc, total, ok, rps: total / DURATION_S, p95: pct(lat, 95), healthP95: pct(hlat, 95), errCount: total - ok };
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log(`load-test → ${BASE} mode=${MODE} levels=[${LEVELS}] ${DURATION_S}s/nivel timeout=${TIMEOUT_MS}ms xff=${SPOOF_XFF ? "spoof" : "real"}`);
if (MODE === "cold") {
  console.log("⚠️  cold pega contra sitios externos (anilist, animeheaven, aniwaves) — puede rate-limitar la IP");
  await invalidatePool();
} else if (MODE === "mixed") {
  console.log(`mixed: rotando ${poolUrls.length} episodios (hits + scrapes según cache)`);
}

// sanity: server vivo
try {
  const h = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5000) });
  if (!h.ok) throw new Error(`HTTP ${h.status}`);
} catch (e) {
  console.error(`server no responde en ${BASE}/health: ${e.message}`);
  process.exit(1);
}

const results = [];
const nextUrl = nextUrlFactory();
for (const conc of LEVELS) {
  results.push(report(conc, await runLevel(conc, nextUrl)));
}

// ── Análisis ──────────────────────────────────────────────────────────────────
console.log("\n── análisis ──");
const peak = results.reduce((a, b) => (b.rps > a.rps ? b : a));
console.log(`pico throughput: ${peak.rps.toFixed(1)} req/s @ conc=${peak.conc}`);
const saturated = results.find(r => r.conc > peak.conc && r.rps < peak.rps * 0.9);
if (saturated) console.log(`saturación: conc=${saturated.conc} rinde PEOR que conc=${peak.conc} — el server está al límite ahí`);
const unhealthy = results.find(r => r.healthP95 > 200);
if (unhealthy) console.log(`event loop: /health p95=${fmt(unhealthy.healthP95)} @ conc=${unhealthy.conc} — hay trabajo sync bloqueando (JSON.stringify de payloads grandes, cache sqlite sync)`);
const erroring = results.find(r => r.errCount / Math.max(1, r.total) > 0.05);
if (erroring) console.log(`errores: ${(erroring.errCount / erroring.total * 100).toFixed(1)}% fallan @ conc=${erroring.conc} — punto de quiebre`);
const last = results.at(-1);
if (MODE === "warm" && last.p95 < 50) console.log("warm p95 <50ms: el cuello real está en el scrapeo, no en express — probá mode=mixed/cold");
process.exit(0);
