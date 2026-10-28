import {
  type EngineId,
  parseEngineId,
} from '@kontourai/station-contracts/agent-identity';
import type { ConversationListItem } from '@kontourai/station-contracts/orchestration';
import { isSessionLifecycleStateAtRest } from '@kontourai/station-contracts/session-lifecycle';
import { type HomeWorkItem, isTerminalLifecycle } from './home-view-model';

function epochMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Layers the conversation inventory's per-conversation facts onto work items:
 * the rendered version (`conversationUpdatedAt`), the person's last view
 * (`acknowledgedAt`), the recorded finish time (`terminalAt`) and the engines
 * the conversation ran on (`executionProviders`).
 *
 * The ONE mapping for every surface that reads the inventory — the chat dock
 * inbox and Home used to carry two copies of it. These facts are
 * presentation (which lane a finished row sits in, which marks it draws); no
 * status word reads them.
 */
export function withConversationInventory<T extends HomeWorkItem>(
  items: readonly T[],
  inventoryById: ReadonlyMap<string, ConversationListItem>,
): T[] {
  return items.map((item) => {
    const conversation = inventoryById.get(item.id);
    if (!conversation) return item;
    const acknowledgedAt = epochMs(conversation.acknowledgedAt);
    // The inventory's change time is a finish time only when the inventory
    // itself read the conversation at rest. It is re-read on a throttle, so
    // a copy read while the work ran holds its START time, and a cached copy
    // read at rest can hold an EARLIER finish (the turn before this one);
    // the later of it and the live row's own finish time stands.
    const inventoryTerminalAt =
      isTerminalLifecycle(item.lifecycleLabel) &&
      conversation.lifecycleState !== undefined &&
      isSessionLifecycleStateAtRest(conversation.lifecycleState)
        ? epochMs(conversation.lifecycleChangedAt)
        : undefined;
    const terminalAt =
      inventoryTerminalAt !== undefined && item.terminalAt !== undefined
        ? Math.max(inventoryTerminalAt, item.terminalAt)
        : (inventoryTerminalAt ?? item.terminalAt);
    const executionProviders = (conversation.executionProviders ?? [])
      .map((provider) => parseEngineId(provider))
      .filter((provider): provider is EngineId => provider !== undefined);
    return {
      ...item,
      conversationUpdatedAt: conversation.updatedAt,
      ...(acknowledgedAt !== undefined ? { acknowledgedAt } : {}),
      ...(terminalAt !== undefined ? { terminalAt } : {}),
      ...(executionProviders.length > 0 ? { executionProviders } : {}),
    };
  });
}
