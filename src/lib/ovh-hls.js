import crypto from "node:crypto";

const DEFAULT_INGEST_BASE_URL = "https://ingest.zenkai.live";
const DEFAULT_ORIGIN_URL = "https://origin.zenkai.live";
const DEFAULT_HLS_TTL_SECONDS = 21600;
const DEFAULT_TIMEOUT_MS = 3500;
const DEFAULT_RETRIES = 1;

function trimSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function getIngestBaseUrl() {
  return trimSlash(process.env.OVH_INGEST_BASE_URL || DEFAULT_INGEST_BASE_URL);
}

export function getOvhOriginUrl() {
  return trimSlash(process.env.OVH_ORIGIN_URL || DEFAULT_ORIGIN_URL);
}

export function getOvhHlsTtlSeconds() {
  const n = Number(process.env.OVH_HLS_URL_TTL_SECONDS || DEFAULT_HLS_TTL_SECONDS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_HLS_TTL_SECONDS;
}

export function isOvhSigningConfigured() {
  return Boolean(process.env.OVH_HLS_SIGNING_KEY);
}

export function isOvhIngestConfigured() {
  return Boolean(process.env.OVH_INGEST_KEY);
}

export function signOvhHlsUrl(slug, { ttlSeconds = getOvhHlsTtlSeconds(), nowSeconds = Math.floor(Date.now() / 1000), secret = process.env.OVH_HLS_SIGNING_KEY, originUrl = getOvhOriginUrl() } = {}) {
  if (!slug) throw new Error("slug OVH requerido");
  if (!secret) throw new Error("OVH_HLS_SIGNING_KEY no está configurado");
  const expiry = Math.floor(nowSeconds) + Math.floor(ttlSeconds);
  const token = crypto
    .createHash("md5")
    .update(`${expiry}/${slug} ${secret}`, "utf8")
    .digest("base64url");
  return `${trimSlash(originUrl)}/hls/${token}/${expiry}/${slug}/master.m3u8`;
}

function publicOvhUrl(pathOrUrl) {
  const value = String(pathOrUrl || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  const path = value.startsWith("/") ? value : `/${value}`;
  return `${getOvhOriginUrl()}${path}`;
}

function languageLabel(value) {
  const raw = String(value || "").toLowerCase();
  if (raw.startsWith("es-419") || raw.startsWith("es-mx")) return "Latino";
  if (raw.startsWith("es")) return "Español";
  if (raw.startsWith("en")) return "English";
  if (raw.startsWith("ja")) return "Japonés";
  if (raw.startsWith("pt-br")) return "Portugués (Brasil)";
  if (raw.startsWith("pt")) return "Portugués";
  return "";
}

function normalizeOvhSubtitle(raw) {
  if (!raw || typeof raw !== "object") return null;
  const url = publicOvhUrl(raw.url || raw.path);
  if (!url) return null;
  const filename = String(raw.filename || raw.path || url).split("/").pop() || "";
  const type = String(raw.type || filename.split(".").pop() || "vtt").toLowerCase();
  const lower = `${raw.label || ""} ${raw.language || ""} ${filename}`.toLowerCase();
  const cc = raw.cc === true || /\b(cc|sdh)\b|_cc(?:\.|$)/i.test(lower);
  const forced = raw.forced === true || /\bforced\b|foreign[\s_-]?only/i.test(lower);
  const signs = /\bsigns?\b|_signs(?:[_-]|\.|$)/i.test(lower);
  const baseLabel = raw.label || languageLabel(raw.language || raw.lang || raw.locale) || raw.language || filename || "Unknown";
  const label = raw.label || `${baseLabel}${cc && !/\bcc\b/i.test(baseLabel) ? " CC" : ""}${signs && !/\bsigns?\b/i.test(baseLabel) ? " Signs" : ""}`;
  return {
    url,
    label,
    lang: raw.lang || raw.language || raw.locale || "",
    type,
    kind: raw.kind || (cc ? "captions" : "subtitles"),
    default: !!raw.default,
    ai: !!raw.ai,
    cc,
    forced,
    ...(filename && { file: filename }),
    ...(signs && { signs: true }),
    ...(raw.available_fonts && { available_fonts: raw.available_fonts }),
    ...(raw.extracted_fonts && { extracted_fonts: raw.extracted_fonts }),
  };
}

function normalizeOvhThumbnails(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  for (const [variant, value] of Object.entries(raw)) {
    if (!value) continue;
    if (typeof value === "string") {
      out[variant] = { vttUrl: publicOvhUrl(value) };
      continue;
    }
    if (typeof value !== "object") continue;
    const vttUrl = publicOvhUrl(value.vtt || value.vttUrl || value.thumbnailVtt || value.url || value.path);
    const sprites = Array.isArray(value.sprites)
      ? value.sprites.map((s) => typeof s === "string" ? publicOvhUrl(s) : { ...s, url: publicOvhUrl(s?.url || s?.path) })
      : [];
    out[variant] = {
      ...value,
      ...(vttUrl && { vttUrl }),
      ...(sprites.length && { sprites }),
    };
  }
  return Object.keys(out).length ? out : null;
}

export function pickOvhThumbnailVtt(thumbnails, preferred = ["crunchy", "sub", "dub"]) {
  if (!thumbnails || typeof thumbnails !== "object") return null;
  for (const key of preferred) {
    const item = thumbnails[key];
    const url = typeof item === "string" ? publicOvhUrl(item) : publicOvhUrl(item?.vttUrl || item?.vtt || item?.thumbnailVtt || item?.url || item?.path);
    if (url) return url;
  }
  for (const item of Object.values(thumbnails)) {
    const url = typeof item === "string" ? publicOvhUrl(item) : publicOvhUrl(item?.vttUrl || item?.vtt || item?.thumbnailVtt || item?.url || item?.path);
    if (url) return url;
  }
  return null;
}

export function normalizeOvhEpisode(raw, fallback = {}) {
  if (!raw || typeof raw !== "object") return null;
  const slug = String(raw.slug || fallback.slug || "").trim();
  if (!slug) return null;
  const hls = raw.hls && typeof raw.hls === "object" ? raw.hls : {};
  const subtitles = Array.isArray(raw.subtitles) ? raw.subtitles.map(normalizeOvhSubtitle).filter(Boolean) : [];
  const thumbnails = normalizeOvhThumbnails(raw.thumbnails);
  return {
    slug,
    status: String(raw.status || fallback.status || "pending").toLowerCase(),
    provider: raw.provider || "zenkai",
    storageProvider: raw.storageProvider || "ovh",
    hls: {
      available: !!hls.available,
      master: hls.master || `${slug}/master.m3u8`,
      files: Array.isArray(hls.files) ? hls.files : [],
      playlists: Array.isArray(hls.playlists) ? hls.playlists : [],
      size_bytes: hls.size_bytes ?? raw.size_bytes ?? fallback.bytes ?? null,
    },
    subtitles,
    thumbnails,
    raw,
  };
}

export function isOvhEpisodePublished(episode) {
  return episode?.status === "published" && episode?.hls?.available === true;
}

function classifyOvhHttpError(status) {
  if (status === 404) return { temporary: true, message: "OVH episode not published yet" };
  if (status === 401 || status === 403) return { authError: true, message: `OVH auth HTTP ${status}` };
  if (status >= 500) return { temporary: true, message: `OVH HTTP ${status}` };
  return { temporary: false, message: `OVH HTTP ${status}` };
}

async function fetchJsonWithRetry(url, { method = "GET", body, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES } = {}) {
  if (!isOvhIngestConfigured()) {
    return { ok: false, statusCode: 0, authError: true, temporary: false, error: "OVH_INGEST_KEY no está configurado" };
  }
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Ingest-Key": process.env.OVH_INGEST_KEY,
        },
        ...(body != null && { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const info = classifyOvhHttpError(res.status);
        return { ok: false, statusCode: res.status, ...info, error: info.message };
      }
      return { ok: true, statusCode: res.status, data: await res.json() };
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (attempt >= retries) break;
    }
  }
  return {
    ok: false,
    statusCode: 0,
    temporary: true,
    error: lastError?.name === "AbortError" ? "OVH request timeout" : (lastError?.message || "OVH request failed"),
  };
}

export async function fetchOvhEpisode(slug, options = {}) {
  const url = `${getIngestBaseUrl()}/v1/episodes/${encodeURIComponent(slug)}`;
  const result = await fetchJsonWithRetry(url, options);
  if (!result.ok) return result;
  const episode = normalizeOvhEpisode(result.data, { slug });
  return { ...result, episode, published: isOvhEpisodePublished(episode) };
}

export async function lookupOvhEpisodes(slugs, options = {}) {
  const wanted = [...new Set((Array.isArray(slugs) ? slugs : []).map(String).filter(Boolean))].slice(0, 100);
  if (!wanted.length) return { ok: true, statusCode: 200, episodes: [], notFound: [] };
  const url = `${getIngestBaseUrl()}/v1/episodes/lookup`;
  const result = await fetchJsonWithRetry(url, { ...options, method: "POST", body: { slugs: wanted } });
  if (!result.ok) return result;
  const episodes = Array.isArray(result.data?.episodes)
    ? result.data.episodes.map((ep) => normalizeOvhEpisode(ep)).filter(Boolean)
    : [];
  const notFound = Array.isArray(result.data?.not_found) ? result.data.not_found : [];
  return { ...result, episodes, notFound };
}
