import {
  CourtIdSchema,
  OperationIdSchema,
  OutputIdSchema,
  VersionSchema,
} from '@kpl/production-contracts';
import { describe, expect, it } from 'vitest';
import { JsonLineLogger } from '../src/agent-logger.js';

describe('JsonLineLogger', () => {
  it('writes deterministic JSON lines containing only parsed safe fields', () => {
    const lines: string[] = [];
    const logger = new JsonLineLogger({
      clock: () => new Date('2026-09-13T12:00:00.000Z'),
      write: (line) => lines.push(line),
    });

    logger.log('info', 'snapshot_loaded', {
      courtId: CourtIdSchema.parse('10000000-0000-4000-8000-000000000001'),
      outputId: OutputIdSchema.parse('20000000-0000-4000-8000-000000000001'),
      desiredVersion: VersionSchema.parse(4),
      durationMs: 25,
    });

    expect(lines).toEqual([
      '{"level":"info","time":"2026-09-13T12:00:00.000Z","event":"snapshot_loaded","courtId":"10000000-0000-4000-8000-000000000001","outputId":"20000000-0000-4000-8000-000000000001","desiredVersion":4,"durationMs":25}\n',
    ]);
  });

  it('rejects unknown fields without writing or exposing sensitive values', () => {
    const lines: string[] = [];
    const logger = new JsonLineLogger({
      clock: () => new Date('2026-09-13T12:00:00.000Z'),
      write: (line) => lines.push(line),
    });
    const sensitiveValues = [
      'https://project.supabase.co',
      'agent-access-token',
      'local://outputs/program',
      'resolved-secret-value',
      'private upstream error message',
      '--service-role=forbidden',
    ];
    const cyclicFields: Record<string, unknown> = {};
    cyclicFields['metadata'] = cyclicFields;
    const unsafeFields: readonly Readonly<Record<string, unknown>>[] = [
      { metadata: sensitiveValues[0] },
      { token: sensitiveValues[1] },
      { secretRef: sensitiveValues[2] },
      { secret: sensitiveValues[3] },
      { error: new Error(sensitiveValues[4]) },
      { argv: ['node', sensitiveValues[5]] },
      cyclicFields,
    ];

    for (const fields of unsafeFields) {
      expect(() => Reflect.apply(logger.log, logger, [
        'error',
        'agent_error',
        fields,
      ])).toThrowError(expect.objectContaining({ code: 'INVALID_RECORD' }));
    }

    logger.log('error', 'agent_error', {
      operationId: OperationIdSchema.parse('30000000-0000-4000-8000-000000000001'),
      errorCode: 'REQUEST_FAILED',
      attempt: 2,
    });
    const output = lines.join('');

    expect(lines).toHaveLength(1);
    for (const sensitiveValue of sensitiveValues) expect(output).not.toContain(sensitiveValue);
  });
});
