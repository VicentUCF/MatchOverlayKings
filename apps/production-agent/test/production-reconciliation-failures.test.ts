import type { CompleteOperationCommand } from '@kpl/production-contracts';
import { describe, expect, it } from 'vitest';
import { ControlPlaneAdapterError } from '../src/index.js';
import {
  loopFor,
  operationFor,
  operationsForFirstTwo,
  reconciledResults,
  settledClaimFor,
  snapshots,
} from './production-runtime-fixtures.js';

describe('production reconciliation failure cleanup', () => {
  it('attempts interruption failure for every claim and preserves the reconciliation error', async () => {
    const current = snapshots();
    const operations = operationsForFirstTwo(current);
    const failure = new TypeError('Supervisor reconciliation failed');
    const completions: CompleteOperationCommand[] = [];
    const loop = loopFor({
      current,
      operations,
      reconcile: async () => { throw failure; },
      completeOperation: async (command) => {
        completions.push(command);
        if (command.operationId === operations[0].id) throw new TypeError('Cleanup completion failed');
        return settledClaimFor(operations[1], command);
      },
    });

    const round = loop.runCycle(new AbortController().signal);

    await expect(round).rejects.toBe(failure);
    expect(completions).toEqual(operations.map((operation) => ({
      operationId: operation.id,
      status: 'failed',
      result: { summary: 'Reconciliation interrupted', retryable: true },
    })));
  });

  it('terminally fails a claim when observed-state reporting is interrupted', async () => {
    const current = snapshots();
    const operation = operationFor(current[0]);
    const failure = new TypeError('Observed-state report failed');
    const completions: CompleteOperationCommand[] = [];
    const loop = loopFor({
      current,
      operations: [operation],
      reconcile: async () => ({ courts: reconciledResults(current) }),
      reportObservedState: async () => { throw failure; },
      completeOperation: async (command) => {
        completions.push(command);
        return settledClaimFor(operation, command);
      },
    });

    await expect(loop.runCycle(new AbortController().signal)).rejects.toBe(failure);
    expect(completions).toEqual([{
      operationId: operation.id,
      status: 'failed',
      result: { summary: 'Reconciliation interrupted', retryable: true },
    }]);
  });

  it('does not complete a settled claim twice when a later completion is interrupted', async () => {
    const current = snapshots();
    const operations = operationsForFirstTwo(current);
    const failure = new TypeError('Operation completion failed');
    const completions: CompleteOperationCommand[] = [];
    const loop = loopFor({
      current,
      operations,
      reconcile: async () => ({ courts: reconciledResults(current) }),
      completeOperation: async (command) => {
        completions.push(command);
        if (command.operationId === operations[1].id && command.status === 'completed') throw failure;
        const operation = operations.find(({ id }) => id === command.operationId);
        if (operation === undefined) throw new TypeError('Unknown operation completion fixture');
        return settledClaimFor(operation, command);
      },
    });

    await expect(loop.runCycle(new AbortController().signal)).rejects.toBe(failure);
    expect(completions).toEqual([
      { operationId: operations[0].id, status: 'completed', result: { summary: 'Reconciliation applied', retryable: false } },
      { operationId: operations[1].id, status: 'completed', result: { summary: 'Reconciliation applied', retryable: false } },
      { operationId: operations[1].id, status: 'failed', result: { summary: 'Reconciliation interrupted', retryable: true } },
    ]);
  });

  it('leaves claimed operations to lease expiry when reconciliation aborts', async () => {
    const current = snapshots();
    const operation = operationFor(current[0]);
    const controller = new AbortController();
    const completions: CompleteOperationCommand[] = [];
    const loop = loopFor({
      current,
      operations: [operation],
      reconcile: async () => {
        controller.abort();
        return { courts: reconciledResults(current) };
      },
      completeOperation: async (command) => {
        completions.push(command);
        return settledClaimFor(operation, command);
      },
    });

    const round = loop.runCycle(controller.signal);

    await expect(round).rejects.toBeInstanceOf(ControlPlaneAdapterError);
    expect(completions).toEqual([]);
  });
});
