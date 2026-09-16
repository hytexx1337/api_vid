// aniwaves.ru — el "sub" del sitio es japonés con subs en inglés QUEMADOS
// (hardsub). Portado de Anivexa-API/providers/aniwaves.js, standalone:
// busca por /filter?keyword=, valida el match por título+tipo+año+cobertura
// de episodios, pide los servers del episodio por /ajax y resuelve los embeds
// (vidplay/datasv/byse) a m3u8/mp4 directos.
// Los playlists de echovideo vienen ofuscados en decimal ASCII — el proxy
// /generic-stream los decodifica (ver routes/proxy.js).
import { cacheGet, cacheSet } from "../lib/cache.js";
import { findVideoExtractor } from "../lib/hardsub-extractors.js";
import {
  HARDSUB_UA,
  decodeEntities,
  stripTags,
  attr,
  diceCoeff,
  getAnimeMedia,
  buildTitles,
  expectedCount,
} from "../lib/anime-match.js";

const BASE = "https://aniwaves.ru";
const SERIES_TTL = 24 * 60 * 60 * 1000;
const EPS_TTL = 60 * 60 * 1000;
const EXTRACT_TIMEOUT = 25_000;

// Extractores lentos: byse hace PoW + 6 requests secuenciales (~4s). Corre
// solo si los rápidos (vidplay/datasv) no devuelven nada.
const SLOW_EXTRACTORS = new Set(["byse"]);

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms)),
  ]);
}

// Timing por fase — aniwaves hace MUCHAS requests externas y necesitamos ver
// dónde se va el tiempo (búsqueda, detalles, servers, extractores).
function mkLap(scope) {
  const t0 = Date.now();
  return (step) => console.log(`  [aniwaves ${scope}] ${step}: ${Date.now() - t0}ms`);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatName(value) {
  const name = String(value || "").toUpperCase();
  if (name.includes("SPECIAL")) return "special";
  if (name === "TV" || name === "TV_SHORT") return "tv";
  if (name === "MOVIE") return "movie";
  if (name === "OVA") return "ova";
  if (name === "ONA") return "ona";
  return "";
}

function searchQueries(titles) {
  const queries = new Set();
  for (const raw of titles.slice(0, 8)) {
    const title = String(raw || "").replace(/\s+/g, " ").trim();
    if (!title) continue;
    queries.add(title);
    const plain = title.replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
    if (plain.length >= 3) queries.add(plain);
    const words = plain.split(/\s+/).filter(Boolean);
    if (words.length > 4) queries.add(words.slice(0, 4).join(" "));
    if (words.length > 6) queries.add(words.slice(0, 6).join(" "));
    const family = plain
      .replace(/\b(?:the\s+)?final\s+chapters?\b/gi, " ")
      .replace(/\bfinal\s+(?:arc|edition)\b/gi, " ")
      .replace(/\b(?:kanketsu|kouhen|zenpen)\s*(?:hen)?\b/gi, " ")
      .replace(/\b(?:the\s+)?movie\b/gi, " ")
      .replace(/\b(?:season|part|cour|chapter)\s*(?:\d+|one|two|three|four|final)?\b/gi, " ")
      .replace(/\b(?:final|special)\s*(?:\d+|one|two|three|four)?\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (family.length >= 3) queries.add(family);
  }
  return [...queries].filter((query) => query.length >= 3).slice(0, 8);
}

async function fetchText(url, headers = {}) {
  const response = await fetch(url, {
    headers: { "User-Agent": HARDSUB_UA, "Accept-Language": "en-US,en;q=0.9", ...headers },
    signal: AbortSignal.timeout(12000),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`AniWaves HTTP ${response.status}: ${url}`);
  return raw;
}

async function fetchAjax(path, referer) {
  const raw = await fetchText(`${BASE}${path}`, {
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": referer,
  });
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`AniWaves returned invalid JSON: ${path}`);
  }
  if (Number(data?.status) !== 200) throw new Error(data?.message || `AniWaves request failed: ${path}`);
  return data.result;
}

function parseSearchCards(html) {
  const found = new Map();
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const tag = match[1];
    if (!/\bclass=["'][^"']*\bname\b[^"']*\bd-title\b/i.test(tag)) continue;
    const href = attr(tag, "href");
    const slug = href.match(/^\/watch\/([a-z0-9-]+)$/i)?.[1];
    if (!slug || found.has(slug)) continue;
    const siteId = Number(slug.match(/-(\d+)$/)?.[1]);
    if (!Number.isFinite(siteId)) continue;
    const title = stripTags(match[2]);
    if (!title) continue;
    found.set(slug, { slug, siteId, title, japanese: attr(tag, "data-jp") });
  }
  return [...found.values()];
}

