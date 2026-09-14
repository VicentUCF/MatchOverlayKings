# KPL Live Overlay Control

Frontend Vite/React para controlar marcadores de padel y overlays OBS de KingsPadelLeague. Produccion usa Vercel para servir la web y Supabase como backend: Auth, Postgres, RLS, RPC y Realtime.

## Arquitectura v1

- 4 pistas fijas: `pista-1`, `pista-2`, `pista-3`, `pista-4`.
- `/` es publico y solo lista partidos en directo.
- `/live/:courtSlug` es publico y solo muestra una pista si esta `live`.
- `/admin` usa Supabase Auth email/password y lista todas las pistas del club.
- `/control/:courtSlug` tiene dos fases: configuracion del partido y marcador.
- `/overlay/:courtSlug/scoreboard` es la ruta fija para OBS.
- El frontend no calcula acciones criticas: llama RPCs de Supabase (`add_point`, `undo_last`, `manual_patch`, `reset_match`, `new_match`, `set_match_status`).
- `score_states.state` conserva el `MatchState` actual en JSONB y `score_events` guarda auditoria completa.

El servidor Fastify/Socket.IO queda como compatibilidad legacy local, no como backend de produccion.

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
- RLS para lectura publica solo de `score_states.status = 'live'`
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

## Agente de produccion local

El agente local gestiona cuatro pistas y un unico servicio MediaMTX. Solo admite tres procesos
FFmpeg simultaneos, por lo que la cuarta solicitud activa queda en estado `capacity-deferred`
hasta que haya capacidad. No sustituye el marcador, las rutas publicas ni el overlay OBS.

Consulta el runbook de [apps/production-agent/README.md](apps/production-agent/README.md) antes
de instalarlo. La configuracion separa el entorno secreto de la configuracion de medios, que se
pasa como un unico argumento de ruta absoluta:

```bash
npm run build
npm run start:production-agent -- /absolute/path/to/media-config.json
```

El proceso necesita `KPL_AGENT_SUPABASE_PUBLISHABLE_KEY` y `KPL_AGENT_ACCESS_TOKEN`, nunca una
service-role key. Sus cuatro UUID de `KPL_AGENT_COURT_IDS` deben ser el mismo conjunto que
`courtIds` y `bindings.courts` del JSON de medios.

El agente consulta por sondeo snapshots autorizados de asignacion, salida y estado deseado. Estos
snapshots son la fuente de verdad: una accion de `/admin` solo solicita reconciliacion. El agente
reconcilia, publica estados observados con secuencia monotona y solo entonces completa o falla la
operacion solicitada.

Quedan fuera del MVP: Android, YouTube, camaras de red, una interfaz de aprovisionamiento y el uso
de una service-role key.

## Producción local en el PC de emisión

La rama mantiene Supabase como fuente de verdad para autenticación, marcador y Realtime, pero
ejecuta en el PC de emisión todo el trabajo pesado: servidor web local, FFmpeg, MediaMTX y la
integración con YouTube. El operador puede abrir el panel publicado en Vercel desde ese mismo PC:
la web contacta al agente en `http://127.0.0.1:4310` y el navegador solicita permiso para acceder
a la red local. El panel local continúa disponible como alternativa. Vercel también sirve la
página HTTPS que necesita el móvil para conceder acceso a la cámara.

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

## Piloto de viabilidad

### Arranque reproducible con Docker

En un equipo nuevo con Docker Compose y acceso a Internet:

```bash
cp .env.pilot.docker.example .env.pilot.docker
# Edita Supabase, KPL_PILOT_LAN_HOST y KPL_PILOT_LAN_CIDR con los valores reales.
npm run production:local:up
npm run production:local:logs
```

Compose levanta un único contenedor con Node, FFmpeg, el frontend del piloto y MediaMTX `1.21.0`.
Publica el panel en `http://<IP-DEL-PC>:4310`, WHIP/WHEP en TCP `8889` y los candidatos ICE en
UDP `8189`. La API MediaMTX y RTSP no se publican al host: permanecen en loopback dentro del
contenedor. La carpeta `./data` conserva la configuración local y el token OAuth si se usa YouTube;
`.env.pilot.docker` no se versiona.

