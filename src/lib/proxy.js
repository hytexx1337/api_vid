import { EDGE_PROXY_BASE, PROXY_CDN_BASE, CC_MEDIA, CC_PLAYLIST, CC_SUBS } from "../config/constants.js";

function isLocalHost(host) {
  if (!host) return false;
  const h = host.toLowerCase().split(":")[0];
  return h === "localhost" || h === "127.0.0.1" || h.startsWith("192.168.") || h.startsWith("10.") || h.startsWith("172.");
}

function cleanHost(host) {
  if (!host) return "";
  return host
    .split(",")[0]
    .trim()
    .replace(/^https?:\/\//i, "");
}

export function getProxyBase(req) {
  const forwardedBase = req.headers["x-proxy-base"];
  if (forwardedBase && /^https?:\/\//.test(forwardedBase)) {
    return forwardedBase.replace(/\/$/, "");
  }
  const host = cleanHost(req.get("host"));
  if (PROXY_CDN_BASE && !isLocalHost(host)) {
    const cdnHost = PROXY_CDN_BASE.replace(/^https?:\/\//i, "");
    if (host.toLowerCase() !== cdnHost.toLowerCase()) {
      return PROXY_CDN_BASE;
    }
  }
  const rawProto = req.headers["x-forwarded-proto"];
  const proto = rawProto === "http" || rawProto === "https" ? rawProto : req.protocol;
  return `${proto}://${host}`;
}

export function isPlaylistCT(ct) { return /mpegurl|dash|xml/i.test(ct || ""); }
export function isSubsCT(ct) {
  return /vtt|text\/track|subrip|ass\/octet|application\/octet-stream.*\.(vtt|ass)/i.test(ct || "");
}

export function setCacheForResponse(res, contentType, urlHint) {
  const ct = contentType || "";
  const ext = String(urlHint || "").toLowerCase().match(/\.([a-z0-9]{1,6})(?:\?|#|$)/i)?.[1] || "";
  let cc;
  if (isPlaylistCT(ct) || ["m3u8", "mpd"].includes(ext)) cc = CC_PLAYLIST;
  else if (isSubsCT(ct) || ["vtt", "ass", "srt"].includes(ext)) cc = CC_SUBS;
  else cc = CC_MEDIA;
  res.removeHeader("Cache-Control");
  res._ccFinal = cc;
  res.setHeader("Cache-Control", cc);
}

export function parsHeaders(raw) {
  if (!raw) return {};
  try {
    return typeof raw === "string" ? JSON.parse(decodeURIComponent(raw)) : raw;
  } catch {
    return {};
  }
}

export function registrableDomain(hostname) {
  const parts = hostname.split(".");
  return parts.length > 2 ? parts.slice(-2).join(".") : hostname;
}

const AD_DOMAINS = [
  "tiktok.com",
  "ttwstatic.com",
  "googlevideo.com",
  "youtube.com",
  "googlesyndication.com",
  "doubleclick.net",
  "amazon-adsystem.com",
  "adsystem.amazon.com",
];
const isAdDomain = (hostname) => AD_DOMAINS.some(d => registrableDomain(hostname).includes(d));

export function rewriteM3U8(content, baseUrl, proxyBase, extraHeaders) {
  const base = new URL(baseUrl);
  const encodedHeaders = extraHeaders ? encodeURIComponent(JSON.stringify(extraHeaders)) : "";

  return content
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) => {
          const absolute = new URL(uri, base).href;
          if (isAdDomain(new URL(absolute).hostname)) return `URI="${absolute}"`;
          const encoded = encodeURIComponent(absolute);
          const hParam = encodedHeaders ? `&headers=${encodedHeaders}` : "";
          return `URI="${proxyBase}/ts-proxy?url=${encoded}${hParam}"`;
        });
      }

      const absolute = new URL(trimmed, base).href;
      if (isAdDomain(new URL(absolute).hostname)) return absolute;

      const encoded = encodeURIComponent(absolute);
      const hParam = encodedHeaders ? `&headers=${encodedHeaders}` : "";

      if (absolute.includes(".m3u8") || absolute.includes(".m3u")) {
        return `${proxyBase}/proxy?url=${encoded}${hParam}`;
      }
      return `${proxyBase}/ts-proxy?url=${encoded}${hParam}`;
    })
    .join("\n");
}
