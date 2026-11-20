/**
 * Value guards the attached-session sources (`codex-rollout`, `grok`,
 * `opencode`) had each carried as an identical block at the end of the file.
 *
 * Only the helpers that were byte-identical in all three live here. The ones
 * that differ per source stay with it: the text and path bounds read each
 * source's own byte limits, and Grok additionally requires an absolute path.
 */
import { createHash } from 'node:crypto';
import { isRecord } from '../../utils/is-record.js';

/** A stable hex digest of `parts`, in order. */
export function digest(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** `value` when it is a string with something other than whitespace in it. */
export function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/** Whether `value` is an object literal rather than a class instance. */
export function isPlainRecord(value: Record<string, unknown>): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function boundedInteger(
  name: string,
  value: number,
  ceiling: number,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
    throw new RangeError(
      `${name} must be an integer from 1 through ${ceiling}.`,
    );
  }
  return value;
}
