# Auditoría Técnica — Endpoints de streams/subtítulos de Vidnest API

## A. Resumen ejecutivo

### Síntoma reportado
El player (`server.js`) recibe `502 Bad Gateway` al pedir streams, mientras que una llamada "directa" desde el navegador parece funcionar.

### Causas probables, ordenadas por confianza

| # | Hipótesis | Confianza | Evidencia |
|---|---|---|---|
| 1 | **El player llama a una URL que no existe en la API de Vidnest.** La ruta real es `/anime/:anilistId/:episode`, no `/api/streams?type=anime&id=...&episode=...`. Eso produce `404` en Vidnest; si hay un proxy/reverse-proxy de por medio, puede traducirse a `502`. | **Alta** | `src/index.js:73` monta `streamsRouter` en raíz. `src/routes/streams.js:263` define `router.get("/anime/:anilistId/:episode", ...)`. No hay ninguna ruta `/api/streams`. |
| 2 | **El header de auth es incorrecto.** Vidnest espera `x-api-key` (o query `key`) en rutas no-proxy. El player envía `x-player-token`. Sin `x-api-key` la API responde `401 Unauthorized` (`src/index.js:64-66`). | **Alta** | `src/index.js:64-66`. |
| 3 | **El upstream `fire.cineparatodos.lat` podría no ser Vidnest.** Si `server.js` consulta directamente `fire.cineparatodos.lat`, el `502` viene de ese servicio, no de Vidnest. Vidnest solo aparece en `ALLOWED_ORIGINS` (`src/config/constants.js:4-14`) como origen CORS permitido. | **Media** | No hay código en Vidnest que atienda `/api/streams`. `fire.cineparatodos.lat` está en `ALLOWED_ORIGINS_EXACT`. |
| 4 | **Rate-limit por IP.** Si `server.js` y el navegador comparten IP pública (o el proxy/reverse-proxy no reenvía `X-Forwarded-For` real), se puede estar golpeando el límite de 60 req/min (`streams.js:43`, `subtitles.js:11`). | **Baja/Media** | Depende de la infraestructura de red entre player y API. |
| 5 | **Cache persistente corrupta/vieja.** Si el `.db` de cache se copió de otro entorno, las entradas pueden contener URLs de proxy selladas contra un `proxyBase` distinto (localhost vs dominio de prod), causando 403/404 en reproducción. | **Baja** | `src/lib/cache.js:72-86`, `src/lib/proxy-seal.js:36-42` (IV determinístico por path). |

### Conclusión inicial
Lo más probable es que el problema no sea "CORS", "TLS" ni un bloqueo anti-bot de Vidnest, sino un **desajuste de contrato**: el player está usando una ruta y esquema de autenticación que Vidnest no implementa. El `502` que ve el player probablemente lo esté generando un proxy/reverse-proxy al no poder contactar un backend que responde `404`/`401`, o directamente el upstream `fire.cineparatodos.lat`.

---

## B. Tabla de endpoints relevantes

### B.1. Streams

| Endpoint | Método | Params requeridos | Headers requeridos | Auth | Respuesta exitosa | Errores | Observaciones |
|---|---|---|---|---|---|---|---|
| `/movie/:tmdbId` | GET | `tmdbId` (path) | Ninguno específico | `x-api-key` o `?key=` | JSON `{ streams, tracks, meta }` | `401` sin key, `502` si upstream falla, `404` solo si no hay streams (implícito: array vacío) | Cachea en `streams:movie:${tmdbId}` por 7 días. No requiere `Origin`/`Referer` para responder. |
| `/tv/:tmdbId/:season/:episode` | GET | `tmdbId`, `season`, `episode` (path) | Ninguno específico | `x-api-key` o `?key=` | JSON `{ streams, tracks, skip, meta }` | `401`, `502` | Cache por 7 días. |
| `/anime/:anilistId/:episode` | GET | `anilistId`, `episode` (path) | Ninguno específico | `x-api-key` o `?key=` | JSON `{ anilistId, episode, streams, tracks, downloads }` | `401`, `404` si `streams.length === 0` (`streams.js:398`), `502` de upstreams | **Este es el endpoint que debería usar el player para anime.** Cache por 7 días (`streams:anime:v2:...`). |
| `/movie/:tmdbId/:provider` | GET | `tmdbId`, `provider` (path) | Ninguno específico | `x-api-key` o `?key=` | JSON `{ tmdbId, mediaType, provider, streams, tracks }` | `401`, `410` si provider no existe, `502` | Provider individual (debug/reemplazo). |
| `/tv/:tmdbId/:season/:episode/:provider` | GET | `tmdbId`, `season`, `episode`, `provider` (path) | Ninguno específico | `x-api-key` o `?key=` | JSON similar | `401`, `410`, `502` | Provider individual. |

