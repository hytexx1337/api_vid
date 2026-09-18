// Scraper standalone de AnimeHeaven (animeheaven.me) — hardsub inglés, mp4
// directo (no HLS, sin extractores ni PoW). Portado de
// Anivault-Scraper/src/scrapers/animeheaven.ts, adaptado a las utils de
// api_vid (cache propia, anime-match para AniList) y parseo con regex
// (api_vid no tiene cheerio).
//
// Fix vs el original: el regex de la key era gate[ha]\(" pero el sitio emite
// gateh( "key") con espacio → parseaba 0 episodios.
import { cacheGet, cacheSet } from "../lib/cache.js";
import {
  HARDSUB_UA,
  fetchHtml,
  decodeEntities,
  stripTags,
  getAnimeMedia,
  buildTitles,
  expectedCount,
  getPrequelOffset,
  selectSeries,
  diceCoeff,
} from "../lib/anime-match.js";

const BASE = "https://animeheaven.me";
const SERIES_TTL = 24 * 60 * 60 * 1000;
const EPS_TTL = 60 * 60 * 1000;

function mkLap(scope) {
  const t0 = Date.now();
  return (step) => console.log(`  [animeheaven ${scope}] ${step}: ${Date.now() - t0}ms`);
}

// ---------------------------------------------------------------------------
// Matching de títulos (portado de Anivault — maneja títulos largos, símbolos
// y markers de season/part/ova que el sitio lista como entradas separadas).
// ---------------------------------------------------------------------------

