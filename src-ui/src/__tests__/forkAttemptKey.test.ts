import { describe, expect, test } from 'vitest';
import {
  completeForkAttempt,
  getOrCreateForkAttemptKey,
  runForkAttempt,
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

describe('runForkAttempt (the key lifecycle runFork uses)', () => {
  const coordinate = (conversation: string) => ({
    sourceConversationId: conversation,
    turnId: 'turn-1',
    targetAgentId: 'codex',
  });
  const isKeyConflict = (error: unknown) =>
    (error as { code?: unknown })?.code === 'key-conflict';

  test('a fork created but not opened keeps its key, so the retry replays it', async () => {
    const persisted = storage();
    let generated = 0;
    const keys: string[] = [];
    const options = {
      isKeyConflict,
      storage: persisted,
      generate: () => `attempt-${++generated}`,
    };
    await expect(
      runForkAttempt(
        coordinate('open-fails'),
        async (key) => {
          keys.push(key);
          throw new Error('The fork was created but could not be opened.');
        },
        options,
      ),
    ).rejects.toThrow('could not be opened');
    await runForkAttempt(
      coordinate('open-fails'),
      async (key) => {
        keys.push(key);
        return 'opened';
      },
      options,
    );
    expect(keys).toEqual(['attempt-1', 'attempt-1']);
    // Opened: the coordinate is free for a genuinely new fork.
    expect(
      getOrCreateForkAttemptKey(
        'open-fails',
        'turn-1',
        'codex',
        persisted,
        () => 'next',
      ),
    ).toBe('next');
  });

  test('a key conflict releases the key, so forking again is a new request', async () => {
    const persisted = storage();
    let generated = 0;
    const keys: string[] = [];
    const options = {
      isKeyConflict,
      storage: persisted,
      generate: () => `attempt-${++generated}`,
    };
    for (let i = 0; i < 2; i++)
      await expect(
        runForkAttempt(
          coordinate('conflicted'),
          async (key) => {
            keys.push(key);
            throw Object.assign(new Error('conflict'), {
              code: 'key-conflict',
            });
          },
          options,
        ),
      ).rejects.toThrow('conflict');
    expect(keys).toEqual(['attempt-1', 'attempt-2']);
  });
});
