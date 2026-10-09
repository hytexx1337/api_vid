import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const cache = new Map();

// ── Persistencia en disco (node:sqlite) ──────────────────────────────────────
// Solo las claves "streams:*" (movie/tv/anime) se persisten: son las que valen
// la pena sobrevivir a un reinicio de pm2, ya que las URLs upstream de los
// providers (AnimeAV1, Miruro, Cuevana, etc) suelen seguir siendo válidas por
// varios días/semanas. El resto de caches (metadata, tmdb, mal ids, etc) son
// baratas de recalcular y no necesitan disco.
const PERSIST_PREFIXES = ["streams:", "reanime:streams:"];
let db = null;

function shouldPersistKey(key) {
  return PERSIST_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function initDb() {
  try {
    const { DatabaseSync } = require("node:sqlite");
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
    const dbPath = process.env.STREAM_CACHE_DB_PATH || path.join(dir, "stream-cache.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const dbInstance = new DatabaseSync(dbPath);
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS stream_cache (
        cache_key TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_verified_at INTEGER NOT NULL
      );
    `);
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS r2_archive (
        anime_id TEXT NOT NULL,
        episode TEXT NOT NULL,
        lang TEXT NOT NULL,
        slug TEXT NOT NULL,
        source_provider TEXT,
        bytes INTEGER,
        archived_at INTEGER NOT NULL,
        PRIMARY KEY (anime_id, episode, lang)
      );
    `);
    // Migración: columnas de skip intro/outro (segundos, NULL = sin skip).
    // ALTER TABLE no soporta IF NOT EXISTS, así que se ignora el error de
    // "duplicate column name" en bases que ya tienen las columnas.
    for (const col of ["skip_intro_start", "skip_intro_end", "skip_outro_start", "skip_outro_end"]) {
      try { dbInstance.exec(`ALTER TABLE r2_archive ADD COLUMN ${col} REAL`); } catch { /* ya existe */ }
    }
    try { dbInstance.exec(`ALTER TABLE r2_archive ADD COLUMN tracks_json TEXT`); } catch { /* ya existe */ }
    // Subtítulos subidos manualmente (panel r2-panel en VPS externo).
    // file es el nombre del objeto en R2 bajo subs/ (ej: "manual-abc123.vtt").
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS manual_tracks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        anime_id TEXT NOT NULL,
        episode TEXT NOT NULL,
        lang TEXT NOT NULL,
        label TEXT NOT NULL,
        file TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'subtitles',
        created_at INTEGER NOT NULL,
        UNIQUE (anime_id, episode, file)
      );
    `);
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS episode_thumbnails (
        anime_id TEXT NOT NULL,
        episode TEXT NOT NULL,
        variant TEXT NOT NULL,
        vtt_key TEXT NOT NULL,
        source_provider TEXT,
        archived_at INTEGER NOT NULL,
        PRIMARY KEY (anime_id, episode, variant)
      );
    `);
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS ovh_archive (
        anime_id TEXT NOT NULL,
        episode TEXT NOT NULL,
        lang TEXT NOT NULL DEFAULT 'MULTI',
        slug TEXT NOT NULL,
        source_provider TEXT,
        bytes INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        hls_status TEXT,
        assets_status TEXT,
        registered_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_synced_at INTEGER,
        next_sync_at INTEGER,
        sync_attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        skip_intro_start REAL,
        skip_intro_end REAL,
        skip_outro_start REAL,
        skip_outro_end REAL,
        tracks_json TEXT,
        subtitles_json TEXT,
        thumbnails_json TEXT,
        hls_json TEXT,
        raw_json TEXT,
        PRIMARY KEY (anime_id, episode, lang)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ovh_archive_slug ON ovh_archive(slug);
      CREATE INDEX IF NOT EXISTS idx_ovh_archive_sync ON ovh_archive(status, next_sync_at);
    `);
    return dbInstance;
  } catch (e) {
    console.warn("[cache] node:sqlite no disponible, cache persistente deshabilitada:", e.message);
    return null;
  }
}

db = initDb();

function persistSet(key, value, expiresAt) {
  if (!db || !shouldPersistKey(key)) return;
  try {
    const now = Date.now();
    db.prepare(`
      INSERT INTO stream_cache (cache_key, payload, created_at, expires_at, last_verified_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        payload = excluded.payload,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at,
        last_verified_at = excluded.last_verified_at
    `).run(key, JSON.stringify(value), now, expiresAt, now);
  } catch (e) {
    console.warn("[cache] persistSet error:", e.message);
  }
}

function persistGet(key) {
  if (!db || !shouldPersistKey(key)) return null;
  try {
    const row = db.prepare(`SELECT payload, expires_at FROM stream_cache WHERE cache_key = ?`).get(key);
    if (!row) return null;
    if (Date.now() > row.expires_at) {
      db.prepare(`DELETE FROM stream_cache WHERE cache_key = ?`).run(key);
      return null;
    }
    return { value: JSON.parse(row.payload), expiresAt: row.expires_at };
  } catch (e) {
    console.warn("[cache] persistGet error:", e.message);
    return null;
  }
}

export function cacheGet(key) {
  const entry = cache.get(key);
  if (entry) {
    if (Date.now() > entry.expiresAt) { cache.delete(key); }
    else return entry.value;
  }
  const persisted = persistGet(key);
  if (persisted) {
    cache.set(key, persisted);
    return persisted.value;
  }
  return null;
}

export function cacheSet(key, value, ttlMs) {
  const expiresAt = Date.now() + ttlMs;
  cache.set(key, { value, expiresAt });
  persistSet(key, value, expiresAt);
}

export function cacheDelete(key) {
  cache.delete(key);
  if (db) {
    try { db.prepare(`DELETE FROM stream_cache WHERE cache_key = ?`).run(key); } catch {}
  }
}

export function cacheFlushAll() {
  const memBefore = cache.size;
  cache.clear();
  let diskBefore = 0;
  if (db) {
    try {
      const beforeRow = db.prepare(`SELECT COUNT(*) AS c FROM stream_cache`).get();
      diskBefore = beforeRow?.c ?? 0;
      db.prepare(`DELETE FROM stream_cache`).run();
    } catch (e) {
      console.warn("[cache] cacheFlushAll disk error:", e.message);
    }
  }
  console.log(`[cache] flush-all: memoria=${memBefore} items borrados, disco=${diskBefore} rows borradas (streams: + reanime:)`);
  return { memCleared: memBefore, diskCleared: diskBefore };
}

export function cacheDeleteAnimeResponseCache(animeId, episode) {
  const marker = `:${animeId}:${episode}:`;
  let deleted = 0;
  for (const key of cache.keys()) {
    if (key.startsWith("resp:streams:anime:") && key.includes(marker)) {
      cache.delete(key);
      deleted++;
    }
  }
  return deleted;
}

// Devuelve todas las cache_key persistidas que empiezan con el prefijo dado
// (usado por el verificador diario de streams).
export function listPersistedKeys(prefix) {
  if (!db) return [];
  try {
    return db.prepare(`SELECT cache_key FROM stream_cache WHERE cache_key LIKE ?`)
      .all(`${prefix}%`)
      .map(r => r.cache_key);
  } catch (e) {
    console.warn("[cache] listPersistedKeys error:", e.message);
    return [];
  }
}

export function touchVerified(key) {
  if (!db) return;
  try { db.prepare(`UPDATE stream_cache SET last_verified_at = ? WHERE cache_key = ?`).run(Date.now(), key); } catch {}
}

// Invalidación reactiva: cuando el proxy detecta que una URL upstream ya no
// responde (403/404), busca qué entradas cacheadas la contienen y las borra
// para forzar un re-scrape fresco en el próximo pedido. Usamos LIKE sobre el
// payload en vez de traer todo a JS porque las entradas pueden ser miles.
export function invalidateStreamsContainingUrl(url) {
  if (!db || !url) return 0;
  try {
    const escaped = url.replace(/[\\%_]/g, (c) => `\\${c}`);
    const rows = db.prepare(
      `SELECT cache_key FROM stream_cache WHERE cache_key LIKE 'streams:%' AND payload LIKE ? ESCAPE '\\'`
    ).all(`%${escaped}%`);
    if (!rows.length) return 0;
    const del = db.prepare(`DELETE FROM stream_cache WHERE cache_key = ?`);
    for (const row of rows) { del.run(row.cache_key); cache.delete(row.cache_key); }
    console.log(`[cache] invalidadas ${rows.length} entrada(s) por URL muerta: ${url.slice(0, 100)}`);
    return rows.length;
  } catch (e) {
    console.warn("[cache] invalidateStreamsContainingUrl error:", e.message);
    return 0;
  }
}

// ── Archivos R2 (streams archivados de forma permanente) ────────────────────
// slug es el prefijo de carpeta en R2 (ej: "21202-3-esp-lat"), donde vive
// `${slug}/master.m3u8` + segmentos. No tiene TTL: el objeto queda ahí hasta
// que se borre a mano o se reemplace.
// skipIntro/skipOutro: [start, end] en segundos, o null/undefined si no hay.
function normalizeR2Tracks(tracks) {
  if (!tracks || typeof tracks !== "object") return null;
  const audioTracks = Array.isArray(tracks.audioTracks) ? tracks.audioTracks : [];
  const subtitleTracks = Array.isArray(tracks.subtitleTracks) ? tracks.subtitleTracks : [];
  if (!audioTracks.length && !subtitleTracks.length) return null;
  return { audioTracks, subtitleTracks };
}

function parseR2Tracks(raw) {
  if (!raw) return null;
  try {
    return normalizeR2Tracks(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function upsertR2Archive({ animeId, episode, lang, slug, sourceProvider, bytes, skipIntro, skipOutro, tracks }) {
  if (!db) return false;
  try {
    const [iStart, iEnd] = Array.isArray(skipIntro) ? skipIntro : [null, null];
    const [oStart, oEnd] = Array.isArray(skipOutro) ? skipOutro : [null, null];
    const tracksJson = normalizeR2Tracks(tracks) ? JSON.stringify(normalizeR2Tracks(tracks)) : null;
    db.prepare(`
      INSERT INTO r2_archive (anime_id, episode, lang, slug, source_provider, bytes, archived_at, skip_intro_start, skip_intro_end, skip_outro_start, skip_outro_end, tracks_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(anime_id, episode, lang) DO UPDATE SET
        slug = excluded.slug,
        source_provider = excluded.source_provider,
        bytes = excluded.bytes,
        archived_at = excluded.archived_at,
        skip_intro_start = excluded.skip_intro_start,
        skip_intro_end = excluded.skip_intro_end,
        skip_outro_start = excluded.skip_outro_start,
        skip_outro_end = excluded.skip_outro_end,
        tracks_json = COALESCE(excluded.tracks_json, r2_archive.tracks_json)
    `).run(String(animeId), String(episode), lang, slug, sourceProvider ?? null, bytes ?? null, Date.now(), iStart ?? null, iEnd ?? null, oStart ?? null, oEnd ?? null, tracksJson);
    return true;
  } catch (e) {
    console.warn("[cache] upsertR2Archive error:", e.message);
    return false;
  }
}

// Devuelve un mapa { lang: { slug, sourceProvider, bytes, archivedAt } } para
// un anime/episodio dado.
export function getR2Archive(animeId, episode) {
  if (!db) return {};
  try {
    const rows = db.prepare(
      `SELECT lang, slug, source_provider, bytes, archived_at, skip_intro_start, skip_intro_end, skip_outro_start, skip_outro_end, tracks_json FROM r2_archive WHERE anime_id = ? AND episode = ?`
    ).all(String(animeId), String(episode));
    const out = {};
    for (const r of rows) {
      const tracks = parseR2Tracks(r.tracks_json);
      out[r.lang] = {
        slug: r.slug, sourceProvider: r.source_provider, bytes: r.bytes, archivedAt: r.archived_at,
        skipIntro: r.skip_intro_start != null ? [r.skip_intro_start, r.skip_intro_end] : null,
        skipOutro: r.skip_outro_start != null ? [r.skip_outro_start, r.skip_outro_end] : null,
        ...(tracks?.audioTracks?.length && { audioTracks: tracks.audioTracks }),
        ...(tracks?.subtitleTracks?.length && { subtitleTracks: tracks.subtitleTracks }),
      };
    }
    return out;
  } catch (e) {
    console.warn("[cache] getR2Archive error:", e.message);
    return {};
  }
}

// Devuelve TODAS las filas de r2_archive (para export/migración entre entornos).
export function listAllR2Archive() {
  if (!db) return [];
  try {
    return db.prepare(
      `SELECT anime_id, episode, lang, slug, source_provider, bytes, archived_at, skip_intro_start, skip_intro_end, skip_outro_start, skip_outro_end, tracks_json FROM r2_archive`
    ).all();
  } catch (e) {
    console.warn("[cache] listAllR2Archive error:", e.message);
    return [];
  }
}

export function deleteR2Archive(animeId, episode, lang) {
  if (!db) return;
  try {
    if (lang) db.prepare(`DELETE FROM r2_archive WHERE anime_id = ? AND episode = ? AND lang = ?`).run(String(animeId), String(episode), lang);
    else db.prepare(`DELETE FROM r2_archive WHERE anime_id = ? AND episode = ?`).run(String(animeId), String(episode));
  } catch (e) {
    console.warn("[cache] deleteR2Archive error:", e.message);
  }
}

function safeJsonStringify(value) {
  if (value == null) return null;
  try { return JSON.stringify(value); }
  catch { return null; }
}

function safeJsonParse(raw, fallback = null) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); }
  catch { return fallback; }
}

function normalizeOvhStatus(status) {
  const s = String(status || "pending").trim().toLowerCase();
  if (s === "published") return "published";
  if (s === "failed") return "failed";
  return "pending";
}

function normalizeOvhArchiveRow(row) {
  if (!row) return null;
  const tracks = parseR2Tracks(row.tracks_json);
  return {
    animeId: row.anime_id,
    episode: row.episode,
    lang: row.lang,
    slug: row.slug,
    sourceProvider: row.source_provider,
    bytes: row.bytes,
    status: row.status,
    hlsStatus: row.hls_status,
    assetsStatus: row.assets_status,
    registeredAt: row.registered_at,
    updatedAt: row.updated_at,
    lastSyncedAt: row.last_synced_at,
    nextSyncAt: row.next_sync_at,
    syncAttempts: row.sync_attempts ?? 0,
    lastError: row.last_error,
    skipIntro: row.skip_intro_start != null ? [row.skip_intro_start, row.skip_intro_end] : null,
    skipOutro: row.skip_outro_start != null ? [row.skip_outro_start, row.skip_outro_end] : null,
    ...(tracks?.audioTracks?.length && { audioTracks: tracks.audioTracks }),
    ...(tracks?.subtitleTracks?.length && { subtitleTracks: tracks.subtitleTracks }),
    subtitles: safeJsonParse(row.subtitles_json, []),
    thumbnails: safeJsonParse(row.thumbnails_json, null),
    hls: safeJsonParse(row.hls_json, null),
    raw: safeJsonParse(row.raw_json, null),
  };
}

export function upsertOvhArchive({
  animeId,
  episode,
  lang = "MULTI",
  slug,
  sourceProvider,
  bytes,
  status = "pending",
  hlsStatus = null,
  assetsStatus = null,
  skipIntro,
  skipOutro,
  tracks,
  subtitles = null,
  thumbnails = null,
  hls = null,
  raw = null,
  lastSyncedAt = null,
  nextSyncAt = null,
  syncAttempts = null,
  lastError = null,
}) {
  if (!db || !animeId || !episode || !lang || !slug) return false;
  try {
    const now = Date.now();
    const [iStart, iEnd] = Array.isArray(skipIntro) ? skipIntro : [null, null];
    const [oStart, oEnd] = Array.isArray(skipOutro) ? skipOutro : [null, null];
    const tracksJson = normalizeR2Tracks(tracks) ? JSON.stringify(normalizeR2Tracks(tracks)) : null;
    db.prepare(`
      INSERT INTO ovh_archive (
        anime_id, episode, lang, slug, source_provider, bytes, status, hls_status, assets_status,
        registered_at, updated_at, last_synced_at, next_sync_at, sync_attempts, last_error,
        skip_intro_start, skip_intro_end, skip_outro_start, skip_outro_end,
        tracks_json, subtitles_json, thumbnails_json, hls_json, raw_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(anime_id, episode, lang) DO UPDATE SET
        slug = excluded.slug,
        source_provider = COALESCE(excluded.source_provider, ovh_archive.source_provider),
        bytes = COALESCE(excluded.bytes, ovh_archive.bytes),
        status = excluded.status,
        hls_status = COALESCE(excluded.hls_status, ovh_archive.hls_status),
        assets_status = COALESCE(excluded.assets_status, ovh_archive.assets_status),
        updated_at = excluded.updated_at,
        last_synced_at = COALESCE(excluded.last_synced_at, ovh_archive.last_synced_at),
        next_sync_at = excluded.next_sync_at,
        sync_attempts = COALESCE(excluded.sync_attempts, ovh_archive.sync_attempts),
        last_error = excluded.last_error,
        skip_intro_start = COALESCE(excluded.skip_intro_start, ovh_archive.skip_intro_start),
        skip_intro_end = COALESCE(excluded.skip_intro_end, ovh_archive.skip_intro_end),
        skip_outro_start = COALESCE(excluded.skip_outro_start, ovh_archive.skip_outro_start),
        skip_outro_end = COALESCE(excluded.skip_outro_end, ovh_archive.skip_outro_end),
        tracks_json = COALESCE(excluded.tracks_json, ovh_archive.tracks_json),
        subtitles_json = COALESCE(excluded.subtitles_json, ovh_archive.subtitles_json),
        thumbnails_json = COALESCE(excluded.thumbnails_json, ovh_archive.thumbnails_json),
        hls_json = COALESCE(excluded.hls_json, ovh_archive.hls_json),
        raw_json = COALESCE(excluded.raw_json, ovh_archive.raw_json)
    `).run(
      String(animeId), String(episode), String(lang).toUpperCase(), String(slug),
      sourceProvider ?? null, bytes ?? null, normalizeOvhStatus(status), hlsStatus ?? null, assetsStatus ?? null,
      now, now, lastSyncedAt ?? null, nextSyncAt ?? null, syncAttempts ?? 0, lastError ?? null,
      iStart ?? null, iEnd ?? null, oStart ?? null, oEnd ?? null,
      tracksJson, safeJsonStringify(subtitles), safeJsonStringify(thumbnails),
      safeJsonStringify(hls), safeJsonStringify(raw)
    );
    return true;
  } catch (e) {
    console.warn("[cache] upsertOvhArchive error:", e.message);
    return false;
  }
}

export function getOvhArchive(animeId, episode, { publishedOnly = true } = {}) {
  if (!db) return {};
  try {
    const rows = db.prepare(`
      SELECT * FROM ovh_archive
      WHERE anime_id = ? AND episode = ? ${publishedOnly ? "AND status = 'published'" : ""}
    `).all(String(animeId), String(episode));
    const out = {};
    for (const row of rows) out[row.lang] = normalizeOvhArchiveRow(row);
    return out;
  } catch (e) {
    console.warn("[cache] getOvhArchive error:", e.message);
    return {};
  }
}

export function getOvhArchiveBySlug(slug) {
  if (!db || !slug) return null;
  try {
    return normalizeOvhArchiveRow(db.prepare(`SELECT * FROM ovh_archive WHERE slug = ?`).get(String(slug)));
  } catch (e) {
    console.warn("[cache] getOvhArchiveBySlug error:", e.message);
    return null;
  }
}

export function listAllOvhArchive() {
  if (!db) return [];
  try {
    return db.prepare(`SELECT * FROM ovh_archive ORDER BY updated_at DESC`).all().map(normalizeOvhArchiveRow);
  } catch (e) {
    console.warn("[cache] listAllOvhArchive error:", e.message);
    return [];
  }
}

export function listDueOvhArchives({ now = Date.now(), limit = 5 } = {}) {
  if (!db) return [];
  try {
    return db.prepare(`
      SELECT * FROM ovh_archive
      WHERE status != 'published' AND (next_sync_at IS NULL OR next_sync_at <= ?)
      ORDER BY COALESCE(next_sync_at, 0), updated_at
      LIMIT ?
    `).all(now, limit).map(normalizeOvhArchiveRow);
  } catch (e) {
    console.warn("[cache] listDueOvhArchives error:", e.message);
    return [];
  }
}

export function deleteOvhArchive(animeId, episode, lang = "MULTI") {
  if (!db) return 0;
  try {
    const result = db.prepare(`DELETE FROM ovh_archive WHERE anime_id = ? AND episode = ? AND lang = ?`)
      .run(String(animeId), String(episode), String(lang).toUpperCase());
    return result.changes ?? 0;
  } catch (e) {
    console.warn("[cache] deleteOvhArchive error:", e.message);
    return 0;
  }
}

export function upsertEpisodeThumbnail({ animeId, episode, variant, vttKey, sourceProvider = null }) {
  if (!db || !animeId || !episode || !variant || !vttKey) return false;
  try {
    db.prepare(`
      INSERT INTO episode_thumbnails (anime_id, episode, variant, vtt_key, source_provider, archived_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(anime_id, episode, variant) DO UPDATE SET
        vtt_key = excluded.vtt_key,
        source_provider = excluded.source_provider,
        archived_at = excluded.archived_at
    `).run(String(animeId), String(episode), String(variant), String(vttKey), sourceProvider, Date.now());
    return true;
  } catch (e) {
    console.warn("[cache] upsertEpisodeThumbnail error:", e.message);
    return false;
  }
}

export function getEpisodeThumbnails(animeId, episode) {
  if (!db) return {};
  try {
    const rows = db.prepare(
      `SELECT variant, vtt_key, source_provider, archived_at FROM episode_thumbnails WHERE anime_id = ? AND episode = ?`
    ).all(String(animeId), String(episode));
    const out = {};
    for (const row of rows) {
      out[row.variant] = {
        vttKey: row.vtt_key,
        sourceProvider: row.source_provider,
        archivedAt: row.archived_at,
      };
    }
    return out;
  } catch (e) {
    console.warn("[cache] getEpisodeThumbnails error:", e.message);
    return {};
  }
}

// ── Tracks manuales (subs subidos desde el panel externo) ────────────────────
// Se mergean en buildAnimeTracks junto a los de CR/megaplay. El archivo vive
// en R2 bajo subs/ y se sirve con URL firmada igual que los subs de CR.
export function addManualTrack({ animeId, episode, lang, label, file, kind = "subtitles" }) {
  if (!db) return false;
  try {
    db.prepare(`
      INSERT INTO manual_tracks (anime_id, episode, lang, label, file, kind, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(anime_id, episode, file) DO UPDATE SET
        lang = excluded.lang,
        label = excluded.label,
        kind = excluded.kind
    `).run(String(animeId), String(episode), lang, label, file, kind, Date.now());
    return true;
  } catch (e) {
    console.warn("[cache] addManualTrack error:", e.message);
    return false;
  }
}

export function getManualTracks(animeId, episode) {
  if (!db) return [];
  try {
    return db.prepare(
      `SELECT id, lang, label, file, kind, created_at FROM manual_tracks WHERE anime_id = ? AND episode = ?`
    ).all(String(animeId), String(episode));
  } catch (e) {
    console.warn("[cache] getManualTracks error:", e.message);
    return [];
  }
}

export function listAllManualTracks() {
  if (!db) return [];
  try {
    return db.prepare(
      `SELECT id, anime_id, episode, lang, label, file, kind, created_at FROM manual_tracks ORDER BY created_at DESC`
    ).all();
  } catch (e) {
    console.warn("[cache] listAllManualTracks error:", e.message);
    return [];
  }
}

export function deleteManualTrack(id) {
  if (!db) return;
  try { db.prepare(`DELETE FROM manual_tracks WHERE id = ?`).run(id); }
  catch (e) { console.warn("[cache] deleteManualTrack error:", e.message); }
}

export function timed(label, fn) {
  const t0 = Date.now();
  return fn().then(
    (result) => {
      console.log(`[timer] ${label} OK ${Date.now() - t0}ms`);
      return result;
    },
    (e) => {
      console.warn(`[timer] ${label} ERR ${Date.now() - t0}ms — ${e.message}`);
      throw e;
    }
  );
}

// Limpia entradas expiradas cada 5 minutos para no acumular memoria
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now > entry.expiresAt) cache.delete(key);
  }
}, 5 * 60 * 1000).unref();
