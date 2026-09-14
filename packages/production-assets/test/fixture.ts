export const baseInput = {
  leagueName: 'Kings Padel League',
  seasonLabel: 'T2',
  matchdayLabel: 'Jornada',
  matchdayNumber: 3,
  courtName: 'Pista Central',
  home: {
    name: 'Red Lions',
    shortName: 'Red Lions',
    color: '#E21A23',
  },
  away: {
    name: 'Titanics',
    shortName: 'Titanics',
    color: '#1C7C54',
  },
  scheduledAt: '2026-09-09T17:30:00.000Z',
  timeZone: 'Europe/Madrid',
  locale: 'es-ES',
  publicUrl: 'https://live.kingspadelleague.com/live/pista-1',
  templateRevision: 'thumbnail-v1',
} as const;

export const onePixelPng = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ),
);
