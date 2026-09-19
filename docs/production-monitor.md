# Realización desde el PC

## Dos vistas, dos responsabilidades

- **Inicio (`/admin`)** es la vista global de realización. Muestra la entrada de
  las cámaras Android, el tanteo de cada pista, estado de emisión, métricas y un
  resumen de incidencias. Una sesión iniciándose no cuenta como emisión activa.
- **Abrir pista (`/admin?pista=pista-2`)** abre la vista individual. Conserva la
  pista al recargar y permite volver con el historial del navegador. Muestra el
  marcador en lectura, cámara, escucha local, salida, preparación, comprobación,
  inicio, parada y recuperación de esa sesión. Los gráficos y los diagnósticos
  de cámara pueden desplegarse sin abandonar la pista.
- **El anotador utiliza `/control/pista-2` desde otro dispositivo**. En el detalle
  hay un enlace para copiar y entregar. El enlace no concede permisos: esa persona
  necesita iniciar sesión con una cuenta autorizada (mediante `/admin`). Si el PC
  usa localhost, el enlace compartido apunta al dominio público de KPL.

El realizador no tiene botones de sumar puntos, deshacer ni resetear el marcador
entre sus controles habituales. El acceso al control del anotador se mantiene en
una sección separada y abre otra pestaña.

## Qué confirma cada monitor

- **Cámara**: entrada WHEP de Android, sin los gráficos del programa. Escuchar o
  silenciar en este PC no cambia el micrófono ni el audio enviado a YouTube.
  El cambio de pista y la salida a otra pestaña del panel silencian la escucha.
- **Marcador del anotador**: datos de Supabase por Realtime y comprobación cada
  cinco segundos. Incluye hora de confirmación y aviso si se conserva un dato
  antiguo. No identifica quién está conectado ni acredita presencia del anotador.
- **Overlay**: gráficos de la ruta real del marcador; se carga al desplegarlo.
- **YouTube**: estado reportado por el runtime y enlace a la señal recibida por el
  público, con su retardo. La entrada de cámara y el overlay por separado no
  sustituyen esta comprobación de composición y audio finales.
- **Emisión**: el controlador existente actualiza las sesiones activas cada dos
  segundos. Si falla la lectura o pasan quince segundos sin confirmación, la
  vista global deja de presentar las cifras conservadas como estado confirmado.

Las fuentes locales V4L2 y sintética todavía no ofrecen monitor de vídeo en vivo
por navegador. La interfaz lo indica y remite al programa de prueba y a YouTube.
La configuración de cámara y visibilidad durante una sesión conserva las
restricciones existentes del runtime.

## Correcciones de UI/UX incluidas

1. La entrada de cámara, los gráficos y la salida final quedan identificados.
   El overlay ya no se etiqueta como una vista previa del programa completo.
2. El realizador puede abrir el contexto completo de una pista desde Inicio,
   manteniendo la responsabilidad del marcador en el anotador.
3. Las incidencias de señal y recuperación aparecen en la vista global.
4. Los datos conservados durante una desconexión se identifican como no confirmados.
5. Las sesiones finalizadas no cuentan como programas estables en Mandos.
6. Solo se abren cámaras y suscripciones de marcador en la vista visible;
   cambiar de área conserva los formularios de preparación, sin mantener sus
   decodificadores de vídeo ocultos.

## Validación

`node scripts/check-production-monitor-ui.mjs` monta los componentes reales con
transportes de marcador y cámara simulados. No autentica, publica ni modifica
producción. Comprueba actualización externa del tanteo, desconexión, navegación,
recarga, selección de pista, acción dirigida a la sesión correcta, escucha local,
enlace del anotador, conservación de borradores y ausencia de desbordamiento
horizontal a 1920, 1366, 768, 390 y 320 px. Guarda capturas en
`output/ui-ux-audit/`; las cámaras de esas capturas son simuladas.

Antes de la jornada falta la aceptación con dispositivos y cuentas reales:
un anotador actualizando cada pista y el realizador comprobando los cambios,
la cámara y el audio final de YouTube desde el PC. Seguir además el
[runbook de producción](weekend-production-runbook.md).

Resultados de esta revisión: lint y build web correctos; 137 pruebas de frontend
correctas; batería completa con dos workers y acceso a puertos locales: 731
pruebas correctas y una omitida. La primera ejecución restringida no pudo validar
integraciones de red y multimedia; la repetición completa con permisos locales
terminó correctamente. La prueba de navegador descrita arriba también pasó.
Estos resultados verifican el código y los transportes de prueba, no una emisión
real ni un despliegue en Vercel o Docker.
