import { describe, expect, test } from 'vitest';
import {
  digestText,
  FAST_CHECKS_PART_JOBS,
  FAST_CHECKS_PLAN_KIND,
  FAST_CHECKS_RECEIPT_KIND,
  FAST_CHECKS_SHARD_COUNT,
  parseFastChecksShard,
  sliceFastChecksPlan,
  validateFastChecksPlan,
  validateFastChecksReceipt,
  verifyFastChecks,
} from '../lib/fast-checks-shards.mjs';

const HEAD = 'a'.repeat(40);
const RUN_ID = '4242';

type Plan = {
  schemaVersion: number;
  kind: string;
  base: string;
  headSha: string;
  shardCount: number;
  deferredLanes: Array<{ id: string; reasons: string[] }>;
  groups: Array<{ resourceGroup: string; files: string[] }>;
  fileCount: number;
};

function plan(
  groups: Plan['groups'],
  { deferred = false, shardCount = FAST_CHECKS_SHARD_COUNT } = {},
): Plan {
  return {
    schemaVersion: 1,
    kind: FAST_CHECKS_PLAN_KIND,
    base: 'base-sha',
    headSha: HEAD,
    shardCount,
    deferredLanes: deferred
      ? [{ id: 'test-full', reasons: ['escalation: pnpm-lock.yaml'] }]
      : [],
    groups,
    fileCount: groups.reduce((total, group) => total + group.files.length, 0),
  };
}

const SEVEN_FILES = plan([
  {
    resourceGroup: 'ordinary',
    files: ['a/a.test.ts', 'a/b.test.ts', 'a/c.test.ts', 'a/d.test.ts'],
  },
  {
    resourceGroup: 'process-heavy',
    files: ['b/e.test.ts', 'b/f.test.ts'],
  },
  { resourceGroup: 'process-exclusive', files: ['c/g.test.ts'] },
]);

function receiptsFor(
  subject: Plan,
  planText: string,
  overrides: Record<number, Record<string, unknown>> = {},
) {
  return Array.from({ length: subject.shardCount }, (_, offset) => {
    const index = offset + 1;
    const { files } = sliceFastChecksPlan(subject, {
      index,
      count: subject.shardCount,
    });
    const status = files.length ? 'completed' : 'empty';
    return {
      path: `receipts/fast-checks-receipt-${index}/fast-checks-shard-receipt.json`,
      text: JSON.stringify({
        schemaVersion: 1,
        kind: FAST_CHECKS_RECEIPT_KIND,
        shard: `${index}/${subject.shardCount}`,
        runId: RUN_ID,
        runAttempt: 1,
        headSha: HEAD,
        planSha256: digestText(planText),
        status,
        passed: true,
        files,
        counts: {
          executed: files.length,
          passed: files.length,
          failed: 0,
          infrastructureErrors: 0,
        },
        ...overrides[index],
      }),
    };
  });
}

const successNeeds = Object.fromEntries([
  ['classify', { result: 'skipped' }],
  ...FAST_CHECKS_PART_JOBS.map((job) => [job, { result: 'success' }]),
]);

function verify({
  subject = SEVEN_FILES,
  needs = successNeeds as Record<string, { result: string }>,
  overrides = {} as Record<number, Record<string, unknown>>,
  mutateReceipts = (receipts: Array<{ path: string; text: string }>) =>
    receipts,
} = {}) {
  const planText = `${JSON.stringify(subject, null, 2)}\n`;
  return verifyFastChecks({
    needs,
    planText,
    receipts: mutateReceipts(receiptsFor(subject, planText, overrides)),
    shardCount: subject.shardCount,
    runId: RUN_ID,
    headSha: HEAD,
  });
}

