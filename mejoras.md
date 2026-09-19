# Plan de mejoras obligatorias de KPL Live

## Objetivo

Convertir el MVP actual en una plataforma capaz de preparar, operar, recuperar y
cerrar una jornada completa con una sola persona, sin depender de OBS, una
terminal o YouTube Studio durante la operación normal.

El salto de producto no consiste únicamente en añadir más controles o
animaciones. Debe cerrar el ciclo completo:

1. Configuración de la jornada.
2. Preflight técnico.
3. Producción y supervisión de todas las pistas.
4. Recuperación automática ante fallos.
5. Grabación y reutilización del contenido.
6. Medición del valor entregado a público y patrocinadores.

## Avance para la primera emisión real

Seguimiento de la ejecución actual: [evidencias y pendientes](docs/mejoras-progress.md).
Las casillas pendientes conservan su estado hasta completar también la validación
operativa exigida por este documento; implementar y probar localmente no acredita
por sí solo una jornada real.

- [x] Convertir el piloto que ya controla YouTube y Android en la ruta operativa
  principal de `Mandos`, sin obligar al operador a alternar entre dos paneles.
- [x] Persistir localmente cada sesión, su destino, miniatura, fuente e identidad
  de overlay mediante escritura atómica y permisos privados.
- [x] Detectar un reinicio, mostrar la sesión como `Interrumpida` y permitir
  recuperar el mismo broadcast desde la interfaz sin crear otro directo.
- [x] Aplicar hasta cinco reintentos con backoff a cualquier caída de FFmpeg o de
  la fuente y ofrecer recuperación manual cuando se agotan.
- [x] Bloquear la preparación de otra emisión mientras exista una sesión fallida
  o interrumpida pendiente de recuperar o finalizar.
- [x] Añadir smoke check de disponibilidad y un runbook específico para el fin de
  semana.
- [x] Completar la unificación operativa: un solo runtime para señal y emisión,
  inventario dinámico autoritativo y retirada del ejecutable de producción
  alternativo. El antiguo reconciliador queda archivado como referencia.
- [ ] Validar una cámara móvil independiente por pista con tres dispositivos
  reales. El runtime ya conserva sesiones separadas; falta su aceptación en el
  entorno de producción previsto.

## Principios obligatorios

- [ ] Debe existir una única fuente de verdad para configuración, estado deseado,
  estado observado, partido, emisión y salida.
- [ ] La interfaz nunca debe presentar una solicitud aceptada como una emisión ya
  iniciada; debe esperar confirmación del estado observado.
- [ ] Todas las operaciones críticas deben ser idempotentes, auditables y
  recuperables después de reiniciar el navegador, el contenedor o el PC.
- [ ] La operación normal de una jornada no debe requerir abrir OBS, una terminal
  ni YouTube Studio.
- [ ] Los secretos, tokens OAuth y claves de emisión no deben llegar al navegador,
  logs ni telemetría.
- [ ] Los errores deben indicar la pista afectada, la causa comprensible, el estado
  real conservado y la acción de recuperación disponible.
- [ ] No se debe añadir automatización que quite al operador la posibilidad de
  detener, cancelar o corregir una acción.
- [ ] Toda capacidad nueva debe contemplar estados de carga, vacío, error,
  desconexión, conflicto, reintento y recuperación.

## P0 — Base de producción fiable

Estas mejoras bloquean la consideración del sistema como producto de producción.

### 1. Unificar piloto y aplicación de producción

- [x] Eliminar la convivencia de dos centros de control con modelos operativos
  distintos.
- [x] Concentrar YouTube, cámara móvil, miniaturas, overlays, estado real de las
  sesiones, recuperación y límite de capacidad en el mismo runtime operativo.
- [x] Hacer que administradores y operadores utilicen el mismo control plane, con
  acciones limitadas según su rol.
- [x] Eliminar arrays de pistas, equipos y emparejamientos hardcodeados de la UI y
  los contratos.
- [x] Obtener las pistas y sus capacidades desde configuración autoritativa.
- [x] Resolver la diferencia entre inventarios fijos de tres y cuatro pistas.
- [x] Mantener una única identidad de partido para marcador, overlay, miniatura,
  metadatos y emisión.

#### Criterios de aceptación

- [x] Una pista añadida o desactivada en configuración aparece correctamente sin
  modificar y desplegar el frontend.
- [x] El administrador puede ver configuración, señal, marcador, salida y salud en
  el mismo contexto de pista.
