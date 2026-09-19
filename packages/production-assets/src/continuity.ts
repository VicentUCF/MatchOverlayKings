import { Resvg } from '@resvg/resvg-js';
import { fileURLToPath } from 'node:url';

/** A static program background. The live scoreboard is composed above it. */
export function renderContinuityFrame(courtName: string, title: string): { png: Uint8Array; yuv: Uint8Array } {
  const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080">
    <rect width="1920" height="1080" fill="#151820"/>
    <path d="M220 400H1700" stroke="#dbba72" stroke-width="3"/>
    <g font-family="Manrope" text-anchor="middle">
      <text x="960" y="365" font-size="32" fill="#dbba72">KINGS PADEL LEAGUE · ${escape(courtName.toUpperCase())}</text>
      <text x="960" y="520" font-size="66" fill="#ffffff">RECUPERANDO SEÑAL</text>
      <text x="960" y="607" font-size="32" fill="#ced0d4">Volvemos en cuanto la cámara esté disponible</text>
      <text x="960" y="745" font-size="${Math.min(38, 1400 / Math.max(1, title.length * 0.65))}" fill="#dbba72">${escape(title)}</text>
    </g>
  </svg>`;
  const rendered = new Resvg(svg, { font: { loadSystemFonts: false,
    fontFiles: [fileURLToPath(import.meta.resolve('@expo-google-fonts/manrope/700Bold/Manrope_700Bold.ttf'))], defaultFontFamily: 'Manrope' } }).render();
  const rgba = rendered.pixels;
  const width = 1920; const height = 1080; const pixels = width * height;
  const yuv = new Uint8Array(pixels * 3 / 2);
  const clip = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
  for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) {
    let u = 0; let v = 0;
    for (const offset of [0, 1, width, width + 1]) {
      const index = y * width + x + offset;
      const r = rgba[index * 4]!; const g = rgba[index * 4 + 1]!; const b = rgba[index * 4 + 2]!;
      // Limited-range BT.709, also used by the camera bridge and output encoder.
      yuv[index] = clip(16 + 0.182586 * r + 0.614231 * g + 0.062007 * b);
      u += 128 - 0.100644 * r - 0.338572 * g + 0.439216 * b;
      v += 128 + 0.439216 * r - 0.398942 * g - 0.040274 * b;
    }
    const chroma = (y / 2) * (width / 2) + x / 2;
    yuv[pixels + chroma] = clip(u / 4);
    yuv[pixels + pixels / 4 + chroma] = clip(v / 4);
  }
  return { png: rendered.asPng(), yuv };
}
