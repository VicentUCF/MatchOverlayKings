# Validación del centro de control KPL

El objetivo de este piloto no es demostrar todavía todo el producto. Debe responder, con el menor coste posible, a dos preguntas:

1. ¿Puede este PC crear y mantener las emisiones sin depender de OBS?
2. ¿Reduce suficiente trabajo operativo como para justificar completar cámaras, móvil y tres pistas?

## Puerta 1 — capacidad del PC

Ejecutar:

```bash
npm run pilot:benchmark
```

Se considera aprobada si las tres salidas 1080p30 H.264 + AAC terminan sin error y la más lenta mantiene al menos `1.15×`. Es una prueba aislada de CPU y no sustituye la prueba con capturadoras, overlays y red reales.

Resultado de referencia obtenido en este PC (Ryzen 5 5600G, 32 GB): `3.04×`, `3.07×` y `3.11×`; 15 segundos por salida procesados en 4,99 segundos. **Puerta 1 aprobada para señal sintética.**

## Puerta 2 — recorrido de tres pistas

1. Ejecutar `npm run pilot` y abrir `http://localhost:4310/admin`.
2. Entrar en **Validar piloto**.
3. Preparar las tres pistas en simulación y comprobar sus títulos y miniaturas.
4. Pulsar **Emitir** de forma independiente en las tres pistas.
5. Mantenerlas 30 minutos. Las tres velocidades deben permanecer por encima de `0.95×` y no debe aparecer un error.
6. Detener cada señal desde su propia tarjeta.
7. Repetir en modo **YouTube real**, con privacidad **Privado**, después de configurar OAuth.

La puerta queda aprobada cuando:

- la operación completa se hace desde el panel, sin abrir OBS ni una terminal adicional;
- YouTube muestra la señal activa y con salud correcta;
- de rellenar los datos a recibir señal pasan menos de 2 minutos;
- las tres emisiones aguantan 30 minutos sin intervención ni pérdida sostenida de velocidad;
- título y miniatura son correctos sin editarlos en YouTube Studio.

## Puerta 3 — rentabilidad

Comparar una jornada real hecha con OBS con una repetición privada usando el piloto. Registrar:

| Medida | OBS actual | Piloto | Objetivo para continuar |
| --- | ---: | ---: | ---: |
| Minutos de preparación total |  |  | reducción ≥ 50 % |
| Personas necesarias |  |  | una sola persona |
| Intervenciones durante 3 partidos |  |  | ≤ 1 |
| Emisiones mal tituladas o con imagen incorrecta |  |  | 0 |
| Fallos que obligan a abrir OBS/terminal |  |  | 0 |

Calcular el ahorro mensual:

```text
ahorro mensual = horas evitadas al mes × coste real por hora
meses de retorno = coste restante de desarrollo / ahorro mensual
```

Continuar si las tres puertas se aprueban y el retorno estimado encaja en el plazo que KPL acepte. Parar o replantear si falla YouTube con una red estable, si el PC no sostiene tres codificaciones, o si el panel no reduce al menos a la mitad el trabajo real.

## Alcance deliberadamente aplazado

El piloto no incluye aún el móvil como tercera cámara, batería/telemetría, mezcla de varias cámaras, overlays dentro del vídeo ni recuperación automática completa. Esas piezas se construyen solo después de validar las tres salidas y la operación real de YouTube.
