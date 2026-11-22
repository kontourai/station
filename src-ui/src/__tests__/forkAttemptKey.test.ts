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
      getOrCreateForkAttemptKey('parent', 'turn-1', 'codex', persisted, generate),
    ).toBe('attempt-1');
    expect(
      getOrCreateForkAttemptKey('parent', 'turn-1', 'codex', persisted, generate),
    ).toBe('attempt-1');
    expect(generated).toBe(1);
  });

  test('only a known terminal success releases the coordinate for a new fork', () => {
    const persisted = storage();
    const first = getOrCreateForkAttemptKey('parent', 'turn-1', 'codex',
      persisted,
      () => 'attempt-1',
    );
    completeForkAttempt('parent', 'turn-1', 'codex', 'different', persisted);
    expect(
      getOrCreateForkAttemptKey('parent', 'turn-1', 'codex', persisted, () => 'new'),
    ).toBe(first);
    completeForkAttempt('parent', 'turn-1', 'codex', first, persisted);
    expect(
      getOrCreateForkAttemptKey('parent', 'turn-1', 'codex', persisted, () => 'new'),
    ).toBe('new');
  });

  test('another target Agent for the same turn is a separate request', () => {
    const persisted = storage();
    let generated = 0;
    const generate = () => `attempt-${++generated}`;
    const toCodex = getOrCreateForkAttemptKey(
      'retarget-parent',
      'turn-1',
      'codex',
      persisted,
      generate,
    );
    const toClaude = getOrCreateForkAttemptKey(
      'retarget-parent',
      'turn-1',
      'claude',
      persisted,
      generate,
    );
    expect(toCodex).toBe('attempt-1');
    expect(toClaude).toBe('attempt-2');
    // A retry to either target still reuses its own key.
    expect(
      getOrCreateForkAttemptKey('retarget-parent', 'turn-1', 'codex', persisted, generate),
    ).toBe(toCodex);
  });

  test('quota/private write failure still reuses the in-memory key on cancel/reopen', () => {
    const unavailable = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
    };
    const first = getOrCreateForkAttemptKey('quota-parent', 'quota-turn', 'codex',
      unavailable,
      () => 'quota-attempt',
    );
    expect(
      getOrCreateForkAttemptKey('quota-parent', 'quota-turn', 'codex',
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
      getOrCreateForkAttemptKey('malformed-parent', 'turn-a', 'codex',
        malformed,
        () => 'safe-a',
      ),
    ).toBe('safe-a');
    expect(
      getOrCreateForkAttemptKey('malformed-parent', 'turn-b', 'codex',
        malformed,
        () => 'safe-b',
      ),
    ).toBe('safe-b');
  });
});
