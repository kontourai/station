import './pull-request-chips.css';

export type PullRequestChipTone = 'success' | 'failure' | 'pending' | 'neutral';

export interface PullRequestChipValue {
  label: string;
  tone: PullRequestChipTone;
}

/**
 * The pull request's state as a word people use, from the forge's enum
 * (GitHub `OPEN`/`CLOSED`/`MERGED`, GitLab `opened`/`closed`/`merged`/
 * `locked`). An enum this pane does not know is written as a word too, never
 * raw.
 */
export function pullRequestStateChip(state: string): PullRequestChipValue {
  const key = state.trim().toUpperCase();
  if (key === 'OPEN' || key === 'OPENED')
    return { label: 'Open', tone: 'success' };
  if (key === 'DRAFT') return { label: 'Draft', tone: 'neutral' };
  if (key === 'MERGED') return { label: 'Merged', tone: 'neutral' };
  if (key === 'CLOSED') return { label: 'Closed', tone: 'failure' };
  return { label: humanise(state), tone: 'neutral' };
}

/**
 * The review decision as a chip, or none when the forge reports no review
 * yet. GitHub reports the latest review's state; GitLab's `reviewStatus` is
 * its detailed merge status, read the same way.
 */
export function reviewDecisionChip(
  status: string,
): PullRequestChipValue | null {
  const key = status.trim().toUpperCase();
  // GitLab's `mergeable`/`checking`/`unchecked` say nothing about review;
  // the mergeability sentence already covers them.
  if (
    !key ||
    key === 'NONE' ||
    key === 'MERGEABLE' ||
    key === 'CHECKING' ||
    key === 'UNCHECKED'
  )
    return null;
  if (key === 'APPROVED') return { label: 'Approved', tone: 'success' };
  if (key === 'CHANGES_REQUESTED' || key === 'REQUESTED_CHANGES')
    return { label: 'Changes requested', tone: 'failure' };
  if (key === 'REVIEW_REQUIRED' || key === 'NOT_APPROVED')
    return { label: 'Review required', tone: 'pending' };
  // GitHub `PENDING` is the viewer's own review, not yet submitted.
  if (key === 'PENDING') return { label: 'Review pending', tone: 'neutral' };
  if (key === 'COMMENTED') return { label: 'Commented', tone: 'neutral' };
  if (key === 'DISMISSED')
    return { label: 'Review dismissed', tone: 'neutral' };
  return { label: humanise(status), tone: 'neutral' };
}

const ACRONYMS = new Set(['ci', 'api', 'url', 'id']);
/** `ci_must_pass` → "CI must pass": words, the first capitalised, acronyms kept. */
export function humanise(value: string): string {
  const words = value
    .trim()
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase())
    .map((word) => (ACRONYMS.has(word) ? word.toUpperCase() : word));
  const [first = '', ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' ');
}

/**
 * One toned chip: an opaque `--bg-tertiary` fill so the ratio is set by the
 * token pair alone, and a toned word (never colour alone) on it. Shared by
 * the pull request list rows and the review head.
 */
export function PullRequestChip({ label, tone }: PullRequestChipValue) {
  return (
    <span className="pull-request-chip" data-tone={tone}>
      {label}
    </span>
  );
}
