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
- El sistema admite tres salidas simultáneas y sesiones Android independientes
  por pista. Antes de usarlas en una jornada, validar tres dispositivos reales
  simultáneos durante 30 minutos; las pruebas automatizadas no sustituyen esta
  comprobación.
- El `docker-compose.yml` base no expone dispositivos `/dev/video*`. Una fuente
  V4L2 solo se considera soportada cuando se haya añadido explícitamente el
  dispositivo al despliegue y superado una prueba privada; no configurarlo por
  primera vez el día del evento.
- La recuperación conserva sesiones, destinos y enlaces Android mientras no
  caduquen ni se revoquen. Mantener el directorio de datos y la dirección LAN
  configurada; después de reiniciar, esperar la nueva confirmación de cada móvil.

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
- [ ] Opcionalmente, pulsar `Comprobar programa completo` y revisar los avisos de cada pista.
- [ ] Abrir `Ver programa de prueba`, comprobar equipos, tanteo y encuadre, y
  escuchar su audio. Es un clip local de diez segundos, no una emisión a YouTube.
- [ ] Revisar los avisos y decidir cuándo pulsar `Emitir`. La prueba es informativa:
  no es obligatoria ni sus resultados o antigüedad impiden iniciar.
- [ ] Después de pulsar `Emitir`, FPS, bitrate y velocidad empiezan a actualizarse.
- [ ] YouTube informa `live · active · good` antes de cambiar la privacidad o compartir
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

## Historial y recuperación de operaciones

- Abrir **Mandos → Historial de operaciones** y filtrar por pista. Cada solicitud
  conserva fecha, jornada e identificador de diagnóstico después de reiniciar.
- **Solicitud completada** confirma que el control terminó la acción. El estado
  real del directo se consulta en la tarjeta de la pista.
- Si se pierde una respuesta, reintentar desde la misma pestaña conserva el
  identificador incluso tras recargar. No borrar el almacenamiento de la pestaña
  para intentar forzar una operación cuyo resultado sea incierto.
- Una operación **Interrumpida** no se reproduce automáticamente. Al arrancar se
  vincula a la configuración o sesión conservada cuando puede identificarse con
  certeza; la respuesta de reintento devuelve su estado actual. Si existe una
  sesión, comprobarla y usar **Recuperar emisión** o **Finalizar sesión**.
- Si falló mientras preparaba YouTube, usar **Recuperar preparación**: busca los
  recursos en el mismo canal y continúa con sus identificadores. No inicia la
  emisión; después hay que pulsar **Emitir**. El destino se prepara en privado y
  adopta la visibilidad configurada al terminar.
- **Cancelar preparación** está disponible mientras YouTube responde. Si una
  creación no tiene respuesta confirmada y tampoco aparece en el canal, el cierre
  pide esperar un minuto y volver a **Finalizar sesión** para comprobar su ausencia.
  No cambiar de canal ni preparar otro destino para sortear este bloqueo.
  Preparaciones antiguas sin referencia de recuperación o referencias duplicadas
  necesitan revisar el destino antes de continuar.
- Si YouTube no confirma el cierre, el encoder local se detiene y la sesión queda
  fallida con explicación. Reintentar **Finalizar emisión**; no usar Recuperar.
- Al recuperar se vuelve a comprobar que Supabase conserva los mismos equipos.
  Un conflicto mantiene la emisión detenida hasta revisar el partido.
- Un encoder que deja de producir fotogramas se termina a los 20 segundos y entra
  en el backoff de recuperación. Tras cinco reintentos sin 30 segundos estables,
  queda **Fallida** y necesita intervención desde Mandos.
- Si el proceso MediaMTX termina, el servicio intenta arrancarlo cinco veces con
  esperas de 1, 2, 4, 8 y 15 segundos. Conserva los enlaces y rutas de las cámaras;
  cada móvil debe confirmar la nueva revisión antes de volver a aparecer listo.
  Si se agotan los intentos, **Recuperar emisión** también intenta restablecer
  MediaMTX. Esperar a que vuelva la cámara y repetir la recuperación de la emisión.
  Sin una sesión de emisión, revocar y regenerar el enlace permite reintentar.
