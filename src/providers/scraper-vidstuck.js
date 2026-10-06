import crypto from "node:crypto";

const BASE = "https://vidstuck.xyz";
const REFERER = `${BASE}/`;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const AES_KEY = "7f4c9e2a81d63b05c4f7a9e8126d3b50e1a8c7f23d9465ab0c6e9f1d4a7b832c";
const FETCH_TIMEOUT = 12000;
const CACHE_TTL_OK = 30 * 60 * 1000;
const CACHE_TTL_ERR = 5 * 60 * 1000;

const KEYS = {
  tmdbId: "a7f39c821d604e5b9c71f36e1547b",
  path: "6b491e7253ad84d392e7561a9384c",
  mediaType: "c285f91ab306d28147a35632e816b",
  ts: "61d9a5274c8e3b29afd6384c291e6",
  token: "c492f7a183d6502b1e7436c538a716d",
  title: "5e28c9147a306d1e829f3674b392a1",
  year: "b731e6c94f08269d725f8341c306e",
  date: "e164932c50216a39e5814b3027",
  season: "d8427b59ce30684a2f957c3613e85b",
  episode: "91c6e4a728503d1f785c92346b713d",
  latestDate: "e16932c543416ad739e5814b3027",
  imdbId: "f35a8c19d674b3265e871c4933a725f",
};

const SERVER_ALIASES = {
  orion: "orion",
  andromeda: "andromeda",
  centaurus: "centaurus",
  atlas: "atlas",
  ursa: "meow",
  meow: "meow",
};

const PRIORITY_SERVERS = (
  process.env.VIDSTUCK_PRIORITY_SERVERS || "orion,andromeda,centaurus,atlas,ursa"
)
  .split(",")
  .map((s) => SERVER_ALIASES[s.trim().toLowerCase()] ?? s.trim().toLowerCase())
  .filter(Boolean);

const cache = new Map();

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value, ttl) {
  cache.set(key, { value, expiresAt: Date.now() + ttl });
}

function buildHeaders(extra = {}) {
  return {
    "User-Agent": UA,
    Referer: REFERER,
    Origin: BASE,
    Accept: "application/json, text/plain, */*",
    ...extra,
  };
}

function decryptOpenSslBase64(cipherText, passphrase) {
  const input = Buffer.from(cipherText, "base64");
  if (input.subarray(0, 8).toString("utf8") !== "Salted__") {
    throw new Error("vidstuck: cipher payload inesperado");
  }
  const salt = input.subarray(8, 16);
  const data = input.subarray(16);

  let derived = Buffer.alloc(0);
  let prev = Buffer.alloc(0);
  while (derived.length < 48) {
    prev = crypto.createHash("md5").update(Buffer.concat([prev, Buffer.from(passphrase, "utf8"), salt])).digest();
    derived = Buffer.concat([derived, prev]);
  }

  const key = derived.subarray(0, 32);
  const iv = derived.subarray(32, 48);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`vidstuck: HTTP ${response.status} ${url}\n${text.slice(0, 200)}`);
  }
  return JSON.parse(text);
}

function buildSessionPayload({ tmdbId, mediaType, server, season, episode }) {
  return {
    [KEYS.tmdbId]: String(tmdbId),
    [KEYS.mediaType]: mediaType,
    [KEYS.path]: server,
    ...(mediaType === "tv"
      ? {
          [KEYS.season]: String(season),
          [KEYS.episode]: String(episode),
        }
      : {}),
  };
}

async function getSessionBits(opts) {
  return fetchJson(`${BASE}/backend/fuckoffniggawtf`, {
    method: "POST",
    headers: {
      ...buildHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildSessionPayload(opts)),
  });
}

function buildServersUrl(opts, session, server) {
  const params = new URLSearchParams({
    [KEYS.tmdbId]: String(opts.tmdbId),
    [KEYS.path]: server,
    [KEYS.mediaType]: opts.mediaType,
    [KEYS.ts]: String(session.ts),
    [KEYS.token]: session.token,
    [KEYS.title]: opts.title,
    [KEYS.year]: String(opts.year),
    [KEYS.date]: opts.date,
  });

  if (opts.mediaType === "tv") {
    params.set(KEYS.season, String(opts.season));
    params.set(KEYS.episode, String(opts.episode));
    if (opts.latestDate) params.set(KEYS.latestDate, opts.latestDate);
  }
  if (opts.imdbId) params.set(KEYS.imdbId, opts.imdbId);

  return `${BASE}/backend/servers/${server}?${params.toString()}`;
}