En este PC la interfaz LAN tiene la IP `192.168.68.55` y la red es `192.168.68.0/22`. El archivo
local `.env.pilot.docker` ha quedado configurado con esos dos valores. Como UFW está activo,
autoriza solamente esa red con una única orden (pedirá la contraseña de administrador):

```bash
./scripts/configure-pilot-firewall.sh 192.168.68.0/22
```

El script es idempotente y abre `4310/tcp`, `8889/tcp` y `8189/udp` únicamente para la LAN. No
activa UFW si estaba apagado, para no poner en riesgo un acceso SSH. No se deben abrir `8554` ni
`9998`, ni crear redirecciones de estos puertos en el router: el teléfono y el PC deben compartir
la misma red privada. En otro PC, sustituye la IP y el CIDR por los que muestre `ip -4 address`.

Después de levantar Compose, comprueba desde el PC `curl http://192.168.68.55:4310/health` y desde
el Android abre `http://192.168.68.55:4310`. La página de cámara final seguirá llegando mediante
el enlace HTTPS temporal generado por el panel.

El Compose usa una red bridge privada fija (`172.30.0.0/24`): solo su gateway `172.30.0.1` puede
usar las rutas administrativas, mientras que el teléfono sigue limitado a los endpoints móviles
con token y origen HTTPS.

Para apagarlo sin borrar datos: `npm run production:local:down`. Para actualizar la imagen, repite
`npm run production:local:up`.

El piloto separa la preparación y la operación de tres pistas independientes. La navegación del
administrador mantiene cargadas tres pestañas: Inicio en `/admin`, preparación en
`/admin/emisiones` y Mandos en `/mandos`. Cambiar entre ellas no recarga la página ni reinicia su
estado. El operador entra directamente en `/mandos`, donde solo puede preparar, iniciar, detener y
vigilar las emisiones. Su modo
`Simulacion local` genera titulo, descripcion y miniatura y ejecuta una codificacion FFmpeg 1080p30
real contra una salida nula: no crea recursos externos ni publica contenido.

```bash
npm run pilot
```

Abre `http://localhost:4310/admin`, inicia sesión y entra en **Emisiones**. Guarda cada pista
y entrega al operador `http://localhost:4310/mandos`. La configuración persiste en el agente local
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
directamente a Mandos, sin campos editables. El piloto mezcla automáticamente el marcador KPL
sobre la señal antes de enviarla a YouTube. La capa conserva transparencia real, refresca el
estado público de la pista desde Supabase cada segundo y mantiene el último frame válido si la
lectura falla, sin cortar el vídeo. Admite un único Android como cámara WebRTC para cualquiera de
las tres pistas. Instala MediaMTX `1.21.0`, configura las variables `KPL_PILOT_MEDIAMTX_*`
y `KPL_PILOT_LAN_*` del ejemplo y permite desde la LAN TCP `4310/8889` y UDP `8189`. RTSP `8554` y
la API `9998` permanecen ligados a `127.0.0.1`.

En **Emisiones**, selecciona **Móvil Android** y genera el enlace temporal. El enlace contiene el
secreto únicamente en el fragmento de URL, caduca a las 12 horas y deja de funcionar al revocarlo
o reiniciar el piloto. Ábrelo en Chrome Android actualizado, pulsa **Preparar cámara** y concede los
permisos solicitados. El panel habilita solamente las cámaras y los perfiles `720p30`, `720p60`,
`1080p30` o `1080p60` reportados por el dispositivo; también permite activar o silenciar su audio.
La pantalla `/mandos` muestra el preview WHEP, el formato realmente aplicado, bitrate, pérdida,
RTT y último heartbeat. La página del móvil debe permanecer visible y con la pantalla encendida.

Si MediaMTX o la LAN no están configurados, la fuente móvil aparece deshabilitada sin afectar a
V4L2 ni a la señal sintética. El objetivo del piloto sigue siendo reducir primero los riesgos de
hardware, codificación, OAuth, metadatos, miniatura, ingesta y salud de YouTube antes de incorporar
la solución al agente de producción.

## Vercel

Configura estas variables en Vercel:

```bash
VITE_SUPABASE_URL=...
VITE_SUPABASE_PUBLISHABLE_KEY=...
# Opcional; este es el valor predeterminado:
VITE_LOCAL_AGENT_URL=http://127.0.0.1:4310
```

El agente debe estar arrancado en el mismo PC desde el que se abre el panel. Añade el origen
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
