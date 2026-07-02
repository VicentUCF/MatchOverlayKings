# Supabase setup

## Local

```bash
supabase start
supabase db reset
supabase test db
```

La migracion inicial crea el club `kpl`, 4 pistas (`pista-1` a `pista-4`), equipos base, `score_states`, `score_events`, RLS y RPCs de marcador.

## Proyecto remoto

1. Crea un proyecto en Supabase.
2. Aplica `supabase/migrations`.
3. Activa Realtime para `public.score_states` si la migracion no lo ha podido anadir a `supabase_realtime`.
4. Crea el usuario del club en Auth con email/password.
5. Entra una vez en `/admin`; `claim_default_club()` asocia el primer usuario autenticado al club `kpl`.
6. Desactiva altas publicas si no quieres que alguien pueda registrar usuarios desde Auth.

## Variables Vercel

```bash
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

## Seguridad

- `anon` solo puede leer equipos y `score_states` con `status = 'live'`.
- `authenticated` solo puede leer pistas, eventos y auditoria si pertenece al club.
- Las mutaciones directas quedan bloqueadas por ausencia de politicas de escritura.
- Las RPCs de marcador revocan ejecucion publica y conceden solo a `authenticated`.
- Cada RPC valida membresia, bloquea la fila con `FOR UPDATE`, comprueba `expected_version`, usa `command_id` para idempotencia y escribe `score_events`.

## Tests

`supabase/tests/score_rpc.sql` cubre:

- anon no lee pistas sin directo y no puede mutar;
- sumar punto;
- golden point;
- tie-break;
- cierre de set y partido;
- undo;
- manual patch;
- nueva partida/reset;
- conflicto de version;
- idempotencia de `command_id`.
