import { isWellFormedUnicode } from './task-graph.js';

/** Internal boundary primitives shared by the chat and status contracts. */
export function closedRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(value).every(
      (key) => typeof key === 'string' && keys.includes(key),
    )
  );
}

export function boundedText(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    value.trim() === value &&
    Array.from(value).every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    }) &&
    isWellFormedUnicode(value)
  );
}

/** Canonical UTC timestamps, with millisecond precision. */
export function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

export function enumValue<T extends string>(
  value: unknown,
  choices: readonly T[],
): value is T {
  return (
    typeof value === 'string' && choices.some((choice) => choice === value)
  );
}
