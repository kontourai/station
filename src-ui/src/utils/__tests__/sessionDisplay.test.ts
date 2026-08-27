import { describe, expect, test } from 'vitest';
import { sessionLifecycleLabel } from '../session-state';

describe('sessionLifecycleLabel (station#1170 declutter)', () => {
  // The session header used to render `session.lifecycleState` verbatim, so
  // users read wire identifiers — `needs_input`, `review_pending` — as status
  // copy. This pins that no label is a raw token, for EVERY member of the
  // union rather than only the two that happened to appear in a screenshot.
  //
  // The list is written out rather than imported from the union on purpose.
  // Adding a state upstream then fails `sessionLifecycleLabel`'s exhaustive
  // switch at typecheck AND leaves this list visibly short — two independent
  // signals. A loop over the imported union would silently cover a new member
  // the moment someone added a `default` branch to quiet the compiler.
  const states = [
    'queued',
    'running',
    'needs_input',
    'review_pending',
    'blocked',
    'completed',
    'failed',
    'canceled',
  ] as const;

  test('never renders a raw wire identifier for any lifecycle state', () => {
    for (const state of states) {
      const label = sessionLifecycleLabel(state);
      expect(label, `${state} must not render as its own wire token`).not.toBe(
        state,
      );
      expect(label, `${state} label must not carry an underscore`).not.toMatch(
        /_/,
      );
      expect(label[0], `${state} label must be capitalised`).toBe(
        label[0]?.toUpperCase(),
      );
    }
  });

  test('names the two states that mean a person is being waited on', () => {
    expect(sessionLifecycleLabel('needs_input')).toBe('Waiting on you');
    expect(sessionLifecycleLabel('review_pending')).toBe('Review pending');
  });
});
