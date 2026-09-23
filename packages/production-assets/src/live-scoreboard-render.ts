import { Resvg } from '@resvg/resvg-js';
import { fileURLToPath } from 'node:url';
import { buildLiveScoreboardSvg } from './live-scoreboard.js';
import type { LiveScoreboardFrameInput } from './live-scoreboard.js';
const FONT_FILES = [fileURLToPath(import.meta.resolve('@expo-google-fonts/space-grotesk/700Bold/SpaceGrotesk_700Bold.ttf')),fileURLToPath(import.meta.resolve('@expo-google-fonts/manrope/700Bold/Manrope_700Bold.ttf'))] as const;
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

