import { createDecipheriv } from "crypto";
import fs from "fs";
import { ANILIST_HEADERS } from "../config/constants.js";
import { voeToM3U8 } from "./voe.js";

const ANIMEAV1_BASE = "https://animeav1.com/media";

const PAGE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
};

// ── UPNShare extractor ────────────────────────────────────────────────────────
// Clave/IV fijos obtenidos por ingeniería inversa del bundle de animeav1.uns.bio

const UPN_KEY = Buffer.from("6b69656d7469656e6d75613931316361", "hex"); // "kiemtienmua911ca"
const UPN_IV  = Buffer.from("313233343536373839306f6975797472", "hex"); // "1234567890oiuytr"
const UPN_BASE = "https://animeav1.uns.bio";

function upnDecrypt(hexStr) {
  const data = Buffer.from(hexStr.trim(), "hex");
  const d = createDecipheriv("aes-128-cbc", UPN_KEY, UPN_IV);
  d.setAutoPadding(true);
  return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString("utf8"));
}

async function upnShareToM3U8(embedUrl, attempt = 0) {
  // embedUrl es tipo "https://animeav1.uns.bio/#gpz1v8"
  const token = embedUrl.split("#")[1];
  if (!token) return null;

  let r;
  try {
    r = await fetch(
      `${UPN_BASE}/api/v1/video?id=${token}&w=1920&h=1080&r=`,
      {
        headers: {
          "User-Agent": PAGE_HEADERS["User-Agent"],
          "Referer": `${UPN_BASE}/#${token}`,
        },
        signal: AbortSignal.timeout(8000),
      }
    );
  } catch (e) {
    // Timeout/red intermitente contra animeav1.uns.bio — un reintento antes
    // de rendirse evita perder el stream por un solo hiccup transitorio.
    if (attempt === 0) return upnShareToM3U8(embedUrl, 1);
    throw e;
  }
  if (!r.ok) {
    if (attempt === 0) return upnShareToM3U8(embedUrl, 1);
    return null;
  }

  const hex  = await r.text();
  let data;
  try {
    data = upnDecrypt(hex);
  } catch (e) {
    if (attempt === 0) return upnShareToM3U8(embedUrl, 1);
    throw e;
  }

  // El dominio del CDN en data.cf (fusionpeaknetworks.site, horizenbuild.online,
  // etc.) rota y sus subdominios aleatorios no resuelven DNS — el player real
  // usa los proxys propios de animeav1:
  //   1) cfNative: URL ya firmada servida por animeav1.uns.bio/v4/pl/{host}/...
  //   2) hlsmod:   UPN_BASE/hlsmod/{dominio-tiktok}{hlsVideoTiktok sin /hls}?v=
  //      (streamingConfig.order indica el orden de preferencia del player)
  //   3) cf+pk:    fallback — el origin exige el token k/kx de data.pk.
  let streamUrl = null;
  if (data.cfNative) {
    streamUrl = data.cfNative;
  } else if (data.hlsVideoTiktok) {
    try {
      const cfg = JSON.parse(data.streamingConfig || "{}");
      const tt = cfg?.adjust?.Tiktok;
      if (tt && !tt.disabled && tt.domain) {
        const path = data.hlsVideoTiktok.replace(/^\/hls/, "");
        const v = tt.params?.v ? `?v=${tt.params.v}` : "";
        streamUrl = `${UPN_BASE}/hlsmod/${tt.domain}${path}${v}`;
      }
    } catch { /* streamingConfig inválido → fallback */ }
  }
  if (!streamUrl) {
    const base = data.cf ?? data.source ?? null;
    streamUrl = base && data.pk?.k && data.pk?.kx
      ? `${base}${base.includes("?") ? "&" : "?"}k=${encodeURIComponent(data.pk.k)}&kx=${encodeURIComponent(data.pk.kx)}`
      : base;
  }
  if (!streamUrl) return null;

  // Thumbnails para preview en la barra de progreso
  // El VTT y el sprite JPG están en UPN_BASE con path firmado del JSON
  const thumbnailVtt = data.thumbnail
    ? `${UPN_BASE}${data.thumbnail}`
    : null;
  const thumbnailJpg = data.thumbnail
    ? `${UPN_BASE}${data.thumbnail.replace(/thumbnail\.vtt$/, "thumbnail.jpg")}`
    : null;

  return { url: streamUrl, thumbnailVtt, thumbnailJpg };
}

// ── Cache ────────────────────────────────────────────────────────────────────

const scraperCache = new Map();
const scraperInflight = new Map();

// #region debug-point B:animeav1-debug-helper
let animeAv1DebugConfig = null;
function reportAnimeAv1Debug(hypothesisId, location, msg, data = {}) {
  if (process.env.REANIME_DEBUG !== "1") return;
  try {
    if (!animeAv1DebugConfig) {
      let url = "http://127.0.0.1:7777/event";
      let sessionId = "api-cache-capacity";
      try {
        const env = fs.readFileSync(".dbg/api-cache-capacity.env", "utf8");
        url = env.match(/DEBUG_SERVER_URL=(.+)/)?.[1]?.trim() || url;
        sessionId = env.match(/DEBUG_SESSION_ID=(.+)/)?.[1]?.trim() || sessionId;
      } catch {}
      animeAv1DebugConfig = { url, sessionId };
    }
    fetch(animeAv1DebugConfig.url, {
      method: "POST",
      body: JSON.stringify({
        sessionId: animeAv1DebugConfig.sessionId,
        runId: "pre-fix",
        hypothesisId,
        location,
        msg,
        data,
        ts: Date.now(),
      }),
    }).catch(() => {});
  } catch {}
}
// #endregion

function coalesceScrape(key, fn) {
  if (!scraperInflight.has(key)) {
    // #region debug-point C:scraper-coalesce-create
    reportAnimeAv1Debug("C", "src/providers/scraper.js:coalesceScrape:new", "[DEBUG] animeav1 coalesce create", { key });
    // #endregion
    const job = Promise.resolve().then(fn).finally(() => scraperInflight.delete(key));
    scraperInflight.set(key, job);
  } else {
    // #region debug-point C:scraper-coalesce-join
    reportAnimeAv1Debug("C", "src/providers/scraper.js:coalesceScrape:join", "[DEBUG] animeav1 coalesce join", { key });
    // #endregion
  }
  return scraperInflight.get(key);
}

