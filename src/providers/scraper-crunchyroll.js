/**
 * scraper-crunchyroll.js — Subtítulos vía Crunchyroll API
 *
 * Requiere haber corrido cr-login.mjs al menos una vez para guardar cr-cookies.json.
 * Las cookies se usan para autenticarse en /playback/v3/ que devuelve captions + subtitles.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, join } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { removeSpamLines } from "../lib/subtitle-cleaner.js";
import { getAnilistInfo, getEpisodeOffset } from "./scraper.js";
import { anilistToImdb  } from "./scraper-cuevana.js";

const __dir     = resolve(fileURLToPath(import.meta.url), "..");
const SUBS_DIR  = join(__dir, "..", "..", "subs-cache");
const CR_INDEX  = join(SUBS_DIR, "cr-index.json");

if (!existsSync(SUBS_DIR)) mkdirSync(SUBS_DIR, { recursive: true });

// Índice persistente: { "anilistId:episode": [{label, lang, format, file}] }
let crIndex = {};
try {
  if (!existsSync(SUBS_DIR)) mkdirSync(SUBS_DIR, { recursive: true });
  if (existsSync(CR_INDEX)) crIndex = JSON.parse(readFileSync(CR_INDEX, "utf-8"));
} catch {}

function saveCRIndex() {
  try { writeFileSync(CR_INDEX, JSON.stringify(crIndex, null, 2)); } catch {}
}
const BASE      = "https://beta-api.crunchyroll.com";
const CR_WWW    = "https://www.crunchyroll.com";
const CR_LOCALE = "en-US";
const CINE_API  = process.env.CINE_API ?? "https://api.cineparatodos.lat";

async function getEpisodeTitleFromCineApi(anilistId, episode) {
  try {
    const url = `${CINE_API}/anime/${anilistId}/season/episode/${episode}?lang=en-US`;
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const data = await r.json();
    return data?.episode?.name ?? null;
  } catch {
    return null;
  }
}
const UA        = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

// Locales para los que se descargan subtítulos .ass
export const WANTED_ASS_LANGS = new Set(["en-US", "es-ES", "es-419"]);

// ── Cookies ───────────────────────────────────────────────────────────────────

let _cookieStr = null;

function getCookieString() {
  if (_cookieStr) return _cookieStr;
  try {
    const file = resolve(SUBS_DIR, "cr-cookies.json");
    if (!existsSync(file)) return null;
    const { cookies } = JSON.parse(readFileSync(file, "utf-8"));
    _cookieStr = cookies.map(c => `${c.name}=${c.value}`).join("; ");
    return _cookieStr;
  } catch { return null; }
}

// Invalida la cookie cacheada (después de cada request para forzar reload del archivo si cambió)
function invalidateCookieCache() { _cookieStr = null; }

// ── Token store ───────────────────────────────────────────────────────────────

const BASIC_AUTH = process.env.CR_BASIC_AUTH
  ? `Basic ${process.env.CR_BASIC_AUTH}`
  : "Basic bm9haWhkZXZtXzZpeWcwYThsMHE6";

let tokenStore = { accessToken: null, expiresAt: 0 };

async function crFetch(path, opts = {}) {
  const url = path.startsWith("http") ? path : `${BASE}${path}`;
  return fetch(url, {
    ...opts,
    headers: {
      "User-Agent": UA,
      "Accept":     "application/json",
      ...(opts.headers ?? {}),
    },
  });
}

async function getToken() {
  if (tokenStore.accessToken && Date.now() < tokenStore.expiresAt - 60_000) {
    return tokenStore.accessToken;
  }

  // Invalidar cache de cookies para leer el archivo actualizado
  invalidateCookieCache();
  const cookieStr = getCookieString();
  if (!cookieStr) {
    throw new Error(
      "Crunchyroll: no se encontró cr-cookies.json.\n" +
      "Corré: node src/providers/cr-login.mjs"
    );
  }

  const deviceId = cookieStr.match(/device_id=([^;]+)/)?.[1]
    ?? process.env.CR_DEVICE_ID
    ?? "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  // etp_rt viene de .env (CR_REFRESH_TOKEN) — siempre actualizado por cr-login.mjs
  // Las demás cookies (cf_clearance, session_id, etc.) vienen de cr-cookies.json
  const etpRt = process.env.CR_REFRESH_TOKEN
    ?? cookieStr.match(/etp_rt=([^;]+)/)?.[1]
    ?? null;
  if (!etpRt) throw new Error("Crunchyroll: falta CR_REFRESH_TOKEN en .env. Corré: node cr-login.mjs");

  const cookieWithFreshEtp = cookieStr
    ? cookieStr.replace(/etp_rt=[^;]+/, `etp_rt=${etpRt}`)
    : `etp_rt=${etpRt}; device_id=${deviceId}`;

  const body    = `device_id=${encodeURIComponent(deviceId)}&device_type=Chrome%20on%20Windows&grant_type=etp_rt_cookie`;
  const headers = { "Authorization": BASIC_AUTH, "Content-Type": "application/x-www-form-urlencoded", "Cookie": cookieWithFreshEtp };

  const r = await crFetch("/auth/v1/token", {
    method: "POST",
    headers,
    body,
  });

  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`CR auth error: ${r.status} ${txt}`);
  }

  const data = await r.json();
  tokenStore.accessToken = data.access_token;
  // Los tokens de CR duran 5 minutos — los cacheamos correctamente
  tokenStore.expiresAt   = Date.now() + (data.expires_in ?? 300) * 1000;

  console.log("[crunchyroll] token OK, expira en", Math.round((tokenStore.expiresAt - Date.now()) / 60000), "min");
  return tokenStore.accessToken;
}

async function crApi(path, params = {}) {
  const token = await getToken();
  const url = new URL(path.startsWith("http") ? path : `${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const r = await crFetch(url.href, {
    headers: { "Authorization": `Bearer ${token}` },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`CR API ${r.status}: ${url.pathname}`);
  return r.json();
}

// ── Cache ─────────────────────────────────────────────────────────────────────

const cache = new Map();
function cacheGet(k) {
  const e = cache.get(k);
  if (!e || Date.now() > e.exp) { cache.delete(k); return null; }
  return e.val;
}
function cacheSet(k, v, ttlMs) { cache.set(k, { val: v, exp: Date.now() + ttlMs }); }

// ── Helpers de búsqueda ───────────────────────────────────────────────────────

function normalizeTitle(t) {
  return t?.toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim() ?? "";
}

const STOPWORDS = new Set(["the","a","an","in","of","to","and","or","is","it","on","at","by","for","with","no","ni","wa","ga","wo"]);

function titleSimilarity(a, b) {
  const na = normalizeTitle(a), nb = normalizeTitle(b);
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  // Comparar solo palabras significativas (sin stopwords)
  const sig  = words => new Set(words.split(" ").filter(w => w && !STOPWORDS.has(w)));
  const wa   = sig(na), wb = sig(nb);
  // Si ambos quedan vacíos tras filtrar, usar todas las palabras
  const fa   = wa.size ? wa : new Set(na.split(" ").filter(Boolean));
  const fb   = wb.size ? wb : new Set(nb.split(" ").filter(Boolean));
  const common = [...fa].filter(w => fb.has(w)).length;
  return common / Math.max(fa.size, fb.size);
}

/**
 * Busca en TODAS las seasons de una serie el episodio cuyo título matchee el dado.
 * Usa locale es-419 ya que los títulos de episodio de CR en español coinciden con TMDB en-US.
 * Devuelve el episodio o null si no encuentra.
 */
