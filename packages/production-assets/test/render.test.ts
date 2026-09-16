import { describe, expect, it } from 'vitest';
import { Resvg } from '@resvg/resvg-js';
import { createProductionAssets, renderLiveScoreboardPng, renderLiveScoreboardRgba } from '../src/index.js';
import { baseInput, onePixelPng } from './fixture.js';

function readPngDimensions(bytes: Uint8Array): readonly [number, number] {
  return [
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16),
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(20),
  ];
}

describe('livestream production assets', () => {
  it('renders a self-contained PNG scoreboard frame for streamed composition', () => {
    const frame = renderLiveScoreboardPng({
      width: 960, height: 270, title: 'Red Lions vs Kings', courtName: 'Pista 1',
      homeName: 'Red Lions', awayName: 'Kings', homeSets: [3], awaySets: [2],
      homePoint: '40', awayPoint: '30', servingSide: 'home', visible: true,
    });

    expect([...frame.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(readPngDimensions(frame)).toEqual([960, 270]);
  });

  it('renders a cropped transparent RGBA scoreboard frame for FFmpeg composition', () => {
    const frame = renderLiveScoreboardRgba({
      width: 960, height: 270, title: 'Red Lions vs Kings', courtName: 'Pista 1',
      homeName: 'Red Lions', awayName: 'Kings', homeSets: [3], awaySets: [2],
      homePoint: '40', awayPoint: '30', servingSide: 'home', visible: true,
    });

    expect(frame).toHaveLength(960 * 270 * 4);
    expect(frame[3]).toBe(0);
    expect(frame.some((channel, index) => index % 4 === 3 && channel > 0)).toBe(true);
  });

  it('renders a fully transparent frame when the scoreboard is hidden', () => {
    const frame = renderLiveScoreboardRgba({
      width: 960, height: 270, title: 'Match', courtName: 'Pista 1',
      homeName: 'Local', awayName: 'Visitante', homeSets: [], awaySets: [],
      homePoint: '0', awayPoint: '0', servingSide: 'home', visible: false,
    });

    expect(frame.every((channel) => channel === 0)).toBe(true);
  });

  it.each(['Kings of Favar', 'Red Lions', 'Barbaridad Team', 'Magic City', 'Thormentadores', 'Titanics'])(
    'embeds the official crest for %s and the KPL wordmark without external image references', (name) => {
      const assets = createProductionAssets({ ...baseInput, home: { name } });
      expect(assets.svg.match(/<image href="data:image\/(?:png|webp);base64,/g)).toHaveLength(4);
      expect(assets.svg).toContain(name.toUpperCase());
      expect(assets.svg).toContain('JORNADA 3');
      expect(assets.pngBytes.length).toBeLessThan(2 * 1024 * 1024);

      // An embedded image can be silently skipped by the PNG renderer.
      // Render each image alone so the background cannot mask a missing crest.
      for (const [image] of assets.svg.matchAll(/<image\b[^>]*\/>/g)) {
        const pixels = new Resvg(
          `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">${image}</svg>`,
          { font: { loadSystemFonts: false } },
        ).render().pixels;
        expect(pixels.some((channel, index) => index % 4 === 3 && channel > 0)).toBe(true);
      }
    },
  );

  it('builds the semantic YouTube title from match metadata', () => {
    // Given / When
    const assets = createProductionAssets(baseInput);

    // Then
    expect(assets.title.split(' | ')).toEqual([
      'Red Lions vs Titanics',
      'Jornada 3',
      'T2',
    ]);
  });

  it('returns identical metadata and bytes for identical input', () => {
    // Given / When
    const first = createProductionAssets(baseInput);
    const second = createProductionAssets(baseInput);

    // Then
    expect(second).toEqual(first);
    expect(first.description).toContain('09/09/2026, 19:30');
    expect(first.description).toContain('Europe/Madrid');
    expect(first.storageKey).toMatch(/^livestream-thumbnails\/[a-z0-9/-]+\.png$/);
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('canonicalizes equivalent scheduled instants for stable storage and content hashes', () => {
    // Given
    const equivalentInstant = { ...baseInput, scheduledAt: '2026-09-09T19:30:00.000+02:00' };

    // When
    const utcAssets = createProductionAssets(baseInput);
    const offsetAssets = createProductionAssets(equivalentInstant);

    // Then
    expect(offsetAssets.storageKey).toBe(utcAssets.storageKey);
    expect(offsetAssets.sha256).toBe(utcAssets.sha256);
  });

  it('renders exact YouTube thumbnail dimensions in SVG and PNG', () => {
    // Given / When
    const assets = createProductionAssets(baseInput);

    // Then
    expect(assets.svg).toContain('width="1280" height="720" viewBox="0 0 1280 720"');
    expect(readPngDimensions(assets.pngBytes)).toEqual([1280, 720]);
  });

  it('escapes untrusted text before inserting it into SVG', () => {
    // Given
    const input = {
      ...baseInput,
      leagueName: 'KPL <Final> & Friends',
      home: { ...baseInput.home, name: 'Red <Lions>', shortName: 'R&L' },
    };

    // When
    const assets = createProductionAssets(input);

    // Then
    expect(assets.svg).toContain('KPL &lt;Final&gt; &amp; Friends');
    expect(assets.svg).toContain('R&amp;L');
    expect(assets.svg).not.toContain('KPL <Final> & Friends');
  });

  it('embeds only caller-supplied bytes for safe local logo references', () => {
    // Given
    const ref = '/logos/red-lions.png';
    const input = {
      ...baseInput,
      home: { ...baseInput.home, logo: { kind: 'local-ref', ref } },
    };

    // When
    const assets = createProductionAssets(input, { localAssets: { [ref]: onePixelPng } });

    // Then
    expect(assets.svg).toContain('data:image/png;base64,');
    expect(assets.svg).not.toContain(ref);
  });

  it('rejects local references resolved with bytes that contradict their media type', () => {
    // Given
    const ref = '/logos/red-lions.jpg';
    const input = {
      ...baseInput,
      home: { ...baseInput.home, logo: { kind: 'local-ref' as const, ref } },
    };

    // When
    const build = () => createProductionAssets(input, { localAssets: { [ref]: onePixelPng } });

    // Then
    expect(build).toThrow();
  });

  it.each([
    ['court', { ...baseInput, courtName: 'Pista 2' }],
    ['team color', { ...baseInput, home: { ...baseInput.home, color: '#000000' } }],
    ['template revision', { ...baseInput, templateRevision: 'thumbnail-v2' }],
  ])('changes the hash for a material %s change', (_caseName, changedInput) => {
    // Given
    const baseline = createProductionAssets(baseInput);

    // When
    const changed = createProductionAssets(changedInput);

    // Then
    expect(changed.sha256).not.toBe(baseline.sha256);
  });
});
