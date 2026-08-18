# Plan de refactor: `api_vid/`

Objetivo: reemplazar el monolito `index.js` por una API organizada en módulos, sin romper endpoints ni perder funcionalidad.

Stack: **Node/Express + Python sidecar** (Python solo para Miruro y cualquier provider que requiera TLS fingerprinting).

---

## 1. Estructura de carpetas propuesta

```
api_vid/
├── package.json
├── src/
│   ├── index.js                 # Entry point: Express + middleware + montaje de routers
│   ├── config/
│   │   └── constants.js         # TMDB bearer, headers globales, TTLs, allowed origins, env wrappers
│   ├── lib/
│   │   ├── cache.js             # TTL memory cache (cacheGet/cacheSet), timers, expiración periódica
│   │   ├── http.js              # fetch helpers, undici proxy, timeouts, retry
│   │   ├── proxy.js             # getProxyBase, setCacheForResponse, proxyFetch, rewriteM3U8, registrableDomain
│   │   ├── subtitles.js         # buildTracks, downloadSubtitles, localizeSubtitle, normalizeSubLabel, detectTrackLang
│   │   ├── stream-formatter.js  # makeCuevanaStream, makeVidlinkStream, makeVidsrcStream, makeGenericStream, makeAnimeStream, etc.
│   │   └── vidnest.js           # decodeVidnest, normalizeVidnest, vidnestFetch, formatSources
│   ├── metadata/
│   │   ├── tmdb.js              # fetchTmdbMeta
│   │   ├── anilist.js           # anilistToMal, getAnimeSkip, getIntroSkip
│   │   └── index.js             # resolvers comunes de metadata
│   ├── providers/               # Un archivo por fuente
│   │   ├── animeav1.js          # scraper.js -> getLatinoStream
│   │   ├── cuevana.js           # scraper-cuevana.js -> getCuevanaStreams, getCuevanaMovieStreams, getCuevanaAnime
│   │   ├── anikoto.js           # scraper-anikoto.js -> getAnikotoStreams
│   │   ├── megaplay.js          # scraper-megaplay.js -> getMegaplayStreams
│   │   ├── twodhive.js          # scraper-2dhive.js -> getTwoDHiveStreams + hlsContentStore
│   │   ├── crunchyroll.js       # scraper-crunchyroll.js -> getCRSubsForAnime
│   │   ├── miruro.js            # miruro.js -> getMiruroStreams
│   │   ├── vidlink.js           # scraper-vidlink.js -> getVidlinkStream
│   │   ├── videasy.js           # scraper-videz.js -> getVideasyStream(s)
│   │   ├── vaplayer.js          # scraper-vaplayer.js -> getVaplayerStream
│   │   ├── vidup.js             # scraper-vidup.js -> getVidupStream
│   │   ├── cinejoy.js           # scraper-cinejoy.js -> getCinejoyStream
│   │   ├── vidrk.js             # scraper-vidcore.js -> getVidrkSubs
│   │   ├── vidcore.js           # scraper-vidcore.js -> getVidcoreStream
│   │   ├── vixsrc.js            # scraper-vixsrc.js -> (si sigue activo)
│   │   └── index.js             # orquestador: getStreams({tmdbId/anilistId, type, season, episode}) -> {sub:[], dub:[]}
│   ├── routes/
│   │   ├── proxy.js             # /proxy, /ts-proxy, /fetch, /mp4-proxy, /generic-stream, /generic-seg, /generic-media, /aes-key, /vidlink-*, /upn-*, /kai-*, /vix-stream, /dash-proxy, /dash-seg, /2dhive-hls, /ghost-proxy, /sealed
│   │   ├── streams.js           # /movie/:tmdbId, /tv/:tmdbId/:season/:episode, /anime/:anilistId/:episode
│   │   ├── subtitles.js         # /subtitles/movie/:tmdbId, /subtitles/tv/:tmdbId/:season/:episode, /subtitles/anime/:anilistId/:episode
│   │   ├── providers.js         # /movie/:tmdbId/:provider, /tv/:tmdbId/:season/:episode/:provider
│   │   ├── debug.js             # /debug/raw, /debug/sources, /debug/anime/:anilistId/:episode
│   │   └── admin.js             # /admin/subs, /admin/api/subs-index, /admin/api/cr-index
│   └── worker/                  # sidecars Python (si se necesitan en api_vid)
│       └── miruro.py            # microservicio de Miruro (puerto configurable)
├── tests/
│   └── ...                      # tests por provider
└── README.md
```

