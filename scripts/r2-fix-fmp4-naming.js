/**
 * scripts/r2-fix-fmp4-naming.js — Migra un episodio YA archivado en R2 al
 * naming nuevo que distingue EXT-X-MAP (init fMP4) de EXT-X-KEY, y segmentos
 * fMP4 de segmentos TS, sin volver a descargar del provider original.
 *
 * No descarga/reescribe bytes de segmentos: usa CopyObjectCommand (copia
 * server-side dentro de R2, no pasa por esta máquina) para renombrar:
 *   key-XXX.jpg  (el que aparece en EXT-X-MAP) -> init-XXX.jpg
 *   seg-NNNNN.jpg (si el playlist tiene EXT-X-MAP) -> fseg-NNNNN.jpg
 * y reescribe el master.m3u8 con los nombres nuevos.
 *
 * El key-XXX.jpg de un EXT-X-KEY real (si existiera) NO se toca.
 *
 * Uso:
 *   node scripts/r2-fix-fmp4-naming.js <slug> [--delete-old] [--dry-run]
 *   node scripts/r2-fix-fmp4-naming.js 21202-3-esp-lat --dry-run
 */
import {
  S3Client, GetObjectCommand, PutObjectCommand, CopyObjectCommand, DeleteObjectCommand,
} from "@aws-sdk/client-s3";

const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME } = process.env;

const args = process.argv.slice(2);
const slug = args.find((a) => !a.startsWith("--"));
const deleteOld = args.includes("--delete-old");
const dryRun = args.includes("--dry-run");

if (!slug) {
  console.error("Uso: node scripts/r2-fix-fmp4-naming.js <slug> [--delete-old] [--dry-run]");
  process.exit(1);
}
for (const [name, val] of Object.entries({ R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME })) {
  if (!val) { console.error(`Falta la variable de entorno ${name} en .env`); process.exit(1); }
}

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});

async function streamToString(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function copyObject(oldKey, newKey) {
  if (dryRun) { console.log(`  [dry-run] copiaría ${oldKey} -> ${newKey}`); return; }
  await s3.send(new CopyObjectCommand({
    Bucket: R2_BUCKET_NAME,
    CopySource: `${R2_BUCKET_NAME}/${encodeURIComponent(oldKey)}`,
    Key: newKey,
  }));
  console.log(`  copiado ${oldKey} -> ${newKey}`);
}

async function deleteObject(key) {
  if (dryRun) { console.log(`  [dry-run] borraría ${key}`); return; }
  await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
  console.log(`  borrado ${key}`);
}

async function main() {
  const masterKey = `${slug}/master.m3u8`;
  console.log(`Descargando ${masterKey}...`);
  const obj = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: masterKey }));
  const text = await streamToString(obj.Body);
  const lines = text.split(/\r?\n/);

  const isFmp4 = lines.some((l) => /^#EXT-X-MAP/i.test(l.trim()));
  console.log(`Playlist tiene EXT-X-MAP: ${isFmp4}`);
  if (!isFmp4) {
    console.log("No hay EXT-X-MAP en este playlist, no necesita migración (probablemente ya es TS puro).");
    return;
  }

  const renames = new Map(); // oldFilename -> newFilename

  const rewritten = [];
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (/^#EXT-X-MAP/i.test(trimmed) && /URI="([^"]+)"/.test(trimmed)) {
      const oldFilename = trimmed.match(/URI="([^"]+)"/)[1];
      if (!oldFilename.includes("://")) {
        const newFilename = oldFilename.replace(/^key-/, "init-");
        renames.set(oldFilename, newFilename);
        rewritten.push(rawLine.replace(/URI="([^"]+)"/, `URI="${newFilename}"`));
        continue;
      }
    }

    if (!trimmed.startsWith("#") && trimmed && !trimmed.includes("://")) {
      const newFilename = trimmed.replace(/^seg-/, "fseg-");
      if (newFilename !== trimmed) renames.set(trimmed, newFilename);
      rewritten.push(newFilename);
      continue;
    }

    rewritten.push(rawLine);
  }

  console.log(`Renombrando ${renames.size} objeto(s) (server-side copy, sin re-descargar bytes)...`);
  for (const [oldFilename, newFilename] of renames) {
    await copyObject(`${slug}/${oldFilename}`, `${slug}/${newFilename}`);
  }

  console.log("Re-subiendo master.m3u8 reescrito...");
  if (!dryRun) {
    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: masterKey,
      Body: Buffer.from(rewritten.join("\n"), "utf8"),
      ContentType: "application/vnd.apple.mpegurl",
    }));
  } else {
    console.log("  [dry-run] no se sube master.m3u8 reescrito");
  }

  if (deleteOld) {
    console.log("Borrando objetos viejos...");
    for (const [oldFilename] of renames) {
      await deleteObject(`${slug}/${oldFilename}`);
    }
  } else {
    console.log("Objetos viejos NO borrados (usá --delete-old para limpiar duplicados una vez confirmado que funciona).");
  }

  console.log(`\nListo. ${renames.size} objeto(s) migrado(s) en ${slug}/. Probá castear de nuevo.`);
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
