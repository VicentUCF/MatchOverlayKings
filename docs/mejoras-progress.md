# Ejecución de mejoras.md

## 19 de septiembre de 2026 — P0, persistencia y recuperación

Se sigue el orden P0 → P1 → P2 → P3. P4 sigue condicionado a la validación real
exigida en el plan. No se han realizado emisiones reales ni modificado datos de
producción durante estas pruebas.

| Requisito | Implementación | Evidencia y límite |
| --- | --- | --- |
| Registro independiente de operaciones pendientes y completadas | `pilot-configurations.json.operations`, escritura atómica, sincronización a disco, modo 0600; configuración, preparación, comprobación previa, inicio, recuperación y cierre | Pruebas de duplicados concurrentes, reinicio, corrupción y fallo de escritura; falta validación en el PC de producción |
| Operaciones idempotentes | `Idempotency-Key`, huella de solicitud y respuesta conservada; el navegador conserva el identificador ante desconexión y refresco | La misma preparación devuelve la misma sesión y su estado actual después de reiniciar; una operación de resultado incierto no se repite automáticamente |
| Historial por pista y jornada | Historial accesible desde Mandos, con solicitudes, cambios de estado, avisos de señal y eventos de MediaMTX, gravedad, fecha, pista, temporada, jornada e identificador | Incluye fallos y recuperación de cámaras antes de preparar un broadcast; no inventa sesión ni jornada cuando no existen; faltan incidentes de otros subsistemas |
| Reconciliación de solicitudes interrumpidas | Relaciona sesiones y configuración persistidas con su operación original sin repetir efectos externos | Mandos permite recuperar o cancelar preparaciones parciales, también en curso; una preparación incierta bloquea nuevos destinos hasta resolverla |
| Reconciliación de sesiones con YouTube | Consulta al arrancar, antes de recuperar y periódicamente; conserva intención antes de cada creación y localiza respuestas perdidas mediante una referencia exacta en el mismo canal | Pruebas de respuestas perdidas del broadcast, entrada y metadatos finales; preparaciones antiguas sin referencia conservada requieren investigación manual |
| Preparación remota recuperable | Guarda cada recurso antes del siguiente paso; el broadcast se prepara en privado y aplica la visibilidad solicitada al terminar; recuperar no inicia FFmpeg | Cancelación explícita comprueba recursos conocidos y ausencias con dos consultas separadas; un fallo anterior a crear recursos se puede cancelar sin conexión |
| Comprobación del partido al iniciar/recuperar | Conserva la configuración de la sesión y confirma la identidad con Supabase usando la autorización del operador | No persiste tokens del operador; la comprobación autenticada se realiza al actuar, no antes de iniciar sesión |
| Procesos huérfanos | Conserva PID, instante de inicio e identificador de arranque Linux, termina el encoder anterior antes de habilitar una recuperación | Pruebas con procesos reales, PID de identidad distinta y otro arranque; estados antiguos sin identidad y la ventana anterior a guardar el PID siguen requiriendo diagnóstico |
| Estado observado | «En directo» exige broadcast `live` e ingest `active`; una respuesta tardía no deshace una parada | Pruebas de `ready`, `testing`, `liveStarting`, parada concurrente y reinicio |
| Cierre remoto recuperable | Un cierre rechazado queda visible como fallido; se puede reintentar Finalizar sin arrancar otro encoder; se consulta el estado remoto para cancelar preparaciones o completar directos | Pruebas de fallo/reintento, destinos ya cerrados, preparaciones nunca iniciadas y prohibición de recuperar un cierre pendiente |
| Capacidad concurrente | Se vuelve a comprobar el límite después de validar Supabase; las cámaras V4L2 se reservan durante la preparación | Cuatro inicios concurrentes solo crean tres encoders en la prueba de integración del servicio |
| Encoder atascado y límite de reintentos | Watchdog de 20 s, terminación forzada tras 2 s y backoff; EOF inesperado también se recupera | Pruebas de recuperación antes de 30 s y máximo de cinco reintentos, aunque se produzcan fotogramas brevemente |
| Calidad de la señal | Analiza vídeo antes del overlay a 320×180 y 2 FPS; detecta negro sostenido, imagen inmóvil y silencio cuando se espera micrófono; calcula FPS, velocidad, bitrate y pérdida recientes | Prueba con filtros FFmpeg reales de negro/congelado/silencio y recuperación; avisos visibles e historial, sin reinicios por estas heurísticas; falta calibración con cámaras reales |
| Continuidad ante pérdida de cámara | Captura separada del encoder de salida; vídeo YUV420p BT.709 y audio PCM con reloj común y colas limitadas; cartel por pista y silencio durante los cinco reintentos; conserva el compositor del marcador | Corte real de una captura entre tres salidas 1080p30: los tres encoders mantienen su identidad y avanzan; reintento manual, historial y reinicio comprobados; falta la prueba de micrófono, sincronía y carga sostenida con dispositivos reales |
| Recuperación del navegador del overlay | Reloj de imágenes independiente; conserva el último PNG validado durante caídas, bloqueo de JavaScript o pérdida de datos; cinco reintentos, historial y recuperación manual del navegador sin reiniciar la cámara | Chromium entrega PNG 1080p a FFmpeg con salida de prueba 160×90: fallo de página, datos caducados, JS bloqueado y cierre del navegador; otra pista conserva su página ante el fallo aislado; sin primera imagen válida la salida espera |
| Comprobación previa por pista | Diagnóstico opcional con catorce comprobaciones, programa local H.264/AAC de diez segundos, resumen de avisos y detalle plegado; resultados válidos cinco minutos, cancelación y repetición parcial; el operador puede emitir sin prueba o con avisos | Clip real con Chromium y FFmpeg, color del overlay decodificado, pérdida de cámara, ausencia de fuente/datos, permisos, cancelación y caducidad; estimación de subida compartida y demanda conjunta con margen; falta validar la red y tres pistas con dispositivos reales en menos de dos minutos |
| Caída o bloqueo de MediaMTX | Reinicia el proceso compartido hasta cinco veces con backoff y conserva rutas y credenciales; consulta su API cada 5 s y actúa tras tres fallos consecutivos; registra los cambios por pista | Pruebas de tres pistas, arranque sin configuración válida, escritura fallida del historial, proceso bloqueado, fallo aislado, agotamiento, recuperación manual y cierre; falta validación con tres móviles reales |
| Cámaras móviles después de reiniciar el servidor | Snapshot privado y atómico de enlaces, hashes de acceso, propietario, caducidad, perfil y revocación; conserva identidad del proceso y retira huérfanos antes de reconstruir las rutas | Recupera las tres pistas; no acepta señal lista hasta confirmar la nueva revisión; el navegador conserva su identidad al recargar la misma pestaña sin guardar el token |
| Protección de diagnósticos | No se registran queries OAuth ni errores internos crudos; FFmpeg se traduce a causas acotadas con referencia de sesión | El historial no contiene entradas RTMP ni tokens; falta auditar todos los subsistemas |

