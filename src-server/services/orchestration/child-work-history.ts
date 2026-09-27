import {
  applyChildWorkDelta,
  type ChildWorkDelta,
  childWorkDeltaFromLegacyClaudeTaskNotification,
  childWorkForReporter,
  createEmptyChildWorkRegistry,
  forgetChildWorkReporter,
} from '@kontourai/station-contracts/child-work';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';

/** Replay durable facts into terminal outcomes without resurrecting old work. */
export function settledChildWorkFromHistory(
  threadId: string,
  events: readonly CanonicalRuntimeEvent[],
): {
  settlements: Array<Extract<ChildWorkDelta, { kind: 'settle' }>>;
  lastReportAt?: string;
} {
  let historical = createEmptyChildWorkRegistry();
  let lastReportAt: string | undefined;
  let exited = false;
  for (const event of events) {
    if (event.method === 'session.exited') {
      historical = forgetChildWorkReporter(historical, threadId);
      lastReportAt = undefined;
      exited = true;
      continue;
    }
    if (event.method === 'session.started') {
      exited = false;
      continue;
    }
    if (exited) continue;
    const delta =
      event.method === 'child-work.updated'
        ? event.delta
        : event.method === 'extension.notification'
          ? childWorkDeltaFromLegacyClaudeTaskNotification(event, threadId)
          : undefined;
    if (!delta) continue;
    const reporter =
      delta.kind === 'upsert'
        ? delta.item.reporterThreadId
        : delta.reporterThreadId;
    if (reporter !== threadId) continue;
    historical = applyChildWorkDelta(historical, delta);
    lastReportAt = event.createdAt;
  }
  const settlements: Array<Extract<ChildWorkDelta, { kind: 'settle' }>> = [];
  for (const item of childWorkForReporter(historical, threadId)) {
    const {
      producer,
      reporterThreadId,
      childId,
      status,
      result,
      usage,
      ...identity
    } = item;
    if (status === 'running') continue;
    settlements.push({
      kind: 'settle',
      producer,
      reporterThreadId,
      childId,
      status,
      ...(result ? { result } : {}),
      ...(usage ? { usage } : {}),
      identity,
    });
  }
  return { settlements, ...(lastReportAt ? { lastReportAt } : {}) };
}
