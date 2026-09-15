import { Resvg } from '@resvg/resvg-js';
import { fileURLToPath } from 'node:url';
import { logoDataUri } from './logo.js';
import { officialLeagueLogo, officialTeamLogo, officialThumbnailBackground } from './official-logos.js';
import { THUMBNAIL_TOKENS as token } from './tokens.js';
import type { ProductionAssetInput, ProductionAssetOptions } from './types.js';

const FONT_FILES = [
  fileURLToPath(import.meta.resolve('@expo-google-fonts/space-grotesk/700Bold/SpaceGrotesk_700Bold.ttf')),
  fileURLToPath(import.meta.resolve('@expo-google-fonts/manrope/700Bold/Manrope_700Bold.ttf')),
] as const;

export function buildThumbnailSvg(input: ProductionAssetInput, options: ProductionAssetOptions): string {
  const gold = token.color.brand;
  const team = (side: 'home' | 'away', x: number) => {
    const value = input[side];
    const name = value.name.toUpperCase();
    const logo = logoDataUri(value, options) ?? officialTeamLogo(value.name);
    const mark = logo
      ? `<image href="${logo}" x="${x - 200}" y="130" width="400" height="400" preserveAspectRatio="xMidYMid meet"/>`
      : `<text x="${x}" y="360" text-anchor="middle" font-size="100" fill="${xml(value.color ?? gold)}">${xml((value.shortName ?? value.name).split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase())}</text>`;
    return `<ellipse cx="${x}" cy="340" rx="190" ry="190" fill="${xml(value.color ?? gold)}" opacity=".035"/>${mark}<text x="${x}" y="608" text-anchor="middle" font-size="44"${name.length > 14 ? ' textLength="450" lengthAdjust="spacingAndGlyphs"' : ''}>${xml(name)}</text>`;
  };
  const day = `${input.matchdayLabel} ${input.matchdayNumber}`.toUpperCase();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <title>${xml(input.leagueName)} · ${xml(input.home.shortName ?? input.home.name)} vs ${xml(input.away.shortName ?? input.away.name)} · ${xml(day)}</title>
  <defs>
    <radialGradient id="background"><stop stop-color="#242018"/><stop offset="1" stop-color="#08090b"/></radialGradient>
    <linearGradient id="gold"><stop stop-color="#80632c"/><stop offset=".45" stop-color="#f1d383"/><stop offset="1" stop-color="#ac873a"/></linearGradient>
    <pattern id="mesh" width="14" height="14" patternUnits="userSpaceOnUse"><path d="M14 0H0V14" fill="none" stroke="#b99a57" stroke-opacity=".12"/></pattern>
    <pattern id="dots" width="12" height="12" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="1.2" fill="${gold}" opacity=".18"/></pattern>
  </defs>
  <rect width="1280" height="720" fill="url(#background)"/>
  <image href="${officialThumbnailBackground()}" width="1280" height="720" preserveAspectRatio="xMidYMid slice"/>
  <rect width="1280" height="720" fill="#08090b" opacity=".38"/>
  <path d="M0 90L250 720H0ZM1280 90L1030 720H1280Z" fill="url(#dots)"/>
  <g fill="none" stroke="url(#gold)">
    <path d="M0 9H476L488 14H792L804 9H1280M0 710H1280" stroke-width="3"/>
    <path d="M0 130L225 710M1280 130L1055 710" stroke-width="12" opacity=".55"/>
    <path d="M0 235L190 710M1280 235L1090 710" stroke-width="2"/>
  </g>
  <path d="M640 180V530" stroke="url(#gold)" stroke-width="2" opacity=".5"/>
  <image href="${officialLeagueLogo()}" x="48" y="36" width="228" height="97" preserveAspectRatio="xMidYMid meet"/>
  <g font-family="${token.typography.family.heading}" font-weight="700" fill="#f5f5f5">
    <text x="640" y="94" text-anchor="middle" font-size="54"${day.length > 12 ? ' textLength="470" lengthAdjust="spacingAndGlyphs"' : ''}>${xml(day)}</text>
    <circle cx="1020" cy="77" r="10" fill="#ff1834"/>
    <text x="1043" y="85" font-family="Manrope" font-size="23">EN DIRECTO</text>
    ${team('home', 326)}
    ${team('away', 954)}
    <text x="640" y="408" text-anchor="middle" font-size="116" fill="url(#gold)" stroke="#b99a57" stroke-width="1">VS</text>
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

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
