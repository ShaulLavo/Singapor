export type EditorSecondaryWorkSchedulerOptions = {
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
};

export type EditorSecondaryWorkOptions = {
  readonly key: string;
  readonly delayMs?: number;
  readonly version?: number;
  isCurrent?(version: number): boolean;
  run(): void;
};

type ScheduledSecondaryWork = {
  readonly token: number;
  readonly timer: ReturnType<typeof globalThis.setTimeout>;
  readonly version: number;
  isCurrent(version: number): boolean;
  run(): void;
};

export class EditorSecondaryWorkScheduler {
  private readonly setTimer: typeof globalThis.setTimeout;
  private readonly clearTimer: typeof globalThis.clearTimeout;
  private readonly scheduled = new Map<string, ScheduledSecondaryWork>();
  private nextToken = 0;
  private disposed = false;

  constructor(options: EditorSecondaryWorkSchedulerOptions = {}) {
    this.setTimer = options.setTimeout ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimer = options.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
  }

  schedule(options: EditorSecondaryWorkOptions): void {
    if (this.disposed) return;

    this.cancel(options.key);
    const token = this.nextToken + 1;
    this.nextToken = token;
    const version = options.version ?? token;
    const timer = this.setTimer(
      () => this.run(options.key, token),
      normalizeDelayMs(options.delayMs),
    );
    this.scheduled.set(options.key, {
      token,
      timer,
      version,
      isCurrent: options.isCurrent ?? (() => true),
      run: options.run,
    });
  }

  cancel(key: string): void {
    const scheduled = this.scheduled.get(key);
    if (!scheduled) return;

    this.scheduled.delete(key);
    this.clearTimer(scheduled.timer);
  }

  dispose(): void {
    if (this.disposed) return;

    this.disposed = true;
    for (const key of this.scheduled.keys()) this.cancel(key);
  }

  private run(key: string, token: number): void {
    const scheduled = this.scheduled.get(key);
    if (!scheduled) return;
    if (scheduled.token !== token) return;

    this.scheduled.delete(key);
    if (!scheduled.isCurrent(scheduled.version)) return;

    scheduled.run();
  }
}

function normalizeDelayMs(delayMs: number | undefined): number {
  if (!delayMs || delayMs <= 0) return 0;
  return delayMs;
}
