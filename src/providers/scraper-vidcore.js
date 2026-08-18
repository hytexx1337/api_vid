/**
 * scraper-vidcore.js
 *
 * Obtiene streams de películas y series desde vidcore.net vía enc-dec.app.
 *
 * Flujo:
 *   1. GET vidcore.net/{movie|tv}/{tmdbId}[/{season}/{episode}]
 *      → extraer texto cifrado de la página (regex \"en\":\"...\")
 *   2. GET enc-dec.app/api/enc-vidcore?text={text}
 *      → { servers, stream, token }
 *   3. POST {servers} con X-CSRF-Token
 *      → texto cifrado de servidores disponibles
 *   4. POST enc-dec.app/api/dec-vidcore { text: encServers }
 *      → array de { data: ... }
 *   5. Para cada servidor: POST {stream}/{data} con X-CSRF-Token
 *      → texto cifrado del stream
 *   6. POST enc-dec.app/api/dec-vidcore { text: encStream }
 *      → { sources: [{ url, quality }], subtitles: [{ lang, url }] }
 */

const ENC_DEC = "https://enc-dec.app/api";
const BASE_URL = "https://vidcore.net";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

const PAGE_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Referer": "https://vidcore.net/",
};

const WANTED_LANGS  = /\b(english|spanish|español|eng|spa)\b/i;

const VDRK_HEADERS = {
  "Origin":   "https://vidrock.ru",
  "Pragma":   "no-cache",
  "Priority": "u=1, i",
  "Referer":  "https://vidrock.ru/",
};
const VDRK_WANTED = /^(english|spanish|español)\d*$/i;

function normalizeLangLabel(lang) {
  const s = (lang ?? "").toLowerCase().trim();
  if (/^(english|eng|en)$/.test(s))                   return "English";
  if (/^(spanish|español|spa|es)$/.test(s))            return "Español";
  if (/spanish.*latin|español.*latin|419|es-la/.test(s)) return "Español Latino";
  return lang?.replace(/\b\w/g, c => c.toUpperCase()) ?? lang;
}

// ── Cache ─────────────────────────────────────────────────────────────────────
const _cache = new Map();
function cacheGet(k) {
  const e = _cache.get(k);
  if (!e) return null;
  if (Date.now() > e.exp) { _cache.delete(k); return null; }
  return e.val;
}
function cacheSet(k, v, ttlMs) { _cache.set(k, { val: v, exp: Date.now() + ttlMs }); }

// ── Paso 1: Fetch página + extraer text token ─────────────────────────────────
async function fetchPageToken(mediaType, tmdbId, season, episode) {
  const path = mediaType === "movie"
    ? `/movie/${tmdbId}`
    : `/tv/${tmdbId}/${season}/${episode}`;

  const url = `${BASE_URL}${path}/`;
  const r = await fetch(url, {
    headers: PAGE_HEADERS,
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`vidcore: página HTTP ${r.status} (${url})`);

  const html = await r.text();

  const match = html.match(/\\"en\\":\\"(.*?)\\"/);
  if (!match) throw new Error("vidcore: no se encontró el token en la página");
  return match[1];
}

// ── Paso 2: enc-vidcore → { servers, stream, token } ─────────────────────────
async function encodeToken(text) {
  const r = await fetch(`${ENC_DEC}/enc-vidcore?text=${encodeURIComponent(text)}`, {
    signal: AbortSignal.timeout(8000),
  });
  const json = await r.json();
  if (json.status !== 200) throw new Error(`enc-vidcore: ${json.error ?? json.status}`);
  const { servers, stream, token } = json.result;
  // "token" ahora puede venir vacío (vidcore.net dejó de exigir CSRF) — solo
  // servers/stream son estrictamente necesarios para continuar el flujo.
  if (!servers || !stream) throw new Error("enc-vidcore: respuesta incompleta");
  return { servers, stream, token: token ?? "" };
}

// ── Paso 3+4: Obtener y descifrar lista de servidores ─────────────────────────
async function fetchServers(serversUrl, token) {
  const headers = {
    "User-Agent": UA,
    "Referer": "https://vidcore.net/",
    "X-Requested-With": "XMLHttpRequest",
    "X-CSRF-Token": token,
  };

  const r = await fetch(serversUrl, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`vidcore servers: HTTP ${r.status}`);

  const encText = await r.text();
  if (!encText?.trim()) throw new Error("vidcore servers: respuesta vacía");

  const dec = await fetch(`${ENC_DEC}/dec-vidcore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: encText }),
    signal: AbortSignal.timeout(8000),
  }).then(r => r.json());

  if (dec.status !== 200) throw new Error(`dec-vidcore servers: ${dec.error ?? dec.status}`);
  if (!Array.isArray(dec.result) || !dec.result.length) throw new Error("vidcore: sin servidores disponibles");
  return dec.result; // [{ data: "...", ... }, ...]
}

// ── Paso 5+6: Obtener y descifrar stream de un servidor ───────────────────────
async function fetchStream(streamBase, data, token) {
  const headers = {
    "User-Agent": UA,
    "Referer": "https://vidcore.net/",
    "X-Requested-With": "XMLHttpRequest",
    "X-CSRF-Token": token,
  };

  const url = `${streamBase}/${data}`;
  const r = await fetch(url, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`vidcore stream: HTTP ${r.status}`);

  const encText = await r.text();
  if (!encText?.trim()) throw new Error("vidcore stream: respuesta vacía");

  const dec = await fetch(`${ENC_DEC}/dec-vidcore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: encText }),
    signal: AbortSignal.timeout(8000),
  }).then(r => r.json());

  if (dec.status !== 200) throw new Error(`dec-vidcore stream: ${dec.error ?? dec.status}`);
  return dec.result; // { sources: [...], subtitles: [...] }
}

