/**
 * Busca dubs archivados que ya están cubiertos por un MULTI del mismo episodio.
 *
 * Uso:
 *   npm run r2:cleanup-multi-dubs
 *   npm run r2:cleanup-multi-dubs -- --apply
 *   npm run r2:cleanup-multi-dubs -- --anime-id 112641
 *   npm run r2:cleanup-multi-dubs -- --anime-id 112641 --episode 1 --apply
 */
import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = path.join(__dirname, "..", "data", "stream-cache.db");
const DUB_LANGS = ["ENG-DUB", "ESP-LAT"];

function readArgs(argv) {
  const args = {
    apply: false,
    animeId: null,
    episode: null,
    dbPath: DEFAULT_DB_PATH,
    lang: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--anime-id" || arg === "--anime") args.animeId = argv[++i] || null;
    else if (arg === "--episode" || arg === "--ep") args.episode = argv[++i] || null;
    else if (arg === "--db") args.dbPath = path.resolve(argv[++i] || DEFAULT_DB_PATH);
    else if (arg === "--lang") args.lang = String(argv[++i] || "").toUpperCase() || null;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Argumento desconocido: ${arg}`);
    }
  }

  if (args.lang && !DUB_LANGS.includes(args.lang)) {
    throw new Error(`--lang solo acepta: ${DUB_LANGS.join(", ")}`);
  }

  return args;
}

function printHelp() {
  console.log(`
Uso:
  npm run r2:cleanup-multi-dubs
  npm run r2:cleanup-multi-dubs -- --apply
  npm run r2:cleanup-multi-dubs -- --anime-id 112641
  npm run r2:cleanup-multi-dubs -- --anime-id 112641 --episode 1 --apply

Opciones:
  --apply          Borra los dubs redundantes. Sin esto, solo hace dry-run.
  --anime-id ID    Limita la búsqueda a un anime.
  --episode N      Limita la búsqueda a un episodio.
  --lang LANG      Limita a ENG-DUB o ESP-LAT.
  --db PATH        Usa otra ruta de SQLite.
`);
}

function parseTracks(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const audioTracks = Array.isArray(parsed?.audioTracks) ? parsed.audioTracks : [];
    const subtitleTracks = Array.isArray(parsed?.subtitleTracks) ? parsed.subtitleTracks : [];
    if (!audioTracks.length && !subtitleTracks.length) return null;
    return { audioTracks, subtitleTracks };
  } catch {
    return null;
  }
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function multiCoversLang(multiRow, lang) {
  const tracks = parseTracks(multiRow?.tracks_json);
  if (!tracks?.audioTracks?.length) return false;

  return tracks.audioTracks.some((track) => {
    const code = String(track?.code || "").trim().toUpperCase();
    const rawLang = normalize(track?.lang || track?.id || track?.language || track?.locale);
    const label = normalize(track?.label || track?.name || track?.title);

    if (code === lang) return true;
    if (lang === "ENG-DUB") return ["en", "en-us", "eng", "english"].includes(rawLang) || label.includes("english");
    if (lang === "ESP-LAT") {
      return ["es", "es-mx", "es-419", "spa", "spanish"].includes(rawLang)
        || label.includes("latino")
        || label.includes("latin american")
        || label.includes("español");
    }
    return false;
  });
}

function groupRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.anime_id}::${row.episode}`;
    if (!groups.has(key)) groups.set(key, { animeId: row.anime_id, episode: row.episode, byLang: new Map() });
    groups.get(key).byLang.set(row.lang, row);
  }
  return [...groups.values()];
}

function buildWhere(args) {
  const where = [`lang IN ('MULTI', 'ENG-DUB', 'ESP-LAT')`];
  const params = [];
  if (args.animeId) {
    where.push("anime_id = ?");
    params.push(String(args.animeId));
  }
  if (args.episode) {
    where.push("episode = ?");
    params.push(String(args.episode));
  }
  return { sql: where.join(" AND "), params };
}

