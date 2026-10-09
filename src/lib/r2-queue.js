/**
 * src/lib/r2-queue.js — Cola en memoria para archivar episodios a R2 de
 * forma automática cuando un usuario los pide y todavía no están.
 *
 * Diseño (proceso único, ver ecosystem.config.cjs instances:1, así que no
 * hace falta coordinación entre procesos):
 *   - `inFlight` (Set) evita encolar el mismo (anime,episode,lang) dos veces
 *     mientras está en cola o procesándose.
 *   - `CONCURRENCY` jobs corren en paralelo como máximo; el resto espera en
 *     `queue`. Cada job baja un episodio completo (~150-300MB), así que no
 *     conviene muchos concurrentes para no saturar CPU/bandwidth del server.
 *     Por default en 4: coincide con la cantidad de grupos de idioma que
 *     archivamos hoy (ESP-LAT, ENG-DUB, MULTI) — son origins
 *     distintos entre sí, así que no tiene sentido serializarlos (ver
 *     scripts/r2-select.js, que ya los corre en paralelo con Promise.all).
 *   - Al terminar (OK o error) se libera el slot y se persiste en
 *     r2_archive (cache.js) solo si tuvo éxito.
 *
 * Si el proceso se reinicia con jobs en curso, se pierden (no hay
 * persistencia de la cola en sí) — el próximo request al mismo episodio
 * los vuelve a encolar automáticamente porque no van a estar en r2_archive.
 */
import { archiveHlsToR2 } from "./hls-to-r2.js";
import { upsertR2Archive } from "./cache.js";

const CONCURRENCY = parseInt(process.env.R2_ARCHIVE_CONCURRENCY) || 4;

const queue = [];
const inFlight = new Set();
let active = 0;

function jobKey(animeId, episode, lang) {
  return `${animeId}:${episode}:${lang}`;
}

export function isQueuedOrArchiving(animeId, episode, lang) {
  return inFlight.has(jobKey(animeId, episode, lang));
}

/**
 * Encola un job de archivado. Devuelve false si ya estaba en cola/procesándose
 * (no duplica), true si se encoló.
 *
 * `candidates` es una lista ordenada de { streamUrl, sourceProvider }: si el
 * archivado falla con el primero, se reintenta con el siguiente (fallback
 * entre providers, ej. megaplay caído -> anikoto -> megavid).
 * También acepta la forma vieja { streamUrl, sourceProvider } por compat.
 */
export function enqueueArchiveJob({ animeId, episode, lang, streamUrl, sourceProvider, candidates, tracks }) {
  const k = jobKey(animeId, episode, lang);
  if (inFlight.has(k)) return false;

  const list = candidates?.length
    ? candidates
    : (streamUrl ? [{ streamUrl, sourceProvider }] : []);
  if (!list.length) return false;

  inFlight.add(k);
  queue.push({ animeId, episode, lang, candidates: list, tracks, k });
  console.log(`[r2-queue] encolado ${k} (cola: ${queue.length}, activos: ${active}, candidatos: ${list.length})`);
  processNext();
  return true;
}

function processNext() {
  if (active >= CONCURRENCY || queue.length === 0) return;
  const job = queue.shift();
  active++;
  runJob(job).finally(() => {
    active--;
    inFlight.delete(job.k);
    processNext();
  });
}

async function runJob({ animeId, episode, lang, candidates, tracks, k }) {
  const slug = `${animeId}-${episode}-${lang.toLowerCase()}`;
  const t0 = Date.now();
  for (const { streamUrl, sourceProvider } of candidates) {
    try {
      console.log(`[r2-queue] archivando ${k} -> ${slug} desde ${sourceProvider} ...`);
      const { bytes } = await archiveHlsToR2(streamUrl, slug);
      upsertR2Archive({ animeId, episode, lang, slug, sourceProvider, bytes, tracks });
      console.log(`[r2-queue] listo ${k} en ${((Date.now() - t0) / 1000).toFixed(1)}s, ${(bytes / 1024 / 1024).toFixed(1)} MB (${sourceProvider})`);
      return;
    } catch (e) {
      console.warn(`[r2-queue] ERROR archivando ${k} desde ${sourceProvider}: ${e.message}`);
    }
  }
  console.warn(`[r2-queue] ${k}: fallaron todos los candidatos (${candidates.length})`);
}

export function getQueueStatus() {
  return { queued: queue.length, active, inFlight: [...inFlight] };
}
