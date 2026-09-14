import { describe, expect, it } from 'vitest';
import { createProductionAssets } from '../src/index.js';
import { baseInput, onePixelPng } from './fixture.js';

function readPngDimensions(bytes: Uint8Array): readonly [number, number] {
  return [
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16),
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(20),
  ];
}

describe('livestream production assets', () => {
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
