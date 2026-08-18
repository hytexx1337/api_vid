import express, { Router } from "express";
import path from "path";
import { existsSync } from "fs";
import { readVdrkIndex, writeVdrkIndex, readCrIndex, writeCrIndex } from "../lib/subtitles.js";

const router = Router();

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

export default router;