async function findEpisodeByTitle(seriesId, episodeTitle) {
  const seasons = await getSeasons(seriesId);

  async function getEpsLocale(seasonId, locale) {
    const cacheKey = `cr:eps:${locale}:${seasonId}`;
    let eps = cacheGet(cacheKey);
    if (!eps) {
      const data = await crApi(`/content/v2/cms/seasons/${seasonId}/episodes`, { locale });
      eps = (data.data ?? []).sort((a, b) => (a.episode_number ?? 0) - (b.episode_number ?? 0));
      cacheSet(cacheKey, eps, 6 * 60 * 60 * 1000);
    }
    return eps;
  }

  // Intentar con es-419 primero (coincide con TMDB en-US para muchos animes),
  // luego en-US si no encuentra
  for (const locale of ["es-419", "en-US"]) {
    for (const season of seasons) {
      const eps = await getEpsLocale(season.id, locale);
      const match = eps.find(e => e.title && titleSimilarity(e.title, episodeTitle) >= 0.8);
      if (match) {
        console.log(`[crunchyroll] ep por título [${locale}] "${episodeTitle}" → "${match.title}" (s="${season.title}" ep_number=${match.episode_number} id=${match.id})`);
        return match;
      }
    }
  }
  return null;
}

/**
 * Busca una serie en CR por título y devuelve el mejor match.
 */