---

## 2. Mapeo real de providers por endpoint (basado en `index.js` actual)

### `GET /movie/:tmdbId`
- **Vidrk subs:** `getVidrkSubsWithIndex(tmdbId, "movie", 1, 1)`
- **Vaplayer:** `getVaplayerStream(tmdbId, "movie")`
- **Vidup:** `getVidupStream(tmdbId, "movie")`
- **Cuevana:** `getCuevanaMovieStreams(tmdbMeta.imdbId)` (requiere imdbId)
- **Cinejoy:** `getCinejoyStream({ tmdbId, mediaType:"movie", title, year, imdbId })`
- **Videasy:** `getVideasyStream(tmdbId, "movie", 1, 1, { title, year, imdbId })`

### `GET /tv/:tmdbId/:season/:episode`
- **Vidrk subs:** `getVidrkSubsWithIndex(tmdbId, "tv", season, episode)`
- **Vaplayer:** `getVaplayerStream(tmdbId, "tv", season, episode)`
- **Vidup:** `getVidupStream(tmdbId, "tv", season, episode)`
- **Cuevana:** `getCuevanaStreams(tmdbMeta.imdbId, season, episode)`
- **IntroSkip:** `getIntroSkip(tmdbMeta.imdbId, season, episode)`
- **Cinejoy:** `getCinejoyStream({ tmdbId, mediaType:"tv", title, year, imdbId, season, episode })`
- **Videasy:** `getVideasyStream(tmdbId, "tv", season, episode, { title, year, imdbId })`

### `GET /anime/:anilistId/:episode`
- **Animeav1:** `getLatinoStream(anilistId, episode)` -> `{ streams: [...] }`
- **Megaplay:** `getMegaplayStreams(anilistId, episode)` -> `{ dub, sub }`
- **Cuevana:** `getCuevanaAnime(anilistId, episode)` (usado si no hay dub latino)
- **Crunchyroll subs:** `getCRSubsForAnime(anilistId, episode)`
- **Miruro:** `getMiruroStreams(anilistId, episode)` -> `{ dub, sub }`
- **2dhive:** `getTwoDHiveStreams(anilistId, episode)` -> `{ dub, sub }`
- **Anikoto:** `getAnikotoStreams(anilistId, episode)` -> `{ dub, sub }`
- **AniSkip:** `getAnimeSkip(malId, episode)`

### Per-provider routes (`/movie/:tmdbId/:provider`, `/tv/.../:provider`)
Providers soportados: `cuevana`, `vaplayer`, `vidup`, `cinejoy`.

### Subtitles routes (`/subtitles/movie/:tmdbId`, `/subtitles/tv/:tmdbId/:season/:episode`)
Actualmente usa `vidnestFetch("subtitles/...")`. NUEVO objetivo: endpoint unificado que devuelva tracks con idioma/label/url (no incrustados en streams).

### Debug routes
- `/debug/raw?...`
- `/debug/sources?...`
- `/debug/anime/:anilistId/:episode`

### Admin routes
- `/admin/subs`
- `/admin/api/subs-index`, `/admin/api/cr-index`

---

## 3. Módulos críticos a extraer

### 3.1 Cache (`src/lib/cache.js`)
- `cacheGet(key)` / `cacheSet(key, value, ttlMs)`
- Limpieza periódica cada 5 minutos.
- Reemplaza la instancia actual en `index.js`.

### 3.2 HTTP / Proxy helpers (`src/lib/proxy.js`)
- `getProxyBase(req)`
- `setCacheForResponse(res, contentType, urlHint)`
- `proxyFetch(url, headers, timeout)` (undici + fetch nativo para flixcloud.cc)
- `rewriteM3U8(content, baseUrl, proxyBase, extraHeaders)`
- `parsHeaders(raw)`
- `registrableDomain(hostname)`

### 3.3 Subtítulos (`src/lib/subtitles.js`)
- `downloadSubtitles(tracks)` -> descarga a `subs-cache/`
- `buildTracks(rawTracks, proxyBase)` -> tracks con URL local o proxy
- `normalizeSubLabel(label, lang)`
- `detectTrackLang(fileUrl, label)`
- Funciones de índice CR/vidrk (`readCrIndex`, `writeCrIndex`, `readVdrkIndex`, `writeVdrkIndex`, `vdrkKey`)

