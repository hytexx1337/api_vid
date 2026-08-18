/**
 * scraper-megaplay.js
 *
 * Extrae streams directamente de megaplay.buzz sin depender de animerealms.
 *
 * Flujo:
 *  1. GET /stream/ani/{anilistId}/{episode}/{type}  con Referer permitido → HTML
 *  2. Extraer data-id del div#megaplay-player
 *  3. GET /stream/getSources?id={dataId}            → JSON con m3u8 + subtítulos + skip
 *
 * El CDN (cdn.mewstream.buzz) necesita Referer: https://megaplay.buzz/
 * para servir los segmentos HLS.
 */

const BASE     = "https://megaplay.buzz";
const VIDWISH  = "https://vidwish.live";
const UA       = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const REFERER  = "https://megaplay.buzz/";

const CDN_HEADERS = {
  "Referer":   "https://megaplay.buzz/",
  "Origin":    "https://megaplay.buzz",
  "User-Agent": UA,
};

/**
 * Convierte una URL de cdn.mewstream.buzz a nekostream.site.
 * mewstream.buzz bloquea IPs fuera de Asia; nekostream.site sirve el mismo
 * contenido (hashes idénticos) sin restricción geográfica.
 *
 * Ejemplo:
 *   cdn.mewstream.buzz/anime/{h1}/{h2}/master.m3u8
 *   → 9hjkrt.nekostream.site/{h1}/{h2}/master.m3u8
 */
function mewToNeko(url) {
  const m = url.match(/mewstream\.buzz\/anime\/([a-f0-9][\w/.-]+)/);
  return m ? `https://9hjkrt.nekostream.site/${m[1]}` : null;
}

// ── Cache ─────────────────────────────────────────────────────────────────────
// getSources está cacheado 1 año en Cloudflare, así que en memoria guardamos
// bastante tiempo también.
const CACHE_TTL = 12 * 60 * 60 * 1000; // 12 horas
const cache = new Map();

// ── MAL ID lookup via AniList GraphQL ────────────────────────────────────────
const malCache = new Map();
async function anilistToMal(anilistId) {
  if (malCache.has(anilistId)) return malCache.get(anilistId);
  try {
    const r = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ query: "query($id:Int){Media(id:$id){idMal}}", variables: { id: Number(anilistId) } }),
      signal: AbortSignal.timeout(8000),
    });
    const json = await r.json();
    const malId = json?.data?.Media?.idMal ?? null;
    malCache.set(anilistId, malId);
    return malId;
  } catch {
    return null;
  }
}

// ── Paso 1: HTML → data-id ────────────────────────────────────────────────────
// Intenta primero con AniList ID (/stream/ani/), luego con MAL ID (/stream/mal/).
async function fetchHtml(urlPath) {
  const r = await fetch(`${BASE}${urlPath}`, {
    headers: { "User-Agent": UA, "Referer": REFERER },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`megaplay HTTP ${r.status}`);
  return r.text();
}

function parseDataId(html) {
  if (html.includes("Error Code: 410") || html.includes("Error - MegaPlay")) return null;
  const dataId = html.match(/data-id="(\d+)"/)?.[1];
  if (dataId) return dataId;

  // New: ID in title (e.g., "File 9587 - MegaPlay")
  const fileIdMatch = html.match(/<title>File (\d+) - MegaPlay/i);
  if (fileIdMatch) return fileIdMatch[1];

  // Vidwish iframe fallback
  const iframeMatch = html.match(/src="(https:\/\/vidwish\.live\/[^"]+)"/);
  if (iframeMatch) return { vidwishUrl: iframeMatch[1] };

  return null;
}

async function fetchDataId(anilistId, episode, type = "dub") {
  // Intentar con AniList ID primero
  const html = await fetchHtml(`/stream/ani/${anilistId}/${episode}/${type}`);
  const result = parseDataId(html);
  if (result) return result;

  // Fallback: convertir a MAL ID y reintentar
  const malId = await anilistToMal(anilistId);
  if (!malId) throw new Error(`megaplay: episodio no encontrado (${type}) — anilist ${anilistId} ep ${episode}`);

  console.log(`[megaplay] anilist ${anilistId} → mal ${malId}, reintentando...`);
  const html2 = await fetchHtml(`/stream/mal/${malId}/${episode}/${type}`);
  const result2 = parseDataId(html2);
  if (result2) return result2;

  throw new Error(`megaplay: episodio no encontrado (${type}) — anilist ${anilistId} / mal ${malId} ep ${episode}`);
}

