import { QueryClient } from '@tanstack/react-query';
import { describe, expect, test, vi } from 'vitest';

// The built-in commands register on import; the loader that would import
// them lazily is not what is under test.
vi.mock('../load', () => ({ loadSlashCommands: async () => undefined }));

import '../builtins';
import { dispatchSlashCommand } from '../dispatch';
import { getAllCommands } from '../registry';

/**
 * /new starts a new chat through the surface's New chat action. /clear,
 * which only emptied the message list on screen, is gone, and is answered
 * here on every engine instead of being forwarded.
 */
function run(
  command: string,
  openNewChat: (() => void) | undefined,
  provider = 'ollama',
  extra: {
    agents?: unknown[];
    queryClient?: QueryClient;
    readSkillDetail?: (name: string) => Promise<unknown>;
  } = {},
) {
  const addEphemeralMessage = vi.fn();
  const updateChat = vi.fn();
  const result = dispatchSlashCommand(
    'session-1',
    command,
    {
      autocomplete: {
        openModel: () => undefined,
        openNewChat,
        closeCommand: () => undefined,
        closeAll: () => undefined,
      },
    },
    {
      apiBase: 'http://127.0.0.1:1',
      chatState: { provider, agentSlug: 'station' } as never,
      agents: (extra.agents ?? []) as never,
      updateChat: updateChat as never,
      addEphemeralMessage: addEphemeralMessage as never,
      queryClient: extra.queryClient ?? new QueryClient(),
      runSkillMutation: {
        mutateAsync: vi.fn().mockResolvedValue(undefined),
      } as never,
      readSkillDetail: (extra.readSkillDetail ?? (async () => null)) as never,
    },
  );
  return { result, addEphemeralMessage, updateChat };
}

describe('/new and /clear', () => {
  test('/new calls the New chat action and leaves the transcript alone', async () => {
    const openNewChat = vi.fn();
    const { result, addEphemeralMessage, updateChat } = run(
      '/new',
      openNewChat,
    );
    await expect(result).resolves.toBe(true);
    expect(openNewChat).toHaveBeenCalledTimes(1);
    expect(updateChat).not.toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ messages: [] }),
    );
    expect(addEphemeralMessage).not.toHaveBeenCalled();
  });

  test('/new where the surface has no New chat says where to start one', async () => {
    const { result, addEphemeralMessage } = run('/new', undefined);
    await expect(result).resolves.toBe(true);
    expect(addEphemeralMessage).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        content: 'Start a new chat from the chat panel.',
      }),
    );
  });

  // Claude and Codex chats forward unknown commands to the engine as a turn.
  // /clear must not go: Claude Code would clear its own context while the
  // transcript still shows everything, and Codex would take it as a message.
  test.each(['claude', 'codex'])(
    '/clear in a %s chat is answered here, never sent to the engine',
    async (provider) => {
      const openNewChat = vi.fn();
      const { result, addEphemeralMessage } = run(
        '/clear',
        openNewChat,
        provider,
      );
      await expect(result).resolves.toBe(true);
      expect(openNewChat).not.toHaveBeenCalled();
      expect(addEphemeralMessage).toHaveBeenCalledWith('session-1', {
        role: 'system',
        content: '/clear isn’t a Station command. Use /new for a new chat.',
      });
    },
  );

  // A person's own `clear` wins over Station's answer: it is theirs, and the
  // refusal exists only because Station no longer has a /clear.
  test('an agent’s own clear command still runs in a claude chat', async () => {
    const { result, addEphemeralMessage } = run('/clear', vi.fn(), 'claude', {
      agents: [
        {
          slug: 'station',
          commands: {
            clear: { name: 'clear', prompt: 'Summarise and start over.' },
          },
        },
      ],
    });
    await expect(result).resolves.toBe('Summarise and start over.');
    expect(addEphemeralMessage).not.toHaveBeenCalled();
  });

  test('a command skill named clear still runs in a claude chat', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      ['skills', 'local'],
      [{ name: 'clear', command: { enabled: true, global: true } }],
    );
    const { result, addEphemeralMessage } = run('/clear', vi.fn(), 'claude', {
      queryClient,
      readSkillDetail: async () => ({
        name: 'clear',
        body: 'Tidy the workspace.',
        variables: [],
      }),
    });
    await expect(result).resolves.toBe('Tidy the workspace.');
    expect(addEphemeralMessage).not.toHaveBeenCalled();
  });

  test('an unknown command in a claude chat still goes to the engine', async () => {
    await expect(run('/compact-now', vi.fn(), 'claude').result).resolves.toBe(
      '/compact-now',
    );
  });

  test('/new with text keeps the line as typed and opens nothing', async () => {
    const openNewChat = vi.fn();
    const { result, addEphemeralMessage, updateChat } = run(
      '/new fix the login bug',
      openNewChat,
    );
    await expect(result).resolves.toBe(true);
    expect(openNewChat).not.toHaveBeenCalled();
    expect(updateChat).not.toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ input: '' }),
    );
    expect(addEphemeralMessage).toHaveBeenCalledWith('session-1', {
      role: 'system',
      content: '/new takes no text.',
    });
  });

  test('/clear is not registered', async () => {
    expect(getAllCommands()).toContain('new');
    expect(getAllCommands()).not.toContain('clear');
    const openNewChat = vi.fn();
    const { result, addEphemeralMessage, updateChat } = run(
      '/clear',
      openNewChat,
    );
    await expect(result).resolves.toBe(true);
    expect(openNewChat).not.toHaveBeenCalled();
    expect(updateChat).not.toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ messages: [] }),
    );
    expect(addEphemeralMessage).toHaveBeenCalledWith('session-1', {
      role: 'system',
      content: '/clear isn’t a Station command. Use /new for a new chat.',
    });
    // Not a command that ran: the line stays in the composer (#5491).
    expect(updateChat).not.toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ input: '' }),
    );
  });

  test("an Agent's own command refused before it runs keeps its line", async () => {
    const { result, addEphemeralMessage, updateChat } = run(
      '/deploy',
      undefined,
      'ollama',
      {
        agents: [
          {
            slug: 'station',
            name: 'Station',
            commands: {
              deploy: {
                prompt: 'Deploy to {{env}}',
                params: [{ name: 'env', required: true }],
              },
            },
          },
        ],
      },
    );
    await expect(result).resolves.toBe(true);
    expect(addEphemeralMessage).toHaveBeenCalledWith('session-1', {
      role: 'system',
      content: '/deploy didn’t run. Enter a value for env',
    });
    expect(updateChat).not.toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ input: '' }),
    );
  });
});
