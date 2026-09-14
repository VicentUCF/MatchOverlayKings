import type { ProductionAssetInput } from './types.js';

export type PublicationMetadata = {
  readonly title: string;
  readonly description: string;
  readonly storageKey: string;
};

export function buildPublicationMetadata(input: ProductionAssetInput): PublicationMetadata {
  const homeName = input.home.shortName ?? input.home.name;
  const awayName = input.away.shortName ?? input.away.name;
  const title = `${homeName} vs ${awayName} | ${input.matchdayLabel} ${input.matchdayNumber} | ${input.seasonLabel}`;
  const scheduledLabel = new Intl.DateTimeFormat(input.locale, {
    timeZone: input.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(input.scheduledAt));
  const description = [
    input.leagueName,
    `${input.home.name} vs ${input.away.name}`,
    `${input.matchdayLabel} ${input.matchdayNumber} · ${input.seasonLabel}`,
    `${scheduledLabel} · ${input.timeZone}`,
    input.courtName,
    input.publicUrl,
  ].join('\n');
  const instant = new Date(input.scheduledAt)
    .toISOString()
    .replace(/[-:.]/g, '')
    .replace('000Z', 'Z')
    .toLowerCase();
  const storageKey = [
    'livestream-thumbnails',
    slug(input.seasonLabel),
    `${slug(input.matchdayLabel)}-${input.matchdayNumber}`,
    `${instant}-${slug(homeName)}-vs-${slug(awayName)}-${input.templateRevision}.png`,
  ].join('/');

  return { title, description, storageKey };
}

function slug(value: string): string {
  const normalized = value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  return normalized.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
