/**
 * scripts/r2-select.js — Pega a /anime/:anilistId/:episode (local o VPS),
 * agrupa los streams por idioma, elige 1 URL por grupo según prioridad de
 * provider, y archiva cada uno a R2 con archiveHlsToR2().
 *
 * Cubre ESP-LAT, ENG-DUB, JAP-ES-HS y JAP-EN-HS. JAP-SUB queda afuera por
 * ahora (soft-subs, menos prioritario).
 *
 * Uso:
 *   npm run r2:select -- <anilistId> <episode> [apiBase]
 *
 * apiBase por defecto: http://localhost:${PORT env || 3005}
 *
 * Requiere en .env (además de las de R2):
 *   API_KEY (opcional, si tu instancia local la exige)
 */

import { archiveHlsToR2 } from "../src/lib/hls-to-r2.js";
import { buildSignedR2Url } from "../src/lib/r2-seal.js";
import { upsertR2Archive } from "../src/lib/cache.js";

const [, , anilistIdArg, episodeArg, apiBaseArg] = process.argv;
if (!anilistIdArg || !episodeArg) {
  console.error("Uso: npm run r2:select -- <anilistId> <episode> [apiBase]");
  process.exit(1);
}

const apiBase = (apiBaseArg || `http://localhost:${process.env.PORT || 3005}`).replace(/\/$/, "");

// Prioridad de provider por grupo de idioma. Se matchea contra
// stream.originalProvider (ej: "animeav1", "animeav1-s2", "cuevana/1",
// "megaplay", "miruro-hop", "anikoto-vidstream").
const GROUP_PRIORITY = {
  "ESP-LAT": ["animeav1", "cuevana"],
  "ENG-DUB": ["reanime", "megaplay", "miruro", "anikoto"],
  "JAP-ES-HS": ["animeav1"],
  "JAP-EN-HS": ["anikoto-hsub", "miruro"],
};

function pickBest(streams, priorityList) {
  for (const providerPrefix of priorityList) {
    const match = streams.find((s) => String(s.originalProvider || "").toLowerCase().includes(providerPrefix));
    if (match) return match;
  }
  return streams[0] ?? null;
}

async function fetchAnimeStreams(anilistId, episode) {
  const key = process.env.API_KEY ? `?key=${encodeURIComponent(process.env.API_KEY)}` : "";
  const url = `${apiBase}/anime/${anilistId}/${episode}${key}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.json();
}

async function main() {
  console.log(`Consultando ${apiBase}/anime/${anilistIdArg}/${episodeArg} ...`);
  const data = await fetchAnimeStreams(anilistIdArg, episodeArg);
  const streams = data.streams || [];
  console.log(`${streams.length} streams encontrados. Grupos: ${[...new Set(streams.map((s) => s.lang))].join(", ")}\n`);

  const results = {};

  // Los grupos son independientes (URLs/origins distintos), así que se
  // archivan en paralelo. El cuello de botella es la descarga desde cada
  // provider, no la subida a R2.
  const jobs = Object.entries(GROUP_PRIORITY).map(async ([lang, priorityList]) => {
    // archiveHlsToR2 solo sabe parsear playlists m3u8, descartamos mp4 (ej. upnshare).
    const candidates = streams.filter((s) => s.lang === lang && s.proxy_url && s.type !== "mp4");
    if (!candidates.length) {
      console.warn(`[${lang}] sin streams disponibles, se omite`);
      return;
    }

    const chosen = pickBest(candidates, priorityList);
    console.log(`[${lang}] elegido: ${chosen.originalProvider} (de ${candidates.length} candidato(s): ${candidates.map((c) => c.originalProvider).join(", ")})`);

    const slug = `${anilistIdArg}-${episodeArg}-${lang.toLowerCase()}`;
    try {
      const { bytes, elapsedMs } = await archiveHlsToR2(chosen.proxy_url, slug);
      console.log(`[${lang}] archivado en ${(elapsedMs / 1000).toFixed(1)}s, ${(bytes / 1024 / 1024).toFixed(2)} MB`);

      upsertR2Archive({
        animeId: anilistIdArg,
        episode: episodeArg,
        lang,
        slug,
        sourceProvider: chosen.originalProvider,
        bytes,
      });

      const signedUrl = process.env.R2_SEAL_SECRET && process.env.R2_WORKER_BASE
        ? buildSignedR2Url(`${slug}/master.m3u8`)
        : null;

      results[lang] = {
        slug,
        quality: "auto",
        lang,
        langLabel: chosen.langLabel,
        type: "hls",
        provider: "zenkai",
        originalProvider: "zenkai",
        sourceProvider: chosen.originalProvider,
        bytes,
        ...(signedUrl && { previewSignedUrl: signedUrl }),
      };
    } catch (e) {
      console.error(`[${lang}] ERROR archivando: ${e.message}`);
    }
  });

  await Promise.all(jobs);

  console.log("\n=== Resultado ===");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