- También se comprueba su API cada cinco segundos. Tres respuestas fallidas
  consecutivas provocan el cierre del proceso y la recuperación; una respuesta
  correcta reinicia el contador. Esta comprobación funciona sin Mandos abierto.
- Si MediaMTX rechaza la retirada de un enlace revocado, se cierra el proceso
  compartido para impedir que ese móvil conserve acceso. Las demás cámaras
  reconectan con sus enlaces originales; el enlace revocado no se restaura.
- En Linux se detectan encoders huérfanos con el PID, su instante de inicio y el
  identificador de arranque del sistema;
  nunca se termina un proceso distinto que reutilice ese PID. Tras retirarlo,
  la sesión sigue siendo la misma y puede recuperarse.
- La sección **Incidencias y cambios de estado** registra también las
  reconexiones automáticas y fallos, con gravedad escrita y fecha. Un aviso de
  almacenamiento en la preparación significa que no se pudo guardar el estado
  recuperable o el historial; evitar reiniciar mientras no se resuelva.

Conservar `pilot-configurations.json`, `.sessions`, `.operations` y
`mobile-camera-runtime/sessions.json` dentro del
directorio de datos. `.sessions` contiene entradas protegidas: no adjuntarlo a
incidencias ni copiarlo al navegador. El historial público excluye estas entradas.
El snapshot móvil conserva hashes, propietario, caducidad y configuración; nunca
guarda el token del enlace. No borrarlo para solucionar una reconexión.

## Matriz de incidencias

### Mandos muestra «Revisar señal» mientras sigue emitiendo

- La tarjeta conserva el estado real del directo y muestra los avisos de calidad
  por separado. Abrir **Mediciones recientes de señal** para consultar los últimos
  cinco segundos; las métricas empiezan después de diez segundos de calentamiento.
- Negro: al menos el 98 % de la imagen oscura durante tres segundos. Imagen
  inmóvil: ocho segundos sin cambio significativo. Comprobar la cámara; una pista
  quieta o sin iluminación puede activar el aviso sin que exista un bloqueo.
- Silencio: ocho segundos por debajo de −50 dB cuando el micrófono está habilitado.
  Las fuentes de silencio intencionado y el micrófono desactivado no generan este
  aviso. La detección no demuestra por sí sola que el audio sea inteligible.
- Rendimiento: menos del 80 % de FPS previstos, velocidad inferior a 0,95×,
  pérdida superior al 1 % de frames o bitrate inferior al 30 % del objetivo,
  sostenidos durante cinco segundos. El bitrate bajo también puede corresponder
  a una imagen sencilla; comprobar el destino antes de actuar.
- Estos avisos no reinician el directo. Se registran al aparecer y al resolverse
  en el historial de la pista. La ausencia de muestras también produce un aviso;
  el watchdog independiente sigue actuando si el encoder deja de avanzar.
- Calibrar estas comprobaciones con las cámaras previstas durante la prueba
  privada. Se utiliza una copia reducida del vídeo antes de superponer el marcador.

