import { describe, expect, it } from 'vitest';
import {
  decideMainHealthComment,
  failureDigest,
  HEARTBEAT_INTERVAL_MS,
  MAX_TRACKED_FAILURES,
  parseMainHealthState,
  renderMainHealthComment,
  summarizeRunFailure,
} from '../main-health-comment-policy.mjs';

const RUN = {
  workflowName: 'Backlog disposition policy',
  runUrl: 'https://github.com/kontourai/station/actions/runs/1',
  headSha: 'a'.repeat(40),
};

const START = Date.parse('2026-09-08T00:00:00.000Z');
const BOT = { type: 'Bot', login: 'github-actions[bot]' };
const HUMAN = { type: 'User', login: 'briananderson1222' };
const GATE_FAILURE = 'policy > Run the gate (failure)';

function jobs(...failing: { job: string; step?: string }[]) {
  return [
    { name: 'setup', conclusion: 'success', steps: [] },
    ...failing.map(({ job, step }) => ({
      name: job,
      conclusion: 'failure',
      steps: step
        ? [
            { name: 'Checkout', conclusion: 'success' },
            { name: step, conclusion: 'failure' },
          ]
        : [],
    })),
  ];
}

function stateFor(failures: string[], overrides: Record<string, unknown> = {}) {
  return {
    lead: 'The workflow failed again on main.',
    failures: failures.slice(0, MAX_TRACKED_FAILURES),
    failureCount: failures.length,
    digest: failureDigest(failures),
    redRunsSinceComment: 0,
    commentedAt: new Date(START).toISOString(),
    ...overrides,
  };
}

/**
 * A comment stream the decisions are actually applied to, exactly as
 * main-health.yml applies them: `create-comment` appends, `update-marker`
 * rewrites the body of the comment it names. Asserting against a hand-written
 * "previous comment" would test the reducer against a fixture the workflow
 * never produces; this tests it against its own output.
 */
class Tracker {
  comments: { id: number; body: string; user: typeof BOT | typeof HUMAN }[] =
    [];
  nextId = 100;

  run(input: {
    failures: string[];
    reopened?: boolean;
    now: number;
    runUrl?: string;
  }) {
    const decision = decideMainHealthComment({
      ...RUN,
      runUrl: input.runUrl ?? RUN.runUrl,
      failures: input.failures,
      reopened: input.reopened ?? false,
      comments: this.comments,
      now: input.now,
    });
    if (decision.action === 'create-comment') {
      this.comments.push({
        id: this.nextId++,
        body: decision.body,
        user: BOT,
      });
    } else {
      const target = this.comments.find(
        (comment) => comment.id === decision.commentId,
      );
      if (!target) throw new Error('update-marker named an unknown comment');
      target.body = decision.body;
    }
    return decision;
  }

  get bodies() {
    return this.comments.map((comment) => comment.body);
  }
}

describe('summarizeRunFailure', () => {
  it('names the failing step, not just the failing job', () => {
    expect(
      summarizeRunFailure(jobs({ job: 'policy', step: 'Run the gate' })),
    ).toEqual([GATE_FAILURE]);
  });

  it('ignores successful and skipped jobs', () => {
    expect(
      summarizeRunFailure([
        { name: 'a', conclusion: 'success', steps: [] },
        { name: 'b', conclusion: 'skipped', steps: [] },
      ]),
    ).toEqual([]);
  });

  it('falls back to the job when no step recorded a failure', () => {
    expect(
      summarizeRunFailure([
        { name: 'runner', conclusion: 'startup_failure', steps: [] },
      ]),
    ).toEqual(['runner (startup_failure)']);
  });

  it('reports every failure, so the digest sees past the display cap', () => {
    const many = Array.from({ length: 25 }, (_, index) => ({
      name: `job${String(index).padStart(2, '0')}`,
      conclusion: 'failure',
      steps: [],
    }));
    expect(summarizeRunFailure(many)).toHaveLength(25);
  });

  it('cannot let a job name terminate the marker that carries it', () => {
    const [label] = summarizeRunFailure([
      { name: 'evil --> injected', conclusion: 'failure', steps: [] },
    ]);
    expect(label).not.toContain('-->');
    const body = renderMainHealthComment(RUN, stateFor([label]));
    expect(parseMainHealthState(body)?.failures).toEqual([label]);
  });
});