async function searchSeries(title) {
  const cacheKey = `cr:search:${normalizeTitle(title)}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const data = await crApi("/content/v2/discover/search", {
    q: title,
    n: 10,
    type: "series",
    locale: CR_LOCALE,
  });

  // La API devuelve data=[{type:"series", items:[...]}, ...]
  const bucket = (data.data ?? []).find(b => b.type === "series");
  const results = bucket?.items ?? data.data ?? [];
  if (!results.length) throw new Error(`CR: sin resultados para "${title}"`);

  // Buscar el mejor match por título
  let best = null, bestScore = 0;
  for (const item of results) {
    const s = Math.max(
      titleSimilarity(title, item.title),
      titleSimilarity(title, item.slug_title ?? ""),
    );
    if (s > bestScore) { bestScore = s; best = item; }
  }

  if (bestScore < 0.4) throw new Error(`CR: no hay match suficiente para "${title}" (mejor: "${best?.title}", score: ${bestScore.toFixed(2)})`);

  console.log(`[crunchyroll] search "${title}" → "${best.title}" (score: ${bestScore.toFixed(2)}, id: ${best.id})`);
  cacheSet(cacheKey, best, 24 * 60 * 60 * 1000);
  return best;
}

/**
 * Devuelve los seasons de una serie ordenados.
 */
async function getSeasons(seriesId) {
  const cacheKey = `cr:seasons:${seriesId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const data = await crApi(`/content/v2/cms/series/${seriesId}/seasons`, { locale: CR_LOCALE });
  const seasons = (data.data ?? []).sort((a, b) => (a.season_number ?? 0) - (b.season_number ?? 0));
  cacheSet(cacheKey, seasons, 6 * 60 * 60 * 1000);
  return seasons;
}

/**
 * Devuelve los episodios de una season.
 */
async function getEpisodes(seasonId) {
  const cacheKey = `cr:eps:${seasonId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const data = await crApi(`/content/v2/cms/seasons/${seasonId}/episodes`, { locale: CR_LOCALE });
  const eps = (data.data ?? []).sort((a, b) => (a.episode_number ?? 0) - (b.episode_number ?? 0));
  cacheSet(cacheKey, eps, 6 * 60 * 60 * 1000);
  return eps;
}

/**
 * Busca un movie_listing en CR por título.
 */
async function searchMovieListing(title) {
  const cacheKey = `cr:moviesearch:${normalizeTitle(title)}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // Búsqueda amplia sin tipo — extraer el bucket movie_listing de los resultados
  const data = await crApi("/content/v2/discover/search", {
    q: title, n: 20, locale: CR_LOCALE,
  });

  // Prioridad: movie_listing bucket > movie_listing/episode/movie en top_results > bucket episode
  // NUNCA usar items de tipo "series" (solo tienen playback de episodio, no de película)
  const buckets       = data.data ?? [];
  const movieBucket   = buckets.find(b => b.type === "movie_listing")?.items ?? [];
  const topItems      = buckets.find(b => b.type === "top_results")?.items ?? [];
  const episodeBucket = buckets.find(b => b.type === "episode")?.items ?? [];

  const topMovies = topItems.filter(i => i.type === "movie_listing" || i.type === "movie" || i.type === "episode");

  const results =
    movieBucket.length  ? movieBucket  :
    topMovies.length    ? topMovies    :
    episodeBucket.length ? episodeBucket :
    [];

  if (!results.length) {
    const summary = buckets.map(b => `${b.type}(${b.items?.length ?? 0})`).join(", ");
    console.warn(`[crunchyroll] movie search sin resultados para "${title}". Buckets: [${summary}]`);
    throw new Error(`CR: sin resultados de película para "${title}"`);
  }

  let best = null, bestScore = 0;
  for (const item of results) {
    const s = Math.max(
      titleSimilarity(title, item.title),
      titleSimilarity(title, item.slug_title ?? ""),
    );
    if (s > bestScore) { bestScore = s; best = item; }
  }

  // Threshold bajo (0.15) porque el título romaji puede tener similitud mínima
  // con el título inglés de CR aunque sea el match correcto
  if (bestScore < 0.15) throw new Error(`CR: no hay match de película para "${title}" (mejor: "${best?.title}", score: ${bestScore.toFixed(2)})`);
  console.log(`[crunchyroll] movie search "${title}" → "${best.title}" (score: ${bestScore.toFixed(2)}, id: ${best.id})`);
  cacheSet(cacheKey, best, 24 * 60 * 60 * 1000);
  return best;
}

/**
 * Devuelve las películas de un movie_listing.
 */
async function getMovies(movieListingId) {
  const cacheKey = `cr:movies:${movieListingId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const data = await crApi(`/content/v2/cms/movie_listings/${movieListingId}/movies`, { locale: CR_LOCALE });
  const movies = data.data ?? [];
  cacheSet(cacheKey, movies, 6 * 60 * 60 * 1000);
  return movies;
}

/**
 * Llama a /playback/v3/{episodeId}/web/chrome/play y devuelve captions + subtitles.
 */
async function getPlayback(episodeId) {
  const cacheKey = `cr:playback:${episodeId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const token     = await getToken();
  const cookieStr = getCookieString();

  const r = await fetch(`${CR_WWW}/playback/v3/${episodeId}/web/chrome/play`, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Cookie":        cookieStr ?? "",
      "User-Agent":    UA,
      "Referer":       `${CR_WWW}/watch/${episodeId}`,
    },
    signal: AbortSignal.timeout(12000),
  });

  if (!r.ok) {
    const errBody = await r.text().catch(() => "");
    throw new Error(`CR playback ${r.status} para episodio ${episodeId}: ${errBody.slice(0, 200)}`);
  }

  const data = await r.json();
  console.log(`[crunchyroll] session: renewSeconds=${data.session?.renewSeconds}, expiresIn=${data.session?.sessionExpirationSeconds}s, usesLimits=${data.session?.usesStreamLimits}`);
  console.log(`[crunchyroll] raw captions:  [${Object.keys(data.captions  ?? {}).join(", ")}]`);
  console.log(`[crunchyroll] raw subtitles: [${Object.keys(data.subtitles ?? {}).join(", ")}]`);
  console.log(`[crunchyroll] raw hardSubs:  [${Object.keys(data.hardSubs  ?? {}).join(", ")}]`);
  console.log(`[crunchyroll] raw softSubs:  [${Object.keys(data.softSubs  ?? {}).join(", ")}]`);

  // Extraer playbackGuid de la URL del manifest (hardSubs o softSubs)
  const manifestUrl = data.hardSubs?.none?.url ?? data.softSubs?.none?.url
    ?? Object.values(data.hardSubs ?? {})[0]?.url
    ?? Object.values(data.softSubs ?? {})[0]?.url ?? null;
  const playbackGuid = manifestUrl?.match(/playbackGuid=([^&]+)/)?.[1] ?? null;

  if (playbackGuid) {
    closePlaybackSession(episodeId, playbackGuid, token, cookieStr).catch(() => {});
  } else {
    console.warn(`[crunchyroll] no se pudo extraer playbackGuid para ${episodeId}`);
  }

  cacheSet(cacheKey, data, 20 * 60 * 1000);
  return data;
}

