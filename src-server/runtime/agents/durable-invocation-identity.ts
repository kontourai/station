import type { AuthorizedTurnCorrelation } from '../conversation/authorized-turn-correlation.js';
export interface DurableNativeStart {
  eventId: string;
  provider: 'station-agent';
  threadId: string;
  turnId: string;
  invocationId: string;
  createdAt: string;
  method: 'turn.started';
  prompt?: string;
  metadata?: Record<string, unknown>;
}

const pending = new Map<
  string,
  { invocationId: string; startEvent: DurableNativeStart; expiresAt: number }
>();
const keyOf = (value: AuthorizedTurnCorrelation) =>
  JSON.stringify([
    value.accountId,
    value.sessionId,
    value.turnId,
    value.correlationId,
  ]);
/** Carries an existing kernel identity; it never creates or rewrites a key. */
export function retainDurableInvocationIdentity(
  correlation: AuthorizedTurnCorrelation,
  invocationId: string,
  startEvent: DurableNativeStart,
): void {
  const now = Date.now();
  for (const [key, entry] of pending)
    if (entry.expiresAt <= now) pending.delete(key);
  const key = keyOf(correlation);
  const existing = pending.get(key);
  if (existing && existing.invocationId !== invocationId)
    throw new Error('The native invocation identity changed.');
  if (!existing && pending.size >= 1024)
    throw new Error('Native invocation handoff capacity is exhausted.');
  if (
    startEvent.threadId !== correlation.sessionId ||
    startEvent.turnId !== correlation.turnId ||
    startEvent.invocationId !== invocationId
  )
    throw new Error('The native start does not match its invocation.');
  pending.set(key, {
    invocationId,
    startEvent: structuredClone(startEvent),
    expiresAt: now + 60_000,
  });
}
export function captureDurableInvocationIdentity(
  correlation: AuthorizedTurnCorrelation,
): { invocationId: string; startEvent: DurableNativeStart } {
  const key = keyOf(correlation);
  const entry = pending.get(key);
  pending.delete(key);
  if (!entry || entry.expiresAt <= Date.now())
    throw new Error('This turn has no retained kernel invocation identity.');
  return { invocationId: entry.invocationId, startEvent: entry.startEvent };
}
export function forgetDurableInvocationIdentity(
  correlation: AuthorizedTurnCorrelation,
): void {
  pending.delete(keyOf(correlation));
}
