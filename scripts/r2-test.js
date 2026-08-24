/**
 * scripts/r2-test.js — Test manual: descarga un stream HLS completo (a
 * través de nuestro propio proxy sellado) y lo sube a Cloudflare R2.
 *
 * No toca nada de la API en producción. Correr con:
 *   npm run r2:test -- "<proxy_url del m3u8>" "<slug de salida, ej: 21202-1-jap>"
 *
 * El <proxy_url> es el campo "proxy_url" que devuelve /anime/:id/:episode
 * para un stream de tipo hls, apuntando a tu instancia LOCAL de api_vid
 * (npm run dev), así los headers/referer del provider ya vienen resueltos.
 *
 * Requiere en .env:
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME
 *   R2_SEAL_SECRET, R2_WORKER_BASE (para generar la URL firmada de prueba)
 */

import { archiveHlsToR2 } from "../src/lib/hls-to-r2.js";
import { buildSignedR2Url } from "../src/lib/r2-seal.js";

const [, , inputUrl, slugArg] = process.argv;
if (!inputUrl) {
  console.error('Uso: npm run r2:test -- "<proxy_url del m3u8>" "<slug opcional>"');
  process.exit(1);
}
const slug = slugArg || `test-${Date.now()}`;

async function main() {
  console.log(`Descargando y subiendo: ${inputUrl}`);
  console.log(`Slug de salida: ${slug}\n`);

  const { slug: outSlug, bytes, elapsedMs } = await archiveHlsToR2(inputUrl, slug);

  console.log(`\nListo en ${(elapsedMs / 1000).toFixed(1)}s. Total subido: ${(bytes / 1024 / 1024).toFixed(2)} MB`);

  if (process.env.R2_SEAL_SECRET && process.env.R2_WORKER_BASE) {
    const signedUrl = buildSignedR2Url(`${outSlug}/master.m3u8`);
    console.log(`\nURL firmada para reproducir (VLC/ffplay/navegador):\n  ${signedUrl}`);
  } else {
    console.log(`\nSlug subido: ${outSlug} (configura R2_SEAL_SECRET + R2_WORKER_BASE para generar una URL firmada de prueba)`);
  }
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});

