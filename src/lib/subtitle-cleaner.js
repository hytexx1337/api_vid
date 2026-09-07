/**
 * subtitle-cleaner.js — Limpia archivos de subtítulos locales.
 * Elimina líneas de spam (por dominio) y las metadata de publicidad.
 */

const DEFAULT_SPAM_DOMAINS = ["hoofoot.ru"];

export function removeSpamLines(text, spamDomains = DEFAULT_SPAM_DOMAINS) {
  return text
    .split("\n")
    .filter(line => !spamDomains.some(domain => line.includes(domain)))
    .join("\n");
}

export function isSpamLine(line, spamDomains = DEFAULT_SPAM_DOMAINS) {
  return spamDomains.some(domain => line.includes(domain));
}

// Convierte SRT a WebVTT: header WEBVTT + separador de milisegundos "," -> "."
// en los timestamps. Los índices numéricos de cue (líneas sueltas con solo
// dígitos) se dejan como están — WebVTT los acepta como cue identifier.
export function srtToVtt(srtText) {
  const text = srtText.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const withDots = text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
  return `WEBVTT\n\n${withDots.trim()}\n`;
}
