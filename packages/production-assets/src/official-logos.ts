import { readFileSync } from 'node:fs';

// The season's approved assets are bundled so rendering also works offline.
// Use PNG copies: the pinned Resvg renderer silently skips embedded WebP images.
const files: Readonly<Record<string, string>> = {
  'kings of favar': 'kings.png', kings: 'kings.png',
  'red lions': 'red-lions.png',
  'barbaridad team': 'barbaridad.png', barbaridad: 'barbaridad.png',
  'magic city': 'magic-city.png', magic: 'magic-city.png',
  thormentadores: 'thormentadores.png', titanics: 'titanics.png',
};
const cache = new Map<string, string>();
function asset(file: string): string {
  let uri = cache.get(file);
  if (uri === undefined) {
    const bytes = readFileSync(new URL(`../assets/${file}`, import.meta.url));
    uri = `data:image/${file.endsWith('.webp') ? 'webp' : 'png'};base64,${bytes.toString('base64')}`;
    cache.set(file, uri);
  }
  return uri;
}
export function officialTeamLogo(name: string): string | undefined {
  const file = files[name.trim().toLowerCase()];
  return file === undefined ? undefined : asset(file);
}
export function officialLeagueLogo(): string { return asset('kpl-wordmark.png'); }

export function officialThumbnailBackground(): string { return asset('padel-court-night.png'); }