describe('main-health comment policy transitions', () => {
  it('comments on the first red after a green closed the tracker', () => {
    const tracker = new Tracker();
    // Seed the state a previous red left behind, then close-and-reopen with
    // the SAME failure inside the quiet window. Only `reopened` distinguishes
    // this from the silent case below, so the assertion has power.
    tracker.run({ failures: [GATE_FAILURE], now: START });
    const decision = tracker.run({
      failures: [GATE_FAILURE],
      reopened: true,
      now: START + 60_000,
    });

    expect(decision.action).toBe('create-comment');
    expect(decision.reason).toBe('reopened-after-green');
    expect(tracker.comments).toHaveLength(2);
  });

  it('posts no new comment for the same failure inside the heartbeat window', () => {
    const tracker = new Tracker();
    tracker.run({ failures: [GATE_FAILURE], now: START });
    const decision = tracker.run({
      failures: [GATE_FAILURE],
      now: START + HEARTBEAT_INTERVAL_MS - 1,
    });

    expect(decision.action).toBe('update-marker');
    expect(decision.reason).toBe('unchanged');
    expect(tracker.comments).toHaveLength(1);
    expect(parseMainHealthState(tracker.bodies[0])).toMatchObject({
      redRunsSinceComment: 1,
      commentedAt: new Date(START).toISOString(),
    });
  });

  it('refreshes the visible run link and count on a silent run', () => {
    const tracker = new Tracker();
    tracker.run({
      failures: [GATE_FAILURE],
      now: START,
      runUrl: 'https://example.test/run/first',
    });
    tracker.run({
      failures: [GATE_FAILURE],
      now: START + 60_000,
      runUrl: 'https://example.test/run/second',
    });
    tracker.run({
      failures: [GATE_FAILURE],
      now: START + 120_000,
      runUrl: 'https://example.test/run/third',
    });

    // One comment, but it points at the newest run and says how many reds it
    // now stands for — the count is a visible fact, not only a hidden one.
    expect(tracker.comments).toHaveLength(1);
    const [body] = tracker.bodies;
    expect(body).toContain('Run: https://example.test/run/third');
    expect(body).not.toContain('run/first');
    expect(body).toContain('2 further red runs since this comment');
  });

  it('posts one heartbeat after 24h, counting the runs it stayed quiet for', () => {
    const tracker = new Tracker();
    const failures = [GATE_FAILURE];
    tracker.run({ failures, now: START });
    // Three silent runs — the scheduled advisory floor's real six-hourly
    // cadence. The 24h mark itself is heartbeat-due, so the window stops
    // short of it and the fourth red run below is the one that speaks.
    for (let hour = 6; hour <= 18; hour += 6) {
      tracker.run({ failures, now: START + hour * 60 * 60 * 1000 });
    }
    expect(tracker.comments).toHaveLength(1);

    const decision = tracker.run({
      failures,
      now: START + HEARTBEAT_INTERVAL_MS + 1,
    });

    expect(decision.action).toBe('create-comment');
    expect(decision.reason).toBe('heartbeat');
    expect(decision.body).toContain('4 red runs since the last comment');
    expect(tracker.comments).toHaveLength(2);
    // The heartbeat restarts the count, so the next window reports its own.
    expect(parseMainHealthState(decision.body)?.redRunsSinceComment).toBe(0);
  });

  it('comments when a different step fails, however soon', () => {
    const tracker = new Tracker();
    tracker.run({ failures: [GATE_FAILURE], now: START });
    const decision = tracker.run({
      failures: ['policy > Publish the report (failure)'],
      now: START + 60_000,
    });

    expect(decision.action).toBe('create-comment');
    expect(decision.reason).toBe('failure-changed');
    expect(decision.body).toContain('- policy > Publish the report (failure)');
    expect(tracker.comments).toHaveLength(2);
  });

  it('comments once on a tracker that predates the policy, then goes quiet', () => {
    // #924's shape: hundreds of markerless comments already on the issue.
    const tracker = new Tracker();
    tracker.comments = Array.from({ length: 326 }, (_, index) => ({
      id: index + 1,
      body: 'The workflow failed again on main.',
      user: BOT,
    }));
    const failures = [GATE_FAILURE];

    const first = tracker.run({ failures, now: START });
    expect(first.action).toBe('create-comment');
    expect(first.reason).toBe('no-recorded-state');

    const second = tracker.run({ failures, now: START + 60_000 });
    expect(second.action).toBe('update-marker');
    expect(tracker.comments).toHaveLength(327);
  });
});

