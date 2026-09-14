import { describe, expect, it } from 'vitest';
import { bounded, nodePlan, withManagedChild } from './managed-process-fixture.js';

const floodScript = [
  "const fs = require('node:fs')",
  "const chunk = Buffer.alloc(8192, 97)",
  "for (let index = 0; index < 128; index += 1) fs.writeSync(3, chunk)",
].join(';');

describe('managed fd3 progress', () => {
  it('drains eagerly when progress is never consumed', async () => {
    await withManagedChild(nodePlan(floodScript, ['ignore', 'pipe', 'pipe', 'pipe']), async (child) => {
      const outcome = await bounded(child.close);

      expect(outcome).toMatchObject({ state: 'settled', value: { code: 0 } });
    });
  });

  it('retains bounded progress for a late consumer', async () => {
    const script = "const fs=require('node:fs');fs.writeSync(3,'late-progress');";
    await withManagedChild(nodePlan(script, ['ignore', 'pipe', 'pipe', 'pipe']), async (child) => {
      await child.close;
      const progress = child.progress;
      if (progress === null) throw new TypeError('Expected fd3 progress');
      let value = '';
      for await (const chunk of progress) value += new TextDecoder().decode(chunk);

      expect(value).toBe('late-progress');
    });
  });

  it('keeps draining after a consumer returns early', async () => {
    await withManagedChild(nodePlan(floodScript, ['ignore', 'pipe', 'pipe', 'pipe']), async (child) => {
      const progress = child.progress;
      if (progress === null) throw new TypeError('Expected fd3 progress');
      for await (const chunk of progress) {
        expect(chunk.byteLength).toBeGreaterThan(0);
        break;
      }

      const outcome = await bounded(child.close);

      expect(outcome).toMatchObject({ state: 'settled', value: { code: 0 } });
    });
  });

  it('bounds queued bytes and reports coalescing and loss', async () => {
    await withManagedChild(nodePlan(floodScript, ['ignore', 'pipe', 'pipe', 'pipe']), async (child) => {
      await child.close;

      expect(child.diagnostics()).toMatchObject({
        progressQueuedBytes: 65_536,
        progressQueuedItems: 1,
      });
      expect(child.diagnostics().progressDroppedBytes).toBeGreaterThan(0);
      expect(child.diagnostics().progressCoalescedItems).toBeGreaterThan(0);
    });
  });
});
