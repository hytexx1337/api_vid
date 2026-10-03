import crypto from "node:crypto";
import { isR2Configured, objectExistsInR2, uploadToR2 } from "./hls-to-r2.js";
import { buildSignedR2Url, signR2Path } from "./r2-seal.js";
import { removeSpamLines, srtToVtt } from "./subtitle-cleaner.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const FLIXCLOUD_REFERER = "https://flixcloud.cc/";

function sha1(value) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

function withOriginHeaders(referer) {
  return {
    "User-Agent": UA,
    Accept: "*/*",
    ...(referer ? { Referer: referer, Origin: new URL(referer).origin } : {}),
  };
}

async function fetchBuffer(url, referer, timeoutMs = 15000) {
  const response = await fetch(url, {
    headers: withOriginHeaders(referer),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType,
  };
}

async function uploadIfMissing(key, buffer, contentType) {
  if (!(await objectExistsInR2(key))) await uploadToR2(key, buffer, contentType);
}

function inferSubtitleFormat(track) {
  const url = String(track.url || "");
  if (track.format === "ass" || /\.ass(\?|$)/i.test(url)) return "ass";
  if (track.format === "srt" || /\.srt(\?|$)/i.test(url)) return "srt";
  return "vtt";
}

export async function archiveSubtitleTracksToR2(tracks) {
  if (!tracks?.length || !isR2Configured()) return tracks;

  const archived = await Promise.all(tracks.map(async (track) => {
    try {
      if (track.r2Key) {
        return { ...track, url: buildSignedR2Url(track.r2Key) };
      }
      const format = inferSubtitleFormat(track);
      const referer = track.referer ?? null;
      const { buffer } = await fetchBuffer(track.url, referer);
      let output = buffer;
      let extension = format;
      let contentType = "text/vtt; charset=utf-8";

      if (format === "ass") {
        extension = "ass";
        contentType = "text/x-ssa; charset=utf-8";
      } else {
        let text = removeSpamLines(buffer.toString("utf8"));
        if (format === "srt") text = srtToVtt(text);
        output = Buffer.from(text, "utf8");
        extension = "vtt";
      }

      const file = `reanime-${sha1(track.url)}.${extension}`;
      const key = `subs/${file}`;
      await uploadIfMissing(key, output, contentType);
      const { referer: _referer, proxy_url: _proxyUrl, ...rest } = track;
      return { ...rest, url: buildSignedR2Url(key), r2Key: key };
    } catch (error) {
      console.warn(`[reanime-r2] subtitle fallback ${track.url}: ${error.message}`);
      return { ...track, _archiveFailed: true };
    }
  }));

  return archived;
}

function thumbnailBasePath(url) {
  const lastSeg = url.split("/").pop().split("?")[0];
  return lastSeg.includes(".")
    ? url.substring(0, url.lastIndexOf("/") + 1)
    : url.replace(/\/$/, "") + "/";
}

function inferImageContentType(url) {
  if (/\.png(\?|$|#)/i.test(url)) return "image/png";
  if (/\.jpe?g(\?|$|#)/i.test(url)) return "image/jpeg";
  return "image/webp";
}

function parseThumbnailAssetRefs(vttText) {
  const refs = [];
  const lines = vttText.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(/^([\w./-]+\.(?:webp|jpg|jpeg|png))(#[^\s]*)?$/i);
    if (!match) continue;
    refs.push({ raw: trimmed, relPath: match[1], fragment: match[2] || "" });
  }
  return refs;
}

function isSafeThumbnailAssetUrl(assetUrl, vttUrl) {
  const asset = new URL(assetUrl);
  const vtt = new URL(vttUrl);
  if (asset.origin !== vtt.origin) return false;
  const assetPath = asset.pathname.toLowerCase();
  return assetPath.startsWith("/thumbnails/") || assetPath.includes("/thumbnails/");
}

function buildSignedSiblingRef(objectKey, fragment = "", ttlSeconds = 86400) {
  const path = objectKey.startsWith("/") ? objectKey : `/${objectKey}`;
  const filename = path.split("/").pop();
  const { exp, sig } = signR2Path(path, ttlSeconds);
  return `${filename}?exp=${exp}&sig=${sig}${fragment}`;
}

export async function archiveThumbnailVttToR2(vttUrl, referer = FLIXCLOUD_REFERER) {
  if (!vttUrl || !isR2Configured()) return null;

  try {
    const baseHash = sha1(vttUrl);
    const { buffer } = await fetchBuffer(vttUrl, referer);
    let text = buffer.toString("utf8");
    if (!text.startsWith("WEBVTT")) throw new Error("thumbnail VTT inválido");
    const basePath = thumbnailBasePath(vttUrl);
    const spriteMap = new Map();
    const refs = parseThumbnailAssetRefs(text);

    for (const { relPath } of refs) {
      if (spriteMap.has(relPath)) continue;
      const absoluteUrl = new URL(relPath, basePath).href;
      if (!isSafeThumbnailAssetUrl(absoluteUrl, vttUrl)) {
        throw new Error(`thumbnail asset fuera de base permitida: ${absoluteUrl}`);
      }
      const ext = absoluteUrl.match(/\.(webp|jpg|jpeg|png)(?=$|[?#])/i)?.[1]?.toLowerCase() || "webp";
      const spriteKey = `thumbs/reanime-${baseHash}/sprite-${sha1(absoluteUrl)}.${ext}`;
      const { buffer: spriteBuffer } = await fetchBuffer(absoluteUrl, referer);
      await uploadIfMissing(spriteKey, spriteBuffer, inferImageContentType(absoluteUrl));
      spriteMap.set(relPath, spriteKey);
    }

    text = text.replace(/^([\w./-]+\.(?:webp|jpg|jpeg|png))(#[^\s]*)?$/gim, (match, relPath, fragment = "") => {
      const spriteKey = spriteMap.get(relPath);
      return spriteKey ? buildSignedSiblingRef(spriteKey, fragment) : match;
    });

    const vttKey = `thumbs/reanime-${baseHash}/thumbs.vtt`;
    await uploadIfMissing(vttKey, Buffer.from(text, "utf8"), "text/vtt; charset=utf-8");
    return vttKey;
  } catch (error) {
    console.warn(`[reanime-r2] thumbnail fallback ${vttUrl}: ${error.message}`);
    return null;
  }
}
