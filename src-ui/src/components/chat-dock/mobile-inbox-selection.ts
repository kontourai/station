import type { HomeWorkItem } from '../../views/home/home-view-model';
import type { WorkFacts } from '../../views/home/work-facts';

export function inboxResolutionId(
  item: HomeWorkItem,
  facts: WorkFacts | undefined,
  supported: boolean,
) {
  return supported &&
    facts?.hostDetails !== false &&
    !item.environmentId &&
    item.kind !== 'remote-session' &&
    item.controlMode !== 'read-only-attached' &&
    !['Running', 'Needs attention', 'Draft'].includes(item.lifecycleLabel)
    ? item.conversationId
    : undefined;
}
