import {
  cacheDeleteAnimeResponseCache,
  getOvhArchive,
  getOvhArchiveBySlug,
  listDueOvhArchives,
  upsertOvhArchive,
} from "./cache.js";
import { fetchOvhAudioTracks, fetchOvhEpisode, isOvhEpisodePublished } from "./ovh-hls.js";
import { log } from "./logger.js";

const SYNC_INTERVAL_MS = Number(process.env.OVH_SYNC_INTERVAL_MS || 30_000);
const SYNC_CONCURRENCY = Math.max(1, Number(process.env.OVH_SYNC_CONCURRENCY || 2));
const INITIAL_BACKOFF_MS = Number(process.env.OVH_SYNC_INITIAL_BACKOFF_MS || 30_000);
const MAX_BACKOFF_MS = Number(process.env.OVH_SYNC_MAX_BACKOFF_MS || 30 * 60 * 1000);
const REGISTER_SYNC_TIMEOUT_MS = Number(process.env.OVH_REGISTER_SYNC_TIMEOUT_MS || 2500);
const WORKER_SYNC_TIMEOUT_MS = Number(process.env.OVH_WORKER_SYNC_TIMEOUT_MS || 3500);
const DISCOVERY_TIMEOUT_MS = Number(process.env.OVH_DISCOVERY_TIMEOUT_MS || REGISTER_SYNC_TIMEOUT_MS);

const inFlight = new Set();
let timer = null;

export function computeOvhBackoffMs(attempts = 0) {
  const exponent = Math.min(Math.max(Number(attempts) || 0, 0), 8);
  return Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * (2 ** exponent));
}

function archiveTracksFromRecord(record, fallbackAudioTracks = []) {
  return {
    audioTracks: Array.isArray(record?.audioTracks) && record.audioTracks.length ? record.audioTracks : fallbackAudioTracks,
    subtitleTracks: Array.isArray(record?.subtitleTracks) ? record.subtitleTracks : [],
  };
}

function publishedFieldsFromEpisode(episode, record, fallbackAudioTracks = []) {
  const hlsBytes = episode?.hls?.size_bytes ?? null;
  return {
    animeId: record.animeId,
    episode: record.episode,
    lang: record.lang || "MULTI",
    slug: record.slug,
    sourceProvider: record.sourceProvider || "crunchyroll-downloader",
    bytes: hlsBytes ?? record.bytes ?? null,
    status: "published",
    hlsStatus: "published",
    assetsStatus: "published",
    skipIntro: record.skipIntro ?? null,
    skipOutro: record.skipOutro ?? null,
    tracks: archiveTracksFromRecord(record, fallbackAudioTracks),
    subtitles: episode?.subtitles ?? [],
    thumbnails: episode?.thumbnails ?? null,
    hls: episode?.hls ?? null,
    raw: episode?.raw ?? null,
    lastSyncedAt: Date.now(),
    nextSyncAt: null,
    syncAttempts: 0,
    lastError: null,
  };
}

function pendingFieldsFromRecord(record, { attempts, error, nextSyncAt }) {
  return {
    animeId: record.animeId,
    episode: record.episode,
    lang: record.lang || "MULTI",
    slug: record.slug,
    sourceProvider: record.sourceProvider || "crunchyroll-downloader",
    bytes: record.bytes ?? null,
    status: "pending",
    hlsStatus: record.hlsStatus || "pending",
    assetsStatus: record.assetsStatus || "pending",
    skipIntro: record.skipIntro ?? null,
    skipOutro: record.skipOutro ?? null,
    tracks: archiveTracksFromRecord(record),
    subtitles: record.subtitles ?? null,
    thumbnails: record.thumbnails ?? null,
    hls: record.hls ?? null,
    raw: record.raw ?? null,
    lastSyncedAt: Date.now(),
    nextSyncAt,
    syncAttempts: attempts,
    lastError: error,
  };
}