### B.2. Subtítulos

| Endpoint | Método | Params requeridos | Headers requeridos | Auth | Respuesta exitosa | Errores | Observaciones |
|---|---|---|---|---|---|---|---|
| `/subtitles/movie/:tmdbId` | GET | `tmdbId` (path) | Ninguno | `x-api-key` o `?key=` | JSON `{ subtitles: [...] }` | `401`, `502` genérico | Cache 3h. |
| `/subtitles/tv/:tmdbId/:season/:episode` | GET | `tmdbId`, `season`, `episode` (path) | Ninguno | `x-api-key` o `?key=` | JSON `{ subtitles: [...] }` | `401`, `502` | Cache 3h. |
| `/subtitles/anime/:anilistId/:episode` | GET | `anilistId`, `episode` (path) | Ninguno | `x-api-key` o `?key=` | JSON `{ subtitles: [...] }` | `401`, `502` | Cache 3h. |

### B.3. Proxies internos (NO requieren `x-api-key`, solo firma/seal válido o params)

| Endpoint | Método | Params requeridos | Headers | Auth | Respuesta | Errores | Observaciones |
|---|---|---|---|---|---|---|---|
| `/sealed/:token` | GET | `token` (path) | Se reenvían al backend interno | Token AES-GCM válido | Bytes/texto del recurso | `400` token inválido (`src/routes/proxy.js:583-592`) | Usado para ocultar URLs internas de proxy. |
| `/proxy` | GET | `url` (query), `headers` opcional | Ninguno | Ninguno (ruta excluida del auth middleware) | Playlist HLS reescrita | `400`, `502` | Legacy proxy. |
| `/generic-stream.m3u8` | GET | `u`, `ref` opcional | Ninguno | Ninguno | Playlist HLS reescrita | `400`, `502` | Usado por Miruro/Anikoto. |
| `/generic-seg` | GET | `u`, `ref` opcional | Ninguno | Ninguno | Segmentos TS | `400`, `502`, status upstream | |
| `/mp4-proxy` | GET | `url`, `headers` opcional | `Range` opcional | Ninguno | Video MP4 (range soportado) | `400`, `502` | |
| `/upn-stream.m3u8` / `/upn-seg` | GET | `u` | Ninguno | Ninguno | Playlist/segmentos UPNShare | `400`, `502` | Va contra `MIRURO_API/raw-proxy`. |
| `/vixsrc-stream.m3u8` / `/vixsrc-seg` | GET | `u` | Ninguno | Ninguno | Playlist/segmentos Vixsrc | `400`, `502` | Usa `undiciRequest` con headers fijos. |
| `/dash-proxy.mpd` / `/dash-seg/:origin/*` | GET | `u` / path | Ninguno | Ninguno | MPD/segmentos DASH | `400`, `502` | |
| `/fetch` | GET | `url`, `ref`, `ct` | Ninguno | Ninguno | Recurso arbitrario | `400`, `502` | Usado para thumbnails VTT/JPG y subs externos. |
| `/subs/:file` | GET | `file` (path) | Ninguno | Ninguno | VTT/ASS desde disco | `404` si no existe | Lee de `subs-cache/`. |

