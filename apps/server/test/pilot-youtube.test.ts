import { describe, expect, it } from 'vitest';
import { PilotYouTubeError, youtubeApiErrorMessage } from '../src/pilot-youtube.js';

describe('YouTube API error presentation', () => {
  it.each([
    ['invalidScheduledStartTime', 'La fecha y hora no son válidas para YouTube. Programa la emisión para un momento futuro.'],
    ['liveStreamingNotEnabled', 'El canal de YouTube todavía no tiene habilitadas las emisiones en directo.'],
    ['quotaExceeded', 'Se ha agotado la cuota diaria de la API de YouTube.'],
  ])('maps %s to an actionable message', (reason, expected) => {
    expect(youtubeApiErrorMessage({
      response: { data: { error: { errors: [{ reason }] } } },
    })).toBe(expected);
  });

  it('keeps unknown API failures generic', () => {
    expect(new PilotYouTubeError('API_ERROR').message).toBe('YouTube no pudo completar la operación.');
    expect(youtubeApiErrorMessage(new Error('secret upstream detail')))
      .toBe('YouTube no pudo completar la operación.');
  });
});