describe('a changed failure is never silent, past the display cap', () => {
  const twentyFive = Array.from(
    { length: 25 },
    (_, index) => `job${String(index).padStart(2, '0')} (failure)`,
  );

  it('sees a new failure whose sorted position is past the cap', () => {
    // The first 20 sorted labels are identical in both runs; only the tail
    // differs. Comparing the displayed list would call this "unchanged".
    const next = [...twentyFive.slice(0, 20), 'zzz-brand-new (failure)'];
    const decision = decideMainHealthComment({
      ...RUN,
      failures: next,
      comments: [
        {
          id: 1,
          body: renderMainHealthComment(RUN, stateFor(twentyFive)),
          user: BOT,
        },
      ],
      now: START + 1000,
    });

    expect(decision.action).toBe('create-comment');
    expect(decision.reason).toBe('failure-changed');
  });

  it('still stays quiet when the untruncated set really is identical', () => {
    const decision = decideMainHealthComment({
      ...RUN,
      failures: [...twentyFive].reverse(),
      comments: [
        {
          id: 1,
          body: renderMainHealthComment(RUN, stateFor(twentyFive)),
          user: BOT,
        },
      ],
      now: START + 1000,
    });

    expect(decision.action).toBe('update-marker');
  });

  it('tells the reader the display list was truncated', () => {
    const body = renderMainHealthComment(RUN, stateFor(twentyFive));
    expect(body).toContain('- …and 5 more');
  });
});

describe('only a bot comment may carry the tracker state', () => {
  const botBody = renderMainHealthComment(
    RUN,
    stateFor([GATE_FAILURE], { redRunsSinceComment: 4 }),
  );
  // GitHub's "Quote reply" copies the raw markdown of the quoted comment,
  // HTML comments included — so a maintainer quoting the tracker reproduces
  // the marker verbatim inside their own comment.
  const quoteReply = `${botBody
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')}\n\nI am looking at this.`;

  it('never anchors state to a human comment that copied the marker', () => {
    const decision = decideMainHealthComment({
      ...RUN,
      failures: [GATE_FAILURE],
      comments: [
        { id: 7, body: botBody, user: BOT },
        { id: 8, body: quoteReply, user: HUMAN },
      ],
      now: START + 1000,
    });

    // Without the author check this picks 8 and rewrites the maintainer's
    // own comment on every silent red run, using `issues: write`.
    expect(decision.action).toBe('update-marker');
    expect(decision.commentId).toBe(7);
  });

  // Quote reply is not the only way a marker reaches a human's comment: a
  // maintainer can paste the tracker's text, and an issue-transfer or a
  // template can carry it verbatim. These two cases isolate the author check
  // from the quote-stripping one — with the marker UNQUOTED, authorship is
  // the only thing standing between the bot and editing someone else's
  // comment. (Written after removing the author check left the quote-reply
  // test green: the quoted fixture was covered by the other defence.)
  const pastedByHuman = `Copying this for reference:\n\n${botBody}`;

  it('never anchors state to a human comment that pasted the marker unquoted', () => {
    const decision = decideMainHealthComment({
      ...RUN,
      failures: [GATE_FAILURE],
      comments: [
        { id: 7, body: botBody, user: BOT },
        { id: 8, body: pastedByHuman, user: HUMAN },
      ],
      now: START + 1000,
    });

    expect(decision.action).toBe('update-marker');
    expect(decision.commentId).toBe(7);
  });

  it('comments when only a human carries an unquoted marker', () => {
    const decision = decideMainHealthComment({
      ...RUN,
      failures: [GATE_FAILURE],
      comments: [{ id: 8, body: pastedByHuman, user: HUMAN }],
      now: START + 1000,
    });

    expect(decision.action).toBe('create-comment');
    expect(decision.reason).toBe('no-recorded-state');
  });

  it('finds the bot comment when it is the only one', () => {
    const decision = decideMainHealthComment({
      ...RUN,
      failures: [GATE_FAILURE],
      comments: [{ id: 7, body: botBody, user: BOT }],
      now: START + 1000,
    });

    expect(decision.action).toBe('update-marker');
    expect(decision.commentId).toBe(7);
  });

  it('comments rather than editing when only a human carries the marker', () => {
    const decision = decideMainHealthComment({
      ...RUN,
      failures: [GATE_FAILURE],
      comments: [{ id: 8, body: quoteReply, user: HUMAN }],
      now: START + 1000,
    });

    expect(decision.action).toBe('create-comment');
    expect(decision.reason).toBe('no-recorded-state');
  });

  it('ignores a marker the bot itself only quoted', () => {
    const decision = decideMainHealthComment({
      ...RUN,
      failures: [GATE_FAILURE],
      comments: [{ id: 9, body: quoteReply, user: BOT }],
      now: START + 1000,
    });

    expect(decision.action).toBe('create-comment');
    expect(decision.reason).toBe('no-recorded-state');
  });
});

