import type { HomeWorkItem } from '../../views/home/home-view-model';

/**
 * The inbox row's compact chip line (#3043). A chip exists only when its
 * fact does: this returns nothing for a row with none, and the row then
 * renders no chip line at all.
 *
 * NOT HERE, because no row-level fact backs them:
 * - the branch: `ProviderSession` declares `workspaceIsolation`, but the
 *   summary the server builds (`buildOrchestrationSessionSummary`) never
 *   carries it, so a branch is only ever a git read;
 * - a diff stat: no read Station exposes carries insertions/deletions (git
 *   status reports file counts only);
 * - a pull request and its checks: links are a per-conversation read the
 *   hover card makes on demand, and the link observation carries no checks
 *   state.
 */
export type InboxRowChipKind = 'remote' | 'draft' | 'woke' | 'agent-message';

export interface InboxRowChip {
  kind: InboxRowChipKind;
  label: string;
}

export function inboxRowChips(
  item: Pick<HomeWorkItem, 'environmentLabel' | 'receivedAgentMessage'>,
  local: { hasUnsentDraft?: boolean; isWoken?: boolean } = {},
): InboxRowChip[] {
  const chips: InboxRowChip[] = [];
  if (item.receivedAgentMessage)
    chips.push({ kind: 'agent-message', label: 'Agent message' });
  if (item.environmentLabel) {
    chips.push({ kind: 'remote', label: item.environmentLabel });
  }
  if (local.hasUnsentDraft) {
    chips.push({ kind: 'draft', label: 'Unsent draft' });
  }
  if (local.isWoken) {
    chips.push({ kind: 'woke', label: 'Woke from snooze' });
  }
  return chips;
}
