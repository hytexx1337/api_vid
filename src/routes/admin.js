import express, { Router } from "express";
import path from "path";
import { existsSync } from "fs";
import { readVdrkIndex, writeVdrkIndex, readCrIndex, writeCrIndex } from "../lib/subtitles.js";
import {
  listPersistedKeys, cacheDelete,
  listAllR2Archive, upsertR2Archive, deleteR2Archive,
  listAllManualTracks, addManualTrack, deleteManualTrack,
} from "../lib/cache.js";
import { verifyAnimeCache } from "../lib/stream-verifier.js";
import { API_KEY } from "../config/constants.js";

const router = Router();

// /admin está en el whitelist de PROXY_PATH (index.js), así que el auth global
// no aplica acá. Las rutas de escritura/registro que usa el panel externo
// (r2-panel en el VPS) llevan su propio check de API_KEY.
function requireApiKey(req, res, next) {
  if (!API_KEY) return next(); // sin API_KEY configurada, no hay nada que chequear
  const key = req.headers["x-api-key"] ?? req.query.key;
  if (key === API_KEY) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

router.get("/admin/api/stream-cache", (req, res) => {
  res.json({ keys: listPersistedKeys("streams:") });
});

router.delete("/admin/api/stream-cache/:key", (req, res) => {
  cacheDelete(decodeURIComponent(req.params.key));
  res.json({ ok: true });
});

router.post("/admin/api/verify-anime-cache", async (req, res) => {
  try {
    const result = await verifyAnimeCache();
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/admin/subs", (req, res) => {
  const html = path.join(process.cwd(), "..", "admin-subs.html");
  if (!existsSync(html)) return res.status(404).send("Panel no encontrado: admin-subs.html");
  res.sendFile(html);
});

router.get("/admin/api/subs-index", (req, res) => { res.json(readVdrkIndex()); });

router.put("/admin/api/subs-index/:key", express.json(), (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const idx = readVdrkIndex();
    if (!idx[key]) return res.status(404).json({ error: "Entry not found" });
    idx[key] = { ...idx[key], ...req.body, subtitles: req.body.subtitles ?? idx[key].subtitles };
    writeVdrkIndex(idx);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/admin/api/subs-index/:key", (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const idx = readVdrkIndex();
    delete idx[key];
    writeVdrkIndex(idx);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/admin/api/cr-index", (req, res) => { res.json(readCrIndex()); });

router.put("/admin/api/cr-index/:key", express.json(), (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const idx = readCrIndex();
    if (!idx[key]) return res.status(404).json({ error: "Entry not found" });
    idx[key] = req.body.subtitles ?? req.body;
    writeCrIndex(idx);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/admin/api/cr-index/:key", (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const idx = readCrIndex();
    delete idx[key];
    writeCrIndex(idx);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Registro manual de archivos R2 (panel externo r2-panel) ──────────────────
// El VPS externo hace el trabajo pesado (descargar el m3u8 con sus headers y
// subir segmentos + subs a R2); acá solo se registra en la DB para que el
// episodio aparezca servido en /anime/:id/:episode.

// Langs válidos = los grupos que streams.js sabe servir desde r2_archive.
const VALID_ARCHIVE_LANGS = new Set(["ESP-LAT", "ENG-DUB", "JAP-ES-HS", "JAP-EN-HS"]);

// Listado completo: lo que ya está archivado + tracks manuales, para que el
// panel pueda mostrar todo y avisar antes de sobreescribir.
router.get("/admin/api/r2-archive", requireApiKey, (req, res) => {
  res.json({ archives: listAllR2Archive(), manualTracks: listAllManualTracks() });
});

// Registra un episodio ya subido a R2 por el panel.
// Body: { animeId, episode, lang, slug, bytes?, sourceProvider?,
//         subs?: [{ file, label, lang, kind? }] }
// El slug DEBE ser `${animeId}-${episode}-${lang.toLowerCase()}` — se valida
// acá para que nadie registre un path arbitrario del bucket.
router.post("/admin/api/register-archive", requireApiKey, express.json(), (req, res) => {
  try {
    const { animeId, episode, lang, slug, bytes, sourceProvider, subs } = req.body || {};
    if (!animeId || !episode || !lang || !slug) {
      return res.status(400).json({ error: "Faltan campos: animeId, episode, lang, slug" });
    }
    if (!VALID_ARCHIVE_LANGS.has(lang)) {
      return res.status(400).json({ error: `lang inválido: ${lang}. Válidos: ${[...VALID_ARCHIVE_LANGS].join(", ")}` });
    }
    const expectedSlug = `${animeId}-${episode}-${lang.toLowerCase()}`;
    if (slug !== expectedSlug) {
      return res.status(400).json({ error: `slug inválido: se esperaba "${expectedSlug}"` });
    }

    upsertR2Archive({
      animeId, episode, lang, slug,
      sourceProvider: sourceProvider || "manual",
      bytes: bytes ?? null,
    });

    const subsRegistered = [];
    for (const s of Array.isArray(subs) ? subs : []) {
      if (!s?.file || !s?.label || !s?.lang) continue;
      // Sanitizar: file es solo el nombre del objeto bajo subs/, sin path.
      const file = path.basename(String(s.file));
      if (addManualTrack({ animeId, episode, lang: s.lang, label: s.label, file, kind: s.kind || "subtitles" })) {
        subsRegistered.push(file);
      }
    }

    console.log(`[admin] register-archive ${animeId} ep${episode} ${lang} → ${slug} (${subsRegistered.length} subs)`);
    res.json({ ok: true, slug, subsRegistered });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/admin/api/r2-archive/:animeId/:episode/:lang", requireApiKey, (req, res) => {
  try {
    deleteR2Archive(req.params.animeId, req.params.episode, req.params.lang);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/admin/api/manual-tracks/:id", requireApiKey, (req, res) => {
  try {
    deleteManualTrack(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
