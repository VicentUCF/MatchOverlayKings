# Estructura de aplicaciones

El código operativo se organiza por responsabilidad, no por tipo de archivo global:

- `server/src/features/recordings`: caso de uso de grabaciones, persistencia y rutas HTTP.
- `server/src/infrastructure/queues`: transporte asíncrono y topología RabbitMQ.
- `web/src/features/recordings`: interfaz del archivo y publicación.
- `web/src/features/production`: contratos, adaptadores, orquestación y pruebas del panel técnico.
- `web/src/features/match-display`: componentes visuales compartidos por directo, control y overlay.
- `web/src/routes`: composición y carga diferida de cada entrada de navegación.
- `production-agent`: referencia histórica aislada de los flujos operativos soportados.

Las nuevas funcionalidades deben vivir en una carpeta de dominio o feature. `components` y `lib`
quedan reservadas para piezas realmente compartidas entre varias features; no deben convertirse en
el destino predeterminado de todo archivo nuevo.
