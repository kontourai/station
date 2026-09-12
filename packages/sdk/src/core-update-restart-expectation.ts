import type { CoreUpdateRestartExpectation } from './query-domains/systemRuntime';

function isNonEmptyString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
      );
    })
  );
}

export function isCanonicalTimestamp(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function parseRestartExpectation(
  value: unknown,
): CoreUpdateRestartExpectation | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.expectedHash !== 'string' ||
    !/^[a-f0-9]{7}$/.test(record.expectedHash) ||
    !isNonEmptyString(record.expectedInstanceId) ||
    !isCanonicalTimestamp(record.deadlineAt)
  ) {
    return null;
  }
  return {
    expectedHash: record.expectedHash,
    expectedInstanceId: record.expectedInstanceId,
    deadlineAt: record.deadlineAt,
  };
}
