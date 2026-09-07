/**
 * scripts/r2-report.mjs — Reporte de lo archivado en R2 (tabla r2_archive).
 *
 * Uso:
 *   node scripts/r2-report.mjs              → resumen global + por anime
 *   node scripts/r2-report.mjs 170130       → detalle por episodio de ese anime
 *   node scripts/r2-report.mjs 170130 12    → además marca episodios 1..12 que faltan
 */
import { DatabaseSync } from "node:sqlite";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "stream-cache.db");

const LANGS = ["ESP-LAT", "ENG-DUB", "JAP-ES-HS", "JAP-EN-HS"];

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const rows = db.prepare(
  `SELECT anime_id, episode, lang, slug, source_provider, bytes, archived_at
   FROM r2_archive ORDER BY anime_id, CAST(episode AS INTEGER), lang`
).all();

if (!rows.length) {
  console.log("r2_archive está vacía.");
  process.exit(0);
}

// Agrupar: anime -> episode -> Set(langs)
const byAnime = new Map();
for (const r of rows) {
  if (!byAnime.has(r.anime_id)) byAnime.set(r.anime_id, new Map());
  const eps = byAnime.get(r.anime_id);
  if (!eps.has(r.episode)) eps.set(r.episode, { langs: new Set(), entries: [] });
  eps.get(r.episode).langs.add(r.lang);
  eps.get(r.episode).entries.push(r);
}

const [animeArg, epCountArg] = process.argv.slice(2);

if (!animeArg) {
  // ── Resumen global ──────────────────────────────────────────────────────
  console.log(`Total: ${byAnime.size} anime(s), ${rows.length} registro(s) en r2_archive\n`);
  for (const [animeId, eps] of byAnime) {
    const epNums = [...eps.keys()].map(Number).sort((a, b) => a - b);
    const full = epNums.filter(e => LANGS.every(l => eps.get(String(e)).langs.has(l)));
    const partial = epNums.filter(e => !full.includes(e));
    const bytes = [...eps.values()].flatMap(v => v.entries).reduce((s, r) => s + (r.bytes || 0), 0);
    console.log(`anime ${animeId}: ${epNums.length} ep(s) [${epNums[0]}..${epNums[epNums.length - 1]}], ` +
      `${full.length} con los 4 idiomas, ${partial.length} parcial(es), ${(bytes / 1048576).toFixed(0)} MB`);
    if (partial.length) {
      for (const e of partial) {
        const have = eps.get(String(e)).langs;
        const missing = LANGS.filter(l => !have.has(l));
        console.log(`   ep${e}: tiene [${[...have].join(", ")}] — falta [${missing.join(", ")}]`);
      }
    }
  }
  console.log(`\nDetalle por anime: node scripts/r2-report.mjs <animeId> [totalEps]`);
  process.exit(0);
}

// ── Detalle de un anime ─────────────────────────────────────────────────────
const eps = byAnime.get(String(animeArg));
if (!eps) {
  console.log(`anime ${animeArg}: sin registros en r2_archive.`);
  process.exit(0);
}

const maxEp = epCountArg ? parseInt(epCountArg, 10) : Math.max(...[...eps.keys()].map(Number));
console.log(`anime ${animeArg} — ${eps.size}/${maxEp} episodio(s) con algo archivado\n`);
console.log(`ep  | ${LANGS.map(l => l.padEnd(10)).join(" | ")} | provider(s)`);
console.log("-".repeat(72));

for (let e = 1; e <= maxEp; e++) {
  const entry = eps.get(String(e));
  if (!entry) {
    console.log(`${String(e).padEnd(3)} | ${"—".padEnd(10)} | ${"—".padEnd(10)} | ${"—".padEnd(10)} | ${"—".padEnd(10)} | (nada)`);
    continue;
  }
  const cells = LANGS.map(l => (entry.langs.has(l) ? "✔" : "✘").padEnd(10));
  const providers = [...new Set(entry.entries.map(r => r.source_provider || "?"))].join(",");
  console.log(`${String(e).padEnd(3)} | ${cells.join(" | ")} | ${providers}`);
}

// Resumen de faltantes
const missingAll = [];
for (let e = 1; e <= maxEp; e++) if (!eps.has(String(e))) missingAll.push(e);
const missingLang = [];
for (const [ep, v] of eps) {
  const miss = LANGS.filter(l => !v.langs.has(l));
  if (miss.length) missingLang.push(`ep${ep}: ${miss.join(", ")}`);
}
console.log();
if (missingAll.length) console.log(`Episodios sin NADA: ${missingAll.join(", ")}`);
if (missingLang.length) console.log(`Idiomas faltantes:\n  ${missingLang.join("\n  ")}`);
if (!missingAll.length && !missingLang.length) console.log("Completo: todos los episodios tienen los 4 idiomas.");
