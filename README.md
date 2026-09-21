# KPL Live Overlay Control

Frontend Vite/React para controlar marcadores de padel y overlays OBS de KingsPadelLeague. Produccion usa Vercel para servir la web y Supabase como backend: Auth, Postgres, RLS, RPC y Realtime.

## Arquitectura de producción

- Supabase es la fuente autoritativa del inventario de pistas, identidades de partido,
  autenticación, roles y marcador. Las pistas no están fijadas en el frontend.
- `/` es publico y solo lista partidos en directo, con el marcador de cada pista, el enlace
  al directo de YouTube como accion principal y el marcador ampliado como secundaria.
- `/live/:courtSlug` es publico y solo muestra una pista si esta `live`.
- `/admin` reúne configuración, supervisión y control técnico en **Producción**;
  `/admin/grabaciones` contiene el archivo y la publicación programada. Las antiguas
  `/admin/emisiones` y `/mandos` redirigen a Producción.
- `/control/:courtSlug#token=…` es el control temporal del operador para marcador y layout;
  no puede preparar, iniciar, detener ni publicar una salida.
- `/overlay/:courtSlug/scoreboard` es la ruta del compositor. Las grabaciones internas usan
  un permiso privado `overlay_read`, sin abrir el marcador a usuarios anónimos.
- El frontend no calcula acciones criticas: llama RPCs de Supabase (`add_point`, `undo_last`, `manual_patch`, `reset_match`, `new_match`, `set_match_status`).
- `score_states.state` conserva el `MatchState` actual en JSONB y `score_events` guarda auditoria completa.
- El servidor Fastify local es el único runtime de señal y emisión: controla Android, FFmpeg,
  MediaMTX, overlays, miniaturas, YouTube, persistencia y recuperación.
- `apps/production-agent` se conserva como código histórico y banco de pruebas del reconciliador;
  no se arranca junto al runtime unificado ni expone una ruta operativa alternativa.

## Desarrollo

```bash
npm install
cp apps/web/.env.example apps/web/.env.local
```

Configura `apps/web/.env.local` con:

```bash
VITE_SUPABASE_URL=...
VITE_SUPABASE_PUBLISHABLE_KEY=...
```

Levanta Supabase local o usa un proyecto remoto con las migraciones de `supabase/migrations`. Despues crea el usuario del club en Supabase Auth. El primer login correcto en `/admin` reclama el club `kpl` mediante `claim_default_club()`.

```bash
npm run dev
```

URLs locales con Vite:

- Selector publico: `http://localhost:5173/`
- Admin: `http://localhost:5173/admin`
- Directo pista 1: `http://localhost:5173/live/pista-1`
- Control pista 1: `http://localhost:5173/control/pista-1`
- Overlay pista 1: `http://localhost:5173/overlay/pista-1/scoreboard`

URLs de produccion previstas:

- Selector publico: `https://live.kingspadelleague.es/`
- Admin: `https://live.kingspadelleague.es/admin`
- Control pista 1: `https://live.kingspadelleague.es/control/pista-1`
- Overlay pista 1: `https://live.kingspadelleague.es/overlay/pista-1/scoreboard`

## Supabase

La migracion inicial crea:

- `clubs`, `club_users`, `teams`, `courts`
- `score_states`
- `score_events`
- RLS para lectura pública solo de marcadores `live` cuya exposición sea `public`; una
  grabación puede estar en juego con exposición `internal` sin aparecer en portada ni `/live`.
- `score_states.youtube_watch_url`: el enlace publico del directo, que el runtime de emision
  publica con `publish_court_stream` al arrancar la senal y limpia al pararla
- RPCs de marcador con bloqueo `FOR UPDATE`, `expected_version`, `command_id` idempotente y auditoria

Para local, usa Supabase CLI:

```bash
supabase start
supabase db reset
```

Para ejecutar los tests SQL/RPC:

```bash
supabase test db
```

Para aplicar las migraciones al proyecto remoto:

```bash
SUPABASE_DB_URL='postgresql://...' npm run supabase:deploy
npm run supabase:check
```

El despliegue registra el hash de cada migracion y aplica solo archivos pendientes dentro de una transaccion. Para adoptar el registro en un proyecto existente, indica explicitamente la ultima migracion ya aplicada una sola vez, por ejemplo `KPL_MIGRATION_BASELINE_THROUGH=20260702120000_initial_kpl_schema.sql`; el script se niega a repetir un esquema existente sin esa referencia.