### B.4. Misc

| Endpoint | Método | Auth | Respuesta |
|---|---|---|---|
| `/health` | GET | Ninguna | `{ ok: true, pid }` |

---

## C. Flujo interno real (anime stream)

Ejemplo de request: `GET /anime/170130/2`.

### 1. Entrada — `src/index.js`

- `app.set("trust proxy", 1)` (`index.js:12`).
- Middleware CORS (`index.js:15-26`):
  - Lee `Origin`.
  - Si no hay `Origin`, responde `Access-Control-Allow-Origin: *`.
  - Si `Origin` está en allowlist exacta o sufijo, lo refleja.
  - Si no, devuelve `https://vidtex.dev` como origen permitido.
  - `Access-Control-Allow-Credentials: false` siempre.
  - `OPTIONS` → `204`.
- Hook de `Cache-Control` (`index.js:29-56`): intercepta `setHeader`/`writeHead`/`end` para forzar el header final calculado por `setCacheForResponse`.
- Auth middleware (`index.js:59-68`):
  - Si `API_KEY` está configurado, todas las rutas requieren `x-api-key` o `?key=`, salvo `/health` y las rutas proxy (`/sealed`, `/proxy`, `/ts-proxy`, `/fetch`, `/mp4-proxy`, etc.).
  - Sin key → `401 { error: "Unauthorized" }`.
- Rate limit (`src/routes/streams.js:43`): 60 req/min por IP (`createRateLimiter` con `keyGenerator = getClientIp`).

### 2. Router de streams — `src/routes/streams.js`

- `router.get("/anime/:anilistId/:episode", ...)` (`streams.js:263`).
- `getProxyBase(req)` (`src/lib/proxy.js:17-32`):
  - Si hay header `x-proxy-base` válido, lo usa.
  - Si `PROXY_CDN_BASE` está seteado y el `Host` no es localhost, devuelve `PROXY_CDN_BASE`.
  - Si no, arma `https?://host` a partir de `X-Forwarded-Proto` o `req.protocol`.
- Cache key: `streams:anime:v2:${anilistId}:${episode}` (`streams.js:269`).
  - Si hit en cache (memoria o SQLite), salta directamente al paso de formateo.
- Si miss: `resolveAnimeData(anilistId, episode)` (`streams.js:220`):
  - Lanza 7 promesas concurrentes con `Promise.allSettled`:
    - `getLatinoStream` (animeav1)
    - `getMegaplayStreams`
    - `getCuevanaAnime`
    - `getCRSubsForAnime`
    - `getMiruroStreams` (Python Flask en `localhost:8001`)
    - `getAnikotoStreams`
    - `anilistToMal` → `getAnimeSkip`
  - Ninguna falla individual aborta el request: se loguea warning y se continúa.
- Construcción de `tracks`:
  - `buildAnimeTracks` (`streams.js:89-125`):
    - Crunchyroll VTT/ASS.
    - Megaplay subs (si los trae).
    - `buildTracks` descarga/localiza subs en `subs-cache/` (`src/lib/subtitles.js:94-127`).
- Construcción de `streams` (`streams.js:281-396`):
  1. Streams archivados en R2 (`getR2Archive`) → URLs firmadas con `buildSignedR2Url`.
  2. Megaplay dub/sub → proxy_url por `/proxy?url=...&headers=...`.
  3. animeav1 streams → `makeAnimeStream`; UPNShare usa `/upn-stream.m3u8?u=...`.
  4. Miruro streams → `/generic-stream.m3u8?u=...&ref=https://www.miruro.tv/`; providers `bee`/`ally` se ocultan.
  5. Cuevana streams.
  6. Anikoto HLS → `/generic-stream.m3u8?u=...&ref=...`.
