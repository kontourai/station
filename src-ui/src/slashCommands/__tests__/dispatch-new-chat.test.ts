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
      agents: [] as never,
      updateChat: updateChat as never,
      addEphemeralMessage: addEphemeralMessage as never,
      queryClient: new QueryClient(),
      runSkillMutation: {} as never,
      readSkillDetail: (async () => null) as never,
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
  });
});
