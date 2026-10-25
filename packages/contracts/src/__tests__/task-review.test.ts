import { describe, expect, test, vi } from 'vitest';
import * as review from '../task-review.js';
import {
  deriveOutdated,
  deriveThreadState,
  parseTaskReviewAnchor,
  relocateTextQuote,
  type TaskReviewAnchor,
  type TaskReviewArtifactKind,
  type TaskReviewEvent,
  type TaskReviewThread,
} from '../task-review.js';
import * as matcher from '../task-review-matcher.js';

const quote: Extract<TaskReviewAnchor, { kind: 'text-quote' }> = {
  kind: 'text-quote',
  start: 4,
  end: 9,
  exact: 'quote',
  prefix: 'the ',
  suffix: ' ends',
};

describe('parseTaskReviewAnchor', () => {
  test('accepts each closed anchor shape and the full image rectangle', () => {
    for (const anchor of [
      quote,
      { kind: 'block', startLine: 1, endLine: 3 },
      { kind: 'region', x: 0, y: 0, w: 1, h: 1 },
      { kind: 'whole' },
    ])
      expect(parseTaskReviewAnchor(anchor)).toEqual(anchor);
  });

  test('refuses extra keys on every variant, rather than silently dropping them', () => {
    for (const anchor of [
      quote,
      { kind: 'block', startLine: 1, endLine: 3 },
      { kind: 'region', x: 0, y: 0, w: 1, h: 1 },
      { kind: 'whole' },
    ]) {
      expect(parseTaskReviewAnchor({ ...anchor, extra: true })).toBeNull();
      expect(
        parseTaskReviewAnchor({ ...anchor, [Symbol('extra')]: true }),
      ).toBeNull();
    }
  });

  test('refuses non-objects, unknown kinds, missing fields and wrong types', () => {
    for (const invalid of [
      null,
      undefined,
      [],
      'whole',
      { kind: 'diff' },
      { kind: 'text-quote', start: 4, end: 9, exact: 'quote' },
      { ...quote, start: '4' },
      { ...quote, prefix: null },
      { kind: 'block', startLine: 1 },
      { kind: 'region', x: 0, y: 0, w: 1 },
    ])
      expect(parseTaskReviewAnchor(invalid)).toBeNull();
  });

  test('accepts the 2000-character quote limit and refuses max+1 without truncating', () => {
    const atLimit = {
      ...quote,
      start: 0,
      end: 2000,
      exact: 'q'.repeat(2000),
      prefix: '',
      suffix: '',
    };
    expect(parseTaskReviewAnchor(atLimit)).toEqual(atLimit);
    expect(
      parseTaskReviewAnchor({ ...atLimit, end: 2001, exact: 'q'.repeat(2001) }),
    ).toBeNull();
  });

  test('accepts exactly 4096 serialized characters and refuses 4097, including JSON escaping', () => {
    const base = { ...quote, prefix: '', suffix: '' };
    const atLimit = {
      ...base,
      prefix: 'p'.repeat(4096 - JSON.stringify(base).length),
    };
    expect(JSON.stringify(atLimit)).toHaveLength(4096);
    expect(parseTaskReviewAnchor(atLimit)).toEqual(atLimit);
    expect(
      parseTaskReviewAnchor({ ...atLimit, prefix: `${atLimit.prefix}p` }),
    ).toBeNull();
    expect(
      parseTaskReviewAnchor({
        ...atLimit,
        prefix: `${atLimit.prefix.slice(1)}\n`,
      }),
    ).toBeNull();
  });

  test('uses safe half-open UTF-16 offsets and one-based inclusive block lines', () => {
    expect(
      parseTaskReviewAnchor({ ...quote, start: 0, end: 2, exact: '🧭' }),
    ).toEqual({
      ...quote,
      start: 0,
      end: 2,
      exact: '🧭',
    });
    expect(
      parseTaskReviewAnchor({
        ...quote,
        start: Number.MAX_SAFE_INTEGER - 5,
        end: Number.MAX_SAFE_INTEGER,
      }),
    ).not.toBeNull();
    expect(
      parseTaskReviewAnchor({
        kind: 'block',
        startLine: 1,
        endLine: Number.MAX_SAFE_INTEGER,
      }),
    ).not.toBeNull();
    for (const invalid of [
      { ...quote, start: -1 },
      { ...quote, start: 0.5 },
      { ...quote, end: 8 },
      { ...quote, end: 4 },
      { ...quote, exact: '', end: 4 },
      { ...quote, end: Infinity },
      {
        ...quote,
        start: Number.MAX_SAFE_INTEGER - 4,
        end: Number.MAX_SAFE_INTEGER + 1,
      },
      { kind: 'block', startLine: 0, endLine: 1 },
      { kind: 'block', startLine: 3, endLine: 2 },
      { kind: 'block', startLine: 1.5, endLine: 3 },
      { kind: 'block', startLine: 1, endLine: Number.MAX_SAFE_INTEGER + 1 },
    ])
      expect(parseTaskReviewAnchor(invalid)).toBeNull();
  });

  test('refuses a region coordinate above 1', () => {
    expect(
      parseTaskReviewAnchor({ kind: 'region', x: 1.01, y: 0, w: 0.1, h: 0.1 }),
    ).toBeNull();
  });

  test('refuses non-finite, negative, empty and overflowing regions', () => {
    const region = { kind: 'region', x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    expect(parseTaskReviewAnchor(region)).toEqual(region);
    for (const invalid of [
      { ...region, x: -0.01 },
      { ...region, y: -0.01 },
      { ...region, x: NaN },
      { ...region, h: Infinity },
      { ...region, w: 0 },
      { ...region, h: 0 },
      { ...region, w: -0.1 },
      { ...region, h: -0.1 },
      { ...region, w: 1.01 },
      { ...region, h: 1.01 },
      { ...region, x: 0.6 },
      { ...region, y: 0.6 },
      { ...region, y: 1.01 },
      { ...region, x: '0.25' },
    ])
      expect(parseTaskReviewAnchor(invalid)).toBeNull();
  });
});

const person = { kind: 'person', principalId: 'person-1' } as const;
const session = { kind: 'session', sessionId: 'session-1' } as const;
const digest = `sha256:${'a'.repeat(64)}` as const;

function event<K extends TaskReviewEvent['kind']>(
  kind: K,
  ordinal: number,
): TaskReviewEvent & { kind: K };
function event(
  kind: TaskReviewEvent['kind'],
  ordinal: number,
): TaskReviewEvent {
  const base = {
    threadId: 'thread-1',
    ordinal,
    operationId: `op-${ordinal}`,
    createdAt: '2026-10-24T12:00:00Z',
  };
  switch (kind) {
    case 'comment':
    case 'reply':
      return { ...base, kind, author: person, body: 'Please fix' };
    case 'agent-reply':
      return {
        ...base,
        kind,
        author: session,
        body: 'Fixed',
        deliveryKey: 'tr-1',
      };
    case 'sent':
      return { ...base, kind, author: person, deliveryKey: 'tr-1' };
    case 'send-failed':
      return {
        ...base,
        kind,
        author: person,
        reason: 'done',
        deliveryKey: 'tr-1',
      };
    case 'resolved':
      return { ...base, kind, author: session, reason: 'done' };
    case 'reopened':
      return { ...base, kind, author: person };
  }
}
function history(...kinds: TaskReviewEvent['kind'][]): TaskReviewEvent[] {
  return kinds.map((kind, index) => event(kind, index + 1));
}
function thread(
  kind: TaskReviewArtifactKind = 'plan',
  events = history('comment'),
): TaskReviewThread {
  const artifact: review.TaskReviewArtifactRef =
    kind === 'answer'
      ? {
          kind,
          sessionId: 'session-1',
          turnId: 'turn/1',
          revision: 'v1',
          digest,
        }
      : kind === 'summary'
        ? { kind, id: 'summary', revision: 1, digest }
        : {
            kind,
            id: 'artifact-1',
            revision: kind === 'capture' ? 'a'.repeat(40) : 'v1',
            digest,
          };
  return {
    threadId: 'thread-1',
    projectId: 'project-1',
    taskId: 'task-1',
    taskCreatedAt: '2026-10-24T12:00:00Z',
    ordinal: 1,
    artifact,
    anchor: quote,
    author: person,
    operationId: 'op-1',
    createdAt: '2026-10-24T12:00:00Z',
    events,
  };
}
const currentPlan = {
  status: 'available',
  kind: 'plan',
  revision: 'v2',
  text: 'now the quote ends',
} as const;
const evidence = {
  commit: 'a'.repeat(40),
  gateRefs: [{ runId: 'run', gateId: 'gate', evaluationId: 'eval' }],
  receiptRefs: ['receipt'],
  captureId: 'capture',
};
const capture = {
  captureId: 'capture',
  projectId: 'project',
  taskId: 'task',
  taskCreatedAt: '2026-10-24',
  sourceKind: 'device',
  sourceSessionId: 'device-1',
  commit: 'a'.repeat(40),
  mediaType: 'image/png',
  byteLength: 1,
  digest,
  author: person,
  operationId: 'op',
  createdAt: '2026-10-24',
};

describe('closed boundary parsers', () => {
  const requests = [
    [review.parseTaskReviewListRequest, { state: 'open' }],
    [review.parseTaskThreadListRequest, { state: 'outdated' }],
    [
      review.parseTaskReviewCreateThreadRequest,
      {
        artifact: thread().artifact,
        anchor: quote,
        body: 'comment',
        operationId: 'op',
      },
    ],
    [review.parseTaskReviewReplyRequest, { body: 'reply', operationId: 'op' }],
    [
      review.parseTaskReviewResolveRequest,
      { reason: 'done', operationId: 'op' },
    ],
    [
      review.parseTaskReviewReopenRequest,
      { reason: 'again', operationId: 'op' },
    ],
    [
      review.parseTaskReviewSendRequest,
      { threadIds: ['thread'], operationId: 'op' },
    ],
    [
      review.parseTaskReviewCreateCaptureRequest,
      {
        sourceKind: 'device',
        sourceSessionId: 'device',
        operationId: 'op',
        label: 'Screen',
      },
    ],
    [review.parseTaskReviewCaptureContentRequest, { captureId: 'capture' }],
    [
      review.parseTaskThreadReplyRequest,
      {
        threadId: 'thread',
        body: 'reply',
        evidence,
        operationId: 'op',
        deliveryKey: 'tr-1',
      },
    ],
    [
      review.parseTaskThreadResolveRequest,
      { threadId: 'thread', reason: 'done', operationId: 'op' },
    ],
    [review.parseTaskReviewEvidenceInput, evidence],
    [review.parseTaskReviewArtifactRef, thread().artifact],
    [review.parseTaskCapture, capture],
  ] as const;
  test.each(requests)(
    '%s accepts its DTO and refuses unknown keys and non-objects',
    (parse, input) => {
      expect(parse(input)).toEqual(input);
      for (const invalid of [
        null,
        [],
        'x',
        { ...input, extra: 1 },
        { ...input, [Symbol('extra')]: 1 },
      ])
        expect(parse(invalid)).toBeNull();
    },
  );
  test('bounds body, reason, label and opaque identities at max and max+1', () => {
    const cases = [
      [review.parseTaskReviewCreateThreadRequest, requests[2][1], 'body', 4000],
      [review.parseTaskReviewReplyRequest, requests[3][1], 'body', 4000],
      [review.parseTaskThreadReplyRequest, requests[9][1], 'body', 4000],
      [review.parseTaskReviewResolveRequest, requests[4][1], 'reason', 500],
      [review.parseTaskReviewReopenRequest, requests[5][1], 'reason', 500],
      [review.parseTaskThreadResolveRequest, requests[10][1], 'reason', 500],
      [
        review.parseTaskReviewCreateCaptureRequest,
        requests[7][1],
        'label',
        120,
      ],
      [review.parseTaskReviewReplyRequest, requests[3][1], 'operationId', 512],
      [review.parseTaskThreadReplyRequest, requests[9][1], 'deliveryKey', 512],
      ...(['sent', 'agent-reply', 'send-failed'] as const).map((kind) => {
        const input = event(kind, 2);
        return [
          (value: unknown) => review.parseTaskReviewEvent(value, 2),
          input,
          'deliveryKey',
          512,
        ] as const;
      }),
      [
        review.parseTaskReviewCaptureContentRequest,
        requests[8][1],
        'captureId',
        512,
      ],
      [review.parseTaskReviewArtifactRef, thread().artifact, 'id', 512],
      [review.parseTaskReviewArtifactRef, thread().artifact, 'revision', 256],
      [review.parseTaskCapture, capture, 'pageUrl', 2048],
    ] as const;
    for (const [parse, input, field, max] of cases) {
      expect(parse({ ...input, [field]: 'x'.repeat(max) })).not.toBeNull();
      for (const value of ['', 'x'.repeat(max + 1), '\ud800', '\udfff'])
        expect(parse({ ...input, [field]: value })).toBeNull();
    }
  });
  test('bounds retained quotes at 2000 and rejects malformed Unicode and CR', () => {
    const input = {
      ...requests[2][1],
      anchor: { kind: 'block', startLine: 1, endLine: 1 },
      quote: 'q'.repeat(2000),
    };
    expect(review.parseTaskReviewCreateThreadRequest(input)).toEqual(input);
    for (const quote of ['', 'q'.repeat(2001), '\ud800', 'a\r\nb'])
      expect(
        review.parseTaskReviewCreateThreadRequest({ ...input, quote }),
      ).toBeNull();
  });
  test('allows retained quotes only on block and whole, and requires a block quote', () => {
    const base = requests[2][1];
    const block = { kind: 'block', startLine: 1, endLine: 1 };
    for (const anchor of [block, { kind: 'whole' }])
      expect(
        review.parseTaskReviewCreateThreadRequest({
          ...base,
          anchor,
          quote: 'retained',
        }),
      ).not.toBeNull();
    expect(
      review.parseTaskReviewCreateThreadRequest({ ...base, anchor: block }),
    ).toBeNull();
    expect(
      review.parseTaskReviewCreateThreadRequest({ ...base, quote: 'retained' }),
    ).toBeNull();
    expect(
      review.parseTaskReviewCreateThreadRequest({
        ...base,
        artifact: thread('capture').artifact,
        anchor: { kind: 'region', x: 0, y: 0, w: 1, h: 1 },
        quote: 'retained',
      }),
    ).toBeNull();
    expect(
      review.parseTaskReviewCreateThreadRequest({
        ...base,
        anchor: { kind: 'whole' },
      }),
    ).not.toBeNull();
  });
  test('capture artifact revisions and capture commits require the same full lowercase SHA', () => {
    for (const revision of [
      'a'.repeat(40),
      'v1',
      'a'.repeat(39),
      'A'.repeat(40),
      '0'.repeat(40),
      'a'.repeat(41),
    ]) {
      const valid = revision === 'a'.repeat(40);
      expect(
        review.parseTaskReviewArtifactRef({
          ...thread('capture').artifact,
          revision,
        }) !== null,
      ).toBe(valid);
      expect(
        review.parseTaskCapture({ ...capture, commit: revision }) !== null,
      ).toBe(valid);
    }
  });
  test('capture dimensions accept 32768 and refuse max+1 on either axis', () => {
    for (const dimension of ['width', 'height']) {
      expect(
        review.parseTaskCapture({ ...capture, [dimension]: 32768 }),
      ).not.toBeNull();
      for (const value of [32769, Number.MAX_SAFE_INTEGER, 0, 1.5])
        expect(
          review.parseTaskCapture({ ...capture, [dimension]: value }),
        ).toBeNull();
    }
  });
  test('uses structured answer references and numeric summary revisions', () => {
    expect(
      review.parseTaskReviewArtifactRef(thread('answer').artifact),
    ).toEqual(thread('answer').artifact);
    expect(
      review.parseTaskReviewArtifactRef(thread('summary').artifact),
    ).toEqual(thread('summary').artifact);
    for (const artifact of [
      { ...thread('answer').artifact, id: 'session/turn' },
      { kind: 'answer', id: 'session/turn', revision: 'v1', digest },
      { ...thread('summary').artifact, revision: '1' },
      { ...thread('summary').artifact, revision: 0 },
      { ...thread('summary').artifact, revision: 1.5 },
      { ...thread('summary').artifact, revision: Number.MAX_SAFE_INTEGER + 1 },
      { ...thread().artifact, digest: 'sha256:a' },
    ])
      expect(review.parseTaskReviewArtifactRef(artifact)).toBeNull();
  });
  test('unifies station-control body and nested evidence and refuses caller verification', () => {
    const input = requests[9][1];
    for (const invalid of [
      { ...input, text: 'old' },
      { ...input, commit: 'old' },
      { ...input, evidence: { ...evidence, commitVerified: true } },
      { ...input, evidence: { ...evidence, gateVerified: true } },
      {
        ...input,
        evidence: {
          ...evidence,
          gateRefs: [{ ...evidence.gateRefs[0], extra: true }],
        },
      },
    ])
      expect(review.parseTaskThreadReplyRequest(invalid)).toBeNull();
    expect(
      review.parseTaskReviewCaptureContentRequest({
        captureId: 'capture',
        taskId: 'redundant',
      }),
    ).toBeNull();
    expect(
      review.parseTaskReviewCreateCaptureRequest({
        ...requests[7][1],
        sourceKind: 'browser',
      }),
    ).not.toBeNull();
    expect(
      review.parseTaskReviewCreateCaptureRequest({
        browserSessionId: 'old',
        operationId: 'op',
      }),
    ).toBeNull();
  });
  test('evidence commits require full 40-hex or 64-hex object IDs at every boundary', () => {
    for (const commit of [
      'a'.repeat(40),
      'Ab01'.repeat(16),
      '0'.repeat(40),
      '0'.repeat(64),
      '',
      'HEAD',
      'abc1234',
      'a'.repeat(39),
      'a'.repeat(41),
      'a'.repeat(63),
      'a'.repeat(65),
      'g'.repeat(40),
      `${'a'.repeat(40)}\n`,
      '\ud800',
    ]) {
      const valid = commit === 'a'.repeat(40) || commit === 'Ab01'.repeat(16);
      expect(review.parseTaskReviewEvidenceInput({ commit })).toEqual(
        valid ? { commit: commit.toLowerCase() } : null,
      );
      const request = review.parseTaskThreadReplyRequest({
        ...requests[9][1],
        evidence: { commit },
      });
      expect(request !== null).toBe(valid);
      const parsed = review.parseTaskReviewEvent(
        {
          ...event('agent-reply', 3),
          evidence: { commit, commitVerified: false, gateVerified: false },
        },
        3,
      );
      expect(parsed !== null).toBe(valid);
      if (valid) {
        expect(request?.evidence?.commit).toBe(commit.toLowerCase());
        expect(parsed?.kind === 'agent-reply' && parsed.evidence?.commit).toBe(
          commit.toLowerCase(),
        );
      }
    }
  });
  test('bounds serialized evidence at 4096 including escaping', () => {
    const base = {
      receiptRefs: Array.from({ length: 9 }, () => 'r'.repeat(450)),
    };
    const padding = 4096 - JSON.stringify(base).length;
    const atLimit = {
      ...base,
      receiptRefs: [
        ...base.receiptRefs.slice(0, -1),
        'r'.repeat(450 + padding),
      ],
    };
    expect(JSON.stringify(atLimit)).toHaveLength(4096);
    expect(review.parseTaskReviewEvidenceInput(atLimit)).toEqual(atLimit);
    const tooLong = {
      ...atLimit,
      receiptRefs: [
        ...atLimit.receiptRefs.slice(0, -1),
        `${atLimit.receiptRefs[8]}r`,
      ],
    };
    expect(review.parseTaskReviewEvidenceInput(tooLong)).toBeNull();
    expect(
      review.parseTaskReviewEvidenceInput({
        ...atLimit,
        receiptRefs: [
          ...atLimit.receiptRefs.slice(0, -1),
          `${atLimit.receiptRefs[8].slice(1)}\n`,
        ],
      }),
    ).toBeNull();
    // Verification flags are included in the stored JSON budget.
    const flagsLength =
      JSON.stringify({ commitVerified: false, gateVerified: false }).length - 1;
    const stored = {
      ...atLimit,
      receiptRefs: [
        ...atLimit.receiptRefs.slice(0, -1),
        atLimit.receiptRefs[8].slice(flagsLength),
      ],
      commitVerified: false,
      gateVerified: false,
    };
    expect(JSON.stringify(stored)).toHaveLength(4096);
    expect(
      review.parseTaskReviewEvent(
        { ...event('agent-reply', 3), evidence: stored },
        3,
      ),
    ).not.toBeNull();
    expect(
      review.parseTaskReviewEvent(
        {
          ...event('agent-reply', 3),
          evidence: {
            ...stored,
            receiptRefs: [
              ...stored.receiptRefs.slice(0, -1),
              `${stored.receiptRefs[8]}r`,
            ],
          },
        },
        3,
      ),
    ).toBeNull();
  });
  test('refuses invalid send selections and enforces all projected store caps', () => {
    const input = {
      threadIds: Array.from({ length: 500 }, (_, i) => `t-${i}`),
      operationId: 'op',
    };
    expect(review.parseTaskReviewSendRequest(input)).toEqual(input);
    for (const threadIds of [
      [],
      ['a', 'a'],
      ['\ud800'],
      [...input.threadIds, 'extra'],
    ])
      expect(
        review.parseTaskReviewSendRequest({ ...input, threadIds }),
      ).toBeNull();
    const counts = {
      threads: 500,
      events: 200,
      captures: 200,
      captureHomeBytes: 512 * 1024 * 1024,
    };
    expect(review.checkTaskReviewCapacity(counts)).toBeNull();
    for (const [field, code] of [
      ['threads', 'thread-limit'],
      ['events', 'event-limit'],
      ['captures', 'capture-limit'],
      ['captureHomeBytes', 'capture-home-limit'],
    ] as const)
      expect(
        review.checkTaskReviewCapacity({
          ...counts,
          [field]: counts[field] + 1,
        }),
      ).toBe(code);
    expect(review.checkTaskReviewCapacity({ ...counts, threads: -1 })).toBe(
      'invalid-request',
    );
    expect(
      review.parseTaskCapture({ ...capture, byteLength: 16 * 1024 * 1024 }),
    ).not.toBeNull();
    expect(
      review.parseTaskCapture({ ...capture, byteLength: 16 * 1024 * 1024 + 1 }),
    ).toBeNull();
    expect(
      review.parseTaskReviewEvidenceInput({
        receiptRefs: Array(200).fill('r'),
      }),
    ).not.toBeNull();
    expect(
      review.parseTaskReviewEvidenceInput({
        receiptRefs: Array(201).fill('r'),
      }),
    ).toBeNull();
  });
  test('enforces artifact and anchor compatibility', () => {
    const region = { kind: 'region', x: 0, y: 0, w: 1, h: 1 } as const;
    for (const kind of [
      'plan',
      'summary',
      'output',
      'answer',
      'capture',
    ] as const) {
      expect(review.checkAnchorForArtifact(kind, region)).toBe(
        kind === 'capture',
      );
      expect(review.checkAnchorForArtifact(kind, quote)).toBe(
        kind !== 'capture',
      );
      expect(
        review.checkAnchorForArtifact(kind, {
          kind: 'block',
          startLine: 1,
          endLine: 1,
        }),
      ).toBe(kind !== 'capture');
      expect(review.checkAnchorForArtifact(kind, { kind: 'whole' })).toBe(true);
    }
    expect(
      review.parseTaskReviewCreateThreadRequest({
        ...requests[2][1],
        artifact: thread('capture').artifact,
      }),
    ).toBeNull();
    expect(
      review.parseTaskReviewCreateThreadRequest({
        ...requests[2][1],
        anchor: region,
      }),
    ).toBeNull();
  });
});

describe('event parsing and transitions', () => {
  test('accepts each event shape, refuses extras, validates expected ordinal and caps', () => {
    for (const kind of [
      'comment',
      'reply',
      'agent-reply',
      'sent',
      'send-failed',
      'resolved',
      'reopened',
    ] as const) {
      const input = event(kind, kind === 'comment' ? 1 : 2);
      expect(review.parseTaskReviewEvent(input, input.ordinal)).toEqual(input);
      expect(
        review.parseTaskReviewEvent({ ...input, extra: true }, input.ordinal),
      ).toBeNull();
      expect(review.parseTaskReviewEvent(input, input.ordinal + 1)).toBeNull();
      if (kind !== 'comment') {
        expect(review.parseTaskReviewEvent(event(kind, 1), 1)).toBeNull();
        expect(
          review.parseTaskReviewEvent(event(kind, 200), 200),
        ).not.toBeNull();
        expect(review.parseTaskReviewEvent(event(kind, 201), 201)).toBeNull();
      }
    }
    expect(review.parseTaskReviewEvent(event('comment', 2), 2)).toBeNull();
  });
  test('enforces event body/reason and author identity bounds', () => {
    for (const [kind, field, max] of [
      ['comment', 'body', 4000],
      ['reply', 'body', 4000],
      ['agent-reply', 'body', 4000],
      ['resolved', 'reason', 500],
      ['send-failed', 'reason', 500],
      ['reopened', 'reason', 500],
    ] as const) {
      const input = event(kind, kind === 'comment' ? 1 : 2);
      expect(
        review.parseTaskReviewEvent(
          { ...input, [field]: 'x'.repeat(max) },
          input.ordinal,
        ),
      ).not.toBeNull();
      expect(
        review.parseTaskReviewEvent(
          { ...input, [field]: 'x'.repeat(max + 1) },
          input.ordinal,
        ),
      ).toBeNull();
    }
    const input = event('comment', 1);
    expect(
      review.parseTaskReviewEvent(
        { ...input, author: { ...person, principalId: 'p'.repeat(256) } },
        1,
      ),
    ).not.toBeNull();
    expect(
      review.parseTaskReviewEvent(
        { ...input, author: { ...person, principalId: 'p'.repeat(257) } },
        1,
      ),
    ).toBeNull();
  });
  test('person comments/replies/sends/reopens and session agent replies are enforced', () => {
    for (const kind of ['comment', 'reply', 'sent', 'reopened'] as const) {
      const input = event(kind, kind === 'comment' ? 1 : 2);
      expect(
        review.parseTaskReviewEvent(
          { ...input, author: session },
          input.ordinal,
        ),
      ).toBeNull();
    }
    expect(
      review.parseTaskReviewEvent(
        { ...event('agent-reply', 2), author: person },
        2,
      ),
    ).toBeNull();
  });
  test('session reply cannot reopen a resolved thread', () => {
    const prior = history('comment', 'resolved');
    expect(deriveThreadState(prior)).toBe('resolved');
    expect(() =>
      deriveThreadState([...prior, { ...event('reply', 3), author: session }]),
    ).toThrow(TypeError);
    expect(deriveThreadState([...prior, event('reply', 3)])).toBe('open');
  });
  test.each([
    [null, 'comment', true],
    [null, 'reply', false],
    ['open', 'sent', true],
    ['sent', 'sent', false],
    ['agent-replied', 'sent', true],
    ['resolved', 'sent', false],
    ['open', 'reopened', false],
    ['sent', 'reopened', false],
    ['agent-replied', 'reopened', false],
    ['resolved', 'reopened', true],
    ['open', 'agent-reply', false],
    ['sent', 'agent-reply', false],
    ['agent-replied', 'agent-reply', false],
    ['resolved', 'agent-reply', false],
    ['open', 'send-failed', false],
    ['sent', 'send-failed', false],
    ['resolved', 'send-failed', false],
    ['open', 'resolved', true],
    ['sent', 'resolved', true],
    ['agent-replied', 'resolved', true],
    ['resolved', 'resolved', false],
    ['resolved', 'reply', true],
    ['open', 'comment', false],
  ] as const)('%s → %s has allowed=%s', (state, kind, allowed) => {
    expect(
      review.canAppendTaskReviewEvent(
        state,
        event(kind, kind === 'comment' ? 1 : 2),
      ),
    ).toEqual(
      allowed
        ? { allowed: true }
        : { allowed: false, code: 'invalid-transition' },
    );
  });
  test.each([
    [['comment', 'sent', 'reply'], 'agent-reply', true, 'agent-replied'],
    [['comment', 'sent', 'reply'], 'send-failed', true, 'open'],
    [['comment', 'sent', 'agent-reply'], 'agent-reply', true, 'agent-replied'],
    [['comment', 'sent', 'resolved'], 'send-failed', true, 'resolved'],
    [['comment', 'sent', 'resolved'], 'agent-reply', true, 'resolved'],
    [['comment', 'sent', 'resolved', 'reopened'], 'send-failed', false, 'open'],
    [
      ['comment', 'sent', 'agent-reply', 'reply'],
      'agent-reply',
      true,
      'agent-replied',
    ],
    [['comment', 'sent', 'agent-reply'], 'send-failed', true, 'agent-replied'],
    [['comment', 'sent', 'send-failed'], 'send-failed', true, 'open'],
    [['comment'], 'agent-reply', false, 'open'],
    [['comment'], 'send-failed', false, 'open'],
  ] as const)(
    '%s → %s admits=%s and folds to %s',
    (kinds, kind, allowed, expected) => {
      const prior = history(...kinds);
      const next = event(kind, prior.length + 1);
      expect(review.canAppendTaskReviewEvent(prior, next)).toEqual(
        allowed
          ? { allowed: true }
          : { allowed: false, code: 'invalid-transition' },
      );
      if (allowed) expect(deriveThreadState([...prior, next])).toBe(expected);
      else expect(() => deriveThreadState([...prior, next])).toThrow(TypeError);
    },
  );
  test.each([
    [false, person, false],
    [true, person, true],
    [true, { kind: 'person', principalId: 'different-person' }, false],
    [true, session, false],
  ] as const)(
    'Sent follow-up=%s permits a new send, then failure author=%s admits=%s',
    (followUp, failureAuthor, failureAllowed) => {
      const prior = history(
        'comment',
        'sent',
        ...(followUp ? ['reply' as const] : []),
      );
      const sent = { ...event('sent', prior.length + 1), deliveryKey: 'tr-2' };
      expect(review.canAppendTaskReviewEvent(prior, sent)).toEqual(
        followUp
          ? { allowed: true }
          : { allowed: false, code: 'invalid-transition' },
      );
      if (!followUp) return;
      const superseded = [...prior, sent];
      expect(
        review.deriveThreadView(thread('plan', superseded), currentPlan),
      ).toMatchObject({
        baseState: 'sent',
        deliveryKey: 'tr-2',
        pendingFollowUp: false,
      });
      for (const kind of ['agent-reply', 'send-failed'] as const)
        expect(
          review.canAppendTaskReviewEvent(
            superseded,
            event(kind, superseded.length + 1),
          ),
        ).toEqual({
          allowed: false,
          code: 'invalid-transition',
        });
      const failed = {
        ...event('send-failed', superseded.length + 1),
        deliveryKey: 'tr-2',
        author: failureAuthor,
      };
      expect(review.canAppendTaskReviewEvent(superseded, failed)).toEqual(
        failureAllowed
          ? { allowed: true }
          : { allowed: false, code: 'invalid-transition' },
      );
      if (failureAllowed)
        expect(deriveThreadState([...superseded, failed])).toBe('open');
    },
  );
  test('a sent key cannot be reused after a reply, failure, superseding send or reopen', () => {
    for (const prior of [
      history('comment', 'sent', 'agent-reply'),
      history('comment', 'sent', 'send-failed'),
      history('comment', 'sent', 'reply'),
      history('comment', 'sent', 'resolved', 'reopened'),
      [
        ...history('comment', 'sent', 'agent-reply'),
        { ...event('sent', 4), deliveryKey: 'tr-2' },
        event('reply', 5),
      ],
    ]) {
      expect(
        review.canAppendTaskReviewEvent(prior, event('sent', prior.length + 1)),
      ).toEqual({
        allowed: false,
        code: 'invalid-transition',
      });
      expect(
        review.canAppendTaskReviewEvent(prior, {
          ...event('sent', prior.length + 1),
          deliveryKey: 'tr-fresh',
        }),
      ).toEqual({ allowed: true });
    }
    // Keys may still be shared by separate threads in a batch.
    expect(
      review.canAppendTaskReviewEvent(history('comment'), event('sent', 2)),
    ).toEqual({ allowed: true });
  });
  test.each(['reopened', 'reply'] as const)(
    '%s clears active delivery correlation after resolution',
    (kind) => {
      const prior = history('comment', 'sent', 'resolved', kind);
      const view = review.deriveThreadView(thread('plan', prior), currentPlan);
      expect(view.baseState).toBe('open');
      expect(view.deliveryKey).toBeUndefined();
      for (const late of ['agent-reply', 'send-failed'] as const)
        expect(review.canAppendTaskReviewEvent(prior, event(late, 5))).toEqual({
          allowed: false,
          code: 'invalid-transition',
        });
      const fresh = [...prior, { ...event('sent', 5), deliveryKey: 'tr-2' }];
      expect(
        review.canAppendTaskReviewEvent(fresh, {
          ...event('agent-reply', 6),
          deliveryKey: 'tr-2',
        }),
      ).toEqual({ allowed: true });
    },
  );
  test.each([['reply'], ['reopened', 'reply']] as const)(
    'person text after resolution via %s is pending since the latest send',
    (...kinds) => {
      const prior = history('comment', 'sent', 'resolved');
      const events = [
        ...prior,
        ...kinds.map((kind, index) => event(kind, prior.length + index + 1)),
      ];
      const view = review.deriveThreadView(thread('plan', events), currentPlan);
      expect(view).toMatchObject({ baseState: 'open', pendingFollowUp: true });
      expect(view.deliveryKey).toBeUndefined();
      const sent = [
        ...events,
        { ...event('sent', events.length + 1), deliveryKey: 'tr-2' },
      ];
      expect(
        review.deriveThreadView(thread('plan', sent), currentPlan)
          .pendingFollowUp,
      ).toBe(false);
      expect(
        review.deriveThreadView(
          thread('plan', history('comment', 'resolved', 'reopened', 'reply')),
          currentPlan,
        ).pendingFollowUp,
      ).toBe(false);
    },
  );
  test('a reply keeps Sent in flight and retains the unsent follow-up until the next send', () => {
    const prior = history('comment', 'sent', 'reply');
    expect(deriveThreadState(prior)).toBe('sent');
    const view = review.deriveThreadView(thread('plan', prior), currentPlan);
    expect(view).toMatchObject({
      baseState: 'sent',
      deliveryKey: 'tr-1',
      pendingFollowUp: true,
      deliveryStatus: 'unconfirmed',
    });
    const replied = [...prior, event('agent-reply', 4)];
    expect(
      review.deriveThreadView(thread('plan', replied), currentPlan),
    ).toMatchObject({ baseState: 'agent-replied', pendingFollowUp: true });
    expect(
      review.deriveThreadView(
        thread('plan', [
          ...replied,
          { ...event('sent', 5), deliveryKey: 'tr-2' },
        ]),
        currentPlan,
      ),
    ).toMatchObject({
      baseState: 'sent',
      deliveryKey: 'tr-2',
      pendingFollowUp: false,
    });
    const reopened = [...prior, event('resolved', 4), event('reopened', 5)];
    for (const events of [reopened, [...reopened, event('reply', 6)]]) {
      const followUp = review.deriveThreadView(
        thread('plan', events),
        currentPlan,
      );
      expect(followUp.pendingFollowUp).toBe(true);
      expect(followUp.deliveryKey).toBeUndefined();
    }
  });
  test('only the latest accepted send key can receive a failure or agent reply', () => {
    const prior = [
      ...history('comment', 'sent', 'agent-reply'),
      { ...event('sent', 4), deliveryKey: 'tr-2' },
    ];
    for (const kind of ['send-failed', 'agent-reply'] as const) {
      const stale = event(kind, 5);
      expect(review.canAppendTaskReviewEvent(prior, stale)).toEqual({
        allowed: false,
        code: 'invalid-transition',
      });
      expect(() => deriveThreadState([...prior, stale])).toThrow(TypeError);
      expect(
        review.canAppendTaskReviewEvent(prior, {
          ...stale,
          deliveryKey: 'tr-2',
        }),
      ).toEqual({ allowed: true });
      const { deliveryKey: _key, ...missing } = stale;
      expect(review.parseTaskReviewEvent(missing, 5)).toBeNull();
    }
    const { deliveryKey: _key, ...missing } = {
      threadId: 'thread',
      body: 'reply',
      deliveryKey: 'tr-1',
      operationId: 'op',
    };
    expect(review.parseTaskThreadReplyRequest(missing)).toBeNull();
    // A refused write is not valid stored history.
    const refused = [
      ...history('comment', 'sent', 'resolved'),
      { ...event('sent', 4), deliveryKey: 'tr-2' },
    ];
    expect(
      review.canAppendTaskReviewEvent(refused, event('send-failed', 5)),
    ).toEqual({ allowed: false, code: 'invalid-event' });
  });
  test('requires the next contiguous ordinal when appending to a history', () => {
    const prior = history('comment', 'sent', 'agent-reply');
    for (const ordinal of [2, 3, 5, 200])
      expect(
        review.canAppendTaskReviewEvent(prior, {
          ...event('sent', ordinal),
          deliveryKey: 'tr-2',
        }),
      ).toEqual({ allowed: false, code: 'invalid-event' });
    expect(
      review.canAppendTaskReviewEvent(prior, {
        ...event('sent', 4),
        deliveryKey: 'tr-2',
      }),
    ).toEqual({ allowed: true });
    expect(review.canAppendTaskReviewEvent([], event('comment', 1))).toEqual({
      allowed: true,
    });
  });
  test.each([{ threadId: 'different-thread' }, { operationId: 'op-1' }])(
    'refuses an appended event with mismatched or reused identity %j',
    (invalid) => {
      const prior = history('comment');
      const candidate = { ...event('reply', 2), ...invalid };
      expect(review.canAppendTaskReviewEvent(prior, candidate)).toEqual({
        allowed: false,
        code: 'invalid-event',
      });
      expect(review.canAppendTaskReviewEvent(prior, event('reply', 2))).toEqual(
        { allowed: true },
      );
    },
  );
  test('refuses invalid stored history rather than projecting or appending to a valid subset', () => {
    const malformed = [
      [...history('comment'), { ...event('reply', 2), ordinal: 3 }],
      [
        ...history('comment'),
        { ...event('reply', 2), threadId: 'different-thread' },
      ],
      [...history('comment'), { ...event('reply', 2), operationId: 'op-1' }],
      history('comment', 'agent-reply'),
      history('comment', 'resolved', 'sent'),
      [...history('comment'), { ...event('reply', 2), body: '' }],
    ];
    for (const events of malformed) {
      expect(() => deriveThreadState(events)).toThrow(TypeError);
      expect(() =>
        review.deriveThreadView(thread('plan', events), currentPlan),
      ).toThrow(TypeError);
      expect(() => deriveOutdated(thread('plan', events), currentPlan)).toThrow(
        TypeError,
      );
      expect(
        review.canAppendTaskReviewEvent(
          events,
          event('reply', events.length + 1),
        ),
      ).toEqual({ allowed: false, code: 'invalid-event' });
    }
  });
  test('returns invalid-event and event-limit refusals and projects valid full histories', () => {
    expect(
      review.canAppendTaskReviewEvent('resolved', {
        ...event('reopened', 3),
        author: session,
      }),
    ).toEqual({ allowed: false, code: 'invalid-event' });
    expect(review.canAppendTaskReviewEvent('open', event('sent', 201))).toEqual(
      { allowed: false, code: 'event-limit' },
    );
    const events = history(
      'comment',
      'sent',
      'send-failed',
      'resolved',
      'reopened',
    );
    expect(deriveThreadState(events)).toBe('open');
    expect(deriveThreadState(events.slice(0, -1))).toBe('resolved');
    expect(deriveThreadState([])).toBe('open');
  });
});

describe('text relocation and freshness', () => {
  test('relocates exact and moved quotes, with low confidence when surrounding context is lost', () => {
    expect(relocateTextQuote('the quote ends', quote)).toEqual({
      status: 'exact',
      start: 4,
      end: 9,
      confidence: 'high',
    });
    expect(relocateTextQuote('now the quote ends', quote)).toEqual({
      status: 'moved',
      start: 8,
      end: 13,
      confidence: 'high',
    });
    expect(relocateTextQuote('a quote elsewhere', quote)).toEqual({
      status: 'moved',
      start: 2,
      end: 7,
      confidence: 'low',
    });
    expect(relocateTextQuote('the quote starts; a quote ends', quote)).toEqual({
      status: 'ambiguous',
    });
    expect(relocateTextQuote('a quote starts; the quote ends', quote)).toEqual({
      status: 'moved',
      start: 20,
      end: 25,
      confidence: 'high',
    });
    expect(relocateTextQuote('the quote ends; the quote ends', quote)).toEqual({
      status: 'ambiguous',
    });
    expect(
      relocateTextQuote('aaa', {
        ...quote,
        start: 0,
        end: 2,
        exact: 'aa',
        prefix: '',
        suffix: '',
      }),
    ).toEqual({ status: 'ambiguous' });
    for (const text of ['', 'the quotation ends', 'the Quote ends'])
      expect(relocateTextQuote(text, quote)).toEqual({ status: 'missing' });
  });
  test('normalizes CRLF and lone CR to LF before offsets, multiline quotes and block comparison', () => {
    const text = 'first\r\nthe quote\r\nends';
    const anchor = {
      ...quote,
      start: 10,
      end: 20,
      exact: 'quote\nends',
      prefix: 'the ',
      suffix: '',
    };
    expect(review.normalizeTaskReviewText('a\r\nb\rc')).toBe('a\nb\nc');
    expect(relocateTextQuote(text, anchor)).toEqual({
      status: 'exact',
      start: 10,
      end: 20,
      confidence: 'high',
    });
    expect(
      deriveOutdated({ ...thread(), anchor }, { ...currentPlan, text }),
    ).toBe(false);
    expect(
      deriveOutdated(
        {
          ...thread(),
          anchor: { kind: 'block', startLine: 2, endLine: 3 },
          quote: 'the quote\nends',
        },
        { ...currentPlan, text },
      ),
    ).toBe(false);
  });
  test('refuses lone surrogates and relocates well-formed quotes despite old offsets splitting a pair', () => {
    for (const field of ['exact', 'prefix', 'suffix'] as const) {
      for (const value of ['\ud800', '\udfff'])
        expect(
          parseTaskReviewAnchor({
            ...quote,
            [field]: value,
            ...(field === 'exact' ? { end: 5 } : {}),
          }),
        ).toBeNull();
    }
    const anchor = {
      ...quote,
      start: 1,
      end: 2,
      exact: 'x',
      prefix: '',
      suffix: '',
    };
    expect(relocateTextQuote('🧭axb', anchor)).toEqual({
      status: 'moved',
      start: 3,
      end: 4,
      confidence: 'low',
    });
    expect(relocateTextQuote('x🧭', anchor)).toEqual({
      status: 'moved',
      start: 0,
      end: 1,
      confidence: 'low',
    });
    expect(relocateTextQuote('x\ud800', anchor)).toEqual({ status: 'unknown' });
    expect(relocateTextQuote('🧭x', { ...anchor, start: 2, end: 3 })).toEqual({
      status: 'exact',
      start: 2,
      end: 3,
      confidence: 'low',
    });
  });
  test.each(['context', 'exact', 'block'] as const)(
    'bounds matcher steps and traps unmetered document access for adversarial %s searches',
    (shape) => {
      for (const size of [64 * 1024, 1024 * 1024]) {
        for (const width of [64, 65, 258, 1802, 2000]) {
          const text = 'a'.repeat(size);
          const p = Math.floor(width / 2);
          const k = width - p - 1;
          const anchor =
            shape === 'context'
              ? {
                  ...quote,
                  start: 0,
                  end: 1,
                  exact: 'a',
                  prefix: 'a'.repeat(p - 1),
                  suffix: `b${'a'.repeat(k)}`,
                }
              : {
                  ...quote,
                  start: 0,
                  end: width,
                  exact: `${'a'.repeat(p)}b${'a'.repeat(k)}`,
                  prefix: '',
                  suffix: '',
                };
          const probes: { length: number; steps: number; limit: number }[] = [];
          const guarded = (document: matcher.MatchText) =>
            new Proxy(new String(document), {
              get(target, property) {
                if (typeof property === 'string' && /^\d+$/.test(property))
                  throw new Error('unmetered document bracket read');
                const value = Reflect.get(target, property);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            });
          const counted = (length: number, limit: number) => {
            const probe = { length, steps: 0, limit };
            probes.push(probe);
            return (steps: number) => {
              probe.steps += steps;
              if (probe.steps > limit)
                throw new Error('linear matcher step budget exceeded');
            };
          };
          const find = matcher.findTwoMatches;
          const at = matcher.matchesAt;
          const findSpy = vi
            .spyOn(matcher, 'findTwoMatches')
            .mockImplementation((document, pattern) =>
              find(
                guarded(document),
                pattern,
                counted(
                  pattern.length,
                  pattern.length <= 64
                    ? 128 * size
                    : 8 * (size + pattern.length),
                ),
              ),
            );
          const atSpy = vi
            .spyOn(matcher, 'matchesAt')
            .mockImplementation((document, pattern, start) =>
              at(
                guarded(document),
                pattern,
                start,
                counted(pattern.length, 2 * pattern.length),
              ),
            );
          const descriptors = new Map<string, PropertyDescriptor>();
          const nativePatterns: number[] = [];
          for (const method of [
            'indexOf',
            'startsWith',
            'endsWith',
            'includes',
            'lastIndexOf',
            'search',
            'match',
          ] as const) {
            const descriptor = Object.getOwnPropertyDescriptor(
              String.prototype,
              method,
            );
            if (!descriptor) throw new Error(`missing String.${method}`);
            descriptors.set(method, descriptor);
            Object.defineProperty(String.prototype, method, {
              ...descriptor,
              value: function (this: string, ...args: unknown[]) {
                if (this.length === size) {
                  if (
                    method !== 'indexOf' ||
                    typeof args[0] !== 'string' ||
                    args[0].length > 64
                  )
                    throw new Error(`unmetered document ${method}`);
                  nativePatterns.push(args[0].length);
                }
                return Reflect.apply(descriptor.value, this, args);
              },
            });
          }
          let result: unknown;
          try {
            result =
              shape === 'block'
                ? deriveOutdated(
                    {
                      ...thread(),
                      anchor: { kind: 'block', startLine: 2, endLine: 2 },
                      quote: anchor.exact,
                    },
                    { ...currentPlan, text },
                  )
                : relocateTextQuote(text, anchor);
          } finally {
            for (const [method, descriptor] of descriptors)
              Object.defineProperty(String.prototype, method, descriptor);
            findSpy.mockRestore();
            atSpy.mockRestore();
          }
          expect(result).toEqual(
            shape === 'block'
              ? true
              : { status: shape === 'context' ? 'ambiguous' : 'missing' },
          );
          expect(probes.length).toBeGreaterThan(0);
          for (const probe of probes) {
            expect(probe.steps).toBeGreaterThan(0);
            expect(probe.steps).toBeLessThanOrEqual(probe.limit);
            if (probe.length > 64)
              expect(probe.steps).toBeGreaterThanOrEqual(size);
          }
          if (width <= 64 || shape === 'context')
            expect(nativePatterns.length).toBeGreaterThan(0);
          else expect(nativePatterns).toEqual([]);
        }
      }
    },
  );
  test.each([64, 65])(
    'relocates unique and overlapping %s-unit patterns across the native/KMP boundary',
    (width) => {
      const exact = `${'a'.repeat(width - 1)}b`;
      const anchor = {
        ...quote,
        start: 0,
        end: width,
        exact,
        prefix: '',
        suffix: '',
      };
      expect(relocateTextQuote(`x${exact}`, anchor)).toEqual({
        status: 'moved',
        start: 1,
        end: width + 1,
        confidence: 'low',
      });
      expect(
        relocateTextQuote('a'.repeat(width + 1), {
          ...anchor,
          exact: 'a'.repeat(width),
        }),
      ).toEqual({ status: 'ambiguous' });
    },
  );
  test('keeps adversarial 1 MiB text and block searches below a generous wall-time backstop', () => {
    const text = 'a'.repeat(1024 * 1024);
    const exact = `${'a'.repeat(1000)}b${'a'.repeat(999)}`;
    const anchor = {
      ...quote,
      start: 0,
      end: 2000,
      exact,
      prefix: '',
      suffix: '',
    };
    for (const shape of ['context', 'exact', 'block']) {
      // Timing is only a coarse backstop; the owning assertions count matcher work above.
      // oxlint-disable-next-line repo-hygiene/deterministic-unit-tests -- Explicit performance backstop requested for 1 MiB matching; deterministic step counts remain primary.
      const started = performance.now();
      const result =
        shape === 'block'
          ? deriveOutdated(
              {
                ...thread(),
                anchor: { kind: 'block', startLine: 2, endLine: 2 },
                quote: exact,
              },
              { ...currentPlan, text },
            )
          : relocateTextQuote(
              text,
              shape === 'context'
                ? {
                    ...anchor,
                    end: 1,
                    exact: 'a',
                    prefix: 'a'.repeat(999),
                    suffix: `b${'a'.repeat(999)}`,
                  }
                : anchor,
            );
      // oxlint-disable-next-line repo-hygiene/deterministic-unit-tests -- Measure the same bounded performance interval; this does not drive a unit-test clock.
      const elapsedMs = performance.now() - started;
      expect(result).toEqual(
        shape === 'block'
          ? true
          : { status: shape === 'context' ? 'ambiguous' : 'missing' },
      );
      expect(elapsedMs).toBeLessThan(2000);
    }
  });
  test('prepares an immutable revision once for multiple quotes and preserves raw bounds', () => {
    const document = review.prepareTaskReviewDocument(
      'the quote ends\r\nsecond',
    );
    expect(document?.text).toBe('the quote ends\nsecond');
    expect(document?.lineStarts).toEqual([0, 15]);
    expect(Object.isFrozen(document?.lineStarts)).toBe(true);
    expect(Object.isFrozen(document)).toBe(true);
    const first = document?.relocateTextQuote(quote);
    const second = document?.relocateTextQuote({
      ...quote,
      start: 15,
      end: 21,
      exact: 'second',
      prefix: '',
      suffix: '',
    });
    expect(first).toEqual({
      status: 'exact',
      start: 4,
      end: 9,
      confidence: 'high',
    });
    expect(second).toEqual({
      status: 'exact',
      start: 15,
      end: 21,
      confidence: 'low',
    });
    expect(review.prepareTaskReviewDocument('x\ud800')).toBeNull();
    expect(
      review.prepareTaskReviewDocument('x'.repeat(1024 * 1024 + 1)),
    ).toBeNull();
    expect(document?.relocateTextQuote({ ...quote, end: 8 })).toEqual({
      status: 'unknown',
    });
  });
  test('bounds document work before normalization and refuses oversized text as unknown', () => {
    const anchor = {
      ...quote,
      start: 0,
      end: 1,
      exact: 'q',
      prefix: '',
      suffix: '',
    };
    const atLimit = `q${'x'.repeat(1024 * 1024 - 1)}`;
    expect(relocateTextQuote(atLimit, anchor)).toMatchObject({
      status: 'exact',
    });
    expect(relocateTextQuote(`${atLimit}x`, anchor)).toEqual({
      status: 'unknown',
    });
    expect(
      deriveOutdated(thread(), { ...currentPlan, text: `${atLimit}x` }),
    ).toBe('unknown');
    expect(
      relocateTextQuote('a'.repeat(1024 * 1024), { ...anchor, exact: 'a' }),
    ).toEqual({ status: 'ambiguous' });
  });
  test('keeps relocated plan and numeric summary quotes current but marks missing or ambiguous quotes outdated', () => {
    expect(deriveOutdated(thread(), currentPlan)).toBe(false);
    expect(
      deriveOutdated(thread('summary'), {
        ...currentPlan,
        kind: 'summary',
        revision: 2,
      }),
    ).toBe(false);
    for (const text of ['changed', 'the quote ends; the quote ends']) {
      expect(deriveOutdated(thread(), { ...currentPlan, text })).toBe(true);
      expect(
        deriveOutdated(thread(), { ...currentPlan, text, revision: 'v1' }),
      ).toBe(false);
      expect(
        deriveOutdated(thread('plan', history('comment', 'resolved')), {
          ...currentPlan,
          text,
        }),
      ).toBe(false);
    }
  });
  test('compares the specified block lines before relocation so duplicate blocks keep their position', () => {
    const block = {
      ...thread(),
      anchor: { kind: 'block', startLine: 3, endLine: 4 } as const,
      quote: 'same\nblock',
    };
    expect(
      deriveOutdated(block, {
        ...currentPlan,
        text: 'same\nblock\nsame\nblock',
      }),
    ).toBe(false);
    expect(
      deriveOutdated(block, {
        ...currentPlan,
        text: 'same\nblock\nchanged\nblock\nsame\nblock',
      }),
    ).toBe(true);
    expect(
      deriveOutdated(block, { ...currentPlan, text: 'same\nblock\nchanged' }),
    ).toBe(false);
    expect(deriveOutdated({ ...block, quote: 'absent' }, currentPlan)).toBe(
      true,
    );
    expect(deriveOutdated({ ...block, quote: undefined }, currentPlan)).toBe(
      'unknown',
    );
    expect(
      deriveOutdated({ ...block, quote: 'x'.repeat(2001) }, currentPlan),
    ).toBe('unknown');
  });
  test('whole anchors stay unknown on changed mutable revisions even when a retained quote occurs', () => {
    const whole = {
      ...thread(),
      anchor: { kind: 'whole' } as const,
      quote: 'quote',
    };
    expect(deriveOutdated(whole, currentPlan)).toBe('unknown');
    expect(deriveOutdated(whole, { ...currentPlan, revision: 'v1' })).toBe(
      false,
    );
  });
  test('output outdated requires a different revision AND newer same-path provenance', () => {
    for (const [revision, newerOutputWithSamePath, expected] of [
      ['v1', true, false],
      ['v1', false, false],
      ['v2', false, false],
      ['v2', true, true],
    ] as const)
      expect(
        deriveOutdated(thread('output'), {
          status: 'available',
          kind: 'output',
          revision,
          newerOutputWithSamePath,
        }),
      ).toBe(expected);
  });
  test('missing/mismatched mutable reads stay unknown while resolved and immutable artifacts are never outdated', () => {
    for (const kind of ['plan', 'summary', 'output'] as const) {
      expect(deriveOutdated(thread(kind), { status: 'unavailable' })).toBe(
        'unknown',
      );
      expect(
        deriveOutdated(thread(kind, history('comment', 'resolved')), {
          status: 'unavailable',
        }),
      ).toBe(false);
    }
    expect(
      deriveOutdated(thread(), {
        ...currentPlan,
        kind: 'summary',
        revision: 2,
      }),
    ).toBe('unknown');
    for (const kind of ['answer', 'capture'] as const)
      expect(deriveOutdated(thread(kind), { status: 'unavailable' })).toBe(
        false,
      );
  });
});

describe('thread views, filters and counts', () => {
  test('delivery confirmation is per thread and latest key, even on the same artifact', () => {
    const first = thread('plan', history('comment', 'sent'));
    const second = {
      ...first,
      threadId: 'thread-2',
      events: history('comment', 'sent').map((e) => ({
        ...e,
        threadId: 'thread-2',
        ...(e.kind === 'sent' ? { deliveryKey: 'tr-2' } : {}),
      })),
    };
    const delivery = { deliveryKey: 'tr-1', status: 'confirmed' } as const;
    expect(
      review.deriveThreadView(first, currentPlan, delivery).deliveryStatus,
    ).toBe('confirmed');
    expect(
      review.deriveThreadView(second, currentPlan, delivery).deliveryStatus,
    ).toBe('unconfirmed');
    expect(
      review.deriveThreadView(second, currentPlan, {
        deliveryKey: 'tr-2',
        status: 'confirmed',
      }).deliveryStatus,
    ).toBe('confirmed');
    const legacyArtifact = {
      ...currentPlan,
      deliveryStatus: 'confirmed' as const,
    };
    expect(review.deriveThreadView(first, legacyArtifact).deliveryStatus).toBe(
      'unconfirmed',
    );
  });
  test('derives state, revision chips, delivery confirmation and unknown freshness in Open', () => {
    const sent = thread('plan', history('comment', 'sent'));
    const unknown = review.deriveThreadView(sent, { status: 'unavailable' });
    expect(unknown).toMatchObject({
      baseState: 'sent',
      state: 'sent',
      outdated: 'unknown',
      deliveryStatus: 'unconfirmed',
    });
    expect(unknown.currentRevision).toBeUndefined();
    expect(review.matchesTaskReviewFilter(unknown, 'open')).toBe(true);
    expect(review.matchesTaskReviewFilter(unknown, 'outdated')).toBe(false);
    const confirmed = review.deriveThreadView(sent, currentPlan, {
      deliveryKey: 'tr-1',
      status: 'confirmed',
    });
    expect(confirmed).toMatchObject({
      currentRevision: 'v2',
      deliveryStatus: 'confirmed',
    });
    const outdated = review.deriveThreadView(sent, {
      ...currentPlan,
      text: 'gone',
    });
    expect(outdated).toMatchObject({
      baseState: 'sent',
      state: 'outdated',
      outdated: true,
    });
    expect(review.matchesTaskReviewFilter(outdated, 'open')).toBe(false);
    expect(review.matchesTaskReviewFilter(outdated, 'outdated')).toBe(true);
    const replied = review.deriveThreadView(
      thread('plan', history('comment', 'sent', 'agent-reply')),
      currentPlan,
    );
    expect(replied.state).toBe('agent-replied');
    expect(replied.deliveryStatus).toBeUndefined();
    const failed = review.deriveThreadView(
      thread('plan', history('comment', 'sent', 'send-failed')),
      currentPlan,
    );
    expect(failed.state).toBe('open');
    expect(failed.deliveryStatus).toBeUndefined();
    const resolved = review.deriveThreadView(
      thread('plan', history('comment', 'resolved')),
      { ...currentPlan, text: 'gone' },
    );
    expect(resolved).toMatchObject({ state: 'resolved', outdated: false });
    expect(review.matchesTaskReviewFilter(resolved, 'resolved')).toBe(true);
    expect(review.matchesTaskReviewFilter(resolved, 'open')).toBe(false);
    expect(
      review.countThreads([
        unknown,
        confirmed,
        outdated,
        replied,
        failed,
        resolved,
      ]),
    ).toEqual({ open: 4, outdated: 1, resolved: 1 });
    expect(review.countThreads([])).toEqual({
      open: 0,
      outdated: 0,
      resolved: 0,
    });
    expect(
      review.deriveThreadView(thread('summary'), {
        ...currentPlan,
        kind: 'summary',
        revision: 2,
      }).currentRevision,
    ).toBe(2);
  });
});
