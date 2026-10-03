# Diagnostico: api-cache-capacity

- Estado: [OPEN]
- Objetivo: separar coste de lectura SQLite/memoria, resolucion y concurrencia.
- Alcance: mediciones locales, sin cambios de logica ni migracion de infraestructura.
- Debug Server: http://127.0.0.1:7777/event
- Evidencia: .dbg/trae-debug-log-api-cache-capacity.ndjson

## Hipotesis

| ID | Hipotesis | Probabilidad | Esfuerzo | Evidencia necesaria |
| --- | --- | --- | --- | --- |
| A | Leer SQLite explica segundos de espera | Baja | Bajo | Latencias de SELECT y JSON.parse en conexion de solo lectura |
| B | El tramo de cache incluye scraping tras un miss | Alta | Medio | Cache hit/miss real y tiempos separados de resolucion |
| C | Solicitudes concurrentes duplican trabajo de resolucion | Media | Medio | Numero de ejecuciones por clave bajo concurrencia |

## Pruebas

1. Medir lecturas de payloads reales sin modificarlos.
2. Comprobar disponibilidad de localhost antes de probar el endpoint.
3. Separar pruebas con cache caliente de pruebas de resolucion; no comparar como antes/despues.

## Estado

No se ha aplicado ningun fix. Se puede abortar el diagnostico.

## Resultados

- A: no respaldada por la medicion aislada. Linea 1: 1000 lecturas, 20 payloads
  de 21-36 KB, conexion SQLite solo lectura. SELECT preparado por iteracion +
  JSON.parse: p50 0.1838 ms, p95 0.3365 ms, max 1.1875 ms.
  Map + comprobacion de expiracion: p95 0.0008 ms.
  No representa contencion ni escrituras bajo carga en el proceso de API.
- B: pendiente de evidencia interna. El codigo incluye getReanimeStreams
  tras cache miss; el log fromCache actual comprueba el resultado al finalizar.
- C: inconclusa. Lineas 2-3: HTTP fallo con ECONNREFUSED en localhost,
  127.0.0.1 y ::1. No se ejecuto la tanda concurrente.

## API reiniciada por el usuario

Linea 4, runId server-restarted, /anime/170130/12:

- Peticion inicial: 4220.25 ms, HTTP 200. No se vaciaron caches; no es prueba
  de cache completamente fria.
- Repeticion secuencial: 3.67 ms, HTTP 200.
- Tanda de 10 concurrentes tras la repeticion: todas HTTP 200,
  latencias individuales 6.22-14.21 ms, duracion total de tanda 19.50 ms.
- Todas devolvieron 5 streams, 20 tracks y 7993 bytes.
- No hay medicion del event loop ni traza interna de cache hit/miss.
  La tanda caliente no prueba capacidad maxima ni descarta duplicacion
  en misses concurrentes (hipotesis C sigue pendiente).
- No se modifico codigo de negocio. Pendiente una prueba controlada de misses
  concurrentes y separacion de tiempos internos; se puede abortar esta sesion.

## Siguiente medicion

Con API disponible: medir primera respuesta (estado de cache explicitado),
repeticion secuencial y carga caliente incremental. Medir p50/p95/p99,
errores, CPU/memoria, retardo del event loop y requests reales por provider.
Las pruebas frias deben ser controladas, no bombardear proveedores.

## Escalado

Dos VPS requieren balanceador con health checks, almacenamiento compartido
para registros persistentes, cache/coordinacion de trabajos distribuida,
secretos de firma compatibles y eliminar dependencias de archivos locales.
No compartir el archivo SQLite con escritura concurrente por red.
