import { describe, expect, test } from 'vitest';
import { describeBrowserAction, describeRefusal } from '../BrowserSessionList';

const refused = (detail: string, count?: number) =>
  describeBrowserAction({
    seq: 3,
    at: '2026-09-23T12:00:00.000Z',
    kind: 'agent-refused',
    actor: { kind: 'agent', sessionId: 's1' },
    detail,
    ...(count ? { count } : {}),
  });

describe('refused agent actions in the Browser pane history (#90 L5)', () => {
  test('a reason code reads as words, with its folded count', () => {
    expect(refused('human-controlling', 12)).toBe(
      'an agent was refused a browser action (a person was in control) ×12',
    );
    expect(describeRefusal('not-permitted')).toBe(
      'not allowed for agents in this Project',
    );
  });

  test('an unknown code is shown as the code, never dropped', () => {
    expect(refused('some-new-reason')).toBe(
      'an agent was refused a browser action (refused: some-new-reason)',
    );
  });
});
