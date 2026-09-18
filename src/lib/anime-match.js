// Utilidades compartidas por los scrapers de hardsub inglés (animeheaven,
// aniwaves): metadata vía api.ani.zip (AniList GraphQL daba 429 seguido —
// solo queda para getPrequelOffset como fallback lazy), matching de títulos
// por dice-coefficient y selección de serie por cobertura de episodios.
// Portado de Anivexa-API (core/new-provider-utils.js + core/anilist.js),
// adaptado a la cache de api_vid (cacheGet/cacheSet).
import { cacheGet, cacheSet } from "./cache.js";
import { ANILIST_HEADERS } from "../config/constants.js";

export const HARDSUB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

// La identidad de una serie (slug del sitio ↔ anilistId) no cambia — 24h.
const SERIES_TTL = 24 * 60 * 60 * 1000;

export async function fetchHtml(url, headers = {}) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": HARDSUB_UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      ...headers,
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

export function decodeEntities(s = "") {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

export function stripTags(html = "") {
  return decodeEntities(html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "));
}

export function attr(tag, name) {
  const m = String(tag).match(new RegExp(`\\b${name}=["']([^"']*)["']`, "i"));
  return m ? decodeEntities(m[1]) : "";
}

export function norm(s = "") {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function diceCoeff(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return 0;
  const bigrams = new Map();
  for (let i = 0; i < na.length - 1; i++) {
    const bg = na.slice(i, i + 2);
    bigrams.set(bg, (bigrams.get(bg) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < nb.length - 1; i++) {
    const bg = nb.slice(i, i + 2);
    const count = bigrams.get(bg) ?? 0;
    if (count > 0) {
      hits++;
      bigrams.set(bg, count - 1);
    }
  }
  return (2 * hits) / (na.length + nb.length - 2);
}

export function titleScore(query, candidate, slug) {
  const base = Math.max(diceCoeff(query, candidate), diceCoeff(query, slug.replace(/-/g, " ")));
  const queryFirstNum = norm(query).match(/\d+/)?.[0] ?? "";
  const slugFirstNum = slug.match(/\d+/)?.[0] ?? "";
  if (queryFirstNum && slugFirstNum && queryFirstNum !== slugFirstNum) return base * 0.65;
  if (queryFirstNum && !slugFirstNum) return base * 0.65;
  if (!queryFirstNum && slugFirstNum) {
    const n = parseInt(slugFirstNum);
    if (n > 1 && n < 1900) return base * (1 - 0.06 * (n - 1));
  }
  const isMovieQuery = /\b(movie|film|the movie)\b/i.test(query);
  const isMovieMatch = /\b(movie|film)\b/i.test(candidate) || /movie|film/.test(slug);
  if (isMovieQuery && !isMovieMatch) return base * 0.4;
  const qLen = norm(query).length;
  const sLen = norm(slug.replace(/-/g, " ")).length;
  return sLen > qLen * 1.6 + 4 ? base * 0.8 : base;
}

function buildSearchQueries(title) {
  const queries = new Set([title]);
  const words = title.trim().split(/\s+/);
  if (words.length > 4) queries.add(words.slice(0, 4).join(" "));
  if (words.length > 3) queries.add(words.slice(0, 3).join(" "));
  const stripped = title
    .replace(/\bseason\s*\d+\b/gi, "")
    .replace(/\bpart\s*\d+\b/gi, "")
    .replace(/\b\d+rd\b|\b\d+th\b|\b\d+st\b|\b\d+nd\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped && stripped !== title) queries.add(stripped);
  return [...queries].filter((q) => q.length >= 3);
}

// Busca con varias queries derivadas de los títulos y devuelve los slugs
// candidatos ordenados por score de título.
export async function findTopSlugs(titles, searchFn, n = 6) {
  const allCandidates = new Map();
  const searchQueries = new Set();
  for (const title of titles.slice(0, 4)) {
    for (const q of buildSearchQueries(title)) searchQueries.add(q);
  }
  await Promise.all([...searchQueries].map(async (q) => {
    try {
      const results = await searchFn(q);
      for (const r of results) if (!allCandidates.has(r.slug)) allCandidates.set(r.slug, r.text);
    } catch {}
  }));
  const scored = [];
  for (const [slug, text] of allCandidates) {
    let best = 0;
    for (const title of titles.slice(0, 2)) best = Math.max(best, titleScore(title, text, slug));
    if (best >= 0.5) scored.push({ slug, title: text, score: best });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, n);
}

async function anilistQuery(query, variables) {
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: ANILIST_HEADERS,
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`AniList: ${json.errors[0].message}`);
  return json.data;
}

// Metadata vía api.ani.zip/mappings — una request cacheada 24h de la que se
// deriva la misma shape de Media que consumían los scrapers
// (title{romaji,english,native}, synonyms, format, status, episodes, idMal).
async function fetchAniZip(anilistId) {
  const cacheKey = `anizip:mappings:${anilistId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  const res = await fetch(`https://api.ani.zip/mappings?anilist_id=${anilistId}`, {
    headers: { "User-Agent": HARDSUB_UA, Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`ani.zip HTTP ${res.status}`);
  const json = await res.json();
  if (!json?.titles && !json?.mappings) throw new Error(`ani.zip: no data for ${anilistId}`);
  cacheSet(cacheKey, json, SERIES_TTL);
  return json;
}

// ani.zip no trae status — se infiere del airDate del último ep numerado:
// si salió hace >60d se asume FINISHED (habilita el corte duro de
// selectSeries); al aire / reciente / sin data → RELEASING (sin corte: el
// sitio legítimamente tiene menos eps que los planeados).
function inferStatus(episodes) {
  const lastAir = Object.entries(episodes ?? {})
    .filter(([k]) => /^\d+$/.test(k))
    .map(([, e]) => e.airDate ?? e.airdate)
    .filter(Boolean)
    .sort()
    .at(-1);
  if (!lastAir) return "RELEASING";
  const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return lastAir > cutoff ? "RELEASING" : "FINISHED";
}

export async function getAnimeMedia(anilistId) {
  const cacheKey = `hardsub:al-media:${anilistId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  const j = await fetchAniZip(anilistId);
  const epCount = j.episodeCount ?? Object.keys(j.episodes ?? {}).filter((k) => /^\d+$/.test(k)).length;
  const year = j.episodes?.["1"]?.airDate?.slice(0, 4) ?? null;
  const media = {
    id: Number(anilistId),
    idMal: j.mappings?.mal_id ?? null,
    title: {
      romaji: j.titles?.["x-jat"] ?? null,
      english: j.titles?.en ?? null,
      native: j.titles?.ja ?? null,
    },
    // ani.zip no tiene synonyms — los títulos en otros idiomas quedan como
    // variantes extra de búsqueda.
    synonyms: [j.titles?.de, j.titles?.["zh-Hans"], j.titles?.["zh-Hant"]].filter(Boolean),
    status: inferStatus(j.episodes),
    format: j.mappings?.type ? String(j.mappings.type).toUpperCase() : null,
    episodes: epCount || null,
    seasonYear: year ? Number(year) : null,
    startDate: { year: year ? Number(year) : null },
  };
  cacheSet(cacheKey, media, SERIES_TTL);
  return media;
}

const RELATION_FRAGMENT = `edges{relationType(version:2) node{id type episodes relations{edges{relationType(version:2) node{id type episodes relations{edges{relationType(version:2) node{id type episodes relations{edges{relationType(version:2) node{id type episodes}}}}}}}}}}}`;

function computePrequelOffset(relations, depth = 0) {
  if (!relations || depth > 5) return 0;
  const prequelEdge = relations.edges?.find(
    (e) => e.relationType === "PREQUEL" && e.node.type === "ANIME" && (e.node.episodes ?? 0) >= 5
  );
  if (!prequelEdge) return 0;
  return (prequelEdge.node.episodes ?? 0) + computePrequelOffset(prequelEdge.node.relations, depth + 1);
}

// Cuántos episodios de precuelas hay que saltar para sitios que numeran la
// serie completa de forma continua (ej. animenosub).
export async function getPrequelOffset(anilistId) {
  const key = `hardsub:offset:${anilistId}`;
  const cached = cacheGet(key);
  if (cached !== null && cached !== undefined) return cached;
  const data = await anilistQuery(
    `query($id:Int){Media(id:$id,type:ANIME){relations{${RELATION_FRAGMENT}}}}`,
    { id: Number(anilistId) }
  );
  const offset = computePrequelOffset(data?.Media?.relations);
  cacheSet(key, offset, SERIES_TTL);
  return offset;
}

export function buildTitles(media) {
  return [
    media?.title?.english,
    media?.title?.romaji,
    media?.title?.native,
    ...(media?.synonyms ?? []),
  ].filter(Boolean);
}

export function expectedCount(media) {
  const n = media?.episodes;
  return Number.isFinite(n) && n > 0 ? n : null;
}

// De los candidatos de búsqueda, scrapea la lista de episodios de cada uno y
// elige el que mejor cubre la cantidad esperada (modo "local" u "offset" si
// el sitio numera continuo desde la primera temporada).
export function selectSeries(candidates, scrapeSeries, expected, status, offset, options = {}) {
  return Promise.all(candidates.map(async (candidate) => {
    const episodes = await scrapeSeries(candidate.slug);
    const max = Math.max(0, ...episodes.map((e) => e.number));
    const localHits = expected ? episodes.filter((e) => e.number >= 1 && e.number <= expected).length : episodes.length;
    const offsetHits = expected && offset
      ? episodes.filter((e) => e.number > offset && e.number <= offset + expected).length
      : 0;
    const mode = offsetHits > localHits ? "offset" : "local";
    const hits = Math.max(localHits, offsetHits);
    let countScore = 1;
    if (expected && expected >= 6) {
      const needed = status === "FINISHED" ? Math.ceil(expected * 0.9) : Math.max(1, expected - 3);
      countScore = hits >= needed ? 1 : hits / needed;
      // Corte duro (solo FINISHED): una entrada con <30% de los eps esperados
      // es otra cosa (ej. "JoJo Steel Ball Run" 1 ep para JoJo 2012 de 26
      // eps) — sin esto un titleScore alto la hacía ganar igual y devolvía el
      // stream de otra temporada/parte. En RELEASING no aplica: el sitio
      // legit tiene menos eps que los planeados en AniList.
      if (status === "FINISHED" && hits < Math.max(2, Math.ceil(expected * 0.3))) countScore = 0;
    }
    return { ...candidate, episodes, max, mode, score: countScore === 0 ? 0 : candidate.score * 0.7 + countScore * 0.3 };
  })).then((results) => {
    const minScore = options.minScore ?? 0.65;
    const viable = results
      .filter((r) => r.episodes.length && r.score >= minScore)
      .sort((a, b) => b.score - a.score);
    if (!viable.length) return null;
    return viable[0];
  });
}
