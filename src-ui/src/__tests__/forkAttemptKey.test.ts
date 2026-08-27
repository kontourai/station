import { describe, expect, test } from 'vitest';
import {
  completeForkAttempt,
  getOrCreateForkAttemptKey,
} from '../components/chat-dock/forkAttemptKey';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe('fork attempt idempotency persistence', () => {
  test('cancel/reopen and ambiguous response loss reuse one coordinate key', () => {
    const persisted = storage();
    let generated = 0;
    const generate = () => `attempt-${++generated}`;
    expect(
      getOrCreateForkAttemptKey('parent', 'turn-1', persisted, generate),
    ).toBe('attempt-1');
    expect(
      getOrCreateForkAttemptKey('parent', 'turn-1', persisted, generate),
    ).toBe('attempt-1');
    expect(generated).toBe(1);
  });

  test('only a known terminal success releases the coordinate for a new fork', () => {
    const persisted = storage();
    const first = getOrCreateForkAttemptKey(
      'parent',
      'turn-1',
      persisted,
      () => 'attempt-1',
    );
    completeForkAttempt('parent', 'turn-1', 'different', persisted);
    expect(
      getOrCreateForkAttemptKey('parent', 'turn-1', persisted, () => 'new'),
    ).toBe(first);
    completeForkAttempt('parent', 'turn-1', first, persisted);
    expect(
      getOrCreateForkAttemptKey('parent', 'turn-1', persisted, () => 'new'),
    ).toBe('new');
  });

  test('quota/private write failure still reuses the in-memory key on cancel/reopen', () => {
    const unavailable = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
    };
    const first = getOrCreateForkAttemptKey(
      'quota-parent',
      'quota-turn',
      unavailable,
      () => 'quota-attempt',
    );
    expect(
      getOrCreateForkAttemptKey(
        'quota-parent',
        'quota-turn',
        unavailable,
        () => 'must-not-regenerate',
      ),
    ).toBe(first);
  });

  test('malformed storage cannot replace another coordinate memory entry', () => {
    const malformed = {
      getItem: () => '{broken',
      setItem: () => {
        throw new Error('unavailable');
      },
    };
    expect(
      getOrCreateForkAttemptKey(
        'malformed-parent',
        'turn-a',
        malformed,
        () => 'safe-a',
      ),
    ).toBe('safe-a');
    expect(
      getOrCreateForkAttemptKey(
        'malformed-parent',
        'turn-b',
        malformed,
        () => 'safe-b',
      ),
    ).toBe('safe-b');
  });
});