- Si `streams.length === 0` → `404 { error: "No streams found for this episode" }` (`streams.js:398`).
- Skip/intro data se propaga a todos los streams.
- `sortStreams` y `assignDisplayProviders`.
- `sealProxyUrls(...)` (`src/lib/proxy-seal.js:153`): reemplaza recursivamente `proxy_url` y campos `*Proxy` por URLs selladas `/sealed/:token` (AES-GCM determinístico).
- `res.json(...)` con `Content-Type: application/json`.
- Fire-and-forget: `autoArchiveMissingLangs` encola archivado a R2 (`streams.js:401`).

### 3. Proxy sellado — `/sealed/:token`

- `src/routes/proxy.js:583-629`.
- Descifra el token con `unsealProxyPath`.
- Si falla → `400 { error: "invalid or expired token" }`.
- Reenvía internamente a `http://127.0.0.1:${localPort}${originalPath}&_cb=...`.
- Reescribe URLs internas que aparezcan en playlists/VTT con `sealProxyUrlsInText`.

---

## D. Hallazgos críticos

### P0 — Bloqueantes / explican el 502

1. **La URL del player no existe en Vidnest.**
   - Player: `GET /api/streams?type=anime&id=170130&episode=2`.
   - Vidnest: `GET /anime/:anilistId/:episode` (path params, no query params).
   - Resultado: Express no hace match → `404`. Si hay proxy intermedio, puede verse como `502`.
   - Evidencia: `src/index.js:73`, `src/routes/streams.js:263`.

2. **El header de autenticación es distinto.**
   - Player: `x-player-token`.
   - Vidnest: `x-api-key` o `?key=API_KEY`.
   - Resultado: `401 Unauthorized`.
   - Evidencia: `src/index.js:64-66`.

3. **No hay query params `type`, `id`, `episode` en ningún endpoint de streams.**
   - Vidnest usa path params exclusivamente para estos valores.
   - Evidencia: `src/routes/streams.js:128`, `:173`, `:263`.

### P1 — Importantes

4. **CORS no bloquea, pero `pickAllowedOrigin` devuelve `https://vidtex.dev` para orígenes no permitidos.**
   - Si el player corre en un origen no listado, el navegador puede fallar por CORS *después* de recibir la respuesta, aunque el servidor haya respondido 200/401/404.
   - Evidencia: `src/config/constants.js:23-42`, `src/index.js:15-26`.

5. **Rate-limit por IP puede afectar a `server.js` si comparte IP pública con otras instancias.**
   - Límite: 60 req/min para streams/subtitles, 1200 req/min para proxies.
   - Evidencia: `src/routes/streams.js:43`, `src/routes/subtitles.js:11`, `src/routes/proxy.js:20`, `src/lib/rate-limit.js:21-25`.

6. **Las URLs de proxy son selladas con `PROXY_SEAL_SECRET`.**
   - Si `server.js` intenta consumir directamente una `proxy_url` sin pasar por `/sealed/:token`, o si intenta reconstruir la URL original, fallará sin el secreto.
   - Evidencia: `src/lib/proxy-seal.js:36-58`.

7. **La respuesta final depende de `proxyBase` (Host / `x-proxy-base`).**
   - Si `server.js` llama a Vidnest a través de un dominio/interior distinto al del reproductor, las URLs selladas apuntarán al dominio de la request de `server.js`, no al del browser.
   - Solución: usar header `x-proxy-base` con el dominio público.
   - Evidencia: `src/lib/proxy.js:17-32`.

### P2 — Mejoras / otras causas potenciales

8. **Cache persistente puede contener URLs selladas contra otro dominio.**
   - Si el `.db` se copió de prod a local, los tokens de `/sealed` son válidos (porque dependen del path), pero el `proxyBase` embebido en la respuesta podría ser `http://127.0.0.1:8000` en vez del dominio público.
   - Evidencia: `src/lib/cache.js:72-86`, `src/lib/proxy-seal.js:36-42`.

