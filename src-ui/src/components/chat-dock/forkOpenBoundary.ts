export function commitForkOpenBoundary({
  signal,
  generation,
  currentGeneration,
  route,
}: {
  signal: AbortSignal;
  generation: number;
  currentGeneration: () => number;
  route: () => void;
}): boolean {
  if (signal.aborted || generation !== currentGeneration()) return false;
  route();
  return true;
}
