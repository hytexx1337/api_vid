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
const PERSIST_PREFIX = "streams:";
let db = null;

function initDb() {
  try {
    const { DatabaseSync } = require("node:sqlite");
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
    fs.mkdirSync(dir, { recursive: true });
    const dbInstance = new DatabaseSync(path.join(dir, "stream-cache.db"));
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
    return dbInstance;
  } catch (e) {
    console.warn("[cache] node:sqlite no disponible, cache persistente deshabilitada:", e.message);
    return null;
  }
}

db = initDb();

function persistSet(key, value, expiresAt) {
  if (!db || !key.startsWith(PERSIST_PREFIX)) return;
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
  if (!db || !key.startsWith(PERSIST_PREFIX)) return null;
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
export function upsertR2Archive({ animeId, episode, lang, slug, sourceProvider, bytes }) {
  if (!db) return false;
  try {
    db.prepare(`
      INSERT INTO r2_archive (anime_id, episode, lang, slug, source_provider, bytes, archived_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(anime_id, episode, lang) DO UPDATE SET
        slug = excluded.slug,
        source_provider = excluded.source_provider,
        bytes = excluded.bytes,
        archived_at = excluded.archived_at
    `).run(String(animeId), String(episode), lang, slug, sourceProvider ?? null, bytes ?? null, Date.now());
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
      `SELECT lang, slug, source_provider, bytes, archived_at FROM r2_archive WHERE anime_id = ? AND episode = ?`
    ).all(String(animeId), String(episode));
    const out = {};
    for (const r of rows) {
      out[r.lang] = { slug: r.slug, sourceProvider: r.source_provider, bytes: r.bytes, archivedAt: r.archived_at };
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
      `SELECT anime_id, episode, lang, slug, source_provider, bytes, archived_at FROM r2_archive`
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
