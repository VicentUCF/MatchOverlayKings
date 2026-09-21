import { finished } from 'node:stream/promises';
import type { Writable } from 'node:stream';

export type Fd4PumpErrorCode = 'ABORTED' | 'FD4_CLOSED' | 'INPUT_FAILED';

export class Fd4PumpError extends Error {
  public constructor(public readonly code: Fd4PumpErrorCode) {
    super(code);
    this.name = 'Fd4PumpError';
  }
}

type PumpTerminal = 'aborted' | 'closed' | 'failed';
type PumpRace<T> =
  | { readonly state: 'value'; readonly value: T }
  | { readonly state: 'terminal'; readonly terminal: PumpTerminal };

export type Fd4PumpOptions = {
  readonly input: Writable;
  readonly chunks: AsyncIterable<Uint8Array>;
  readonly signal: AbortSignal;
  readonly childClose: Promise<unknown>;
};

function terminalError(terminal: PumpTerminal): Fd4PumpError {
  switch (terminal) {
    case 'aborted': return new Fd4PumpError('ABORTED');
    case 'closed': return new Fd4PumpError('FD4_CLOSED');
    case 'failed': return new Fd4PumpError('INPUT_FAILED');
  }
}

function normalizeError(error: unknown): Fd4PumpError {
  if (error instanceof Fd4PumpError) return error;
  return new Fd4PumpError('INPUT_FAILED');
}

async function raceTerminal<T>(operation: Promise<T>, terminal: Promise<PumpTerminal>): Promise<PumpRace<T>> {
  return Promise.race([
    operation.then((value): PumpRace<T> => ({ state: 'value', value })),
    terminal.then((value): PumpRace<T> => ({ state: 'terminal', terminal: value })),
  ]);
}

async function waitForDrain(input: Writable, terminal: Promise<PumpTerminal>): Promise<void> {
  let removeListeners = (): void => undefined;
  const streamEvent = new Promise<PumpRace<void>>((resolve) => {
    const settle = (result: PumpRace<void>): void => {
      removeListeners();
      resolve(result);
    };
    const onDrain = (): void => { settle({ state: 'value', value: undefined }); };
    const onError = (): void => { settle({ state: 'terminal', terminal: 'failed' }); };
    const onClose = (): void => { settle({ state: 'terminal', terminal: 'closed' }); };
    removeListeners = () => {
      input.off('drain', onDrain);
      input.off('error', onError);
      input.off('close', onClose);
    };
    input.once('drain', onDrain);
    input.once('error', onError);
    input.once('close', onClose);
  });
  const result = await Promise.race([
    streamEvent,
    terminal.then((value) => {
      removeListeners();
      return { state: 'terminal', terminal: value } satisfies PumpRace<void>;
    }),
  ]);
  removeListeners();
  if (result.state === 'terminal') throw terminalError(result.terminal);
}

export async function pumpFd4Input(options: Fd4PumpOptions): Promise<void> {
  let iterator: AsyncIterator<Uint8Array> | null = null;
  let primaryError: Fd4PumpError | null = null;
  let cleanupError: Fd4PumpError | null = null;
  let terminalState: PumpTerminal | null = null;
  let settleTerminal: (terminal: PumpTerminal) => void = () => undefined;
  const terminal = new Promise<PumpTerminal>((resolve) => { settleTerminal = resolve; });
  const settle = (value: PumpTerminal): void => {
    if (terminalState !== null) return;
    terminalState = value;
    settleTerminal(value);
  };
  const onError = (): void => { settle('failed'); };
  const onClose = (): void => {
    if (!options.input.writableFinished) settle('closed');
  };
  const onAbort = (): void => { settle('aborted'); };
  options.input.on('error', onError);
  options.input.on('close', onClose);
  options.signal.addEventListener('abort', onAbort, { once: true });
  void options.childClose.then(
    () => { settle('closed'); },
    () => { settle('closed'); },
  );
  try {
    if (options.input.destroyed || options.input.closed) throw new Fd4PumpError('FD4_CLOSED');
    const activeIterator = options.chunks[Symbol.asyncIterator]();
    iterator = activeIterator;
    if (options.signal.aborted) throw new Fd4PumpError('ABORTED');
    while (true) {
      const next = await raceTerminal(Promise.resolve().then(() => activeIterator.next()), terminal);
      if (next.state === 'terminal') throw terminalError(next.terminal);
      if (next.value.done) break;
      if (!options.input.write(next.value.value)) await waitForDrain(options.input, terminal);
    }
    options.input.end();
    const completion = await raceTerminal(
      finished(options.input, { cleanup: true }).then(() => undefined),
      terminal,
    );
    if (completion.state === 'terminal') throw terminalError(completion.terminal);
    if (!options.input.writableFinished) throw new Fd4PumpError('FD4_CLOSED');
  } catch (error) {
    primaryError = normalizeError(error);
  } finally {
    if (!options.input.writableFinished) options.input.destroy();
    options.input.off('error', onError);
    options.input.off('close', onClose);
    options.signal.removeEventListener('abort', onAbort);
    if (iterator !== null) {
      let cleanup: Promise<Fd4PumpError | null>;
      try {
        const returnMethod = iterator.return;
        cleanup = returnMethod === undefined
          ? Promise.resolve(null)
          : Promise.resolve(returnMethod.call(iterator)).then(
            () => null,
            (error) => normalizeError(error),
          );
      } catch (error) {
        cleanup = Promise.resolve(normalizeError(error));
      }
      if (primaryError === null) cleanupError = await cleanup;
      else void cleanup.then(() => undefined);
    }
  }
  if (primaryError !== null) throw primaryError;
  if (cleanupError !== null) throw cleanupError;
}
