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