`SUPABASE_DB_URL` es la connection string de Postgres del proyecto Supabase. No sirve la publishable key ni la secret API key para crear tablas, RLS o funciones SQL.

## Runtime unificado en el PC de emisión

La rama mantiene Supabase como fuente de verdad para autenticación, marcador y Realtime, pero
ejecuta en el PC de emisión todo el trabajo pesado: servidor web local, FFmpeg, MediaMTX y la
integración con YouTube. El operador puede abrir el panel publicado en Vercel desde ese mismo PC:
la web contacta al runtime en `http://127.0.0.1:4310` y el navegador solicita permiso para acceder
a la red local. El panel local continúa disponible como alternativa. Vercel también sirve la
página HTTPS que necesita el móvil para conceder acceso a la cámara.

Cada grabación o directo abre internamente `/overlay/:courtSlug/scoreboard` en Chromium y mezcla esa página
transparente sobre el vídeo de la cámara móvil antes de codificar la salida. Es la misma interfaz
que se usa como Browser Source en OBS, incluidas sus cartas, escenas y animaciones, pero no hace
falta instalar ni abrir OBS. El contenedor ya incluye el navegador requerido.

Las grabaciones producen MP4 locales independientes y se validan con `ffprobe` al detenerse.
Desde **Grabaciones** el administrador inicia una subida reanudable y privada a YouTube; cuando
YouTube termina de procesarla puede programar `publishAt`. La publicación posterior depende de
YouTube y no exige que el PC de producción permanezca encendido.

La instalación soportada usa Docker Compose:

```bash
cp .env.pilot.docker.example .env.pilot.docker
# Completa Supabase, la IP/CIDR de la LAN, el origen HTTPS del panel y, si procede, YouTube.
npm run production:local:check
npm run production:local:up
```

Configura `KPL_PILOT_CONTROL_ORIGINS` con el origen exacto del panel, sin ruta; por ejemplo,
`https://live.kingspadelleague.es` o la URL `https://<proyecto>.vercel.app`. Se pueden autorizar
varios orígenes separándolos con comas. No uses `*`: estas rutas pueden iniciar y detener
emisiones.

Abre el panel de Vercel en el PC de emisión y acepta el permiso de red local cuando Chrome lo
solicite. Si el permiso se deniega o el navegador no implementa esta conexión, usa el botón
**Abrir panel local** o entra en `http://localhost:4310/admin`. Los valores
`VITE_SUPABASE_URL` y `VITE_SUPABASE_PUBLISHABLE_KEY` se incorporan a la web al construir la
imagen; cambiar cualquiera de ellos exige repetir `npm run production:local:up`. Para seguir el
servicio usa `npm run production:local:logs`, y para apagarlo sin borrar la configuración usa
`npm run production:local:down`.

El arranque espera a que el servidor y FFmpeg estén listos. Docker reinicia el servicio si cae,
limita los registros a cinco archivos de 10 MB y concede 20 segundos para detener limpiamente las
codificaciones antes de cerrar el contenedor. `./data` conserva la configuración local y el token
OAuth; la base de datos y el estado del marcador continúan en Supabase.

## Operación local

### Arranque reproducible con Docker

En un equipo nuevo con Docker Compose y acceso a Internet:

```bash
cp .env.pilot.docker.example .env.pilot.docker
# Edita las credenciales de Supabase; la red LAN se detecta al arrancar.
npm run production:local:up
npm run production:local:logs
```

Compose levanta un único contenedor con Node, FFmpeg, el frontend de producción y MediaMTX `1.21.0`.
Publica el panel en `http://<IP-DEL-PC>:4310`, WHIP/WHEP en TCP `8889` y los candidatos ICE en
UDP `8189`. La API MediaMTX y RTSP no se publican al host: permanecen en loopback dentro del
contenedor. La carpeta `./data` conserva la configuración local y el token OAuth si se usa YouTube;
`.env.pilot.docker` no se versiona.

`npm run production:local:up` y `npm run production:local:check` detectan la interfaz con ruta
predeterminada de Windows y actualizan `KPL_PILOT_LAN_HOST` y `KPL_PILOT_LAN_CIDR` en el archivo
local `.env.pilot.docker`. En Linux nativo usan la ruta IPv4 predeterminada. Para fijar valores
manualmente configura `KPL_PILOT_AUTO_LAN=0`. Dentro de WSL, si UFW está activo, autoriza la red
detectada (el arranque la muestra en pantalla):

