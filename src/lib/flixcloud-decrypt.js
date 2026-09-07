import { gunzipSync, brotliDecompressSync, zstdDecompressSync } from "zlib";

// Clave XOR global fija usada por flixcloud.cc para "cifrar" el contenido de
// sus manifests .m3u8 (master/video/audio). Reverseada el 2026-09-06:
// - El transporte HTTP usa Content-Encoding: zstd (normal, sin relación con esto).
// - El body ya descomprimido de zstd es TEXTO BASE64 (no el m3u8 todavía).
// - Ese base64, decodeado a binario, es el m3u8 real XOReado byte a byte con
//   esta clave de 32 bytes repetida (keystream period=32, confirmado con
//   3 manifests de distintos videos/tokens que comparten prefijo cifrado
//   idéntico → prueba de que la clave es global, no por sesión).
// Requiere Node >=22.15 (zlib.zstdDecompressSync). Ver package.json engines.
const FLIXCLOUD_XOR_KEY = Buffer.from(
  "ff3a7693db610598278154f1492dd2d8aed070f0ea35836a483dc2e692000c6f",
  "hex"
);

function xorWithKey(buf, key) {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ key[i % key.length];
  return out;
}

function decompressByEncoding(buf, encoding) {
  switch (encoding) {
    case "zstd":
      if (typeof zstdDecompressSync !== "function") {
        throw new Error("zlib.zstdDecompressSync no disponible: se requiere Node >=22.15");
      }
      return zstdDecompressSync(buf);
    case "br":
      return brotliDecompressSync(buf);
    case "gzip":
    case "deflate":
      return gunzipSync(buf);
    default:
      return buf;
  }
}

// Descifra el body crudo (ya con Content-Encoding removido a nivel HTTP si el
// cliente HTTP lo hizo automáticamente; si no, encoding indica cómo destaparlo
// manualmente antes del paso base64+XOR).
// manifestKeyB64: clave dinámica de 32 bytes (base64) derivada del WASM del
// embed (window.__pk en el player). Si viene, se usa en lugar de la clave
// estática — flixcloud rotó a clave por-embed en 2026-09.
export function decryptFlixcloudManifest(rawBuf, contentEncoding, manifestKeyB64 = null) {
  const b64Text = decompressByEncoding(rawBuf, contentEncoding).toString("utf8");
  const cipherBytes = Buffer.from(b64Text.trim(), "base64");
  const keys = [];
  if (manifestKeyB64) {
    const k = Buffer.from(manifestKeyB64, "base64");
    if (k.length) keys.push(k);
  }
  keys.push(FLIXCLOUD_XOR_KEY);
  for (const key of keys) {
    const plain = xorWithKey(cipherBytes, key).toString("utf8");
    if (plain.startsWith("#EXTM3U")) return plain;
  }
  // Ninguna clave produjo un m3u8 válido: devolver el intento con la clave
  // dinámica (o la estática) para que el error upstream sea visible.
  return xorWithKey(cipherBytes, keys[0]).toString("utf8");
}

// Los "segmentos" (.webp/.png) también van cifrados, pero con un esquema
// distinto al del manifest: hls.js (parcheado, ver el bundle real de
// flixcloud.cc) les pega un header falso de 12 bytes (RIFF....WEBP) u 8 bytes
// (\x89PNG\r\n\x1a\n) según el nombre de archivo, y el payload real que sigue
// va XOReado con una clave de 16 bytes repetida — salvo que el primer byte
// post-header YA sea 0x47 (sync de MPEG-TS), en cuyo caso viene sin XOR.
// Reverseado el 2026-09-06 leyendo el propio bundle de hls.js parcheado que
// sirve flixcloud.cc (loader fetch, ver comentario en rewriteFlixcloudPlaylist
// en routes/proxy.js para el pipeline completo).
const FLIXCLOUD_SEGMENT_XOR_KEY = Buffer.from([157, 42, 241, 71, 179, 142, 92, 112, 166, 25, 228, 59, 216, 98, 15, 197]);

export function decryptFlixcloudSegment(buf) {
  let payload = null;
  let needsXor = true;
  if (buf.length >= 12 && buf[0] === 82 && buf[1] === 73 && buf[2] === 70 && buf[3] === 70 && buf[8] === 87 && buf[9] === 69 && buf[10] === 66 && buf[11] === 80) {
    payload = buf.subarray(12);
    if (buf.length >= 13 && buf[12] === 71) needsXor = false;
  } else if (buf.length >= 8 && buf[0] === 137 && buf[1] === 80 && buf[2] === 78 && buf[3] === 71 && buf[4] === 13 && buf[5] === 10 && buf[6] === 26 && buf[7] === 10) {
    payload = buf.subarray(8);
    if (buf.length >= 9 && buf[8] === 71) needsXor = false;
  } else {
    return buf;
  }
  if (!needsXor) return Buffer.from(payload);
  const out = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ FLIXCLOUD_SEGMENT_XOR_KEY[i & 15];
  return out;
}

export async function fetchAndDecryptFlixcloudManifest(targetUrl, referer = "https://flixcloud.cc/", manifestKeyB64 = null) {
  const upstream = await fetch(targetUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Referer: referer,
      Origin: new URL(referer).origin,
      "Accept-Encoding": "zstd",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!upstream.ok) {
    throw Object.assign(new Error(`flixcloud manifest upstream ${upstream.status}`), { status: upstream.status });
  }
  const buf = Buffer.from(await upstream.arrayBuffer());
  const encoding = upstream.headers.get("content-encoding");
  return decryptFlixcloudManifest(buf, encoding, manifestKeyB64);
}