function cacheGet(key) {
  const entry = scraperCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { scraperCache.delete(key); return null; }
  return entry.value;
}

function cacheSet(key, value, ttlMs) {
  scraperCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

// ── AniList ID → título + MAL ID (directo desde AniList, sin Jikan ni ani.zip) ─

export async function getAnilistInfo(anilistId) {
  return coalesceScrape(`alinfo:${anilistId}`, () => resolveAnilistInfo(anilistId));
}

async function resolveAnilistInfo(anilistId) {
  const key = `alinfo:${anilistId}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  let result = null;
  try {
    const q = `query($id:Int){Media(id:$id,type:ANIME){idMal title{romaji english} format startDate{year}}}`;
    const res = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: ANILIST_HEADERS,
      body: JSON.stringify({ query: q, variables: { id: Number(anilistId) } }),
      signal: AbortSignal.timeout(5000),
    });
    const json = await res.json();
    const media = json?.data?.Media;
    if (media) {
      result = {
        idMal:        media.idMal ?? null,
        titleRomaji:  media.title?.romaji  || null,
        titleEnglish: media.title?.english || null,
        format:       media.format ?? null,
        year:         media.startDate?.year ?? null,
      };
    }
  } catch (e) {
    console.warn(`[scraper] AniList falló para ${anilistId}: ${e.message} — probando ani.zip`);
  }

  // Fallback: api.ani.zip (mappings + titles + airDate del ep 1 para el año).
  // Cubre lo mismo que AniList para este uso: romaji (x-jat), english (en),
  // mal_id, type y año.
  if (!result) {
    const r = await fetch(`https://api.ani.zip/mappings?anilist_id=${anilistId}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw Object.assign(new Error("Anime not found in AniList"), { status: 404 });
    const j = await r.json();
    if (!j?.titles && !j?.mappings) throw Object.assign(new Error("Anime not found in AniList"), { status: 404 });
    const airDate = j.episodes?.["1"]?.airDate;
    result = {
      idMal:        j.mappings?.mal_id ?? null,
      titleRomaji:  j.titles?.["x-jat"] || j.titles?.en || null,
      titleEnglish: j.titles?.en || null,
      format:       j.mappings?.type ?? null,
      year:         airDate ? parseInt(airDate.slice(0, 4), 10) : null,
    };
    console.log(`[scraper] ani.zip fallback OK para ${anilistId}: "${result.titleRomaji}" mal=${result.idMal} y=${result.year}`);
  }

  cacheSet(key, result, 7 * 24 * 60 * 60 * 1000);
  return result;
}

// Mantenido por compatibilidad con getEpisodeOffset (usa malId del nodo prequel de AniList)
export async function anilistToMalId(anilistId) {
  const info = await getAnilistInfo(anilistId);
  if (!info.idMal) throw Object.assign(new Error("No MAL ID in AniList for this anime"), { status: 404 });
  return info.idMal;
}

// ── MAL ID → slug (via API JSON de animeav1.com) ─────────────────────────────
// La API acepta POST /api/search con { query: "<título>" } y devuelve
// [{ id, title, slug }] — sin necesidad de scrapear HTML.

const ROMAN_ORDINALS = new Map([
  ["i", 1], ["ii", 2], ["iii", 3], ["iv", 4], ["v", 5],
  ["vi", 6], ["vii", 7], ["viii", 8], ["ix", 9], ["x", 10],
  ["xi", 11], ["xii", 12], ["xiii", 13], ["xiv", 14], ["xv", 15],
  ["xvi", 16], ["xvii", 17], ["xviii", 18], ["xix", 19], ["xx", 20],
]);

function romanToInt(token) {
  return ROMAN_ORDINALS.get(String(token || "").toLowerCase()) ?? null;
}