async function search(query) {
  const html = await fetchText(`${BASE}/filter?keyword=${encodeURIComponent(query)}`, {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Referer": `${BASE}/`,
  });
  return parseSearchCards(html);
}

function detailField(html, label) {
  const match = html.match(new RegExp(`<div>\\s*${escapeRegex(label)}:\\s*<span[^>]*>([\\s\\S]*?)<\\/span>`, "i"));
  return match ? stripTags(match[1]) : "";
}

function parseEpisodeCount(value) {
  const numbers = [...String(value).matchAll(/\d+/g)].map((match) => Number(match[0])).filter(Number.isFinite);
  return { available: numbers[0] ?? 0, total: numbers[1] ?? numbers[0] ?? 0 };
}

async function fetchDetail(candidate) {
  const html = await fetchText(`${BASE}/watch/${candidate.slug}`, {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Referer": `${BASE}/`,
  });
  const premiered = detailField(html, "Premiered");
  const aired = detailField(html, "Date aired");
  const year = Number((aired.match(/\d{4}/)?.[0] ?? premiered.match(/\d{4}/)?.[0] ?? ""));
  return {
    ...candidate,
    title: candidate.title || stripTags(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? ""),
    type: formatName(detailField(html, "Type")),
    year: Number.isFinite(year) ? year : null,
    episodes: parseEpisodeCount(detailField(html, "Episodes")),
  };
}

function candidateTitleScore(titles, candidate) {
  const values = [candidate.title, candidate.japanese, candidate.slug.replace(/-/g, " ")].filter(Boolean);
  let best = 0;
  for (const title of titles) {
    for (const value of values) best = Math.max(best, diceCoeff(title, value));
  }
  return best;
}

function coverageScore(candidate, expected, status) {
  if (!expected || expected < 1) return 0.5;
  if (candidate.episodes.available < 1) return 0;
  if (expected < 6) return 1;
  const needed = status === "FINISHED" ? Math.ceil(expected * 0.8) : Math.max(1, expected - 3);
  return Math.min(1, candidate.episodes.available / needed);
}

function validateCandidate(candidate, media, titles, expected) {
  const titleScore = candidateTitleScore(titles, candidate);
  const expectedType = formatName(media?.format);
  const expectedYear = Number(media?.startDate?.year ?? media?.seasonYear ?? 0) || null;
  if (titleScore < 0.68) return null;
  if (expectedType && candidate.type && expectedType !== candidate.type) return null;
  if (expectedYear && candidate.year && expectedYear !== candidate.year) return null;
  const coverage = coverageScore(candidate, expected, media?.status);
  if (expected >= 6 && coverage < 0.8) return null;
  const score = titleScore * 0.72 + (expectedType && candidate.type === expectedType ? 0.14 : 0.07) + (expectedYear && candidate.year === expectedYear ? 0.1 : 0.04) + coverage * 0.04;
  return { ...candidate, titleScore, coverage, score };
}

async function resolveSeries(anilistId, lap = () => {}) {
  const cacheKey = `aniwaves:series:${anilistId}`;
  const cached = cacheGet(cacheKey);
  if (cached) { lap(`series cache hit → ${cached.slug}`); return cached; }

  const media = await getAnimeMedia(anilistId);
  lap("anilist media");
  const titles = buildTitles(media);
  const expected = expectedCount(media);
  const queries = searchQueries(titles);
  const discovered = new Map();
  await Promise.all(queries.map(async (query) => {
    try {
      for (const candidate of await search(query)) if (!discovered.has(candidate.slug)) discovered.set(candidate.slug, candidate);
    } catch {}
  }));
  lap(`search ×${queries.length} → ${discovered.size} candidatos`);
  const shortlist = [...discovered.values()]
    .map((candidate) => ({ candidate, score: candidateTitleScore(titles, candidate) }))
    .filter((item) => item.score >= 0.5)
    .sort((left, right) => right.score - left.score)
    .slice(0, 6)
    .map((item) => item.candidate);
  const details = await Promise.all(shortlist.map((candidate) => fetchDetail(candidate).catch(() => null)));
  lap(`details ×${shortlist.length}`);
  const valid = details
    .filter(Boolean)
    .map((candidate) => validateCandidate(candidate, media, titles, expected))
    .filter(Boolean)
    .sort((left, right) => right.score - left.score);
  const selected = valid[0];
  const runnerUp = valid[1];
  if (!selected || selected.score < 0.82 || runnerUp && selected.score - runnerUp.score < 0.08) {
    throw new Error(`AniWaves match not confident for AniList ${anilistId}`);
  }
  lap(`match → ${selected.slug} (score ${selected.score.toFixed(2)})`);
  const data = { siteId: selected.siteId, slug: selected.slug, title: selected.title };
  cacheSet(cacheKey, data, SERIES_TTL);
  return data;
}

