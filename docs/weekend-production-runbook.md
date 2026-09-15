# Runbook de la primera emisión real

Este documento es la lista operativa para la primera jornada real. El objetivo
es detectar los fallos antes de abrir el directo y recuperar la misma emisión si
el runtime local se reinicia, sin crear broadcasts duplicados.

## Responsables y límites

- Una persona opera `Mandos` y el marcador.
- Una segunda persona debe estar localizable durante la primera prueba para
  revisar cableado, red o el móvil si hay una incidencia física.
- El flujo soportado este fin de semana es el centro local servido por Docker,
  Supabase como fuente del marcador y YouTube como destino.
- El sistema admite tres salidas simultáneas, pero actualmente solo una sesión de
  cámara Android a la vez. Para varias pistas deben usarse fuentes V4L2 o señal
  sintética en las demás.
- El `docker-compose.yml` base no expone dispositivos `/dev/video*`. Una fuente
  V4L2 solo se considera soportada cuando se haya añadido explícitamente el
  dispositivo al despliegue y superado una prueba privada; no configurarlo por
  primera vez el día del evento.
- La recuperación conserva sesiones y destinos, pero una cámara Android debe
  volver a enlazarse después de reiniciar por completo el servicio local.

## El día anterior

- [ ] Ejecutar `npm run verify` con el código exacto que se utilizará.
- [ ] Ejecutar `npm run production:local:check`.
- [ ] Confirmar que las migraciones de Supabase están aplicadas con
  `npm run supabase:check`.
- [ ] Levantar el sistema con `npm run production:local:up`.
- [ ] Abrir `http://localhost:4310/ready` y comprobar que responde con `ok: true`.
- [ ] Entrar en `http://localhost:4310/admin` y conectar YouTube.
- [ ] Ejecutar `KPL_SMOKE_REQUIRE_YOUTUBE=true npm run production:smoke` y resolver
  todos los resultados `ERROR`.
- [ ] Configurar los partidos y guardarlos para vincular emisión y marcador.
- [ ] Preparar una emisión privada de prueba por cada fuente física que se usará.
- [ ] Mantener la prueba al menos 30 minutos y comprobar una velocidad igual o
  superior a `0.95x`.
- [ ] Verificar vídeo, overlay, actualización del marcador y audio desde otro
  dispositivo usando el enlace real de YouTube.
- [ ] Probar detener y volver a preparar una sesión.
- [ ] Probar el simulacro de reinicio descrito más abajo.
- [ ] Dejar una regleta, cargador del móvil y cable de red identificados.
- [ ] Desactivar suspensión automática y ahorro de energía del PC.
- [ ] Si se usa Android, dejarlo conectado a corriente, desactivar bloqueo de
  pantalla y cerrar aplicaciones que puedan reclamar cámara o micrófono.

## Antes de abrir cada emisión

- [ ] El panel muestra `Agente · Conectado`.
- [ ] FFmpeg aparece disponible.
- [ ] YouTube aparece conectado.
- [ ] La pista muestra los equipos y horario correctos.
- [ ] El control visual muestra el mismo partido que la emisión.
- [ ] La fuente seleccionada tiene preview estable.
- [ ] El perfil aplicado es el esperado.
- [ ] Hay audio cuando se espera audio y no hay saturación perceptible.
- [ ] El marcador cambia en el preview al sumar y deshacer un punto de prueba.
- [ ] La emisión se prepara inicialmente como `Privado`.
- [ ] La miniatura, título y descripción son correctos.
- [ ] Después de pulsar `Emitir`, FPS, bitrate y velocidad empiezan a actualizarse.
- [ ] YouTube informa `active · good` antes de cambiar la privacidad o compartir
  el enlace.
- [ ] `KPL_SMOKE_REQUIRE_YOUTUBE=true npm run production:smoke` no devuelve
  errores. Añadir `KPL_SMOKE_REQUIRE_MOBILE=true` cuando la fuente sea Android.

## Durante el directo

- Mantener abierta la pestaña `Mandos`.
- Mantener abierta una segunda pestaña con el directo de YouTube silenciado para
  comprobar la señal que recibe el público.
- No cambiar fuente, cámara, FPS o audio con una sesión activa.
- No volver a pulsar preparar si una sesión aparece como `Interrumpida` o
  `Fallida`; usar `Recuperar emisión` para conservar el broadcast existente.
- No reiniciar Docker como primera respuesta a un fallo de cámara. Revisar antes
  la pista, el mensaje y el estado del móvil.
- Consultar registros con `npm run production:local:logs` desde una terminal de
  soporte, sin cerrar el navegador del operador.

## Matriz de incidencias

### El navegador no contacta con el runtime

