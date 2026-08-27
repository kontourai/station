import { describe, expect, it } from 'vitest';
import { formatApprovalAge, render } from '../commands/operate/render.js';
import { initialState, reduce } from '../commands/operate/state.js';

/**
 * `render(state): string[]` tests for `station operate` (#168 Wave 1, Task
 * 1A) — asserts the four content panes (board, approvals, gates,
 * transcript) each appear as distinguishable line groups, and specifically
 * that a pending approval's rendered line contains a truncated `toolInput`
 * value (not just `toolName`) — the direct counter to the plan's stop-short
 * risk #2 ("approvals pane shows toolName only").
 */

function baseStateWithApproval() {
  let state = initialState({ focusedThreadId: 'thread-1' });
  state = reduce(state, {
    type: 'snapshot',
    sessions: [
      {
        threadId: 'thread-1',
        provider: 'claude',
        status: 'running',
        lastEventMethod: 'request.opened',
        updatedAt: '2026-07-05T00:00:00.000Z',
      },
    ],
  });
  state = reduce(state, {
    type: 'event',
    event: {
      threadId: 'thread-1',
      provider: 'claude',
      createdAt: '2026-07-05T00:00:00.000Z',
      requestId: 'req-1',
      method: 'request.opened',
      requestType: 'approval',
      title: 'Allow Bash',
      payload: {
        toolName: 'Bash',
        toolInput: { command: 'rm -rf tmp/scratch-dir' },
      },
    },
  });
  return state;
}

