// animenosub.to — el "sub" del sitio es japonés con subs en inglés QUEMADOS
// (hardsub). Portado de Anivexa-API/providers/animenosub.js, standalone:
// busca la serie por título (admin-ajax), scrapea la lista de episodios y los
// embeds (<option> base64 → iframe src), y resuelve los que tienen extractor
// (vidmoly/nova/byse) a m3u8 directos.
// Los servers "RAW - *" son video sin subs → se descartan.
import { cacheGet, cacheSet } from "../lib/cache.js";
import { findVideoExtractor } from "../lib/hardsub-extractors.js";
import {
  HARDSUB_UA,
  fetchHtml,
  decodeEntities,
  findTopSlugs,
  getPrequelOffset,
  getAnimeMedia,
  buildTitles,
  expectedCount,
  selectSeries,
} from "../lib/anime-match.js";

const BASE = "https://animenosub.to";
const SERIES_TTL = 24 * 60 * 60 * 1000;
const EPS_TTL = 3 * 60 * 60 * 1000;

async function search(query) {
  const res = await fetch(`${BASE}/wp-admin/admin-ajax.php`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": HARDSUB_UA,
      Origin: BASE,
      Referer: `${BASE}/`,
    },
    body: `action=ts_ac_do_search&ts_ac_query=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`animenosub search HTTP ${res.status}`);
  const data = await res.json();
  const results = [];
  for (const item of data?.anime?.[0]?.all ?? []) {
    const slug = item.post_link?.match(/\/anime\/([^/]+)\/?$/)?.[1];
    if (!slug) continue;
    results.push({ slug, text: item.post_title ?? slug.replace(/-/g, " ") });
  }
  return results;
}

async function scrapeSeriesRaw(slug) {
  const html = await fetchHtml(`${BASE}/anime/${slug}/`, { Referer: BASE });
  const isSlugDub = /-dub$/.test(slug) || /(?:^|[-\s])dub(?:$|[-\s])/i.test(slug);
  const episodes = [];
  const seen = new Set();
  const listRe = /<li\b[^>]*data-index="\d+"[^>]*>[\s\S]*?<a\s+href="(https?:\/\/animenosub\.to\/[^"]+)"[\s\S]*?<div\s+class="epl-num">([^<]+)<\/div>/gi;
  for (const m of html.matchAll(listRe)) {
    const epUrl = decodeEntities(m[1]);
    const label = m[2].trim();
    let number;
    if (/^movie$/i.test(label)) {
      number = 1;
    } else {
      const n = parseFloat(label);
      number = Number.isFinite(n) && n >= 1 ? Math.round(n) : null;
    }
    if (number === null || seen.has(number)) continue;
    seen.add(number);
    const isDub = isSlugDub || /-dub(?:$|\/)/.test(epUrl);
    episodes.push({ number, epUrl, hasSub: !isDub, hasDub: isDub });
  }
  episodes.sort((a, b) => a.number - b.number);
  return episodes;
}

// La lista de episodios de una serie cambia poco — cachearla evita scrapear
// la página dos veces (selectSeries + resolución del episodio).
async function scrapeSeries(slug) {
  const key = `animenosub:eps:${slug}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const episodes = await scrapeSeriesRaw(slug);
  cacheSet(key, episodes, EPS_TTL);
  return episodes;
}

async function scrapeEmbeds(epUrl) {
  const html = await fetchHtml(epUrl, { Referer: `${BASE}/` });
  const embeds = [];
  for (const m of html.matchAll(/<option\s+value="([A-Za-z0-9+/=]+)"\s+data-index="\d+"[^>]*>([^<]+)<\/option>/gi)) {
    const b64 = m[1];
    const serverName = m[2].trim();
    if (!serverName || /select video server/i.test(serverName)) continue;
    let embedUrl = null;
    try {
      const decoded = atob(b64);
      embedUrl = decoded.match(/src=["']([^"']+)["']/i)?.[1] ?? null;
    } catch { continue; }
    if (!embedUrl) continue;
    embeds.push({ url: embedUrl, server: serverName });
  }
  if (!embeds.length) {
    for (const m of html.matchAll(/<iframe[^>]+src=["']([^"']+)["'][^>]*>/gi)) {
      const src = m[1];
      if (/vidmoly|vtbe|streamtape|dood|filemoon|upn\.one|bysesa/i.test(src)) {
        embeds.push({ url: src, server: "Direct" });
        break;
      }
    }
  }
  return embeds;
}

