export const PORT = process.env.PORT || 8000;

export const ALLOWED_ORIGINS_EXACT = new Set([
  "https://cineparatodos.lat",
  "https://www.cineparatodos.lat",
  "https://vidtex.dev",
  "https://www.vidtex.dev",
  "https://metacatalog.tech",
  "https://cdn.cineparatodos.lat",
  "http://localhost:3000",
  "http://localhost:8000",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:8000",
]);

export const ALLOWED_ORIGIN_SUFFIXES = [
  ".b-cdn.net",
  ".vidtex.dev",
  ".cineparatodos.lat",
  ".metacatalog.tech",
];

export function isAllowedOrigin(origin) {
  if (!origin || typeof origin !== "string") return false;
  try {
    const u = new URL(origin);
    const host = u.hostname.toLowerCase();
    if (ALLOWED_ORIGINS_EXACT.has(origin.toLowerCase())) return true;
    return ALLOWED_ORIGIN_SUFFIXES.some(s => host === s.slice(1) || host.endsWith(s));
  } catch { return false; }
}

export function pickAllowedOrigin(reqOriginHeader) {
  if (!reqOriginHeader) return "*";
  if (isAllowedOrigin(reqOriginHeader)) return reqOriginHeader;
  try {
    const u = new URL(reqOriginHeader);
    const host = u.hostname.toLowerCase();
    if (ALLOWED_ORIGIN_SUFFIXES.some(s => host.endsWith(s))) return reqOriginHeader;
  } catch {}
  return "https://vidtex.dev";
}

export const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  Origin: "https://fmoviesunblocked.net",
  Referer: "https://fmoviesunblocked.net/",
};

export const TMDB_BEARER = "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiIyMjYwNmNlMmU2MTJkOGQyYzQyNzhmYWNhNDE5Y2VjMSIsIm5iZiI6MTc1ODk0Njk4NC4yOTcsInN1YiI6IjY4ZDc2NmE4NWFmYjU3ZjJjZTUyZmMzZCIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.-KoF5Nloah5nLAlONDasUwMb9OUS_LbawNd8mdRGNBg";

export const STREAM_TTL = 7 * 24 * 60 * 60 * 1000; // 7 días (persistido en disco, ver lib/cache.js)
export const SUB_TTL = 3 * 60 * 60 * 1000; // 3h
export const PROVIDER_TTL = 3 * 60 * 60 * 1000; // 3h

export const CC_MEDIA = "public, max-age=604800, s-maxage=604800, stale-while-revalidate=86400, stale-if-error=2592000";
export const CC_PLAYLIST = "public, max-age=60, s-maxage=60, stale-while-revalidate=300, stale-if-error=86400";
export const CC_SUBS = "public, max-age=3600, s-maxage=3600, stale-while-revalidate=14400, stale-if-error=86400";

// Workers / env wrappers
export const EDGE_PROXY_BASE = process.env.EDGE_PROXY_BASE?.replace(/\/$/, "") || null;
export const PROXY_CDN_BASE = process.env.PROXY_CDN_BASE?.replace(/\/$/, "") || null;
export const KAI_HTTP_PROXY = process.env.KAI_HTTP_PROXY;
export const KAI_CF_WORKER = process.env.KAI_CF_WORKER?.replace(/\/$/, "");
export const MIRURO_CF_WORKER = process.env.MIRURO_CF_WORKER?.replace(/\/$/, "");
export const MIRURO_API = process.env.MIRURO_API_URL || "http://localhost:8001";
export const API_KEY = process.env.API_KEY;

// Provider toggles: ENABLE_<PROVIDER>=false disables a provider (default enabled)
function parseEnvBool(value, defaultValue = true) {
  if (!value) return defaultValue;
  return !/^(0|false|no|off|disabled)$/i.test(value.trim());
}

export function isProviderEnabled(name) {
  const envKey = `ENABLE_${name.toUpperCase().replace(/-/g, "_")}`;
  if (process.env[envKey] !== undefined) return parseEnvBool(process.env[envKey]);
  const disabled = (process.env.DISABLED_PROVIDERS || "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
  return !disabled.includes(name.toLowerCase());
}