### 3.4 Stream formatters (`src/lib/stream-formatter.js`)
- `makeCuevanaStream(result, req)`
- `makeVidlinkStream(result, proxyBase, lang, sharedSubs)`
- `makeVidsrcStream(result, proxyBase, sharedSubs)`
- `makeGenericStream(result, proxyBase, sharedSubs, lang)`
- `makeAnimeStream(proxyBase, url, quality, lang, provider, opts)`
- `resolveProxyUrlByType(result, proxyBase, ref)`
- `sortStreams(streams)`
- `buildSharedSubtitles(vixsrc, proxyBase)`

### 3.5 VidNest helpers (`src/lib/vidnest.js`)
- `decodeVidnest(data)`
- `normalizeVidnest(data, server)`
- `vidnestFetch(path)`
- `formatSources(raw, meta, req)`
- Constantes: `HEADERS`, `BASE_URL`, `VIDNEST_SERVERS`, `SERVER_HEADERS`, `VIDNEST_ALPHA`

### 3.6 Metadata (`src/metadata/`)
- `fetchTmdbMeta(tmdbId, mediaType)`
- `anilistToMal(anilistId)`
- `getAnimeSkip(malId, episode)`
- `getIntroSkip(imdbId, season, episode)`

---

## 4. Nuevo endpoint de subtítulos

El objetivo es separar subtítulos de streams.

### `GET /subtitles/:type/:id/:season?/:episode?`
- `type` = `movie` | `tv` | `anime`
- Para movie/tv: mergear `vidrkSubs` + tracks de `vidlink`.
- Para anime: mergear CR subs + vidrk + tracks propios de providers.

Respuesta:
```json
{
  "subtitles": [
    { "label": "English", "lang": "en", "url": "...", "kind": "subtitles", "default": true },
    { "label": "Español Latino", "lang": "es-419", "url": "...", "kind": "subtitles" },
    { "label": "Español", "lang": "es", "url": "...", "kind": "subtitles" }
  ]
}
```

En el endpoint de streams, los subtítulos se dejan vacíos o se referencia el endpoint `/subtitles/...` para que el player los pida aparte.

---

## 5. Orden de migración sugerido

1. **Infraestructura base:**
   - `src/lib/cache.js`
   - `src/lib/http.js`
   - `src/lib/proxy.js`
   - `src/lib/subtitles.js`
   - `src/config/constants.js`

2. **Metadata y formatters:**
   - `src/metadata/tmdb.js`
   - `src/metadata/anilist.js`
   - `src/lib/stream-formatter.js`
   - `src/lib/vidnest.js`

3. **Providers (uno por uno, con test individual):**
   - `src/providers/vaplayer.js`
   - `src/providers/vidup.js`
   - `src/providers/videasy.js`
   - `src/providers/cinejoy.js`
   - `src/providers/cuevana.js`
   - `src/providers/animeav1.js`
   - `src/providers/megaplay.js`
   - `src/providers/anikoto.js`
   - `src/providers/twodhive.js`
   - `src/providers/miruro.js` (o microservicio Python)
   - `src/providers/vidlink.js`
   - `src/providers/vidrk.js`

4. **Routes:**
   - `src/routes/proxy.js` (más grande, mover primero)
   - `src/routes/streams.js`
   - `src/routes/subtitles.js`
   - `src/routes/providers.js`
   - `src/routes/debug.js`
   - `src/routes/admin.js`

5. **Entry point:**
   - `src/index.js` monta todo.

6. **Tests y QA:**
   - `node --check src/index.js`
   - Probar `/movie/...`, `/tv/...`, `/anime/...` y al menos un proxy.

---

## 6. Notas de compatibilidad

- Los scrapers originales (`scraper-*.js`) siguen funcionando en el root; `api_vid` puede importarlos como punto de partida (`../../scraper-X.js`) mientras se portan.
- El microservicio Python de Miruro (`asd.py`) puede seguir corriendo en el puerto actual y ser llamado desde `src/providers/miruro.js`.
- No se elimina `index.js` original hasta que `api_vid` esté 100% validado.
- El sellado de URLs (`proxy-seal.js`) se mantiene en `src/lib/proxy.js` o se importa directamente.

---

## 7. Próximo paso inmediato

Empezar por el **módulo de providers** con un solo provider de punta a punta (por ejemplo `vaplayer` o `megaplay`) para validar la nueva estructura, y luego seguir con los demás.