### Verificación

Última suite completa verificada: **727 pruebas correctas, una omitida, 110 archivos de
pruebas correctos** (188,98 s, ejecución en serie). Incluye la comprobación previa,
su bloqueo de inicio, el clip real, la corrección del emparejado de audio/vídeo y
el historial por pista del servicio de cámaras, también antes de crear un broadcast,
y la estimación de subida compartida con bloqueos por demanda conjunta y protección
de las salidas activas.
La emisión privada con dispositivos reales sigue pendiente.

- Pruebas específicas: `pilot-operation-journal`, `pilot-observed-state`,
  `pilot-process-identity`, `pilot-runtime-recovery`, `pilot-youtube-preparation`,
  `pilot-mobile-recovery`, `pilot-mobile-camera`, `pilot-mobile-identity`, `pilot-signal-monitor`, `pilot-program-feed`,
  `pilot-overlay-feed`, `pilot-overlay-browser`, `pilot-preflight`, `pilot-upload-check`,
  `pilot-preflight-media`, `pilot.integration` y
  `production-pilot-adapter`.
- La suite completa requiere sockets de loopback y propietarios reales de
  directorios. El sandbox puede provocar `EPERM` y rechazos de rutas seguras.
  Ejecutar en el entorno local autorizado, con `npx vitest run --maxWorkers=1`.
  La prueba de tres salidas ahora mantiene seis procesos FFmpeg (captura y salida
  por pista); otras pruebas de vídeo simultáneas pueden alterar la medición de
  velocidad. En una ejecución concurrente una pista no alcanzó 0,9×; la prueba
  aislada conserva ese umbral y comprueba también el corte de una captura.
- Lint, compilación de todos los workspaces y typecheck de pruebas del agente
  archivado verificados. Vite conserva su aviso de bundle superior a 500 kB.
