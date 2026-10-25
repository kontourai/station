import { describe, expect, test } from 'vitest';
import {
  deriveOutdated,
  deriveThreadState,
  parseTaskReviewAnchor,
  relocateTextQuote,
  type TaskReviewAnchor,
  type TaskReviewArtifactKind,
  type TaskReviewBaseThreadState,
  type TaskReviewCurrentArtifact,
  type TaskReviewEvent,
  type TaskReviewThread,
} from '../task-review.js';

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

describe('deriveThreadState', () => {
  const priorStates: readonly (readonly Pick<TaskReviewEvent, 'kind'>[])[] = [
    [],
    [{ kind: 'sent' }],
    [{ kind: 'agent-reply' }],
    [{ kind: 'resolved' }],
  ];
  const transitions: readonly [
    TaskReviewEvent['kind'],
    TaskReviewBaseThreadState,
  ][] = [
    ['comment', 'open'],
    ['reply', 'open'],
    ['sent', 'sent'],
    ['send-failed', 'open'],
    ['agent-reply', 'agent-replied'],
    ['resolved', 'resolved'],
    ['reopened', 'open'],
  ];
  test.each(transitions)(
    '%s transitions every prior state to %s',
    (kind, expected) => {
      for (const events of priorStates)
        expect(deriveThreadState([...events, { kind }])).toBe(expected);
    },
  );
  test('starts open and folds a complete send, failure, retry, reply, resolve and reopen history in order', () => {
    expect(deriveThreadState([])).toBe('open');
    const events = [
      { kind: 'comment' },
      { kind: 'sent' },
      { kind: 'send-failed' },
      { kind: 'sent' },
      { kind: 'agent-reply' },
      { kind: 'resolved' },
      { kind: 'reopened' },
    ] as const;
    expect(deriveThreadState(events)).toBe('open');
    expect(deriveThreadState(events.slice(0, -1))).toBe('resolved');
  });
});

describe('relocateTextQuote', () => {
  test('returns exact and moved half-open positions without rewriting the quote', () => {
    expect(relocateTextQuote('the quote ends', quote)).toEqual({
      status: 'exact',
      start: 4,
      end: 9,
    });
    expect(relocateTextQuote('now the quote ends', quote)).toEqual({
      status: 'moved',
      start: 8,
      end: 13,
    });
    expect(relocateTextQuote('a quote elsewhere', quote)).toEqual({
      status: 'moved',
      start: 2,
      end: 7,
    });
  });
  test('uses prefix and suffix together to select one repeated quote', () => {
    expect(relocateTextQuote('a quote starts; the quote ends', quote)).toEqual({
      status: 'moved',
      start: 20,
      end: 25,
    });
    expect(relocateTextQuote('the quote starts; a quote ends', quote)).toEqual({
      status: 'ambiguous',
    });
  });
  test('refuses to choose an ambiguous quote even if an occurrence keeps its old offset', () => {
    expect(relocateTextQuote('the quote ends; the quote ends', quote)).toEqual({
      status: 'ambiguous',
    });
    expect(
      relocateTextQuote('quote quote', { ...quote, prefix: '', suffix: '' }),
    ).toEqual({ status: 'ambiguous' });
    expect(
      relocateTextQuote('aaa', {
        kind: 'text-quote',
        start: 0,
        end: 2,
        exact: 'aa',
        prefix: '',
        suffix: '',
      }),
    ).toEqual({ status: 'ambiguous' });
  });
  test('reports missing for absent, edited or case-changed text', () => {
    for (const text of ['', 'the quotation ends', 'the Quote ends'])
      expect(relocateTextQuote(text, quote)).toEqual({ status: 'missing' });
  });
});

function thread(kind: TaskReviewArtifactKind = 'plan'): Pick<
  TaskReviewThread,
  'artifact' | 'anchor' | 'quote'
