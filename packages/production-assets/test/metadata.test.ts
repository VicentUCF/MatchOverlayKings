import { describe, expect, it } from 'vitest';
import { parseProductionAssetInput } from '../src/index.js';
import { baseInput } from './fixture.js';

describe('production asset metadata boundary', () => {
  it('parses the required match metadata when every field is safe', () => {
    // Given
    const input = { ...baseInput };

    // When
    const parsed = parseProductionAssetInput(input);

    // Then
    expect(parsed).toMatchObject({
      seasonLabel: 'T2',
      matchdayLabel: 'Jornada',
      matchdayNumber: 3,
      timeZone: 'Europe/Madrid',
      locale: 'es-ES',
    });
  });

  it.each([
    ['unknown fields', { ...baseInput, ignored: true }],
    ['an insecure public URL', { ...baseInput, publicUrl: 'http://example.com/live' }],
    ['a credential-bearing public URL', { ...baseInput, publicUrl: 'https://user:secret@example.com/live' }],
    ['an invalid timezone', { ...baseInput, timeZone: 'Mars/Olympus' }],
    ['an invalid locale', { ...baseInput, locale: 'not_a_locale' }],
    ['text with an unpaired surrogate', { ...baseInput, leagueName: 'KPL\uD800' }],
    [
      'a traversing local logo reference',
      { ...baseInput, home: { ...baseInput.home, logo: { kind: 'local-ref', ref: '/logos/../secret.png' } } },
    ],
    [
      'a remote logo reference',
      { ...baseInput, away: { ...baseInput.away, logo: { kind: 'local-ref', ref: 'https://example.com/logo.png' } } },
    ],
    [
      'logo bytes with a mismatched media type',
      {
        ...baseInput,
        home: {
          ...baseInput.home,
          logo: { kind: 'bytes', mediaType: 'image/jpeg', bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
        },
      },
    ],
  ])('rejects %s', (_caseName, input) => {
    // Given
    const parse = () => parseProductionAssetInput(input);

    // Then
    expect(parse).toThrow();
  });
});
