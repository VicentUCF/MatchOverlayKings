import { Resvg } from '@resvg/resvg-js';
import { fileURLToPath } from 'node:url';

const FONT_FILES = [
  fileURLToPath(import.meta.resolve('@expo-google-fonts/space-grotesk/700Bold/SpaceGrotesk_700Bold.ttf')),
  fileURLToPath(import.meta.resolve('@expo-google-fonts/manrope/700Bold/Manrope_700Bold.ttf')),
] as const;

export interface LiveScoreboardFrameInput {
  readonly width: number;
  readonly height: number;
  readonly title: string;
  readonly courtName: string;
  readonly homeName: string;
  readonly awayName: string;
  readonly homeColor?: string;
  readonly awayColor?: string;
  readonly homeSets: readonly number[];
  readonly awaySets: readonly number[];
  readonly homePoint: string;
  readonly awayPoint: string;
  readonly servingSide: 'home' | 'away';
  readonly visible: boolean;
}

export function renderLiveScoreboardPng(input: LiveScoreboardFrameInput): Uint8Array {
  return renderLiveScoreboard(input).asPng();
}

export function renderLiveScoreboardRgba(input: LiveScoreboardFrameInput): Uint8Array {
  return renderLiveScoreboard(input).pixels;
}

function renderLiveScoreboard(input: LiveScoreboardFrameInput) {
  const svg = buildLiveScoreboardSvg(input);
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
  }).render();
}

export function buildLiveScoreboardSvg(input: LiveScoreboardFrameInput): string {
  const setCount = Math.max(1, Math.min(3, input.homeSets.length, input.awaySets.length));
  const boardWidth = 890;
  const boardHeight = 214;
  const boardX = 42;
  const boardY = 34;
  const pointsX = boardX + boardWidth - 88;
  const setWidth = 62;
  const setsStartX = pointsX - setCount * setWidth;
  const nameWidth = setsStartX - boardX - 20;
  const homeColor = color(input.homeColor, '#c9a227');
  const awayColor = color(input.awayColor, '#34d8ff');
  const title = fit(input.title, 40);
  const court = fit(input.courtName || 'Pista', 24);

  if (!input.visible) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${input.width}" height="${input.height}"/>`;
  }

  const setHeaders = Array.from({ length: setCount }, (_, index) =>
    `<text x="${setsStartX + index * setWidth + setWidth / 2}" y="94" class="label" text-anchor="middle">S${index + 1}</text>`,
  ).join('');
  const homeSets = Array.from({ length: setCount }, (_, index) => scoreCell(
    setsStartX + index * setWidth, 104, setWidth, 48, input.homeSets[index] ?? 0,
  )).join('');
  const awaySets = Array.from({ length: setCount }, (_, index) => scoreCell(
    setsStartX + index * setWidth, 154, setWidth, 48, input.awaySets[index] ?? 0,
  )).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${input.width}" height="${input.height}" viewBox="0 0 ${input.width} ${input.height}">
  <defs>
    <linearGradient id="panel" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#05080c" stop-opacity=".98"/><stop offset="1" stop-color="#111925" stop-opacity=".95"/></linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#c9a227"/><stop offset="1" stop-color="#34d8ff"/></linearGradient>
    <filter id="shadow" x="-10%" y="-20%" width="130%" height="160%"><feDropShadow dx="0" dy="14" stdDeviation="14" flood-opacity=".52"/></filter>
    <style>.heading{font-family:'Space Grotesk';font-weight:700}.body{font-family:Manrope;font-weight:700}.label{font-family:Manrope;font-size:14px;font-weight:700;fill:#9da8b8;letter-spacing:1px}.number{font-family:'Space Grotesk';font-size:31px;font-weight:700;fill:#fff}</style>
  </defs>
  <g filter="url(#shadow)">
    <rect x="${boardX}" y="${boardY}" width="${boardWidth}" height="${boardHeight}" rx="8" fill="url(#panel)" stroke="#fff" stroke-opacity=".22"/>
    <rect x="${boardX}" y="${boardY}" width="${boardWidth}" height="5" rx="2.5" fill="url(#accent)"/>
    <rect x="${boardX}" y="${boardY + 5}" width="${boardWidth}" height="61" fill="#fff" fill-opacity=".035"/>
    <rect x="${boardX + 14}" y="${boardY + 15}" width="68" height="36" rx="5" fill="#c9a227"/>
    <text x="${boardX + 48}" y="${boardY + 41}" class="heading" font-size="23" text-anchor="middle" fill="#080a0f">KPL</text>
    <text x="${boardX + 96}" y="${boardY + 31}" class="heading" font-size="20" fill="#fff">${xml(title)}</text>
    <text x="${boardX + 96}" y="${boardY + 50}" class="body" font-size="12" fill="#9da8b8">${xml(court)}</text>
    <circle cx="${boardX + boardWidth - 96}" cy="${boardY + 34}" r="5" fill="#ff3b4f"/>
    <text x="${boardX + boardWidth - 82}" y="${boardY + 39}" class="body" font-size="14" fill="#fff" letter-spacing="1">DIRECTO</text>
    <line x1="${boardX}" y1="${boardY + 66}" x2="${boardX + boardWidth}" y2="${boardY + 66}" stroke="#c9a227" stroke-width="3"/>
    ${setHeaders}
    <text x="${pointsX + 44}" y="94" class="label" text-anchor="middle">PTS</text>
    ${teamRow({ y: 104, name: input.homeName, color: homeColor, serving: input.servingSide === 'home', nameWidth })}
    ${teamRow({ y: 154, name: input.awayName, color: awayColor, serving: input.servingSide === 'away', nameWidth })}
    ${homeSets}${awaySets}
    <rect x="${pointsX}" y="104" width="88" height="48" fill="#fff" fill-opacity=".08"/>
    <rect x="${pointsX}" y="154" width="88" height="48" fill="#fff" fill-opacity=".055"/>
    <text x="${pointsX + 44}" y="138" class="number" text-anchor="middle">${xml(input.homePoint)}</text>
    <text x="${pointsX + 44}" y="188" class="number" text-anchor="middle">${xml(input.awayPoint)}</text>
  </g>
  </svg>`;
}

function teamRow(input: { y: number; name: string; color: string; serving: boolean; nameWidth: number }): string {
  const name = fit(input.name, 24);
  return `<rect x="42" y="${input.y}" width="${input.nameWidth}" height="48" fill="#fff" fill-opacity=".025"/>
    <rect x="42" y="${input.y}" width="7" height="48" fill="${input.color}"/>
    ${input.serving ? `<circle cx="67" cy="${input.y + 24}" r="7" fill="${input.color}"/><circle cx="67" cy="${input.y + 24}" r="2.5" fill="#080a0f"/>` : ''}
    <text x="88" y="${input.y + 33}" class="heading" font-size="24" fill="#fff">${xml(name)}</text>`;
}

function scoreCell(x: number, y: number, width: number, height: number, value: number): string {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#fff" fill-opacity=".04" stroke="#fff" stroke-opacity=".08"/>
    <text x="${x + width / 2}" y="${y + 34}" class="number" text-anchor="middle">${value}</text>`;
}

function color(value: string | undefined, fallback: string): string {
  return value && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function fit(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
