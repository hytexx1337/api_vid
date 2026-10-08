import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { removeSpamLines, srtToVtt } from "./subtitle-cleaner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SUBS_DIR = path.join(__dirname, "..", "..", "subs-cache");

const VDRK_INDEX_PATH = path.join(SUBS_DIR, "vdrk-index.json");
const CR_INDEX_PATH = path.join(SUBS_DIR, "cr-index.json");

export function readCrIndex() {
  try { return existsSync(CR_INDEX_PATH) ? JSON.parse(readFileSync(CR_INDEX_PATH, "utf8")) : {}; }
  catch { return {}; }
}
export function writeCrIndex(idx) {
  try { writeFileSync(CR_INDEX_PATH, JSON.stringify(idx, null, 2), "utf8"); }
  catch (e) { console.error("[cr-index] write error:", e.message); }
}
export function readVdrkIndex() {
  try { return existsSync(VDRK_INDEX_PATH) ? JSON.parse(readFileSync(VDRK_INDEX_PATH, "utf8")) : {}; }
  catch { return {}; }
}
export function writeVdrkIndex(idx) {
  try { writeFileSync(VDRK_INDEX_PATH, JSON.stringify(idx, null, 2), "utf8"); }
  catch (e) { console.error("[vdrk-index] write error:", e.message); }
}
export function vdrkKey(tmdbId, mediaType, season = 1, episode = 1) {
  return mediaType === "movie" ? `movie:${tmdbId}` : `tv:${tmdbId}:${season}:${episode}`;
}

try {
  if (!existsSync(SUBS_DIR)) mkdirSync(SUBS_DIR, { recursive: true });
} catch (e) {
  console.error(`[subs] No se pudo crear subs-cache: ${e.message}`);
}