/**
 * Cierra la sesión de playback usando el endpoint correcto descubierto via CDP:
 *   DELETE /playback/v1/token/{episodeId}/{playbackGuid}  →  204
 * El browser hace exactamente esto al cambiar de episodio.
 */
async function closePlaybackSession(episodeId, playbackGuid, token, cookieStr) {
  const url = `${CR_WWW}/playback/v1/token/${episodeId}/${playbackGuid}`;
  const r = await fetch(url, {
    method: "DELETE",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Cookie":        cookieStr ?? "",
      "User-Agent":    UA,
      "Referer":       `${CR_WWW}/watch/${episodeId}`,
    },
  }).catch(() => null);
  if (r?.status === 204 || r?.ok) {
    console.log(`[crunchyroll] ✅ stream cerrado (DELETE /v1/token/${episodeId}/${playbackGuid})`);
  } else {
    console.warn(`[crunchyroll] ⚠ close session ${r?.status ?? "error"} para ${episodeId}`);
  }
}

/**
 * Extrae tracks de subtítulos del playback response.
 * CR devuelve captions (VTT, CC) y subtitles (ASS, traducidos).
 */
export function parsePlaybackTracks(data) {
  const tracks = [];

  for (const [locale, cap] of Object.entries(data.captions ?? {})) {
    if (!cap.url || locale === "none") continue;
    tracks.push({ label: cap.language ?? locale, lang: locale, url: cap.url, format: cap.format ?? "vtt" });
  }

  for (const [locale, sub] of Object.entries(data.subtitles ?? {})) {
    if (!sub.url || locale === "none") continue;
    const fmt = sub.format ?? "ass";
    if (tracks.find(t => t.lang === locale && t.format === fmt)) continue;
    tracks.push({ label: sub.language ?? locale, lang: locale, url: sub.url, format: fmt });
  }

  return tracks;
}

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Devuelve las URLs de subtítulos de CR para un episodio.
 * @param {string|number} anilistId
 * @param {number} episode
 * @param {string} titleRomaji - título romaji de AniList
 * @param {number} [seasonNumber=1] - temporada (de Fribb/tvdb)
 * @param {string} [titleEnglish] - título en inglés (opcional, CR suele usarlo)
 * @returns {Promise<Array<{label, lang, url, format}>>}
 */
