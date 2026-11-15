import { QueryClient } from '@tanstack/react-query';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../load', () => ({ loadSlashCommands: async () => undefined }));

import { dispatchSlashCommand } from '../dispatch';

/**
 * An unrecognised slash command reaches an ACP-family engine (`acp`, or
 * `opencode` behind its Feature Preview) only through an Agent bound to a
 * saved ACP connection, as on the base; without one it is "Unknown command",
 * so a typo never becomes a billed prompt. Claude and Codex always forward.
 */
function run(provider: string, agents: unknown[] = []) {
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
      chatState: { provider, agentSlug: 'oc' } as never,
      agents: agents as never,
      updateChat: vi.fn() as never,
      addEphemeralMessage: addEphemeralMessage as never,
      queryClient: new QueryClient(),
      runSkillMutation: {} as never,
      readSkillDetail: (async () => null) as never,
    },
  );
  return { result, addEphemeralMessage };
}

const ACP_AGENT = { slug: 'oc', engineConnectionType: 'acp' };

describe('slash-command pass-through for ACP-family providers', () => {
  test.each(['claude', 'codex'])(
    '%s forwards an unknown command to the engine',
    async (provider) => {
      await expect(run(provider).result).resolves.toBe(
        '/engine-only-command now',
      );
    },
  );

  test.each(['acp', 'opencode', 'ollama'])(
    '%s without an ACP-bound Agent answers Unknown command',
    async (provider) => {
      const { result, addEphemeralMessage } = run(provider);
      await expect(result).resolves.toBe(true);
      expect(addEphemeralMessage).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({
          content: expect.stringContaining(
            'Unknown command: /engine-only-command now',
          ),
        }),
      );
    },
  );

  test.each(['acp', 'opencode'])(
    '%s with an ACP-bound Agent forwards it',
    async (provider) => {
      await expect(run(provider, [ACP_AGENT]).result).resolves.toBe(
        '/engine-only-command now',
      );
    },
  );
});