describe('operate/render', () => {
  it('renders the six sections as distinguishable line groups (SESSIONS/APPROVALS/GATES/TRANSCRIPT/FOOTER present)', () => {
    const lines = render(baseStateWithApproval());
    const joined = lines.join('\n');
    expect(joined).toContain('SESSIONS');
    expect(joined).toContain('APPROVALS');
    expect(joined).toContain('GATES');
    expect(joined).toContain('TRANSCRIPT');
    expect(joined).toContain('FOOTER');
  });

  it('renders the session board with the focused session marked', () => {
    const lines = render(baseStateWithApproval());
    expect(
      lines.some(
        (line) =>
          line.includes('> thread-1') && line.includes('provider=claude'),
      ),
    ).toBe(true);
  });

  it("renders a pending approval's line with both toolName AND a truncated toolInput (not toolName alone)", () => {
    const lines = render(baseStateWithApproval());
    const approvalLine = lines.find((line) => line.includes('req-1'));
    expect(approvalLine).toBeDefined();
    expect(approvalLine).toContain('Bash');
    expect(approvalLine).toContain('rm -rf tmp/scratch-dir');
  });

  it('truncates an overlong toolInput rather than dumping it unbounded', () => {
    let state = initialState({ focusedThreadId: 'thread-1' });
    state = reduce(state, {
      type: 'event',
      event: {
        threadId: 'thread-1',
        provider: 'claude',
        createdAt: '2026-07-05T00:00:00.000Z',
        requestId: 'req-long',
        method: 'request.opened',
        requestType: 'approval',
        title: 'Allow Bash',
        payload: { toolName: 'Bash', toolInput: { command: 'x'.repeat(500) } },
      },
    });
    const lines = render(state);
    const approvalLine = lines.find((line) => line.includes('req-long'));
    expect(approvalLine).toBeDefined();
    expect(approvalLine!.length).toBeLessThan(300);
    expect(approvalLine).toContain('…');
  });

  it('renders "not Flow-bound" for a session with no flow.run-attached event and no pulled snapshot', () => {
    const lines = render(baseStateWithApproval());
    expect(lines.some((line) => line.includes('not Flow-bound'))).toBe(true);
  });

  it('renders real gate verdict + openGates for a Flow-bound, gate-verdict-carrying session', () => {
    let state = baseStateWithApproval();
    state = reduce(state, {
      type: 'event',
      event: {
        threadId: 'thread-1',
        provider: 'claude',
        createdAt: '2026-07-05T00:00:01.000Z',
        method: 'flow.run-attached',
        runId: 'run-1',
        definitionId: 'builder.build',
        cwd: '/repo',
        resumed: false,
      },
    });
    state = reduce(state, {
      type: 'event',
      event: {
        threadId: 'thread-1',
        provider: 'claude',
        createdAt: '2026-07-05T00:00:02.000Z',
        method: 'flow.gate-verdict',
        runId: 'run-1',
        verdict: 'block',
        gateId: 'gate-review',
        summary: 'missing evidence',
      },
    });
    state = reduce(state, {
      type: 'flow-run-snapshot',
      threadId: 'thread-1',
      snapshot: {
        runId: 'run-1',
        definitionId: 'builder.build',
        currentStep: 'review',
        status: 'running',
        openGates: [{ id: 'gate-final', step: 'release' }],
      },
    });

    const lines = render(state);
    const joined = lines.join('\n');
    expect(joined).not.toContain('not Flow-bound');
    expect(joined).toContain('block');
    expect(joined).toContain('gate-review');
    expect(joined).toContain('gate-final@release');
  });

  /**
   * station#189: the GATES pane used to say only where a run sits. An
   * auto-attached run on a step with no gate holds `step=plan status=active`
   * forever, which reads as work in progress; the pane must state the gap.
   */
  it('renders a never-evaluated ungated run as an explicit gap, not as progress', () => {
    let state = baseStateWithApproval();
    state = reduce(state, {
      type: 'flow-run-snapshot',
      threadId: 'thread-1',
      snapshot: {
        runId: 'session-thread-1',
        definitionId: 'station-delivery',
        currentStep: 'plan',
        status: 'active',
        openGates: [],
        lastEvaluatedAt: null,
        blockedReason: 'ungated-step',
        gateOutcomeCount: 0,
        evidenceCount: 0,
      },
    });

    const joined = render(state).join('\n');
    expect(joined).toContain('Legacy delivery checks');
    expect(joined).not.toContain('station-delivery');
    expect(joined).not.toContain('session-thread-1');
    expect(joined).toContain('never evaluated — no gate on step `plan`');
    expect(joined).toContain('cannot advance');
  });

  /**
   * station#189 S4: the Builder run is a DISTINCT row. These tests exist
   * because the failure mode is a merge — one progress figure covering two
   * runs — so each asserts that the delivery-run line and the builder-run
   * line are both present and separately readable.
   */
  describe('builder run row (station#189 S4)', () => {
    function withDeliveryRun(state: ReturnType<typeof initialState>) {
      return reduce(state, {
        type: 'flow-run-snapshot',
        threadId: 'thread-1',
        snapshot: {
          runId: 'session-thread-1',
          definitionId: 'station-delivery',
          currentStep: 'plan',
          status: 'active',
          openGates: [],
          lastEvaluatedAt: null,
          blockedReason: 'ungated-step',
          gateOutcomeCount: 0,
          evidenceCount: 0,
        },
      });
    }

    it('renders the builder run on its own line, never merged with the delivery run', () => {
      let state = withDeliveryRun(baseStateWithApproval());
      state = reduce(state, {
        type: 'builder-run-snapshot',
        threadId: 'thread-1',
        builderRun: {
          identityStatus: 'present',
          matchKind: 'correlation-matched',
          taskSlug: 'kontourai-station-1388',
          runRef: '.kontourai/flow/runs/kontourai-station-1388',
          definitionId: 'builder.build',
          currentStep: 'verify',
          status: 'active',
          openGateIds: ['verify-gate'],
        },
      });

      const lines = render(state);
      const joined = lines.join('\n');
      // The stalled delivery run still reports its own stall...
      expect(joined).toContain('never evaluated — no gate on step `plan`');
      // ...and the builder run reports itself, separately.
      const builderLine = lines.find((line) =>
        line.includes('builder run: kontourai-station-1388'),
      );
      expect(builderLine).toBeDefined();
      expect(builderLine).toContain('identity=present');
      expect(builderLine).toContain('match=correlation-matched');
      expect(joined).toContain('builder.build  step=verify  status=active');
      expect(joined).toContain('verify-gate');
      // No freshness is claimed for a projection that carries no currency
      // stamp upstream.
      expect(joined).toContain('per last sidecar write');
    });

    it('renders an unjoinable session as unavailable with the reason, never a nearby run', () => {
      let state = withDeliveryRun(baseStateWithApproval());
      state = reduce(state, {
        type: 'builder-run-snapshot',
        threadId: 'thread-1',
        builderRun: {
          identityStatus: 'unavailable',
          matchKind: 'none',
          reason:
            "2 builder runs claim this session's runtime identity (a, b) — not guessing between them",
        },
      });

      const joined = render(state).join('\n');
      expect(joined).toContain('builder run: unavailable');
      expect(joined).toContain('match=none');
      expect(joined).toContain('not guessing between them');
      expect(joined).not.toContain('step=verify');
    });

    it('renders a joined task with no projected run as a join without progress', () => {
      let state = withDeliveryRun(baseStateWithApproval());
      state = reduce(state, {
        type: 'builder-run-snapshot',
        threadId: 'thread-1',
        builderRun: {
          identityStatus: 'unavailable',
          matchKind: 'started-by-station',
          reason: 'the builder run published no run-correlation envelope',
          taskSlug: 'just-picked-up',
        },
      });

      const joined = render(state).join('\n');
      expect(joined).toContain('builder run: just-picked-up');
      expect(joined).toContain('match=started-by-station');
      expect(joined).toContain('no run projection published for this task yet');
      expect(joined).not.toMatch(/builder run:.*step=/);
    });

    it('a broken binding shows its reason and NOT "no run projection yet" (review M3)', () => {
      // taskSlug + reason + no flowRun is reachable two ways, and they mean
      // opposite things. This is the sidecar-could-not-be-read one: claiming
      // "no run projection published for this task yet" above the real reason
      // asserts a currency nobody has and makes the row contradict itself.
      let state = withDeliveryRun(baseStateWithApproval());
      state = reduce(state, {
        type: 'builder-run-snapshot',
        threadId: 'thread-1',
        builderRun: {
          identityStatus: 'unavailable',
          matchKind: 'started-by-station',
          taskSlug: 'deleted-task',
          taskSidecarUnreadable: true,
          reason:
            'Station started this session against task `deleted-task`, whose sidecar is no longer readable in this workspace',
        },
      });

      const joined = render(state).join('\n');
      expect(joined).toContain('builder run: deleted-task');
      expect(joined).toContain('no longer readable in this workspace');
      expect(joined).not.toContain('no run projection published');
    });

    it('quotes the sidecar write time when the server sends one, and stays vague when it does not', () => {
      const base = withDeliveryRun(baseStateWithApproval());
      const projected = {
        identityStatus: 'present' as const,
        matchKind: 'started-by-station' as const,
        taskSlug: 'timed',
        definitionId: 'builder.build',
        currentStep: 'verify',
        status: 'active',
        openGateIds: [],
      };

      const timed = render(
        reduce(base, {
          type: 'builder-run-snapshot',
          threadId: 'thread-1',
          builderRun: {
            ...projected,
            sidecarUpdatedAt: '2026-08-01T11:22:33.000Z',
          },
        }),
      ).join('\n');
      expect(timed).toContain('per sidecar write at 2026-08-01T11:22:33.000Z');

      const untimed = render(
        reduce(base, {
          type: 'builder-run-snapshot',
          threadId: 'thread-1',
          builderRun: projected,
        }),
      ).join('\n');
      expect(untimed).toContain('(per last sidecar write)');
      expect(untimed).not.toContain('per sidecar write at');
    });

    it('says nothing about a builder run that has never been pulled', () => {
      const joined = render(withDeliveryRun(baseStateWithApproval())).join(
        '\n',
      );
      expect(joined).not.toContain('builder run');
    });

    it('renders the builder run even when the session has no Flow run at all', () => {
      // The common case after station-delivery's retirement: a Builder run
      // and no delivery run. Suppressing the row behind "not Flow-bound"
      // would hide the only run that exists.
      const state = reduce(baseStateWithApproval(), {
        type: 'builder-run-snapshot',
        threadId: 'thread-1',
        builderRun: {
          identityStatus: 'present',
          matchKind: 'started-by-station',
          taskSlug: 'kontourai-station-1388',
          definitionId: 'builder.build',
          currentStep: 'execute',
          status: 'active',
          openGateIds: [],
        },
      });

      const joined = render(state).join('\n');
      expect(joined).toContain('not Flow-bound');
      expect(joined).toContain('builder run: kontourai-station-1388');
    });

    it('distinguishes "pulled, nothing joined" from "never pulled"', () => {
      const state = reduce(baseStateWithApproval(), {
        type: 'builder-run-snapshot',
        threadId: 'thread-1',
        builderRun: null,
      });

      expect(render(state).join('\n')).toContain(
        'builder run: none joined to this session',
      );
    });
  });

  it('renders the evaluation time and counts once a gate has been evaluated', () => {
    let state = baseStateWithApproval();
    state = reduce(state, {
      type: 'flow-run-snapshot',
      threadId: 'thread-1',
      snapshot: {
        runId: 'session-thread-1',
        definitionId: 'station-delivery',
        currentStep: 'verify',
        status: 'active',
        openGates: [{ id: 'verify-gate', step: 'verify' }],
        lastEvaluatedAt: '2026-07-31T09:00:00.000Z',
        gateOutcomeCount: 1,
        evidenceCount: 2,
      },
    });

    const joined = render(state).join('\n');
    expect(joined).toContain('last evaluated 2026-07-31T09:00:00.000Z');
    expect(joined).toContain('1 gate outcomes, 2 evidence');
    expect(joined).not.toContain('never evaluated');
  });

  it('keeps the evaluation prefix and counts when an evaluated run is on an ungated step', () => {
    // A run CAN have been evaluated and still be sitting on a step with no
    // gate (it advanced into one). The pane must say both, in the same shape
    // as every other evaluation line — not drop the timestamp and counts.
    let state = baseStateWithApproval();
    state = reduce(state, {
      type: 'flow-run-snapshot',
      threadId: 'thread-1',
      snapshot: {
        runId: 'session-thread-1',
        definitionId: 'station-delivery',
        currentStep: 'handoff',
        status: 'active',
        openGates: [],
        lastEvaluatedAt: '2026-07-31T09:00:00.000Z',
        blockedReason: 'ungated-step',
        gateOutcomeCount: 3,
        evidenceCount: 4,
      },
    });

    const joined = render(state).join('\n');
    expect(joined).toContain('last evaluated 2026-07-31T09:00:00.000Z');
    expect(joined).toContain('no gate on step `handoff`');
    expect(joined).toContain('3 gate outcomes, 4 evidence');
    expect(joined).not.toContain('never evaluated');
  });

  it('says evaluated-but-time-unrecorded rather than never-evaluated for a waiting gate', () => {
    // Flow stamps only advancing evaluations, so a gate that has been
    // evaluated and is waiting has outcomes but no timestamp.
    let state = baseStateWithApproval();
    state = reduce(state, {
      type: 'flow-run-snapshot',
      threadId: 'thread-1',
      snapshot: {
        runId: 'session-thread-1',
        definitionId: 'station-delivery',
        currentStep: 'implement',
        status: 'active',
        openGates: [{ id: 'implement-gate', step: 'implement' }],
        lastEvaluatedAt: null,
        gateOutcomeCount: 1,
        evidenceCount: 0,
      },
    });

    const joined = render(state).join('\n');
    expect(joined).toContain(
      'evaluation: time unrecorded (1 gate outcomes, 0 evidence)',
    );
    expect(joined).not.toContain('never evaluated');
  });

  it('says freshness is unknown rather than guessing when nothing was pulled', () => {
    let state = baseStateWithApproval();
    state = reduce(state, {
      type: 'event',
      event: {
        threadId: 'thread-1',
        provider: 'claude',
        createdAt: '2026-07-05T00:00:01.000Z',
        method: 'flow.run-attached',
        runId: 'run-1',
        definitionId: 'station-delivery',
        cwd: '/repo',
        resumed: false,
      },
    });

    const joined = render(state).join('\n');
    expect(joined).toContain('evaluation: unknown (not pulled)');
  });

  it('shows "(none pending)" for the approvals pane when there are no pending approvals', () => {
    const state = reduce(initialState({ focusedThreadId: 'thread-1' }), {
      type: 'snapshot',
      sessions: [
        { threadId: 'thread-1', provider: 'claude', status: 'running' },
      ],
    });
    const lines = render(state);
    expect(lines.some((line) => line.includes('(none pending)'))).toBe(true);
  });

  it('renders the keybinding legend in the footer', () => {
    const lines = render(initialState({}));
    const footerLine = lines.find((line) => line.includes('quit'));
    expect(footerLine).toBeDefined();
  });

  it('shows "(no sessions yet)" before any snapshot has arrived', () => {
    const lines = render(initialState({}));
    expect(lines.some((line) => line.includes('(no sessions yet)'))).toBe(true);
  });

  /**
   * #168 iteration-2 review finding M1: `derivePendingApprovalsForSession`
   * used to compute `ageMs` internally via `Date.now()` — a hidden impurity
   * that also meant the *displayed* age never advanced between renders,
   * because nothing re-derived it once the approval entered the buffer.
   * This test proves the fix end-to-end through the real reducer + real
   * renderer: two `tick` actions (the shell's 1s interval, advancing
   * `state.now`) with **no new events at all** must change the rendered
   * age line.
   *
   * Red/green evidence (recorded per the task brief): run against the
   * pre-fix code (`derive.ts` computing `ageMs: Date.now() - ...` and
   * `render.ts` reading `approval.ageMs` directly, ignoring `state.now`),
   * this test FAILS — both renders show the exact same `age=0s` (frozen at
   * derivation time), so `firstAgeLine !== secondAgeLine` never holds.
   * Against the post-fix code (age computed in `render.ts` from
   * `state.now`/`approval.createdAt` on every call) it PASSES: the second
   * render's age line reflects the advanced `state.now`.
   */
  it('advances the rendered approval age across two ticks with no new events (M1 fix, was frozen before)', () => {
    const createdAt = '2026-07-05T00:00:00.000Z';
    const createdAtMs = Date.parse(createdAt);
    let state = initialState({ focusedThreadId: 'thread-1' });
    state = reduce(state, { type: 'tick', now: createdAtMs });
    state = reduce(state, {
      type: 'event',
      event: {
        threadId: 'thread-1',
        provider: 'claude',
        createdAt,
        requestId: 'req-age',
        method: 'request.opened',
        requestType: 'approval',
        title: 'Allow Bash',
        payload: { toolName: 'Bash', toolInput: { command: 'npm test' } },
      },
    });

    const findAgeLine = (lines: string[]) =>
      lines.find((line) => line.includes('req-age'));

    const firstLines = render(state);
    const firstAgeLine = findAgeLine(firstLines);
    expect(firstAgeLine).toBeDefined();
    expect(firstAgeLine).toContain('age=0s');

    // First tick: 5s later, still no new events for this session.
    state = reduce(state, { type: 'tick', now: createdAtMs + 5000 });
    const secondLines = render(state);
    const secondAgeLine = findAgeLine(secondLines);
    expect(secondAgeLine).toBeDefined();
    expect(secondAgeLine).toContain('age=5s');
    expect(secondAgeLine).not.toBe(firstAgeLine);

    // Second tick: another 5s later — genuinely advances again, not a
    // one-off recompute.
    state = reduce(state, { type: 'tick', now: createdAtMs + 10000 });
    const thirdLines = render(state);
    const thirdAgeLine = findAgeLine(thirdLines);
    expect(thirdAgeLine).toBeDefined();
    expect(thirdAgeLine).toContain('age=10s');
    expect(thirdAgeLine).not.toBe(secondAgeLine);
  });

  /**
   * #187 follow-up 1: `formatApprovalAge(createdAt, now)` used to render a
   * negative age (e.g. `age=-3s`) when client/server clock skew put the
   * server-stamped `createdAt` ahead of the client's `state.now`. The fix
   * clamps at zero via `Math.max(0, ...)`. Table-driven per the issue's AC —
   * the skew rows are the negative cases (pre-fix, the -3s row returned
   * `'-3s'`).
   */
  describe('formatApprovalAge (table-driven, #187 follow-up 1)', () => {
    const now = Date.parse('2026-07-05T00:00:10.000Z');
    const cases: Array<{
      name: string;
      createdAt: string | undefined;
      now: number;
      expected: string;
    }> = [
      {
        name: 'normal positive age',
        createdAt: '2026-07-05T00:00:00.000Z',
        now,
        expected: '10s',
      },
      {
        name: 'exact zero age',
        createdAt: '2026-07-05T00:00:10.000Z',
        now,
        expected: '0s',
      },
      {
        name: 'clock skew (now < createdAt) clamps to 0s instead of -3s',
        createdAt: '2026-07-05T00:00:13.000Z',
        now,
        expected: '0s',
      },
      {
        name: 'sub-second clock skew clamps to 0s (never -0s)',
        createdAt: '2026-07-05T00:00:10.400Z',
        now,
        expected: '0s',
      },
      {
        name: 'missing createdAt renders ?',
        createdAt: undefined,
        now,
        expected: '?',
      },
      {
        name: 'unparseable createdAt renders ?',
        createdAt: 'not-a-date',
        now,
        expected: '?',
      },
    ];

    it.each(cases)('$name', ({ createdAt, now: caseNow, expected }) => {
      expect(formatApprovalAge(createdAt, caseNow)).toBe(expected);
    });
  });

  it('clamps the rendered approval age to 0s end-to-end when state.now lags createdAt (clock skew, #187)', () => {
    const createdAt = '2026-07-05T00:00:10.000Z';
    let state = initialState({ focusedThreadId: 'thread-1' });
    // Client clock 3s behind the server-stamped createdAt.
    state = reduce(state, { type: 'tick', now: Date.parse(createdAt) - 3000 });
    state = reduce(state, {
      type: 'event',
      event: {
        threadId: 'thread-1',
        provider: 'claude',
        createdAt,
        requestId: 'req-skew',
        method: 'request.opened',
        requestType: 'approval',
        title: 'Allow Bash',
        payload: { toolName: 'Bash', toolInput: { command: 'npm test' } },
      },
    });
    const line = render(state).find((l) => l.includes('req-skew'));
    expect(line).toBeDefined();
    expect(line).toContain('age=0s');
    expect(line).not.toContain('age=-');
  });
});

