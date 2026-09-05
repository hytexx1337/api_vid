/**
 * scraper-anikoto.js
 *
 * Adaptación del provider de Anivexa para Vidnest-API.
 * Extrae streams HLS desde anikototv.to a partir de un AniList ID y número de episodio,
 * devolviendo listas separadas por audio (sub/dub) para integrarse con /anime/:anilistId/:episode.
 */

import { ANILIST_HEADERS } from "../config/constants.js";

const ANIKOTO = "https://anikototv.to";
const MAPPER = "https://mapper.nekostream.site/api/mal";
const SPOOF_REF = "https://hianimes.re/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const CACHE_TTL = 3 * 60 * 60 * 1000; // 3 horas
const cache = new Map();
const mediaCache = new Map();

const MEGAPLAY_ORIGINS = new Set(["https://megaplay.buzz", "https://www.megaplay.buzz"]);

function isMegaplayStream(hlsUrl, referer) {
  try {
    const urlObj = new URL(hlsUrl);
    if (urlObj.hostname.includes("megaplay.buzz")) return true;
  } catch {}
  try {
    const refObj = new URL(referer);
    if (MEGAPLAY_ORIGINS.has(refObj.origin)) return true;
  } catch {}
  return false;
}

// ── Helpers HTTP ───────────────────────────────────────────────────────────────

async function httpGet(url, headers = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,*/*", ...headers },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => null);
    const e = new Error(`HTTP ${res.status} fetching ${url}`);
    e.rawBody = raw;
    throw e;
  }
  return res.text();
}

async function getJSON(url, headers = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json,*/*", ...headers },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => null);
    const e = new Error(`HTTP ${res.status} fetching ${url}`);
    e.rawBody = raw;
    throw e;
  }
  return res.json();
}

function normalize(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ── AniList media resolver ─────────────────────────────────────────────────────

async function getAnilistMedia(anilistId) {
  const key = `anilist:${anilistId}`;
  const hit = mediaCache.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.data;

  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: ANILIST_HEADERS,
    body: JSON.stringify({
      query: `query($id:Int){Media(id:$id){idMal title{english romaji} synonyms}}`,
      variables: { id: Number(anilistId) },
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
  const json = await res.json();
  const m = json?.data?.Media;
  if (!m) throw new Error(`AniList media not found: ${anilistId}`);

  const data = {
    idMal: m.idMal ?? null,
    title: { english: m.title?.english ?? null, romaji: m.title?.romaji ?? null },
    synonyms: m.synonyms || [],
  };
  mediaCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL });
  return data;
}

// ── Búsqueda / matching del show ─────────────────────────────────────────────────

const MODIFIERS = [
  "ova", "movie", "special", "specials", "tales", "journal", "part", "season", "kanwa", "spin-off", "theatre",
];

function scoreCandidate(cand, primaryEn, primaryRom, synonyms) {
  let score = 0;
  const candNameNorm = normalize(cand.name);
  const candJpNorm = normalize(cand.jp);
  const candSlugNorm = normalize(cand.slug);
  const normEn = normalize(primaryEn);
  const normRom = normalize(primaryRom);

  if (normEn && candNameNorm === normEn) score += 1000;
  if (normRom && candNameNorm === normRom) score += 900;
  if (normRom && candJpNorm === normRom) score += 800;

  const targetText = `${primaryEn || ""} ${primaryRom || ""} ${(synonyms || []).join(" ")}`.toLowerCase();
  for (const mod of MODIFIERS) {
    const candHasMod = candNameNorm.includes(mod) || candSlugNorm.includes(mod);
    const targetHasMod = targetText.includes(mod);
    if (candHasMod && !targetHasMod) score -= 300;
  }

  for (const t of [primaryEn, primaryRom, ...(synonyms || [])]) {
    const normT = normalize(t);
    if (!normT || normT.length < 3) continue;
    if (candNameNorm === normT) score += 200;
    else if (candNameNorm.startsWith(normT) || normT.startsWith(candNameNorm)) score += 80;
    else if (candNameNorm.includes(normT) || normT.includes(candNameNorm)) score += 40;
    if (candJpNorm && candJpNorm === normT) score += 100;
  }

  const lengthDiff = Math.abs(candNameNorm.length - (normEn || normRom || "").length);
  score -= lengthDiff * 2;
  return score;
}

async function searchAnikoto(query) {
  const searchHtml = await httpGet(`${ANIKOTO}/filter?keyword=${encodeURIComponent(query)}`, {
    Referer: `${ANIKOTO}/`,
  });
  const candidates = [];
  const re = /<a\s+class="name d-title"\s+href="https:\/\/anikototv\.to\/watch\/([^"\/]+)(?:\/ep-\d+)?"[^>]*data-jp="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(searchHtml)) !== null) {
    candidates.push({
      slug: m[1],
      jp: m[2].trim(),
      name: m[3].replace(/<[^>]*>/g, "").trim(),
    });
  }

  if (!candidates.length) {
    const reFallback = /<a\s+href="https:\/\/anikototv\.to\/watch\/([^"\/]+)(?:\/ep-\d+)?"[^>]*>([\s\S]*?)<\/a>/g;
    while ((m = reFallback.exec(searchHtml)) !== null) {
      candidates.push({ slug: m[1], name: m[1], jp: "" });
    }
  }

  const seen = new Set();
  return candidates.filter((c) => {
    if (seen.has(c.slug)) return false;
    seen.add(c.slug);
    return true;
  });
}

