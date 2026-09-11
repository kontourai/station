const replayThreads = new Set<string>();

/** Opaque replay chat ids. Membership, not a name prefix, is the test. */
export function registerReplayThread(id?: string): string {
  const replayId = id ?? `replay:${crypto.randomUUID()}`;
  replayThreads.add(replayId);
  return replayId;
}

export function unregisterReplayThread(id: string): void {
  replayThreads.delete(id);
}

export function isReplayThread(id: string | undefined | null): boolean {
  return Boolean(id && replayThreads.has(id));
}

export function listReplayThreads(): readonly string[] {
  return [...replayThreads];
}

/** Test-only. */
export function _resetReplayRegistry(): void {
  replayThreads.clear();
}
