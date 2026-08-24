/**
 * scripts/r2-fix-playlist.js — Migra un master.m3u8 ya subido (con URLs
 * absolutas al bucket público viejo) a rutas RELATIVAS, sin volver a
 * descargar/subir segmentos. Solo reescribe y re-sube ese único archivo.
 *
 * Uso:
 *   npm run r2:fix -- <slug>
 *   npm run r2:fix -- 21202-3-esp-lat
 */
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL } = process.env;

const [, , slug] = process.argv;
if (!slug) {
  console.error("Uso: npm run r2:fix -- <slug>");
  process.exit(1);
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

async function main() {
  const key = `${slug}/master.m3u8`;
  console.log(`Descargando ${key} de R2...`);
  const obj = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
  const text = await streamToString(obj.Body);

  const publicPrefix = `${(R2_PUBLIC_URL || "").replace(/\/$/, "")}/${slug}/`;
  let changed = 0;
  const rewritten = text
    .split(/\r?\n/)
    .map((line) => {
      if (line.includes(publicPrefix)) {
        changed++;
        return line.replaceAll(publicPrefix, "");
      }
      return line;
    })
    .join("\n");

  if (!changed) {
    console.log("No se encontraron URLs absolutas para reescribir. ¿Ya está en formato relativo?");
    return;
  }

  await s3.send(new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    Body: Buffer.from(rewritten, "utf8"),
    ContentType: "application/vnd.apple.mpegurl",
  }));

  console.log(`Listo: ${changed} línea(s) reescritas a relativas en ${key}`);
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
