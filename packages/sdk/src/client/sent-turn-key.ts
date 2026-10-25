const turnKeys = new WeakMap<object, string>();

/** The key chosen for a rejected SDK send; this is not proof of delivery. */
export function sentTurnKey(error: unknown): string | undefined {
  return error !== null &&
    (typeof error === 'object' || typeof error === 'function')
    ? turnKeys.get(error)
    : undefined;
}

export function rememberSentTurnKey(error: unknown, key: string): void {
  if (
    error !== null &&
    (typeof error === 'object' || typeof error === 'function')
  )
    turnKeys.set(error, key);
}
