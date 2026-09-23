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
 * author. The agent and conversation are the tool call's report: when
 * Station's own runtime did not vouch for them (`reportedBy` is not
 * `runtime`), the line says the agent named itself, because for an external
 * engine that name is text its model wrote (#2323 S5 review M3).
 */
export function describeProposalAuthor(
  author: PluginLifecycleProposalAuthor | undefined,
): string {
  if (!author) return 'Proposed by an agent';
  if (author.principal === 'person') return 'Proposed from Station by a person';
  if (!author.agentSlug && !author.conversationId)
    return 'Proposed by an agent that did not say which';
  const agent = stripFormatCharacters(author.agentSlug ?? 'an agent');
  const where = author.conversationId
    ? ` in conversation ${stripFormatCharacters(author.conversationId)}`
    : '';
  return author.reportedBy === 'runtime'
    ? `Proposed by ${agent}${where}`
    : `Proposed by ${agent}${where} (self-reported by the agent)`;
}

/**
 * Removes invisible and direction-changing characters (Unicode Cf, plus the
 * line and paragraph separators) before text an agent wrote is shown. The
 * server refuses them in new proposals; this is the second line.
 */
export function stripFormatCharacters(text: string): string {
  return text.replace(/[\p{Cf}\u2028\u2029]/gu, '');
}

/** The agent's rationale, quoted and attributed so it never reads as Station's words (L1). */
export function quoteProposalRationale(rationale: string): string {
  return `The agent wrote: \u201c${stripFormatCharacters(rationale)}\u201d`;
}

export type ProposalSourceParts =
  | { kind: 'local'; path: string }
  | { kind: 'git'; host: string; path: string }
  | { kind: 'other'; text: string };

/**
 * A source split into what a person must read separately (#2323 S5 review
 * M2): the host a git source is fetched from, and the repository path on it.
 */
export function describeProposalSource(source: string): ProposalSourceParts {
  const clean = stripFormatCharacters(source);
  const https = /^https:\/\/([^/]+)\/(.+)$/.exec(clean);
  if (https) return { kind: 'git', host: https[1]!, path: https[2]! };
  const scp = /^git@([^:]+):(.+)$/.exec(clean);
  if (scp) return { kind: 'git', host: scp[1]!, path: scp[2]! };
  if (clean.startsWith('/') || /^[A-Za-z]:[\\/]/.test(clean))
    return { kind: 'local', path: clean };
  return { kind: 'other', text: clean };
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
