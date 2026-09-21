export class SerializedTaskQueue {
  private tail: Promise<void> = Promise.resolve();

  public run<Result>(task: () => Promise<Result>): Promise<Result> {
    const scheduled = this.tail.then(task);
    this.tail = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  }
}
