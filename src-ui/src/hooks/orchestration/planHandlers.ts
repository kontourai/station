import { runtimeEventContentDisplayText } from '@kontourai/station-contracts/runtime-event-content';
import { activeChatsStore } from '../../contexts/active-chats-store';
import type { PlanArtifact } from '../../utils/planArtifacts';
import type { OrchestrationEvent } from './types';

/**
 * Feeds the canonical `plan.updated` event (ADR-0008) directly into the
 * existing typed plan-artifact pipeline (`ChatUIState.planArtifact` ->
 * `WorkflowPlanPanel`, rendered by the Workspace Plan pane). Each event is a
 * full replace of the plan's entries (never a delta),
 * so writing `planArtifact` unconditionally here is correct for live
 * updates — no merge/diff logic needed. Source `'canonical'` distinguishes
 * this typed, event-sourced artifact from the pre-existing heuristic
 * `'assistant'`/`'reasoning'` parsers in `utils/planArtifacts.ts`, whose
 * fallback-to-previous-value behavior (`derivePlanArtifactFromStreamingState`)
 * is what keeps a later `content.text-delta`/`content.reasoning-delta` event
 * from clobbering the typed artifact with plain prose.
 */
export function handlePlanUpdatedEvent(
  event: Extract<OrchestrationEvent, { method: 'plan.updated' }>,
) {
  const chat = activeChatsStore.getChatForExecutionSession(event.threadId);
  if (!chat) return;

  // A plan too large for one event arrives as a reference to its entries
  // (docs/design/event-content-spill.md): show its preview, marked partial,
  // rather than steps it does not carry.
  const entries = Array.isArray(event.entries) ? event.entries : undefined;
  const planArtifact: PlanArtifact = {
    source: 'canonical',
    rawText: entries
      ? entries.map((entry) => entry.content).join('\n')
      : (runtimeEventContentDisplayText(event.entries) ?? ''),
    steps: (entries ?? []).map((entry) => ({
      content: entry.content,
      status: entry.status,
    })),
    updatedAt: event.createdAt,
  };

  activeChatsStore.updateChat(event.threadId, { planArtifact });
}