function parseEpisodes(html) {
  const episodes = [];
  const seen = new Set();
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = match[1];
    const number = Number(attr(attrs, "data-num"));
    const sourceNumber = attr(attrs, "data-slug") || String(number);
    if (!Number.isFinite(number) || number < 1 || seen.has(number)) continue;
    const ids = attr(attrs, "data-ids");
    if (!ids) continue;
    seen.add(number);
    episodes.push({
      number,
      sourceNumber,
      title: stripTags(match[2]).replace(/^\d+\s*/, "") || `Episode ${number}`,
      hasSub: attr(attrs, "data-sub") === "1",
      hasDub: attr(attrs, "data-dub") === "1",
    });
  }
  return episodes.sort((left, right) => left.number - right.number);
}

async function fetchEpisodesRaw(series) {
  const result = await fetchAjax(`/ajax/episode/list/${series.siteId}?vrf=`, `${BASE}/watch/${series.slug}`);
  const episodes = parseEpisodes(String(result || ""));
  if (!episodes.length) throw new Error(`AniWaves has no episodes for ${series.slug}`);
  return episodes;
}

// La lista de episodios cambia solo cuando emiten uno nuevo — cachearla 1h
// ahorra ~2-3s por request (aniwaves.ru responde lento). Si el episodio
// pedido no está en la lista cacheada, se refetchea fresco (ep recién salido).
async function fetchEpisodes(series, { fresh = false } = {}) {
  const key = `aniwaves:eps:${series.siteId}`;
  if (!fresh) {
    const cached = cacheGet(key);
    if (cached) return cached;
  }
  const episodes = await fetchEpisodesRaw(series);
  cacheSet(key, episodes, EPS_TTL);
  return episodes;
}

function ordinal(value) {
  const match = String(value || "").toLowerCase().match(/\b(?:part|special|chapter)\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/);
  if (!match) return 0;
  const word = match[1];
  const numbers = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  return Number(word) || numbers[word] || 0;
}

// Si el sitio lista más episodios que los esperados y el anime es una "parte"
// (ej. "Season 2 Part 2"), realinea por el ordinal del título.
function alignEpisodes(sourceEpisodes, media, expected) {
  if (!expected || sourceEpisodes.length <= expected) return sourceEpisodes;
  const targetTitles = [media?.title?.english, media?.title?.romaji, media?.title?.native].filter(Boolean);
  const targetOrdinal = Math.max(0, ...targetTitles.map(ordinal));
  if (targetOrdinal < 2) return sourceEpisodes;
  const start = sourceEpisodes.findIndex((episode) => ordinal(episode.title) === targetOrdinal);
  if (start < 0 || sourceEpisodes.length - start < expected) return sourceEpisodes;
  return sourceEpisodes.slice(start, start + expected).map((episode, index) => ({ ...episode, number: index + 1 }));
}

function parseServerGroups(html) {
  const groups = [];
  const markers = [...html.matchAll(/<div\b([^>]*)>/gi)]
    .map((match) => ({ index: match.index, attrs: match[1], type: attr(match[1], "data-type") }))
    .filter((item) => item.type === "sub" || item.type === "dub");
  for (let index = 0; index < markers.length; index++) {
    const current = markers[index];
    const end = markers[index + 1]?.index ?? html.length;
    const segment = html.slice(current.index, end);
    for (const match of segment.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/gi)) {
      const attrs = match[1];
      const linkId = attr(attrs, "data-link-id");
      if (!linkId) continue;
      groups.push({
        audio: current.type,
        linkId,
        server: stripTags(match[2]) || "AniWaves",
      });
    }
  }
  return groups;
}

async function fetchServers(series, episode) {
  const result = await fetchAjax(
    `/ajax/server/list?servers=${encodeURIComponent(series.siteId)}&eps=${encodeURIComponent(episode.sourceNumber)}`,
    `${BASE}/watch/${series.slug}/ep-${episode.sourceNumber}`,
  );
  return parseServerGroups(String(result || ""));
}

async function fetchSource(linkId, referer) {
  const result = await fetchAjax(`/ajax/sources?id=${encodeURIComponent(linkId)}&asi=0&autoPlay=0`, referer);
  if (!result?.url) throw new Error("AniWaves source response has no embed url");
  return result;
}

