import type {
  TaskReviewArtifactRef,
  TaskReviewCurrentArtifact,
  TaskReviewEvent,
  TaskReviewItem,
  TaskReviewThreadView,
} from '@kontourai/station-contracts/task-review';

export const plan: TaskReviewArtifactRef = {
  kind: 'plan',
  id: 'plan',
  revision: 'v2',
  digest: 'sha256:plan-v2',
};
export const text =
  '# Approach\n\nRound each taxed line with **half-even rounding** before summing.\n\n## Test cases\n\n82.5 → 82 · 115.5 → 116 · -82.5 → -82\n\n## Verify\n\nReplay the October export.';
export const screenSrc =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="#f7f6f2"/><rect width="640" height="28" fill="#e6e5df"/><g fill="#202124" font-family="sans-serif" font-size="20"><text x="30" y="80">Invoice #1043</text><text x="30" y="140">Consulting × 3</text><text x="490" y="140">$412.50</text><text x="30" y="190">Tax 8.25%</text><text x="510" y="190">$34.03</text><text x="30" y="240">Hosting</text><text x="510" y="240">$89.00</text></g><path d="M30 158h580M30 208h580M30 258h580" stroke="#c9ccca"/><rect x="25" y="275" width="590" height="45" rx="4" fill="#d7f4e7"/><g font-family="sans-serif" font-size="20" font-weight="bold" fill="#202124"><text x="30" y="304">Total</text><text x="500" y="304">$535.53</text></g></svg>',
  );

export const currentArtifact = (
  artifact: TaskReviewArtifactRef,
): TaskReviewCurrentArtifact =>
  artifact.kind === 'capture'
    ? { status: 'available', kind: 'capture', revision: artifact.revision }
    : { status: 'available', kind: 'plan', revision: 'v3', text };

function events(
  threadId: string,
  kinds: readonly TaskReviewEvent['kind'][],
): TaskReviewEvent[] {
  return kinds.map((kind, index) => {
    const identity = {
      threadId,
      ordinal: index + 1,
      operationId: `${threadId}-${index}`,
      createdAt: '2026-10-25T00:00:00Z',
    };
    const person = { kind: 'person', principalId: 'person-brian' } as const;
    switch (kind) {
      case 'comment':
      case 'reply':
        return {
          ...identity,
          kind,
          author: person,
          body: index
            ? 'Please include the replay.'
            : 'Why half-even rounding?',
        };
      case 'agent-reply':
        return {
          ...identity,
          kind,
          author: { kind: 'session', sessionId: 'lead' },
          body: 'Keeps every exact tie, drops float error. Added a property test.',
          evidence: {
            commit: '7c04e1d0000000000000000000000000000000000',
            commitVerified: true,
            gateVerified: false,
            gateRefs: [
              {
                runId: 'replay',
                gateId: 'October replay',
                evaluationId: 'eval-1',
              },
            ],
            captureId: 'screen-1',
          },
        };
      case 'sent':
        return {
          ...identity,
          kind,
          author: person,
          deliveryKey: 'tr-delivery',
        };
      case 'resolved':
      case 'send-failed':
        return {
          ...identity,
          kind,
          author: person,
          reason: kind === 'resolved' ? 'Accepted' : 'Delivery failed',
        };
      case 'reopened':
        return { ...identity, kind, author: person };
    }
  });
}

export function thread(
  id: string,
  ordinal: number,
  kinds: readonly TaskReviewEvent['kind'][] = ['comment'],
): TaskReviewThreadView {
  const last = kinds.at(-1);
  const state =
    last === 'resolved'
      ? 'resolved'
      : last === 'sent'
        ? 'sent'
        : last === 'agent-reply'
          ? 'agent-replied'
          : 'open';
  return {
    threadId: id,
    ordinal,
    taskId: 'task-1',
    taskCreatedAt: '2026-10-25T00:00:00Z',
    projectId: 'project-1',
    artifact: plan,
    anchor: {
      kind: 'text-quote',
      start: 41,
      end: 59,
      exact: 'half-even rounding',
      prefix: '',
      suffix: '',
    },
    quote: 'half-even rounding',
    author: { kind: 'person', principalId: 'person-brian' },
    operationId: `${id}-create`,
    createdAt: '2026-10-25T00:00:00Z',
    events: events(id, kinds),
    baseState: state,
    state,
    outdated: false,
    currentRevision: 'v3',
  };
}

export const threads: readonly TaskReviewThreadView[] = [
  thread('open-1', 1),
  thread('open-2', 2),
  {
    ...thread('old', 3),
    quote: 'Round the final total',
    anchor: {
      kind: 'text-quote',
      start: 0,
      end: 21,
      exact: 'Round the final total',
      prefix: '',
      suffix: '',
    },
    state: 'outdated',
    outdated: true,
  },
  thread('sent', 4, ['comment', 'sent']),
  thread('replied', 5, ['comment', 'sent', 'agent-reply']),
  thread('resolved', 6, ['comment', 'resolved']),
];

export const items: readonly TaskReviewItem[] = [
  {
    kind: 'plan',
    id: 'plan',
    label: 'plan.md',
    counts: { open: 4, outdated: 1, resolved: 1 },
    status: 'available',
    artifact: plan,
    text,
  },
  {
    kind: 'summary',
    id: 'summary',
    label: 'Task summary',
    counts: { open: 0, outdated: 0, resolved: 0 },
    status: 'available',
    artifact: {
      kind: 'summary',
      id: 'summary',
      revision: '2',
      digest: 'sha256:summary',
    },
    text: 'Fix rounding drift.',
  },
  {
    kind: 'capture',
    id: 'screen-1',
    label: 'October replay',
    counts: { open: 1, outdated: 0, resolved: 0 },
    status: 'available',
    artifact: {
      kind: 'capture',
      id: 'screen-1',
      revision: 'sha256:screen',
      digest: 'sha256:screen',
    },
  },
];

export const captureThread: TaskReviewThreadView = {
  ...thread('capture-thread', 7),
  artifact: {
    kind: 'capture',
    id: 'screen-1',
    revision: 'sha256:screen',
    digest: 'sha256:screen',
  },
  anchor: { kind: 'region', x: 0.96, y: 0.96, w: 0.04, h: 0.04 },
  quote: undefined,
  currentRevision: 'sha256:screen',
};
