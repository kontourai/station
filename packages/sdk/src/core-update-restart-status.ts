import { authenticatedFetch } from './client/http';
import type {
  CoreUpdateRestartExpectation,
  CoreUpdateRestartStatus,
} from './query-domains/systemRuntime';

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

function isCanonicalTimestamp(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function parseRestartExpectation(
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

function hasExactFields(
  value: Record<string, unknown>,
  fields: string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return (
    actual.length === expected.length &&
    actual.every((field, index) => field === expected[index])
  );
}

function parseCoreUpdateRestartStatus(value: unknown): CoreUpdateRestartStatus {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Core update restart status is unavailable');
  }
  const record = value as Record<string, unknown>;
  if (record.status === 'unavailable') {
    if (!hasExactFields(record, ['status'])) {
      throw new Error('Core update restart status is unavailable');
    }
    return { status: 'unavailable' };
  }
  if (
    record.status !== 'pending' &&
    record.status !== 'verified' &&
    record.status !== 'failed'
  ) {
    throw new Error('Core update restart status is unavailable');
  }
  const expectation = parseRestartExpectation(record);
  if (!expectation) {
    throw new Error('Core update restart status is unavailable');
  }
  const resolvedAt = record.resolvedAt;
  if (record.status === 'pending') {
    if (
      resolvedAt !== undefined ||
      !hasExactFields(record, [
        'status',
        'expectedHash',
        'expectedInstanceId',
        'deadlineAt',
      ])
    ) {
      throw new Error('Core update restart status is unavailable');
    }
    return { ...expectation, status: 'pending' };
  }
  if (
    !isCanonicalTimestamp(resolvedAt) ||
    !hasExactFields(record, [
      'status',
      'expectedHash',
      'expectedInstanceId',
      'deadlineAt',
      'resolvedAt',
    ])
  ) {
    throw new Error('Core update restart status is unavailable');
  }
  return { ...expectation, status: record.status, resolvedAt };
}

/** Read the detached watchdog's durable, correlated restart outcome. */
export async function requestCoreUpdateRestartStatus(
  apiBase: string,
  signal: AbortSignal,
): Promise<CoreUpdateRestartStatus> {
  const response = await authenticatedFetch(
    `${apiBase}/api/system/core-update/restart-status`,
    { signal },
  );
  if (!response.ok) {
    throw new Error('Core update restart status is unavailable');
  }
  return parseCoreUpdateRestartStatus(await response.json());
}