9. **Los providers corren en procesos/llamadas con timeouts cortos.**
   - `resolveAnimeData` no tiene timeout global; cada provider tiene los suyos. Si el Python de Miruro (`localhost:8001`) no responde, no se bloquea el request completo, pero puede dejar sin streams.

10. **`fire.cineparatodos.lat` no aparece como endpoint de Vidnest.**
    - Está solo en allowlist CORS. Si `server.js` le pega a `fire.cineparatodos.lat`, Vidnest no es el backend que está devolviendo el 502.

---

## E. Comparación exacta con `server.js`

### Request del player (según lo reportado)

```
GET http://127.0.0.1:3000/api/streams?type=anime&id=170130&episode=2
Headers:
  x-player-token: <token JWT/opaco>
  x-requested-with: vidtex-player
  accept: application/json (implícito)
  referer: http://127.0.0.1:3000/anime/170130/2?...
```

### Lo que Vidnest espera

```
GET http://<vidnest-host>/anime/170130/2
Headers:
  x-api-key: <API_KEY de .env>
  (Origin/Referer opcionales; solo afectan CORS)
```

### Diff conceptual

| Aspecto | API espera | Player envía | Diferencia | Impacto |
|---|---|---|---|---|
| **Path** | `/anime/:anilistId/:episode` | `/api/streams` | Ruta completamente distinta. | Express no matchea → `404` (o `502` si hay proxy). |
| **ID** | Path param `:anilistId` | Query `?id=170130` | Vidnest no lee `req.query.id` para anime. | El ID nunca llega al handler correcto. |
| **Episode** | Path param `:episode` | Query `?episode=2` | Vidnest no lee `req.query.episode` para anime. | Episodio ignorado. |
| **Type** | No existe; el tipo está en la ruta. | Query `?type=anime` | Sin efecto. | Parámetro sobrante. |
| **Auth** | `x-api-key` | `x-player-token` | Header de auth distinto. | `401 Unauthorized`. |
| **Referer** | No validado por la API. | `http://127.0.0.1:3000/...` | Vidnest no rechaza referer, pero `pickAllowedOrigin` usa `Origin`, no `Referer`. | Ninguno directo sobre status. |
| **User-Agent** | No validado. | El de fetch/Node del player. | Ninguna validación de UA en Vidnest. | Ninguno. |
| **Origin** | Opcional; si se envía, debe estar en allowlist para CORS. | `http://127.0.0.1:3000` si el request es desde navegador. | `127.0.0.1:3000` **no** está en `ALLOWED_ORIGINS_EXACT`. | CORS puede bloquear la respuesta en el navegador. |
| **Upstream** | Vidnest responde ella misma. | `server.js` consulta `https://fire.cineparatodos.lat/...` | Posible confusión de backend. | El `502` podría venir de `fire...`, no de Vidnest. |

### Impacto concreto

- Si `server.js` le pega directamente a Vidnest con esa URL → **404 + 401**.
- Si `server.js` le pega a `fire.cineparatodos.lat` → Vidnest no interviene; el `502` es de ese servicio.
- Si hay un Nginx/Cloudflare entre player y Vidnest que intenta rutear `/api/streams` a Vidnest → Vidnest devuelve 404 y el proxy puede traducirlo a 502.

---

## F. Recomendaciones accionables para `server.js`

1. **Cambiar la URL de llamada a Vidnest:**
   ```js
   // Antes (mal)
   fetch('http://127.0.0.1:3000/api/streams?type=anime&id=170130&episode=2', { headers: { 'x-player-token': ... }})

   // Después (correcto para Vidnest)
   fetch('http://<vidnest-host>/anime/170130/2', {
     headers: {
       'x-api-key': process.env.VIDNEST_API_KEY,  // o API_KEY de Vidnest
       'x-proxy-base': 'https://<dominio-publico-del-player>', // opcional pero recomendado
     }
   })
   ```

