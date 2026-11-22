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
 * which only emptied the message list on screen, is gone: on an engine that
 * does not forward unknown commands it answers Unknown command.
 */
function run(command: string, openNewChat: (() => void) | undefined) {
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
      chatState: { provider: 'ollama', agentSlug: 'station' } as never,
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
    expect(addEphemeralMessage).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        content: expect.stringContaining('Unknown command: /clear'),
      }),
    );
  });
});
