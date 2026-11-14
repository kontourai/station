import { QueryClient } from '@tanstack/react-query';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../load', () => ({ loadSlashCommands: async () => undefined }));

import { dispatchSlashCommand } from '../dispatch';

/**
 * An unrecognised slash command in a chat on `opencode` (an engine that runs
 * saved ACP connections) reaches the engine as text, as it does on `acp`,
 * Claude and Codex, even when no ACP-bound Agent is in the list.
 */
function run(provider: string) {
  const addEphemeralMessage = vi.fn();
  const result = dispatchSlashCommand(
    'session-1',
    '/engine-only-command now',
    {
      autocomplete: {
        openModel: () => undefined,
        openNewChat: () => undefined,
        closeCommand: () => undefined,
        closeAll: () => undefined,
      },
    } as never,
    {
      apiBase: 'http://127.0.0.1:1',
      chatState: { provider } as never,
      agents: [] as never,
      updateChat: vi.fn() as never,
      addEphemeralMessage: addEphemeralMessage as never,
      queryClient: new QueryClient(),
      runSkillMutation: {} as never,
      readSkillDetail: (async () => null) as never,
    },
  );
  return { result, addEphemeralMessage };
}

describe('slash-command pass-through for ACP-family providers', () => {
  test.each(['opencode', 'acp', 'claude'])(
    '%s forwards an unknown command to the engine',
    async (provider) => {
      await expect(run(provider).result).resolves.toBe(
        '/engine-only-command now',
      );
    },
  );

  test('a provider that takes no engine commands does not', async () => {
    const { result } = run('ollama');
    await expect(result).resolves.not.toBe('/engine-only-command now');
  });
});
