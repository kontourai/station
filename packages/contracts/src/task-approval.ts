import { CHAT_APP_IDS, type ChatAppId } from './chat-app.js';
import { boundaryText, enumValue } from './contract-validation.js';

/** Bounds are UTF-16 code units; max+1 refuses without truncation. */
export const TASK_APPROVAL_LIMITS = Object.freeze({ idChars: 256 });

export interface TaskApprovalDecision {
  readonly requestId: string;
  readonly sessionId: string;
  readonly decision: 'allow' | 'deny';
  readonly decider: { readonly principalId: string };
  readonly channel: 'station' | ChatAppId;
  readonly decidedAt: string;
}

export type TaskApprovalRefusalCode =
  | 'invalid-request'
  | 'not-found'
  | 'forbidden'
  | 'request-not-pending'
  | 'unavailable';

export type TaskApprovalOutcome =
  | { readonly kind: 'decided'; readonly decision: TaskApprovalDecision }
  /** Attribution for "Allowed by"; 2E resolves the principal's display name. */
  | { readonly kind: 'already-decided'; readonly winner: TaskApprovalDecision }
  | { readonly kind: 'refused'; readonly code: TaskApprovalRefusalCode };

/** Parse the closed outcome, including the winner's principal, channel and time. */
export function parseTaskApprovalOutcome(
  value: unknown,
): TaskApprovalOutcome | null {
  if (closed(value, ['kind', 'decision']) && value.kind === 'decided') {
    const decision = parseTaskApprovalDecision(value.decision);
    return decision ? { kind: 'decided', decision } : null;
  }
  if (closed(value, ['kind', 'winner']) && value.kind === 'already-decided') {
    const winner = parseTaskApprovalDecision(value.winner);
    return winner ? { kind: 'already-decided', winner } : null;
  }
  if (
    closed(value, ['kind', 'code']) &&
    value.kind === 'refused' &&
    (value.code === 'invalid-request' ||
      value.code === 'not-found' ||
      value.code === 'forbidden' ||
      value.code === 'request-not-pending' ||
      value.code === 'unavailable')
  )
    return { kind: 'refused', code: value.code };
  return null;
}

/** Structure only. The host supplies the decider/time and arbitrates the first winner. */
export function parseTaskApprovalDecision(
  value: unknown,
): TaskApprovalDecision | null {
  if (
    !closed(value, [
      'requestId',
      'sessionId',
      'decision',
      'decider',
      'channel',
      'decidedAt',
    ]) ||
    !id(value.requestId) ||
    !id(value.sessionId) ||
    (value.decision !== 'allow' && value.decision !== 'deny') ||
    !closed(value.decider, ['principalId']) ||
    !id(value.decider.principalId) ||
    (value.channel !== 'station' && !enumValue(value.channel, CHAT_APP_IDS)) ||
    typeof value.decidedAt !== 'string' ||
    value.decidedAt.length !== 24 ||
    !Number.isFinite(Date.parse(value.decidedAt)) ||
    new Date(value.decidedAt).toISOString() !== value.decidedAt
  )
    return null;
  return {
    requestId: value.requestId,
    sessionId: value.sessionId,
    decision: value.decision,
    decider: { principalId: value.decider.principalId },
    channel: value.channel,
    decidedAt: value.decidedAt,
  };
}

function id(value: unknown): value is string {
  return boundaryText(value, TASK_APPROVAL_LIMITS.idChars);
}

function closed(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const own = Reflect.ownKeys(value);
    return (
      own.length === keys.length &&
      own.every((key) => {
        if (typeof key !== 'string' || !keys.includes(key)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && 'value' in descriptor;
      })
    );
  } catch {
    return false;
  }
}
