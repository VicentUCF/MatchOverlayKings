import { describe, expect, it } from 'vitest';
import { mapProductionOverviewData } from './production-overview-mapper.js';
import {
  CLUB_ID,
  OPERATION_ID,
  productionDataset,
  USER_ID,
} from './production-overview-test-fixtures.js';

describe('production overview mapping', () => {
  it('keeps production administrators distinct from delegated operators', () => {
    const admin = mapProductionOverviewData(USER_ID, productionDataset('production_admin'));
    const operator = mapProductionOverviewData(USER_ID, productionDataset('operator'));

    expect(admin).toMatchObject({ kind: 'success', capability: 'admin' });
    expect(operator).toMatchObject({ kind: 'success', capability: 'operator' });
  });

  it('maps every configured court in authoritative display order with no-assignment slots', () => {
    const dataset = productionDataset();
    dataset.courts.push({
      id: '80000000-0000-4000-8000-000000000005', club_id: CLUB_ID, slug: 'pista-central',
      name: 'Pista central', display_order: 0, production_enabled: false,
    });
    const result = mapProductionOverviewData(USER_ID, dataset);

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.snapshot.courts.map((court) => court.slug)).toEqual([
      'pista-central',
      'pista-1',
      'pista-2',
      'pista-3',
      'pista-4',
    ]);
    expect(result.snapshot.courts[1]?.assignment?.desired.version).toBe(3);
    expect(result.snapshot.courts[1]?.assignment?.latestOperationClaim?.operationId).toBe(OPERATION_ID);
    expect(result.snapshot.courts.filter(({ slug }) => slug !== 'pista-1').every((court) => court.assignment === null)).toBe(true);
  });

  it.each([
    ['claimed', null, null],
    ['completed', { summary: 'Output reconciled', retryable: false }, '2026-09-14T10:01:00.000Z'],
    ['failed', { summary: 'Encoder unavailable', retryable: true }, '2026-09-14T10:02:00.000Z'],
  ] as const)('parses a canonical %s claim for the latest operation', (status, claimResult, completedAt) => {
    const dataset = productionDataset();
    const claim = dataset.production_operation_claims[0];
    if (claim === undefined) throw new Error('claim fixture failed');
    dataset.production_operation_claims[0] = {
      ...claim,
      status,
      result: claimResult,
      completed_at: completedAt,
    };

    const result = mapProductionOverviewData(USER_ID, dataset);

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.snapshot.courts.find(({ slug }) => slug === 'pista-1')?.assignment?.latestOperationClaim).toMatchObject({
      operationId: OPERATION_ID,
      status,
      result: claimResult,
      completedAt,
    });
  });

  it('selects the latest operation deterministically before pairing its claim', () => {
    const dataset = productionDataset();
    const operation = dataset.production_operations[0];
    const claim = dataset.production_operation_claims[0];
    if (operation === undefined || claim === undefined) throw new Error('operation fixture failed');
    const latestOperationId = 'b0000000-0000-4000-8000-000000000002';
    dataset.production_operations.push({ ...operation, id: latestOperationId });
    dataset.production_operation_claims.push({
      ...claim,
      operation_id: latestOperationId,
      status: 'completed',
      result: { summary: 'Latest operation completed', retryable: false },
      completed_at: '2026-09-14T10:01:00.000Z',
    });

    const result = mapProductionOverviewData(USER_ID, dataset);

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.snapshot.courts.find(({ slug }) => slug === 'pista-1')?.assignment?.latestOperation?.id).toBe(latestOperationId);
    expect(result.snapshot.courts.find(({ slug }) => slug === 'pista-1')?.assignment?.latestOperationClaim?.operationId).toBe(latestOperationId);
  });

  it('does not attach an older claim when the latest operation is unclaimed', () => {
    const dataset = productionDataset();
    const operation = dataset.production_operations[0];
    if (operation === undefined) throw new Error('operation fixture failed');
    const latestOperationId = 'b0000000-0000-4000-8000-000000000002';
    dataset.production_operations.push({
      ...operation,
      id: latestOperationId,
      created_at: '2026-09-14T10:01:00.000Z',
    });

    const result = mapProductionOverviewData(USER_ID, dataset);

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.snapshot.courts.find(({ slug }) => slug === 'pista-1')?.assignment?.latestOperation?.id).toBe(latestOperationId);
    expect(result.snapshot.courts.find(({ slug }) => slug === 'pista-1')?.assignment?.latestOperationClaim).toBeNull();
  });

  it('rejects the complete response when one production row is malformed', () => {
    const dataset = productionDataset();
    const desired = dataset.production_desired_states[0];
    if (desired === undefined) throw new Error('desired fixture failed');
    dataset.production_desired_states[0] = {
      ...desired,
      version: 0,
    };

    expect(mapProductionOverviewData(USER_ID, dataset)).toEqual({ kind: 'malformed' });
  });

  it('rejects the complete response when one claim row is malformed', () => {
    const validDataset = productionDataset();
    const claim = validDataset.production_operation_claims[0];
    if (claim === undefined) throw new Error('claim fixture failed');
    const dataset = {
      ...validDataset,
      production_operation_claims: [{ ...claim, status: 'pending' }],
    };

    expect(mapProductionOverviewData(USER_ID, dataset)).toEqual({ kind: 'malformed' });
  });

  it('rejects claims returned for another club', () => {
    const validDataset = productionDataset();
    const claim = validDataset.production_operation_claims[0];
    if (claim === undefined) throw new Error('claim fixture failed');
    const dataset = {
      ...validDataset,
      production_operation_claims: [{
        ...claim,
        club_id: '20000000-0000-4000-8000-000000000002',
      }],
    };

    expect(mapProductionOverviewData(USER_ID, dataset)).toEqual({ kind: 'malformed' });
    expect(claim.club_id).toBe(CLUB_ID);
  });
});
