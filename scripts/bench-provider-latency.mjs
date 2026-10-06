import { performance } from "node:perf_hooks";

const DEFAULT_CASES = [
  {
    provider: "cinejoy",
    label: "cinejoy-tv-dexter-s1e1",
    tmdbId: 1405,
    mediaType: "tv",
    title: "Dexter",
    year: 2006,
    imdbId: "tt0773262",
    season: 1,
    episode: 1,
  },
  {
    provider: "vidup",
    label: "vidup-tv-got-s1e1",
    tmdbId: 1399,
    mediaType: "tv",
    season: 1,
    episode: 1,
  },
];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i++;
  }
  return args;
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildCases(args) {
  if (!args.provider) return DEFAULT_CASES;
  if (args.provider === "cinejoy") {
    if (!args.title) {
      throw new Error("--title es obligatorio para provider=cinejoy");
    }
    return [{
      provider: "cinejoy",
      label: args.label || "cinejoy-custom",
      tmdbId: toNumber(args.tmdb, args.tmdb),
      mediaType: args.mediaType || "tv",
      title: args.title,
      year: toNumber(args.year, undefined),
      imdbId: args.imdb,
      season: toNumber(args.season, undefined),
      episode: toNumber(args.episode, undefined),
    }];
  }
  if (args.provider === "vidup") {
    return [{
      provider: "vidup",
      label: args.label || "vidup-custom",
      tmdbId: toNumber(args.tmdb, args.tmdb),
      mediaType: args.mediaType || "tv",
      season: toNumber(args.season, undefined),
      episode: toNumber(args.episode, undefined),
    }];
  }
  throw new Error(`provider no soportado: ${args.provider}`);
}

function shortUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const path = `${url.origin}${url.pathname}`;
    if (!url.search) return path;
    const query = url.search.length > 90 ? `${url.search.slice(0, 90)}...` : url.search;
    return `${path}${query}`;
  } catch {
    return rawUrl;
  }
}

function summarizeRequests(requests) {
  const byHost = new Map();
  for (const req of requests) {
    const host = req.host || "unknown";
    const row = byHost.get(host) || { count: 0, totalMs: 0, maxMs: 0, errors: 0 };
    row.count++;
    row.totalMs += req.ms;
    row.maxMs = Math.max(row.maxMs, req.ms);
    if (req.error || (typeof req.status === "number" && req.status >= 400)) row.errors++;
    byHost.set(host, row);
  }
  return [...byHost.entries()]
    .map(([host, row]) => ({
      host,
      count: row.count,
      totalMs: row.totalMs,
      avgMs: row.totalMs / row.count,
      maxMs: row.maxMs,
      errors: row.errors,
    }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

function printCaseSummary(run) {
  console.log(`\n=== ${run.label} (${run.provider}) ===`);
  console.log(`total: ${run.totalMs.toFixed(0)}ms`);
  console.log(`result: ${run.result ? "ok" : "null"}`);
  if (run.result) {
    console.log(`resolved provider: ${run.result.provider ?? "?"}`);
    if (run.result.server) console.log(`server: ${run.result.server}`);
    if (run.result.url) console.log(`stream: ${shortUrl(run.result.url)}`);
  }

  console.log(`requests: ${run.requests.length}`);
  const hostSummary = summarizeRequests(run.requests);
  console.log("hosts:");
  for (const row of hostSummary) {
    console.log(`  - ${row.host}: count=${row.count} total=${row.totalMs.toFixed(0)}ms avg=${row.avgMs.toFixed(0)}ms max=${row.maxMs.toFixed(0)}ms errors=${row.errors}`);
  }

  const slowest = [...run.requests]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 8);
  console.log("slowest:");
  for (const req of slowest) {
    const status = req.error ? `ERR ${req.error}` : req.status;
    console.log(`  - ${req.ms.toFixed(0)}ms ${req.method} ${status} ${shortUrl(req.url)}`);
  }
}

const args = parseArgs(process.argv.slice(2));
const cases = buildCases(args);

const originalFetch = globalThis.fetch;
let activeLabel = "bootstrap";
let activeRequests = [];

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input?.url;
  const method = init.method || (typeof input !== "string" ? input?.method : undefined) || "GET";
  const host = (() => {
    try { return new URL(url).host; } catch { return "unknown"; }
  })();
  const startedAt = performance.now();
  try {
    const response = await originalFetch(input, init);
    activeRequests.push({
      label: activeLabel,
      method,
      url,
      host,
      status: response.status,
      ms: performance.now() - startedAt,
    });
    return response;
  } catch (error) {
    activeRequests.push({
      label: activeLabel,
      method,
      url,
      host,
      status: null,
      error: error.message,
      ms: performance.now() - startedAt,
    });
    throw error;
  }
};

async function freshImport(path) {
  return import(`${path}?bench=${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

async function runCase(testCase) {
  activeLabel = testCase.label;
  activeRequests = [];
  const startedAt = performance.now();
  let result = null;

  if (testCase.provider === "cinejoy") {
    const { getCinejoyStream } = await freshImport("../src/providers/scraper-cinejoy.js");
    result = await getCinejoyStream({
      tmdbId: testCase.tmdbId,
      mediaType: testCase.mediaType,
      title: testCase.title,
      year: testCase.year,
      imdbId: testCase.imdbId,
      season: testCase.season,
      episode: testCase.episode,
    });
  } else if (testCase.provider === "vidup") {
    const { getVidupStream } = await freshImport("../src/providers/scraper-vidup.js");
    result = await getVidupStream(
      testCase.tmdbId,
      testCase.mediaType,
      testCase.season,
      testCase.episode,
    );
  } else {
    throw new Error(`provider no soportado: ${testCase.provider}`);
  }

  return {
    ...testCase,
    result,
    totalMs: performance.now() - startedAt,
    requests: activeRequests.slice(),
  };
}

try {
  console.log(`benchmark cases=${cases.length}`);
  for (const testCase of cases) {
    const run = await runCase(testCase);
    printCaseSummary(run);
  }
} finally {
  globalThis.fetch = originalFetch;
}