```bash
./scripts/configure-pilot-firewall.sh CIDR_DETECTADO
```

El script es idempotente y abre `4310/tcp`, `8889/tcp` y `8189/udp` únicamente para la LAN. No
activa UFW si estaba apagado, para no poner en riesgo un acceso SSH. No se deben abrir `8554` ni
`9998`, ni crear redirecciones de estos puertos en el router: el teléfono y el PC deben compartir
la misma red privada. En otro PC, sustituye la IP y el CIDR por los que muestre `ip -4 address`.

Después de levantar Compose, usa la IP que muestra el arranque para comprobar `/health` desde el
PC y desde el dispositivo de cámara. La página de cámara seguirá llegando mediante el enlace HTTPS
temporal generado por el panel en `live.kingspadelleague.es`.

#### WSL 2 en Windows: red reflejada y firewalls

El reenvío a `localhost` del modo NAT de WSL no expone de forma fiable a la LAN los puertos TCP y
UDP publicados por Docker. En Windows 11 22H2 o posterior con WSL 2.0.9 o posterior, usa red
reflejada y autoriza el tráfico en Windows Firewall y Hyper-V Firewall. No intentes abrir el script
mediante `\\wsl.localhost`: una consola elevada puede no tener acceso a ese proveedor UNC.

Abre **PowerShell como administrador** con la misma cuenta de Windows que usa WSL y pega esta línea:

```powershell
wsl.exe -d Ubuntu-26.04 --exec cat /home/vciscar/projects/MatchOverlayKings/scripts/configure-wsl-camera.ps1 | powershell.exe -NoProfile -ExecutionPolicy Bypass -Command -
```

Si la elevación se hace con otra cuenta de Windows, esa consola no verá las distribuciones WSL del
usuario habitual. Primero confirma `wsl --list --verbose` sin elevar y comprueba que
`Ubuntu-26.04` muestra `VERSION 2`. Después ejecuta desde PowerShell elevado la copia del script
guardada en Windows, omitiendo únicamente la comprobación ya realizada y señalando el perfil
propietario de `.wslconfig`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'C:\Users\VicentCiscarAlmiñana\Documents\Codex\2026-09-17\necesito-solucionar-el-acceso-de-la\work\MatchOverlayKings\scripts\configure-wsl-camera.ps1' -SkipDistroCheck -WslUserProfile 'C:\Users\VicentCiscarAlmiñana'
```

El script comprueba la elevación, que `Ubuntu-26.04` exista y use WSL 2, y que Windows y WSL
admitan `networkingMode=mirrored`. Detecta la interfaz activa, actualiza
`%USERPROFILE%\.wslconfig` conservando una copia del archivo anterior y crea o actualiza dos reglas
KPL para `LocalSubnet`: TCP `4310,8889` y UDP `8189`. Las reglas se adaptan cuando cambia la red y
se aplican también al firewall Hyper-V de WSL.

Guarda el trabajo abierto en cualquier distribución y aplica el cambio de red:

```powershell
wsl --shutdown
```

Abre de nuevo `Ubuntu-26.04`, levanta Compose y genera un enlace nuevo; el reinicio invalida los
enlaces de cámara anteriores. No abras `8554` ni `9998` y no configures port forwarding en el
router.

Comprobaciones desde PowerShell:

```powershell
wsl --version
wsl --list --verbose
Get-Content "$env:USERPROFILE\.wslconfig"
Get-NetFirewallRule KPL-Camera-TCP,KPL-Camera-UDP | Get-NetFirewallPortFilter
Get-NetFirewallRule KPL-Camera-TCP,KPL-Camera-UDP | Get-NetFirewallAddressFilter
Get-NetFirewallHyperVRule KPL-Camera-HyperV-TCP,KPL-Camera-HyperV-UDP | Format-List Name,Protocol,LocalPorts,RemoteAddresses
$kplIp = (Get-NetIPConfiguration | Where-Object IPv4DefaultGateway | Select-Object -First 1).IPv4Address.IPAddress
Test-NetConnection $kplIp -Port 4310
Test-NetConnection $kplIp -Port 8889
```

Comprobaciones desde WSL, en el directorio del proyecto:

```bash
grep -E '^KPL_PILOT_LAN_(HOST|CIDR)=' .env.pilot.docker
docker compose ps
curl --fail http://127.0.0.1:4310/health
ss -lnt | grep -E ':(4310|8889)\b'
ss -lnu | grep -E ':8189\b'
```

En el dispositivo de cámara, conectado a la misma LAN, abre `http://IP_DETECTADA:4310/health`.
Después abre el enlace HTTPS nuevo de `live.kingspadelleague.es`, pulsa **Preparar cámara** y
verifica que el panel muestre **Lista**: esa última prueba valida el POST WHIP por TCP `8889` y el
candidato ICE por UDP `8189`, que no se puede validar con `Test-NetConnection`.

