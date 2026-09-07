import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { removeSpamLines, srtToVtt } from "./subtitle-cleaner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SUBS_DIR = path.join(__dirname, "..", "..", "subs-cache");

const VDRK_INDEX_PATH = path.join(SUBS_DIR, "vdrk-index.json");
const CR_INDEX_PATH = path.join(SUBS_DIR, "cr-index.json");

export function readCrIndex() {
  try { return existsSync(CR_INDEX_PATH) ? JSON.parse(readFileSync(CR_INDEX_PATH, "utf8")) : {}; }
  catch { return {}; }
}
export function writeCrIndex(idx) {
  try { writeFileSync(CR_INDEX_PATH, JSON.stringify(idx, null, 2), "utf8"); }
  catch (e) { console.error("[cr-index] write error:", e.message); }
}
export function readVdrkIndex() {
  try { return existsSync(VDRK_INDEX_PATH) ? JSON.parse(readFileSync(VDRK_INDEX_PATH, "utf8")) : {}; }
  catch { return {}; }
}
export function writeVdrkIndex(idx) {
  try { writeFileSync(VDRK_INDEX_PATH, JSON.stringify(idx, null, 2), "utf8"); }
  catch (e) { console.error("[vdrk-index] write error:", e.message); }
}
export function vdrkKey(tmdbId, mediaType, season = 1, episode = 1) {
  return mediaType === "movie" ? `movie:${tmdbId}` : `tv:${tmdbId}:${season}:${episode}`;
}

try {
  if (!existsSync(SUBS_DIR)) mkdirSync(SUBS_DIR, { recursive: true });
} catch (e) {
  console.error(`[subs] No se pudo crear subs-cache: ${e.message}`);
}

export function normalizeSubLabel(label, lang) {
  const src = (label ?? lang ?? "").toLowerCase().trim();
  if (/^(english(\s*(cc|sdh|forced))?|eng)$/i.test(src)) return "English";
  if (/english\s*(cc|sdh)/i.test(src)) return `English (${src.match(/cc|sdh/i)?.[0].toUpperCase()})`;
  if (/^(spanish|español|spa|es)$/i.test(src)) return "Español";
  if (/spanish.*latin|español.*latin|spa.*419|es.*419|es.*la$/i.test(src)) return "Español Latino";
  if (/spanish.*spain|español.*españa/i.test(src)) return "Español (España)";
  return (label ?? lang ?? "").replace(/\b\w/g, c => c.toUpperCase());
}

export function detectTrackLang(fileUrl, label) {
  const fileCode = fileUrl?.match(/\/subs\/(?:ai_)?([a-z]{2,3})_/i)?.[1]?.toLowerCase();
  if (fileCode) {
    const ISO = { eng: "en", spa: "es", por: "pt", jpn: "ja", fra: "fr", ger: "de", ita: "it", kor: "ko", chi: "zh" };
    return ISO[fileCode] ?? fileCode;
  }
  const l = (label ?? "").toLowerCase();
  if (l.includes("english")) return "en";
  if (l.includes("spanish") || l.includes("español")) return "es";
  if (l.includes("portuguese") || l.includes("português")) return "pt";
  if (l.includes("japanese") || l.includes("japonés")) return "ja";
  if (l.includes("french")) return "fr";
  if (l.includes("german")) return "de";
  if (l.includes("italian")) return "it";
  if (l.includes("korean")) return "ko";
  if (l.includes("chinese")) return "zh";
  return "unknown";
}

export async function localizeSubtitle(url, referer = null) {
  if (!url) return url;
  const hash = createHash("sha1").update(url).digest("hex");
  const filename = `${hash}.vtt`;
  const filepath = path.join(SUBS_DIR, filename);

  if (!existsSync(filepath)) {
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept": "*/*",
      ...(referer && { "Referer": referer, "Origin": new URL(referer).origin }),
    };
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      await writeFile(filepath, text, "utf8");
    } catch (e) {
      console.warn(`[subs] no se pudo descargar ${url}: ${e.message}`);
      return url;
    }
  }
  return null; // señal para que el caller use el filename
}

export async function downloadSubtitles(tracks) {
  if (!tracks?.length) return tracks;
  if (!existsSync(SUBS_DIR)) return tracks;

  return Promise.all(tracks.map(async (t) => {
    if (t.file) return { ...t, _localFile: t.file };
    if (/\.ass(\?|$)/i.test(t.url)) return t;

    const hash = createHash("sha1").update(t.url).digest("hex");
    // Siempre se guarda como .vtt: los .srt se convierten al vuelo (WebVTT es
    // lo único que <track> / hls.js soportan nativamente — servir un .srt
    // renombrado o con extensión propia no lo hace parseable en el browser).
    const isSrt = /\.srt(\?|$)/i.test(t.url);
    const filename = `${hash}.vtt`;
    const filepath = path.join(SUBS_DIR, filename);

    if (!existsSync(filepath)) {
      const referer = t.referer ?? t.proxy_url ?? null;
      const headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "*/*",
        ...(referer && { "Referer": referer, "Origin": (() => { try { return new URL(referer).origin; } catch { return referer; } })() }),
      };
      try {
        const r = await fetch(t.url, { headers, signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        let subText = removeSpamLines(await r.text());
        if (isSrt) subText = srtToVtt(subText);
        await writeFile(filepath, subText, "utf8");
      } catch (e) {
        console.warn(`[subs] fallo descarga ${t.url}: ${e.message}`);
        return t;
      }
    }

    const { referer: _r, proxy_url: _p, ...rest } = t;
    return { ...rest, _localFile: filename };
  }));
}

export async function getVidrkSubsWithIndex(tmdbId, mediaType, season = 1, episode = 1, title = null) {
  const key = vdrkKey(tmdbId, mediaType, season, episode);
  const idx = readVdrkIndex();
  if (idx[key]?.subtitles?.length) return idx[key].subtitles;

  // Import dynamically to avoid circular dependency with providers/index.js
  const { getVidrkSubs } = await import("../providers/index.js");
  const rawSubs = await getVidrkSubs(tmdbId, mediaType, season, episode);
  if (!rawSubs.length) return [];
  const downloaded = await downloadSubtitles(rawSubs);
  const indexedSubs = downloaded
    .filter(t => t._localFile)
    .map(t => ({ label: t.label, lang: t.lang, file: t._localFile, kind: t.kind ?? "captions", default: t.default ?? false }));
  if (indexedSubs.length) {
    idx[key] = { title, cachedAt: new Date().toISOString(), subtitles: indexedSubs };
    writeVdrkIndex(idx);
    return indexedSubs;
  }
  return rawSubs;
}

export async function buildTracks(rawTracks, proxyBase) {
  if (!rawTracks?.length) return null;
  const downloaded = await downloadSubtitles(rawTracks);
  return downloaded.map(t => {
    if (t._localFile) {
      const { _localFile, referer: _r, proxy_url: _p, ...rest } = t;
      return { ...rest, url: `${proxyBase}/subs/${_localFile}` };
    }
    if (t.referer) {
      return { ...t, proxy_url: `${proxyBase}/fetch?url=${encodeURIComponent(t.url)}&ref=${encodeURIComponent(t.referer)}&ct=${encodeURIComponent("text/vtt")}` };
    }
    return t;
  });
}