- `node scripts/check-pilot-history-ui.mjs`: comprobación en Chromium con datos
  simulados de teclado, reflow a 320 px, filtro de pista, error, reintento, vacío
  y zoom CSS al 200 %; el hook y Mandos reales comprueban actualización durante
  preparación, cancelación concurrente y recuperación sin inicio automático;
  avisos visibles durante el directo, continuidad, recuperación de cámara y del marcador,
  acceso por teclado a las mediciones, cancelación de comprobaciones, repetición
  de un paso bloqueado, bloqueo del inicio sin informe vigente e incidencias de
  cámara en pistas sin operaciones de emisión.
  Capturas en `output/mejoras/`. No equivale a una auditoría
  con lector de pantalla ni a una validación de toda la aplicación.

### Próximos pendientes, en orden

1. Completar instrumentación de incidentes técnicos; comprobar también MediaMTX y la configuración
   autoritativa antes de habilitar controles que dependan de ellos.
2. Completar la medición de capacidad de subida y validar el preflight con fuentes
   físicas y tres programas simultáneos en el equipo previsto. La conexión TCP/TLS
   comprobada no equivale a una prueba de ancho de banda.
3. Continuar la implementación de P1, P2 y P3 en orden.
4. En el otro dispositivo: calibrar negro/congelado/silencio y medir tres programas
   compuestos con las cámaras reales; una escena legítimamente inmóvil puede
   producir un aviso. Realizar la prueba privada de tres pistas durante 30 minutos
   antes de afirmar que se cumplen sus criterios o abordar P4.

### Observaciones sobre el inventario inicial

El código ya contenía sesiones móviles por pista, rutas independientes y pruebas
de aislamiento aunque el plan y el runbook todavía describían una cámara global.
Se conserva pendiente su aceptación con tres dispositivos reales.

El usuario ha indicado que la prueba de tres dispositivos y YouTube se realizará
en otro dispositivo. No iniciar esa prueba ni marcar su aceptación desde este PC.

Solicitud adicional pendiente: al terminar las mejoras, generar enlaces de control
visual por pista para asignar una persona al marcador de cada pista. Queda incluida
en `mejoras.md`, con autorización limitada, revocación y pruebas de aislamiento.

### Detalles de la continuidad de cámara

- La caída de la captura o dos segundos sin un par de vídeo/audio válido activan
  el cartel; al iniciar se conceden ocho segundos a la fuente. Los cinco reintentos
  esperan 1, 2, 4, 8 y 15 segundos, y solo treinta segundos de señal estable
  restablecen el contador. Tras agotarse, la salida continúa y se ofrece
  `Recuperar emisión`; `Detener`/`Finalizar sesión` siguen disponibles.
- No se muestran avisos de negro, congelación o silencio causados por el propio
  cartel. Se siguen comprobando el avance y el rendimiento de la salida.
- Se persiste la identidad del capturador junto con la del encoder para retirar
  ambos procesos huérfanos tras un reinicio. Un cartel guardado nunca se presenta
  como una salida activa después de reiniciar. El cierre corta ambos pipes de
  entrada, espera al encoder y fuerza su salida tras dos segundos si es necesario;
  repetir el cierre no vuelve a escribir un estado anterior.
- La selección de muestras de análisis evita el lookahead del filtro `fps`, que
  bloqueaba VAAPI con las entradas de vídeo/audio separadas. La integración usa
  el encoder detectado y ha verificado esta corrección con la GPU local.
