/**
 * scripts/r2-migrate-cr-subs.js — Sube a R2 todos los subs de Crunchyroll
 * ya cacheados en disco (subs-cache/*.vtt|*.ass) e indexados en
 * subs-cache/cr-index.json, y marca cada track con r2:true para que
 * scraper-crunchyroll.js/streams.js dejen de servirlos desde el VPS.
 *
 * No borra los .vtt/.ass locales (quedan como backup si algo sale mal con
 * R2); usar --delete-local para borrarlos después de subir con éxito.
 *
 * Uso:
 *   npm run r2:migrate-cr-subs
 *   npm run r2:migrate-cr-subs -- --delete-local
 */
import { readFileSync, writeFileSync, existsSync, readFileSync as readFileSyncBin, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { isR2Configured, uploadToR2 } from "../src/lib/hls-to-r2.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const SUBS_DIR = join(__dir, "..", "subs-cache");
const CR_INDEX = join(SUBS_DIR, "cr-index.json");

const DELETE_LOCAL = process.argv.includes("--delete-local");

const CONTENT_TYPE = {
  vtt: "text/vtt; charset=utf-8",
  ass: "text/x-ssa; charset=utf-8",
};

async function main() {
  if (!isR2Configured()) {
    console.error("R2 no está configurado (faltan R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET_NAME/R2_SEAL_SECRET/R2_WORKER_BASE en .env)");
    process.exit(1);
  }
  if (!existsSync(CR_INDEX)) {
    console.error(`No existe ${CR_INDEX}`);
    process.exit(1);
  }

  const index = JSON.parse(readFileSync(CR_INDEX, "utf-8"));
  let uploaded = 0, skipped = 0, missing = 0, failed = 0;

  for (const [key, tracks] of Object.entries(index)) {
    for (const t of tracks) {
      if (t.r2) { skipped++; continue; }

      const filepath = join(SUBS_DIR, t.file);
      if (!existsSync(filepath)) {
        console.warn(`[${key}] falta en disco: ${t.file} — se deja como está`);
        missing++;
        continue;
      }

      const contentType = CONTENT_TYPE[t.format] || "text/plain; charset=utf-8";
      try {
        const buf = readFileSyncBin(filepath);
        await uploadToR2(`subs/${t.file}`, buf, contentType);
        t.r2 = true;
        uploaded++;
        console.log(`[${key}] ✅ subido ${t.file} (${t.lang}/${t.format})`);
        if (DELETE_LOCAL) {
          try { unlinkSync(filepath); } catch (e) { console.warn(`  no se pudo borrar local: ${e.message}`); }
        }
      } catch (e) {
        console.warn(`[${key}] ❌ fallo subiendo ${t.file}: ${e.message}`);
        failed++;
      }
    }
  }

  writeFileSync(CR_INDEX, JSON.stringify(index, null, 2), "utf-8");
  console.log(`\nListo. subidos=${uploaded} ya-en-r2=${skipped} faltantes-en-disco=${missing} fallidos=${failed}`);
}

main();
