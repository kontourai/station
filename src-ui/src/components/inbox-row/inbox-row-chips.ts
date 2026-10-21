import {
  type WorkClaimView,
  workClaimSubjectDetail,
  workClaimSubjectLabel,
} from '@kontourai/station-contracts/work-claims';
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
export type InboxRowChipKind = 'remote' | 'draft' | 'woke' | 'claim';

export interface InboxRowChip {
  kind: InboxRowChipKind;
  label: string;
  /** The full text on hover, when the label is short for it. */
  title?: string;
}

/**
 * #3413 part B: what the Session says it is on, from its active claims (the
 * server answers only unreleased, unexpired claims of a Session that has not
 * ended). One chip: the newest claim's subject, and how many more.
 */
function claimChip(claims: readonly WorkClaimView[]): InboxRowChip | undefined {
  const labelled = claims.filter((claim) => workClaimSubjectLabel(claim));
  const [newest, ...rest] = labelled;
  if (!newest) return undefined;
  const label = `On ${workClaimSubjectLabel(newest)}${rest.length > 0 ? ` +${rest.length}` : ''}`;
  const title = labelled
    .map((claim) => {
      const until = new Date(claim.expiresAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
      return `Claimed: ${workClaimSubjectDetail(claim)}${claim.note ? ` — ${claim.note}` : ''} (until ${until})`;
    })
    .join('\n');
  return { kind: 'claim', label, title };
}

export function inboxRowChips(
  item: Pick<HomeWorkItem, 'environmentLabel'>,
  local: {
    hasUnsentDraft?: boolean;
    isWoken?: boolean;
    claims?: readonly WorkClaimView[];
  } = {},
): InboxRowChip[] {
  const chips: InboxRowChip[] = [];
  const claim = local.claims ? claimChip(local.claims) : undefined;
  if (claim) chips.push(claim);
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
