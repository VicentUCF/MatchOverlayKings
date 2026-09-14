import { describe, expect, it, vi } from 'vitest';
import { submitProductionSetupOnce } from './useProductionSetup.js';

describe('production setup submission guard', () => {
  it('starts one orchestration run for two immediate submissions', async () => {
    const inFlight = { current: null };
    let finish: (() => void) | undefined;
    const orchestration = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));

    const first = submitProductionSetupOnce(inFlight, orchestration);
    const second = submitProductionSetupOnce(inFlight, orchestration);

    expect(orchestration).toHaveBeenCalledOnce();
    expect(second).toBe(first);
    finish?.();
    await first;
  });

  it('releases the guard after a rejected orchestration without swallowing the error', async () => {
    const inFlight = { current: null };
    const failure = new TypeError('orchestration failed');
    const orchestration = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);

    await expect(submitProductionSetupOnce(inFlight, orchestration)).rejects.toBe(failure);
    await submitProductionSetupOnce(inFlight, orchestration);

    expect(orchestration).toHaveBeenCalledTimes(2);
  });
});