// ── API pública ───────────────────────────────────────────────────────────────
/**
 * @param {string|number} tmdbId
 * @param {"movie"|"tv"}  mediaType
 * @param {number}        [season]
 * @param {number}        [episode]
 * @returns {Promise<{ url, quality, type, provider, referer, subtitles? }>}
 */
function vttToSeconds(t) {
  const [h, m, rest] = t.split(":");
  return +h * 3600 + +m * 60 + parseFloat(rest.replace(",", "."));
}

async function getSubSignature(url) {
  try {
    const r = await fetch(url, {
      headers: { ...VDRK_HEADERS, "Range": "bytes=0-2000" },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const text = await r.text();
    const timings = [...text.matchAll(/(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*-->/g)].map(m => m[1]);
    if (!timings.length) return null;
    const main = timings.filter(t => vttToSeconds(t) >= 5);
    return (main.length >= 3 ? main.slice(0, 3) : timings.slice(0, 3)).join("|");
  } catch {
    return null;
  }
}

export async function getVidrkSubs(tmdbId, mediaType = "movie", season = 1, episode = 1) {
  const path = mediaType === "movie"
    ? `/v1/movie/${tmdbId}`
    : `/v1/tv/${tmdbId}/${season}/${episode}`;
  try {
    const r = await fetch(`https://sub.vdrk.site${path}`, {
      headers: VDRK_HEADERS,
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return [];
    const list = await r.json();
    if (!Array.isArray(list)) return [];

    const candidates = list.filter(s => VDRK_WANTED.test(s.label ?? ""));

    const withSigs = await Promise.all(
      candidates.map(async s => ({ s, sig: await getSubSignature(s.file) }))
    );

    const groups = new Map();
    for (const { s, sig } of withSigs) {
      if (!sig) continue;
      const baseLang = s.label.toLowerCase().replace(/\d+$/, "");
      if (!groups.has(baseLang)) groups.set(baseLang, []);
      groups.get(baseLang).push({ s, sig });
    }

    const result = [];
    for (const [baseLang, entries] of groups) {
      const seenSigs = new Set();
      let version = 1;
      for (const { s, sig } of entries) {
        if (seenSigs.has(sig)) continue;
        seenSigs.add(sig);
        const baseLabel = normalizeLangLabel(baseLang);
        result.push({
          label:   version === 1 ? baseLabel : `${baseLabel} (${version})`,
          lang:    /english/i.test(baseLang) ? "en" : "es",
          url:     s.file,
          kind:    "captions",
          default: /english/i.test(baseLang) && version === 1,
          referer: "https://vidrock.ru/",
        });
        version++;
      }
    }
    return result;
  } catch {
    return [];
  }
}

const WORKER_URL = "https://vidcore-scraper.vidify-proxy.workers.dev";

async function getVidcoreViaWorker(tmdbId, mediaType, season, episode) {
  const params = new URLSearchParams({ type: mediaType, tmdbId, season, episode });
  const url = `${WORKER_URL}?${params}`;
  console.log(`[vidcore] worker → ${url}`);
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const j = await r.json();
  console.log(`[vidcore] worker status=${r.status} body=${JSON.stringify(j).slice(0, 120)}`);
  if (!r.ok || j.error) throw new Error(`vidcore worker: ${j.error ?? r.status}`);
  return j;
}

export async function getVidcoreStream(tmdbId, mediaType = "movie", season = 1, episode = 1) {
  const cacheKey = `vidcore:${tmdbId}:${mediaType}:${season}:${episode}`;
  const hit = cacheGet(cacheKey);
  if (hit) return hit;

  console.log(`[vidcore] ${mediaType} tmdb=${tmdbId} S${season}E${episode}`);

  const result = await getVidcoreViaWorker(tmdbId, mediaType, season, episode);
  cacheSet(cacheKey, result, 2 * 60 * 60 * 1000);
  return result;
}
