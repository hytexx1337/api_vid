import { detectSubtitleMeta, detectSubtitleType, normalizeSubtitleTrack, normalizeSubtitleTracks } from "../src/lib/subtitles.js";

const unitCases = [
  {
    name: "English (Dubtitle(AI)) — user ejemplo 1",
    input: { label: "English (Dubtitle(AI))", url: "http://localhost:8000/fetch?s=k9jno-83l8TvOAHvALaRN-...", kind: "captions" },
    expect: { label: "English Dubtitle", lang: "en", type: "vtt", mimeType: "text/vtt", kind: "subtitles", ai: true, cc: false, forced: false },
  },
  {
    name: "English CC — user ejemplo captions",
    input: { label: "English CC", format: "vtt", url: "https://cdn.../subs/en_cc.vtt" },
    expect: { label: "English CC", lang: "en", type: "vtt", mimeType: "text/vtt", kind: "captions", ai: false, cc: true, forced: false },
  },
  {
    name: "English plano user ejemplo",
    input: { label: "English", url: "https://cdn.../subs/eng_default.vtt" },
    expect: { label: "English", lang: "en", type: "vtt", mimeType: "text/vtt", kind: "subtitles", ai: false, cc: false, forced: false },
  },
  {
    name: "English Forced ASS — user ejemplo",
    input: { label: "English Forced", format: "ass", url: "https://cdn.../subs/en_forced.ass?token=123" },
    expect: { label: "English Forced", lang: "en", type: "ass", mimeType: "text/x-ssa", kind: "forced", ai: false, cc: false, forced: true },
  },
  {
    name: "Español ASS user ejemplo",
    input: { label: "Español", format: "ass", url: "https://example.com/subtitles/spa_419_master.ass", default: true },
    expect: { label: "Español", lang: "es", type: "ass", mimeType: "text/x-ssa", kind: "subtitles", default: true, ai: false, cc: false, forced: false },
  },
  {
    name: "Español Latino vtt legacy",
    input: { label: "Spanish (Latin America)", url: "https://flixcloud.cc/subs/spa_419_track.vtt" },
    expect: { label: "Español Latino", lang: "es-MX", type: "vtt", kind: "subtitles" },
  },
  {
    name: "Español (España) srt",
    input: { label: "Spanish (Spain)", url: "https://foo/srt/spa_es_track.srt" },
    expect: { label: "Español (España)", lang: "es-ES", type: "srt", mimeType: "application/x-subrip" },
  },
  {
    name: "Español Latino crudo (caso user)",
    input: { label: "Español latino", format: "ass", url: "http://localhost:8000/subs/cr_7a044ded6325f9a98740983a7297f25859b5c034.ass" },
    expect: { label: "Español Latino", lang: "es-MX", type: "ass", mimeType: "text/x-ssa", kind: "subtitles" },
  },
  {
    name: "raw.lang=es-419 → es-MX",
    input: { label: "Spanish", lang: "es-419", url: "https://foo/spa_lat.vtt" },
    expect: { lang: "es-MX", kind: "subtitles" },
  },
  {
    name: "raw.lang=es-ES → es-ES",
    input: { label: "Español", lang: "es-ES", url: "https://foo/spa_es.vtt" },
    expect: { lang: "es-ES", kind: "subtitles" },
  },
  {
    name: "raw.lang=pt-BR → pt-BR",
    input: { label: "Português", lang: "pt-BR", url: "https://foo/por_br.vtt" },
    expect: { lang: "pt-BR", kind: "subtitles" },
  },
  {
    name: "English (AI Translated)",
    input: { label: "English (AI Translated)", url: "https://cdn/.../en.vtt" },
    expect: { label: "English", kind: "subtitles", ai: true, cc: false, forced: false },
  },
  {
    name: "English [CC] Captions hint",
    input: { label: "English [CC]", url: "/subs/eng_cc.vtt", kind: "captions" },
    expect: { label: "English CC", kind: "captions", cc: true, ai: false, forced: false },
  },
  {
    name: "Japanese (Forced)",
    input: { label: "Japanese (Forced)", url: "https://cdn/subtitles/jpn_forced.vtt" },
    expect: { label: "Japanese Forced", lang: "ja", kind: "forced", forced: true },
  },
  {
    name: "Dubtitle AI sin paréntesis",
    input: { label: "English Dubtitle AI Generated", url: "https://cdn/en.vtt" },
    expect: { label: "English Dubtitle", kind: "subtitles", ai: true },
  },
  {
    name: "Portuguese Brazil",
    input: { label: "Português (Brasil)", url: "https://foo/por_br.vtt" },
    expect: { lang: "pt-BR", kind: "subtitles" },
  },
  {
    name: "FIX 1: Portuguese duplicado (-Portuguese Brazil) → (Brazil)",
    input: { label: "Portuguese (-Portuguese Brazil)", url: "https://foo/pt_br.vtt" },
    expect: { label: "Portuguese (Brazil)", lang: "pt-BR", kind: "subtitles", ai: false, cc: false, forced: false },
  },
  {
    name: "FIX 2: ([NeoDESU]) brackets dentro de paréntesis → (NeoDESU)",
    input: { label: "English ([NeoDESU]) Forced", format: "ass", url: "https://cdn/en_forced.ass" },
    expect: { label: "English (NeoDESU) Forced", lang: "en", type: "ass", kind: "forced", forced: true },
  },
  {
    name: "FIX 3: (brasil) minúscula → (Brasil) mayúscula interior",
    input: { label: "Português (brasil)", url: "https://foo/pt_br.vtt" },
    expect: { label: "Português (Brasil)", lang: "pt-BR", kind: "subtitles" },
  },
  {
    name: "NEW: Signs & Songs + [NeoDESU] dentro paréntesis NO se pierde",
    input: { label: "English (Signs & Songs [NeoDESU])", url: "https://foo/en_signs.vtt" },
    expect: { label: "English (Signs & Songs NeoDESU)", lang: "en", kind: "subtitles", forced: false },
  },
  {
    name: "NEW: Full Subtitles Signs&Songs [NeoDESU] = Forced + Signs&Songs preserved",
    input: { label: "English (Full Subtitles Signs & Songs [NeoDESU])", url: "https://foo/en_forced.vtt" },
    expect: { label: "English (Signs & Songs NeoDESU) Forced", lang: "en", kind: "forced", forced: true },
  },
  {
    name: "NEW USER CASE: English (Dialogue) + available_fonts (ASS override)",
    input: {
      label: "English (Dialogue)",
      url: "http://localhost:8000/fetch?s=selladoxxx",
      default: true,
      available_fonts: { "ADHOC": "https://foo/ADHOC.ttf", "GANDHISANS-BOLD": "https://foo/GANDHISANS-BOLD.otf" },
      extracted_fonts: ["https://foo/ADHOC.ttf", "https://foo/GANDHISANS-BOLD.otf"],
    },
    expect: { type: "ass", mimeType: "text/x-ssa", default: true, kind: "subtitles", forced: false },
  },
  {
    name: "BUG FIX: filename cr_* = Crunchyroll NO es lang='cr', label=English → lang=en",
    input: {
      url: "http://localhost:8000/subs/cr_837abc8cbc8a8b3ca3d72bb5e34b785093959c67.ass",
      label: "English",
      lang: "cr",  // raw.lang "cr" provider id
    },
    expect: { lang: "en", type: "ass", mimeType: "text/x-ssa", cc: false, forced: false },
  },
  {
    name: "BUG FIX: filename cr_* English CC con raw.lang=cr → lang=en kind=captions cc=true",
    input: {
      url: "http://localhost:8000/subs/cr_7a044ded6325f9a98740983a7297f25859b5c034.vtt",
      label: "English CC",
      lang: "cr",
    },
    expect: { lang: "en", kind: "captions", cc: true, type: "vtt" },
  },
  {
    name: "FIX Arabic label → lang=ar (anti unknown fallback)",
    input: { label: "Arabic", url: "https://foo/ar.vtt" },
    expect: { lang: "ar" },
  },
  {
    name: "FIX Russian label → lang=ru (anti unknown fallback)",
    input: { label: "Russian", url: "https://foo/ru.vtt" },
    expect: { lang: "ru" },
  },
];

