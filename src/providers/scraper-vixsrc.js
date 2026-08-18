/**
 * scraper-vixsrc.js
 *
 * Obtiene streams de series y películas desde vixsrc.to.
 *
 * Flujo:
 *   GET vixsrc.to/api/{type}/{tmdbId}[/{season}/{episode}]
 *     → { src: "/embed/{id}?token=...&expires=..." }
 *   GET vixsrc.to/embed/{id}?...
 *     → HTML con window.masterPlaylist.params.token + expires (60 días)
 *   GET vixsrc.to/playlist/{id}?token={masterToken}&expires={exp}&h=1&lang=en
 *     → M3U8 con #EXT-X-MEDIA AUDIO/SUBTITLES + #EXT-X-STREAM-INF video
 *   Para cada subtítulo: GET playlist/?type=subtitle&rendition={lang}&token=...
 *     → M3U8 de un segmento con la URL real del .vtt
 *
 * Notas:
 *   - El master M3U8 usa AES-128 con URI="/storage/enc.key" (key pública, sin restricciones)
 *   - Los sub-playlists y segmentos NO requieren Referer
 *   - El master tampoco requiere Referer si se usa el token de masterPlaylist (60 días)
 *
 * Devuelve: { masterUrl, subtitles: [{ lang, name, url }] }
 */

const BASE = "https://vixsrc.to";
const UA   = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const HEADERS = { "User-Agent": UA, "Referer": `${BASE}/` };

// ── Cache ─────────────────────────────────────────────────────────────────────
const _cache = new Map();
function cacheGet(k) {
  const e = _cache.get(k);
  if (!e) return null;
  if (Date.now() > e.exp) { _cache.delete(k); return null; }
  return e.val;
}
function cacheSet(k, v, ttlMs) { _cache.set(k, { val: v, exp: Date.now() + ttlMs }); }

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchEmbedId(tmdbId, type, season, episode) {
  const path = type === "tv"
    ? `${BASE}/api/tv/${tmdbId}/${season}/${episode}`
    : `${BASE}/api/movie/${tmdbId}`;

  const r = await fetch(path, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw Object.assign(new Error(`vixsrc api HTTP ${r.status}`), { status: r.status });
  const json = await r.json();
  if (!json?.src) throw Object.assign(new Error("vixsrc: no src en respuesta"), { status: 502 });

  // src = "/embed/180649?token=...&expires=..."
  const embedId = json.src.match(/\/embed\/(\d+)/)?.[1];
  const embedUrl = `${BASE}${json.src}`;
  if (!embedId) throw Object.assign(new Error("vixsrc: no se pudo extraer embedId"), { status: 502 });
  return { embedId, embedUrl };
}

async function fetchMasterPlaylistToken(embedId, embedUrl) {
  const r = await fetch(embedUrl, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw Object.assign(new Error(`vixsrc embed HTML HTTP ${r.status}`), { status: r.status });
  const html = await r.text();

  // window.masterPlaylist = { params: { 'token': 'xxx', 'expires': 'yyy' }, url: '...' }
  const token        = html.match(/'token'\s*:\s*'([a-f0-9]+)'/)?.[1];
  const expires      = html.match(/'expires'\s*:\s*'(\d+)'/)?.[1];
  const urlBase      = html.match(/masterPlaylist[\s\S]*?url:\s*'([^']+)'/)?.[1]
                       ?? `${BASE}/playlist/${embedId}`;
  const thumbnailVtt = html.match(/window\.thumbnailsUrl\s*=\s*'([^']+)'/)?.[1] ?? null;

  if (!token || !expires)
    throw Object.assign(new Error("vixsrc: no se encontró masterPlaylist en HTML"), { status: 502 });

  return { token, expires, urlBase, thumbnailVtt };
}

// Sigue un sub-M3U8 de subtítulo y extrae la URL del .vtt real
async function resolveSubVtt(subM3u8Url) {
  try {
    const r = await fetch(subM3u8Url, { headers: HEADERS, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const text = await r.text();
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (t && !t.startsWith("#")) return t;
    }
  } catch {}
  return null;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * @param {string} tmdbId
 * @param {"tv"|"movie"} type
 * @param {string|number} [season]
 * @param {string|number} [episode]
 * @returns {{ masterUrl: string, subtitles: Array<{lang, name, url}> }}
 */
export async function getVixsrcStream(tmdbId, type, season, episode) {
  const cacheKey = type === "tv"
    ? `vixsrc:tv:${tmdbId}:${season}:${episode}`
    : `vixsrc:movie:${tmdbId}`;

  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // 1. Obtener embed URL
  const { embedId, embedUrl } = await fetchEmbedId(tmdbId, type, season, episode);

  // 2. Extraer masterPlaylist token + thumbnails desde el HTML del embed
  const { token, expires, urlBase, thumbnailVtt } = await fetchMasterPlaylistToken(embedId, embedUrl);
  const sep = urlBase.includes("?") ? "&" : "?";
  const masterUrl = `${urlBase}${sep}token=${token}&expires=${expires}&h=1&lang=en`;

  // 3. Fetch del master M3U8
  const m3u8Res = await fetch(masterUrl, {
    headers: { "User-Agent": UA, "Accept": "*/*" },
    signal: AbortSignal.timeout(10000),
  });
  if (!m3u8Res.ok)
    throw Object.assign(new Error(`vixsrc playlist HTTP ${m3u8Res.status}`), { status: m3u8Res.status });
  const m3u8 = await m3u8Res.text();
  if (!m3u8.startsWith("#EXTM3U"))
    throw Object.assign(new Error("vixsrc: respuesta no es M3U8"), { status: 502 });

  // 4. Parsear subtítulos del M3U8
  const rawSubs = [];
  for (const line of m3u8.split("\n")) {
    if (!line.startsWith("#EXT-X-MEDIA") || !line.includes("TYPE=SUBTITLES")) continue;
    const lang = line.match(/LANGUAGE="([^"]+)"/)?.[1];
    const name = line.match(/NAME="([^"]+)"/)?.[1];
    const uri  = line.match(/URI="([^"]+)"/)?.[1];
    if (lang && uri) rawSubs.push({ lang, label: name ?? lang, uri });
  }

  // 5. Resolver VTT en paralelo (batches de 6)
  const subtitles = [];
  const BATCH = 6;
  for (let i = 0; i < rawSubs.length; i += BATCH) {
    const batch = rawSubs.slice(i, i + BATCH);
    const vttUrls = await Promise.all(batch.map(s => resolveSubVtt(s.uri)));
    for (let j = 0; j < batch.length; j++) {
      if (vttUrls[j]) subtitles.push({ lang: batch[j].lang, label: batch[j].label, url: vttUrls[j] });
    }
  }

  // Filtrar solo subtítulos en español e inglés
  const wantedLangs = /^(eng|en|spa|es|spa-419|es-419|es-la)/i;
  const wantedNames = /english|spanish|español/i;
  const filteredSubs = subtitles.filter(
    s => wantedLangs.test(s.lang) || wantedNames.test(s.label)
  );

  // Cache por ~50 días (el token del master dura ~60 días)
  const TTL = 50 * 24 * 60 * 60 * 1000;
  const result = { masterUrl, subtitles: filteredSubs, thumbnailVtt };
  cacheSet(cacheKey, result, TTL);
  return result;
}