export async function getCRSubtitles(anilistId, episode, titleRomaji, seasonNumber = 1, titleEnglish = null, episodeTitle = null) {
  const cacheKey = `cr:subs:${anilistId}:${episode}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // 1. Buscar serie — intentar con inglés primero (CR los cataloga en inglés), luego romaji
  const titlesToTry = [...new Set([titleEnglish, titleRomaji].filter(Boolean))];
  let series = null;
  let lastErr = null;
  for (const t of titlesToTry) {
    try { series = await searchSeries(t); break; }
    catch (e) { lastErr = e; }
  }
  if (!series) throw lastErr;

  // 2. Obtener seasons y elegir la correcta
  const seasons = await getSeasons(series.id);
  if (!seasons.length) throw new Error(`CR: sin temporadas para "${series.title}"`);

  // Estrategia de matching de temporada:
  // 1. Por season_number exacto
  // 2. Por título: "Season 4", "4th Season", "Season 4:", etc.
  // 3. Por posición ignorando OVAs/Specials (que CR numera como seasons)
  // 4. Por season_number=1 como fallback
  const seasonNumStr = String(seasonNumber);
  const ordinals = ["1st","2nd","3rd","4th","5th","6th","7th","8th","9th","10th"];
  const ordinal   = ordinals[seasonNumber - 1] ?? seasonNumStr;

  const byNumber = seasons.find(s => s.season_number === seasonNumber);

  // Buscar en el título: "Season 4", "4th Season", " 4 " dentro del título
  const byTitle = seasons.find(s => {
    const t = s.title?.toLowerCase() ?? "";
    return t.includes(`season ${seasonNumStr}`)
        || t.includes(`${ordinal} season`)
        || t.match(new RegExp(`\\b${seasonNumStr}\\b`));
  });

  // Por posición entre seasons reales (excluir OVAs/Specials/Movies)
  const realSeasons = seasons.filter(s => {
    const t = s.title?.toLowerCase() ?? "";
    return !t.includes("ova") && !t.includes("special") && !t.includes("movie") && !t.includes("clip");
  });
  const byPosition = realSeasons[seasonNumber - 1] ?? null;

  // Prioridad: título explícito > posición entre reales > season_number > fallback S1
  // (CR numera season_number incluyendo OVAs, lo que desplaza los reales)
  let season = byTitle ?? byPosition ?? byNumber ?? seasons.find(s => s.season_number === 1) ?? seasons[0];

  const matchStrategy = byTitle ? "title" : byPosition ? "position" : byNumber ? "season_number" : "fallback";
  console.log(`[crunchyroll] usando season "${season.title}" (season_number=${season.season_number}, id=${season.id}, match=${matchStrategy}, buscado=${seasonNumber})`);

  // 3. Obtener episodio
  let ep;
  if (episodeTitle) {
    // Búsqueda directa por título en todas las seasons (más confiable para OVAs/Specials)
    ep = await findEpisodeByTitle(series.id, episodeTitle);
    if (!ep) throw new Error(`CR: episodio "${episodeTitle}" no encontrado por título en ninguna season`);
  } else {
    const episodes = await getEpisodes(season.id);
    // Si CR usa numeración continua (S2 empieza en ep13, no en ep1) usar posición.
    // Si empieza en 1 usar episode_number primero (más exacto ante eps faltantes).
    const firstEpNum = episodes[0]?.episode_number ?? 1;
    ep = firstEpNum === 1
      ? (episodes.find(e => e.episode_number === episode) ?? episodes[episode - 1])
      : (episodes[episode - 1] ?? episodes.find(e => e.episode_number === episode));
    if (!ep) throw new Error(`CR: episodio ${episode} no encontrado en season ${season.id} (firstEpNum=${firstEpNum})`);
    if (firstEpNum > 1) console.log(`[crunchyroll] numeración continua: S ep${firstEpNum}+ → posición ${episode} → ep_number=${ep.episode_number}`);
  }

  console.log(`[crunchyroll] episodio "${ep.title}" (id=${ep.id})`);

  // 4. Obtener playback del episodio
  const playback    = await getPlayback(ep.id);
  const hasCaptions = Object.values(playback.captions ?? {}).some(c => c.url);

  // Si hay captions → es un dub: tomar solo VTT CC (el ASS del dub son signs/titles, sin diálogo).
  // Si no hay captions → ya es sub/original: tomar los ASS directamente.
  const tracks = hasCaptions
    ? parsePlaybackTracks(playback).filter(t => t.format === "vtt")
    : parsePlaybackTracks(playback).filter(t => t.format === "ass");

  // 5. Buscar versión original (ja-JP) solo si aún no tenemos ASS (caso dub)
  const subVersionId = !tracks.some(t => t.format === "ass") ? findSubVersionId(ep, ep.id) : null;
  if (subVersionId) {
    console.log(`[crunchyroll] versión original (ja-JP): ${subVersionId} — buscando ASS multiidioma`);
    try {
      await new Promise(r => setTimeout(r, 600));
      const subPlayback = await getPlayback(subVersionId);
      const subTracks   = parsePlaybackTracks(subPlayback);
      let added = 0;
      for (const t of subTracks) {
        if (t.format === "ass" && !tracks.find(x => x.lang === t.lang && x.format === t.format)) {
          tracks.push(t);
          added++;
        }
      }
      if (added) console.log(`[crunchyroll] +${added} ASS desde sub: ${subTracks.filter(t=>t.format==="ass").map(t=>t.lang).join(", ")}`);
    } catch (e) {
      console.warn(`[crunchyroll] sub version fallida: ${e.message}`);
    }
  }

  if (!tracks.length) throw new Error(`CR: sin subtítulos para ep ${episode}`);

  console.log(`[crunchyroll] ${tracks.length} subtítulos: ${tracks.map(t => `${t.lang}(${t.format})`).join(", ")}`);
  cacheSet(cacheKey, tracks, 20 * 60 * 1000);
  return tracks;
}

/**
 * Devuelve el GUID de la versión sub (original, ja-JP) del episodio si existe y es distinto al dub.
 */
function findSubVersionId(ep, currentId) {
  const versions = ep.versions ?? [];
  if (!versions.length) return null;
  const ja = versions.find(v => v.audio_locale === "ja-JP" && v.original);
  if (ja?.guid && ja.guid !== currentId) return ja.guid;
  const orig = versions.find(v => v.original);
  if (orig?.guid && orig.guid !== currentId) return orig.guid;
  return null;
}

/**
 * Devuelve el GUID de la versión dub (en-US) del episodio si existe y es distinto al actual.
 */
function findDubVersionId(ep, currentId) {
  const versions = ep.versions ?? [];
  if (!versions.length) return null;
  const dub = versions.find(v => v.audio_locale === "en-US");
  return dub && dub.guid !== currentId ? dub.guid : null;
}

/**
 * Extrae el número de temporada de un título de anime.
 * Soporta: "4th Season", "Season 4", "2nd Season", "Season 2:", "III", etc.
 */
function extractSeasonFromTitle(title) {
  if (!title) return null;
  const ORDINALS = { "1st":1,"2nd":2,"3rd":3,"4th":4,"5th":5,"6th":6,"7th":7,"8th":8,"9th":9,"10th":10 };

  // "Season 4", "Season 4:", "season 4 part 2"
  let m = title.match(/\bseason\s+(\d+)\b/i);
  if (m) return parseInt(m[1]);

  // "4th Season", "2nd Season", "3rd Season"
  m = title.match(/\b(1st|2nd|3rd|\d+th)\s+season\b/i);
  if (m) return ORDINALS[m[1].toLowerCase()] ?? parseInt(m[1]);

  // "Part 2", "Part II" cuando es conocido como secuela
  // (no aplicamos esto — demasiado ambiguo)

  return null;
}

/**
 * Resuelve subtítulos para una película en CR (movie_listing).
 */
async function getCRMovieSubtitles(anilistId, titleRomaji, titleEnglish) {
  const cacheKey = `cr:subs:${anilistId}:movie`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const titlesToTry = [...new Set([titleEnglish, titleRomaji].filter(Boolean))];
  let listing = null, lastErr = null;
  for (const t of titlesToTry) {
    try { listing = await searchMovieListing(t); break; }
    catch (e) { lastErr = e; }
  }
  if (!listing) throw lastErr ?? new Error("CR: película no encontrada");

  // Si el resultado es un movie_listing, obtener sus películas. Si es series, obtener el primer episodio.
  // Si es episode/movie, usar directo.
  let epId, epLabel;
  if (listing.type === "movie_listing") {
    const movies = await getMovies(listing.id);
    if (!movies.length) throw new Error(`CR: sin películas en "${listing.title}"`);
    epId   = movies[0].id;
    epLabel = movies[0].title ?? listing.title;
  } else if (listing.type === "series") {
    // CR a veces devuelve películas como type=series — tomar el primer episodio de la primera season
    const seasons = await getSeasons(listing.id);
    if (!seasons.length) throw new Error(`CR: sin seasons para "${listing.title}"`);
    const eps = await getEpisodes(seasons[0].id);
    if (!eps.length) throw new Error(`CR: sin episodios en "${seasons[0].title}"`);
    epId   = eps[0].id;
    epLabel = eps[0].title ?? listing.title;
    console.log(`[crunchyroll] serie-como-película: season="${seasons[0].title}" ep="${epLabel}" id=${epId}`);
  } else {
    epId   = listing.id;
    epLabel = listing.title;
  }
  console.log(`[crunchyroll] película "${epLabel}" (id=${epId}, type=${listing.type})`);

  // Los resultados de búsqueda no incluyen versions → fetchear detalles del episodio
  let epDetails = listing;
  if (!listing.versions?.length) {
    try {
      const det = await crApi(`/content/v2/cms/episodes/${epId}`, { locale: CR_LOCALE });
      epDetails = det.data?.[0] ?? listing;
    } catch (e) {
      console.warn(`[crunchyroll] no se pudieron obtener detalles del episodio ${epId}: ${e.message}`);
    }
  }

  const playback    = await getPlayback(epId);
  const hasCaptions = Object.values(playback.captions ?? {}).some(c => c.url);
  const tracks = hasCaptions
    ? parsePlaybackTracks(playback).filter(t => t.format === "vtt")
    : parsePlaybackTracks(playback).filter(t => t.format === "ass");

  // Sub version encontrada (sin captions) → también buscar dub en-US para VTT CC
  if (!hasCaptions) {
    const dubVersionId = findDubVersionId(epDetails, epId);
    if (dubVersionId) {
      console.log(`[crunchyroll] versión en-US (dub): ${dubVersionId} — buscando VTT CC`);
      try {
        await new Promise(r => setTimeout(r, 600));
        const dubPlayback = await getPlayback(dubVersionId);
        const dubTracks   = parsePlaybackTracks(dubPlayback).filter(t => t.format === "vtt");
        tracks.push(...dubTracks);
        if (dubTracks.length) console.log(`[crunchyroll] +${dubTracks.length} VTT desde dub en-US`);
      } catch (e) {
        console.warn(`[crunchyroll] dub version fallida: ${e.message}`);
      }
    }
  }

  const subVersionId = !tracks.some(t => t.format === "ass") ? findSubVersionId(epDetails, epId) : null;
  if (subVersionId) {
    console.log(`[crunchyroll] versión original (ja-JP): ${subVersionId} — buscando ASS multiidioma`);
    try {
      await new Promise(r => setTimeout(r, 600));
      const subPlayback = await getPlayback(subVersionId);
      const subTracks   = parsePlaybackTracks(subPlayback);
      let added = 0;
      for (const t of subTracks) {
        if (t.format === "ass" && !tracks.find(x => x.lang === t.lang && x.format === t.format)) {
          tracks.push(t); added++;
        }
      }
      if (added) console.log(`[crunchyroll] +${added} ASS desde sub: ${subTracks.filter(t=>t.format==="ass").map(t=>t.lang).join(", ")}`);
    } catch (e) {
      console.warn(`[crunchyroll] sub version fallida: ${e.message}`);
    }
  }

  if (!tracks.length) throw new Error("CR: sin subtítulos para la película");
  console.log(`[crunchyroll] ${tracks.length} subtítulos: ${tracks.map(t => `${t.lang}(${t.format})`).join(", ")}`);
  cacheSet(cacheKey, tracks, 20 * 60 * 1000);
  return tracks;
}

/**
 * Wrapper para usar desde index.js — resuelve títulos y temporada automáticamente.
 * Solo devuelve tracks VTT (CC cerrados para dubs en inglés).
 *
 * Descarga el VTT al disco y lo indexa persistentemente (cr-index.json) para que
 * el playback endpoint de CR solo se consulte UNA VEZ por episodio en toda la vida
 * del servidor — evita el problema de TOO_MANY_ACTIVE_STREAMS.
 *
 * @param {string|number} anilistId
 * @param {number} episode
 * @returns {Promise<Array<{label, lang, url, format, _localFile}>>}
 */
export async function getCRSubsForAnime(anilistId, episode) {
  const idxKey  = `${anilistId}:${episode}`;
  const memKey  = `cr:vtt:${anilistId}:${episode}`;

  // 1. Memoria
  const memCached = cacheGet(memKey);
  if (memCached) return memCached;

  // 2. Índice en disco — si el archivo sigue existiendo, no tocamos CR
  const persisted = crIndex[idxKey];
  if (persisted?.length) {
    const missingFiles = persisted.filter(t => !existsSync(join(SUBS_DIR, t.file)));
    if (!missingFiles.length) {
      console.log(`[crunchyroll] ✅ subs desde disco para ${idxKey}`);
      cacheSet(memKey, persisted, 24 * 60 * 60 * 1000);
      return persisted;
    }
    console.warn(`[crunchyroll] índice existe pero faltan archivos: ${missingFiles.map(t=>t.file).join(", ")}`);
  } else {
    console.log(`[crunchyroll] índice vacío para ${idxKey} (total keys: ${Object.keys(crIndex).length})`);
  }

  // 3. Resolver metadata y llamar a CR (+ título del episodio desde CINE_API en paralelo)
  const [anilistInfo, fribbData, epOffset, episodeTitle] = await Promise.all([
    getAnilistInfo(anilistId).catch(() => null),
    anilistToImdb(anilistId).catch(() => null),
    getEpisodeOffset(anilistId).catch(() => 0),
    getEpisodeTitleFromCineApi(anilistId, episode).catch(() => null),
  ]);
  if (episodeTitle) console.log(`[crunchyroll] título del episodio desde CINE_API: "${episodeTitle}"`);

  const titleRomaji  = anilistInfo?.titleRomaji  ?? String(anilistId);
  const titleEnglish = anilistInfo?.titleEnglish ?? null;

  // Extraer temporada del título: "4th Season", "Season 4", "3rd Season", etc.
  // Tiene prioridad sobre Fribb porque Fribb a veces devuelve 1 para secuelas.
  const seasonFromTitle = extractSeasonFromTitle(titleEnglish) ?? extractSeasonFromTitle(titleRomaji);
  const seasonNumber = seasonFromTitle ?? fribbData?.season ?? 1;

  if (seasonFromTitle) {
    console.log(`[crunchyroll] temporada extraída del título: ${seasonNumber} (de "${seasonFromTitle === extractSeasonFromTitle(titleEnglish) ? titleEnglish : titleRomaji}")`);
  }

  // Split-cours: ep local → ep real en CR (misma season que el prequel)
  const crEpisode = episode + epOffset;
  if (epOffset > 0) console.log(`[crunchyroll] split-cours: ep local ${episode} → ep CR ${crEpisode} (offset=${epOffset})`);

  const isMovie  = anilistInfo?.format === "MOVIE";
  const allTracks = isMovie
    ? await getCRMovieSubtitles(anilistId, titleRomaji, titleEnglish)
    : await getCRSubtitles(anilistId, crEpisode, titleRomaji, seasonNumber, titleEnglish, episodeTitle);
  const vttTracks = allTracks.filter(t => t.format === "vtt");
  const assTracks = allTracks.filter(t => t.format === "ass" && WANTED_ASS_LANGS.has(t.lang));
  const tracksToDownload = [...vttTracks, ...assTracks];

  console.log(`[crunchyroll] descargando ${vttTracks.length} VTT + ${assTracks.length} ASS (${assTracks.map(t => t.lang).join(", ") || "ninguno"})`);

  // 4. Descargar VTT (todos) y ASS (solo idiomas deseados) al disco inmediatamente
  const localTracks = await Promise.all(tracksToDownload.map(async t => {
    const hash     = createHash("sha1").update(t.url).digest("hex");
    const filename = `cr_${hash}.${t.format}`;
    const filepath = join(SUBS_DIR, filename);
    if (!existsSync(filepath)) {
      try {
        const r = await fetch(t.url, { signal: AbortSignal.timeout(10000) });
        if (r.ok) writeFileSync(filepath, removeSpamLines(await r.text()), "utf-8");
      } catch (e) {
        console.warn(`[crunchyroll] fallo descarga ${t.format.toUpperCase()} (${t.lang}): ${e.message}`);
        return { ...t, _localFile: null };
      }
    }
    return { label: t.label, lang: t.lang, format: t.format, file: filename };
  }));

  const validTracks = localTracks.filter(t => t.file);

  // 5. Persistir en índice
  if (validTracks.length) {
    crIndex[idxKey] = validTracks;
    saveCRIndex();
  }

  cacheSet(memKey, validTracks, 24 * 60 * 60 * 1000);
  return validTracks;
}
