// Re-exporta los scrapers disponibles en api_vid/src/providers/
// Nota: los archivos son copias de los originales del root ajustando imports relativos.

export { getLatinoStream } from "./scraper.js";
export {
  getCuevanaStreams,
  getCuevanaMovieStreams,
  getCuevanaAnime,
} from "./scraper-cuevana.js";
export { getAnikotoStreams } from "./scraper-anikoto.js";
export { getMegaplayStreams } from "./scraper-megaplay.js";
export { getMegavidStream } from "./scraper-megavid.js";
export { getCRSubsForAnime, WANTED_ASS_LANGS } from "./scraper-crunchyroll.js";
export { getMiruroStreams } from "./miruro.js";
export { getVaplayerStream } from "./scraper-vaplayer.js";
export { getVidupStream } from "./scraper-vidup.js";
export { getCinejoyStream } from "./scraper-cinejoy.js";
export { getVidcoreStream, getVidrkSubs } from "./scraper-vidcore.js";
export { getVixsrcStream } from "./scraper-vixsrc.js";
export { getReanimeStreams } from "./reanime.js";
export { getAniwavesStreams } from "./scraper-aniwaves.js";
export { getAnimeheavenStreams } from "./scraper-animeheaven.js";
