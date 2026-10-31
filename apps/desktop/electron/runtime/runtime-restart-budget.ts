/**
 * Decides whether a lost agent runtime may be started again. A runtime that keeps dying
 * (for example an extension that crashes it while loading) must not restart forever.
 */
export class RuntimeRestartBudget {
  private readonly failures: number[] = [];

  constructor(
    private readonly limit = 3,
    private readonly windowMs = 60_000,
  ) {}

  /** Records an unexpected loss. Returns false once `limit` losses fall within `windowMs`. */
  recordFailure(now = Date.now()): boolean {
    this.failures.push(now);
    while (this.failures.length > 0 && now - this.failures[0]! >= this.windowMs) {
      this.failures.shift();
    }
    return this.failures.length < this.limit;
  }

  get failuresInWindow(): number {
    return this.failures.length;
  }
}
