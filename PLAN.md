Implementá la integración completa del almacenamiento HLS self-hosted de OVH en la Streams API de Zenkai.

Ya realizaste una auditoría técnica de este proyecto y conocés sus archivos, funciones, esquema SQLite y mecanismos de caché. Utilizá ese conocimiento y verificá el código real antes de modificarlo.

**Quiero que implementes la solución completa, no solamente un análisis.**

### 1. Objetivo principal

Integrar OVH como nuevo almacenamiento de streams propios de Zenkai.

- Mantener `provider: "zenkai"` y `originalProvider: "zenkai"` en la respuesta pública.
- Identificar internamente el almacenamiento como `ovh`.
- Conservar el contrato JSON actual del endpoint `GET /anime/:anilistId/:episode`.
- Mantener intactos los scrapers y streams externos.
- No modificar el frontend.
- Conservar R2 durante las pruebas, pero diseñar OVH para que posteriormente funcione sin depender de R2.
- Priorizar OVH cuando exista una publicación válida para el mismo anime, episodio y variante.

### 2. Infraestructura OVH disponible

API de ingesta y consulta:

`https://ingest.zenkai.live`

Autenticación:

`X-Ingest-Key: <OVH_INGEST_KEY>`

Endpoints ya implementados y probados:

**Consulta individual**

`GET /v1/episodes/{slug}`

**Consulta por lotes**

`POST /v1/episodes/lookup`

Body:

```json
{
  "slugs": ["112641-8-multi", "112641-9-multi"]
}
```

La respuesta de OVH incluye:

- `slug`
- `status: "published"`
- `provider: "zenkai"`
- `storageProvider: "ovh"`
- `hls.available`
- `hls.master`
- `hls.files`
- `hls.playlists`
- `hls.size_bytes`
- `subtitles[]`: language, filename, type, path, url
- `thumbnails`: recursos organizados por fuente (`crunchy`, `sub`, `dub`), con VTT, sprites y URLs públicas.

En el lookup, `episodes[]` contiene los episodios publicados y `not_found[]` los no disponibles.

Los episodios en proceso pueden devolver 404, por lo que un 404 no significa necesariamente un fallo permanente.

El servidor HLS público es:

`https://origin.zenkai.live`

Los slugs tienen formato:

`{anilistId}-{episode}-multi`

### 3. Base de datos

La base actual es `data/stream-cache.db`, gestionada en `src/lib/cache.js`.

Actualmente existen `r2_archive`, `manual_tracks` y `episode_thumbnails`.

Implementá una tabla independiente `ovh_archive`, sin destruir ni migrar los datos existentes de R2.

Debe almacenar como mínimo:

- Anime ID.
- Episodio.
- Variante `MULTI`.
- Slug.
- Proveedor original de contenido.
- Tamaño.
- Tiempos de intro y outro.
- Metadatos completos de audio y subtítulos.
- Referencias de thumbnails.
- Estado de publicación.
- Fecha de registro y última sincronización.

Elegí una clave primaria e índices adecuados para registros idempotentes. Guardá referencias permanentes y JSON de metadatos cuando corresponda.

No almacenes URLs HLS firmadas.

Implementá funciones de inserción, actualización, consulta, eliminación administrativa y sincronización, respetando los patrones actuales de SQLite.

### 4. Cliente OVH

Creá un módulo reutilizable, por ejemplo `src/lib/ovh-hls.js`, con funciones para:

- Consultar un episodio.
- Consultar varios episodios mediante lookup.
- Validar y normalizar la respuesta.
- Generar URLs HLS firmadas.
- Gestionar timeouts, errores HTTP y reintentos acotados.

Configuración mediante variables de entorno:

- `OVH_INGEST_BASE_URL`
- `OVH_INGEST_KEY`
- `OVH_ORIGIN_URL`
- `OVH_HLS_SIGNING_KEY`
- `OVH_HLS_URL_TTL_SECONDS`

Usá `https://ingest.zenkai.live` y `https://origin.zenkai.live` como valores predeterminados de los dominios.

No expongas secretos en respuestas ni logs.

La firma HLS debe ser compatible exactamente con Nginx:

```javascript
const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;

const token = crypto
  .createHash("md5")
  .update(`${expiry}/${slug} ${secret}`, "utf8")
  .digest("base64url");
```

URL:

`https://origin.zenkai.live/hls/{token}/{expiry}/{slug}/master.m3u8`

