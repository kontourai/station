import { describe, expect, test } from 'vitest';
import { shouldBindPanelProjectContext } from '../project-context-binding';

describe('coding panel Project context binding', () => {
  test('uses the panel Project only for a fresh, untouched chat', () => {
    expect(shouldBindPanelProjectContext({ status: 'idle' }, 'station')).toBe(
      true,
    );
  });

  test('does not overwrite a global conversation after persistence and project navigation', () => {
    // Composition regression for archive#3147: turn one ran globally; after
    // rehydration the user opened a Project coding panel. The next turn must
    // retain the original global workspace rather than acquire this Project.
    expect(
      shouldBindPanelProjectContext(
        {
          status: 'idle',
          conversationId: 'codex:1787544761790',
          orchestrationSessionStarted: true,
        },
        'station',
      ),
    ).toBe(false);
  });

  test('does not rewrite an in-flight first turn during navigation', () => {
    expect(
      shouldBindPanelProjectContext(
        {
          status: 'sending',
          pendingClientTurnId: 'turn-1',
        },
        'station',
      ),
    ).toBe(false);
  });
});
