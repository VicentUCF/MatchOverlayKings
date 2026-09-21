# Estructura de aplicaciones

El código operativo se organiza por responsabilidad, no por tipo de archivo global:

- `server/src/bootstrap`: composición de la aplicación y lectura de configuración.
- `server/src/core`: errores, persistencia de archivos y utilidades privadas compartidas.
- `server/src/realtime`: adaptación de conexiones y eventos Socket.IO.
- `server/src/features/pilot`: operación del piloto, señal, preflight, overlay y publicación.
- `server/src/features/production`: acceso y eventos del panel de producción.
- `server/src/features/recordings`: caso de uso de grabaciones, persistencia y rutas HTTP.
- `server/src/infrastructure/queues`: transporte asíncrono y topología RabbitMQ.
- `web/src/features/recordings`: interfaz del archivo y publicación.
- `web/src/features/production`: contratos, adaptadores, orquestación y pruebas del panel técnico.
- `web/src/features/match-display`: componentes visuales compartidos por directo, control y overlay.
- `web/src/routes`: composición y carga diferida de cada entrada de navegación.
- `production-agent/src/domain`: modelos, reglas de admisión, reconciliación y puertos.
- `production-agent/src/application`: casos de uso, supervisor y ciclo de reconciliación.
- `production-agent/src/infrastructure`: procesos, FFmpeg, MediaMTX, configuración y Supabase.
- `production-agent/src/bootstrap`: ensamblado del ejecutable histórico.

Las nuevas funcionalidades deben vivir en una carpeta de dominio o feature. `components` y `lib`
quedan reservadas para piezas realmente compartidas entre varias features; no deben convertirse en
el destino predeterminado de todo archivo nuevo. En las raíces de `server/src` y
`production-agent/src` solo se permiten puntos de entrada públicos. `npm run check:architecture`
protege este límite y forma parte de `npm run verify`.