console.log("=== Unit Tests: detect + normalize ===");
let passed = 0, failed = 0;
for (const c of unitCases) {
  const t = normalizeSubtitleTrack(c.input);
  const issues = [];
  for (const k of Object.keys(c.expect || {})) {
    const want = c.expect[k], got = t[k];
    if (typeof want === "boolean" ? !!got !== want : String(got).toLowerCase() !== String(want).toLowerCase()) {
      issues.push(`  ❌ ${k}: expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
    }
  }
  if (issues.length) { failed++; console.log(`FAIL [${c.name}]:`); issues.forEach(i => console.log(i)); console.log("   full track:", JSON.stringify(t)); }
  else { passed++; console.log(`✅ [${c.name}] → label="${t.label}" lang=${t.lang} kind=${t.kind} type=${t.type} ai=${t.ai} cc=${t.cc} forced=${t.forced}`); }
}
console.log(`\nUnit total: ${passed} passed, ${failed} failed`);

// ── Hit real /anime/170130/2 ──────────────────────────────────────────────────
import crypto from "node:crypto";
const API = "http://localhost:8000";
const KEY = process.env.TEST_API_KEY || "Monitor1337!";
const b64d = s => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
function dec(b) {
  if (!b || b.encrypted !== true) return b;
  const iv = b64d(b.iv), dek = b64d(b.key), raw = b64d(b.data);
  const tag = raw.subarray(raw.length - 16), ct = raw.subarray(0, raw.length - 16);
  const d = crypto.createDecipheriv("aes-256-gcm", dek, iv); d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8"));
}
console.log("\n=== Real /anime/170130/2 tracks ===");
const r = await fetch(`${API}/anime/170130/2?key=${encodeURIComponent(KEY)}`);
const body = dec(await r.json());
const tracks = body.tracks || body.subtitles || [];
console.log("status:", r.status, " tracks/subtitles:", tracks.length);
if (tracks.length === 0) {
  console.log("No tracks — probablemente cache frío.");
} else {
  const REQUIRED = ["url", "label", "lang", "type", "mimeType", "kind", "default", "ai", "cc", "forced"];
  for (const t of tracks) {
    const missing = REQUIRED.filter(k => !(k in t));
    const shape = missing.length ? `  ❌ MISSING: ${missing.join(",")}` : "  ✅ shape completo (9 campos obligatorios + url=10 total)";
    console.log(`• label="${t.label}" lang=${t.lang} kind=${t.kind} type=${t.type} mime=${t.mimeType} ai=${t.ai} cc=${t.cc} forced=${t.forced} default=${t.default}${shape}`);
    if (t.available_fonts) console.log(`    available_fonts keys: ${Object.keys(t.available_fonts).length} fonts present`);
    if (t.rawLabel && t.rawLabel !== t.label) console.log(`    rawLabel original crudo: "${t.rawLabel}" → limpio="${t.label}"`);
    if (t.extracted_fonts?.length) console.log(`    extracted_fonts: ${t.extracted_fonts.length}`);
  }
}
console.log("\nDone.");
