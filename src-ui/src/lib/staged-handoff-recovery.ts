const RECOVERY_KEY = 'station.staged-handoff-recovery.v1';

function readPointers(): Map<string, string> {
  const value: unknown = JSON.parse(localStorage.getItem(RECOVERY_KEY) ?? '{}');
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Staged Agent recovery data is invalid.');
  return new Map(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

export const stagedHandoffRecovery = {
  read(binding: string): string | undefined {
    try {
      return readPointers().get(binding);
    } catch {
      return undefined;
    }
  },
  write(binding: string, idempotencyKey: string): void {
    const pointers = readPointers();
    const earlier = pointers.get(binding);
    if (earlier && earlier !== idempotencyKey)
      throw new Error(
        'Check the earlier Agent change before sending another one.',
      );
    pointers.set(binding, idempotencyKey);
    localStorage.setItem(
      RECOVERY_KEY,
      JSON.stringify(Object.fromEntries(pointers)),
    );
  },
  remove(binding: string, idempotencyKey: string): void {
    const pointers = readPointers();
    if (pointers.get(binding) !== idempotencyKey) return;
    pointers.delete(binding);
    if (pointers.size === 0) localStorage.removeItem(RECOVERY_KEY);
    else
      localStorage.setItem(
        RECOVERY_KEY,
        JSON.stringify(Object.fromEntries(pointers)),
      );
  },
};
