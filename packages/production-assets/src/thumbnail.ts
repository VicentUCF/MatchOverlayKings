import { Resvg } from '@resvg/resvg-js';
import { fileURLToPath } from 'node:url';
import { logoDataUri } from './logo.js';
import { THUMBNAIL_TOKENS as token } from './tokens.js';
import type { ProductionAssetInput, ProductionAssetOptions } from './types.js';

const FONT_FILES = [
  fileURLToPath(import.meta.resolve('@expo-google-fonts/space-grotesk/700Bold/SpaceGrotesk_700Bold.ttf')),
  fileURLToPath(import.meta.resolve('@expo-google-fonts/manrope/700Bold/Manrope_700Bold.ttf')),
] as const;

export function buildThumbnailSvg(
  input: ProductionAssetInput,
  options: ProductionAssetOptions,
): string {
  const homeName = input.home.shortName ?? input.home.name;
  const awayName = input.away.shortName ?? input.away.name;
  const homeColor = input.home.color ?? token.color.brandStrong;
  const awayColor = input.away.color ?? token.color.accent;
  const homeLogo = logoDataUri(input.home, options);
  const awayLogo = logoDataUri(input.away, options);
  const matchday = `${input.matchdayLabel} ${input.matchdayNumber} · ${input.seasonLabel}`;
  const layout = token.layout;
  const type = token.typography;
  const atmosphere = token.atmosphere;
  const date = new Intl.DateTimeFormat(input.locale, {
    timeZone: input.timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(input.scheduledAt));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${token.canvas.width}" height="${token.canvas.height}" viewBox="0 0 ${token.canvas.width} ${token.canvas.height}">
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${token.color.background}"/><stop offset=".55" stop-color="${token.color.surfaceRaised}"/><stop offset="1" stop-color="${token.color.background}"/></linearGradient>
    <radialGradient id="homeGlow"><stop stop-color="${homeColor}" stop-opacity=".36"/><stop offset="1" stop-color="${homeColor}" stop-opacity="0"/></radialGradient>
    <radialGradient id="awayGlow"><stop stop-color="${awayColor}" stop-opacity=".34"/><stop offset="1" stop-color="${awayColor}" stop-opacity="0"/></radialGradient>
    <pattern id="stripes" width="${atmosphere.patternSize}" height="${atmosphere.patternSize}" patternUnits="userSpaceOnUse" patternTransform="rotate(${atmosphere.patternAngle})"><line x1="0" y1="0" x2="0" y2="${atmosphere.patternSize}" stroke="${token.color.text}" stroke-opacity="${token.opacity.pattern}" stroke-width="${token.stroke.pattern}"/></pattern>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="${atmosphere.shadow.y}" stdDeviation="${atmosphere.shadow.blur}" flood-opacity="${atmosphere.shadow.opacity}"/></filter>
  </defs>
  <rect width="${token.canvas.width}" height="${token.canvas.height}" fill="url(#background)"/>
  <ellipse cx="${atmosphere.homeGlow.x}" cy="${atmosphere.homeGlow.y}" rx="${atmosphere.homeGlow.width}" ry="${atmosphere.homeGlow.height}" fill="url(#homeGlow)"/>
  <ellipse cx="${atmosphere.awayGlow.x}" cy="${atmosphere.awayGlow.y}" rx="${atmosphere.awayGlow.width}" ry="${atmosphere.awayGlow.height}" fill="url(#awayGlow)"/>
  <rect width="${token.canvas.width}" height="${token.canvas.height}" fill="url(#stripes)"/>
  <path d="M0 0h${atmosphere.homeWedge.top}L${atmosphere.homeWedge.bottom} ${token.canvas.height}H0z" fill="${token.color.brand}" fill-opacity="${token.opacity.wedgeHome}"/>
  <path d="M${token.canvas.width} 0H${atmosphere.awayWedge.top}L${atmosphere.awayWedge.bottom} ${token.canvas.height}h${atmosphere.awayWedge.inset}z" fill="${token.color.accent}" fill-opacity="${token.opacity.wedgeAway}"/>
  <rect width="${token.canvas.width}" height="${layout.edge}" fill="${token.color.brand}"/>
  <rect y="${token.canvas.height - layout.edge}" width="${token.canvas.width}" height="${layout.edge}" fill="${token.color.accent}"/>
  <g font-family="${type.family.body}">
    <rect x="${token.space.gutter}" y="${layout.headerY}" width="${layout.brandWidth}" height="${layout.brandHeight}" rx="${token.radius.small}" fill="${token.color.brand}"/>
    <text x="${token.space.gutter + layout.brandWidth / 2}" y="${layout.brandTextY}" text-anchor="middle" fill="${token.color.background}" font-family="${type.family.heading}" font-size="${type.size.brand}" font-weight="${type.weight.bold}">KPL</text>
    <text x="${layout.leagueX}" y="${layout.brandTextY}" fill="${token.color.text}" font-size="${type.size.body}" font-weight="${type.weight.bold}">${xml(input.leagueName)}</text>
    <circle cx="${layout.liveX}" cy="${layout.headerY + type.size.body}" r="${token.radius.live}" fill="${token.color.live}"/>
    <text x="${layout.liveTextX}" y="${layout.brandTextY - token.space.unit / 4}" text-anchor="end" fill="${token.color.text}" font-size="${type.size.label}" font-weight="${type.weight.heavy}" letter-spacing="${type.tracking.status}">DIRECTO</text>
    <text x="${layout.versusX}" y="${layout.eyebrowY}" text-anchor="middle" fill="${token.color.brandStrong}" font-size="${type.size.body}" font-weight="${type.weight.heavy}" letter-spacing="${type.tracking.overline}">${xml(matchday.toUpperCase())}</text>
  </g>
  ${teamCard({ x: token.space.gutter, color: homeColor, name: homeName, side: 'LOCAL', logo: homeLogo })}
  ${teamCard({ x: layout.awayX, color: awayColor, name: awayName, side: 'VISITANTE', logo: awayLogo })}
  <g filter="url(#shadow)"><circle cx="${layout.versusX}" cy="${layout.versusY}" r="${token.radius.versus}" fill="${token.color.brandStrong}"/><circle cx="${layout.versusX}" cy="${layout.versusY}" r="${token.radius.badge}" fill="${token.color.background}" stroke="${token.color.accent}" stroke-width="${token.stroke.accent}"/><text x="${layout.versusX}" y="${layout.versusTextY}" text-anchor="middle" fill="${token.color.text}" font-family="${type.family.heading}" font-size="${type.size.versus}" font-weight="${type.weight.bold}">VS</text></g>
  <g font-family="${type.family.body}" font-weight="${type.weight.bold}">
    <text x="${token.space.gutter}" y="${layout.footerY}" fill="${token.color.text}" font-size="${type.size.body}">${xml(date)} · ${xml(input.timeZone)}</text>
    <text x="${layout.footerRight}" y="${layout.footerY}" text-anchor="end" fill="${token.color.text}" font-size="${type.size.body}">${xml(input.courtName)}</text>
  </g>
</svg>`;
}

export function renderThumbnailPng(svg: string): Uint8Array {
  return new Resvg(svg, {
    fitTo: { mode: 'original' },
    font: {
      fontFiles: [...FONT_FILES],
      loadSystemFonts: false,
      defaultFontFamily: 'Manrope',
    },
    imageRendering: 0,
    shapeRendering: 2,
    textRendering: 2,
    logLevel: 'off',
  }).render().asPng();
}

type TeamCard = {
  readonly x: number;
  readonly color: string;
  readonly name: string;
  readonly side: string;
  readonly logo: string | undefined;
};

function teamCard(card: TeamCard): string {
  const layout = token.layout;
  const center = card.x + layout.cardWidth / 2;
  const initials = card.name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part.slice(0, 1)).join('').toUpperCase();
  const mark = card.logo === undefined
    ? `<text x="${center}" y="${layout.logoTextY}" text-anchor="middle" fill="${token.color.text}" font-family="${token.typography.family.heading}" font-size="${token.typography.size.versus}" font-weight="${token.typography.weight.bold}">${xml(initials)}</text>`
    : `<image href="${card.logo}" x="${center - layout.logoImage / 2}" y="${layout.logoCenterY - layout.logoImage / 2}" width="${layout.logoImage}" height="${layout.logoImage}" preserveAspectRatio="xMidYMid meet"/>`;
  const length = card.name.length > 16 ? ` textLength="${layout.teamNameWidth}" lengthAdjust="spacingAndGlyphs"` : '';
  return `<g filter="url(#shadow)"><rect x="${card.x}" y="${layout.cardY}" width="${layout.cardWidth}" height="${layout.cardHeight}" rx="${token.radius.small}" fill="${token.color.surface}" stroke="${token.color.text}" stroke-opacity="${token.opacity.cardBorder}"/><rect x="${card.x}" y="${layout.cardY}" width="${layout.edge}" height="${layout.cardHeight}" rx="${token.space.unit}" fill="${card.color}"/><circle cx="${center}" cy="${layout.logoCenterY}" r="${token.radius.logo}" fill="${card.color}" fill-opacity="${token.opacity.logoFill}" stroke="${card.color}" stroke-width="${token.stroke.accent}"/>${mark}<text x="${center}" y="${layout.sideY}" text-anchor="middle" fill="${token.color.textMuted}" font-family="${token.typography.family.body}" font-size="${token.typography.size.label}" font-weight="${token.typography.weight.heavy}" letter-spacing="${token.typography.tracking.team}">${card.side}</text><text x="${center}" y="${layout.teamNameY}" text-anchor="middle" fill="${token.color.text}" font-family="${token.typography.family.heading}" font-size="${token.typography.size.team}" font-weight="${token.typography.weight.bold}"${length}>${xml(card.name.toUpperCase())}</text></g>`;
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