function skipRange(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const start = Number(value[0]);
  const end = Number(value[1]);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? [start, end] : null;
}

// Devuelve { sub: [{url, referer, server, skip}] } — solo streams resueltos.
// El "sub" de aniwaves es hardsub inglés (streams.js lo etiqueta JAP-EN-HS).
export async function getAniwavesStreams(anilistId, episode) {
  const lap = mkLap(`${anilistId}/${episode}`);
  const media = await getAnimeMedia(anilistId);
  lap("anilist media");
  const series = await resolveSeries(anilistId, lap);
  const expected = expectedCount(media);
  let episodes = alignEpisodes(await fetchEpisodes(series), media, expected);
  lap(`episodes (${episodes.length})`);
  let ep = episodes.find((item) => item.number === Number(episode));
  if (!ep) {
    // Puede ser un ep recién emitido que no está en la lista cacheada.
    episodes = alignEpisodes(await fetchEpisodes(series, { fresh: true }), media, expected);
    ep = episodes.find((item) => item.number === Number(episode));
    if (ep) lap(`episodes refetch fresco (${episodes.length})`);
  }
  if (!ep || !ep.hasSub) throw new Error(`AniWaves sub episode ${episode} not found`);

  const servers = (await fetchServers(series, ep)).filter((server) => server.audio === "sub");
  lap(`servers (${servers.length} sub)`);
  if (!servers.length) throw new Error(`AniWaves has no sub servers for episode ${episode}`);
  const referer = `${BASE}/watch/${series.slug}/ep-${ep.sourceNumber}`;

  const settled = await Promise.all(servers.map(async (server) => {
    const ts = Date.now();
    try {
      const source = await fetchSource(server.linkId, referer);
      lap(`source ${server.server}: ${Date.now() - ts}ms`);
      return { server, source };
    } catch (error) {
      lap(`source ${server.server} ✗: ${Date.now() - ts}ms (${error.message})`);
      return { server, error };
    }
  }));

  const sub = [];
  let skip = null;
  const extractOne = async (item) => {
    if (!item.source?.url) return { item, streams: [] };
    const extractor = findVideoExtractor(item.source.url);
    if (!extractor) return { item, streams: [] };
    const ts = Date.now();
    try {
      const streams = await withTimeout(
        extractor.extract(item.source.url, { userAgent: HARDSUB_UA, referer }),
        EXTRACT_TIMEOUT,
        `aniwaves:${extractor.name}`,
      );
      console.log(`  [aniwaves] extract ${extractor.name} (${item.server.server}): ${Date.now() - ts}ms → ${streams?.length ?? 0} streams`);
      return { item, extractor, streams };
    } catch (e) {
      console.log(`  [aniwaves] extract ${extractor.name} (${item.server.server}) ✗: ${Date.now() - ts}ms (${e.message})`);
      return { item, extractor, streams: [] };
    }
  };

  // Dos fases: primero los extractores rápidos; los lentos (byse: PoW + 6
  // requests secuenciales ~4s) solo si los rápidos no devolvieron nada.
  const isSlow = (item) => {
    const ex = item.source?.url && findVideoExtractor(item.source.url);
    return ex && SLOW_EXTRACTORS.has(ex.name);
  };
  const fastItems = settled.filter((item) => item.source?.url && !isSlow(item));
  const slowItems = settled.filter(isSlow);
  let extracted = await Promise.all(fastItems.map(extractOne));
  if (!extracted.some((r) => r.streams?.length) && slowItems.length) {
    lap("fast extractors vacíos — probando extractores lentos");
    extracted = extracted.concat(await Promise.all(slowItems.map(extractOne)));
  }
  for (const { item, streams } of extracted) {
    if (!streams?.length) continue;
    const sourceReferer = (() => {
      try { return `${new URL(item.source.url).origin}/`; } catch { return referer; }
    })();
    const skipData = item.source.skip_data ?? {};
    skip ??= (() => {
      const intro = skipRange(skipData.intro);
      const outro = skipRange(skipData.outro);
      return (intro || outro) ? { ...(intro && { intro }), ...(outro && { outro }) } : null;
    })();
    for (const stream of streams) {
      const source = typeof stream === "string" ? { url: stream, type: "hls" } : stream;
      if (!source.url) continue;
      sub.push({ url: source.url, type: source.type ?? "hls", referer: sourceReferer, server: item.server.server, quality: source.quality });
    }
  }
  if (!sub.length) {
    const failure = settled.find((item) => item.error)?.error;
    throw failure ?? new Error(`AniWaves sources unavailable for episode ${episode}`);
  }
  for (const s of sub) s.skip = skip;
  return { sub };
}