Referencia técnica: [metadatos y filtros de FFmpeg](https://ffmpeg.org/ffmpeg-filters.html#metadata_002c-ametadata).

### El navegador no contacta con el runtime

1. No cerrar ni recrear el directo en YouTube.
2. Abrir `http://localhost:4310/ready`.
3. Si responde, abrir `http://localhost:4310/mandos` y operar desde el panel local.
4. Si no responde, consultar `npm run production:local:logs`.
5. Reiniciar con `npm run production:local:up` solo si el servicio no se recupera.
6. Volver a Mandos; la sesión debe aparecer como `Interrumpida`.
7. Comprobar la fuente y pulsar `Recuperar emisión`.

### Se interrumpe la cámara durante una emisión

1. Mandos indica `Continuidad · Revisar cámara`. Se muestra el cartel de la pista,
   con el marcador superpuesto y audio en silencio. El encoder y el compositor
   siguen activos mientras se recupera la captura.
2. Si no llegan vídeo y audio válidos durante dos segundos, se reinicia la captura;
   al arrancar se conceden ocho segundos para recibirlos. Una salida explícita del
   capturador activa la continuidad inmediatamente.
3. Comprobar cableado o conectividad. Hay cinco reintentos, con esperas de 1, 2, 4,
   8 y 15 segundos. No preparar otro broadcast. Los avisos de negro, congelado y
   silencio quedan suspendidos mientras se muestra el cartel intencionado.
4. Al agotarse, aparece `Recuperar emisión`. Tras corregir la fuente, esta acción
   reinicia la captura conservando el encoder, el destino y la sesión.
5. El cartel se retira cuando vuelve el par de vídeo/audio. Comprobar la imagen y
   escuchar el micrófono desde otro dispositivo; el avance técnico no acredita
   por sí solo calidad de audio ni sincronía.
6. Si se abandona la emisión, pulsar `Detener` o `Finalizar sesión`. El cierre debe
   confirmarse en Mandos. El historial conserva activación y retirada del cartel.

### Se interrumpe el navegador o la conexión de datos del marcador

1. Mandos indica `Revisar marcador`. Si ya se había recibido una imagen válida,
   se conserva mientras continúa el vídeo. El tanteo mostrado puede estar
   desactualizado: comprobarlo con la persona que lleva el resultado.
2. Si ocurre antes de la primera imagen válida, la salida espera al marcador;
   no interpretar la sesión `Iniciando` como un directo ya confirmado.
3. Revisar conexión con Supabase y disponibilidad de la aplicación. No resetear
   el marcador ni preparar otro broadcast. El navegador realiza cinco reintentos
   con esperas de 1, 2, 4, 8 y 15 segundos. Cada apertura puede tardar hasta diez
   segundos antes de fallar.
4. Si termina en `Fallida`, corregir la causa y pulsar `Recuperar emisión`. Si
   solo falló el marcador, esta acción conserva la cámara y el encoder de salida.
5. Al desaparecer el aviso, contrastar el tanteo. El historial conserva el fallo,
   los reintentos y la recuperación. `Detener`/`Finalizar sesión` siguen disponibles.

### Se interrumpe el encoder de salida

1. El sistema pasa a `Recuperando señal` y realiza hasta cinco intentos con
   backoff.
2. No pulsar preparar y no crear otro broadcast.
3. Corregir cableado o disponibilidad de la fuente mientras reintenta.
4. Si termina en `Fallida`, comprobar la fuente y pulsar `Recuperar emisión`.
5. Si no es recuperable, pulsar `Finalizar sesión` antes de preparar otra.

Una caída del encoder interrumpe la salida mientras se reconstruye; el cartel
solo puede mantenerse cuando el encoder continúa funcionando. Las emisiones
nuevas desactivan el cierre automático de YouTube para poder recuperar el destino.
Cerrar siempre desde Mandos al terminar: detener el PC no equivale a finalizar
el broadcast remoto. Las emisiones preparadas antes de esta mejora pueden
conservar su ajuste anterior de cierre automático.

### El servicio o el PC se reinician

1. Levantar el servicio con `npm run production:local:up`.
2. Abrir Mandos y localizar `Interrumpida`.
3. No preparar otra emisión.
4. Para una cámara Android, mantener abierta su pestaña y esperar a que recupere
   la señal con el enlace conservado. Si se recarga esa misma pestaña, pulsar
   Preparar cámara. No aparece lista hasta confirmar la nueva revisión.
5. Pulsar `Recuperar emisión`; se reutilizan el ID y la entrada protegida del
   broadcast existente.
6. Confirmar de nuevo la salud real desde YouTube.

### La cámara Android queda offline

1. Mantener el móvil desbloqueado, conectado a corriente y con Chrome visible.
2. Comprobar que móvil y PC siguen en la misma red privada.
3. Esperar la reconexión automática.
   En `Historial de operaciones`, seleccionar la pista para consultar las
   incidencias de `Servicio de cámaras`, sus reintentos y recuperación. El fallo
   compartido aparece en cada pista afectada, también antes de preparar un
   broadcast. Que el servicio responda de nuevo no confirma todavía la cámara:
   esperar a que el móvil aplique su revisión y vuelva a entregar señal.
4. Si el enlace caducó, fue revocado o se ha perdido la pestaña que lo reclamó,
   generar uno nuevo. Reiniciar el servicio por sí solo no invalida los enlaces.
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
2. Mandos avisará de la pérdida de datos y conservará el último frame válido del
   overlay mientras reconecta. El tanteo puede estar desactualizado.
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

## Comprobación del programa antes de emitir

Después de preparar la sesión, Mandos permite **Comprobar programa completo** de forma opcional.
El operador decide cuándo emitir: puede hacerlo sin prueba, con avisos o con resultados
anteriores. El panel resume los avisos y mantiene el detalle plegado. Si hay una prueba
en curso, terminarla o cancelarla libera la cámara para iniciar la emisión.
La prueba verifica el partido autenticado, perfil aplicado, servicio móvil,
recursos del PC, acceso al destino y conexión de entrada. Graba diez segundos
con la cámara, el marcador del partido y audio usando el mismo compositor y
codificador del directo. El archivo se decodifica para comprobar su integridad.
El cartel de continuidad no cuenta como cámara válida.

- **Revisar / Aviso**: consultar el detalle del paso y, si procede, pulsar `Repetir`.
  Cámara, audio, marcador, codificador y bitrate comparten una muestra y se repiten
  juntos. Si se omite la muestra, esos pasos aparecen **Sin comprobar**, indicando
  la causa, sin atribuirles un fallo que no se ha medido.
- **Avisos en la prueba**: revisar cada aviso. Una fuente sintética, una fuente
  sin micrófono o una imagen inmóvil pueden ser intencionadas. Reproducir siempre
  el clip y comprobar lo que se oye y se ve.
- **Resultados anteriores**: se puede repetir la prueba completa. Reiniciar el runtime o cambiar la
  identidad/perfil de la cámara invalida la comprobación anterior. Repetir un
  solo paso no renueva la antigüedad de los demás.
- **Cancelar comprobación**: cancela la captura local sin iniciar ni cancelar el
  broadcast preparado. Finalizar la sesión también cancela primero la prueba.

La comprobación **Red y capacidad de subida** primero abre TCP o TLS hacia la
entrada, sin publicar vídeo. Con las salidas detenidas, envía desde el PC hasta
26 MiB de bytes generados al servicio de pruebas HTTPS de Cloudflare durante un
máximo de doce segundos. No envía imágenes, audio, claves ni tokens. Las pistas
comparten una medición durante cinco minutos, conservando su fecha original.
La comparación suma vídeo y audio de las pistas configuradas/preparadas para
YouTube, hasta las tres simultáneas de mayor consumo, y añade un 30 % de margen.
Si la estimación es inferior, muestra un aviso sin bloquear el inicio. Cambiar esa
demanda marca los resultados anteriores como desactualizados.

Usar `Repetir: Red y capacidad de subida` para forzar una medición nueva después
de cambiar de red, incluso si la anterior salió correcta. Durante un directo
solo se reutiliza una medición vigente: nunca se inicia una prueba de carga y
el arranque de una salida cancela cualquier medición pendiente. Si no se dispone
de medición vigente o el servicio falla, aparece una advertencia explícita.
La ruta a Cloudflare puede rendir distinto a YouTube. Confirmar la estabilidad
con la prueba privada de treinta minutos; ni esta estimación ni un clip individual
de diez segundos acreditan capacidad sostenida de tres pistas. El bitrate del
programa mostrado en otro paso corresponde al archivo compuesto.

Con menos de 128 MB libres se omite la grabación de prueba; con menos de 256 MB de
memoria se señala el margen crítico. Con menos de 2 GB de disco o 1 GB de memoria
también se advierte del margen reducido. Estos diagnósticos no bloquean `Emitir`
ni se exigen de nuevo al iniciar. Estos límites no son
una reserva suficiente para grabar partidos completos ni sustituyen su futura
política de almacenamiento.

Los clips quedan bajo el directorio privado de configuración del runtime, con
permisos 0600 y descarga autenticada para operadores. Cada prueba de programa
sustituye su clip anterior; finalizar la sesión lo elimina. No copiar esa carpeta
como parte de un paquete de soporte público. La interfaz descarga el archivo con
la sesión del operador y no pone tokens en la dirección del vídeo.