describe('fast-checks shard slicing', () => {
  test('parses exactly k/n within bounds', () => {
    expect(parseFastChecksShard('3/4')).toEqual({ index: 3, count: 4 });
    for (const value of ['0/4', '5/4', '4', '1/17', '01/4', '1/4 ', '-1/4'])
      expect(() => parseFastChecksShard(value), value).toThrow(
        /fast-checks shard must be/,
      );
  });

  test('deals round-robin across group boundaries and regroups each slice', () => {
    expect(sliceFastChecksPlan(SEVEN_FILES, { index: 1, count: 4 })).toEqual({
      groups: [
        { resourceGroup: 'ordinary', files: ['a/a.test.ts'] },
        { resourceGroup: 'process-heavy', files: ['b/e.test.ts'] },
      ],
      files: ['a/a.test.ts', 'b/e.test.ts'],
    });
    // The rotation continues into the serial group rather than restarting,
    // so its single file lands on shard 3, not always shard 1.
    expect(sliceFastChecksPlan(SEVEN_FILES, { index: 3, count: 4 })).toEqual({
      groups: [
        { resourceGroup: 'ordinary', files: ['a/c.test.ts'] },
        { resourceGroup: 'process-exclusive', files: ['c/g.test.ts'] },
      ],
      files: ['a/c.test.ts', 'c/g.test.ts'],
    });
  });

  test('is deterministic, disjoint and exhaustive for every shard count', () => {
    const all = SEVEN_FILES.groups.flatMap((group) => group.files);
    for (let count = 1; count <= 16; count += 1) {
      const slices = Array.from({ length: count }, (_, offset) =>
        sliceFastChecksPlan(SEVEN_FILES, { index: offset + 1, count }),
      );
      const union = slices.flatMap((slice) => slice.files);
      expect(new Set(union).size, `count ${count}`).toBe(union.length);
      expect([...union].sort(), `count ${count}`).toEqual([...all].sort());
      expect(
        Array.from({ length: count }, (_, offset) =>
          sliceFastChecksPlan(SEVEN_FILES, { index: offset + 1, count }),
        ),
      ).toEqual(slices);
    }
  });

  test('gives a shard beyond the plan an empty slice rather than an error', () => {
    const small = plan([
      { resourceGroup: 'ordinary', files: ['a/a.test.ts', 'a/b.test.ts'] },
    ]);
    expect(sliceFastChecksPlan(small, { index: 4, count: 4 })).toEqual({
      groups: [],
      files: [],
    });
  });
});

describe('fast-checks plan and receipt validation', () => {
  test('accepts a well-formed plan and a deferred empty plan', () => {
    expect(validateFastChecksPlan(SEVEN_FILES)).toEqual([]);
    expect(validateFastChecksPlan(plan([], { deferred: true }))).toEqual([]);
  });

  test.each([
    ['an undeferred empty plan', plan([]), 'an undeferred plan must select'],
    [
      'a duplicated test',
      plan([
        { resourceGroup: 'ordinary', files: ['a/a.test.ts'] },
        { resourceGroup: 'process-heavy', files: ['a/a.test.ts'] },
      ]),
      'plan names a test twice',
    ],
    [
      'an unsafe path',
      plan([{ resourceGroup: 'ordinary', files: ['../escape.test.ts'] }]),
      'unsafe test path',
    ],
    [
      'a miscounted plan',
      { ...SEVEN_FILES, fileCount: 6 },
      'fileCount 6 does not match 7',
    ],
    [
      'a short head sha',
      { ...SEVEN_FILES, headSha: 'abc' },
      'headSha must be a full commit sha',
    ],
  ])('rejects %s', (_name, subject, message) => {
    expect(validateFastChecksPlan(subject).join('\n')).toContain(message);
  });

  test('rejects a receipt whose passed flag disagrees with its status', () => {
    const [receipt] = receiptsFor(SEVEN_FILES, JSON.stringify(SEVEN_FILES)).map(
      ({ text }) => JSON.parse(text),
    );
    expect(validateFastChecksReceipt(receipt)).toEqual([]);
    expect(
      validateFastChecksReceipt({ ...receipt, status: 'failed' }),
    ).toContain('receipt passed must agree with its status');
  });
});