async function findAnikotoShow(media) {
  const primaryEn = media.title?.english;
  const primaryRom = media.title?.romaji;
  const synonyms = media.synonyms || [];
  const keywords = [...new Set([primaryEn, primaryRom, ...synonyms].filter(Boolean))];
  const allCandidatesMap = new Map();

  for (const k of keywords.slice(0, 5)) {
    const res = await searchAnikoto(k).catch(() => []);
    for (const c of res) allCandidatesMap.set(c.slug, c);
  }

  const candidates = Array.from(allCandidatesMap.values());
  if (!candidates.length) {
    throw new Error(`No results found on Anikoto for: ${primaryEn || primaryRom}`);
  }

  const scored = candidates
    .map((c) => ({ ...c, score: scoreCandidate(c, primaryEn, primaryRom, synonyms) }))
    .sort((a, b) => b.score - a.score);

  const chosen = scored[0];
  const watchHtml = await httpGet(`${ANIKOTO}/watch/${chosen.slug}`, { Referer: `${ANIKOTO}/` });
  const showIdMatch = watchHtml.match(/data-id="(\d+)"/);
  if (!showIdMatch) throw new Error(`Could not find show ID for slug: ${chosen.slug}`);

  return { slug: chosen.slug, showId: showIdMatch[1], title: chosen.name };
}

// ── Extracción del embed ───────────────────────────────────────────────────────