describe('recorded state is read back only when it is trustworthy', () => {
  const validState = stateFor([GATE_FAILURE], { redRunsSinceComment: 3 });

  it('round-trips through the comment body', () => {
    expect(
      parseMainHealthState(renderMainHealthComment(RUN, validState)),
    ).toEqual(validState);
  });

  it.each([
    ['no marker at all', 'The workflow failed again on main.'],
    ['malformed JSON', '<!-- main-health-state: {"failures":[ -->'],
    [
      'a non-string failure label',
      '<!-- main-health-state: {"lead":"x","failures":[7],"failureCount":1,"digest":"d","redRunsSinceComment":0,"commentedAt":"2026-09-08T00:00:00.000Z"} -->',
    ],
    [
      'no digest to compare against',
      '<!-- main-health-state: {"lead":"x","failures":[],"failureCount":0,"redRunsSinceComment":0,"commentedAt":"2026-09-08T00:00:00.000Z"} -->',
    ],
    [
      'a failure count smaller than the list it summarizes',
      '<!-- main-health-state: {"lead":"x","failures":["a","b"],"failureCount":1,"digest":"d","redRunsSinceComment":0,"commentedAt":"2026-09-08T00:00:00.000Z"} -->',
    ],
    [
      'an unparseable timestamp',
      '<!-- main-health-state: {"lead":"x","failures":[],"failureCount":0,"digest":"d","redRunsSinceComment":0,"commentedAt":"never"} -->',
    ],
    [
      'a negative run count',
      '<!-- main-health-state: {"lead":"x","failures":[],"failureCount":0,"digest":"d","redRunsSinceComment":-1,"commentedAt":"2026-09-08T00:00:00.000Z"} -->',
    ],
  ])('treats %s as no recorded state, which comments', (_label, body) => {
    expect(parseMainHealthState(body)).toBeNull();
    const decision = decideMainHealthComment({
      ...RUN,
      failures: [GATE_FAILURE],
      comments: [{ id: 1, body, user: BOT }],
      now: START,
    });
    // Unreadable state must never resolve to silence on a red main.
    expect(decision.action).toBe('create-comment');
    expect(decision.reason).toBe('no-recorded-state');
  });

  it('reads the most recent marker, not the first', () => {
    const decision = decideMainHealthComment({
      ...RUN,
      failures: [GATE_FAILURE],
      comments: [
        {
          id: 1,
          body: renderMainHealthComment(RUN, stateFor(['old (failure)'])),
          user: BOT,
        },
        { id: 2, body: renderMainHealthComment(RUN, validState), user: BOT },
      ],
      now: START + 1000,
    });

    expect(decision.action).toBe('update-marker');
    expect(decision.commentId).toBe(2);
    expect(decision.state.redRunsSinceComment).toBe(4);
  });

  it('comments rather than staying silent when the recorded time is in the future', () => {
    const decision = decideMainHealthComment({
      ...RUN,
      failures: [GATE_FAILURE],
      comments: [
        { id: 1, body: renderMainHealthComment(RUN, validState), user: BOT },
      ],
      now: START - 60_000,
    });

    expect(decision.action).toBe('create-comment');
    expect(decision.reason).toBe('heartbeat');
  });
});
