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
3. Verifica que las migraciones han añadido a `supabase_realtime` el marcador y las tablas del
   inventario de producción. Así, altas, bajas, permisos y asignaciones aparecen sin redesplegar.
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

`/admin` obtiene de Supabase todas las pistas del club ordenadas por `display_order`. Un `viewer`
puede observar el control plane. Un `operator` y un `production_admin` operan las emisiones en el
runtime local unificado; una pista desactivada continúa visible, pero no puede prepararse ni
iniciarse. Si Realtime se interrumpe se conserva el último inventario válido y se muestra una
advertencia explícita.

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

### Avisos del Security Advisor

La migracion `20260916120000_harden_function_security.sql` corrige los 52 avisos
`function_search_path_mutable` del informe del 16/09/2026 con un `search_path` vacio
y referencias de aplicacion ya cualificadas. Tambien revoca la ejecucion para
`PUBLIC`, `anon` y `authenticated` de cinco helpers internos:
`kpl_load_command_context`, `kpl_require_club_member`, `kpl_store_state`,
`production_prepare_command` y `production_require_human_admin`. Esto elimina los
cinco avisos de acceso anonimo y cinco de los 41 avisos de acceso autenticado.
`kpl_store_state` debe permanecer interno porque confia en la autorizacion de la
RPC que lo llama. Las nuevas funciones no reciben permisos de cliente por defecto
cuando se crean con el mismo rol que ejecuta la migracion, en cualquier esquema:
se retiran tanto los defaults globales como los de `public`. Cada nueva RPC debe
conceder `EXECUTE` explicitamente al rol correspondiente.

Los 36 avisos restantes de `authenticated_security_definer_function_executable`
corresponden a acceso intencional: RPCs de marcador y produccion, bootstrap del
club y helpers usados por RLS. Las RPCs comprueban membresia, rol o asignacion;
`claim_default_club` permite el alta inicial solo mientras el club no tiene usuarios.
No se deben revocar sus permisos ni cambiar a `SECURITY INVOKER` sin redisenar
el acceso: las escrituras directas siguen bloqueadas y los helpers RLS necesitan
leer las tablas de autorizacion sin recursion. Revisar estos avisos por funcion;
no ocultar indiscriminadamente todos los avisos de esta categoria.

`auth_leaked_password_protection` se configura fuera de las migraciones SQL:
activar la proteccion de contrasenas filtradas en los ajustes de Supabase Auth.
Segun la [documentacion de Supabase](https://supabase.com/docs/guides/auth/password-security),
requiere un plan Pro o superior.

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

`supabase/tests/function_security.sql` verifica rutas de busqueda fijas, ausencia
de ejecucion anonima de funciones privilegiadas, bloqueo de los cinco helpers
internos para ambos roles y permisos por defecto de futuras funciones.

El runtime local incluye Android, YouTube y la operación de emisiones; Supabase conserva el
inventario, acceso, identidad de partido y marcador autoritativos. No copies secretos, tokens ni
valores `local://` con material sensible a migraciones, configuracion de Vite o registros.
