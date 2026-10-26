import { randomCorrelationId } from '@kontourai/station-shared/random-id';

const turnKeys = new WeakMap<object, string | null>();

function isObject(value: unknown): value is object {
  return (
    value !== null && (typeof value === 'object' || typeof value === 'function')
  );
}

/** The key chosen for a rejected SDK send; this is not proof of delivery. */
export function sentTurnKey(error: unknown): string | undefined {
  return isObject(error) ? (turnKeys.get(error) ?? undefined) : undefined;
}

export function hasRecordedTurnFailure(error: unknown): boolean {
  return isObject(error) && turnKeys.has(error);
}

export function rememberSentTurnKey(error: unknown, key: string): void {
  if (isObject(error)) {
    const previous = turnKeys.get(error);
    turnKeys.set(error, turnKeys.has(error) && previous !== key ? null : key);
  }
}

export function chooseSentTurnKey(supplied: unknown): string {
  if (
    supplied !== undefined &&
    (typeof supplied !== 'string' || !supplied.trim() || supplied.length > 200)
  )
    throw new TypeError(
      'clientTurnId must be a non-empty string of at most 200 characters',
    );
  return typeof supplied === 'string' ? supplied : randomCorrelationId();
}