El TTL inicial será de 21600 segundos.

Generá la firma al construir la respuesta de reproducción; nunca reutilices una URL que ya haya expirado.

### 5. Registro de episodios OVH

Implementá:

`POST /admin/api/register-ovh-archive`

Reutilizá el sistema de autenticación administrativa existente.

Debe ser compatible con el payload actual enviado por Go:

```json
{
  "animeId": 154587,
  "episode": 1,
  "lang": "MULTI",
  "slug": "154587-1-multi",
  "bytes": 123456,
  "storageProvider": "ovh",
  "storageProviders": ["ovh"],
  "hlsStatus": "queued",
  "assetsStatus": "queued",
  "sourceProvider": "crunchyroll-downloader",
  "skipIntro": [0, 90],
  "skipOutro": [1320, 1410],
  "thumbnailVttKey": "thumbs/anime/154587/1/crunchy/thumbnails.vtt",
  "subs": [],
  "audioTracks": [],
  "subtitleTracks": []
}
```

Los campos opcionales deben seguir las convenciones del registro actual. Preservá los metadatos enviados por Go y combiná únicamente información comprobada de OVH.

**Es fundamental manejar la publicación asíncrona:**

Go recibe HTTP 202 cuando OVH encola la publicación, no cuando el episodio es público.

Por eso:

1. Aceptá registros pendientes de episodios OVH.
2. Guardalos con estado `pending`, sin exponerlos como streams reproducibles.
3. Consultá el endpoint individual de OVH.
4. Cuando responda `status: "published"` y `hls.available: true`, activá el registro.
5. Si todavía devuelve 404, mantenelo pendiente y programá un reintento.
6. Implementá reintentos automáticos con backoff, límites de concurrencia y estado persistente para sobrevivir a reinicios.
7. No marques un episodio como fallido permanentemente solamente por un 404 temporal.
8. No confundas fallos de autenticación o indisponibilidad de OVH con episodios inexistentes.
9. No registres como disponibles subtítulos y thumbnails todavía no publicados.
10. Permití una resincronización administrativa idempotente.

La respuesta del endpoint debe indicar si quedó `pending` o `published`, para que Go pueda registrar correctamente el resultado.

No bloquees el request esperando indefinidamente a que OVH publique.

### 6. Construcción de los streams

En `src/routes/streams.js`, integrá los registros OVH con los de R2.

Podés generalizar `buildZenkaiStreams()` o introducir una función nueva reutilizable.

Para OVH:

- `provider: "zenkai"`
- `originalProvider: "zenkai"`
- `storageProvider: "ovh"`
- `sourceProvider`: conservar el proveedor real de origen del contenido.
- `lang: "MULTI"`
- `langLabel`: usar el formato actual del proyecto.
- `quality: "auto"`
- `type: "hls"`
- `url` y `proxy_url`: URL OVH firmada.
- `verifyKey: "ovh:{slug}"`
- `multiAudio`: basado en metadatos reales.
- `audioTracks`: conservar los datos enviados por Go.
- `subtitleTracks`: conservar los datos existentes.
- `skip`: preservar los tiempos registrados.

El stream OVH no necesita pasar por el proxy que utilizan determinadas fuentes externas.

Revisá la validación de HLS en `filterPlayableStreams()` para que no rechace indebidamente las URLs firmadas de OVH, pero conservá la verificación de disponibilidad y los controles existentes.

Revisá la deduplicación y ordenamiento para evitar mostrar dos streams idénticos de Zenkai cuando OVH y R2 contienen la misma variante.

Durante las pruebas, OVH debe tener prioridad sobre R2 en esa variante, pero R2 debe continuar disponible como respaldo.

No alteres los streams externos de otros idiomas.

### 7. Audio MULTI e idiomas

El uploader Go ya envía `audioTracks` y `subtitleTracks` desde las pistas seleccionadas por el usuario.

No inventes idiomas ni tracks.

Preservá campos existentes como:

- `id`
- `lang`
- `code`
- `label`
- `original`
- `default`
- `dub`

Analizá cuidadosamente `coveredLangs` y `skipProviders`.

Un stream `MULTI` de OVH solamente debe cubrir los idiomas que figuren efectivamente en sus metadatos.

No ocultes proveedores externos por asumir que `MULTI` contiene todos los doblajes.

Si faltan metadatos, aplicá un comportamiento conservador y mantené disponibles las alternativas externas.

### 8. Subtítulos OVH