async function resolveSeries(anilistId) {
  const cacheKey = `animenosub:series:${anilistId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const media = await getAnimeMedia(anilistId);
  const titles = buildTitles(media);
  const candidates = await findTopSlugs(titles, search);
  const expected = expectedCount(media);
  const offset = await getPrequelOffset(anilistId).catch(() => 0);
  const selected = await selectSeries(candidates, scrapeSeries, expected, media?.status, offset);
  if (!selected) throw new Error(`animenosub match not found for AniList ${anilistId}`);
  const data = { slug: selected.slug, title: selected.title, mode: selected.mode, offset, score: selected.score };
  cacheSet(cacheKey, data, SERIES_TTL);
  return data;
}

const EXTRACT_TIMEOUT = 25_000;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms)),
  ]);
}

async function withRetry(fn, attempts = 2) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (_) { if (i === attempts - 1) return null; }
  }
  return null;
}

// Referer que espera el CDN del m3u8 según el extractor que lo resolvió.
const EXTRACTOR_REFERER = {
  vidmoly: "https://vidmoly.biz/",
  nova: "https://nova.upn.one/",
  byse: "https://bysesayeveum.com/",
};

// Devuelve { sub: [{url, referer, server}] } — solo streams HLS resueltos.
// El "sub" de animenosub es hardsub inglés (streams.js lo etiqueta JAP-EN-HS).
export async function getAnimenosubStreams(anilistId, episode) {
  const series = await resolveSeries(anilistId);
  const providerEp = series.mode === "offset" ? Number(episode) + series.offset : Number(episode);
  const episodes = await scrapeSeries(series.slug);
  const ep = episodes.find((e) => e.number === providerEp && e.hasSub) ?? episodes.find((e) => e.number === providerEp);
  if (!ep) throw new Error(`animenosub episode ${providerEp} not found`);
  const embeds = await scrapeEmbeds(ep.epUrl);

  const resolvable = embeds
    .map((embed) => ({ embed, extractor: findVideoExtractor(embed.url) }))
    .filter((item) => item.extractor);
  const resolvedList = await Promise.all(
    resolvable.map(({ embed, extractor }) => {
      const run = () => withTimeout(
        extractor.extract(embed.url, { userAgent: HARDSUB_UA, referer: `${BASE}/` }),
        EXTRACT_TIMEOUT,
        `animenosub:${extractor.name}`,
      );
      // byse hace PoW síncrono — reintentar duplica el bloqueo del event loop.
      return extractor.name === "byse" ? run().catch(() => null) : withRetry(run);
    })
  );

  const sub = [];
  for (const [i, { embed, extractor }] of resolvable.entries()) {
    const urls = resolvedList[i];
    if (!urls) continue;
    const referer = EXTRACTOR_REFERER[extractor.name] ?? (() => {
      try { return `${new URL(embed.url).origin}/`; } catch { return `${BASE}/`; }
    })();
    for (const resolvedSource of urls) {
      const source = typeof resolvedSource === "string" ? { url: resolvedSource, type: "hls" } : resolvedSource;
      if (source.type !== "hls" || !source.url) continue;
      if (/^\s*RAW\b/i.test(embed.server)) continue; // RAW = sin subs quemados
      sub.push({ url: source.url, referer, server: embed.server });
    }
  }
  return { sub };
}