- [x] No existen rutas administrativas alternativas que representen estados
  contradictorios de la misma emisión.

### 2. Persistencia y recuperación después de reinicios

- [x] Persistir de forma atómica las sesiones, el destino remoto, la configuración
  aplicada y el último estado de ejecución necesario para recuperarlas.
- [ ] Persistir un registro independiente de operaciones pendientes y completadas.
- [ ] Al arrancar, reconciliar el estado local con Supabase, MediaMTX, FFmpeg y
  YouTube antes de habilitar controles.
- [ ] Detectar procesos huérfanos, emisiones remotas activas y sesiones locales
  incompletas.
- [x] Permitir recuperar o finalizar de forma segura una emisión que sobrevivió
  parcialmente a un reinicio.
- [x] Reutilizar el broadcast y la entrada protegida existentes al recuperar, sin
  preparar una segunda emisión.
- [ ] Conservar un historial de acciones e incidentes por pista y jornada.

#### Criterios de aceptación

- [x] Reiniciar el navegador no pierde ninguna configuración ni sesión.
- [x] Reiniciar el contenedor durante una simulación recupera o cierra la sesión de
  manera determinista.
- [ ] Reiniciar durante una emisión privada de YouTube no crea un segundo
  broadcast y muestra claramente si la emisión continúa, se recupera o se cierra.
- [x] La recuperación puede ejecutarse desde la interfaz sin terminal.

### 3. Recuperación automática de todas las fuentes

- [ ] Extender el reintento automático más allá de la cámara móvil a V4L2, audio,
  overlay, MediaMTX, FFmpeg y salida remota.
- [ ] Detectar vídeo congelado, pantalla negra, ausencia de audio, pérdida de
  frames, velocidad insuficiente y bitrate degradado.
- [x] Configurar un límite de cinco reintentos, backoff y escalado visible a estado
  `Fallida`.
- [ ] Disponer de una fuente de respaldo o cartel de continuidad por pista.
- [x] Permitir una acción segura `Recuperar pista` cuando la autorrecuperación no
  sea suficiente.
- [x] Evitar bucles infinitos silenciosos y mostrar el último diagnóstico útil.

#### Criterios de aceptación

- [ ] Desconectar y reconectar una cámara recupera la señal sin reconstruir la
  jornada.
- [ ] La caída de FFmpeg se detecta y se recupera o escala en menos de 30 segundos.
- [ ] Durante la recuperación se conserva el último estado válido del marcador y
  se emite una continuidad segura.
- [ ] El operador recibe una alerta identificable sin vigilar permanentemente cada
  tarjeta.

### 4. Preflight técnico completo

- [ ] Comprobar antes de emitir: cámara, perfil, audio, espacio en disco, CPU/GPU,
  memoria, red, bitrate, encoder, MediaMTX, overlay, autenticación y destino.
- [ ] Distinguir entre bloqueos, advertencias y recomendaciones.
- [ ] Probar unos segundos de señal real, no solo la presencia del dispositivo.
- [ ] Mostrar una vista previa del programa final con overlay y audio.
- [ ] Impedir iniciar cuando exista un bloqueo que produciría una emisión inválida.
- [ ] Permitir repetir únicamente la comprobación fallida.

#### Criterios de aceptación

- [ ] Cada pista obtiene un resultado `Lista`, `Lista con advertencias` o
  `Bloqueada`, con explicación.
- [ ] No se puede entregar Mandos como listo mientras una pista configurada tenga
  un bloqueo crítico.
- [ ] El preflight completo de tres pistas tarda menos de dos minutos.

## P1 — Operar una jornada con una sola persona

### 5. Modo jornada

- [ ] Crear o importar una jornada completa con partidos, horarios, equipos,
  alineaciones y pistas.
- [ ] Generar automáticamente título, descripción, miniatura, rutas públicas y
  configuración de marcador.
- [ ] Añadir acciones `Preparar todas`, `Iniciar jornada` y `Finalizar jornada` con
  confirmaciones y progreso por pista.
- [ ] Permitir iniciar automáticamente una emisión según el horario configurado,
  con margen y confirmación opcionales.
- [ ] Preparar el siguiente partido sin eliminar el histórico del anterior.
- [ ] Automatizar la transición entre fin de partido, cierre de emisión y siguiente
  encuentro.
- [ ] Permitir pausar o excluir una pista sin bloquear el resto de la jornada.
- [ ] Conservar siempre controles independientes por pista.

#### Criterios de aceptación