El endpoint OVH devuelve las URLs públicas de los subtítulos.

Incorporá esos recursos en el array global `tracks` mediante `buildAnimeTracks()` y las utilidades actuales de normalización.

Conservá el esquema:

- `url`
- `label`
- `lang`
- `type`
- `mimeType`
- `kind`
- `default`
- `ai`
- `cc`
- `forced`

Utilizá los metadatos enviados por Go para asignar etiquetas, idioma, predeterminados y características de las pistas.

Si los metadatos no alcanzan, utilizá reglas explícitas basadas en nombres como `_cc` y `_signs`, evitando clasificaciones incorrectas.

No interpretes automáticamente `_signs` como `forced` si el código no puede determinarlo con seguridad.

Los subtítulos OVH tienen URLs públicas como:

`https://origin.zenkai.live/subs/112641-8-multi-es-419.ass`

No utilices `buildPublicR2Url()` para ellos.

No rompas la deduplicación actual ni elimines pistas legítimamente distintas del mismo idioma.

Mantené el soporte ASS y los metadatos de fuentes disponibles cuando existan; no inventes fuentes ni conviertas ASS a VTT innecesariamente.

### 9. Thumbnails

Integrá los thumbnails de OVH manteniendo:

- `thumbnailVtt`
- `thumbnailVttProxy`

Por ejemplo:

`https://origin.zenkai.live/thumbs/anime/112641/8/crunchy/thumbnails.vtt`

Utilizá las URLs devueltas por el endpoint de OVH y los metadatos de origen.

Considerá las variantes `crunchy`, `sub` y `dub` y verificá que las referencias a sprites dentro del VTT se resuelvan correctamente desde la URL pública.

No sobreescribas los thumbnails de otras fuentes sin una razón comprobada.

### 10. Caché y rendimiento

El proyecto utiliza:

- SQLite para persistencia.
- Caché en memoria de respuestas de 60 segundos.
- Caché de verificación de streams.
- Caché de proveedores externos.

Al registrar o activar un episodio OVH, invalidá la caché de respuesta de ese episodio.

Nunca guardes en caché una URL firmada más allá de su validez.

No consultes OVH en cada request de reproducción.

La respuesta de `/anime/:anilistId/:episode` debe construirse con los datos locales de SQLite y generar las firmas cuando corresponda.

Las comprobaciones de OVH deben realizarse durante el registro y las sincronizaciones en segundo plano.

Limitá correctamente los tiempos de espera y concurrencia.

### 11. Compatibilidad con R2 y migración futura

No elimines todavía el soporte R2.

Preservá:

- `r2_archive`
- `register-archive`
- Firmas R2
- Assets R2
- Streams externos existentes

OVH será el almacenamiento preferido para episodios propios cuando esté confirmado como publicado.

La arquitectura debe permitir desactivar R2 posteriormente mediante configuración, sin necesidad de rediseñar toda la API.

No elimines registros o archivos R2 automáticamente.

### 12. Pruebas obligatorias

Implementá y ejecutá pruebas para:

1. Firma OVH compatible con Nginx.
2. Registro OVH pendiente.
3. Activación posterior a la publicación.
4. Registro idempotente.
5. Persistencia y recuperación después de reiniciar la API.
6. Consulta individual y por lotes.
7. Manejo de 404 temporal, 401/403, timeouts y errores 5xx.
8. Respuesta con OVH y R2 coexistiendo.
9. Prioridad OVH sobre R2.
10. Preservación de streams externos.
11. Metadatos reales de audio MULTI.
12. Subtítulos ASS/VTT, CC, signs y deduplicación.
13. Thumbnails y sprites.
14. Invalidación de caché.
15. Compatibilidad del JSON original.
16. Ausencia de URLs expiradas en respuestas cacheadas.

Para las pruebas de integración utilizá el episodio real `112641-8-multi`, cuando estén configuradas las credenciales necesarias.

No publiques secretos en los resultados.

### 13. Entrega

Implementá los cambios necesarios en el proyecto real siguiendo su arquitectura y convenciones.

No crees una API paralela.

Al terminar, entregá:

- Archivos modificados.
- Migración SQLite realizada.
- Variables de entorno nuevas.
- Ejemplos reales de registro y consulta.
- Resultados de pruebas.
- Instrucciones concretas para adaptar después el uploader Go.



No elimines ni desactives R2 todavía.

La integración debe quedar preparada para pruebas locales antes de habilitar OVH en producción.