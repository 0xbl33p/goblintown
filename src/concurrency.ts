export class Semaphore {
  private waiting: Array<() => void> = [];
  private inFlight = 0;

  constructor(private readonly capacity: number) {
    if (capacity < 1) throw new Error("Semaphore capacity must be >= 1");
  }

  async acquire(): Promise<() => void> {
    if (this.inFlight < this.capacity) {
      this.inFlight++;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.inFlight++;
    return () => this.release();
  }

  private release(): void {
    this.inFlight--;
    const next = this.waiting.shift();
    if (next) next();
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await task();
    } finally {
      release();
    }
  }
}

let _shared: Semaphore | null = null;

export function sharedSemaphore(): Semaphore {
  if (_shared) return _shared;
  const raw = process.env.GOBLINTOWN_MAX_CONCURRENCY;
  const parsed = raw ? Number(raw) : 5;
  const capacity = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 5;
  _shared = new Semaphore(capacity);
  return _shared;
}