- [ ] Los datos de un partido se introducen una sola vez.
- [ ] Una jornada de tres pistas puede quedar configurada en menos de diez minutos.
- [ ] Una sola persona puede preparar, iniciar, supervisar y finalizar las tres
  pistas.
- [ ] Ninguna acción masiva oculta el resultado individual de cada pista.

### 6. Centro de operaciones y multiview

- [ ] Mostrar simultáneamente el programa real de todas las pistas, no solo el
  overlay aislado.
- [ ] Incluir estado de vídeo, audio, encoder, salida remota, marcador, duración y
  próxima acción.
- [ ] Priorizar automáticamente pistas con fallos, degradación o acciones
  pendientes.
- [ ] Añadir monitorización de audio sin reproducir todas las pistas a la vez.
- [ ] Disponer de una bandeja única de alertas e incidentes.
- [ ] Permitir abrir el control visual o técnico de una pista manteniendo el
  contexto de la jornada.
- [ ] Mantener navegación y controles utilizables a 320 px, 200 % de zoom y en un
  monitor de producción ancho.

#### Criterios de aceptación

- [ ] Un operador identifica en menos de cinco segundos qué pista necesita
  atención y por qué.
- [ ] Todos los estados críticos se comprenden sin depender únicamente del color.
- [ ] Las actualizaciones rutinarias no saturan lectores de pantalla ni producen
  cambios de foco inesperados.

### 7. Varias cámaras móviles simultáneas

- [ ] Sustituir la única sesión móvil global por sesiones independientes por pista.
- [ ] Admitir al menos un móvil simultáneo en cada pista activa.
- [ ] Vincular y revocar cada dispositivo de forma independiente.
- [ ] Mostrar batería cuando el navegador la exponga, conectividad, bitrate,
  pérdida, RTT, perfil aplicado y último heartbeat.
- [ ] Alertar si la pantalla está a punto de bloquearse, el dispositivo se calienta
  o la conexión se degrada cuando esa información esté disponible.
- [ ] Mantener tokens temporales, revocables y limitados a una pista.

#### Criterios de aceptación

- [ ] Tres móviles pueden emitir a tres pistas simultáneamente sin compartir
  estado, token ni ruta de medios.
- [ ] Revocar o perder un móvil no afecta a las otras pistas.
- [ ] Cada pista puede cambiar entre móvil, V4L2 y señal de respaldo de forma
  controlada.

### 8. Automatización de overlays

- [ ] Definir reglas configurables para previa, alineaciones, inicio, punto de oro,
  set point, match point, cambio de lado, fin de set y fin de partido.
- [ ] Automatizar clasificación, próximos partidos, últimos resultados y
  patrocinadores durante pausas apropiadas.
- [ ] Permitir activar, desactivar o anular temporalmente cada regla.
- [ ] Evitar que una escena automática tape una acción manual o un evento más
  prioritario.
- [ ] Registrar qué escena se mostró, cuándo, durante cuánto tiempo y por qué.

#### Criterios de aceptación

- [ ] Un partido completo puede mostrar sus escenas habituales sin intervención
  manual continua.
- [ ] El operador puede recuperar control manual inmediatamente.
- [ ] Las escenas automáticas nunca alteran el estado deportivo del partido.

## P2 — Convertir cada partido en contenido reutilizable

### 9. Grabación local

- [ ] Grabar el programa final de cada pista con integridad comprobable.
- [ ] Evaluar y documentar si deben grabarse también fuentes aisladas.
- [ ] Monitorizar espacio disponible y estimación de duración restante.
- [ ] Dividir o finalizar archivos de manera segura ante reinicios y cortes.
- [ ] Asociar la grabación con jornada, partido, pista, equipos y timestamps del
  marcador.
- [ ] Definir política de conservación, exportación y eliminación recuperable.

#### Criterios de aceptación

- [ ] Cada partido finalizado tiene un archivo reproducible y correctamente
  identificado.
- [ ] Un fallo de grabación genera una alerta sin detener necesariamente el
  directo.
- [ ] El sistema impide comenzar si el espacio disponible no alcanza el mínimo
  configurado.

### 10. Replay y clips automáticos

- [ ] Mantener un buffer de vídeo para replay de los últimos segundos.
- [ ] Permitir lanzar un replay sin interrumpir la grabación ni perder el directo.
- [ ] Utilizar los eventos del marcador para marcar puntos de oro, breaks, set
  points, match points, cartas y final del partido.
- [ ] Generar clips horizontales y verticales a partir de esos eventos.
- [ ] Crear un resumen automático con selección revisable.
- [ ] Generar título, miniatura y borrador de copy social sin publicar
  automáticamente.
