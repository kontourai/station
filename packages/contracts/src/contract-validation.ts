import { isWellFormedUnicode } from './task-graph.js';

/** Internal parser primitives; no public package subpath. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function onlyKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Reflect.ownKeys(record).every(
    (key) => typeof key === 'string' && keys.includes(key),
  );
}

export function boundedText(
  value: unknown,
  max: number,
  min = 1,
): value is string {
  return (
    typeof value === 'string' &&
    value.length >= min &&
    value.length <= max &&
    isWellFormedUnicode(value) &&
    !/[\u0080-\u009f]/u.test(value)
  );
}

export function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function closedRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return isRecord(value) && onlyKeys(value, keys);
}

/** Single-line boundary identifiers and diagnostics, without invisible controls. */
export function boundaryText(value: unknown, max: number): value is string {
  return (
    boundedText(value, max) &&
    value.trim() === value &&
    !/(?:\p{Cc}|\p{Cf}|\u034f)/u.test(value)
  );
}

export function enumValue<T extends string>(
  value: unknown,
  choices: readonly T[],
): value is T {
  return (
    typeof value === 'string' && choices.some((choice) => choice === value)
  );
}

export function sha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
