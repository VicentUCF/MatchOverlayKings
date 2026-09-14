# Runbook del agente de produccion local

Este agente Linux controla cuatro pistas configuradas con un MediaMTX compartido y cuatro
pipelines `FfmpegCourtPipeline`. El supervisor admite como maximo tres pipelines activos
(`KPL_AGENT_MAX_CONCURRENT_PIPELINES=3`). Si las cuatro pistas solicitan `preflight` o `running`,
la cuarta queda aplazada por capacidad, `capacity-deferred`, hasta que una de las otras libere
capacidad.

El agente usa sondeo. En cada ciclo reclama operaciones elegibles, carga snapshots de salida
asignada, estado deseado y estado observado, reconcilia las cuatro pistas, informa una observacion
con secuencia monotona y completa las operaciones reclamadas despues de informar el resultado. Un
boton de `/admin` reconoce `reconciliation_requested`, no una salida ya aplicada. Los snapshots
autorizados son la fuente de verdad.

## Limites del MVP

- No admite Android, YouTube ni camaras de red.
- No incluye una interfaz de aprovisionamiento.
- No usa ni acepta una Supabase service-role key.
- Solo acepta captura local Linux `v4l2`, audio ALSA opcional, MediaMTX y salida local SRT/MPEG-TS.
- La publicacion SRT y la API de MediaMTX quedan en loopback. Ese limite es de confianza local, no
  autenticacion de publicadores remotos.

## Antes de arrancar

1. Aplica las migraciones y aprovisiona el evento, agente, captura, salida y estado deseado como
   describe [../../supabase/README.md](../../supabase/README.md). El agente solo recibe snapshots
   de eventos donde tiene una asignacion `agent` activa. Cada salida necesita un estado deseado.
2. Comprueba que las cuatro pistas estan habilitadas. La migracion
   `20260914120000_enable_pista_4_production.sql` habilita `pista-4` hacia delante. No la omitas en
   una base ya existente.
3. Instala los binarios locales configurados: MediaMTX version `1.21.0` y FFmpeg. Verifica que el
   usuario del agente puede acceder a cada `/dev/video*`, al dispositivo ALSA configurado y a los
   directorios de trabajo.
4. Crea un directorio de secretos local, absoluto y propiedad del usuario del agente, por ejemplo
   `/var/lib/kpl-agent/secrets` con modo `0700`. Cada secreto debe ser un archivo regular `0600`.
   `local://outputs/program` se resuelve debajo de ese directorio como `outputs/program`.

No guardes tokens, claves de salida ni archivos de secretos en este repositorio ni en los logs.
No pongas secretos en argumentos de proceso o variables heredadas por hijos. Los valores
`local://` no pueden ser vacios, atravesar directorios, apuntar a enlaces simbolicos, directorios
o archivos sobredimensionados. Los directorios bajo la raiz no pueden tener escritura para grupo u
otros. Los ancestros deben pertenecer a root o al usuario efectivo del agente y no ser escribibles
por grupo u otros, salvo un directorio sticky como `/tmp`. Este modelo depende de permisos POSIX y
de un sistema de archivos local.

## Configuracion

Parte de [`.env.example`](.env.example), pero conserva el archivo real fuera del repositorio y con
modo `0600`. Solo se aceptan estas variables `KPL_AGENT_*`; una variable adicional con ese prefijo
hace fallar la configuracion.

| Variable | Contrato |
| --- | --- |
| `KPL_AGENT_COURT_IDS` | Exactamente cuatro UUID unicos, el mismo conjunto que `courtIds` y `bindings.courts` del JSON de medios. |
| `KPL_AGENT_MAX_CONCURRENT_PIPELINES` | Exactamente `3`. |
| `KPL_AGENT_SUPABASE_URL` | Origen HTTPS de Supabase, sin credenciales, ruta, consulta ni fragmento. |
| `KPL_AGENT_SUPABASE_PUBLISHABLE_KEY` | Publishable key del proyecto. |
| `KPL_AGENT_ACCESS_TOKEN` | Token de un usuario Auth que corresponde a un principal `agent` activo. No hay refresco de token en este proceso. |
| `KPL_AGENT_SECRET_ROOT` | Ruta absoluta a la raiz POSIX de secretos local. |
| `KPL_AGENT_POLL_INTERVAL_MS` | Entero entre `100` y `60000`. |
| `KPL_AGENT_SHUTDOWN_DEADLINE_MS` | Entero entre `1000` y `120000`. |