- [ ] Permitir revisar, recortar, aprobar y exportar cada clip.

#### Criterios de aceptación

- [ ] Los clips prioritarios están disponibles menos de dos minutos después de
  finalizar el partido.
- [ ] Cada clip conserva la atribución al partido y al evento deportivo que lo
  originó.
- [ ] La generación de contenido no degrada las emisiones activas; debe respetar
  límites de CPU, GPU y almacenamiento.

### 11. Archivo y búsqueda

- [ ] Crear una página permanente por partido, incluso cuando ya no esté en
  directo.
- [ ] Buscar por jornada, pista, equipo, jugador, fecha y tipo de evento.
- [ ] Relacionar marcador final, histórico de acciones, grabación, clips,
  miniatura e incidencias.
- [ ] Permitir exportar los datos deportivos y operativos en formatos abiertos.

## P3 — Audiencia y monetización

### 12. Match Center público

- [ ] Integrar el vídeo del directo con marcador y datos del partido.
- [ ] Permitir cambiar rápidamente entre pistas y ofrecer una vista mosaico cuando
  haya varios partidos activos.
- [ ] Mostrar timeline, sets, cartas, alineaciones, estadísticas y próximos
  partidos.
- [ ] Conservar el resultado, replay y highlights al terminar.
- [ ] Generar enlaces compartibles del partido y de momentos concretos.
- [ ] Diseñar estados claros para próximo, retrasado, en directo, interrumpido,
  finalizado y cancelado.
- [ ] Garantizar navegación por teclado, contraste, reflow, texto ampliado y
  alternativas accesibles para contenido audiovisual.

### 13. Patrocinadores medibles

- [ ] Registrar cada aparición de un patrocinador, superficie, duración, pista y
  partido.
- [ ] Definir objetivos mínimos de impresiones o segundos contratados.
- [ ] Distribuir automáticamente el inventario pendiente sin romper el ritmo del
  partido.
- [ ] Alertar si un compromiso no se está cumpliendo.
- [ ] Incorporar audiencia disponible de la plataforma de destino, diferenciando
  claramente datos exactos y estimaciones.
- [ ] Exportar un informe por patrocinador, jornada y temporada.

#### Criterios de aceptación

- [ ] El informe de una jornada se genera sin recuento manual.
- [ ] Cada cifra del informe puede rastrearse hasta eventos registrados.
- [ ] La automatización respeta límites de frecuencia y nunca muestra dos campañas
  incompatibles simultáneamente.

### 14. Distribución adicional

- [ ] Diseñar destinos como configuración extensible y no como un modo exclusivo
  `YouTube` o `Simulación`.
- [ ] Admitir salidas RTMP y SRT configuradas de manera segura.
- [ ] Evaluar publicación simultánea según ancho de banda y capacidad de encoding.
- [ ] Mantener salud, inicio, parada y errores independientes por destino.
- [ ] Evitar que el fallo de una plataforma detenga automáticamente las demás.

## P4 — Estudio avanzado

Estas capacidades solo se abordarán después de cumplir P0 y validar P1 en una
jornada real.

- [ ] Varias cámaras por pista con buses de preview y program.
- [ ] Corte, fundido, escenas y mezcla de audio.
- [ ] Cámaras IP mediante protocolos adecuados y autenticación segura.
- [ ] Redundancia de red, encoder y PC de producción.
- [ ] Operación remota con permisos, confirmaciones y auditoría.
- [ ] Autodirector opcional basado en señales medibles, siempre anulable por una
  persona.

## Mejoras transversales de experiencia

- [ ] Sustituir errores técnicos por mensajes orientados a la recuperación, sin
  ocultar un identificador de diagnóstico para soporte.
- [ ] Confirmar acciones destructivas como finalizar partido, cancelar broadcast o
  resetear marcador.
- [ ] Evitar que un refresco sustituya formularios editados o acciones en curso.
- [ ] Añadir atajos de teclado seguros para las acciones repetitivas del marcador.
- [ ] Proteger los atajos destructivos contra pulsaciones accidentales.
- [ ] Mantener visibles conexión, sincronización y versión cuando exista riesgo de
  conflicto.
- [ ] Unificar terminología: pista, partido, jornada, preparación, emisión,
  programa, fuente, destino y estado.
- [ ] Revisar textos mezclados en español e inglés.
- [ ] Validar cada flujo crítico con teclado, lector de pantalla, zoom al 200 % y
  pantalla táctil.

