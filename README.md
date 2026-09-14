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

- Selector publico: `https://live.kingspadelleague.com/`
- Admin: `https://live.kingspadelleague.com/admin`
- Control pista 1: `https://live.kingspadelleague.com/control/pista-1`
- Overlay pista 1: `https://live.kingspadelleague.com/overlay/pista-1/scoreboard`

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

## Vercel

Configura estas variables en Vercel:

```bash
VITE_SUPABASE_URL=...
VITE_SUPABASE_PUBLISHABLE_KEY=...
```

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
