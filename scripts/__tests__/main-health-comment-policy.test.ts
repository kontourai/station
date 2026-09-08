import { describe, expect, it } from 'vitest';
import {
  applyMainHealthState,
  decideMainHealthComment,
  HEARTBEAT_INTERVAL_MS,
  parseMainHealthState,
  summarizeRunFailure,
} from '../main-health-comment-policy.mjs';

const RUN = {
  workflowName: 'Backlog disposition policy',
  runUrl: 'https://github.com/kontourai/station/actions/runs/1',
  headSha: 'a'.repeat(40),
};

const START = Date.parse('2026-09-08T00:00:00.000Z');

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

/**
 * A comment stream the decisions are actually applied to, exactly as
 * main-health.yml applies them: `create-comment` appends, `update-marker`
 * rewrites the body of the comment it names. Asserting against a hand-written
 * "previous comment" would test the reducer against a fixture the workflow
 * never produces; this tests it against its own output.
 */
class Tracker {
  comments: { id: number; body: string }[] = [];
  nextId = 100;

  run(input: { failures: string[]; reopened?: boolean; now: number }) {
    const decision = decideMainHealthComment({
      ...RUN,
      failures: input.failures,
      reopened: input.reopened ?? false,
      comments: this.comments,
      now: input.now,
    });
    if (decision.action === 'create-comment') {
      this.comments.push({ id: this.nextId++, body: decision.body });
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
    ).toEqual(['policy > Run the gate (failure)']);
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

  it('cannot let a job name terminate the marker that carries it', () => {
    const [label] = summarizeRunFailure([
      { name: 'evil --> injected', conclusion: 'failure', steps: [] },
    ]);
    expect(label).not.toContain('-->');
    const body = applyMainHealthState('lead', {
      failures: [label],
      redRunsSinceComment: 0,
      commentedAt: new Date(START).toISOString(),
    });
    expect(parseMainHealthState(body)?.failures).toEqual([label]);
  });
});

describe('main-health comment policy transitions', () => {
  it('comments on the first red after a green closed the tracker', () => {
    const tracker = new Tracker();
    // Seed the state a previous red left behind, then close-and-reopen with
    // the SAME failure inside the quiet window. Only `reopened` distinguishes
    // this from the silent case below, so the assertion has power.
    tracker.run({ failures: ['policy > Run the gate (failure)'], now: START });
    const decision = tracker.run({
      failures: ['policy > Run the gate (failure)'],
      reopened: true,
      now: START + 60_000,
    });

    expect(decision.action).toBe('create-comment');
    expect(decision.reason).toBe('reopened-after-green');
    expect(tracker.comments).toHaveLength(2);
  });

  it('says nothing for the same failure inside the heartbeat window', () => {
    const tracker = new Tracker();
    tracker.run({ failures: ['policy > Run the gate (failure)'], now: START });
    const decision = tracker.run({
      failures: ['policy > Run the gate (failure)'],
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

  it('posts one heartbeat after 24h, counting the runs it stayed quiet for', () => {
    const tracker = new Tracker();
    const failures = ['policy > Run the gate (failure)'];
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
    tracker.run({ failures: ['policy > Run the gate (failure)'], now: START });
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
    }));
    const failures = ['policy > Run the gate (failure)'];

    const first = tracker.run({ failures, now: START });
    expect(first.action).toBe('create-comment');
    expect(first.reason).toBe('no-recorded-state');

    const second = tracker.run({ failures, now: START + 60_000 });
    expect(second.action).toBe('update-marker');
    expect(tracker.comments).toHaveLength(327);
  });
});

describe('recorded state is read back only when it is trustworthy', () => {
  const validState = {
    failures: ['policy > Run the gate (failure)'],
    redRunsSinceComment: 3,
    commentedAt: new Date(START).toISOString(),
  };

  it('round-trips through the comment body', () => {
    expect(
      parseMainHealthState(applyMainHealthState('lead', validState)),
    ).toEqual(validState);
  });

  it('replaces the marker rather than accumulating one per run', () => {
    const once = applyMainHealthState('lead', validState);
    const twice = applyMainHealthState(once, {
      ...validState,
      redRunsSinceComment: 4,
    });
    expect(twice.match(/main-health-state:/g)).toHaveLength(1);
    expect(parseMainHealthState(twice)?.redRunsSinceComment).toBe(4);
  });

  it.each([
    ['no marker at all', 'The workflow failed again on main.'],
    ['malformed JSON', '<!-- main-health-state: {"failures":[ -->'],
    [
      'a non-string failure label',
      '<!-- main-health-state: {"failures":[7],"redRunsSinceComment":0,"commentedAt":"2026-09-08T00:00:00.000Z"} -->',
    ],
    [
      'an unparseable timestamp',
      '<!-- main-health-state: {"failures":[],"redRunsSinceComment":0,"commentedAt":"never"} -->',
    ],
    [
      'a negative run count',
      '<!-- main-health-state: {"failures":[],"redRunsSinceComment":-1,"commentedAt":"2026-09-08T00:00:00.000Z"} -->',
    ],
  ])('treats %s as no recorded state, which comments', (_label, body) => {
    expect(parseMainHealthState(body)).toBeNull();
    const decision = decideMainHealthComment({
      ...RUN,
      failures: ['policy > Run the gate (failure)'],
      comments: [{ id: 1, body }],
      now: START,
    });
    // Unreadable state must never resolve to silence on a red main.
    expect(decision.action).toBe('create-comment');
    expect(decision.reason).toBe('no-recorded-state');
  });

  it('reads the most recent marker, not the first', () => {
    const older = applyMainHealthState('older', {
      ...validState,
      failures: ['old (failure)'],
    });
    const newer = applyMainHealthState('newer', validState);
    const decision = decideMainHealthComment({
      ...RUN,
      failures: validState.failures,
      comments: [
        { id: 1, body: older },
        { id: 2, body: newer },
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
      failures: validState.failures,
      comments: [{ id: 1, body: applyMainHealthState('lead', validState) }],
      now: START - 60_000,
    });

    expect(decision.action).toBe('create-comment');
    expect(decision.reason).toBe('heartbeat');
  });
});