El Compose usa una red bridge privada fija (`172.30.0.0/24`): solo su gateway `172.30.0.1` puede
usar las rutas administrativas, mientras que el teléfono sigue limitado a los endpoints móviles
con token y origen HTTPS.

Para apagarlo sin borrar datos: `npm run production:local:down`. Para actualizar la imagen, repite
`npm run production:local:up`.

### Codificación automática por GPU

Al arrancar, el runtime prueba los codificadores de hardware disponibles con vídeo real
1080p30 y 1080p60, usando los mismos ajustes de salida que las emisiones. Solo selecciona
una GPU para los perfiles que hayan superado la prueba. El orden es NVIDIA NVENC;
en Windows nativo, AMD AMF e Intel Quick Sync; en Linux, los dispositivos VAAPI
AMD/Intel. Si ninguno funciona, mantiene CPU (x264). La prueba detecta compatibilidad,
no garantiza capacidad para varias pistas simultáneas: valida la carga con simulaciones.

El arranque habitual `npm run production:local:up` expone automáticamente NVIDIA cuando
hay controlador y runtime Docker compatibles, o los dispositivos `/dev/dri/renderD*`
en Linux con sus grupos de acceso. La imagen incluye los controladores VAAPI Mesa e
Intel. Para NVIDIA en Linux instala también NVIDIA Container Toolkit y configura su
runtime Docker. No se requiere ejecutar el contenedor con privilegios.

`KPL_PILOT_GPU=auto` es el valor predeterminado en `.env.pilot.docker`; `nvidia` o
`vaapi` fuerzan el tipo de acceso a dispositivos y `off` lo desactiva. Estos valores
configuran el lanzador Docker, no sustituyen la prueba de FFmpeg. Si usas directamente
`docker compose up`, debes configurar el acceso a dispositivos tú mismo; usa el script
de arranque para conservar la detección automática.

En Windows con Docker Desktop/WSL 2, el acceso documentado es NVIDIA. AMD/Intel mediante
AMF/Quick Sync se detectan al ejecutar FFmpeg en Windows nativo; esto no convierte el
resto del runtime Linux en una instalación Windows nativa validada. No se debe asumir
que una GPU visible en Windows esté disponible dentro del contenedor.

**Este PC** muestra las GPU que pasaron la prueba y sus FPS disponibles. Cada sesión
en **Emisiones** e **Inicio** indica el codificador utilizado. Si FFmpeg informa de un
fallo de hardware, la recuperación descarta ese codificador para la sesión y prueba
otro disponible o CPU, conservando el mismo directo de YouTube y un aviso visible.
La recuperación puede interrumpir brevemente el vídeo y la CPU debe tener margen.

Esta aceleración se aplica a la codificación H.264. La composición del marcador,
el escalado y Chromium siguen usando CPU. No garantiza mayor calidad de imagen ni
elimina toda la carga del procesador. Reconstruye la imagen para incorporar el cambio;
no hay migraciones de Supabase y las sesiones guardadas anteriores siguen siendo legibles.
Si utilizas el panel publicado en Vercel, actualiza también esa web junto con el runtime:
los contratos de estado incorporan la información del codificador. El panel local ya
se actualiza al reconstruir la imagen.

