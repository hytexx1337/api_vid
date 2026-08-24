/**
 * scripts/r2-import.js — Importa un JSON generado por r2-export.js a la
 * tabla r2_archive local (upsert, no duplica). Correr en el VPS después de
 * copiar el archivo generado localmente (ej: scp).
 *
 * Uso:
 *   npm run r2:import -- [archivo-entrada.json]
 *   (default: r2-archive-export.json en la raíz del proyecto)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { upsertR2Archive } from "../src/lib/cache.js";

const inFile = process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "r2-archive-export.json");

if (!fs.existsSync(inFile)) {
  console.error(`No existe ${inFile}`);
  process.exit(1);
}

const rows = JSON.parse(fs.readFileSync(inFile, "utf8"));
let ok = 0;
for (const r of rows) {
  const success = upsertR2Archive({
    animeId: r.anime_id,
    episode: r.episode,
    lang: r.lang,
    slug: r.slug,
    sourceProvider: r.source_provider,
    bytes: r.bytes,
  });
  if (success) ok++;
}
console.log(`Importadas ${ok}/${rows.length} fila(s) a r2_archive`);