function findCandidates(rows, args) {
  const candidates = [];
  const skipped = [];

  for (const group of groupRows(rows)) {
    const multi = group.byLang.get("MULTI");
    if (!multi) continue;

    for (const lang of DUB_LANGS) {
      if (args.lang && args.lang !== lang) continue;
      const dub = group.byLang.get(lang);
      if (!dub) continue;

      if (multiCoversLang(multi, lang)) {
        candidates.push({ animeId: group.animeId, episode: group.episode, lang, dub, multi });
      } else {
        skipped.push({ animeId: group.animeId, episode: group.episode, lang, reason: "MULTI sin audio confirmado para ese idioma", dub, multi });
      }
    }
  }

  return { candidates, skipped };
}

function deleteRows(db, candidates) {
  const deleteArchive = db.prepare(`DELETE FROM r2_archive WHERE anime_id = ? AND episode = ? AND lang = ?`);
  const deleteCache = db.prepare(`DELETE FROM stream_cache WHERE cache_key LIKE ?`);
  const touched = new Set();
  let deletedArchive = 0;
  let deletedCache = 0;

  db.exec("BEGIN");
  try {
    for (const item of candidates) {
      const result = deleteArchive.run(item.animeId, item.episode, item.lang);
      deletedArchive += result.changes ?? 0;
      touched.add(`${item.animeId}::${item.episode}`);
    }

    for (const key of touched) {
      const [animeId, episode] = key.split("::");
      const patterns = [
        `streams:anime:%:${animeId}:${episode}`,
        `reanime:streams:%:${animeId}:${episode}`,
        `resp:streams:anime:%:${animeId}:${episode}:%`,
      ];
      for (const pattern of patterns) {
        const result = deleteCache.run(pattern);
        deletedCache += result.changes ?? 0;
      }
    }

    db.exec("COMMIT");
    return { deletedArchive, deletedCache, touched: touched.size };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function printCandidates(candidates, skipped) {
  if (!candidates.length && !skipped.length) {
    console.log("No encontré episodios con MULTI + dubs separados.");
    return;
  }

  if (candidates.length) {
    console.log(`Dubs redundantes confirmados: ${candidates.length}`);
    for (const item of candidates) {
      console.log(
        `  anime ${item.animeId} ep ${item.episode}: borrar ${item.lang} (${item.dub.slug}) porque MULTI (${item.multi.slug}) lo cubre`
      );
    }
  }

  if (skipped.length) {
    console.log(`\nOmitidos por seguridad: ${skipped.length}`);
    for (const item of skipped) {
      console.log(
        `  anime ${item.animeId} ep ${item.episode}: NO borro ${item.lang} (${item.reason})`
      );
    }
  }
}

const args = readArgs(process.argv.slice(2));

if (!fs.existsSync(args.dbPath)) {
  throw new Error(`No existe la DB: ${args.dbPath}`);
}

const db = new DatabaseSync(args.dbPath, { readOnly: !args.apply });
const where = buildWhere(args);
const rows = db.prepare(
  `SELECT anime_id, episode, lang, slug, source_provider, bytes, archived_at, tracks_json
   FROM r2_archive
   WHERE ${where.sql}
   ORDER BY anime_id, CAST(episode AS INTEGER), episode, lang`
).all(...where.params);

const { candidates, skipped } = findCandidates(rows, args);

console.log(args.apply ? "Modo APPLY: voy a borrar registros confirmados.\n" : "Modo DRY-RUN: no se borra nada.\n");
printCandidates(candidates, skipped);

if (!args.apply) {
  if (candidates.length) console.log("\nPara aplicar: npm run r2:cleanup-multi-dubs -- --apply");
  process.exit(0);
}

if (!candidates.length) {
  console.log("\nNo hay nada para borrar.");
  process.exit(0);
}

const result = deleteRows(db, candidates);
console.log(
  `\nListo: ${result.deletedArchive} fila(s) borradas de r2_archive, ${result.deletedCache} cache(s) persistidas invalidadas, ${result.touched} episodio(s) tocados.`
);