Referencias de instalación: [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html),
[GPU en Docker Desktop](https://docs.docker.com/desktop/features/gpu/) y
[AMD AMF](https://github.com/GPUOpen-LibrariesAndSDKs/AMF).

La aplicación separa la preparación y la operación de todas las pistas habilitadas. La navegación del
administrador mantiene cargadas tres pestañas: Inicio en `/admin`, preparación en
`/admin/emisiones` y Mandos en `/mandos`. Cambiar entre ellas no recarga la página ni reinicia su
estado. El operador entra directamente en `/mandos`, donde solo puede preparar, iniciar, detener y
vigilar las emisiones. Su modo
`Simulacion local` genera titulo, descripcion y miniatura y ejecuta una codificacion FFmpeg 1080p30
real contra una salida nula: no crea recursos externos ni publica contenido.

Para ejecutarlo en primer plano, fuera de Docker:

```bash
npm run production:local:foreground
```

Abre `http://localhost:4310/admin`, inicia sesión y entra en **Emisiones**. Guarda cada pista
y entrega al operador `http://localhost:4310/mandos`. La configuración persiste en el runtime local
entre aperturas del navegador y reinicios del servidor. El panel detecta las
camaras Linux `/dev/video*`; si no hay ninguna conectada ofrece una señal sintetica. La validacion
considera estable el encoder cuando mantiene al menos `0.95x` de velocidad.

Para validar YouTube de verdad, crea un cliente OAuth de tipo aplicacion web, habilita YouTube Data
API v3 y registra exactamente
`http://localhost:4310/api/pilot/youtube/auth/callback` como URI de redireccion. Copia las variables
de [`apps/server/.env.pilot.example`](apps/server/.env.pilot.example) al `.env` de la raiz. El token
OAuth se guarda en la ruta absoluta configurada, fuera del repositorio y con modo `0600`.

El modo `YouTube real` crea un broadcast, una entrada RTMP, los vincula, sube la miniatura y entrega
la URL RTMPS exclusivamente al proceso FFmpeg. Empieza siempre con visibilidad `Privado`. La clave
de emision y los tokens no se devuelven al navegador ni se escriben en los logs.

Cada pista conserva su propia configuración, fuente, estado, métricas y controles de inicio/parada.
Los perfiles `production_admin` ven configuración y mandos; los perfiles `operator` acceden
directamente a Mandos, sin campos editables. El runtime mezcla automáticamente el marcador KPL
sobre la señal antes de enviarla a YouTube. La capa conserva transparencia real, refresca el
estado público de la pista desde Supabase cada segundo y mantiene el último frame válido si la
lectura falla, sin cortar el vídeo. Admite una cámara Android WebRTC independiente por pista,
con varias pistas conectadas a la vez. Instala MediaMTX `1.21.0`, configura las variables `KPL_PILOT_MEDIAMTX_*`
y `KPL_PILOT_LAN_*` del ejemplo y permite desde la LAN TCP `4310/8889` y UDP `8189`. RTSP `8554` y
la API `9998` permanecen ligados a `127.0.0.1`.

En **Emisiones**, selecciona **Móvil Android** en cada pista y genera su enlace temporal.
Abre cada enlace en el dispositivo de esa pista; crear, cambiar o revocar una cámara no modifica
las cámaras de las demás pistas. Los enlaces mantienen la página `https://live.kingspadelleague.es/camera/pilot`.
El enlace contiene el
secreto únicamente en el fragmento de URL, caduca a las 12 horas y deja de funcionar al revocarlo
o reiniciar el runtime. Ábrelo en Chrome Android actualizado, pulsa **Preparar cámara** y concede los
permisos solicitados. El panel habilita solamente las cámaras y los perfiles `720p30`, `720p60`,
`1080p30` o `1080p60` reportados por el dispositivo; también permite activar o silenciar su audio.
La pantalla `/mandos` muestra el preview WHEP, el formato realmente aplicado, bitrate, pérdida,
RTT y último heartbeat. La página del móvil debe permanecer visible y con la pantalla encendida.

Si MediaMTX o la LAN no están configurados, la fuente móvil aparece deshabilitada sin afectar a
V4L2 ni a la señal sintética.

## Vercel

Configura estas variables en Vercel:

```bash
VITE_SUPABASE_URL=...
VITE_SUPABASE_PUBLISHABLE_KEY=...
# Opcional; este es el valor predeterminado:
VITE_LOCAL_AGENT_URL=http://127.0.0.1:4310
```

El runtime debe estar arrancado en el mismo PC desde el que se abre el panel. Añade el origen
exacto del despliegue a `KPL_PILOT_CONTROL_ORIGINS` en `.env.pilot.docker` y reconstruye el
contenedor. Para previews de Vercel con URL cambiante, autoriza explícitamente cada origen que se
vaya a utilizar; no se aceptan comodines.

El build de Vercel usa:

```bash
npm run build:vercel
```

Salida: `apps/web/dist`. Las rutas SPA se reescriben a `index.html` en `vercel.json`.

## Verificacion

```bash
npm run lint
npm run test
npm run build:vercel
npm run test:e2e
```

Los e2e se omiten si no existen `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `KPL_E2E_EMAIL` y `KPL_E2E_PASSWORD` en el entorno de ejecucion.

### Partido único para emisión y marcador

La configuración de cada pista en Administración fija también los equipos, el título
y la pista del marcador en Supabase. El control visual permite gestionar el juego,
pero no sustituir esa identidad. Antes de preparar una emisión, el runtime comprueba
que sus datos coinciden con la configuración guardada; si falta la conexión o hay
un desfase, rechaza la preparación.

Para activar esta protección y la autorización por rol del runtime, aplica todas las
migraciones pendientes —incluidas `20260915120000_pilot_match_binding.sql` y
`20260915150000_production_runtime_capability.sql`— y despliega la web junto con el
runtime unificado. Ambos necesitan `VITE_SUPABASE_URL` y
`VITE_SUPABASE_PUBLISHABLE_KEY` del mismo proyecto (Docker Compose ya carga
`apps/web/.env`). Las operaciones usan la sesión del administrador u operador, sin
una clave de servicio. Guarda de nuevo las configuraciones anteriores para vincularlas;
no se migran automáticamente desde el fichero local.

Una emisión preparada o activa bloquea su configuración. Para cambiar el partido,
cancela la preparación o detén la emisión; si el marcador sigue en juego, finaliza
el partido desde el control visual. Cancelar una preparación de YouTube elimina
esa emisión programada; si YouTube rechaza la cancelación, se mantiene el bloqueo.

### Recuperación de la emisión

El estado de las sesiones, la miniatura y las referencias protegidas de YouTube se
guardan en `./data` con permisos `0600`. Si FFmpeg, una fuente o el compositor se
interrumpen, el servicio intenta recuperar la misma sesión cinco veces con backoff.
Si el contenedor o el PC se reinician, Mandos muestra la sesión como
**Interrumpida**: comprueba la fuente y pulsa **Recuperar emisión**. Esta acción
reutiliza el broadcast existente y evita crear un directo duplicado. Si no se debe
continuar, usa **Finalizar sesión** antes de preparar otra.

Para la primera jornada real sigue el
[runbook de producción del fin de semana](docs/weekend-production-runbook.md),
incluido su simulacro de reinicio obligatorio.

Con el contenedor levantado, el smoke check comprueba el proceso, FFmpeg y sesiones
pendientes. Para convertir YouTube y Android en requisitos obligatorios:

```bash
KPL_SMOKE_REQUIRE_YOUTUBE=true KPL_SMOKE_REQUIRE_MOBILE=true npm run production:smoke
```

## Grabación local para falso directo

En la configuración de la pista, selecciona **Grabación local**, guarda y pulsa
**Preparar grabación** → **Grabar** en Mandos. Se guarda el programa completo
(cámara, audio y marcador) en MP4 H.264/AAC sin preparar ni enviar vídeo a YouTube.
Pulsa **Detener** antes de utilizar el archivo como fuente multimedia para emitirlo después.

Los archivos están en `data/recordings/<pista>/<sesión>/` con la configuración por
defecto. En **Ajustes generales** de Emisiones, pulsa **Elegir carpeta** para recorrer las
carpetas reales del equipo de emisión y seleccionar otra ubicación sin escribir ni copiar rutas;
el runtime creará dentro de ella las subcarpetas de pista y sesión. Si usas Docker, `/app/data/recordings`
corresponde a `./data/recordings` en el host. La carpeta se sitúa junto al archivo de configuración
del runtime. Las grabaciones se conservan al detener o reiniciar el servicio.
Cada reinicio del encoder crea un archivo nuevo, sin sobrescribir las partes anteriores.
El MP4 se escribe por fragmentos para conservar las partes completas si se interrumpe el proceso.
Revisa el espacio disponible antes de grabar partidos largos; la grabación termina si se llena el disco.
