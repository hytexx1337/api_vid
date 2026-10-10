#!/usr/bin/env node
/**
 * Smoke test para verificar que OVH MULTI gane sobre R2/CDN cuando ambos
 * existen para el mismo episodio.
 *
 * Uso:
 *   node --env-file=.env scripts/ovh-preference-smoke.mjs --base http://localhost:1337 --episodes 112641:2,112641:8
 *   node --env-file=.env scripts/ovh-preference-smoke.mjs --base http://localhost:1337 --episodes 112641:2 --sync
 */

const DEFAULT_BASE = process.env.API_BASE_URL || "http://localhost:1337";

function parseArgs(argv) {
  const args = { base: DEFAULT_BASE, episodes: [], sync: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--base") args.base = argv[++i];
    else if (arg === "--episodes") args.episodes = argv[++i].split(",").map(s => s.trim()).filter(Boolean);
    else if (arg === "--sync") args.sync = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

function usage() {
  console.log(`Uso:
  node --env-file=.env scripts/ovh-preference-smoke.mjs --base http://localhost:1337 --episodes 112641:2,112641:8 [--sync]

Variables:
  API_KEY        key admin/API usada como ?key=...
  API_BASE_URL   base opcional si no pasás --base
`);
}

function parseEpisode(value) {
  const [animeId, episode] = String(value || "").split(":");
  if (!animeId || !episode) throw new Error(`episodio inválido "${value}", usá anilist:episodio`);
  return { animeId, episode };
}

function apiUrl(base, path, params = {}) {
  const url = new URL(path, base.replace(/\/$/, "") + "/");
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }
  return url;
}

function coveredLangCodesFromAudioTrack(track) {
  const out = new Set();
  const code = String(track?.code || "").toUpperCase();
  const rawLang = String(track?.lang || track?.language || track?.id || "").toLowerCase();
  if ((track?.dub || code === "ENG-DUB") && (rawLang === "en" || rawLang === "en-us")) out.add("ENG-DUB");
  if ((track?.dub || code === "ESP-LAT") && (rawLang === "es" || rawLang === "es-mx" || rawLang === "es-419")) out.add("ESP-LAT");
  if ((track?.original || code === "JAP-SUB") && (rawLang === "ja" || rawLang === "ja-jp")) out.add("JAP-SUB");
  return out;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "-";
  }
}

async function syncOvh(base, key, animeId, episode) {
  const slug = `${animeId}-${episode}-multi`;
  const res = await fetch(apiUrl(base, `/admin/api/sync-ovh-archive/${slug}`, { key }), { method: "POST" });
  const text = await res.text();
  if (!res.ok) throw new Error(`sync ${slug} HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text;
}

async function fetchAnime(base, key, animeId, episode) {
  const res = await fetch(apiUrl(base, `/anime/${animeId}/${episode}`, { key }));
  const text = await res.text();
  if (!res.ok) throw new Error(`/anime/${animeId}/${episode} HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function analyzeResponse(data) {
  const streams = Array.isArray(data?.streams) ? data.streams : [];
  const zenkai = streams.filter(s => s?.originalProvider === "zenkai" || s?.provider === "zenkai");
  const ovhMulti = zenkai.find(s => s.storageProvider === "ovh" && s.lang === "MULTI");
  const first = streams[0];
  const covered = new Set();

  if (Array.isArray(ovhMulti?.audioTracks)) {
    for (const track of ovhMulti.audioTracks) {
      for (const lang of coveredLangCodesFromAudioTrack(track)) covered.add(lang);
    }
  }

  const coveredR2 = zenkai.filter(s => s.storageProvider === "r2" && covered.has(s.lang));
  const cdnZenkai = zenkai.filter(s => hostOf(s.proxy_url || s.url) === "cdn.zenkai.live");
  const issues = [];

  if (!ovhMulti) issues.push("no apareció OVH MULTI");
  if (ovhMulti && (!Array.isArray(ovhMulti.audioTracks) || !ovhMulti.audioTracks.length)) issues.push("OVH MULTI no trae audioTracks");
  if (ovhMulti && first?.verifyKey !== ovhMulti.verifyKey) issues.push(`el primer stream no es OVH MULTI, es ${first?.verifyKey || first?.storageProvider || "unknown"}`);
  if (coveredR2.length) issues.push(`quedaron R2 cubiertos por OVH: ${coveredR2.map(s => `${s.lang}:${s.verifyKey}`).join(", ")}`);

  return {
    ok: issues.length === 0,
    issues,
    summary: {
      streams: streams.length,
      zenkai: zenkai.length,
      first: first ? `${first.storageProvider || first.provider}:${first.lang}:${hostOf(first.proxy_url || first.url)}` : "-",
      ovhMulti: ovhMulti ? `${ovhMulti.verifyKey} tracks=${ovhMulti.audioTracks?.length || 0}` : "-",
      covered: [...covered].join(",") || "-",
      coveredR2: coveredR2.map(s => `${s.lang}:${s.verifyKey}`),
      cdnZenkai: cdnZenkai.map(s => `${s.lang}:${s.verifyKey}`),
    },
  };
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.episodes.length) {
  usage();
  process.exit(args.help ? 0 : 1);
}

const key = process.env.API_KEY || "";
let failed = 0;

for (const item of args.episodes) {
  const { animeId, episode } = parseEpisode(item);
  console.log(`\n[${animeId}/${episode}] probando ${args.base}`);
  try {
    if (args.sync) {
      await syncOvh(args.base, key, animeId, episode);
      console.log("  sync OVH: ok");
    }
    const data = await fetchAnime(args.base, key, animeId, episode);
    const result = analyzeResponse(data);
    console.log(`  streams=${result.summary.streams} zenkai=${result.summary.zenkai}`);
    console.log(`  first=${result.summary.first}`);
    console.log(`  ovhMulti=${result.summary.ovhMulti}`);
    console.log(`  covered=${result.summary.covered}`);
    if (result.summary.cdnZenkai.length) console.log(`  cdnZenkai=${result.summary.cdnZenkai.join(" | ")}`);
    if (result.ok) {
      console.log("  ✅ OK OVH MULTI tiene prioridad");
    } else {
      failed++;
      console.log(`  ❌ FAIL ${result.issues.join(" | ")}`);
    }
  } catch (err) {
    failed++;
    console.log(`  ❌ ERROR ${err.message}`);
  }
}

process.exitCode = failed ? 1 : 0;
