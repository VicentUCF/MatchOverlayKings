# KPL Live Overlay Control

Herramienta independiente para controlar overlays de OBS de KingsPadelLeague desde varios dispositivos mediante WebSocket.

## MVP

- Marcador de padel para enfrentamientos.
- Portada publica en `/` con solo partidos en directo.
- Panel admin en `/admin` para abrir mandos y overlays de las cinco pistas.
- Vista publica de marcador desde `/live/:eventId`.
- Control en dos fases: configuracion del partido y marcador.
- Control desde `/control/:eventId`.
- Overlay transparente para OBS desde `/overlay/:eventId/scoreboard`.
- Equipos fijos en `data/teams.json`.
- Cinco pistas fijas en `data/events/pista-1.json` a `data/events/pista-5.json`.

## Desarrollo

```bash
npm install
npm run dev
```

Servidor local:

- Selector: `http://localhost:4300/`
- Admin: `http://localhost:4300/admin`
- Directo pista 1: `http://localhost:4300/live/pista-1`
- Control pista 1: `http://localhost:4300/control/pista-1`
- Overlay pista 1: `http://localhost:4300/overlay/pista-1/scoreboard`
- Overlay pista 2: `http://localhost:4300/overlay/pista-2/scoreboard`
- Health: `http://localhost:4300/health`

En una LAN, usa la IP del portatil en lugar de `localhost`.

## Verificacion

```bash
npm run verify
```