2. **Usar `x-proxy-base`** si `server.js` llama a Vidnest por red interna pero el reproductor está en un dominio público:
   ```js
   headers: {
     'x-api-key': API_KEY,
     'x-proxy-base': 'https://fire.cineparatodos.lat', // dominio que ve el navegador
   }
   ```
   Esto asegura que las URLs selladas de la respuesta apunten al dominio público.

3. **Agregar `Origin` permitido si el request sale del navegador directamente a Vidnest:**
   - Añadir `https://fire.cineparatodos.lat` (o el dominio del player) a `ALLOWED_ORIGINS_EXACT` si aún no está.
   - Actualmente ya está: `src/config/constants.js:4-5`.

4. **Si el player necesita mantener el contrato `/api/streams?type=...`, crear un adaptador en `server.js`:**
   ```js
   app.get('/api/streams', async (req, res) => {
     const { type, id, episode, season } = req.query;
     let vidnestUrl;
     if (type === 'anime') vidnestUrl = `${VIDNEST_BASE}/anime/${id}/${episode}`;
     else if (type === 'movie') vidnestUrl = `${VIDNEST_BASE}/movie/${id}`;
     else if (type === 'tv') vidnestUrl = `${VIDNEST_BASE}/tv/${id}/${season}/${episode}`;
     // forward con x-api-key y x-proxy-base
   });
   ```

5. **Logging útil en `server.js`:**
   - Loguear URL exacta, status, headers de respuesta y body truncado ante cualquier status >= 400.
   - Verificar que `fire.cineparatodos.lat` realmente apunta a Vidnest y no a otro servicio.

6. **Rate-limit:**
   - Si `server.js` está en la misma IP pública que otros clientes, considerar que 60 req/min es por IP.
   - Asegurar que el reverse-proxy reenvíe `X-Forwarded-For` real para no colapsar todas las requests en una sola IP.

7. **Evitar confusión con `fire.cineparatodos.lat`:**
   - Confirmar si el upstream del player es Vidnest o `fire...`. Si es `fire...`, la auditoría debe hacerse sobre ese servicio, no sobre Vidnest.

---

## G. Evidencia por archivo

| Afirmación | Archivo | Líneas / Función |
|---|---|---|
| Montaje de routers en raíz | `src/index.js` | `:71-77` |
| Auth middleware requiere `x-api-key` o `?key=` | `src/index.js` | `:59-68` |
| CORS middleware y `pickAllowedOrigin` | `src/index.js` | `:15-26`; `src/config/constants.js` `:33-42` |
| Endpoint anime real | `src/routes/streams.js` | `:263-421` |
| Endpoint movie/tv real | `src/routes/streams.js` | `:128-217` |
| Rate limit 60 req/min streams | `src/routes/streams.js` | `:43`; `src/lib/rate-limit.js` `:21-25` |
| Cache persistente SQLite | `src/lib/cache.js` | `:52-106` |
| `proxyBase` y header `x-proxy-base` | `src/lib/proxy.js` | `:17-32` |
| Sellado AES-GCM de proxy URLs | `src/lib/proxy-seal.js` | `:36-58`, `:153-157` |
| Descifrado `/sealed/:token` | `src/routes/proxy.js` | `:583-629` |
| Subtítulos anime | `src/routes/subtitles.js` | `:63-69` |
| `ALLOWED_ORIGINS_EXACT` incluye `fire.cineparatodos.lat` | `src/config/constants.js` | `:4-5` |

---

## H. Lo que NO puede deducirse del código

- El código fuente de `server.js` del player no está disponible; solo se conocen la URL y headers reportados.
- La configuración exacta de red/proxy entre player, `fire.cineparatodos.lat` y Vidnest (nginx, Cloudflare, etc.).
- Si `fire.cineparatodos.lat` es Vidnest bajo otro dominio o un servicio separado.
- Los logs concretos del momento del `502`.

---

*Reporte generado a partir del análisis de código de Vidnest API. Cada afirmación incluye la referencia al archivo y línea correspondiente.*
