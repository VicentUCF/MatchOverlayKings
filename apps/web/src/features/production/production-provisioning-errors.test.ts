import { describe, expect, it } from 'vitest';
import { createProductionProvisioningAdapter } from './production-provisioning-adapter.js';
import {
  eventDayRow,
  PROVISIONING_COMMAND_ID,
  PROVISIONING_IDS,
  provisioningHarness,
} from './production-provisioning-test-fixtures.js';

const validEventDay = {
  eventDayId: PROVISIONING_IDS.eventDay,
  clubId: PROVISIONING_IDS.club,
  name: 'Finals',
  eventDate: '2026-09-14',
  timeZone: 'Europe/Madrid',
  status: 'active',
  expectedVersion: 0,
} as const;

describe('production provisioning result classification', () => {
  it('returns validation without calling the RPC for invalid external input', async () => {
    // Given
    const harness = provisioningHarness({ data: eventDayRow(), error: null });
    const adapter = createProductionProvisioningAdapter(harness.backend, () => PROVISIONING_COMMAND_ID);

    // When
    const result = await adapter.upsertEventDay({ ...validEventDay, eventDayId: 'not-a-uuid' });

    // Then
    expect(result).toEqual({ kind: 'validation' });
    expect(harness.calls).toEqual([]);
  });

  it('rejects unsupported output transports at the browser boundary', async () => {
    // Given
    const harness = provisioningHarness({ data: {}, error: null });
    const adapter = createProductionProvisioningAdapter(harness.backend, () => PROVISIONING_COMMAND_ID);

    // When
    const result = await adapter.upsertOutput({
      outputId: PROVISIONING_IDS.output,
      eventId: PROVISIONING_IDS.event,
      name: 'Program',
      kind: 'program',
      transport: 'rtmp',
      secretRef: 'local://outputs/court-1',
      enabled: true,
      expectedVersion: 0,
    });

    // Then
    expect(result).toEqual({ kind: 'validation' });
    expect(harness.calls).toEqual([]);
  });

  it('maps permission errors to forbidden', async () => {
    // Given
    const harness = provisioningHarness({ data: null, error: { code: '42501', message: 'permission denied' } });
    const adapter = createProductionProvisioningAdapter(harness.backend, () => PROVISIONING_COMMAND_ID);

    // When
    const result = await adapter.upsertEventDay(validEventDay);

    // Then
    expect(result).toEqual({ kind: 'forbidden' });
  });

  it('maps exact version conflicts to the current version', async () => {
    // Given
    const harness = provisioningHarness({ data: null, error: { code: 'P0001', message: 'VERSION_CONFLICT:12' } });
    const adapter = createProductionProvisioningAdapter(harness.backend, () => PROVISIONING_COMMAND_ID);

    // When
    const result = await adapter.upsertEventDay(validEventDay);

    // Then
    expect(result).toEqual({ kind: 'conflict', currentVersion: 12 });
  });

  it('maps unrecognized structured RPC errors to transport', async () => {
    // Given
    const harness = provisioningHarness({ data: null, error: { code: 'P0001', message: 'EVENT_NOT_FOUND' } });
    const adapter = createProductionProvisioningAdapter(harness.backend, () => PROVISIONING_COMMAND_ID);

    // When
    const result = await adapter.upsertEventDay(validEventDay);

    // Then
    expect(result).toEqual({ kind: 'transport' });
  });

  it('maps rejected backend calls to transport', async () => {
    // Given
    const harness = provisioningHarness(new Error('network unavailable'));
    const adapter = createProductionProvisioningAdapter(harness.backend, () => PROVISIONING_COMMAND_ID);

    // When
    const result = await adapter.upsertEventDay(validEventDay);

    // Then
    expect(result).toEqual({ kind: 'transport' });
  });

  it('maps invalid envelopes and accepted rows to malformed', async () => {
    // Given
    const malformedEnvelope = createProductionProvisioningAdapter(
      provisioningHarness({ unexpected: true }).backend,
      () => PROVISIONING_COMMAND_ID,
    );
    const malformedRow = createProductionProvisioningAdapter(
      provisioningHarness({ data: { id: PROVISIONING_IDS.eventDay }, error: null }).backend,
      () => PROVISIONING_COMMAND_ID,
    );

    // When
    const envelopeResult = await malformedEnvelope.upsertEventDay(validEventDay);
    const rowResult = await malformedRow.upsertEventDay(validEventDay);

    // Then
    expect(envelopeResult).toEqual({ kind: 'malformed' });
    expect(rowResult).toEqual({ kind: 'malformed' });
  });

  it('treats an invalid generated command ID as malformed without calling the RPC', async () => {
    // Given
    const harness = provisioningHarness({ data: eventDayRow(), error: null });
    const adapter = createProductionProvisioningAdapter(harness.backend, () => '');

    // When
    const result = await adapter.upsertEventDay(validEventDay);

    // Then
    expect(result).toEqual({ kind: 'malformed' });
    expect(harness.calls).toEqual([]);
  });
});