- Las emisiones nuevas se preparan con `enableAutoStop: false` para permitir
  recuperar el mismo destino tras un fallo del encoder. Deben cerrarse desde
  Mandos; no modifica emisiones creadas previamente. Véase la
  [definición de YouTube](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts#contentDetails.enableAutoStop).
- La captura y el cartel comparten matriz y rango BT.709 limitado; se conserva
  ese formato en la entrada y metadatos del encoder. Referencia:
  [opciones de conversión de FFmpeg](https://ffmpeg.org/ffmpeg-filters.html#scale).
  La prueba decodifica el cartel con FFmpeg y comprueba su color de fondo.

### Detalles de la recuperación del overlay

- El servidor acepta imágenes de la ruta fijada al partido cuando sus datos están
  confirmados. Un fallo de lectura conserva el tanteo en React, marca la conexión
  como fallida y no actualiza la fecha de confirmación. Una respuesta de versión
  inferior tampoco sustituye el tanteo ni renueva esa confirmación.
- El runtime comprueba la página cada segundo, limita a dos segundos la espera
  de respuesta y considera caducada una confirmación de datos de quince segundos.
  Cada cinco segundos comprueba también el compositor con una captura, incluso
  si la escena está quieta y no genera eventos de screencast. Esa captura solo
  comprueba salud: únicamente el screencast ordenado publica fotogramas, para que
  una respuesta tardía no sustituya una imagen posterior. Referencias:
  [eventos de Playwright](https://playwright.dev/docs/api/class-page#page-event-crash)
  y [captura de Chromium](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureScreenshot).
- Cada apertura tiene un presupuesto inicial de diez segundos. Hay cinco
  reintentos con esperas de 1, 2, 4, 8 y 15 segundos; treinta segundos estables
  restablecen el contador. El agotamiento mantiene la última imagen y permite
  `Recuperar emisión`. Las esperas y sus listeners se cancelan al detener.
- Si todavía no llegó una imagen válida, FFmpeg espera su entrada de overlay y
  no se publica una salida sin marcador. El watchdog distingue esa espera de
  un encoder bloqueado para no reiniciar el ciclo de reintentos indefinidamente.
- Una recuperación de cámara no borra un fallo pendiente del marcador, ni
  viceversa. Si solo falló el navegador, la recuperación conserva la captura.
  Reiniciar el servicio borra las confirmaciones de ejecución anteriores.
- `node scripts/check-overlay-data-recovery.mjs` usa el hook real de React y datos
  simulados para comprobar desconexión, tanteo conservado, confirmaciones y
  respuestas antiguas. El aviso de Mandos se comprueba a 320 px en
  `scripts/check-pilot-history-ui.mjs`; captura en `output/mejoras/overlay-recovery-320.png`.
- Falta medir la carga sostenida de tres programas con overlays reales, audio y
  móviles en el equipo previsto. Estas pruebas locales no acreditan esa aceptación.

### Detalles de la comprobación previa

- El servidor conserva el informe por sesión y la huella de configuración solo
  durante la ejecución actual. La prueba caduca cinco minutos después de la
  comprobación más antigua; repetir un paso no renueva el resto. Un reinicio,
  cambio de cámara/perfil o de codificadores invalida el informe.
- La muestra usa el mismo constructor de argumentos FFmpeg que el directo,
  pero su única salida es un MP4 privado. Exige pares reales de vídeo/audio,
  marcador confirmado y diez segundos completos, y decodifica ambos streams
  antes de ofrecer el archivo. Nunca conecta una salida de medios con YouTube.
- Se comprueban partido, autorización, perfil, cámara, audio, almacenamiento,
  carga de CPU, memoria, codificador, red, bitrate, MediaMTX, marcador y destino.
  La memoria y CPU consideran los límites de cgroup cuando están disponibles.
  El servidor reserva un máximo de tres salidas, contando las pruebas. Los
  umbrales de disco y memoria son diagnósticos y no bloquean el inicio.
- Una prueba de señal completa exige velocidad reciente de al menos 0,95×.
  La medición descubrió que el audio llegaba en ráfagas adelantadas al vídeo:
  limitar ambas colas a seis cuadros descartaba pares válidos y reducía la
  muestra a unos 22 FPS. La cola de vídeo sigue limitada a seis cuadros; el audio
  conserva un segundo, 192 KB por pista. La prueba aislada vuelve a alcanzar el
  mínimo de velocidad sin reducirlo. En este clip CFR, la velocidad se calcula
  como fotogramas realmente codificados por segundo divididos por los FPS del
  perfil. El timestamp del mux AAC puede adelantarse y recortarse al terminar
  los diez segundos; no se usa ese salto como caída del rendimiento de vídeo.
  El cierre normal de los pipes del MP4 se distingue de una interrupción de cámara.
- Los pasos de cámara, audio, codificador, bitrate y marcador repiten una única
  muestra compartida; repetir otro paso conserva el clip y las fechas originales
  de los resultados que no se tocaron. Cancelar o finalizar cierra captura,
  encoder y página de esa pista. Sus identidades se conservan para retirar
  procesos huérfanos al reiniciar.
- La descarga exige operador local autenticado y usa `Cache-Control: no-store`.
  El navegador descarga un blob con autorización y revoca su URL al cambiar de
  clip o salir. No se incorporan tokens a la URL del vídeo. Un nuevo programa
  sustituye el clip previo y finalizar la sesión lo elimina.
- Mandos permite `Emitir` sin prueba, con avisos o con resultados anteriores.
  Durante una prueba activa se puede cancelarla para liberar la captura. Los
  resultados se muestran plegados y las pruebas omitidas figuran sin comprobar.
  La API tampoco exige un diagnóstico favorable para iniciar.
- La ruta TCP/TLS comprueba disponibilidad del destino; la medición independiente
  de subida se describe más abajo. No se acredita todavía el presupuesto de dos
  minutos para tres cámaras físicas ni la operación sostenida en el PC previsto.

### Estimación de subida compartida

- La comprobación de red mide desde el runtime del PC, usando el endpoint HTTPS
  de subida documentado por [Cloudflare Speedtest](https://github.com/cloudflare/speedtest#instantiation).
  Envía exclusivamente bytes generados. La respuesta confirma la recepción según
  el [contrato del servicio de subida](https://github.com/cloudflare/worker-speedtest-template#upload).
  No sigue redirecciones ni adjunta autorización o cookies; limita la respuesta.
- Hay hasta tres muestras crecientes (2, 8 y 16 MiB), máximo 26 MiB y doce segundos
  en conjunto. Finaliza al recibir una muestra de al menos un segundo; usa el
  tiempo completo de la petición, sin descontar latencia ni procesamiento del
  servidor. Es una estimación conservadora, no una garantía de bitrate sostenido.
- Las pistas comparten una petición y caché de cinco minutos. Cancelar una pista
  no cancela las demás; retirar el último solicitante cancela la transferencia.
  El informe conserva la fecha de medición original para calcular su caducidad.
  Repetir Red fuerza una medición nueva y descarta la anterior si falla. Una nueva
  medición invalida los informes de otras pistas basados en la anterior, incluso
  si termina mientras alguna de ellas todavía está grabando su muestra.
- Se suman 6/9 Mbps de vídeo según 30/60 FPS y 128 kbps de audio por pista; se
  comparan las tres pistas configuradas/preparadas para YouTube de mayor consumo
  con un 30 % adicional. Una estimación insuficiente genera un aviso; cambiar
  la demanda invalida el informe anterior. Una simulación no consume subida.
- Nunca inicia una transferencia si existe una salida a YouTube activa o en
  recuperación. Arrancar cualquier salida cancela la prueba pendiente. Sin una
  medición vigente, informa de la ausencia con una advertencia; no inventa una
  capacidad. Una respuesta fallida, cortada o excesiva tampoco acredita capacidad.
- Mandos explica destino y consumo de datos antes de comprobar. Permite repetir
  Red aunque el resultado anterior fuera correcto, útil al cambiar de conexión.
  Las pruebas utilizan servidores HTTP de loopback y mediciones simuladas; no se
  ha realizado una subida externa desde este equipo. Sigue pendiente comprobar
  la red prevista y la ruta real a YouTube con tres dispositivos durante 30 minutos.

### Historial del servicio de cámaras

- MediaMTX emite causas cerradas y seguras: arranque, disponibilidad, caída,
  tres comprobaciones fallidas, reintento programado/en curso, agotamiento,
  recuperación manual, configuración no disponible y reinicio para retirar una
  conexión revocada. El journal convierte esas causas en mensajes; no recibe
  stderr, URLs, claves ni hashes de acceso.
- Un fallo compartido genera un evento por cada enlace activo afectado. Conserva
  la identidad de ese enlace y, cuando existe, la sesión de emisión y su jornada.
  Una incidencia anterior al broadcast utiliza sesión y estado de emisión nulos.
- El observador se instala antes de inicializar las cámaras en la aplicación.
  Los eventos de arranque quedan guardados antes de exponer la API. El cierre
  voluntario no genera una caída falsa y el cierre de MediaMTX se intenta aunque
  falle la persistencia final del runtime de emisión.
- Los eventos capturan fecha y contexto al ocurrir. La cola de escritura solo los
  retira tras confirmar el journal, deduplica su identificador y vuelve a intentar
  los pendientes cada cinco segundos. Ante un fallo de disco, el runtime muestra
  el problema de persistencia; la señal puede continuar. Los eventos aún no
  escritos siguen dependiendo de la memoria del proceso y no se presentan como
  durables si también se pierde ese proceso.
- «El servicio vuelve a responder» no equivale a cámara lista: cada móvil debe
  confirmar su nueva revisión y entregar señal. El historial lo explica y conserva
  reintentos, gravedad y resolución sin modificar por sí mismo el estado deportivo.
- El filtro de pistas incluye incidencias aunque todavía no haya una operación de
  emisión. Chromium verifica ese caso con teclado y a 320 px; captura
  `output/mejoras/mobile-runtime-history-320.png`. Sigue pendiente la validación
  con tres móviles en el equipo previsto y el sistema de alertas global de P1.
