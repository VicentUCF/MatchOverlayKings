import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { PilotMobileCameraSessionSchema } from '@kpl/production-contracts';
import { PilotMobileCameraPanel } from './PilotMobileCameraPanel.js';

it('allows revocation and a new link while the broadcast is active', () => {
  const props = { courtSlug: 'pista-1' as const, active: true, pending: false, connectUrl: null,
    onCreate: async () => null, onRevoke: async () => true, onUpdate: async () => true };
  const mobileCamera = PilotMobileCameraSessionSchema.parse({
    id: '20000000-0000-4000-8000-000000000001', courtSlug: 'pista-1', state: 'offline',
    desired: { revision: 1, cameraId: null, profile: '1080p30', audioEnabled: true },
    applied: null, capabilities: null, metrics: null, claimed: false, lastHeartbeatAt: null,
    expiresAt: '2026-09-19T12:00:00.000Z', error: null, previewUrl: null,
  });
  const connected = renderToStaticMarkup(createElement(PilotMobileCameraPanel, { ...props, mobileCamera }));
  expect(connected.match(/<button[^>]*>.*?Revocar móvil<\/button>/)?.[0]).not.toContain('disabled');
  expect(connected).toContain('Revocar móvil');
  const revoked = renderToStaticMarkup(createElement(PilotMobileCameraPanel, { ...props, mobileCamera: { ...mobileCamera, state: 'revoked' } }));
  expect(revoked).toContain('Generar enlace');
  expect(revoked.match(/<button[^>]*>.*?Generar enlace<\/button>/)?.[0]).not.toContain('disabled');
});