## Observabilidad y soporte

- [ ] Crear métricas por pista de uptime, FPS, bitrate, velocidad, pérdida, RTT,
  reinicios y duración de incidentes.
- [ ] Registrar cambios de estado con timestamps y correlación entre UI, control
  plane, agente, FFmpeg, MediaMTX y destino.
- [ ] Redactar logs con límites de tamaño y sin secretos.
- [ ] Añadir un paquete de diagnóstico exportable y sanitizado.
- [ ] Incorporar alertas con niveles informativo, advertencia y crítico.
- [ ] Documentar procedimientos de recuperación desde la propia interfaz.

## Validación obligatoria en una jornada real

Antes de considerar completado P1 se debe realizar una prueba real o privada con
tres pistas durante al menos 30 minutos y registrar:

| Métrica | Objetivo obligatorio |
| --- | ---: |
| Personas necesarias | 1 |
| Preparación total de la jornada | Menos de 10 minutos |
| Reducción frente al flujo con OBS | Al menos 50 % |
| Tiempo desde preparación hasta señal | Menos de 2 minutos por pista |
| Velocidad sostenida del encoder | Al menos 0,95x |
| Emisiones con título, equipos o miniatura incorrectos | 0 |
| Fallos que obligan a abrir OBS o terminal | 0 |
| Intervenciones no previstas durante tres partidos | Como máximo 1 |
| Recuperación de un fallo recuperable | Menos de 30 segundos |
| Minutos previstos realmente en emisión | Al menos 99,5 % |

Para validar P2 y P3:

| Métrica | Objetivo obligatorio |
| --- | ---: |
| Partidos con grabación válida | 100 % |
| Highlights prioritarios disponibles | Menos de 2 minutos tras el partido |
| Informes de patrocinio con trazabilidad | 100 % |
| Trabajo manual para generar el informe de jornada | 0 recuentos manuales |

## Orden de ejecución

1. Completar P0 y verificar reinicios, fallos y recuperación.
2. Completar P1 y validarlo con una jornada operada por una sola persona.
3. Añadir grabación antes que replay, clips o IA.
4. Completar P2 sin comprometer la estabilidad de las emisiones.
5. Completar P3 únicamente con datos trazables.
6. Considerar P4 cuando la operación base ya sea estable y rentable.

## Capacidades que no deben priorizarse todavía

- Nuevos temas visuales o animaciones que no resuelvan una tarea operativa.
- Una aplicación móvil nativa mientras la captura web satisfaga fiabilidad y
  permisos necesarios.
- Un autodirector con IA antes de disponer de multicámara, grabación y controles
  manuales fiables.
- Publicación social automática sin revisión humana.
- Convertir el producto en SaaS multi-club antes de validar el retorno dentro de
  KPL.
- Añadir destinos de emisión sin métricas de capacidad y ancho de banda.

## Definición global de terminado

Una mejora de este documento solo puede marcarse como cumplida cuando:

- [ ] Está implementada en el flujo real, no únicamente en una pantalla o mockup.
- [ ] Tiene pruebas proporcionales al riesgo y casos de error.
- [ ] Ha sido verificada con los dispositivos y entorno de producción previstos.
- [ ] Tiene estados accesibles de carga, éxito, error y recuperación.
- [ ] No expone secretos ni amplía permisos innecesariamente.
- [ ] Su documentación operativa está actualizada.
- [ ] Existe evidencia de que cumple sus criterios de aceptación.

## Ampliación solicitada: enlaces de marcador por pista

Después de las mejoras anteriores, incorporar la solicitud del 19 de septiembre
de 2026: generar un enlace independiente por pista para que una persona asignada
a cada pista pueda operar sus mandos visuales e introducir el resultado.

- [ ] Generar desde administración un enlace de acceso al control visual de una
  pista concreta.
- [ ] Limitar su autorización al marcador de esa pista, con comprobación en el
  servidor y sin conceder acceso a otras pistas ni a la administración de emisión.
- [ ] Permitir revocar y renovar cada enlace de manera independiente.
- [ ] Mantener sincronización, detección de conflictos y trazabilidad de las
  acciones deportivas realizadas mediante estos enlaces.
- [ ] Mostrar estados claros de enlace inválido, caducado o revocado y conservar
  la recuperación de conexión sin duplicar puntos.
- [ ] Verificar que varias personas pueden operar simultáneamente sus pistas y
  que cambiar una URL o reutilizar un enlace revocado no amplía el acceso.
