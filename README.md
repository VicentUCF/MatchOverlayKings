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

`SUPABASE_DB_URL` es la connection string de Postgres del proyecto Supabase. No sirve la publishable key ni la secret API key para crear tablas, RLS o funciones SQL.

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