> & {
  events: readonly Pick<TaskReviewEvent, 'kind'>[];
} {
  return {
    artifact: {
      kind,
      id: 'artifact-1',
      revision: 'v1',
      digest: `sha256:${'a'.repeat(64)}`,
    },
    anchor: quote,
    events: [],
  };
}
const currentPlan = {
  status: 'available',
  kind: 'plan',
  revision: 'v2',
  text: 'now the quote ends',
} as const;

describe('deriveOutdated', () => {
  test('keeps a relocatable quote current across plan and summary revision changes', () => {
    expect(deriveOutdated(thread(), currentPlan)).toBe(false);
    expect(
      deriveOutdated(thread('summary'), { ...currentPlan, kind: 'summary' }),
    ).toBe(false);
    expect(
      deriveOutdated(thread(), { ...currentPlan, text: 'the quote ends' }),
    ).toBe(false);
  });
  test('marks missing or ambiguous quotes outdated only on a different revision and while unresolved', () => {
    for (const text of ['changed', 'the quote ends; the quote ends']) {
      for (const kind of ['comment', 'sent', 'agent-reply'] as const) {
        expect(
          deriveOutdated(
            { ...thread(), events: [{ kind }] },
            { ...currentPlan, text },
          ),
        ).toBe(true);
      }
      expect(
        deriveOutdated(thread(), { ...currentPlan, text, revision: 'v1' }),
      ).toBe(false);
      expect(
        deriveOutdated(
          { ...thread(), events: [{ kind: 'resolved' }] },
          { ...currentPlan, text },
        ),
      ).toBe(false);
    }
  });
  test('keeps unavailable or mismatched mutable artifact reads unknown, including after send', () => {
    for (const kind of ['plan', 'summary', 'output'] as const) {
      expect(
        deriveOutdated(
          { ...thread(kind), events: [{ kind: 'sent' }] },
          { status: 'unavailable' },
        ),
      ).toBe('unknown');
      expect(
        deriveOutdated(
          { ...thread(kind), events: [{ kind: 'resolved' }] },
          { status: 'unavailable' },
        ),
      ).toBe(false);
    }
    expect(deriveOutdated(thread(), { ...currentPlan, kind: 'summary' })).toBe(
      'unknown',
    );
  });
  test('uses retained block or whole quotes and leaves quote-free changed revisions unknown', () => {
    for (const anchor of [
      { kind: 'block', startLine: 1, endLine: 1 },
      { kind: 'whole' },
    ] as const) {
      expect(
        deriveOutdated({ ...thread(), anchor, quote: 'quote' }, currentPlan),
      ).toBe(false);
      expect(
        deriveOutdated({ ...thread(), anchor, quote: 'removed' }, currentPlan),
      ).toBe(true);
      expect(deriveOutdated({ ...thread(), anchor }, currentPlan)).toBe(
        'unknown',
      );
    }
  });
  test('uses newer output provenance rather than revision inequality', () => {
    const current: TaskReviewCurrentArtifact = {
      status: 'available',
      kind: 'output',
      revision: 'v2',
      newerOutputWithSamePath: false,
    };
    expect(deriveOutdated(thread('output'), current)).toBe(false);
    expect(
      deriveOutdated(thread('output'), {
        ...current,
        revision: 'v1',
        newerOutputWithSamePath: true,
      }),
    ).toBe(true);
    expect(
      deriveOutdated(
        { ...thread('output'), events: [{ kind: 'resolved' }] },
        { ...current, newerOutputWithSamePath: true },
      ),
    ).toBe(false);
  });
  test('never marks immutable answers or captures outdated, even when their read is unavailable', () => {
    for (const kind of ['answer', 'capture'] as const) {
      expect(deriveOutdated(thread(kind), { status: 'unavailable' })).toBe(
        false,
      );
      expect(
        deriveOutdated(thread(kind), {
          status: 'available',
          kind,
          revision: 'v2',
        }),
      ).toBe(false);
    }
  });
});
