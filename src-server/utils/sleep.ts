/**
 * `new Promise((resolve) => setTimeout(resolve, ms))`, which five src-server
 * modules had each written under three names (`sleep`, `delay`, `wait`).
 *
 * It does NOT unref the timer and it takes no `AbortSignal`, which is why
 * `services/evidence/orchestration-review-executor.ts` keeps its own `delay`:
 * that one resolves early on abort and unrefs, so it is a different contract
 * rather than a differently-named copy of this one.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
