/**
 * Presentation of a plugin lifecycle proposal (#2323 S5): who asked, and
 * whether the bytes still match what they asked about.
 *
 * Both derivations read the proposal's own recorded fields; nothing here
 * decides anything. The person's decision is still the ordinary preview and
 * consent.
 */
import type {
  PluginLifecycleProposal,
  PluginLifecycleProposalAuthor,
} from '@kontourai/station-contracts/plugin';

/**
 * "Proposed by <agent> in <conversation>", from the proposal's recorded
 * author. The agent and conversation are the tool call's report, so a
 * proposal without them says so rather than naming nobody as if that were a
 * fact about the author.
 */
export function describeProposalAuthor(
  author: PluginLifecycleProposalAuthor | undefined,
): string {
  if (!author) return 'Proposed by an agent';
  if (author.principal === 'person') return 'Proposed from Station by a person';
  const agent = author.agentSlug ?? 'an agent';
  return author.conversationId
    ? `Proposed by ${agent} in conversation ${author.conversationId}`
    : author.agentSlug
      ? `Proposed by ${agent}`
      : 'Proposed by an agent that did not say which';
}

export type ProposalDigestComparison =
  | 'unchanged'
  | 'changed'
  /** Nothing recorded at proposal time (a git source, or an unreadable tree). */
  | 'not-recorded'
  /** The preview produced no digest to compare. */
  | 'not-previewed';

/**
 * Compares the digest recorded when the agent proposed against the one the
 * preview derived from the bytes it just staged: the same tree encoding on
 * both sides (`station-plugin-tree/v2`).
 */
export function compareProposalDigest(
  proposal: Pick<PluginLifecycleProposal, 'proposedContentDigest'>,
  previewDigest: string | undefined,
): ProposalDigestComparison {
  if (!proposal.proposedContentDigest) return 'not-recorded';
  if (!previewDigest) return 'not-previewed';
  return proposal.proposedContentDigest === previewDigest
    ? 'unchanged'
    : 'changed';
}

/** Whether an install of `source` is the one `proposal` asked for. */
export function installMatchesProposal(
  proposal: Pick<PluginLifecycleProposal, 'kind' | 'source'> | null,
  source: string,
): boolean {
  return (
    !!proposal &&
    proposal.kind === 'install' &&
    !!proposal.source &&
    proposal.source === source.trim()
  );
}