export function normalizeSubLabel(label, lang) {
  const src = (label ?? lang ?? "").toLowerCase().trim();
  if (/^(english(\s*(cc|sdh|forced))?|eng)$/i.test(src)) return "English";
  if (/english\s*(cc|sdh)/i.test(src)) return `English (${src.match(/cc|sdh/i)?.[0].toUpperCase()})`;
  if (/^(spanish|español|spa|es)$/i.test(src)) return "Español";
  if (/spanish.*latin|español.*latin|spa.*419|es.*419|es.*la$/i.test(src)) return "Español Latino";
  if (/spanish.*spain|español.*españa/i.test(src)) return "Español (España)";
  return (label ?? lang ?? "").replace(/(^|\s|[(\[])([a-záéíóúüñA-ZÁÉÍÓÚÜÑ])/g, (_m, pre, c) => pre + c.toUpperCase());
}

/**
 * Detecta TYPE y MIME-TYPE de un subtítulo a partir de URL/pathname/format explícito.
 * Orden: fmt > ext url/pathname > fallback "vtt" (lo más común).
 */
export function detectSubtitleType(fileUrlOrPath, knownFormat) {
  const fmt = String(knownFormat || "").toLowerCase().trim();
  const path = String(fileUrlOrPath || "").split("?")[0];
  const extMatch = path.match(/\.(ass|ssa|vtt|srt)(?:$|[/#.])/i);
  const ext = (fmt || (extMatch ? extMatch[1] : "")).toLowerCase();

  switch (ext) {
    case "ass":
    case "ssa":
      return { type: "ass", mimeType: "text/x-ssa" };
    case "srt":
      return { type: "srt", mimeType: "application/x-subrip" };
    case "vtt":
    default:
      return { type: "vtt", mimeType: "text/vtt" };
  }
}

/**
 * Detección SEMÁNTICA de subtítulo desde el label crudo y la URL.
 * Devuelve:
 *   { label:string, lang:string (iso 2 char), kind:"captions"|"subtitles"|"forced",
 *     ai:boolean, cc:boolean, forced:boolean }
 */
export function detectSubtitleMeta(rawLabel, fileUrlOrPath, originalKindHint) {
  const raw = String(rawLabel || "").trim();
  const s = raw.toLowerCase();

  // ── Flags booleanos ──────────────────────────────────────────────────────────
  let ai = /(\bdubtitle\b|\bai\b|\bauto[\s_-]?\w*|\btranslat(ed|ion)\b|\bgenerated\b)/i.test(raw) || (/(^|[-_])ai[-_](sub|dub|cc)/i.test(s));
  // El "(AI)" al final del label es AI fuerte: English Dubtitle(AI)
  const aiStrong = /\bai\b/i.test(raw.replace(/[()\[\]]/g, " ").replace(/\s+/g, " "));
  if (aiStrong && !ai) ai = true;
  let cc = /(\bcc\b|closed[\s_-]?captions?|sdh|\bcaptions?\b)/i.test(raw) || /\bcc\b/i.test(String(originalKindHint || ""));
  let forced = /(\bforced\b|foreign[\s_-]?only|\bfull\b)/i.test(raw) || /(^|[\s_-])f([\s_-]|$)/.test(s);

  // Dubtitle AI = tipo subtitles (no captions) + flag ai=true
  const isDubtitle = /\bdubtitle\b/i.test(raw);

  // ── Normalización del label (QUITAR metadata cruda). Orden:
  //   (0) Reemplazar paréntesis ANIDADOS tipo "(Dubtitle(AI))" o "(Full Subtitles [NeoDESU])"
  //       por sus contenidos internos con un único nivel de delimitadores (así regexes
  //       de paso siguiente pueden distinguir qué es flag qué es contenido real).
  //   (1) Borrar delimitadores ENTEROS cuando TODO su contenido es flag (sólo AI/CC/etc).
  //   (2) Borrar palabras-clave sueltas (fuera de delimitadores).
  //   (3) Colapsar whitespace + limpiar delimitadores VACÍOS.
  //   (4) Limpiar BORDES solo de whitespace + separadores banales (no paréntesis/corchetes
  //       que pertenecen a contenido legítimo como Signs & Songs, NeoDESU, Portuguese(Brazil)).
  let wip = String(raw || "");

  // ── EXTRAER TAGS DE CONTENIDO REAL (preservar antes de cualquier limpieza) ───
  // Ej: "Signs & Songs", "Songs & Signs", "Narration", "Dialog/Dialogue". User
  // pide que aparezcan explícitamente tipo "English (NeoDESU) Signs & Songs".
  const PRESERVED_CONTENT_RE = /\b(signs\s*[&+]\s*songs|songs\s*[&+]\s*signs|signs|songs|narration|dialogue|dialog(?:ue)?)\b/gi;
  const preservedTags = [];
  {
    const rawForScan = String(raw || "");
    let pm;
    while ((pm = PRESERVED_CONTENT_RE.exec(rawForScan)) !== null) {
      const tag = pm[0]
        .replace(/\s*\+\s*/g, " & ")
        .replace(/\s+/g, " ")
        .replace(/\b\w/g, c => c.toUpperCase())
        .trim();
      // Normalizar "Dialog"/"Dialogue" → solo "Dialogue" (evitar duplicados)
      const norm = tag === "Dialog" ? "Dialogue" : tag;
      if (!preservedTags.includes(norm)) preservedTags.push(norm);
    }
  }

  // Paso -1: flatten paréntesis/corchetes ANIDADOS 1 nivel. "(Dubtitle(AI))" → "(Dubtitle AI)".
  for (let i = 0; i < 2; i++) {
    wip = wip
      .replace(/\(([^()]*)\(([^()]*)\)([^()]*)\)/g, (_m, a, b, c) => `(${a} ${b} ${c})`)
      .replace(/\[([^\[\]]*)\[([^\[\]]*)\]([^\[\]]*)\]/g, (_m, a, b, c) => `[${a} ${b} ${c}]`);
  }
  // Fix borde 1: duplicado tipo "Portuguese (-Portuguese Brazil)" → "Portuguese (Brazil)".
  wip = wip.replace(/^([A-Za-zçãõáéíóúüñ]+)\s*\(-\s*\1[\s_-]+([^)]+)\)/i, (_m, lang, rest) => `${lang} (${rest})`);
  // Fix borde 2: brackets DENTRO de paréntesis → QUITAR solo los brackets [] PERO
  // PRESERVAR el texto ANTES ([^()]*?) y DESPUES ([^()]*?) del bracket. Antes perdíamos
  // "Signs & Songs " en "Signs & Songs [NeoDESU]".
  wip = wip.replace(/(\()([^()]*?)\[([A-Za-z0-9_\- &]+)\]([^()]*?)(\))/g, (_m, o, pre, i, post, c) => `${o}${pre}${i}${post}${c}`);
  // Fix borde 2b: igual pero al revés (paréntesis DENTRO de brackets) para no romper nada.
  wip = wip.replace(/(\[)([^\[\]]*?)\(([A-Za-z0-9_\- &]+)\)([^\[\]]*?)(\])/g, (_m, o, pre, i, post, c) => `${o}${pre}${i}${post}${c}`);
  // Fix borde 3: title-case primer letra DENTRO de ()/[] (ej: "(brasil)" → "(Brasil)").
  wip = wip.replace(/([(\[])([a-záéíóúüñ])/g, (_m, d, c) => d + c.toUpperCase());
  // Helper interno para saber si un INTERIOR de ()/[] es SÓLO flags (borrable entero).
  const FLAG_WORDS_RE = "AI|CC|Forced?|SDH|Translated|Generated|Dubtitle|Auto(?:[\\s-][\\w-]+)?|subtitles?|captions?|foreign\\s+only|Full";
  const ONLY_FLAGS_RE = new RegExp(`^\\s*(?:(?:${FLAG_WORDS_RE})[\\s,&+/:|_-]*)+\\s*$`, "i");
  // Paso 0: quitar () enteros cuando TODO lo de adentro es flag.
  wip = wip.replace(/\(([^()]*)\)/g, (m, inside) => ONLY_FLAGS_RE.test(inside) ? " " : m);
  // Paso 0b: igual para [].
  wip = wip.replace(/\[([^\[\]]*)\]/g, (m, inside) => ONLY_FLAGS_RE.test(inside) ? " " : m);
  // Paso 1: palabras clave sueltas.
  wip = wip.replace(new RegExp(`\\b(?:${FLAG_WORDS_RE})\\b`, "gi"), " ");
  // Paso 2: delimitadores vacíos residuales.
  wip = wip
    .replace(/\(\s*\)/g, " ")
    .replace(/\[\s*\]/g, " ")
    // Paso 3: separadores duplicados / whitespace roto.
    .replace(/([(\[])\s+/g, "$1")
    .replace(/\s+([)\]])/g, "$1")
    .replace(/\s*([,/:|_-])\s*/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  // Paso 4: BORDE. Solo quitar whitespace y separadores SIMILARES A DOBLE espacio. No
  // tocar paréntesis/corchetes finales si tienen contenido abierto → ya se
  // encargó el browser de traerlos bien cerrados.
  wip = wip.replace(/^[\s,/:|_-]+|[\s,/:|_-]+$/g, " ").replace(/\s{2,}/g, " ").trim();
  let base = wip;
  if (!base) {
    base = String(raw || "").replace(/[()\[\]]/g, " ").replace(/\s{2,}/g, " ").trim();
  }
  if (!base) base = raw;

  // Armado label final según flags + base. Orden / wording user:
  //   "English (Dubtitle(AI))"            → "English Dubtitle"  (ai=true)
  //   "English (CC)"                      → "English CC"        (cc=true)
  //   "English (Full) Forced" / Foreign   → "English Forced"    (forced=true)
  //   "English (AI Translated)"           → "English"           (ai=true, label limpio)
  let finalLabel;
  if (isDubtitle) {
    // Si el usuario originalmente NO tenía Dubtitle visible PERO era un dubtitle (por regex),
    // agregamos "Dubtitle". Si ya venía Dubtitle y lo limpiamos (ej: "English Dubtitle"
    // era "English" después de quitar flags), volvemos a agregar 1 vez.
    if (!/\bDubtitle\b/i.test(base)) finalLabel = `${base} Dubtitle`.trim();
    else finalLabel = base;
  } else if (forced) {
    if (!/\bForced\b/i.test(base)) finalLabel = `${base} Forced`.trim();
    else finalLabel = base;
  } else if (cc && /\benglish\b/i.test(base)) {
    if (!/\bCC\b/.test(base)) finalLabel = `${base} CC`.trim();
    else finalLabel = base;
  } else {
    // Primero probamos normalizeSubLabel (legacy). Si su lógica title-case posterior
    // rompió capitalización tipo "PortuguêS (Brasil)", lo corregimos.
    const first = normalizeSubLabel(base, null);
    if (first && /[A-ZÁÉÍÓÚÜ][a-záéíóúü]*[^A-Za-záéíóúü][A-ZÁÉÍÓÚÜ]\b/.test(first)) {
      // Title case más inteligente: solo mayúscula la 1ª letra de cada palabra
      // donde la palabra empieza con letra latina y hay whitespace al principio,
      // o la 1ª letra del string completo.
      finalLabel = first
        .toLowerCase()
        .replace(/(^|\s|[(\[])([a-záéíóúüñ])/g, (_m, sp, ch) => sp + ch.toUpperCase())
        .trim();
    } else {
      finalLabel = first || base || "Unknown";
    }
  }
  // Cleanup final: whitespace dobles, borde simple, y asegurar que paréntesis/
  // corchetes estén balanceados (cerrar los que estén abiertos por error de regex).
  finalLabel = finalLabel
    .replace(/\(\s*\)/g, " ")
    .replace(/\[\s*\]/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,/:|_-]+|[\s,/:|_-]+$/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!finalLabel) finalLabel = base || "Unknown";

  // Balance simple de paréntesis/corchetes: si faltan cerraduras al final, agregarlas.
  {
    const opens = (finalLabel.match(/\(/g) || []).length - (finalLabel.match(/\)/g) || []).length;
    const closesq = (finalLabel.match(/\[/g) || []).length - (finalLabel.match(/\]/g) || []).length;
    if (opens > 0) finalLabel = finalLabel + ")".repeat(opens);
    if (closesq > 0) finalLabel = finalLabel + "]".repeat(closesq);
  }

  // ── RE-INSERTAR TAGS DE CONTENIDO REAL PRESERVADOS ──────────────────────────
  // Posición user: "English (NeoDESU) Signs & Songs [Forced/CC/Dubtitle]"
  // Si el tag ya quedó incluido dentro del label (por la limpieza correcta de
  // brackets que ya no borra Signs & Songs), no lo duplicamos.
  if (preservedTags.length) {
    const tagStr = preservedTags.join(" & ");
    const hay = new RegExp(preservedTags.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");
    if (!hay.test(finalLabel)) {
      if (isDubtitle && /\bDubtitle\s*$/i.test(finalLabel)) {
        finalLabel = finalLabel.replace(/\s*Dubtitle\s*$/i, ` ${tagStr} Dubtitle`);
      } else if (forced && /\bForced\s*$/i.test(finalLabel)) {
        finalLabel = finalLabel.replace(/\s*Forced\s*$/i, ` ${tagStr} Forced`);
      } else if (cc && /\bCC\s*$/i.test(finalLabel)) {
        finalLabel = finalLabel.replace(/\s*CC\s*$/i, ` ${tagStr} CC`);
      } else {
        finalLabel = `${finalLabel} ${tagStr}`;
      }
      finalLabel = finalLabel.replace(/\s{2,}/g, " ").trim();
    }
  }

  // ── KIND final ───────────────────────────────────────────────────────────────
  // Reglas user:
  //   captions ↔ cc=true (Closed Captions, incluye descripción de audio no-verbal)
  //   forced   ↔ forced=true
  //   subtitles ↔ el resto normal (ASS / .srt / .vtt sin CC).
  //
  // EXCEPCIÓN user: si es un Dubtitle (AI o no), KIND DEBE ser subtitles,
  // aunque originalmente viniera con hint "captions". Dubtitle != captions reales.
  let kind = "subtitles";
  if (forced) kind = "forced";
  else if (cc && !isDubtitle) kind = "captions";
  const hint = String(originalKindHint || "").toLowerCase();
  if (hint === "captions" && !forced && !isDubtitle && !cc) kind = "captions"; // hint solo si no contradice

  // ── LANG ─────────────────────────────────────────────────────────────────────
  let lang = detectTrackLang(fileUrlOrPath, finalLabel);

  // Paso 1: detección SEMÁNTICA por tokens EN LABEL (SEMPRE corre, incluso si
  // detectTrackLang devolvió algo, para no perder "Latino / España / Brasil"
  // que venían solo en el label).
  const rawLblLow = String(rawLabel || "").toLowerCase();
  const finLblLow = String(finalLabel || "").toLowerCase();
  const combLbl = `${rawLblLow} ${finLblLow}`;
  // Guardia anti-colisión ar: Arabic vs Argentina. País 2-char SOLO si hay
  // contexto Español/Latino evidente en el label.
  const hasESContext = /spanish|español|castellano|lat(in|am)|419|\bes[-_]mx\b|\bes[-_]419\b|\bes[-_]es\b|\bspa(in|ñol)?\b/i.test(combLbl);
  if (/spanish.*latin|español.*latino|\bes-?419\b|\bla(tino|am(?:erica)?)\b/i.test(combLbl)) {
    lang = "es-MX";
  } else if (hasESContext && /(^|\s|[-_])(mx|ar|cl|co|pe|ve|uy|py|bo|ec|gt|pa|hn|sv|ni|do|pr)(\s|[-_]|$)/i.test(combLbl)) {
    lang = "es-MX";
  } else if (/spanish.*spain|español.*(españa|castellano)|castellano|\bes[-_]es\b/i.test(combLbl)) {
    lang = "es-ES";
  } else if (/portugu[êe]s.*brasil|brazil(ian)?|brasileiro|\bpt[-_]br\b/i.test(combLbl)) {
    lang = "pt-BR";
  }

  // Paso 2: fallback por idioma genérico solo si todavía no tenemos nada
  if (!lang || lang === "unknown") {
    const l = finLblLow;
    if (/english|ingl[eé]s|^eng\b/.test(l)) lang = "en";
    else if (/español|spanish|castellano|\bes\b|\bespa\b/.test(l)) lang = "es";
    else if (/portugu[êe]s|brazilian|brasileiro|\bpt\b|\bpor\b/.test(l)) lang = "pt";
    else if (/japon[eé]s|japanese|\bja\b|\bjpn\b/.test(l)) lang = "ja";
    else if (/korean|coreano|\bko\b/.test(l)) lang = "ko";
    else if (/italian[o]?|\bit\b/.test(l)) lang = "it";
    else if (/french|fran[cç]ais|\bfr\b/.test(l)) lang = "fr";
    else if (/german|alem[aã]n|\bde\b/.test(l)) lang = "de";
    else if (/chinese|chino|\bzh\b/.test(l)) lang = "zh";
  }

  // Paso 3: normalizar lang según lo que tenemos hasta ahora (en esta función no
  // tenemos acceso a raw.lang, se maneja después en normalizeSubtitleTrack).
  // Reglas:
  //   • es-419 / latino / cualquier país LATAM → es-MX
  //   • es-ES / spain / castellano → es-ES
  //   • "es" solo SIN tokens → se queda "es" (genérico, NO es España)
  //   • pt-BR / brasil → pt-BR ; "pt" solo → "pt"
  //   • resto de idiomas → truncados a 2 chars ISO
  const rawLangStr = String(lang || "").toLowerCase();
  // GUARDIA ANTI-COLISIÓN: no confundir códigos ISO de idioma (ar=Arabic) con
  // países LATAM (ar=Argentina). Los códigos de país 2-char SOLO se usan si
  // además el label original tiene indicios de ser Español/Latino.
  const hasSpanishLatinContext = /spanish|español|castellano|lat(in|am)|419|\bes[-_]mx\b|\bes[-_]419\b|\bes[-_]es\b|\bspa(in|ñol)?\b/i.test(`${rawLblLow} ${rawLangStr}`);
  if (
    /(^|[-_\s])419($|[-_\s])|lat(in|am(?:erica)?)/i.test(rawLangStr) ||
    (hasSpanishLatinContext &&
      /(^|[-_\s])(mx|ar|cl|co|pe|ve|uy|py|bo|ec|gt|pa|hn|sv|ni|do|pr)($|[-_\s])/i.test(rawLangStr))
  ) {
    lang = "es-MX";
  } else if (/\bes[-_]es\b|spain|castellano|españa/i.test(rawLangStr)) {
    lang = "es-ES";
  } else if (/\bpt[-_]br\b|brazil|brasil/i.test(rawLangStr)) {
    lang = "pt-BR";
  } else {
    const cur = rawLangStr;
    const m = cur.match(/^([a-z]{2,3})(?:[-_].*)?$/);
    if (m) {
      const map3 = { eng: "en", spa: "es", por: "pt", jpn: "ja", fra: "fr", fre: "fr", ger: "de", deu: "de", ita: "it", kor: "ko", chi: "zh", zho: "zh",
        ara: "ar", rus: "ru", hin: "hi", ind: "id", msa: "ms", tha: "th", vie: "vi", nld: "nl", pol: "pl", swe: "sv", tur: "tr", ukr: "uk",
        ell: "el", heb: "he", ron: "ro", ces: "cs", hun: "hu", fin: "fi", dan: "da", nor: "no",
      };
      lang = map3[m[1]] ?? m[1];
    }
  }

  return { label: finalLabel, lang, kind, ai: !!ai, cc: !!cc, forced: !!forced };
}

/**
 * NORMALIZADOR PRINCIPAL de subtítulos. Toma CUALQUIER track crudo (cualquier
 * fuente: reanime, megaplay, CR, vidrk, manual, legacy) y devuelve el contrato
 * NUEVO user enriquecido y consistente. NUNCA muta el objeto original.
 *
 * Output shape GARANTIZADO:
 *   { url:string, label:string, lang:string (iso 2), type:"ass"|"vtt"|"srt",
 *     mimeType:string, kind:"subtitles"|"captions"|"forced",
 *     default:boolean, ai:boolean, cc:boolean, forced:boolean,
 *     ... (available_fonts, extracted_fonts, file, r2, r2Key si existían) }
 */
export function normalizeSubtitleTrack(raw) {
  if (!raw || typeof raw !== "object") return null;

  const url = String(raw.url || raw.file || raw.proxy_url || "");
  const format = raw.format ?? raw.type;
  let { type, mimeType } = detectSubtitleType(url, format);

  // OVERRIDE por metadata ASS-only: available_fonts / extracted_fonts solo
  // existen en archivos .ass (VTT y SRT NO tienen fuentes embebidas).
  // Si alguna de estas keys existe con data, 100% es un ASS real.
  const hasAssFonts =
    (typeof raw.available_fonts === "object" && raw.available_fonts !== null && Object.keys(raw.available_fonts).length > 0) ||
    (Array.isArray(raw.extracted_fonts) && raw.extracted_fonts.length > 0);
  if (hasAssFonts) {
    type = "ass";
    mimeType = "text/x-ssa";
  }

  // Label puede venir en raw.label o raw.lang como fallback; lang raw también es
  // hint pero lo normalizamos a 2 chars ISO siempre antes de meter en meta,
  // así "en-US", "es-419", "es-ES" no aparecen como `cr` o algo raro.
  const rawLabel = raw.label || raw.lang || "";
  const meta = detectSubtitleMeta(rawLabel, url, raw.kind);

  // Override final de lang: respetar raw.lang cuando es locale conocido de
  // Latinoamérica (es-MX) / España (es-ES) / Brasil (pt-BR). El resto se trunca
  // a 2 chars ISO.
  let lang = meta.lang;
  {
    const rl = String(raw.lang || "").toLowerCase();
    const rawLblLowOv = String(raw.label || raw.lang || "").toLowerCase();
    // Guardia anti colisión (igual que detectSubtitleMeta Paso 1/3)
    const hasESCtx = /spanish|español|castellano|lat(in|am)|419|\bes[-_](mx|419|es)\b|\bspa(in|ñol)?\b/i.test(`${rawLblLowOv} ${rl}`);
    if (rl) {
      if (
        /(^|[-_])419($|[-_])|lat(in|am)/i.test(rl) ||
        (hasESCtx && /(^|[-_])(mx|ar|cl|co|pe|ve|uy|py|bo|ec|gt|pa|hn|sv|ni|do|pr)($|[-_])/i.test(rl))
      ) {
        lang = "es-MX";
      } else if (/\bes[-_]es\b|spain|castellano|españa/i.test(rl)) {
        lang = "es-ES";
      } else if (/(^|[-_])(br)($|[-_])|brazil/i.test(rl)) {
        lang = "pt-BR";
      } else if (!lang || lang === "unknown" || lang.length > 5) {
        const m = rl.match(/^([a-z]{2,3})(?:[-_].*)?$/);
        if (m) {
          const map3 = { eng: "en", spa: "es", por: "pt", jpn: "ja", fra: "fr", fre: "fr", ger: "de", deu: "de", ita: "it", kor: "ko", chi: "zh", zho: "zh" };
          const iso = map3[m[1]] ?? m[1];
          const VALID_ISO_FALLBACK = new Set([
            "en","es","pt","ja","fr","de","it","ko","zh","ar","ru","hi","id","ms","th","vi","nl","pl","sv","tr","uk",
            "el","he","ro","cs","hu","fi","da","no","ca","eu","gl","et","lv","lt","sk","sl","hr","bg","sr","mk","bs",
            "sq","is","ga","cy","la","eng","spa","por","jpn","fra","ger","deu","ita","kor","chi","zho","ara","rus",
          ]);
          if (VALID_ISO_FALLBACK.has(iso)) {
            if (iso?.length === 2 && !/^(es|pt)$/.test(iso)) lang = iso;
            else if (!lang || lang === "unknown") lang = iso;
          }
        }
      }
    }
  }

  const out = {
    url,
    label: meta.label,
    lang,
    type,
    mimeType,
    kind: meta.kind,
    default: !!raw.default,
    ai: meta.ai,
    cc: meta.cc,
    forced: meta.forced,
  };

  // Campos legacy / provider-specific que queremos preservar si existen:
  if (typeof raw.label === "string" && raw.label !== out.label) out.rawLabel = raw.label;
  if (typeof raw.proxy_url === "string" && raw.proxy_url !== url) out.proxy_url = raw.proxy_url;
  if (typeof raw.r2 === "boolean") out.r2 = true;
  if (raw.r2Key) out.r2Key = raw.r2Key;
  if (raw.file) out.file = raw.file;
  if (raw.format && raw.format !== type) out.originalFormat = raw.format;
  if (typeof raw.available_fonts === "object" && raw.available_fonts && Object.keys(raw.available_fonts).length) {
    out.available_fonts = raw.available_fonts;
  }
  if (Array.isArray(raw.extracted_fonts) && raw.extracted_fonts.length) {
    out.extracted_fonts = raw.extracted_fonts;
  }
  if (raw.referer) out.referer = raw.referer;

  return out;
}

export function normalizeSubtitleTracks(tracks) {
  if (!Array.isArray(tracks)) return [];
  const out = [];
  const seen = new Set();
  for (const t of tracks) {
    const n = normalizeSubtitleTrack(t);
    if (!n || !n.url) continue;
    const key = `${n.lang}|${n.kind}|${n.type}|${n.ai}|${n.cc}|${n.forced}|${n.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  // Marcar default inteligente: si NINGÚN track vino con default=true,
  // elegimos el 1er subtitles lang=en.
  const hasDefault = out.some(t => t.default);
  if (!hasDefault) {
    const fallback = out.find(t => t.lang === "en" && t.kind !== "forced") || out.find(t => t.kind !== "forced");
    if (fallback) fallback.default = true;
  }
  return out;
}

export function detectTrackLang(fileUrl, label) {
  const fileCode = fileUrl?.match(/\/subs\/(?:ai_)?([a-z]{2,3})_/i)?.[1]?.toLowerCase();
  if (fileCode) {
    const ISO_3MAP = {
      eng: "en", spa: "es", por: "pt", jpn: "ja", fra: "fr", ger: "de", deu: "de",
      ita: "it", kor: "ko", chi: "zh", zho: "zh",
      ara: "ar", rus: "ru", hin: "hi", ind: "id", msa: "ms", tha: "th", vie: "vi",
      nld: "nl", pol: "pl", swe: "sv", tur: "tr", ukr: "uk", ell: "el", heb: "he",
      ron: "ro", ces: "cs", hun: "hu", fin: "fi", dan: "da", nor: "no",
      cat: "ca", eus: "eu", glg: "gl", est: "et", lav: "lv", lit: "lt",
      slk: "sk", slv: "sl", hrv: "hr", bul: "bg", srp: "sr", mkd: "mk",
      bos: "bs", sqi: "sq", isl: "is", gle: "ga", cym: "cy", lat: "la",
    };
    const VALID_ISO = new Set([
      // 2 chars ISO 639-1 reales
      "en", "es", "pt", "ja", "fr", "de", "it", "ko", "zh", "ar", "ru", "hi",
      "id", "ms", "th", "vi", "nl", "pl", "sv", "tr", "uk", "el", "he", "ro",
      "cs", "hu", "fi", "da", "no", "ca", "eu", "gl", "et", "lv", "lt", "sk",
      "sl", "hr", "bg", "sr", "mk", "bs", "sq", "is", "ga", "cy", "la",
      // 3 chars ISO 639-2/3 reales
      "ara", "rus", "hin", "ind", "zho", "msa", "tha", "vie", "nld", "pol",
      "swe", "tur", "ukr", "ell", "heb", "ron", "ces", "hun", "fin", "dan",
      "nor", "cat", "eus", "glg", "est", "lav", "lit", "slk", "slv", "hrv",
      "bul", "srp", "mkd", "bos", "sqi", "isl", "gle", "cym", "lat",
      // 3 chars de nuestro ISO_3MAP
      "eng", "spa", "por", "jpn", "fra", "ger", "deu", "ita", "kor", "chi",
    ]);
    const mapped = ISO_3MAP[fileCode] ?? fileCode;
    if (VALID_ISO.has(mapped)) return mapped;
    // si fileCode no está en whitelist → PROBABLEMENTE es prefijo provider
    // (cr=Crunchyroll, ai=auto-dub, etc.). DESCARTAR y seguir por label.
  }
  const l = (label ?? "").toLowerCase();
  if (l.includes("english")) return "en";
  if (l.includes("spanish") || l.includes("español")) return "es";
  if (l.includes("portuguese") || l.includes("português")) return "pt";
  if (l.includes("japanese") || l.includes("japonés")) return "ja";
  if (l.includes("french")) return "fr";
  if (l.includes("german")) return "de";
  if (l.includes("italian")) return "it";
  if (l.includes("korean")) return "ko";
  if (l.includes("chinese")) return "zh";
  if (l.includes("arabic")) return "ar";
  if (l.includes("russian")) return "ru";
  return "unknown";
}

export async function localizeSubtitle(url, referer = null) {
  if (!url) return url;
  const hash = createHash("sha1").update(url).digest("hex");
  const filename = `${hash}.vtt`;
  const filepath = path.join(SUBS_DIR, filename);

  if (!existsSync(filepath)) {
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept": "*/*",
      ...(referer && { "Referer": referer, "Origin": new URL(referer).origin }),
    };
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      await writeFile(filepath, text, "utf8");
    } catch (e) {
      console.warn(`[subs] no se pudo descargar ${url}: ${e.message}`);
      return url;
    }
  }
  return null; // señal para que el caller use el filename
}

export async function downloadSubtitles(tracks) {
  if (!tracks?.length) return tracks;
  if (!existsSync(SUBS_DIR)) return tracks;

  return Promise.all(tracks.map(async (t) => {
    if (t.file) return { ...t, _localFile: t.file };
    if (/\.ass(\?|$)/i.test(t.url)) return t;

    const hash = createHash("sha1").update(t.url).digest("hex");
    // Siempre se guarda como .vtt: los .srt se convierten al vuelo (WebVTT es
    // lo único que <track> / hls.js soportan nativamente — servir un .srt
    // renombrado o con extensión propia no lo hace parseable en el browser).
    const isSrt = /\.srt(\?|$)/i.test(t.url);
    const filename = `${hash}.vtt`;
    const filepath = path.join(SUBS_DIR, filename);

    if (!existsSync(filepath)) {
      const referer = t.referer ?? t.proxy_url ?? null;
      const headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "*/*",
        ...(referer && { "Referer": referer, "Origin": (() => { try { return new URL(referer).origin; } catch { return referer; } })() }),
      };
      try {
        const r = await fetch(t.url, { headers, signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        let subText = removeSpamLines(await r.text());
        if (isSrt) subText = srtToVtt(subText);
        await writeFile(filepath, subText, "utf8");
      } catch (e) {
        console.warn(`[subs] fallo descarga ${t.url}: ${e.message}`);
        return t;
      }
    }

    const { referer: _r, proxy_url: _p, ...rest } = t;
    return { ...rest, _localFile: filename };
  }));
}

export async function getVidrkSubsWithIndex(tmdbId, mediaType, season = 1, episode = 1, title = null) {
  const key = vdrkKey(tmdbId, mediaType, season, episode);
  const idx = readVdrkIndex();
  if (idx[key]?.subtitles?.length) return idx[key].subtitles;

  // Import dynamically to avoid circular dependency with providers/index.js
  const { getVidrkSubs } = await import("../providers/index.js");
  const rawSubs = await getVidrkSubs(tmdbId, mediaType, season, episode);
  if (!rawSubs.length) return [];
  const downloaded = await downloadSubtitles(rawSubs);
  const indexedSubs = downloaded
    .filter(t => t._localFile)
    .map(t => ({ label: t.label, lang: t.lang, file: t._localFile, kind: t.kind ?? "captions", default: t.default ?? false }));
  if (indexedSubs.length) {
    idx[key] = { title, cachedAt: new Date().toISOString(), subtitles: indexedSubs };
    writeVdrkIndex(idx);
    return indexedSubs;
  }
  return rawSubs;
}

export async function buildTracks(rawTracks, proxyBase) {
  if (!rawTracks?.length) return [];
  const downloaded = await downloadSubtitles(rawTracks);
  const hydrated = downloaded.map(t => {
    if (t._localFile) {
      const { _localFile, referer: _r, proxy_url: _p, ...rest } = t;
      return { ...rest, url: `${proxyBase}/subs/${_localFile}` };
    }
    if (t.referer) {
      return { ...t, proxy_url: `${proxyBase}/fetch?url=${encodeURIComponent(t.url)}&ref=${encodeURIComponent(t.referer)}&ct=${encodeURIComponent("text/vtt")}` };
    }
    return t;
  });
  return normalizeSubtitleTracks(hydrated);
}
