# Supabase setup

## Local

```bash
supabase start
supabase db reset
supabase test db
```

La migracion inicial crea el club `kpl`, 4 pistas (`pista-1` a `pista-4`), equipos base, `score_states`, `score_events`, RLS y RPCs de marcador. La produccion se completa con las migraciones de control, operaciones reclamables y la migracion hacia delante `20260914120000_enable_pista_4_production.sql`, que habilita `pista-4`.

## Proyecto remoto

1. Crea un proyecto en Supabase.
2. Aplica `supabase/migrations`.
3. Activa Realtime para `public.score_states` si la migracion no lo ha podido anadir a `supabase_realtime`.
4. Crea el usuario del club en Auth con email/password.
5. Entra una vez en `/admin`; `claim_default_club()` asocia el primer usuario autenticado al club `kpl`.
6. Desactiva altas publicas si no quieres que alguien pueda registrar usuarios desde Auth.
7. Para el agente local, aprovisiona mediante los RPC de produccion un principal `agent` activo, su asignacion `agent` activa para cada evento, una captura activa asignada, una salida `program` habilitada y su estado deseado. Un evento solo puede pasar a `ready` o `live` cuando se cumplen esos requisitos, el dia esta activo y la ventana horaria es valida.

Para aplicar desde el repo:

```bash
SUPABASE_DB_URL='postgresql://...' npm run supabase:deploy
npm run supabase:check
```

El runner usa `public.kpl_schema_migrations`, verifica el SHA-256 y ejecuta cada archivo pendiente junto con su registro en una transaccion. Si el proyecto ya tiene esquema pero aun no tiene este registro, configura una sola vez `KPL_MIGRATION_BASELINE_THROUGH=<ultimo-archivo-ya-aplicado.sql>`; sin una base explicita el despliegue se detiene en lugar de repetir migraciones.

Usa la connection string de Postgres desde Settings > Database. Las API keys nuevas (`sb_publishable_...` y `sb_secret_...`) no ejecutan DDL SQL.

El agente se autentica con una publishable key y `KPL_AGENT_ACCESS_TOKEN` de su principal Auth. No le des una service-role key. El token solo puede leer snapshots y reclamar operaciones de eventos con una asignacion `agent` activa. Los snapshots omiten referencias de secretos para clientes no autorizados; las referencias `local://` se resuelven exclusivamente en el host del agente.

## Control de produccion y `/admin`

`/admin` muestra snapshots de las cuatro pistas. Un `viewer` puede observarlos. Un `operator` y un `production_admin` pueden solicitar reconciliacion de estados deseados. La respuesta de la consola confirma una solicitud, no una salida ya aplicada: el agente la reclama, reconcilia el snapshot, informa un estado observado con secuencia monotona y completa o falla la operacion.

Solo un `production_admin` puede conceder o revocar roles humanos. El rol `operator` no administra roles. El primer usuario `admin` del club recibe `production_admin`; los usuarios `member` no reciben ese rol de forma automatica.

El agente consulta `production_list_claimable_operations_v1`, `production_get_assigned_output_snapshots_v1`, `production_claim_operation_v1`, `production_report_observed_state_v1` y `production_complete_operation_v1`. No hay que crear tablas, modificar RLS ni invocar esos RPC manualmente durante la operacion normal.

## Variables Vercel

```bash
VITE_SUPABASE_URL=...
VITE_SUPABASE_PUBLISHABLE_KEY=...
```

## Seguridad

- La publishable key se usa en el frontend; la secret key queda fuera de Vercel/Vite.
- El rol publico solo puede leer equipos y `score_states` con `status = 'live'`.
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

Los tests de produccion cubren aprovisionamiento, snapshots de salidas asignadas, operaciones
reclamables, secuencias observadas y permisos. Ejecutalos solo cuando Supabase CLI y Docker esten
disponibles:

```bash
supabase start
supabase db reset
supabase test db
```

Este repositorio no incluye Android, YouTube, camaras de red ni una UI de aprovisionamiento. No
copies secretos, tokens ni valores `local://` con material sensible a migraciones, configuracion de
Vite o registros.
