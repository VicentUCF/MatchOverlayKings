# Migración de publicaciones a RabbitMQ

## Objetivo

Separar la reconciliación de YouTube de las lecturas HTTP. Abrir o refrescar
**Grabaciones** ya no debe consumir cuota de YouTube ni escribir el índice en
disco. RabbitMQ conserva los trabajos y aplica reintentos aunque el navegador se
cierre.

La primera fase mueve solamente la comprobación posterior a una subida y la
confirmación de una publicación programada. La transferencia del MP4 permanece en
el proceso actual para conservar las garantías de subida reanudable existentes.

## Topología

- Exchange directo `kpl.publications.exchange`.
- Cola durable `kpl.publications.reconcile`, consumidor con `prefetch=1` y `ack`
  manual.
- Colas TTL durables para 5 s, 30 s, 5 min, 30 min, 1 h, 6 h y 24 h. Al caducar,
  RabbitMQ devuelve el mensaje a la cola principal mediante dead lettering.
- Exchange y cola muerta `kpl.publications.dead.*` para mensajes no válidos o
  errores que agotan 48 intentos.
- Mensajes persistentes y publicación mediante publisher confirms.

La entrega es **al menos una vez**. Cada cadena de reconciliación lleva un token
persistido en `recording-library.json`; al reiniciar se gira el token. Los mensajes
antiguos se reconocen sin actuar, evitando cadenas de reintento duplicadas.

## Estados y reintentos

| Situación | Comportamiento |
|---|---|
| YouTube sigue procesando | nueva comprobación en 5 s |
| Error transitorio | 5 s, 30 s, 5 min y 30 min |
| Límite temporal | 5 min |
| Cuota o autorización caducada | 30 min |
| Publicación programada | siguiente bucket anterior a la fecha prevista |
| Privado listo o publicado | termina la cadena |

`GET /api/pilot/recordings` es una lectura pura del snapshot local. El frontend
mantiene un único canal SSE autenticado en `/api/pilot/events`. Cuando RabbitMQ o
el runtime cambia un snapshot, el canal envía solamente su ámbito y versión; el
navegador vuelve a leer el recurso autorizado correspondiente. Durante trabajos
activos queda un sondeo de recuperación cada 60 s, por si el canal se interrumpe.
Las consultas se serializan, por lo que no se solapan.

En el panel de producción, `teams` y `configurations` se cargan al entrar o después
de una mutación, no en cada ciclo. `readiness`, `sessions` y `mobile-cameras` se
sirven juntos desde `/api/pilot/runtime-snapshot`, por lo que cada invalidación
operativa produce una sola lectura. Estas invalidaciones se agrupan como máximo
cada 2 s; las de grabaciones, cada 1 s. El stream se reconecta cada cinco
minutos para renovar la autorización. En DevTools es normal ver una petición
`events` pendiente; sustituye las ráfagas periódicas anteriores.

## Despliegue

1. Copiar los nuevos valores de `.env.pilot.docker.example` a
   `.env.pilot.docker` y usar una contraseña larga alfanumérica.
2. Validar la composición:

   ```bash
   docker compose --env-file .env.pilot.docker config --quiet
   ```

3. Construir y arrancar:

   ```bash
   docker compose --env-file .env.pilot.docker up -d --build
   ```

4. Confirmar que RabbitMQ está sano y que el runtime arrancó después:

   ```bash
   docker compose --env-file .env.pilot.docker ps
   docker compose --env-file .env.pilot.docker logs --tail=100 rabbitmq kpl-pilot
   ```

5. Subir un MP4 privado de prueba. Cerrar el navegador mientras YouTube lo
   procesa y volver a abrirlo: el trabajo debe terminar como `private_ready`.
6. Forzar una credencial o cuota no disponible en un entorno de prueba. El
   snapshot debe incluir `retryAt` y no deben aparecer consultas cada dos
   segundos en los registros.
7. Abrir Network en el navegador: debe quedar una petición `events` pendiente y
   solo deben aparecer lecturas de snapshots cuando cambie su estado.

RabbitMQ no publica ningún puerto al host. Sus datos se conservan en el volumen
`rabbitmq-data`. No incluir la URL AMQP ni las credenciales en diagnósticos.

## Observabilidad y alertas

Antes de considerar completada la migración en producción, observar durante una
jornada:

- profundidad y antigüedad de `kpl.publications.reconcile`;
- mensajes en `kpl.publications.dead`;
- reconexiones del cliente AMQP;
- trabajos `processing` cuyo `retryAt` haya vencido;
- cuota de YouTube y escrituras de `recording-library.json`.

Un mensaje en la cola muerta requiere revisar el trabajo y YouTube antes de
republicarlo. No se debe borrar el volumen de RabbitMQ como forma de reintento.

## Rollback

El rollback no requiere revertir `recording-library.json`; los campos nuevos son
opcionales. Para una contingencia:

1. Detener nuevas subidas.
2. Conservar `./data` y el volumen `rabbitmq-data`.
3. Desplegar la versión anterior del runtime.
4. Inspeccionar los trabajos `processing` antes de usar la actualización manual;
   nunca crear otra subida para un trabajo que ya tenga `youtubeVideoId`.

No se recomienda desactivar solamente RabbitMQ en la versión nueva: sin
`KPL_RABBITMQ_URL` se activa la cola temporal en memoria, apropiada para desarrollo
pero no durable ante reinicios.

## Fases posteriores

1. Mover la subida por chunks a un worker separado, después de introducir un
   outbox transaccional para la sesión reanudable.
