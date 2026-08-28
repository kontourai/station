import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TurnStallWatchdog } from '../turn-stall-watchdog.js';

describe('TurnStallWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Delta-review F1 (archive#4054 round 2): the suspension path honors the same
  // stale-turn identity gate as the terminal paths. A delayed request.opened
  // naming a SUPERSEDED turn must neither suspend nor clear the observation
  // of the turn actually running.
  test('ignores a stale request.opened naming a superseded turn: no suspend, no clear', () => {
    const watchdog = new TurnStallWatchdog();
    const onStall = vi.fn();
    const onClear = vi.fn();
    const callbacks = { onStall, onClear };
    watchdog.observe(
      { method: 'turn.started', threadId: 't1', turnId: 'turn-2' },
      1_000,
      callbacks,
    );
    vi.advanceTimersByTime(1_000);
    expect(onStall).toHaveBeenCalledWith('t1', 'turn-2');

    watchdog.observe(
      {
        method: 'request.opened',
        threadId: 't1',
        turnId: 'turn-1', // superseded turn — a delayed frame
      },
      1_000,
      callbacks,
    );
    expect(onClear).not.toHaveBeenCalled();

    // The CURRENT turn's fired watch still clears on its own progress —
    // proof the stale frame neither suspended nor forgot it.
    watchdog.observe(
      {
        method: 'content.text-delta',
        threadId: 't1',
        turnId: 'turn-2',
        createdAt: '2026-08-24T12:00:01.000Z',
      },
      1_000,
      callbacks,
    );
    expect(onClear).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 't1', turnId: 'turn-2' }),
    );
  });

  test('fires when no progress event is observed within the window', () => {
    const watchdog = new TurnStallWatchdog();
    const onStall = vi.fn();
    watchdog.observe(
      { method: 'turn.started', threadId: 't1', turnId: 'turn-1' },
      1_000,
      onStall,
    );

    vi.advanceTimersByTime(999);
    expect(onStall).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onStall).toHaveBeenCalledWith('t1', 'turn-1');
  });

  test('keeps a fired watch long enough for the next progress and turn end to clear its observation', () => {
    const watchdog = new TurnStallWatchdog();
    const onStall = vi.fn();
    const onProgress = vi.fn();
    const onClear = vi.fn();
    const callbacks = { onStall, onProgress, onClear };
    watchdog.observe(
      {
        method: 'turn.started',
        threadId: 't1',
        turnId: 'turn-1',
        createdAt: '2026-08-24T12:00:00.000Z',
      },
      1_000,
      callbacks,
    );

    vi.advanceTimersByTime(1_000);
    expect(onStall).toHaveBeenCalledWith('t1', 'turn-1');
    // A fired watch owns no live timer, but retains turn identity so the
    // next real progress can clear the process-local projection (archive#4054).
    expect(watchdog.size).toBe(0);

    watchdog.observe(
      {
        method: 'content.text-delta',
        threadId: 't1',
        turnId: 'turn-1',
        createdAt: '2026-08-24T12:00:01.000Z',
      },
      1_000,
      callbacks,
    );
    expect(onClear).toHaveBeenCalledWith({ threadId: 't1', turnId: 'turn-1' });
    expect(onProgress).toHaveBeenLastCalledWith({
      threadId: 't1',
      turnId: 'turn-1',
      lastProgressEventAt: '2026-08-24T12:00:01.000Z',
    });

    watchdog.observe(
      {
        method: 'turn.completed',
        threadId: 't1',
        turnId: 'turn-1',
        createdAt: '2026-08-24T12:00:02.000Z',
      },
      1_000,
      callbacks,
    );
    expect(onClear).toHaveBeenLastCalledWith({
      threadId: 't1',
      turnId: 'turn-1',
    });
  });

  test('clears a fired observation on a terminal event with no intervening progress', () => {
    const watchdog = new TurnStallWatchdog();
    const onClear = vi.fn();
    const callbacks = { onStall: vi.fn(), onClear };
    watchdog.observe(
      { method: 'turn.started', threadId: 't1', turnId: 'turn-1' },
      1_000,
      callbacks,
    );
    vi.advanceTimersByTime(1_000);
    onClear.mockClear();

    watchdog.observe(
      { method: 'turn.completed', threadId: 't1', turnId: 'turn-1' },
      1_000,
      callbacks,
    );
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledWith({ threadId: 't1', turnId: 'turn-1' });
  });

  test('never fires while progress events keep arriving at any rate under the window', () => {
    const watchdog = new TurnStallWatchdog();
    const onStall = vi.fn();
    watchdog.observe(
      { method: 'turn.started', threadId: 't1', turnId: 'turn-1' },
      1_000,
      onStall,
    );

    // Ten resets, each just under the window: total elapsed time (9_990ms)
    // vastly exceeds the window, but every gap between events is < window.
    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(999);
      watchdog.observe(
        {
          method: 'content.text-delta',
          threadId: 't1',
          turnId: 'turn-1',
        },
        1_000,
        onStall,
      );
    }
    expect(onStall).not.toHaveBeenCalled();
  });

  test.each([
    'content.text-delta',
    'content.reasoning-delta',
    'tool.started',
    'tool.progress',
    'tool.completed',
  ] as const)('%s resets the window', (method) => {
    const watchdog = new TurnStallWatchdog();
    const onStall = vi.fn();
    watchdog.observe(
      { method: 'turn.started', threadId: 't1', turnId: 'turn-1' },
      1_000,
      onStall,
    );
    vi.advanceTimersByTime(900);
    watchdog.observe(
      { method, threadId: 't1', turnId: 'turn-1' },
      1_000,
      onStall,
    );
    vi.advanceTimersByTime(900);
    expect(onStall).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(onStall).toHaveBeenCalledOnce();
  });

  test('a session state transition resets the window even without a matching turnId', () => {
    const watchdog = new TurnStallWatchdog();
    const onStall = vi.fn();
    watchdog.observe(
      { method: 'turn.started', threadId: 't1', turnId: 'turn-1' },
      1_000,
      onStall,
    );
    vi.advanceTimersByTime(900);
    watchdog.observe(
      {
        method: 'session.state-changed',
        threadId: 't1',
        turnId: undefined,
        isStateTransition: true,
      },
      1_000,
      onStall,
    );
    vi.advanceTimersByTime(900);
    expect(onStall).not.toHaveBeenCalled();
  });

  test.each([
    'turn.completed',
    'turn.aborted',
    'session.stop-settled',
    'session.exited',
  ] as const)('%s clears the watch outright, never resets it', (method) => {
    const watchdog = new TurnStallWatchdog();
    const onStall = vi.fn();
    watchdog.observe(
      { method: 'turn.started', threadId: 't1', turnId: 'turn-1' },
      1_000,
      onStall,
    );
    watchdog.observe(
      { method, threadId: 't1', turnId: 'turn-1' },
      1_000,
      onStall,
    );
    expect(watchdog.size).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(onStall).not.toHaveBeenCalled();
  });

  test('an unrelated turnId on the same thread does not reset the watched turn', () => {
    const watchdog = new TurnStallWatchdog();
    const onStall = vi.fn();
    watchdog.observe(
      { method: 'turn.started', threadId: 't1', turnId: 'turn-1' },
      1_000,
      onStall,
    );
    vi.advanceTimersByTime(900);
    watchdog.observe(
      { method: 'content.text-delta', threadId: 't1', turnId: 'turn-stale' },
      1_000,
      onStall,
    );
    vi.advanceTimersByTime(100);
    expect(onStall).toHaveBeenCalledWith('t1', 'turn-1');
  });

  test('leaves zero live timers after natural completion', () => {
    const watchdog = new TurnStallWatchdog();
    const onStall = vi.fn();
    watchdog.observe(
      { method: 'turn.started', threadId: 't1', turnId: 'turn-1' },
      1_000,
      onStall,
    );
    expect(vi.getTimerCount()).toBe(1);
    watchdog.observe(
      { method: 'turn.completed', threadId: 't1', turnId: 'turn-1' },
      1_000,
      onStall,
    );
    expect(vi.getTimerCount()).toBe(0);
    // A trailing advance has zero power on its own (a cleared timer just
    // isn't there) — the timer-count assertion above is the real proof.
    vi.advanceTimersByTime(10_000);
    expect(onStall).not.toHaveBeenCalled();
  });

  test('clearAll clears every watched thread without firing', () => {
    const watchdog = new TurnStallWatchdog();
    const onStall = vi.fn();
    watchdog.observe(
      { method: 'turn.started', threadId: 't1', turnId: 'turn-1' },
      1_000,
      onStall,
    );
    watchdog.observe(
      { method: 'turn.started', threadId: 't2', turnId: 'turn-2' },
      1_000,
      onStall,
    );
    expect(watchdog.size).toBe(2);
    watchdog.clearAll();
    expect(watchdog.size).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(onStall).not.toHaveBeenCalled();
  });
  // archive#3451 findings 4/6: a genuine (non-deferred) runtime.error must
  // clear the watch outright, exactly like TERMINAL_METHODS — otherwise a
  // turn that already ended fires a spurious stall detection later,
  // polluting the metric archive#2959's observe-only phase exists to collect.
  test('a non-retriable runtime.error clears the watch outright, never resets it', () => {
    const watchdog = new TurnStallWatchdog();
    const onStall = vi.fn();
    watchdog.observe(
      { method: 'turn.started', threadId: 't1', turnId: 'turn-1' },
      1_000,
      onStall,
    );
    watchdog.observe(
      {
        method: 'runtime.error',
        threadId: 't1',
        turnId: 'turn-1',
        provider: 'codex',
        retriable: false,
      },
      1_000,
      onStall,
    );
    expect(watchdog.size).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(onStall).not.toHaveBeenCalled();
  });

  test('a runtime.error from a non-codex provider clears the watch even with retriable:true (station-agent hardcodes it on an already-terminal turn)', () => {
    const watchdog = new TurnStallWatchdog();
    const onStall = vi.fn();
    watchdog.observe(
      { method: 'turn.started', threadId: 't1', turnId: 'turn-1' },
      1_000,
      onStall,
    );
    watchdog.observe(
      {
        method: 'runtime.error',
        threadId: 't1',
        turnId: 'turn-1',
        provider: 'station-agent',
        retriable: true,
      },
      1_000,
      onStall,
    );
    expect(watchdog.size).toBe(0);
  });

  // The whole point of leaving `runtime.error` out of TERMINAL_METHODS: a
  // codex deferred-retriable error must NOT stop this watch — the retry may
  // still be silently stuck, which is exactly what this watchdog exists to
  // catch.
  test('a codex deferred-retriable runtime.error does not clear the watch, and does not reset it either', () => {
    const watchdog = new TurnStallWatchdog();
    const onStall = vi.fn();
    watchdog.observe(
      { method: 'turn.started', threadId: 't1', turnId: 'turn-1' },
      1_000,
      onStall,
    );
    vi.advanceTimersByTime(900);
    watchdog.observe(
      {
        method: 'runtime.error',
        threadId: 't1',
        turnId: 'turn-1',
        provider: 'codex',
        retriable: true,
      },
      1_000,
      onStall,
    );
    expect(watchdog.size).toBe(1);
    // Not reset: the ORIGINAL deadline (1000ms from turn.started) still
    // governs — 100ms more (to 1000ms total) fires it.
    vi.advanceTimersByTime(100);
    expect(onStall).toHaveBeenCalledWith('t1', 'turn-1');
  });

  // archive#3451 finding H2: the SECOND documented non-terminal runtime.error
  // publisher — orchestration-service's adapter-stream-restart error — is
  // provider-agnostic (any adapter) and carries NO turnId (session-scoped).
  // Before this fix, isDeferredRetriableTurnError's codex-only scoping meant
  // this event cleared the watch for claude/acp/bedrock even though its own
  // comment says a legitimate later turn.completed may still arrive.
  test('the adapter-stream-restart runtime.error (any provider, retriable, no turnId) does not clear the watch', () => {
    const watchdog = new TurnStallWatchdog();
    const onStall = vi.fn();
    watchdog.observe(
      { method: 'turn.started', threadId: 't1', turnId: 'turn-1' },
      1_000,
      onStall,
    );
    vi.advanceTimersByTime(900);
    watchdog.observe(
      {
        method: 'runtime.error',
        threadId: 't1',
        turnId: undefined,
        provider: 'claude',
        retriable: true,
      },
      1_000,
      onStall,
    );
    expect(watchdog.size).toBe(1);
    vi.advanceTimersByTime(100);
    expect(onStall).toHaveBeenCalledWith('t1', 'turn-1');
  });

  // Negative control: a definitive (non-retriable) runtime.error with no
  // turnId is NOT the adapter-stream-restart shape and must still clear.
  test('a non-retriable runtime.error with no turnId still clears the watch', () => {
    const watchdog = new TurnStallWatchdog();
    const onStall = vi.fn();
    watchdog.observe(
      { method: 'turn.started', threadId: 't1', turnId: 'turn-1' },
      1_000,
      onStall,
    );
    watchdog.observe(
      {
        method: 'runtime.error',
        threadId: 't1',
        turnId: undefined,
        provider: 'claude',
        retriable: false,
      },
      1_000,
      onStall,
    );
    expect(watchdog.size).toBe(0);
  });

  // archive#3594: a terminal naming the turn currently watched must still
  // clear it (the direction that was never broken — proving the identity
  // gate does not over-reject the normal case).
  test.each([
    'turn.completed',
    'turn.aborted',
    'session.stop-settled',
  ] as const)('%s naming the watched turn clears the watch', (method) => {
    const watchdog = new TurnStallWatchdog();
    const onStall = vi.fn();
    watchdog.observe(
      { method: 'turn.started', threadId: 't1', turnId: 'turn-2' },
      1_000,
      onStall,
    );
    watchdog.observe(
      { method, threadId: 't1', turnId: 'turn-2' },
      1_000,
      onStall,
    );
    expect(watchdog.size).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(onStall).not.toHaveBeenCalled();
  });

  // archive#3594 — THE defect this issue is about, and the direction with
  // power: a terminal naming a SUPERSEDED turn (one the thread has already
  // moved past — a codex session runs turn-1 then turn-2; turn-1's terminal
  // arrives late) must NOT clear the watch for the turn that is genuinely
  // still running. Before the fix, `observe()` called `this.clear(threadId)`
  // unconditionally in the TERMINAL_METHODS branch, with no comparison
  // against `watching.turnId` — this test fails against that code (fault
  // injection confirmed below in the report) because the watch would already
  // be gone (`size` 0) instead of surviving to fire.
  test.each([
    'turn.completed',
    'turn.aborted',
    'session.stop-settled',
  ] as const)(
    '%s naming a superseded turn does not clear the watch for the turn that is actually running',
    (method) => {
      const watchdog = new TurnStallWatchdog();
      const onStall = vi.fn();
      // turn-1 runs, then turn-2 supersedes it (the watchdog now only tracks
      // turn-2, per its single-watch-per-thread design).
      watchdog.observe(
        { method: 'turn.started', threadId: 't1', turnId: 'turn-1' },
        1_000,
        onStall,
      );
      watchdog.observe(
        { method: 'turn.started', threadId: 't1', turnId: 'turn-2' },
        1_000,
        onStall,
      );
      // turn-1's stale terminal arrives late, naming turn-1 — not turn-2.
      watchdog.observe(
        { method, threadId: 't1', turnId: 'turn-1' },
        1_000,
        onStall,
      );
      // The watch for turn-2 must have survived...
      expect(watchdog.size).toBe(1);
      // ...and must still fire for turn-2 when it genuinely stalls.
      vi.advanceTimersByTime(1_000);
      expect(onStall).toHaveBeenCalledWith('t1', 'turn-2');
    },
  );

  // archive#3594: `session.exited` never carries a turnId (audited every
  // publisher) — it is a genuinely session-scoped fact, not a stale terminal
  // for one specific other turn, so it must keep clearing unconditionally
  // regardless of which turn is currently watched.
  test('session.exited (no turnId) still clears the watch even with a different turn watched', () => {
    const watchdog = new TurnStallWatchdog();
    const onStall = vi.fn();
    watchdog.observe(
      { method: 'turn.started', threadId: 't1', turnId: 'turn-1' },
      1_000,
      onStall,
    );
    watchdog.observe(
      { method: 'turn.started', threadId: 't1', turnId: 'turn-2' },
      1_000,
      onStall,
    );
    watchdog.observe(
      { method: 'session.exited', threadId: 't1', turnId: undefined },
      1_000,
      onStall,
    );
    expect(watchdog.size).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(onStall).not.toHaveBeenCalled();
  });

  // Review MEDIUM 1: the discriminating case for the STRUCTURAL exclusion,
  // not the "no known publisher sets turnId" fact alone. No current
  // publisher sets a turnId on session.exited, so the test above (turnId:
  // undefined) cannot tell a structural exclusion apart from the ordinary
  // identity gate, which already treats "no turnId" as never-stale. This
  // event carries a turnId that MISMATCHES the currently watched turn — the
  // ordinary identity gate alone would treat it as stale-for-another-turn and
  // skip clearing (leaving a dead session's watch armed to fire a false
  // stall later); the structural exclusion must still clear it because the
  // session itself ended, regardless of what turnId the event happens to
  // carry.
  test('session.exited carrying a turnId that MISMATCHES the watched turn still clears (structural exclusion, not merely an audit fact)', () => {
    const watchdog = new TurnStallWatchdog();
    const onStall = vi.fn();
    watchdog.observe(
      { method: 'turn.started', threadId: 't1', turnId: 'turn-1' },
      1_000,
      onStall,
    );
    watchdog.observe(
      { method: 'turn.started', threadId: 't1', turnId: 'turn-2' },
      1_000,
      onStall,
    );
    watchdog.observe(
      { method: 'session.exited', threadId: 't1', turnId: 'turn-1' },
      1_000,
      onStall,
    );
    expect(watchdog.size).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(onStall).not.toHaveBeenCalled();
  });

  // archive#3594: the identical identity-blind-clear defect also lived in the
  // `runtime.error` branch (not itself named by the issue's cited lines, but
  // the same unconditional `this.clear(threadId)` mechanism) — a genuine,
  // turn-scoped, non-retriable runtime.error naming a superseded turn must
  // not clear the watch for the turn actually running.
  test('a non-retriable runtime.error naming a superseded turn does not clear the watch for the turn that is actually running', () => {
    const watchdog = new TurnStallWatchdog();
    const onStall = vi.fn();
    watchdog.observe(
      { method: 'turn.started', threadId: 't1', turnId: 'turn-1' },
      1_000,
      onStall,
    );
    watchdog.observe(
      { method: 'turn.started', threadId: 't1', turnId: 'turn-2' },
      1_000,
      onStall,
    );
    watchdog.observe(
      {
        method: 'runtime.error',
        threadId: 't1',
        turnId: 'turn-1',
        provider: 'codex',
        retriable: false,
      },
      1_000,
      onStall,
    );
    expect(watchdog.size).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(onStall).toHaveBeenCalledWith('t1', 'turn-2');
  });

  // Review HIGH 1 (archive#3594): the issue's own scenario, reachable through
  // the SUSPENDED state specifically. A turn awaiting a human moves its entry
  // out of `watched` into `suspended` (see `:264-271`), so an
  // `isStaleForAnotherTurn` that consulted only `watched` found nothing to
  // protect and let a stale terminal for an earlier, superseded turn clear
  // the suspension outright — after which the eventual `request.resolved`
  // found nothing to resume, and the genuinely running (merely paused) turn
  // was never watched again. Executed repro from the independent review:
  //   turn.started(t1) -> turn.started(t2) -> request.opened(t2)
  //     -> turn.completed(t1) [stale] -> request.resolved(t2) -> advance
  //   pre-fix: onStall never fires, watch is gone.
  describe('station#3594 review HIGH 1: identity gate during suspension', () => {
    test('a stale terminal for a superseded turn does not clear a SUSPENDED watch; it survives and still fires after resolution', () => {
      const watchdog = new TurnStallWatchdog();
      const onStall = vi.fn();
      watchdog.observe(
        { method: 'turn.started', threadId: 't1', turnId: 'turn-1' },
        1_000,
        onStall,
      );
      watchdog.observe(
        { method: 'turn.started', threadId: 't1', turnId: 'turn-2' },
        1_000,
        onStall,
      );
      // turn-2 is now awaiting a human — its watch moves into `suspended`,
      // and `watched` is empty for this thread.
      watchdog.observe(
        { method: 'request.opened', threadId: 't1', turnId: 'turn-2' },
        1_000,
        onStall,
      );
      // turn-1's stale terminal arrives late, naming turn-1 — not turn-2 —
      // while turn-2 is suspended (not watched).
      watchdog.observe(
        { method: 'turn.completed', threadId: 't1', turnId: 'turn-1' },
        1_000,
        onStall,
      );
      // Resolving the (still-open) human request must resume watching
      // turn-2 — proves the suspension survived the stale terminal.
      watchdog.observe(
        { method: 'request.resolved', threadId: 't1', turnId: 'turn-2' },
        1_000,
        onStall,
      );
      expect(watchdog.size).toBe(1);
      vi.advanceTimersByTime(1_000);
      expect(onStall).toHaveBeenCalledWith('t1', 'turn-2');
    });

    test('a stale non-retriable runtime.error for a superseded turn does not clear a SUSPENDED watch either', () => {
      const watchdog = new TurnStallWatchdog();
      const onStall = vi.fn();
      watchdog.observe(
        { method: 'turn.started', threadId: 't1', turnId: 'turn-1' },
        1_000,
        onStall,
      );
      watchdog.observe(
        { method: 'turn.started', threadId: 't1', turnId: 'turn-2' },
        1_000,
        onStall,
      );
      watchdog.observe(
        { method: 'request.opened', threadId: 't1', turnId: 'turn-2' },
        1_000,
        onStall,
      );
      watchdog.observe(
        {
          method: 'runtime.error',
          threadId: 't1',
          turnId: 'turn-1',
          provider: 'codex',
          retriable: false,
        },
        1_000,
        onStall,
      );
      watchdog.observe(
        { method: 'request.resolved', threadId: 't1', turnId: 'turn-2' },
        1_000,
        onStall,
      );
      expect(watchdog.size).toBe(1);
      vi.advanceTimersByTime(1_000);
      expect(onStall).toHaveBeenCalledWith('t1', 'turn-2');
    });

    // Positive control: a terminal genuinely naming the SUSPENDED turn must
    // still clear it outright — proves the identity gate does not
    // over-protect the suspended state, only stale terminals for a DIFFERENT
    // turn.
    test('a terminal naming the SUSPENDED turn itself still clears it, and it never resumes', () => {
      const watchdog = new TurnStallWatchdog();
      const onStall = vi.fn();
      watchdog.observe(
        { method: 'turn.started', threadId: 't1', turnId: 'turn-2' },
        1_000,
        onStall,
      );
      watchdog.observe(
        { method: 'request.opened', threadId: 't1', turnId: 'turn-2' },
        1_000,
        onStall,
      );
      watchdog.observe(
        { method: 'turn.completed', threadId: 't1', turnId: 'turn-2' },
        1_000,
        onStall,
      );
      watchdog.observe(
        { method: 'request.resolved', threadId: 't1', turnId: 'turn-2' },
        1_000,
        onStall,
      );
      expect(watchdog.size).toBe(0);
      vi.advanceTimersByTime(5_000);
      expect(onStall).not.toHaveBeenCalled();
    });

    // Review MEDIUM 1's structural exclusion applies in the suspended state
    // too: session.exited (no turnId) always clears, even mid-suspension.
    test('session.exited (no turnId) still clears a SUSPENDED watch', () => {
      const watchdog = new TurnStallWatchdog();
      const onStall = vi.fn();
      watchdog.observe(
        { method: 'turn.started', threadId: 't1', turnId: 'turn-2' },
        1_000,
        onStall,
      );
      watchdog.observe(
        { method: 'request.opened', threadId: 't1', turnId: 'turn-2' },
        1_000,
        onStall,
      );
      watchdog.observe(
        { method: 'session.exited', threadId: 't1', turnId: undefined },
        1_000,
        onStall,
      );
      watchdog.observe(
        { method: 'request.resolved', threadId: 't1', turnId: 'turn-2' },
        1_000,
        onStall,
      );
      expect(watchdog.size).toBe(0);
      vi.advanceTimersByTime(5_000);
      expect(onStall).not.toHaveBeenCalled();
    });
  });

  // Review HIGH 1 (archive#2959): a turn awaiting a human (approval prompt, input
  // request) is alive but deliberately silent for as long as the human takes.
  // The watch suspends on request.opened — no expiry however long the human
  // is away — and re-arms only on request.resolved.
  test('suspends on request.opened for any duration and re-arms on request.resolved', () => {
    vi.useFakeTimers();
    try {
      const onStall = vi.fn();
      const watchdog = new TurnStallWatchdog();
      watchdog.observe(
        { method: 'turn.started', threadId: 't', turnId: 'turn-1' },
        1_000,
        onStall,
      );
      watchdog.observe(
        { method: 'request.opened', threadId: 't', turnId: 'turn-1' },
        1_000,
        onStall,
      );
      // Far past the window: the human is in a meeting. Nothing may fire.
      vi.advanceTimersByTime(60 * 60 * 1000);
      expect(onStall).not.toHaveBeenCalled();
      watchdog.observe(
        { method: 'request.resolved', threadId: 't', turnId: 'turn-1' },
        1_000,
        onStall,
      );
      vi.advanceTimersByTime(1_000);
      expect(onStall).toHaveBeenCalledWith('t', 'turn-1');
    } finally {
      vi.useRealTimers();
    }
  });
});