function intToRoman(num) {
  const table = [
    [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"],
    [100, "c"], [90, "xc"], [50, "l"], [40, "xl"],
    [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
  ];
  let value = Number(num);
  if (!Number.isInteger(value) || value <= 0) return null;
  let out = "";
  for (const [n, roman] of table) {
    while (value >= n) {
      out += roman;
      value -= n;
    }
  }
  return out || null;
}

function canonicalizeTitleForMatch(str) {
  let out = ` ${String(str || "").toLowerCase()} `;
  out = out.replace(/[_./:+-]+/g, " ");
  out = out.replace(/\b(\d+)(?:st|nd|rd|th)\s+season\b/g, " $1 ");
  out = out.replace(/\bseason\s+(\d+)(?:st|nd|rd|th)?\b/g, " $1 ");
  out = out.replace(/\bs(\d+)\b/g, " $1 ");
  out = out.replace(/\bseason\s+([ivxlcdm]{1,6})\b/g, (_, roman) => {
    const n = romanToInt(roman);
    return n ? ` ${n} ` : ` ${roman} `;
  });
  out = out.replace(/\b([ivxlcdm]{1,6})\b\s*$/g, (_, roman) => {
    const n = romanToInt(roman);
    return n ? ` ${n} ` : ` ${roman} `;
  });
  out = out.replace(/[^a-z0-9]+/g, " ").trim();
  return out;
}

function buildComparisonTokens(str) {
  return new Set(canonicalizeTitleForMatch(str).match(/[a-z0-9]+/g) ?? []);
}

function normalizeTitle(t) {
  return canonicalizeTitleForMatch(t).replace(/\s+/g, "");
}

let activeSearches = 0;
const searchWaiters = [];

async function searchAnimeav1(query) {
  return coalesceScrape(`search:${query}`, async () => {
    // Global al proceso: distintos episodios tambien comparten este limite.
    if (activeSearches >= 2) await new Promise(resolve => searchWaiters.push(resolve));
    else activeSearches++;
    try {
      return await fetchAnimeav1Search(query);
    } finally {
      const next = searchWaiters.shift();
      if (next) next();
      else activeSearches--;
    }
  });
}

async function fetchAnimeav1Search(query) {
  const r = await fetch("https://animeav1.com/api/search", {
    method: "POST",
    headers: { ...PAGE_HEADERS, "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw Object.assign(new Error(`animeav1 /api/search HTTP ${r.status}`), { status: 502 });
  return r.json(); // [{ id, title, slug }]
}

// Extrae el ordinal de temporada de un string ("2nd" → 2, "3rd" → 3, "4th" → 4, etc.)
function extractSeasonOrdinal(str) {
  const input = String(str || "").toLowerCase().replace(/[_./:+-]+/g, " ");
  const m = input.match(/\b(\d+)(?:st|nd|rd|th)\s+season\b/i)
    ?? input.match(/\bseason\s+(\d+)(?:st|nd|rd|th)?\b/i)
    ?? input.match(/\bs(\d+)\b/i);
  return m ? parseInt(m[1]) : null;
}

// Números presentes en un string, ignorando años entre paréntesis "(2023)".
function extractNumbers(str) {
  const clean = str.replace(/\(\d{4}\)/g, "");
  const numbers = new Set([...clean.matchAll(/\d+/g)].map(m => m[0]));
  const season = extractSeasonOrdinal(clean);
  if (season !== null) numbers.add(String(season));
  const trailingRoman = clean.match(/\b([ivxlcdm]{1,6})\b\s*$/i);
  const romanNumber = trailingRoman ? romanToInt(trailingRoman[1]) : null;
  if (romanNumber !== null) numbers.add(String(romanNumber));
  return numbers;
}

// Score de un resultado contra UN título: 2 = exacto/normalizado, si no Jaccard.
function scoreAgainstTitle(r, title) {
  const norm = title.toLowerCase().trim();
  const stripped = normalizeTitle(title);
  if (r.title.toLowerCase().trim() === norm) return 2;
  if (normalizeTitle(r.title) === stripped) return 2;
  if (normalizeTitle(r.slug) === stripped) return 2;
  const titleTokens = buildComparisonTokens(title);
  const slugTokens  = buildComparisonTokens(`${r.slug} ${r.title}`);
  const shared = [...titleTokens].filter(w => slugTokens.has(w)).length;
  const union  = titleTokens.size + slugTokens.size - shared;
  return union > 0 ? shared / union : 0;
}

// entries: [{ r: {id,title,slug}, rank }] — rank = mejor posición en los search.
// titles: todos los títulos candidatos (romaji, english, ...) para scoring.
function pickBestSlug(entries, titles, anilistYear = null) {
  if (!entries?.length) return null;
  let pool = entries;

  // Pre-filtro por "?" en el título
  const wantQ = titles.some(t => t.includes("?"));
  const qFiltered = pool.filter(e => wantQ ? e.r.title.includes("?") : !e.r.title.includes("?"));
  if (qFiltered.length > 0) pool = qFiltered;

  // Desambiguación por año: si AniList dice 1996 y un resultado trae
  // "(2023)" en el título, es un remake/otra versión → descartarlo.
  if (anilistYear) {
    const yearOk = pool.filter(e => {
      const m = e.r.title.match(/\((\d{4})\)/);
      return !m || parseInt(m[1], 10) === anilistYear;
    });
    if (yearOk.length > 0) pool = yearOk;
  }

  // Si algún título tiene número de temporada, descartar temporadas distintas
  const malSeason = titles.map(extractSeasonOrdinal).find(n => n !== null) ?? null;
  if (malSeason) {
    const seasonPool = pool.filter(e => {
      const s = extractSeasonOrdinal(e.r.slug) ?? extractSeasonOrdinal(e.r.title);
      return s === null || s === malSeason;
    });
    if (seasonPool.length > 0) pool = seasonPool;
  }

  // Match exacto/normalizado contra CUALQUIER título gana siempre — antes del
  // filtro de números. Sin esto "Shin Evangelion Movie:||" (match exacto del
  // romaji de Eva 3.0+1.0) perdía contra "Evangelion Movie 3: Q" solo porque
  // el título inglés "3.0+1.0" contiene el dígito 3.
  const exacts = pool.filter(e => titles.some(t => scoreAgainstTitle(e.r, t) === 2));
  if (exacts.length > 0) {
    // Los exactos ganan siempre y se saltan el filtro de números (un match
    // exacto como "Shin Evangelion Movie:||" no tiene dígitos y el tier lo
    // descartaría). Van primero; el resto queda como respaldo para la
    // verificación por año en el caller.
    exacts.sort((a, b) => a.rank - b.rank);
    const rest = pool
      .filter(e => !exacts.includes(e))
      .map(e => ({ e, sum: titles.reduce((s, t) => s + scoreAgainstTitle(e.r, t), 0) }))
      .sort((a, b) => b.sum - a.sum || a.e.rank - b.e.rank)
      .map(s => s.e);
    return [...exacts, ...rest].map(e => e.r.slug);
  }

  // Desambiguación por números del título ("Evangelion: 1.0" → {1,0}):
  // tier A = resultados cuyos números son todos consistentes con los títulos,
  // tier B = sin números, y se descartan los que traen números ajenos
  // ("Evangelion Movie 3" cuando el título dice 1.0). Sin esto el Jaccard
  // empataba "shin-evangelion-movie" (película 4) con "evangelion-movie-1-jo".
  const titleNums = new Set();
  for (const t of titles) for (const n of extractNumbers(t)) titleNums.add(n);
  if (titleNums.size > 0) {
    const tierA = [], tierB = [];
    for (const e of pool) {
      const nums = extractNumbers(`${e.r.title} ${e.r.slug}`);
      if (nums.size === 0) { tierB.push(e); continue; }
      if ([...nums].every(n => titleNums.has(n))) tierA.push(e);
      // números ajenos → descartado
    }
    if (tierA.length > 0) pool = tierA;
    else if (tierB.length > 0) pool = tierB;
  }

  // Scoring combinado contra TODOS los títulos: un resultado que matchea
  // parcialmente romaji Y english gana al que solo matchea uno.
  // Desempate final: mejor rank en los resultados del buscador.
  const scored = [];
  for (const e of pool) {
    let sum = 0, max = 0;
    for (const t of titles) {
      const s = scoreAgainstTitle(e.r, t);
      sum += s; if (s > max) max = s;
    }
    if (max >= 0.5) scored.push({ e, sum, max });
  }
  scored.sort((a, b) => b.sum - a.sum || a.e.rank - b.e.rank);
  return scored.map(s => s.e.r.slug);
}

// Intenta romaji primero (los slugs de animeav1 usan romaji), luego inglés como fallback.
export async function malIdToSlug(malId, titleRomaji = null, titleEnglish = null, anilistYear = null) {
  const key = JSON.stringify(["slug", malId, titleRomaji, titleEnglish, anilistYear]);
  return coalesceScrape(key, () => resolveMalIdToSlug(malId, titleRomaji, titleEnglish, anilistYear));
}

async function resolveMalIdToSlug(malId, titleRomaji, titleEnglish, anilistYear) {
  // slug3: pool combinado de todas las queries + desambiguación por números
  // del título — las entradas viejas pueden tener slugs erróneos cacheados
  // (ej. Evangelion 1.0 → "shin-evangelion-movie" por empate de Jaccard).
  const key = `slug3:${malId}`;
  const cached = cacheGet(key);
  if (cached) {
    // #region debug-point A:slug-cache-hit
    reportAnimeAv1Debug("A", "src/providers/scraper.js:resolveMalIdToSlug:hit", "[DEBUG] animeav1 slug cache hit", { key, malId, slug: cached });
    // #endregion
    return cached;
  }
  // #region debug-point A:slug-cache-miss
  reportAnimeAv1Debug("A", "src/providers/scraper.js:resolveMalIdToSlug:miss", "[DEBUG] animeav1 slug cache miss", { key, malId, anilistYear, titleRomaji, titleEnglish });
  // #endregion

  const titleCandidates = [titleRomaji, titleEnglish].filter(Boolean);

  if (titleCandidates.length === 0) {
    throw Object.assign(new Error("No AniList titles available for animeav1 lookup"), { status: 404 });
  }

  // Convierte un título a slug candidato: lowercase, solo alfanum+guión
  function titleToSlug(t) {
    return t.toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")   // quitar puntuación (incluye ":")
      .trim()
      .replace(/\s+/g, "-");
  }

  function stripSeasonSuffix(t) {
    return String(t || "")
      .replace(/\b\d+(?:st|nd|rd|th)\s+season\b/gi, " ")
      .replace(/\bseason\s+\d+(?:st|nd|rd|th)?\b/gi, " ")
      .replace(/\bseason\s+[ivxlcdm]{1,6}\b/gi, " ")
      .replace(/\bs\d+\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function buildSlugFallbacks(t) {
    const candidates = [];
    const push = (slug) => {
      if (slug && !candidates.includes(slug)) candidates.push(slug);
    };

    push(titleToSlug(t));

    const season = extractSeasonOrdinal(t);
    const baseTitle = stripSeasonSuffix(t);
    if (season !== null && baseTitle) {
      const baseSlug = titleToSlug(baseTitle);
      push(`${baseSlug}-${season}`);
      const roman = intToRoman(season);
      if (roman) push(`${baseSlug}-${roman}`);
    }

    return candidates;
  }

  // Verifica si un slug existe en animeav1 haciendo HEAD al ep 1
  async function probeSlug(slug) {
    try {
      const r = await fetch(`${ANIMEAV1_BASE}/${slug}/1`, {
        method: "HEAD", headers: PAGE_HEADERS, signal: AbortSignal.timeout(6000), redirect: "follow",
      });
      return r.ok;
    } catch { return false; }
  }

  // Año mostrado en el media page de animeav1: el header tiene
  // <span>Tipo</span> <span>•</span> <span>1990</span> — primer span de 4
  // dígitos. Es la desambiguación definitiva cuando el título no alcanza
  // (ej. "Episode of Bardock" 2011 vs el especial de 1990, ambos matchean
  // "Bardock" por Jaccard).
  async function fetchSlugYear(slug) {
    try {
      const r = await fetch(`${ANIMEAV1_BASE}/${slug}`, {
        headers: PAGE_HEADERS, signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) return null;
      const html = await r.text();
      const m = html.match(/<span>(\d{4})<\/span>/);
      return m ? parseInt(m[1], 10) : null;
    } catch { return null; }
  }

  // Pool combinado: slug → { r, rank } con el mejor rank visto entre todas
  // las queries. Antes se evaluaba título por título y se devolvía el primer
  // match — eso elegía "shin-evangelion-movie" (película 4) para Eva 1.0
  // porque el Jaccard empataba y ganaba el orden del buscador.
  const pool = new Map();
  let narrowTop = null;
  const addResults = (arr) => {
    (arr || []).forEach((r, i) => {
      if (!r?.slug) return;
      const e = pool.get(r.slug);
      if (!e) pool.set(r.slug, { r, rank: i });
      else if (i < e.rank) e.rank = i;
    });
  };

  // Memo local: una query repetida entre variantes no vuelve a salir a la red.
  const searches = new Map();
  const search = (query) => {
    if (!searches.has(query)) searches.set(query, searchAnimeav1(query));
    return searches.get(query);
  };
  const titleResults = await Promise.all(titleCandidates.map(async (malTitle) => {
    const batches = [];
    let narrowTop = null;
    try {
      // Usar el título hasta el primer ":" como query de búsqueda.
      // Si el split en ":" da menos de 4 chars (ej: "Re" de "Re:Zero"),
      // usar el título completo sin el número de temporada para mejor coincidencia.
      const splitColon = malTitle.split(":")[0].trim();
      const afterColon = malTitle.slice(splitColon.length + 1).trim();
      const keywords   = splitColon.length >= 4
        ? splitColon
        : malTitle.replace(/\b\d+(?:st|nd|rd|th)\s+season\b/gi, "").replace(/[!]/g, "").trim();

      const results = await search(keywords);
      console.log(`[scraper] search "${keywords}" → ${results.map(r => r.slug).join(", ") || "(sin resultados)"}`);
      batches.push(results);

      // Con títulos que tienen ":", la query corta ("Rurouni Kenshin") puede
      // no devolver la entrada exacta — buscar también con el título completo.
      if (malTitle.includes(":") && keywords !== malTitle) {
        batches.push(await search(malTitle).catch(() => []));
      }

      // Query acotada con la parte DESPUÉS de los ":" — distingue
      // especiales/películas. Si devuelve pocos resultados, el top del
      // ranking es confiable como fallback.
      if (afterColon.length >= 4) {
        const narrow = await search(afterColon).catch(() => []);
        batches.push(narrow);
        if (narrow.length > 0 && narrow.length <= 2) narrowTop = narrow[0].slug;
      }
      return { batches, narrowTop };
    } catch (e) {
      return { batches, narrowTop, error: e };
    }
  }));
  // Combinar en orden original, nunca por orden de llegada: preserva desempates.
  let lastError;
  for (const result of titleResults) {
    for (const batch of result.batches) addResults(batch);
    if (result.narrowTop) narrowTop = result.narrowTop;
    if (result.error) lastError = result.error;
  }

  const entries = [...pool.values()];
  const ranked = pickBestSlug(entries, titleCandidates, anilistYear);
  // La query específica (parte después de ":") es un candidato extra cuando
  // devolvió pocos resultados — su top de ranking es confiable.
  const candidates = [...(ranked ?? [])];
  if (narrowTop && !candidates.includes(narrowTop)) candidates.push(narrowTop);

  // Verificación por año: el media page de animeav1 muestra el año en un
  // <span> del header. Si AniList da un año, el primer candidato cuyo año
  // coincide gana — resuelve especiales/películas con títulos parecidos
  // (ej. "Episode of Bardock" 2011 vs el especial de 1990).
  let slug = null;
  if (anilistYear && candidates.length > 1) {
    const years = new Map();
    for (const c of candidates.slice(0, 5)) {
      const y = await fetchSlugYear(c);
      years.set(c, y);
      if (y === anilistYear) { slug = c; break; }
    }
    if (slug && slug !== candidates[0]) {
      console.log(`[scraper] malId=${malId} → "${candidates[0]}" descartado por año (página dice ${years.get(candidates[0]) ?? "?"}, AniList ${anilistYear}) → "${slug}"`);
    }
  }
  slug ??= candidates[0] ?? null;
  if (slug) {
    console.log(`[scraper] malId=${malId} → slug="${slug}" (de ${entries.length} candidatos)`);
    cacheSet(key, slug, 7 * 24 * 60 * 60 * 1000);
    // #region debug-point B:slug-selected
    reportAnimeAv1Debug("B", "src/providers/scraper.js:resolveMalIdToSlug:selected", "[DEBUG] animeav1 slug resolved", { key, malId, slug, candidateCount: entries.length });
    // #endregion
    return slug;
  }
  lastError ??= Object.assign(new Error(`No match for "${titleCandidates[0]}" in animeav1 search`), { status: 404 });

  // Fallback: construir slug desde el título romaji y verificar con HEAD
  // Ej: "Re:Zero kara Hajimeru Isekai Seikatsu 4th Season"
  //   → "rezero-kara-hajimeru-isekai-seikatsu-4th-season"
  const romajiTitle = titleCandidates[0];
  if (romajiTitle) {
    for (const candidateSlug of buildSlugFallbacks(romajiTitle)) {
      console.log(`[scraper] malId=${malId} → probando slug construido: "${candidateSlug}"`);
      if (await probeSlug(candidateSlug)) {
        console.log(`[scraper] malId=${malId} → slug construido confirmado: "${candidateSlug}"`);
        cacheSet(key, candidateSlug, 7 * 24 * 60 * 60 * 1000);
        return candidateSlug;
      }
    }
  }

  throw lastError ?? Object.assign(new Error("Could not match any title in animeav1.com"), { status: 404 });
}

// ── Extractor de URLs HLS por sección ────────────────────────────────────────

// Devuelve TODAS las URLs HLS de una sección (DUB o SUB), en orden
function extractAllHlsUrls(html, section) {
  const sectionRe = new RegExp(`${section}:\\[([^\\[]*?)\\]`);
  const sectionMatch = html.match(sectionRe);
  if (!sectionMatch) return [];

  const urls = [];
  const re = /server:"HLS",url:"([^"]+)"/g;
  let m;
  while ((m = re.exec(sectionMatch[1])) !== null) {
    urls.push(m[1]);
  }
  return urls;
}

// Extrae URLs de un server:"<name>" específico dentro de una sección (DUB/SUB)
function extractServerUrls(html, section, serverName) {
  const sectionRe = new RegExp(`${section}:\\[([^\\[]*?)\\]`);
  const sectionMatch = html.match(sectionRe);
  if (!sectionMatch) return [];

  const urls = [];
  const re = new RegExp(`server:"${serverName}",url:"([^"]+)"`, "g");
  let m;
  while ((m = re.exec(sectionMatch[1])) !== null) {
    urls.push(m[1]);
  }
  return urls;
}

function extractUpnShareUrls(html, section)  { return extractServerUrls(html, section, "UPNShare"); }
function extractVoeUrls(html, section)       { return extractServerUrls(html, section, "Voe"); }
function extractMp4UploadUrls(html, section) { return extractServerUrls(html, section, "MP4Upload"); }

function playToM3U8(url) {
  return url.replace("/play/", "/m3u8/");
}

// ── MP4Upload extractor ────────────────────────────────────────────
// Sin ofuscación ni challenge alguno: el embed HTML trae la URL del MP4 en
// texto plano dentro de `player.src({type:"video/mp4", src:"..."})`. Solo
// exige Referer exacto "https://mp4upload.com/" (sin él, 403; con él, 206
// con Range OK — verificado 2026-09-27).
const MP4UPLOAD_HEADERS = { "User-Agent": PAGE_HEADERS["User-Agent"], Referer: "https://mp4upload.com/" };

async function mp4uploadToStream(embedUrl, attempt = 0) {
  try {
    const r = await fetch(embedUrl, { headers: MP4UPLOAD_HEADERS, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const html = await r.text();
    const srcMatch = html.match(/src:\s*"([^"]+\.mp4[^"]*)"/);
    if (!srcMatch) return null;
    const posterMatch = html.match(/player\.poster\("([^"]+)"\)/);
    return { url: srcMatch[1], thumbnailJpg: posterMatch?.[1] || null };
  } catch (e) {
    if (attempt === 0) return mp4uploadToStream(embedUrl, 1);
    return null;
  }
}

// Extrae los links de descarga directa (Mega, 1Fichier, MP4Upload, StreamTape, etc.)
// embebidos en el HTML bajo `downloads:{SUB:[{server,url}],DUB:[{server,url}]}`.
function extractDownloadLinks(html) {
  const downloadsMatch = html.match(/downloads:\{(SUB:\[.*?\],DUB:\[.*?\]|DUB:\[.*?\],SUB:\[.*?\]|SUB:\[.*?\]|DUB:\[.*?\])\}/);
  if (!downloadsMatch) return { sub: [], dub: [] };
  const block = downloadsMatch[1];

  const extract = (section) => {
    const m = block.match(new RegExp(`${section}:\\[([^\\]]*)\\]`));
    if (!m) return [];
    const items = [];
    const re = /\{server:"([^"]+)",url:"([^"]+)"\}/g;
    let mm;
    while ((mm = re.exec(m[1])) !== null) items.push({ server: mm[1], url: mm[2] });
    return items;
  };

  return { sub: extract("SUB"), dub: extract("DUB") };
}

// ── Scraper principal ─────────────────────────────────────────────────────────

async function scrapeM3U8(slug, episode) {
  const cacheKey = `m3u8:${slug}:${episode}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    // #region debug-point A:scrape-cache-hit
    reportAnimeAv1Debug("A", "src/providers/scraper.js:scrapeM3U8:hit", "[DEBUG] animeav1 stream cache hit", { cacheKey, slug, episode, streamCount: cached?.streams?.length ?? 0 });
    // #endregion
    return cached;
  }
  // #region debug-point A:scrape-cache-miss
  reportAnimeAv1Debug("A", "src/providers/scraper.js:scrapeM3U8:miss", "[DEBUG] animeav1 stream cache miss", { cacheKey, slug, episode });
  // #endregion

  const epNum = parseInt(episode);

  // Para películas animeav1 usa /0 o /1 sin criterio fijo → probar ambos
  const candidates = [epNum];
  if (epNum === 0) candidates.push(1);
  if (epNum === 1) candidates.push(0);

  let res, usedEp = epNum;
  for (const ep of candidates) {
    const pageUrl = `${ANIMEAV1_BASE}/${slug}/${ep}`;
    res = await fetch(pageUrl, { headers: PAGE_HEADERS, signal: AbortSignal.timeout(15000) });
    if (res.ok) { usedEp = ep; break; }
    console.warn(`[scraper] 404 en ${slug}/${ep}, probando siguiente...`);
  }

  if (!res.ok) throw Object.assign(new Error(`Page fetch failed: ${res.status}`), { status: 502 });

  const html = await res.text();

  const dubUrls    = extractAllHlsUrls(html, "DUB");
  const subUrls    = extractAllHlsUrls(html, "SUB");
  const dubUpnUrls = extractUpnShareUrls(html, "DUB");
  const subUpnUrls = extractUpnShareUrls(html, "SUB");
  const dubVoeUrls = extractVoeUrls(html, "DUB");
  const subVoeUrls = extractVoeUrls(html, "SUB");
  const dubMp4uUrls = extractMp4UploadUrls(html, "DUB");
  const subMp4uUrls = extractMp4UploadUrls(html, "SUB");
  const downloads  = extractDownloadLinks(html);

  console.log(`[scraper] slug=${slug} ep=${usedEp} | DUB HLS=${dubUrls.length} UPN=${dubUpnUrls.length} Voe=${dubVoeUrls.length} MP4U=${dubMp4uUrls.length} | SUB HLS=${subUrls.length} UPN=${subUpnUrls.length} Voe=${subVoeUrls.length} MP4U=${subMp4uUrls.length}`);

  if (dubUrls.length === 0 && subUrls.length === 0 && dubUpnUrls.length === 0 && subUpnUrls.length === 0 && dubVoeUrls.length === 0 && subVoeUrls.length === 0 && dubMp4uUrls.length === 0 && subMp4uUrls.length === 0) {
    throw new Error("No player URLs found in page HTML");
  }

  // Resolver UPNShare, Voe y MP4Upload de DUB y SUB en paralelo, SIEMPRE
  // todos los tipos de cada servidor — un fallo transitorio en uno no debe
  // tirar todo el resultado si otro (nunca probado antes) hubiera funcionado.
  const dubUpnPromises = dubUpnUrls.map(u => upnShareToM3U8(u).catch(() => null));
  const subUpnPromises = subUpnUrls.map(u => upnShareToM3U8(u).catch(() => null));
  const dubVoePromises = dubVoeUrls.map(u => voeToM3U8(u).catch(() => null));
  const subVoePromises = subVoeUrls.map(u => voeToM3U8(u).catch(() => null));
  const dubMp4uPromises = dubMp4uUrls.map(u => mp4uploadToStream(u).catch(() => null));
  const subMp4uPromises = subMp4uUrls.map(u => mp4uploadToStream(u).catch(() => null));

  // Todos los servidores DUB HLS + primer servidor SUB HLS
  const streams = [];
  dubUrls.forEach((url, i) => streams.push({ url: playToM3U8(url), type: "dub", server: i + 1 }));
  if (subUrls.length > 0) streams.push({ url: playToM3U8(subUrls[0]), type: "sub", server: 1 });

  // Agregar servidores UPNShare resueltos — el número de servidor es
  // relativo al tipo: si ya hay 1 SUB HLS, el UPNShare SUB es srv2
  const dubHlsCount = dubUrls.length;
  const subHlsCount = subUrls.length > 0 ? 1 : 0;
  const [dubUpnResults, subUpnResults, dubVoeResults, subVoeResults, dubMp4uResults, subMp4uResults] = await Promise.all([
    Promise.all(dubUpnPromises),
    Promise.all(subUpnPromises),
    Promise.all(dubVoePromises),
    Promise.all(subVoePromises),
    Promise.all(dubMp4uPromises),
    Promise.all(subMp4uPromises),
  ]);
  const pushUpnResults = (results, type, baseCount) => {
    results.forEach((upn, i) => {
      if (!upn?.url) return;
      const serverNum = baseCount + i + 1;
      console.log(`[scraper] UPNShare(${type}) server${serverNum}: ${upn.url}`);
      streams.push({
        url:          upn.url,
        type,
        server:       serverNum,
        provider:     "upnshare",
        cfUrl:        upn.url,
        ...(upn.thumbnailVtt && { thumbnailVtt: upn.thumbnailVtt }),
        ...(upn.thumbnailJpg && { thumbnailJpg: upn.thumbnailJpg }),
      });
    });
  };
  pushUpnResults(dubUpnResults, "dub", dubHlsCount);
  pushUpnResults(subUpnResults, "sub", subHlsCount);

  // Voe: server number sigue después de HLS + UPNShare de ese mismo tipo
  const dubBeforeVoe = dubHlsCount + dubUpnResults.filter(r => r?.url).length;
  const subBeforeVoe = subHlsCount + subUpnResults.filter(r => r?.url).length;
  const pushVoeResults = (results, type, baseCount) => {
    results.forEach((voe, i) => {
      if (!voe?.url) return;
      const serverNum = baseCount + i + 1;
      console.log(`[scraper] Voe(${type}) server${serverNum}: ${voe.url}`);
      streams.push({
        url:          voe.url,
        type,
        server:       serverNum,
        provider:     "voe",
        cfUrl:        voe.url,
        ...(voe.directUrl && { directUrl: voe.directUrl }),
        ...(voe.thumbnailJpg && { thumbnailJpg: voe.thumbnailJpg }),
      });
    });
  };
  pushVoeResults(dubVoeResults, "dub", dubBeforeVoe);
  pushVoeResults(subVoeResults, "sub", subBeforeVoe);

  // MP4Upload: server number sigue después de HLS + UPNShare + Voe de ese tipo
  const dubBeforeMp4u = dubBeforeVoe + dubVoeResults.filter(r => r?.url).length;
  const subBeforeMp4u = subBeforeVoe + subVoeResults.filter(r => r?.url).length;
  const pushMp4uResults = (results, type, baseCount) => {
    results.forEach((mp4u, i) => {
      if (!mp4u?.url) return;
      const serverNum = baseCount + i + 1;
      console.log(`[scraper] MP4Upload(${type}) server${serverNum}: ${mp4u.url}`);
      streams.push({
        url:          mp4u.url,
        type,
        server:       serverNum,
        provider:     "mp4upload",
        cfUrl:        mp4u.url,
        ...(mp4u.thumbnailJpg && { thumbnailJpg: mp4u.thumbnailJpg }),
      });
    });
  };
  pushMp4uResults(dubMp4uResults, "dub", dubBeforeMp4u);
  pushMp4uResults(subMp4uResults, "sub", subBeforeMp4u);

  streams.forEach(s => console.log(`[scraper] m3u8 (${s.type} srv${s.server}): ${s.url}`));
  // Cachear también con el ep que realmente funcionó (para películas que usan /0)
  // TTL corto porque UPNShare firma la URL con un token (pk.kx) que expira en ~25-30 min;
  // cachear por 4hs serviría cf-master URLs muertas (403) la mayor parte del tiempo.
  const streamsTtl = 15 * 60 * 1000;
  const result = { streams, downloads };
  cacheSet(cacheKey, result, streamsTtl);
  if (usedEp !== epNum) cacheSet(`m3u8:${slug}:${usedEp}`, result, streamsTtl);
  // #region debug-point B:scrape-result
  reportAnimeAv1Debug("B", "src/providers/scraper.js:scrapeM3U8:done", "[DEBUG] animeav1 scrape result", { cacheKey, slug, requestedEpisode: epNum, usedEpisode: usedEp, streamCount: streams.length, downloadCount: (downloads?.sub?.length ?? 0) + (downloads?.dub?.length ?? 0) });
  // #endregion
  return result;
}

// ── Detección de split-cours: offset de episodios ────────────────────────────

/**
 * Dado un anilistId, devuelve cuántos episodios hay que sumar al número local
 * para llegar al episodio correcto en la página de animeav1.
 *
 * Caso split-cours: Part 1 y Part 2 están en la misma página de animeav1.
 * Detectamos esto comparando el slug resuelto del anime actual con el de su PREQUEL.
 * Si son iguales → están en la misma página → offset = episodios del prequel.
 * Si son distintos → sequel normal → offset = 0.
 */
export async function getEpisodeOffset(anilistId) {
  return coalesceScrape(`ep_offset:${anilistId}`, () => resolveEpisodeOffset(anilistId));
}

async function resolveEpisodeOffset(anilistId) {
  const key = `ep_offset:${anilistId}`;
  const cached = cacheGet(key);
  if (cached !== null) {
    // #region debug-point A:offset-cache-hit
    reportAnimeAv1Debug("A", "src/providers/scraper.js:resolveEpisodeOffset:hit", "[DEBUG] animeav1 offset cache hit", { key, anilistId, offset: cached });
    // #endregion
    return cached;
  }
  // #region debug-point A:offset-cache-miss
  reportAnimeAv1Debug("A", "src/providers/scraper.js:resolveEpisodeOffset:miss", "[DEBUG] animeav1 offset cache miss", { key, anilistId });
  // #endregion

  const TTL = 7 * 24 * 60 * 60 * 1000; // 7 días — split-cours no cambia

  try {
    // 1. Buscar PREQUEL TV/ONA en AniList — incluimos título del prequel para evitar Jikan
    const q = `query($id:Int){Media(id:$id,type:ANIME){idMal title{romaji english} startDate{year} relations{edges{relationType node{id idMal format episodes title{romaji english} startDate{year}}}}}}`;
    const alRes = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: ANILIST_HEADERS,
      body: JSON.stringify({ query: q, variables: { id: Number(anilistId) } }),
      signal: AbortSignal.timeout(4000),
    });
    const alJson = await alRes.json();
    const mediaData = alJson?.data?.Media;
    const edges = mediaData?.relations?.edges ?? [];

    const prequelNode = edges
      .filter(e => e.relationType === "PREQUEL" && ["TV", "ONA"].includes(e.node?.format))
      .map(e => e.node)[0];

    if (!prequelNode?.idMal || !prequelNode?.episodes) {
      cacheSet(key, 0, TTL);
      return 0;
    }

    // 2. Resolver slug del anime actual y del prequel en paralelo — sin Jikan
    const currentMalId      = mediaData?.idMal;
    const currentRomaji     = mediaData?.title?.romaji  || null;
    const currentEnglish    = mediaData?.title?.english || null;
    const currentYear       = mediaData?.startDate?.year ?? null;
    const prequelRomaji     = prequelNode.title?.romaji  || null;
    const prequelEnglish    = prequelNode.title?.english || null;
    const prequelYear       = prequelNode.startDate?.year ?? null;

    if (!currentMalId) { cacheSet(key, 0, TTL); return 0; }

    const [currentSlug, prequelSlug] = await Promise.all([
      malIdToSlug(currentMalId, currentRomaji, currentEnglish, currentYear).catch(() => null),
      malIdToSlug(prequelNode.idMal, prequelRomaji, prequelEnglish, prequelYear).catch(() => null),
    ]);

    // 3. Si mismo slug → verificar si los episodios son secuenciales en esa página.
    //    Para distinguir split-cours real de slugs coincidentes donde cada season numera desde 1:
    //    - Split-cours real: la página tiene preq.eps + sequel.eps → el episodio (preq.eps + 1) existe.
    //    - Falso positivo (Kaguya-sama): la página solo tiene la season actual, empieza desde 1.
    //    Probamos HEAD al episodio inmediatamente siguiente al último del prequel.
    if (currentSlug && prequelSlug && currentSlug === prequelSlug) {
      let confirmedSplitCours = false;
      try {
        const probeEp = prequelNode.episodes + 1;
        const probeResp = await fetch(
          `https://animeav1.com/media/${currentSlug}/${probeEp}`,
          { method: "HEAD", headers: PAGE_HEADERS, signal: AbortSignal.timeout(6000), redirect: "follow" }
        );
        confirmedSplitCours = probeResp.ok; // 200 → existe → split-cours real
        console.log(`[scraper] split-cours probe: /media/${currentSlug}/${probeEp} → ${probeResp.status} → ${confirmedSplitCours ? "split-cours REAL" : "NO split-cours (season separada)"}`);
      } catch (e) {
        // Si falla el probe, asumimos que no es split-cours (más seguro)
        console.warn(`[scraper] split-cours probe falló para "${currentSlug}":`, e.message);
      }

      if (confirmedSplitCours) {
        let offset = prequelNode.episodes;
        // Si hay ep 0 especial TV, el especial ocupa el slot 0 y los eps del prequel
        // son 1..N sin desplazarse, pero AniList los cuenta como N+1 total incluyendo el especial.
        // En ese caso el offset real es anilistEps - 1.
        const ep0CacheKey = `ep0special:${currentSlug}`;
        let hasEp0Special = cacheGet(ep0CacheKey);
        if (hasEp0Special === null) {
          const ep0Resp = await fetch(`${ANIMEAV1_BASE}/${currentSlug}/0`, { headers: PAGE_HEADERS, signal: AbortSignal.timeout(8000) }).catch(() => null);
          if (ep0Resp?.ok) {
            const ep0Html = await ep0Resp.text();
            hasEp0Special = /TV Anime/i.test(ep0Html) && /SUB:\[|DUB:\[/.test(ep0Html);
          } else {
            hasEp0Special = false;
          }
          cacheSet(ep0CacheKey, hasEp0Special, 24 * 60 * 60 * 1000);
        }
        if (hasEp0Special) {
          offset = prequelNode.episodes - 1;
          console.log(`[scraper] split-cours + ep0 especial → offset ajustado ${prequelNode.episodes} → ${offset}`);
        }
        console.log(`[scraper] split-cours confirmado: anilist=${anilistId} → offset=${offset} (prequel idMal=${prequelNode.idMal}, slug="${currentSlug}")`);
        cacheSet(key, offset, TTL);
        // #region debug-point B:offset-resolved
        reportAnimeAv1Debug("B", "src/providers/scraper.js:resolveEpisodeOffset:resolved", "[DEBUG] animeav1 offset resolved", { key, anilistId, offset, reason: "split-cours" });
        // #endregion
        return offset;
      }
    }

    cacheSet(key, 0, TTL);
    // #region debug-point B:offset-zero
    reportAnimeAv1Debug("B", "src/providers/scraper.js:resolveEpisodeOffset:zero", "[DEBUG] animeav1 offset resolved", { key, anilistId, offset: 0, reason: "default-zero" });
    // #endregion
    return 0;
  } catch (err) {
    console.warn(`[scraper] getEpisodeOffset(${anilistId}) falló:`, err.message);
    return 0;
  }
}

// ── Export principal ──────────────────────────────────────────────────────────

export async function getLatinoStream(anilistId, episode) {
  const t0 = Date.now();
  const lap = (l) => console.log(`  [latino ${anilistId}/${episode}] ${l}: ${Date.now()-t0}ms`);
  // #region debug-point B:getLatino-start
  reportAnimeAv1Debug("B", "src/providers/scraper.js:getLatinoStream:start", "[DEBUG] animeav1 provider start", { anilistId, episode });
  // #endregion

  // El slug solo necesita metadata; no tiene que esperar los probes del offset.
  const [resolved, offset] = await Promise.all([
    getAnilistInfo(anilistId).then(async (info) => {
      if (!info.idMal) throw Object.assign(new Error("No MAL ID in AniList for this anime"), { status: 404 });
      const slug = await malIdToSlug(info.idMal, info.titleRomaji, info.titleEnglish, info.year);
      return { info, slug };
    }),
    getEpisodeOffset(anilistId),
  ]);
  const { info, slug } = resolved;
  const malId = info.idMal;
  lap(`metadata+slug+offset (slug="${slug}", malId=${malId}, offset=${offset})`);

  const epNum = Number(episode) + offset;
  if (offset > 0) console.log(`[scraper] split-cours: ep local ${episode} → ep animeav1 ${epNum} (offset=${offset})`);

  const { streams, downloads } = await scrapeM3U8(slug, epNum);
  lap("scrapeM3U8");
  // #region debug-point B:getLatino-done
  reportAnimeAv1Debug("B", "src/providers/scraper.js:getLatinoStream:done", "[DEBUG] animeav1 provider done", { anilistId, episode, slug, offset, episodeOnPage: epNum, streamCount: streams.length, ms: Date.now() - t0 });
  // #endregion

  return { slug, malId, offset, episodeOnPage: epNum, streams, downloads };
}