function normalizeTitle(title) {
  return String(title).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function significantWords(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

const TYPE_INDICATOR_WORDS = new Set([
  "ova", "ona", "special", "specials", "movie", "film", "recap", "picture", "pv",
  "season", "part", "cour", "saga",
]);

// Markers que el formato de AniList justifica: si el media es MOVIE, que el
// candidato agregue "movie" es correcto, no un spinoff no pedido.
function allowedTypeWords(media) {
  const fmt = String(media?.format ?? "").toUpperCase();
  const allow = new Set();
  if (fmt === "MOVIE") { allow.add("movie"); allow.add("film"); }
  if (fmt === "OVA") allow.add("ova");
  if (fmt === "ONA") allow.add("ona");
  if (fmt === "SPECIAL") { allow.add("special"); allow.add("specials"); }
  return allow;
}

function addsUnrequestedTypeIndicator(query, candidateTitle, allow = new Set()) {
  const queryWords = new Set(significantWords(query));
  return significantWords(candidateTitle).some(
    (w) => TYPE_INDICATOR_WORDS.has(w) && !queryWords.has(w) && !allow.has(w)
  );
}

// Score 0-100. Penaliza candidatos truncados (query más larga que el
// candidato → probablemente es la entrada genérica de la franquicia) y
// candidatos que agregan markers de tipo no pedidos (OVA/special/season).
function scoreTitle(query, title, allow = new Set()) {
  const needle = normalizeTitle(query);
  const hay = normalizeTitle(title);
  if (!needle || !hay) return 0;
  if (hay === needle) return 100;

  const ratio = Math.min(needle.length, hay.length) / Math.max(needle.length, hay.length);
  const queryIsLonger = needle.length > hay.length;
  const missingWords = queryIsLonger
    ? significantWords(query).length - significantWords(title).length
    : 0;
  const candidateAddsSpinoffMarker = !queryIsLonger && addsUnrequestedTypeIndicator(query, title, allow);

  if (hay.startsWith(needle) || needle.startsWith(hay)) {
    if (queryIsLonger && missingWords >= 2) return Math.floor(ratio * 30);
    if (candidateAddsSpinoffMarker) return Math.floor(ratio * 30);
    return ratio >= 0.6 ? 80 : Math.floor(ratio * 60);
  }
  if (hay.includes(needle) || needle.includes(hay)) {
    if (queryIsLonger && missingWords >= 2) return Math.floor(ratio * 25);
    if (candidateAddsSpinoffMarker) return Math.floor(ratio * 25);
    return ratio >= 0.6 ? 60 : Math.floor(ratio * 45);
  }
  let matches = 0;
  for (const ch of needle) if (hay.includes(ch)) matches++;
  return Math.floor((matches / Math.max(needle.length, 1)) * 40);
}

function firstNum(s) {
  return normalizeTitle(s).match(/\d+/)?.[0] ?? "";
}

// Score 0-1 del candidato contra TODOS los títulos de AniList. Combina el
// scoreTitle estructural (prefix/substring) con diceCoeff (bigramas) — este
// último rescata candidatos con palabras insertadas en el medio (ej. el sitio
// lista "KonoSuba – …! Movie: Legend of Crimson" y AniList "KonoSuba: …!
// Legend of Crimson": ni prefix ni substring → scoreTitle ~0.4, dice ~0.95).
// Penaliza números de temporada distintos para no repetir el bug de
// animenosub (matchear S3 cuando se pidió S1).
function scoreCandidate(titles, candidateTitle, media) {
  const allow = allowedTypeWords(media);
  let best = 0;
  for (const t of titles) {
    let s = Math.max(scoreTitle(t, candidateTitle, allow) / 100, diceCoeff(t, candidateTitle));
    const qn = firstNum(t);
    const cn = firstNum(candidateTitle);
    if (qn && cn && qn !== cn) s *= 0.5;                       // "…2" vs "…3"
    else if (!qn && cn && +cn > 1 && +cn < 1900) s *= 0.75;    // query sin nro, candidato S2+
    if (addsUnrequestedTypeIndicator(t, candidateTitle, allow)) s *= 0.6;
    if (s > best) best = s;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Scraping
// ---------------------------------------------------------------------------

// fastsearch.php devuelve <a href='/anime.php?ID'>...<div class='fastname'>T</div></a>
function parseSearch(html) {
  const results = [];
  const seen = new Set();
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']?\/?anime\.php\?([a-zA-Z0-9]+)["']?[^>]*>([\s\S]*?)<\/a>/gi)) {
    const id = m[1];
    if (seen.has(id)) continue;
    const inner = m[2];
    const nameDiv = inner.match(/class\s*=\s*["'][^"']*fastname[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const imgAlt = inner.match(/alt\s*=\s*["']([^"']*)["']/i);
    const title = stripTags(nameDiv?.[1] ?? "") || decodeEntities(imgAlt?.[1] ?? "");
    if (!title) continue;
    seen.add(id);
    results.push({ slug: id, title });
  }
  return results;
}

async function search(query) {
  const key = `heaven:search:${query.toLowerCase().trim()}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const html = await fetchHtml(`${BASE}/fastsearch.php?xhr=1&s=${encodeURIComponent(query)}`, {
    Referer: `${BASE}/`,
    "X-Requested-With": "XMLHttpRequest",
  });
  const results = parseSearch(html);
  cacheSet(key, results, EPS_TTL);
  return results;
}

// Variantes de búsqueda para títulos largos o con símbolos (portado de
// Anivault): sin posesivos, sin apóstrofes, sin "+", hasta el primer ":",
// primeras 2 palabras, primera palabra.
function titleVariants(title) {
  const noPossessive = title.replace(/[’']s\b/gi, "");
  return [
    title,
    noPossessive,
    title.replace(/[’']/g, ""),
    noPossessive.replace(/\+/g, " "),
    title.replace(/\+/g, " "),
    title.split(/[:(|-]/)[0]?.trim(),
    noPossessive.split(/[:(|-]/)[0]?.trim(),
    title.replace(/[’']/g, "").split(/\s+/).slice(0, 2).join(" "),
    noPossessive.split(/\s+/).slice(0, 2).join(" "),
    title.replace(/[’']/g, "").split(/\s+/)[0],
    noPossessive.split(/\s+/)[0],
  ].filter((v) => v && v.trim().length >= 3);
}

// La página de la serie lista los eps como
// <a onmouseover='gateh( "KEY")' onclick='gatea( "KEY")' href='gate.php'>
//   ...<div class='watch2'>12</div></a>
// OJO: el sitio emite gateh( "key") CON espacio — el regex original de
// Anivault (gate[ha]\(") no matcheaba y devolvía 0 episodios.
function parseEpisodes(html) {
  const episodes = [];
  const seen = new Set();
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = m[1];
    if (!/gate[ha]\(/.test(attrs)) continue;
    const key = attrs.match(/gate[ha]\(\s*["']([^"']+)["']/)?.[1];
    const numText = m[2].match(/class\s*=\s*["'][^"']*watch2[^"']*["'][^>]*>([^<]*)/i)?.[1];
    const num = Number(String(numText ?? "").trim().replace(/^0+(\d)/, "$1"));
    if (!key || !Number.isFinite(num) || seen.has(key)) continue;
    seen.add(key);
    episodes.push({ id: key, number: num });
  }
  return episodes.sort((a, b) => a.number - b.number);
}

async function fetchEpisodesRaw(id) {
  const html = await fetchHtml(`${BASE}/anime.php?${id}`, {
    Referer: `${BASE}/`,
    "X-Requested-With": "XMLHttpRequest",
  });
  const episodes = parseEpisodes(html);
  if (!episodes.length) throw new Error(`AnimeHeaven: no episodes for ${id}`);
  return episodes;
}

// Cache 1h; si el ep pedido no está en la lista cacheada se refetchea fresco
// (ep recién emitido).
async function fetchEpisodes(id, { fresh = false } = {}) {
  const key = `heaven:eps:${id}`;
  if (!fresh) {
    const cached = cacheGet(key);
    if (cached) return cached;
  }
  const episodes = await fetchEpisodesRaw(id);
  cacheSet(key, episodes, EPS_TTL);
  return episodes;
}

// gate.php responde <video><source src="https://cy.animeheaven.me/video.mp4?KEY&TOKEN">
// con varios mirrors (cy/ct/ck). Requiere Cookie: key=<episodeId>.
async function fetchStreamUrls(episodeId) {
  const html = await fetchHtml(`${BASE}/gate.php`, {
    Cookie: `key=${episodeId}`,
    Referer: `${BASE}/`,
    Accept: "text/html,*/*",
    "X-Requested-With": "XMLHttpRequest",
  });
  const sources = [...html.matchAll(/<source\b[^>]*?src\s*=\s*["']([^"']+)["']/gi)]
    .map((m) => decodeEntities(m[1]).trim())
    .filter((u) => /^https?:\/\//i.test(u))
    // Los sources con &error/&error2 son los fallbacks ct/ck del player —
    // nodos muertos/degradados que no sirven el video.
    .filter((u) => !/[&?]error\d*$/i.test(u));
  return [...new Set(sources)];
}

// ---------------------------------------------------------------------------
// Resolución de serie: búsqueda por variantes de TODOS los títulos de AniList
// (english/romaji/synonyms) + selección por cobertura de episodios con
// selectSeries (modo local u offset si el sitio numera continuo entre
// temporadas — el mismo criterio que animenosub/aniwaves).
// ---------------------------------------------------------------------------

async function resolveSeries(anilistId, lap = () => {}) {
  const cacheKey = `heaven:series:${anilistId}`;
  const cached = cacheGet(cacheKey);
  if (cached) { lap(`series cache hit → ${cached.id}`); return cached; }

  const media = await getAnimeMedia(anilistId);
  const titles = buildTitles(media);
  const expected = expectedCount(media);
  lap(`anizip media (expected=${expected})`);

  // Variantes de los primeros 3 títulos, cap 10 queries en paralelo.
  const queries = [...new Set(titles.slice(0, 3).flatMap(titleVariants))].slice(0, 10);
  const discovered = new Map();
  await Promise.all(queries.map(async (q) => {
    try {
      for (const r of await search(q)) if (!discovered.has(r.slug)) discovered.set(r.slug, r);
    } catch {}
  }));
  lap(`search ×${queries.length} → ${discovered.size} candidatos`);

  // Score del candidato = mejor combinación scoreTitle/diceCoeff contra
  // cualquier título de AniList, con penalizaciones de número y spinoff.
  const candidates = [...discovered.values()]
    .map((c) => ({ ...c, score: scoreCandidate(titles, c.title, media) }))
    .filter((c) => c.score >= 0.6)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  if (!candidates.length) throw new Error(`AnimeHeaven: no match for AniList ${anilistId}`);

  // Un candidato sin episodios (entrada vacía/película sin listar) se
  // descarta — si fetchEpisodes tira, Promise.all rechazaría todo.
  const scrapeFn = async (id) => fetchEpisodes(id).catch(() => []);
  let offset = 0;
  let selected = await selectSeries(candidates, scrapeFn, expected, media.status, 0, { minScore: 0.5 });
  // Fallback lazy: solo si el match local falla se consulta el offset de
  // precuelas a AniList (sitios que numeran continuo entre temporadas) —
  // el path común no toca graphql.anilist.co.
  if (!selected) {
    offset = await getPrequelOffset(anilistId).catch(() => 0);
    if (offset) {
      lap(`sin match local — reintento con offset=${offset}`);
      selected = await selectSeries(candidates, scrapeFn, expected, media.status, offset, { minScore: 0.5 });
    }
  }
  if (!selected) throw new Error(`AnimeHeaven: no confident match for AniList ${anilistId}`);
  lap(`match → ${selected.slug} "${selected.title}" mode=${selected.mode} eps=${selected.episodes.length}`);

  const data = { id: selected.slug, title: selected.title, mode: selected.mode, offset };
  cacheSet(cacheKey, data, SERIES_TTL);
  return data;
}

// Devuelve { sub: [{url, referer, server, type:"mp4"}] } — mirrors incluidos.
// El "sub" de animeheaven es hardsub inglés (streams.js lo etiqueta JAP-EN-HS).
export async function getAnimeheavenStreams(anilistId, episode) {
  const lap = mkLap(`${anilistId}/${episode}`);
  const series = await resolveSeries(anilistId, lap);

  const targetNum = series.mode === "offset" ? Number(episode) + (series.offset ?? 0) : Number(episode);
  let episodes = await fetchEpisodes(series.id);
  lap(`episodes (${episodes.length})`);
  let ep = episodes.find((e) => e.number === targetNum);
  if (!ep) {
    episodes = await fetchEpisodes(series.id, { fresh: true });
    ep = episodes.find((e) => e.number === targetNum);
    if (ep) lap(`episodes refetch fresco (${episodes.length})`);
  }
  if (!ep) throw new Error(`AnimeHeaven: episode ${episode} (site #${targetNum}) not found`);

  const urls = await fetchStreamUrls(ep.id);
  lap(`gate → ${urls.length} mirrors`);
  if (!urls.length) throw new Error(`AnimeHeaven: no sources for episode ${episode}`);

  return {
    sub: urls.map((url, i) => ({
      url,
      referer: `${BASE}/`,
      server: `heaven-${i + 1}`,
      type: "mp4",
    })),
  };
}