El archivo [`media-config.example.json`](media-config.example.json) es JSON valido para el esquema
actual. Sus UUID, rutas de binarios, puertos, dispositivos, nombres ALSA, tiempos y rutas de
stream son marcadores especificos del sitio, no valores predeterminados ni un mapeo de dispositivos
para copiar sin revisar. Sustituye esos datos por los de la instalacion y mantén el mismo conjunto
de cuatro UUID que `KPL_AGENT_COURT_IDS`.

El JSON exige:

- `mediaMtxVersion` igual a `1.21.0`, rutas absolutas para MediaMTX, FFmpeg y el directorio de
  ejecucion, modo de directorio `0700` y modo de configuracion `0600`, expresados en JSON como
  `448` y `384`, y persistencia `ephemeral`.
- Tiempos de inicio y salud entre `100` y `120000` ms, y gracia de parada entre `100` y `30000` ms.
- API y SRT en `127.0.0.1`, cuatro enlaces de pista con UUID y `pathName` unicos, al menos una
  entrada `v4l2` bajo `/dev/`, audio ALSA opcional y valores de pixel admitidos `yuyv422` o `mjpeg`.
- Si el perfil deseado activa `overlayEnabled`, el proceso necesita una fuente de frames disponible.
  La fuente aporta el descriptor de entrada raw por fd `4`: `rgba` o `bgra`, ancho de `640` a
  `7680`, alto de `360` a `4320` y de `24` a `120` fps. Sus dimensiones y fps deben coincidir con
  el perfil deseado. El JSON de medios no configura esa fuente ni inventa un mapeo de overlay.

MediaMTX genera una configuracion efimera con API autenticada solo en loopback, cuatro paths de
publicacion y protocolos no usados desactivados. FFmpeg se inicia sin shell, con progreso por fd
`3` y el overlay opcional por fd `4`.

## Arranque, observacion y parada

Desde la raiz del repositorio, construye y arranca con un unico argumento absoluto:

```bash
npm run build
npm run start:production-agent -- /absolute/path/to/media-config.json
```

El proceso rechaza cero o mas de un argumento, rutas relativas, JSON invalido, variables invalidas
o UUID de pistas que no coincidan. Al iniciar, MediaMTX debe informar exactamente los cuatro paths
configurados antes de que el agente entre en reconciliacion.

Observa los registros JSON de `agent_started`, `snapshot_loaded`, `operation_claimed`,
`output_health`, `operation_completed`, `agent_error`, `retry_scheduled` y `agent_stopped`. No
esperes claves, tokens, referencias `local://` ni argumentos sensibles en esos registros. En
`/admin`, usa la hora del snapshot, la version deseada, la salud observada y el estado de la ultima
operacion para decidir si una solicitud quedo aplicada, aplazada o fallo.

Para parar el proceso, enviale `SIGINT` o `SIGTERM` y espera el plazo configurado. La parada aborta
las llamadas de control en curso, deja de admitir trabajo, detiene los pipelines de pista y despues
MediaMTX. FFmpeg recibe `SIGTERM` y puede escalar a `SIGKILL`; MediaMTX recibe `SIGINT`, luego
`SIGTERM` y, si hace falta, `SIGKILL`.

## Uso seguro de `/admin`

Un usuario autenticado con acceso de produccion puede ver el snapshot. Un `viewer` solo observa.
Un `operator` o `production_admin` puede solicitar estados `off`, `preflight`, `running` y
`stopped`, siempre que el snapshot no este obsoleto, la pista este habilitada y no haya una solicitud
pendiente. Un `production_admin` tambien puede conceder o revocar roles humanos; un `operator` no
puede escalar permisos.

Antes de solicitar `running` o de pasar un evento a `ready` o `live`, confirma el dia activo, la
ventana horaria, una salida `program` habilitada, un agente activo asignado y una captura activa
asignada. El estado deseado debe usar el UUID de la pista, una camara asignada, parametros de video
validos, audio opcional asignado y el ajuste de overlay. No interpretes la aceptacion de la consola
como disponibilidad de señal: espera al siguiente snapshot y al estado observado.

## Verificacion sin servicios externos

Estos comandos validan codigo y configuracion local. No prueban hardware, MediaMTX, Supabase remoto
ni flujos de extremo a extremo:

```bash
npm run build --workspace=@kpl/production-contracts
npm run typecheck:test --workspace=@kpl/production-agent
npm test --workspace=@kpl/production-agent
python3 -m json.tool apps/production-agent/media-config.example.json >/dev/null
```

Para validar el ejemplo con el esquema compilado, ejecuta despues del build:

```bash
node --input-type=module -e "import { readFile } from 'node:fs/promises'; import { LocalMediaRuntimeConfigSchema } from './apps/production-agent/dist/index.js'; LocalMediaRuntimeConfigSchema.parse(JSON.parse(await readFile('./apps/production-agent/media-config.example.json', 'utf8')));"
```