async function extractEmbedSource(embedUrl) {
  try {
    const pageHtml = await httpGet(embedUrl, { Referer: SPOOF_REF, "Accept-Language": "en-US,en;q=0.9" });
    const m = pageHtml.match(/data-id="([^"]*)"/);
    if (!m?.[1]) return null;
    const fileId = m[1];
    const origin = new URL(embedUrl).origin;
    // El embed declara el type que hay que pedirle a getSources (sub, dub,
    // hsub, etc). Si lo limitamos a sub|dub, los embeds hsub piden sin type
    // y el server devuelve el source de soft-sub por defecto.
    const typeMatch = pageHtml.match(/type:\s*['"]([a-zA-Z]+)['"]/);
    const audioType = typeMatch?.[1];
    const typeQs = audioType ? `&type=${audioType}` : "";
    const data = await getJSON(`${origin}/stream/getSources?id=${fileId}&id=${fileId}${typeQs}`, {
      Referer: `${origin}/`,
      "X-Requested-With": "XMLHttpRequest",
    });
    return { fileId, data, origin };
  } catch (e) {
    return null;
  }
}

function mapTrack(t, source, referer) {
  const label = t.label ?? "";
  return {
    url: t.file,
    label: label || "English",
    default: t.default ?? false,
    source,
    referer,
  };
}

// ── Core: resuelve un audio (sub|dub) ───────────────────────────────────────────

async function fetchAudioStreams(media, show, epNum, audio) {
  if (audio !== "sub" && audio !== "dub") throw new Error("audio must be sub or dub");

  const listJson = await getJSON(`${ANIKOTO}/ajax/episode/list/${show.showId}`, {
    "X-Requested-With": "XMLHttpRequest",
    Referer: `${ANIKOTO}/watch/${show.slug}`,
  });

  const html = listJson.result || "";
  let targetEp = null;
  const re = /<a\s+[^>]*data-id="([^"]*)"[^>]*>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const getAttr = (attr) => {
      const x = tag.match(new RegExp(`data-${attr}="([^"]*)"`));
      return x ? x[1] : "";
    };
    const num = parseInt(getAttr("num"));
    const hasAudio = getAttr(audio) === "1";
    if (num === epNum && hasAudio) {
      targetEp = {
        ids: getAttr("ids"),
        mal: getAttr("mal"),
        slug: getAttr("slug"),
        timestamp: getAttr("timestamp"),
      };
      break;
    }
  }

  if (!targetEp?.ids) {
    throw new Error(`Episode ${epNum} not found for show: ${show.title}`);
  }

  const malIdNum = media.idMal || (targetEp.mal ? parseInt(targetEp.mal) : null);

  const [serverDataRes, mapperRes] = await Promise.allSettled([
    getJSON(`${ANIKOTO}/ajax/server/list?servers=${encodeURIComponent(targetEp.ids)}`, {
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${ANIKOTO}/`,
    }),
    targetEp.mal && targetEp.slug && targetEp.timestamp
      ? getJSON(`${MAPPER}/${targetEp.mal}/${targetEp.slug}/${targetEp.timestamp}`, { Referer: `${ANIKOTO}/` })
      : Promise.resolve(null),
  ]);

  const serverData = serverDataRes.status === "fulfilled" ? serverDataRes.value : null;
  const mapperData = mapperRes.status === "fulfilled" ? mapperRes.value : null;

  const serverHtml = serverData?.result || "";
  const serverItems = [];
  const hsubItems = [];
  const downloadItems = [];

  const typeRe = /<div class="type" data-type="([^"]+)">([\s\S]*?)<\/ul>\s*<\/div>/g;
  let typeM;
  while ((typeM = typeRe.exec(serverHtml)) !== null) {
    const typeName = typeM[1];
    for (const li of typeM[2].matchAll(/<li\s+([^>]*data-link-id[^>]*)>([\s\S]*?)<\/li>/g)) {
      const linkId = li[1].match(/data-link-id="([^"]+)"/)[1];
      const name = li[2].replace(/<[^>]+>/g, "").trim();
      if (!linkId) continue;

      if (typeName === "dl" || name.toLowerCase().includes("download") || name.toLowerCase().includes("kiwi")) {
        downloadItems.push({ linkId, name });
      } else if (typeName === audio) {
        serverItems.push({ linkId, name });
      } else if (audio === "sub" && typeName === "hsub") {
        hsubItems.push({ linkId, name });
      }
    }
  }

  if (mapperData) {
    for (const [sKey, sObj] of Object.entries(mapperData)) {
      if (sKey === "status") continue;
      const cleanName = sKey.replace(/[-_]+$/, "").trim();
      if (sObj?.[audio]?.url) {
        serverItems.push({ linkId: sObj[audio].url, name: cleanName });
      }
      if (sObj?.[audio]?.download) {
        for (const [dLabel, dUrl] of Object.entries(sObj[audio].download)) {
          if (dUrl && typeof dUrl === "string") downloadItems.push({ url: dUrl, name: cleanName });
        }
      }
    }
  }

  const streams = [];

  const resolveItems = async (items, { allowHd1 = false } = {}) => {
    const out = [];
    const serverSeen = new Set();
    for (const item of items) {
    if (serverSeen.has(item.name)) continue;
    serverSeen.add(item.name);

    const resolved = item.linkId.startsWith("http")
      ? { result: { url: item.linkId } }
      : await getJSON(`${ANIKOTO}/ajax/server?get=${encodeURIComponent(item.linkId)}`, {
          "X-Requested-With": "XMLHttpRequest",
          Referer: `${ANIKOTO}/`,
        }).catch(() => null);

    const embedUrl = resolved?.result?.url;
    if (!embedUrl) continue;

    let serverIntro = { start: 0, end: 0 };
    let serverOutro = { start: 0, end: 0 };

    if (resolved?.result?.skip_data?.intro?.length === 2) {
      const [s, e] = resolved.result.skip_data.intro;
      if (s || e) serverIntro = { start: Number(s) || 0, end: Number(e) || 0 };
    }
    if (resolved?.result?.skip_data?.outro?.length === 2) {
      const [s, e] = resolved.result.skip_data.outro;
      if (s || e) serverOutro = { start: Number(s) || 0, end: Number(e) || 0 };
    }

    let hlsUrl = null;

    if (embedUrl.includes("#aHR0c")) {
      const b64 = embedUrl.split("#")[1];
      try {
        const decodedUrl = atob(b64);
        if (decodedUrl.includes(".m3u8")) hlsUrl = decodedUrl;
      } catch (e) {}
    }

    const extracted = await extractEmbedSource(embedUrl);
    const itemSubs = [];

    if (extracted?.data?.sources?.file) {
      hlsUrl = extracted.data.sources.file;
      const referer = `${extracted.origin}/`;

      for (const t of extracted.data.tracks ?? []) {
        itemSubs.push(mapTrack(t, item.name, referer));
      }

      if (extracted.data.intro?.start || extracted.data.intro?.end) {
        serverIntro = {
          start: Number(extracted.data.intro.start) || 0,
          end: Number(extracted.data.intro.end) || 0,
        };
      }
      if (extracted.data.outro?.start || extracted.data.outro?.end) {
        serverOutro = {
          start: Number(extracted.data.outro.start) || 0,
          end: Number(extracted.data.outro.end) || 0,
        };
      }
    }

    if (hlsUrl) {
      const referer = extracted?.origin ? `${extracted.origin}/` : `${new URL(embedUrl).origin}/`;
      if (isMegaplayStream(hlsUrl, referer)) {
        console.log(`[anikoto] Ignorando stream de Megaplay: ${hlsUrl.slice(0, 80)}...`);
        continue;
      }
      const streamObj = {
        url: hlsUrl,
        type: "hls",
        server: item.name,
        referer,
        subtitles: itemSubs,
      };
      if (serverIntro.start || serverIntro.end) streamObj.skip = { intro: [serverIntro.start, serverIntro.end] };
      if (serverOutro.start || serverOutro.end) {
        streamObj.skip = streamObj.skip || {};
        streamObj.skip.outro = [serverOutro.start, serverOutro.end];
      }
      out.push(streamObj);
    }
    }
    return out;
  };

  for (const s of await resolveItems(serverItems, { allowHd1: true })) streams.push(s);
  const hsubStreams = hsubItems.length ? await resolveItems(hsubItems) : [];

  return { streams, hsubStreams, malId: malIdNum };
}

// ── API pública ─────────────────────────────────────────────────────────────────

/**
 * @returns {{ sub: Array, dub: Array }} streams por audio
 */
export async function getAnikotoStreams(anilistId, episode) {
  const epNum = parseInt(episode);
  const key = `anikoto:both:${anilistId}:${epNum}`;
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.data;

  const media = await getAnilistMedia(anilistId);
  const show = await findAnikotoShow(media);

  const [subResult, dubResult] = await Promise.allSettled([
    fetchAudioStreams(media, show, epNum, "sub"),
    fetchAudioStreams(media, show, epNum, "dub"),
  ]);

  if (subResult.status === "rejected") console.warn(`[anikoto] sub ✗: ${subResult.reason?.message}`);
  if (dubResult.status === "rejected") console.warn(`[anikoto] dub ✗: ${dubResult.reason?.message}`);

  const result = {
    sub: subResult.status === "fulfilled" ? subResult.value.streams : [],
    dub: dubResult.status === "fulfilled" ? dubResult.value.streams : [],
    hsub: subResult.status === "fulfilled" ? (subResult.value.hsubStreams ?? []) : [],
  };

  // Dedupe: si sub/dub/hsub resuelven al mismo HLS, evitar mostrar el mismo stream dos veces.
  const seenUrls = new Set();
  for (const list of [result.sub, result.dub, result.hsub]) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (seenUrls.has(list[i].url)) list.splice(i, 1);
      else seenUrls.add(list[i].url);
    }
  }

  if (result.sub.length || result.dub.length || result.hsub.length) {
    cache.set(key, { data: result, expiresAt: Date.now() + CACHE_TTL });
  }
  return result;
}