/**
 * station#1782 AC3 — the operate TUI's approvals pane renders the SAME
 * annotation the `station approvals list` payload carries, off the same wire
 * decoration. The pane never recomputes the fact: `projectRequestAnswerability`
 * needs the serving process's adapter registry and thread-attachment table,
 * and this is a different process over HTTP.
 */
describe('operate/render approvals answerability (station#1782)', () => {
  const observation = {
    answerable: false,
    qualification: 'provider_absent',
    observedBy: 'station-7f3a',
    observedAt: '2026-08-03T12:04:03.000Z',
  };

  function stateWithApproval(sessionOverrides: Record<string, unknown>) {
    let state = initialState({ focusedThreadId: 'thread-1' });
    state = reduce(state, {
      type: 'snapshot',
      sessions: [
        {
          threadId: 'thread-1',
          provider: 'acme',
          status: 'running',
          updatedAt: '2026-07-05T00:00:00.000Z',
          ...sessionOverrides,
        },
      ],
    });
    return reduce(state, {
      type: 'event',
      event: {
        threadId: 'thread-1',
        provider: 'acme',
        createdAt: '2026-07-05T00:00:00.000Z',
        requestId: 'req-stranded',
        method: 'request.opened',
        requestType: 'approval',
        title: 'Allow Bash',
        payload: { toolName: 'Bash', toolInput: { command: 'rm -rf tmp' } },
      },
    });
  }

  it('annotates the pane with qualification, observer and observedAt', () => {
    const lines = render(stateWithApproval({ answerability: observation }));
    const joined = lines.join('\n');
    expect(joined).toContain("no adapter for provider 'acme'");
    expect(joined).toContain('station-7f3a');
    expect(joined).toContain('2026-08-03T12:04:03.000Z');
  });

  it('anti-filter: the approval row is still rendered, tagged', () => {
    const lines = render(stateWithApproval({ answerability: observation }));
    const row = lines.find((line) => line.includes('req-stranded'));
    expect(row).toBeDefined();
    expect(row).toContain('[unanswerable]');
    expect(lines.join('\n')).not.toContain('(none pending)');
  });

  it('control: an answerable session renders the pane exactly as before', () => {
    const lines = render(
      stateWithApproval({ answerability: { answerable: true } }),
    );
    const joined = lines.join('\n');
    expect(joined).not.toContain('Unanswerable by the serving Station');
    expect(joined).not.toContain('[unanswerable]');
    expect(joined).not.toContain('Answerability unknown');
    expect(lines.find((line) => line.includes('req-stranded'))).toBeDefined();
  });

  it('a focused thread with no board observation renders the explicit unknown gap', () => {
    // Reachable when a live event invents a row before any snapshot has
    // described the thread. "Could not look" is not "nothing can answer
    // this", and it is not "answerable" either.
    let state = initialState({ focusedThreadId: 'thread-unseen' });
    state = reduce(state, {
      type: 'event',
      event: {
        threadId: 'thread-unseen',
        provider: 'acme',
        createdAt: '2026-07-05T00:00:00.000Z',
        requestId: 'req-unseen',
        method: 'request.opened',
        requestType: 'approval',
        title: 'Allow Bash',
        payload: { toolName: 'Bash' },
      },
    });
    const joined = render(state).join('\n');
    expect(joined).toContain('Answerability unknown');
    expect(joined).toContain('thread-unseen');
    // ...and no row is tagged, because nothing was observed.
    expect(joined).not.toContain('[unanswerable]');
  });
});