1. No cerrar ni recrear el directo en YouTube.
2. Abrir `http://localhost:4310/ready`.
3. Si responde, abrir `http://localhost:4310/mandos` y operar desde el panel local.
4. Si no responde, consultar `npm run production:local:logs`.
5. Reiniciar con `npm run production:local:up` solo si el servicio no se recupera.
6. Volver a Mandos; la sesión debe aparecer como `Interrumpida`.
7. Comprobar la fuente y pulsar `Recuperar emisión`.

### FFmpeg, el overlay o una fuente se interrumpen

1. El sistema pasa a `Recuperando señal` y realiza hasta cinco intentos con
   backoff.
2. No pulsar preparar y no crear otro broadcast.
3. Corregir cableado o disponibilidad de la fuente mientras reintenta.
4. Si termina en `Fallida`, comprobar la fuente y pulsar `Recuperar emisión`.
5. Si no es recuperable, pulsar `Finalizar sesión` antes de preparar otra.

### El servicio o el PC se reinician

1. Levantar el servicio con `npm run production:local:up`.
2. Abrir Mandos y localizar `Interrumpida`.
3. No preparar otra emisión.
4. Para una cámara Android, generar un nuevo enlace desde Emisiones, abrirlo en el
   móvil y esperar a que la cámara figure como lista.
5. Pulsar `Recuperar emisión`; se reutilizan el ID y la entrada protegida del
   broadcast existente.
6. Confirmar de nuevo la salud real desde YouTube.

### La cámara Android queda offline

1. Mantener el móvil desbloqueado, conectado a corriente y con Chrome visible.
2. Comprobar que móvil y PC siguen en la misma red privada.
3. Esperar la reconexión automática.
4. Si el enlace caducó o se reinició el servicio, generar uno nuevo.
5. No cambiar cámara, perfil o audio durante una emisión activa.

### YouTube muestra mala salud pero el encoder está estable

1. Comprobar la conexión de subida y evitar tráfico no esencial.
2. Confirmar que la velocidad del encoder sigue por encima de `0.95x`.
3. No preparar otro broadcast.
4. Esperar la actualización de salud durante al menos dos ciclos.
5. Si la señal continúa llegando, mantener la sesión y registrar la incidencia.
6. Si deja de llegar y la sesión falla, usar `Recuperar emisión`.

### Supabase o el marcador dejan de responder

1. No detener automáticamente la emisión de vídeo.
2. El compositor debe conservar el último frame válido del overlay.
3. Revisar conectividad a Internet desde un segundo dispositivo.
4. No resetear el marcador ni crear otro partido.
5. Cuando vuelva la conexión, confirmar la versión y el tanteo antes de continuar.

### Hay que abandonar una sesión dañada

1. Pulsar `Finalizar sesión`.
2. Confirmar en YouTube que el broadcast anterior quedó finalizado.
3. Corregir la fuente o configuración.
4. Preparar una sesión nueva solo después de que Mandos muestre la anterior como
   `Finalizada`.

## Simulacro obligatorio de recuperación

Realizarlo con una emisión privada o simulación, nunca por primera vez durante el
evento:

1. Preparar e iniciar una señal.
2. Esperar a que aparezcan métricas estables.
3. Ejecutar `npm run production:local:down`.
4. Levantar de nuevo con `npm run production:local:up`.
5. Confirmar que la sesión aparece como `Interrumpida`, con el mismo título y el
   mismo enlace de YouTube si corresponde.
6. Reconectar la cámara Android si se utilizaba.
7. Pulsar `Recuperar emisión`.
8. Confirmar que la sesión vuelve a `Emitiendo` y que no se creó otro broadcast.
9. Detenerla desde Mandos.

## Cierre de jornada

- [ ] Finalizar todas las sesiones desde Mandos.
- [ ] Confirmar en YouTube que no queda ningún broadcast activo.
- [ ] Guardar los logs relevantes de cualquier incidencia.
- [ ] Registrar minutos de preparación, intervenciones y tiempo de recuperación.
- [ ] No borrar `./data`: contiene configuración, OAuth y el journal recuperable.
- [ ] Apagar con `npm run production:local:down`.

## Resultado mínimo para considerar superada la prueba

- Una persona puede operar la emisión desde el panel.
- No se abre OBS ni YouTube Studio durante el flujo normal.
- No se crea ningún broadcast duplicado después de una interrupción.
- Un reinicio conserva la sesión y permite recuperarla desde Mandos.
- La emisión mantiene `speed >= 0.95x` durante 30 minutos.
- Título, equipos, miniatura, marcador y privacidad son correctos.
- Toda incidencia queda registrada con su acción de recuperación.
