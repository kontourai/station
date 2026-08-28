import { flowRunDisplayIdentity } from '@kontourai/station-contracts';
import { telemetry } from '@kontourai/station-sdk';
import type {
  ChatMessage,
  FlowGateVerdictInfo,
  FlowRunBinding,
} from '../../contexts/active-chats-state';
import { activeChatsStore } from '../../contexts/active-chats-store';
import type { OrchestrationEvent } from './types';

function appendFlowMessage(threadId: string, message: ChatMessage) {
  const chat = activeChatsStore.getChatForExecutionSession(threadId);
  if (!chat) return;
  activeChatsStore.updateChat(threadId, {
    messages: [...(chat.messages || []), message],
  });
}

function flowEventMessageMetadata(event: OrchestrationEvent) {
  const parsedTimestamp = Date.parse(event.createdAt);
  const eventSpecificIdentity =
    event.method === 'flow.gate-verdict'
      ? `${event.runId}:${event.gateId ?? event.verdict}`
      : event.method === 'flow.run-attached'
        ? `${event.runId}:${event.definitionId}`
        : event.method;
  return {
    id:
      event.eventId ??
      `${event.method}:${event.threadId}:${event.createdAt}:${eventSpecificIdentity}`,
    ...(Number.isNaN(parsedTimestamp) ? {} : { timestamp: parsedTimestamp }),
  };
}

function buildFlowGateVerdictSummary(info: FlowGateVerdictInfo) {
  switch (info.verdict) {
    case 'pass':
      return info.summary || 'Flow gates passed.';
    case 'route-back':
      return (
        info.nextAction ||
        info.summary ||
        `Gate routed work back${info.routeBackTo ? ` to ${info.routeBackTo}` : ''}.`
      );
    case 'block':
      return info.summary || 'Flow gate blocked completion.';
    case 'wait':
      return info.summary || 'Flow gate is waiting on expectations.';
  }
}

export function handleFlowRunAttachedEvent(
  event: Extract<OrchestrationEvent, { method: 'flow.run-attached' }>,
) {
  const binding: FlowRunBinding = {
    runId: event.runId,
    definitionId: event.definitionId,
    cwd: event.cwd,
    resumed: event.resumed,
    currentStep: event.currentStep,
    freshness: event.freshness,
  };
  activeChatsStore.updateChat(event.threadId, { flowRun: binding });
  telemetry.track('ui.flow_gate.run_attached', {
    resumed: String(event.resumed),
  });
  appendFlowMessage(event.threadId, {
    ...flowEventMessageMetadata(event),
    role: 'system',
    content: `Flow run ${event.resumed ? 're-attached' : 'attached'}: ${flowRunDisplayIdentity(event.definitionId, event.runId)}`,
    contentParts: [{ type: 'flow-run-attached', flowRunAttached: binding }],
  });
}

/**
 * Refresh the run's persisted freshness from a gate verdict (archive#189).
 *
 * Without this the chip keeps rendering the attach-time snapshot for the life
 * of the session — and across reloads, since the binding is persisted — so a
 * run that HAS been evaluated goes on reading "never evaluated".
 *
 * The verdict's `freshness` is REPLACED wholesale, never merged or derived
 * here. Inferring it client-side got all three of these wrong: one completion
 * request can settle several gates but emits a single verdict naming only the
 * last, Flow replaces a gate's outcome per gate id rather than appending, and
 * a `wait` advances no transition so the server correctly reports no
 * timestamp for it. The server holds the run; it is the only place that can
 * answer, and a second answer here is just a second truth.
 *
 * A verdict for a DIFFERENT run says nothing about this binding, so it is
 * ignored entirely (null). A verdict for THIS run that carries no freshness —
 * an older server, or one whose post-evaluation read failed — is a different
 * case: an evaluation demonstrably happened, so whatever the binding still
 * holds is a claim about the run as it was BEFORE it. Clearing the field
 * degrades the chip to its explicit unknown state, which is the honest answer;
 * keeping it would leave a stale "never evaluated" standing after a real
 * evaluation.
 */
function foldVerdictIntoBinding(
  binding: FlowRunBinding,
  event: Extract<OrchestrationEvent, { method: 'flow.gate-verdict' }>,
): FlowRunBinding | null {
  if (binding.runId !== event.runId) return null;
  if (!event.freshness) return { ...binding, freshness: undefined };
  return {
    ...binding,
    currentStep: event.currentStep ?? binding.currentStep,
    freshness: event.freshness,
  };
}

export function handleFlowGateVerdictEvent(
  event: Extract<OrchestrationEvent, { method: 'flow.gate-verdict' }>,
) {
  const bound = activeChatsStore.getChatForExecutionSession(
    event.threadId,
  )?.flowRun;
  if (bound) {
    const folded = foldVerdictIntoBinding(bound, event);
    if (folded)
      activeChatsStore.updateChat(event.threadId, { flowRun: folded });
  }
  const info: FlowGateVerdictInfo = {
    runId: event.runId,
    verdict: event.verdict,
    gateId: event.gateId,
    summary: event.summary,
    nextAction: event.nextAction,
    routeBackTo: event.routeBackTo,
    attempt: event.attempt,
    maxAttempts: event.maxAttempts,
    missing: event.missing,
    reportPaths: event.reportPaths,
    exceptionRequired: event.exceptionRequired,
  };
  telemetry.track('ui.flow_gate.verdict', { verdict: event.verdict });
  appendFlowMessage(event.threadId, {
    ...flowEventMessageMetadata(event),
    role: 'system',
    content: buildFlowGateVerdictSummary(info),
    contentParts: [{ type: 'flow-gate-verdict', flowGateVerdict: info }],
  });
}