export async function syncOvhArchive(recordOrSlug, { timeoutMs = WORKER_SYNC_TIMEOUT_MS, retries = 1 } = {}) {
  const record = typeof recordOrSlug === "string" ? getOvhArchiveBySlug(recordOrSlug) : recordOrSlug;
  if (!record?.slug) return { ok: false, status: "missing", error: "Registro OVH inexistente" };
  if (inFlight.has(record.slug)) return { ok: true, status: "inflight", slug: record.slug };
  inFlight.add(record.slug);
  try {
    const result = await fetchOvhEpisode(record.slug, { timeoutMs, retries });
    if (result.ok && isOvhEpisodePublished(result.episode)) {
      const inferredAudioTracks = Array.isArray(record.audioTracks) && record.audioTracks.length
        ? []
        : await fetchOvhAudioTracks(record.slug, { timeoutMs });
      upsertOvhArchive(publishedFieldsFromEpisode(result.episode, record, inferredAudioTracks));
      cacheDeleteAnimeResponseCache(record.animeId, record.episode);
      log.info(`[ovh ${record.animeId}/${record.episode}] ✅ published slug=${record.slug}`);
      return { ok: true, status: "published", slug: record.slug, episode: result.episode };
    }

    const attempts = (record.syncAttempts ?? 0) + 1;
    const nextSyncAt = Date.now() + computeOvhBackoffMs(attempts);
    const error = result.error || (result.ok ? "OVH episode pending" : "OVH sync failed");
    upsertOvhArchive(pendingFieldsFromRecord(record, { attempts, error, nextSyncAt }));
    return {
      ok: true,
      status: "pending",
      slug: record.slug,
      temporary: result.temporary !== false,
      authError: !!result.authError,
      nextSyncAt,
      error,
    };
  } finally {
    inFlight.delete(record.slug);
  }
}

export async function syncDueOvhArchives({ limit = SYNC_CONCURRENCY } = {}) {
  const due = listDueOvhArchives({ limit });
  if (!due.length) return { checked: 0, published: 0, pending: 0 };
  const results = await Promise.all(due.map((record) => syncOvhArchive(record)));
  return {
    checked: results.length,
    published: results.filter((r) => r.status === "published").length,
    pending: results.filter((r) => r.status === "pending").length,
  };
}

export async function registerAndMaybeSyncOvhArchive(record) {
  upsertOvhArchive({
    ...record,
    status: "pending",
    hlsStatus: record.hlsStatus || "pending",
    assetsStatus: record.assetsStatus || "pending",
    nextSyncAt: Date.now() + computeOvhBackoffMs(0),
    syncAttempts: 0,
    lastError: null,
  });
  cacheDeleteAnimeResponseCache(record.animeId, record.episode);
  return syncOvhArchive(record, { timeoutMs: REGISTER_SYNC_TIMEOUT_MS, retries: 0 });
}

export function buildOvhArchiveSlug(animeId, episode) {
  return `${animeId}-${episode}-multi`;
}

export async function discoverOvhArchiveForEpisode(animeId, episode, { timeoutMs = DISCOVERY_TIMEOUT_MS, retries = 0, force = false } = {}) {
  const slug = buildOvhArchiveSlug(animeId, episode);
  const existing = getOvhArchiveBySlug(slug) || getOvhArchive(animeId, episode, { publishedOnly: false }).MULTI;
  if (existing?.status === "published") {
    if (force || !Array.isArray(existing.audioTracks) || !existing.audioTracks.length) {
      return syncOvhArchive(existing, { timeoutMs, retries });
    }
    return { ok: true, status: "published", slug, archive: existing, discovered: false };
  }
  if (existing && !force) {
    const nextSyncAt = Number(existing.nextSyncAt || 0);
    if (nextSyncAt > Date.now()) {
      return { ok: true, status: existing.status || "pending", slug, archive: existing, skipped: true, nextSyncAt };
    }
    return syncOvhArchive(existing, { timeoutMs, retries });
  }
  return syncOvhArchive({
    animeId,
    episode,
    lang: "MULTI",
    slug,
    sourceProvider: "ovh-discovery",
    status: "pending",
    hlsStatus: "pending",
    assetsStatus: "pending",
  }, { timeoutMs, retries });
}

export function startOvhSyncWorker() {
  if (timer) return;
  timer = setInterval(() => {
    syncDueOvhArchives().catch((error) => log.warn(`[ovh] ⚠️ sync worker error: ${error.message}`));
  }, SYNC_INTERVAL_MS);
  timer.unref?.();
  syncDueOvhArchives().catch((error) => log.warn(`[ovh] ⚠️ startup sync error: ${error.message}`));
}