function detectStreamType(url, contentType, body) {
  const lowerCt = String(contentType || "").toLowerCase();
  const lowerUrl = String(url || "").toLowerCase();
  if (/<MPD[\s>]/i.test(body) || lowerCt.includes("dash") || lowerUrl.includes(".mpd")) return "dash";
  if (/^#EXTM3U/m.test(body) || lowerCt.includes("mpegurl") || lowerUrl.includes(".m3u8")) return "hls";
  if (lowerCt.startsWith("video/mp4") || lowerUrl.includes(".mp4")) return "mp4";
  return null;
}

function rankLink(link) {
  const typeRank = link.type === "dash" ? 0 : link.type === "hls" ? 1 : 2;
  const resolution = Number(link.resolution) || 0;
  return typeRank * 100000 - resolution;
}

async function resolvePlaybackFromLink(link) {
  const candidateUrl = link.decrypted.startsWith("http") ? link.decrypted : `${BASE}${link.decrypted}`;
  const directType = String(link.type || "").toLowerCase();

  // Algunos títulos no pasan por /backend/database ni devuelven manifest.
  // El frontend usa directamente URLs externas tipo /media/mp4?url=...&header=...
  // y esa es la URL real que tenemos que propagar.
  if (directType === "mp4") {
    return {
      url: candidateUrl,
      type: "mp4",
      quality: Number(link.resolution) > 0 ? `${link.resolution}p` : "auto",
    };
  }

  const response = await fetch(candidateUrl, {
    headers: buildHeaders({ Accept: "application/dash+xml, application/vnd.apple.mpegurl, text/plain, */*" }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`vidstuck: manifest HTTP ${response.status}`);
  }

  const type = detectStreamType(response.url, response.headers.get("content-type"), body);
  if (!type) {
    throw new Error("vidstuck: respuesta final no parece manifest");
  }

  return {
    // Para la API queremos exponer la URL real que entrega vidstuck
    // (/backend/database/... o /edge?...), no una URL derivada posterior.
    url: candidateUrl,
    type,
    quality: Number(link.resolution) > 0 ? `${link.resolution}p` : "auto",
  };
}

async function resolveServer(opts, server) {
  const session = await getSessionBits({ ...opts, server });
  const payload = await fetchJson(buildServersUrl(opts, session, server), {
    headers: buildHeaders(),
  });

  const decryptedLinks = (payload.links ?? [])
    .map((entry) => ({
      ...entry,
      decrypted: decryptOpenSslBase64(entry.link, AES_KEY),
    }))
    .sort((a, b) => rankLink(a) - rankLink(b));

  let lastError = null;
  for (const link of decryptedLinks) {
    try {
      const manifest = await resolvePlaybackFromLink(link);
      return {
        url: manifest.url,
        type: manifest.type,
        quality: manifest.quality,
        provider: `vidstuck/${server}`,
        referer: REFERER,
        server,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("vidstuck: sin links válidos");
}

export async function getVidstuckStream({
  tmdbId,
  mediaType,
  title,
  year,
  date,
  latestDate,
  imdbId,
  season,
  episode,
}) {
  if (!tmdbId || !title || !year || !date) return null;

  const type = mediaType === "tv" ? "tv" : "movie";
  const cacheKey = type === "tv"
    ? `vidstuck:tv:${tmdbId}:${season}:${episode}`
    : `vidstuck:movie:${tmdbId}`;

  const cached = cacheGet(cacheKey);
  if (cached !== null) return cached;

  const opts = {
    tmdbId,
    mediaType: type,
    title,
    year,
    date,
    latestDate,
    imdbId,
    season,
    episode,
  };

  try {
    for (const server of PRIORITY_SERVERS) {
      try {
        const result = await resolveServer(opts, server);
        console.log(`[vidstuck] ${cacheKey}: ${result.provider} -> ${result.type}`);
        cacheSet(cacheKey, result, CACHE_TTL_OK);
        return result;
      } catch (error) {
        console.warn(`[vidstuck] ${cacheKey} ${server}: ${error.message}`);
      }
    }
    throw new Error("vidstuck: ningún server resolvió manifest real");
  } catch (error) {
    cacheSet(cacheKey, null, CACHE_TTL_ERR);
    return null;
  }
}
