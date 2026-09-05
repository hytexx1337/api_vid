/**
 * scripts/r2-fix-cr-index-flags.js — Repara subs-cache/cr-index.json cuando
 * el archivo ya está subido a R2 pero al track le falta el flag r2:true
 * (ej. porque saveCRIndex() pisó el índice completo antes del fix en
 * scraper-crunchyroll.js). NO vuelve a subir nada: solo hace HEAD contra R2
 * para confirmar que el objeto existe y recién ahí marca el flag.
 *
 * Uso: npm run r2:fix-cr-index-flags
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { isR2Configured, objectExistsInR2 } from "../src/lib/hls-to-r2.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const SUBS_DIR = join(__dir, "..", "subs-cache");
const CR_INDEX = join(SUBS_DIR, "cr-index.json");

async function main() {
  if (!isR2Configured()) {
    console.error("R2 no está configurado (faltan envs en .env)");
    process.exit(1);
  }
  if (!existsSync(CR_INDEX)) {
    console.error(`No existe ${CR_INDEX}`);
    process.exit(1);
  }

  const index = JSON.parse(readFileSync(CR_INDEX, "utf-8"));
  let fixed = 0, alreadyOk = 0, notInR2 = 0;

  for (const [key, tracks] of Object.entries(index)) {
    for (const t of tracks) {
      if (t.r2) { alreadyOk++; continue; }
      const exists = await objectExistsInR2(`subs/${t.file}`);
      if (exists) {
        t.r2 = true;
        fixed++;
        console.log(`[${key}] ✅ ${t.file} confirmado en R2 → r2:true`);
      } else {
        notInR2++;
        console.warn(`[${key}] ⚠️  ${t.file} NO está en R2 — se deja como está`);
      }
    }
  }

  writeFileSync(CR_INDEX, JSON.stringify(index, null, 2), "utf-8");
  console.log(`\nListo. corregidos=${fixed} ya-ok=${alreadyOk} no-en-r2=${notInR2}`);
}

main();
