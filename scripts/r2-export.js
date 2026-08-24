/**
 * scripts/r2-export.js — Vuelca la tabla r2_archive completa a un JSON.
 * Usar cuando querés migrar los registros de "qué episodios ya están
 * archivados en R2" de un entorno a otro (ej: local -> VPS), ya que
 * data/ está en .gitignore y no viaja con git pull.
 *
 * Uso:
 *   npm run r2:export -- [archivo-salida.json]
 *   (default: r2-archive-export.json en la raíz del proyecto)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { listAllR2Archive } from "../src/lib/cache.js";

const outFile = process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "r2-archive-export.json");

const rows = listAllR2Archive();
fs.writeFileSync(outFile, JSON.stringify(rows, null, 2));
console.log(`Exportadas ${rows.length} fila(s) de r2_archive a ${outFile}`);
