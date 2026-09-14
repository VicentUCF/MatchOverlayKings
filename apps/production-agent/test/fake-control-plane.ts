import type {
  ControlPlaneRequest,
  ControlPlaneRequestExecutor,
  ControlPlaneResponse,
} from '../src/index.js';

type QueuedResponse = ControlPlaneResponse | Error;

export class FakeControlPlaneExecutor {
  readonly requests: ControlPlaneRequest[] = [];
  private readonly responses: QueuedResponse[] = [];

  public readonly execute: ControlPlaneRequestExecutor = async (request, signal) => {
    this.requests.push(request);
    const response = this.responses.shift();
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (response === undefined) throw new Error('Missing fake response');
    if (response instanceof Error) throw response;
    return response;
  };

  public succeed(data: unknown): void {
    this.responses.push({ data, error: null });
  }

  public fail(code: string, message: string): void {
    this.responses.push({ data: null, error: { code, message } });
  }
}