describe('fast-checks aggregate verdict', () => {
  test('passes when every part succeeded and every shard ran its slice', () => {
    const { findings, notes } = verify();
    expect(findings).toEqual([]);
    expect(notes).toHaveLength(FAST_CHECKS_SHARD_COUNT);
  });

  test('passes a deferred plan whose shards are all empty, and says so', () => {
    const { findings, notes } = verify({
      subject: plan([], { deferred: true }),
    });
    expect(findings).toEqual([]);
    expect(notes.join('\n')).toContain(
      'selection deferred to test-full; full-regression remains the required completion gate',
    );
    expect(notes.filter((note) => note.includes(': empty,'))).toHaveLength(4);
  });

  test.each([
    ['failure', "finished 'failure'"],
    ['skipped', "finished 'skipped'"],
    ['cancelled', "finished 'cancelled'"],
  ])('fails when a shard job %s', (result, message) => {
    const { findings } = verify({
      needs: { ...successNeeds, 'fast-checks-shard': { result } },
    });
    expect(findings.join('\n')).toContain(`fast-checks-shard ${message}`);
  });

  test('fails when the statics or plan job did not report at all', () => {
    const { 'fast-checks-statics': _statics, ...withoutStatics } = successNeeds;
    expect(verify({ needs: withoutStatics }).findings.join('\n')).toContain(
      "fast-checks-statics finished 'missing'",
    );
  });

  test('fails on a failing shard receipt even when every job reported success', () => {
    const { findings } = verify({
      overrides: { 2: { status: 'failed', passed: false } },
    });
    expect(findings).toContain("shard 2/4 reported 'failed'");
  });

  test('fails on a missing receipt', () => {
    const { findings } = verify({
      mutateReceipts: (receipts) => receipts.filter((_, index) => index !== 3),
    });
    expect(findings).toContain('shard 4/4 left no receipt');
  });

  test('fails when the plan was computed for another commit than the checkout (review F3)', () => {
    const planText = `${JSON.stringify(SEVEN_FILES, null, 2)}\n`;
    const other = 'b'.repeat(40);
    const { findings } = verifyFastChecks({
      needs: successNeeds,
      planText,
      receipts: receiptsFor(SEVEN_FILES, planText),
      runId: RUN_ID,
      headSha: other,
    });
    // Every receipt agrees with the plan, so only the head check can fire.
    expect(findings).toEqual([
      `plan was computed for ${HEAD}, not the checked-out ${other}`,
    ]);
  });

  test('fails on a missing plan', () => {
    expect(
      verifyFastChecks({
        needs: successNeeds,
        planText: undefined,
        receipts: [],
        runId: RUN_ID,
        headSha: HEAD,
      }).findings,
    ).toContain('the fast-checks plan artifact is missing');
  });

  test.each([
    [
      'ran a different slice',
      { 1: { files: ['a/b.test.ts', 'b/e.test.ts'] } },
      'shard 1/4 ran 2 file(s), not its 2-file slice of the plan',
    ],
    [
      'ran another plan',
      { 1: { planSha256: 'f'.repeat(64) } },
      'shard 1/4 ran a different plan',
    ],
    [
      'ran another head',
      { 1: { headSha: 'b'.repeat(40) } },
      `shard 1/4 ran ${'b'.repeat(40)}`,
    ],
    [
      'called a non-empty slice empty',
      { 1: { status: 'empty' } },
      "shard 1/4 reported 'empty' for a 2-file slice",
    ],
  ])('fails when a shard %s', (_name, overrides, message) => {
    expect(verify({ overrides }).findings).toContain(message);
  });

  test('ignores a receipt from another run, so that shard is missing', () => {
    expect(verify({ overrides: { 3: { runId: '1' } } }).findings).toContain(
      'shard 3/4 left no receipt',
    );
  });

  test('uses the latest attempt when a failed shard was re-run', () => {
    const subject = SEVEN_FILES;
    const planText = `${JSON.stringify(subject, null, 2)}\n`;
    const receipts = receiptsFor(subject, planText);
    const retried = JSON.parse(receipts[1].text);
    const failedFirst = {
      path: 'receipts/attempt-1/fast-checks-shard-receipt.json',
      text: JSON.stringify({
        ...retried,
        status: 'failed',
        passed: false,
      }),
    };
    receipts[1] = {
      path: receipts[1].path,
      text: JSON.stringify({ ...retried, runAttempt: 2 }),
    };
    const base = {
      needs: successNeeds,
      planText,
      runId: RUN_ID,
      headSha: HEAD,
    };
    expect(
      verifyFastChecks({ ...base, receipts: [failedFirst, ...receipts] })
        .findings,
    ).toEqual([]);
    // ...and the reverse order of attempts fails.
    const passedFirst = { ...failedFirst, text: receipts[1].text };
    receipts[1] = {
      path: receipts[1].path,
      text: JSON.stringify({
        ...retried,
        runAttempt: 3,
        status: 'failed',
        passed: false,
      }),
    };
    expect(
      verifyFastChecks({ ...base, receipts: [passedFirst, ...receipts] })
        .findings,
    ).toContain("shard 2/4 reported 'failed'");
  });

  test('fails on two receipts for the same shard attempt', () => {
    const { findings } = verify({
      mutateReceipts: (receipts) => [...receipts, receipts[0]],
    });
    expect(findings).toContain('shard 1/4 has two receipts for attempt 1');
  });

  test('fails a plan split a different number of ways than required', () => {
    const subject = plan(SEVEN_FILES.groups, { shardCount: 2 });
    const planText = `${JSON.stringify(subject, null, 2)}\n`;
    expect(
      verifyFastChecks({
        needs: successNeeds,
        planText,
        receipts: receiptsFor(subject, planText),
        shardCount: FAST_CHECKS_SHARD_COUNT,
        runId: RUN_ID,
        headSha: HEAD,
      }).findings,
    ).toContain(
      `plan is split 2 ways, not the required ${FAST_CHECKS_SHARD_COUNT}`,
    );
  });
});
