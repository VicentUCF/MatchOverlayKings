import type { SponsorId } from '@kpl/shared';

export interface SponsorDefinition {
  id: SponsorId;
  name: string;
  logoUrl: string;
  accentColor: string;
}

export const SPONSORS: SponsorDefinition[] = [
  {
    id: 'kpl',
    name: 'KingsPadelLeague',
    logoUrl: '/logos/kpl-wordmark.png',
    accentColor: '#c9a227',
  },
  {
    id: 'barbaridad',
    name: 'Barbaridad',
    logoUrl: '/logos/barbaridad.webp',
    accentColor: '#f4b000',
  },
  {
    id: 'magic-city',
    name: 'Magic City',
    logoUrl: '/logos/magic-city.webp',
    accentColor: '#20b8f0',
  },
  {
    id: 'red-lions',
    name: 'Red Lions',
    logoUrl: '/logos/red-lions.png',
    accentColor: '#e21a23',
  },
  {
    id: 'thormentadores',
    name: 'Thormentadores',
    logoUrl: '/logos/thormentadores.png',
    accentColor: '#8e44ff',
  },
  {
    id: 'titanics',
    name: 'Titanics',
    logoUrl: '/logos/titanics.png',
    accentColor: '#1c7c54',
  },
];

export function getSponsorById(id: SponsorId): SponsorDefinition {
  return SPONSORS.find((sponsor) => sponsor.id === id) ?? {
    id,
    name: id,
    logoUrl: '',
    accentColor: '#c9a227',
  };
}

export function resolveSponsors(ids: SponsorId[]): SponsorDefinition[] {
  return ids.map(getSponsorById);
}
