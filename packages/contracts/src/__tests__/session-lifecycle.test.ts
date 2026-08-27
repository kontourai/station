import { describe, expect, test } from 'vitest';
import {
  canSessionLifecycleStateResume,
  isSessionLifecycleState,
  isSessionLifecycleStateStopped,
  isSessionLifecycleStateTerminal,
  SESSION_LIFECYCLE_STATES,
  SESSION_LIFECYCLE_TRANSITIONS,
  validateSessionLifecycleTransition,
} from '../session-lifecycle.js';

describe('session lifecycle contract', () => {
  test('declares the canonical board states', () => {
    expect(SESSION_LIFECYCLE_STATES).toEqual([
      'queued',
      'running',
      'needs_input',
      'review_pending',
      'blocked',
      'completed',
      'failed',
      'canceled',
    ]);
  });

  test('allows expected runtime, review, and retry paths', () => {
    expect(validateSessionLifecycleTransition('queued', 'running')).toEqual({
      ok: true,
      code: 'allowed',
    });
    expect(
      validateSessionLifecycleTransition('running', 'review_pending'),
    ).toEqual({
      ok: true,
      code: 'allowed',
    });
    expect(validateSessionLifecycleTransition('failed', 'queued')).toEqual({
      ok: true,
      code: 'allowed',
    });
    expect(validateSessionLifecycleTransition('blocked', 'running')).toEqual({
      ok: true,
      code: 'allowed',
    });
  });

  test('rejects same-state, terminal, and illegal transitions with codes', () => {
    expect(validateSessionLifecycleTransition('running', 'running')).toEqual(
      expect.objectContaining({ ok: false, code: 'same_state' }),
    );
    expect(validateSessionLifecycleTransition('completed', 'running')).toEqual(
      expect.objectContaining({ ok: false, code: 'terminal_state' }),
    );
    // #1073: queued → completed is legal now — an attached-but-never-run
    // session projects 'queued' and closing it out is a legitimate action.
    expect(validateSessionLifecycleTransition('queued', 'completed')).toEqual(
      expect.objectContaining({ ok: true, code: 'allowed' }),
    );
    expect(validateSessionLifecycleTransition('completed', 'queued')).toEqual(
      expect.objectContaining({ ok: false, code: 'terminal_state' }),
    );
  });

  // station#1548: three hand-written predicates all called themselves
  // "terminal" and had drifted apart — the lifecycle projector's and the
  // attention projection's both counted `failed`, which this map explicitly
  // declares retryable. These are now the only definitions, they all derive
  // from SESSION_LIFECYCLE_TRANSITIONS, and the sets below are what the map
  // says today.
  describe('terminality is derived from the transition map, not hand-listed (#1548)', () => {
    const statesWhere = (
      predicate: (state: (typeof SESSION_LIFECYCLE_STATES)[number]) => boolean,
    ) => SESSION_LIFECYCLE_STATES.filter(predicate);

    test('terminal means the map permits no transition out at all', () => {
      expect(statesWhere(isSessionLifecycleStateTerminal)).toEqual([
        'completed',
      ]);
    });

    test('stopped means every permitted transition out is a restart', () => {
      expect(statesWhere(isSessionLifecycleStateStopped)).toEqual([
        'completed',
        'failed',
        'canceled',
      ]);
    });

    // `running` is reflexive here: the map has no self-edges, so a
    // map-only derivation answers `false` for a live session — which would
    // have zeroed `pendingReview` on a session with a genuinely open
    // request. Caught by this assertion during implementation.
    test('resumable means the session is running, or the map permits going straight back to it', () => {
      expect(statesWhere(canSessionLifecycleStateResume)).toEqual([
        'queued',
        'running',
        'needs_input',
        'review_pending',
        'blocked',
        'failed',
      ]);
    });

    // The whole defect in one assertion: `failed` is the only state that is
    // both stopped and resumable, and every predicate that conflated the two
    // hid an outstanding approval on a retryable session.
    test('failed is the state that is stopped AND resumable, and it is not terminal', () => {
      expect(isSessionLifecycleStateTerminal('failed')).toBe(false);
      expect(isSessionLifecycleStateStopped('failed')).toBe(true);
      expect(canSessionLifecycleStateResume('failed')).toBe(true);
      expect(SESSION_LIFECYCLE_TRANSITIONS.failed).toContain('running');
    });

    test('every predicate agrees with the map it derives from', () => {
      for (const state of SESSION_LIFECYCLE_STATES) {
        const allowed = SESSION_LIFECYCLE_TRANSITIONS[state];
        expect(isSessionLifecycleStateTerminal(state)).toBe(
          allowed.length === 0,
        );
        expect(isSessionLifecycleStateStopped(state)).toBe(
          allowed.every((next) => next === 'queued' || next === 'running'),
        );
        expect(canSessionLifecycleStateResume(state)).toBe(
          state === 'running' || allowed.includes('running'),
        );
      }
    });

    // These guard user-visible attention surfaces, so an unrecognized value
    // must read as "still live" — never as a reason to hide work.
    test('an unrecognized state is treated as live, never as terminal or stopped', () => {
      const unknown = 'zombie' as (typeof SESSION_LIFECYCLE_STATES)[number];
      expect(isSessionLifecycleStateTerminal(unknown)).toBe(false);
      expect(isSessionLifecycleStateStopped(unknown)).toBe(false);
      expect(canSessionLifecycleStateResume(unknown)).toBe(true);
    });

    test('validateSessionLifecycleTransition answers terminal_state from the same predicate', () => {
      for (const state of SESSION_LIFECYCLE_STATES) {
        const result = validateSessionLifecycleTransition(state, 'running');
        expect(result.code === 'terminal_state').toBe(
          isSessionLifecycleStateTerminal(state),
        );
      }
    });
  });

  test('covers every canonical state in the transition map', () => {
    expect(Object.keys(SESSION_LIFECYCLE_TRANSITIONS).sort()).toEqual(
      [...SESSION_LIFECYCLE_STATES].sort(),
    );
    expect(isSessionLifecycleState('review_pending')).toBe(true);
    expect(isSessionLifecycleState('awaiting-approval')).toBe(false);
  });
});