// ── Paso 2a: getSources megaplay (player nativo) ──────────────────────────────
async function fetchSources(dataId, anilistId, episode, type) {
  const url = `${BASE}/stream/getSources?id=${dataId}`;
  const r = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Referer": `${BASE}/stream/ani/${anilistId}/${episode}/${type}`,
      "X-Requested-With": "XMLHttpRequest",
      "Accept": "application/json",
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`megaplay getSources HTTP ${r.status}`);
  const data = await r.json();
  if (!data.sources?.file) throw new Error("megaplay: sin URL en getSources");
  return { data, cdnReferer: `${BASE}/` };
}

// ── Paso 2b: getSources vidwish (cuando megaplay devuelve iframe) ─────────────
// Flujo: vidwish embed page → data-id → vidwish/getSources
async function fetchSourcesVidwish(vidwishUrl) {
  // 1. Obtener el data-id real de la página embed de vidwish
  const embedUrl = vidwishUrl;
  console.log(`[megaplay] vidwish embed: ${embedUrl}`);
  const page = await fetch(embedUrl, {
    headers: { "User-Agent": UA, "Referer": `${BASE}/` },
    signal: AbortSignal.timeout(12000),
  });
  if (!page.ok) throw new Error(`vidwish embed HTTP ${page.status}`);
  const html = await page.text();

  const dataId = html.match(/data-id="(\d+)"/)?.[1];
  if (!dataId) throw new Error("vidwish: data-id no encontrado en embed page");
  console.log(`[megaplay] vidwish data-id=${dataId}`);

  // 2. getSources de vidwish
  const url = `${VIDWISH}/stream/getSources?id=${dataId}`;
  const r = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Referer": embedUrl,
      "X-Requested-With": "XMLHttpRequest",
      "Accept": "application/json",
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`vidwish getSources HTTP ${r.status}`);
  const data = await r.json();
  if (!data.sources?.file) throw new Error("vidwish: sin URL en getSources");
  return { data, cdnReferer: `${VIDWISH}/` };
}

// ── API pública ───────────────────────────────────────────────────────────────

// ── Core: obtiene un stream para el tipo dado (dub | sub) ────────────────────
async function fetchMegaplayByType(anilistId, episode, type) {
  const isDub = type === "dub";
  const rawId = await fetchDataId(anilistId, episode, type);
  console.log(`[megaplay] ${type} OK → id ${JSON.stringify(rawId)} (${anilistId} ep${episode})`);

  const { data, cdnReferer } = rawId?.vidwishUrl
    ? await fetchSourcesVidwish(rawId.vidwishUrl)
    : await fetchSources(rawId, anilistId, episode, type);

  const subtitles = (data.tracks ?? [])
    .filter(t => t.kind === "captions" || t.kind === "subtitles")
    .map(t => ({ label: t.label, url: t.file, default: t.default ?? false, referer: cdnReferer }));

  const streamUrl = data.sources.file;
  const headers = { "Referer": cdnReferer, "Origin": new URL(cdnReferer).origin, "User-Agent": UA };

  return {
    url: streamUrl,
    headers,
    lang: isDub ? "en-dub" : "ja-sub",
    subtitles,
    skip: {
      ...(data.intro && { intro: [data.intro.start, data.intro.end] }),
      ...(data.outro && { outro: [data.outro.start, data.outro.end] }),
    },
  };
}

/**
 * Obtiene ambos streams (dub + sub) de megaplay en paralelo.
 * @returns {{ dub: stream|null, sub: stream|null }}
 */
export async function getMegaplayStreams(anilistId, episode) {
  const key = `megaplay:both:${anilistId}:${episode}`;
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.data;

  const [dubResult, subResult] = await Promise.allSettled([
    fetchMegaplayByType(anilistId, episode, "dub"),
    fetchMegaplayByType(anilistId, episode, "sub"),
  ]);

  if (dubResult.status === "rejected") console.warn(`[megaplay] dub ✗: ${dubResult.reason?.message}`);
  if (subResult.status === "rejected") console.warn(`[megaplay] sub ✗: ${subResult.reason?.message}`);

  const result = {
    dub: dubResult.status === "fulfilled" ? dubResult.value : null,
    sub: subResult.status === "fulfilled" ? subResult.value : null,
  };

  if (result.dub || result.sub) {
    cache.set(key, { data: result, expiresAt: Date.now() + CACHE_TTL });
  }
  return result;
}

/**
 * Obtiene stream de anime desde megaplay.buzz.
 * Intenta dub primero, luego sub como fallback.
 * @returns {{ url, headers, lang, subtitles, skip }}
 */
export async function getMegaplayStream(anilistId, episode) {
  const { dub, sub } = await getMegaplayStreams(anilistId, episode);
  return dub ?? sub;
}
