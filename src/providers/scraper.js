import { createDecipheriv } from "crypto";

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

async function upnShareToM3U8(embedUrl) {
  // embedUrl es tipo "https://animeav1.uns.bio/#gpz1v8"
  const token = embedUrl.split("#")[1];
  if (!token) return null;

  const r = await fetch(
    `${UPN_BASE}/api/v1/video?id=${token}&w=1920&h=1080&r=`,
    {
      headers: {
        "User-Agent": PAGE_HEADERS["User-Agent"],
        "Referer": `${UPN_BASE}/#${token}`,
      },
      signal: AbortSignal.timeout(8000),
    }
  );
  if (!r.ok) return null;

  const hex  = await r.text();
  const data = upnDecrypt(hex);

  // Preferir la URL de Cloudflare (.txt) porque los segmentos son .woff2.
  // El CDN origin (nginx detrás de CF) exige un token firmado `k`/`kx` en la
  // query string — viene en data.pk y NO está incluido en data.cf directamente.
  // Sin este token, el origin devuelve 403 aunque el Referer/headers sean correctos.
  const base = data.cf ?? data.source ?? null;
  const streamUrl = base && data.pk?.k && data.pk?.kx
    ? `${base}${base.includes("?") ? "&" : "?"}k=${encodeURIComponent(data.pk.k)}&kx=${encodeURIComponent(data.pk.kx)}`
    : base;
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
  const key = `alinfo:${anilistId}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const q = `query($id:Int){Media(id:$id,type:ANIME){idMal title{romaji english} format}}`;
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: q, variables: { id: Number(anilistId) } }),
    signal: AbortSignal.timeout(5000),
  });
  const json = await res.json();
  const media = json?.data?.Media;
  if (!media) throw Object.assign(new Error("Anime not found in AniList"), { status: 404 });

  const result = {
    idMal:        media.idMal ?? null,
    titleRomaji:  media.title?.romaji  || null,
    titleEnglish: media.title?.english || null,
    format:       media.format ?? null,
  };
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

function normalizeTitle(t) {
  return t.toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function searchAnimeav1(query) {
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
  const m = str.match(/\b(\d+)(?:st|nd|rd|th)\b/i) ?? str.match(/\bseason\s+(\d+)\b/i);
  return m ? parseInt(m[1]) : null;
}

function pickBestSlug(results, malTitle) {
  if (!results?.length) return null;
  const normTitle    = malTitle.toLowerCase().trim();
  const normStripped = normalizeTitle(malTitle);
  const malSeason    = extractSeasonOrdinal(malTitle);

  // Pre-filtro por "?" en el título
  const malHasQuestion = malTitle.includes("?");
  const filtered = results.filter(r => malHasQuestion
    ? r.title.includes("?")
    : !r.title.includes("?")
  );
  const pool = filtered.length > 0 ? filtered : results;

  // Si el MAL title tiene número de temporada, preferir slugs que lo contengan
  // y descartar los que tienen un número de temporada distinto
  const seasonPool = malSeason
    ? pool.filter(r => {
        const slugSeason = extractSeasonOrdinal(r.slug) ?? extractSeasonOrdinal(r.title);
        if (slugSeason === null) return true;    // sin número → no penalizar
        return slugSeason === malSeason;         // descartar temporadas distintas
      })
    : pool;
  const effectivePool = seasonPool.length > 0 ? seasonPool : pool;

  // 1. Match exacto de título (case-insensitive)
  let match = effectivePool.find(r => r.title.toLowerCase().trim() === normTitle);

  // 2. Título normalizado sin puntuación
  if (!match) match = effectivePool.find(r => normalizeTitle(r.title) === normStripped);

  // 3. Slug normalizado vs título MAL normalizado
  if (!match) match = effectivePool.find(r => normalizeTitle(r.slug) === normStripped);

  // 4. Jaccard por tokens entre título MAL y slug
  if (!match) {
    const malTokens = new Set((malTitle.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(w => w.length > 1));
    let bestScore = 0;
    for (const r of effectivePool) {
      const slugTokens = new Set(r.slug.split("-").filter(t => t.length > 1));
      const shared = [...malTokens].filter(w => slugTokens.has(w)).length;
      const union  = malTokens.size + slugTokens.size - shared;
      const score  = union > 0 ? shared / union : 0;
      if (score > bestScore) { bestScore = score; match = r; }
    }
    if (bestScore < 0.5) match = undefined;
  }

  return match?.slug ?? null;
}

// titleRomaji/titleEnglish: si se pasan, se omite Jikan.
// Intenta romaji primero (los slugs de animeav1 usan romaji), luego inglés como fallback.
export async function malIdToSlug(malId, titleRomaji = null, titleEnglish = null) {
  const key = `slug:${malId}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const titleCandidates = [titleRomaji, titleEnglish].filter(Boolean);

  if (titleCandidates.length === 0) {
    const jikanRes = await fetch(`https://api.jikan.moe/v4/anime/${malId}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!jikanRes.ok) throw Object.assign(new Error("Anime not found in Jikan/MAL"), { status: 404 });
    const jikanData = await jikanRes.json();
    const t = jikanData?.data?.title;
    if (!t) throw Object.assign(new Error("No title in Jikan response"), { status: 404 });
    titleCandidates.push(t);
  }

  // Convierte un título a slug candidato: lowercase, solo alfanum+guión
  function titleToSlug(t) {
    return t.toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")   // quitar puntuación (incluye ":")
      .trim()
      .replace(/\s+/g, "-");
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

  let lastError;
  for (const malTitle of titleCandidates) {
    try {
      // Usar el título hasta el primer "!" como query de búsqueda.
      // Si el split en ":" da menos de 4 chars (ej: "Re" de "Re:Zero"),
      // usar el título completo sin el número de temporada para mejor coincidencia.
      const splitColon = malTitle.split(":")[0].trim();
      const keywords   = splitColon.length >= 4
        ? splitColon
        : malTitle.replace(/\b\d+(?:st|nd|rd|th)\s+season\b/gi, "").replace(/[!]/g, "").trim();
      const results = await searchAnimeav1(keywords);
      const slug    = pickBestSlug(results, malTitle);
      if (slug) {
        console.log(`[scraper] malId=${malId} → "${malTitle}" → slug="${slug}"`);
        cacheSet(key, slug, 7 * 24 * 60 * 60 * 1000);
        return slug;
      }
      lastError = Object.assign(new Error(`No match for "${malTitle}" in animeav1 search`), { status: 404 });
    } catch (e) {
      lastError = e;
    }
  }

  // Fallback: construir slug desde el título romaji y verificar con HEAD
  // Ej: "Re:Zero kara Hajimeru Isekai Seikatsu 4th Season"
  //   → "rezero-kara-hajimeru-isekai-seikatsu-4th-season"
  const romajiTitle = titleCandidates[0];
  if (romajiTitle) {
    const candidateSlug = titleToSlug(romajiTitle);
    console.log(`[scraper] malId=${malId} → probando slug construido: "${candidateSlug}"`);
    if (await probeSlug(candidateSlug)) {
      console.log(`[scraper] malId=${malId} → slug construido confirmado: "${candidateSlug}"`);
      cacheSet(key, candidateSlug, 7 * 24 * 60 * 60 * 1000);
      return candidateSlug;
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

// Extrae URLs de UPNShare (server:"UPNShare") de una sección
function extractUpnShareUrls(html, section) {
  const sectionRe = new RegExp(`${section}:\\[([^\\[]*?)\\]`);
  const sectionMatch = html.match(sectionRe);
  if (!sectionMatch) return [];

  const urls = [];
  const re = /server:"UPNShare",url:"([^"]+)"/g;
  let m;
  while ((m = re.exec(sectionMatch[1])) !== null) {
    urls.push(m[1]);
  }
  return urls;
}

function playToM3U8(url) {
  return url.replace("/play/", "/m3u8/");
}

// ── Scraper principal ─────────────────────────────────────────────────────────

async function scrapeM3U8(slug, episode) {
  const cacheKey = `m3u8:${slug}:${episode}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

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

  console.log(`[scraper] slug=${slug} ep=${usedEp} | DUB HLS=${dubUrls.length} UPN=${dubUpnUrls.length} | SUB HLS=${subUrls.length} UPN=${subUpnUrls.length}`);

  if (dubUrls.length === 0 && subUrls.length === 0 && dubUpnUrls.length === 0 && subUpnUrls.length === 0) {
    throw new Error("No player URLs found in page HTML");
  }

  // Resolver UPNShare DUB + SUB en paralelo
  // SUB solo se usa si DUB no tiene UPNShare
  const effectiveUpnUrls = dubUpnUrls.length > 0 ? dubUpnUrls : subUpnUrls;
  const effectiveUpnType = dubUpnUrls.length > 0 ? "dub" : "sub";
  const upnPromises = effectiveUpnUrls.map(u => upnShareToM3U8(u).catch(() => null));

  // Todos los servidores DUB HLS + primer servidor SUB HLS
  const streams = [];
  dubUrls.forEach((url, i) => streams.push({ url: playToM3U8(url), type: "dub", server: i + 1 }));
  if (subUrls.length > 0) streams.push({ url: playToM3U8(subUrls[0]), type: "sub", server: 1 });

  // Agregar servidores UPNShare resueltos
  // El número de servidor es relativo al tipo: si ya hay 1 SUB HLS, el UPNShare SUB es srv2
  const dubHlsCount = dubUrls.length;
  const subHlsCount = subUrls.length > 0 ? 1 : 0;
  const upnResults = await Promise.all(upnPromises);
  upnResults.forEach((upn, i) => {
    if (upn?.url) {
      const baseCount = effectiveUpnType === "dub" ? dubHlsCount : subHlsCount;
      const serverNum = baseCount + i + 1;
      console.log(`[scraper] UPNShare(${effectiveUpnType}) server${serverNum}: ${upn.url}`);
      streams.push({
        url:          upn.url,
        type:         effectiveUpnType,
        server:       serverNum,
        provider:     "upnshare",
        cfUrl:        upn.url,
        ...(upn.thumbnailVtt && { thumbnailVtt: upn.thumbnailVtt }),
        ...(upn.thumbnailJpg && { thumbnailJpg: upn.thumbnailJpg }),
      });
    }
  });

  streams.forEach(s => console.log(`[scraper] m3u8 (${s.type} srv${s.server}): ${s.url}`));
  // Cachear también con el ep que realmente funcionó (para películas que usan /0)
  // TTL corto porque UPNShare firma la URL con un token (pk.kx) que expira en ~25-30 min;
  // cachear por 4hs serviría cf-master URLs muertas (403) la mayor parte del tiempo.
  const streamsTtl = 15 * 60 * 1000;
  cacheSet(cacheKey, streams, streamsTtl);
  if (usedEp !== epNum) cacheSet(`m3u8:${slug}:${usedEp}`, streams, streamsTtl);
  return streams;
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
  const key = `ep_offset:${anilistId}`;
  const cached = cacheGet(key);
  if (cached !== null) return cached;

  const TTL = 7 * 24 * 60 * 60 * 1000; // 7 días — split-cours no cambia

  try {
    // 1. Buscar PREQUEL TV/ONA en AniList — incluimos título del prequel para evitar Jikan
    const q = `query($id:Int){Media(id:$id,type:ANIME){idMal title{romaji english} relations{edges{relationType node{id idMal format episodes title{romaji english}}}}}}`;
    const alRes = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "content-type": "application/json" },
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
    const prequelRomaji     = prequelNode.title?.romaji  || null;
    const prequelEnglish    = prequelNode.title?.english || null;

    if (!currentMalId) { cacheSet(key, 0, TTL); return 0; }

    const [currentSlug, prequelSlug] = await Promise.all([
      malIdToSlug(currentMalId, currentRomaji, currentEnglish).catch(() => null),
      malIdToSlug(prequelNode.idMal, prequelRomaji, prequelEnglish).catch(() => null),
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
        return offset;
      }
    }

    cacheSet(key, 0, TTL);
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

  // getAnilistInfo y getEpisodeOffset son independientes → paralelo
  // getAnilistInfo reemplaza ani.zip + Jikan: obtiene título y malId desde AniList directamente
  const [info, offset] = await Promise.all([
    getAnilistInfo(anilistId),
    getEpisodeOffset(anilistId),
  ]);
  lap(`alInfo+offset (title="${info.titleRomaji ?? info.titleEnglish}", malId=${info.idMal}, offset=${offset})`);

  if (!info.idMal) throw Object.assign(new Error("No MAL ID in AniList for this anime"), { status: 404 });
  const malId = info.idMal;

  const slug = await malIdToSlug(malId, info.titleRomaji, info.titleEnglish);
  lap(`slug="${slug}"`);

  const epNum = Number(episode) + offset;
  if (offset > 0) console.log(`[scraper] split-cours: ep local ${episode} → ep animeav1 ${epNum} (offset=${offset})`);

  const streams = await scrapeM3U8(slug, epNum);
  lap("scrapeM3U8");

  return { slug, malId, offset, episodeOnPage: epNum, streams };
}
