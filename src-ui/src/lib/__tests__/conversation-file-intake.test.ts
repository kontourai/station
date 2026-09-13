/** @vitest-environment jsdom */
import { afterEach, expect, test, vi } from 'vitest';
import {
  FILE_INTAKE_HANDOFF_MS,
  registerConversationFileReceiver,
  requestConversationFileIntake,
} from '../conversation-file-intake';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanups.splice(0)) dispose();
  vi.useRealTimers();
});
const scope = (apiBase = 'http://station.test') => ({
  apiBase,
  authorityKey: 'owner',
  isCurrent: () => true,
});
const files = () => [new File(['hello'], 'note.txt', { type: 'text/plain' })];

test('waits for the named target and allows only one matching pane to consume', async () => {
  const first = vi.fn(async () => ({ added: 1, errors: [] }));
  const second = vi.fn(async () => ({ added: 1, errors: [] }));
  const wrong = vi.fn(async () => ({ added: 1, errors: [] }));
  cleanups.push(
    registerConversationFileReceiver({
      apiBase: 'http://other.test',
      sessionId: 'target',
      receive: wrong,
    }),
  );
  const activate = vi.fn();
  const pending = requestConversationFileIntake(
    scope(),
    'target',
    files(),
    activate,
  );
  expect(activate).toHaveBeenCalledOnce();
  expect(first).not.toHaveBeenCalled();
  cleanups.push(
    registerConversationFileReceiver({
      apiBase: 'http://station.test',
      sessionId: 'target',
      receive: first,
    }),
  );
  cleanups.push(
    registerConversationFileReceiver({
      apiBase: 'http://station.test',
      sessionId: 'target',
      receive: second,
    }),
  );
  await expect(pending).resolves.toEqual({ added: 1, errors: [] });
  expect(first).toHaveBeenCalledOnce();
  expect(second).not.toHaveBeenCalled();
  expect(wrong).not.toHaveBeenCalled();
});

test('an unavailable or read-only receiver reports failure rather than claiming attachment success', async () => {
  cleanups.push(
    registerConversationFileReceiver({
      apiBase: 'http://station.test',
      sessionId: 'readonly',
      receive: async () => {
        throw new Error('Read-only chat');
      },
    }),
  );
  await expect(
    requestConversationFileIntake(scope(), 'readonly', files(), () => {}),
  ).rejects.toThrow('Read-only');
  cleanups.push(
    registerConversationFileReceiver({
      apiBase: 'http://station.test',
      sessionId: 'reject',
      receive: async () => ({ added: 0, errors: ['Unsupported file'] }),
    }),
  );
  await expect(
    requestConversationFileIntake(scope(), 'reject', files(), () => {}),
  ).rejects.toThrow('Unsupported');
});

test('closing a receiving pane aborts unfinished conversion and permits a later fresh intake', async () => {
  let signal: AbortSignal | undefined;
  let finish:
    | ((value: { added: number; errors: string[] }) => void)
    | undefined;
  const dispose = registerConversationFileReceiver({
    apiBase: 'http://station.test',
    sessionId: 'close',
    receive: async (_files, op) => {
      signal = op.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const pending = requestConversationFileIntake(
    scope(),
    'close',
    files(),
    () => {},
  );
  const failed = expect(pending).rejects.toThrow('closed or changed');
  await vi.waitFor(() => expect(signal).toBeDefined());
  dispose();
  await failed;
  expect(signal?.aborted).toBe(true);
  finish?.({ added: 0, errors: ['closed'] });
});

test('a target that never mounts times out without sending files elsewhere', async () => {
  vi.useFakeTimers();
  const pending = requestConversationFileIntake(
    scope(),
    'absent',
    files(),
    () => {},
  );
  const failed = expect(pending).rejects.toThrow('did not become ready');
  await vi.advanceTimersByTimeAsync(FILE_INTAKE_HANDOFF_MS);
  await failed;
});

test('a lost Station scope refuses before receiver intake', async () => {
  let current = true;
  const captured = { ...scope(), isCurrent: () => current };
  const receive = vi.fn(async () => ({ added: 1, errors: [] }));
  const pending = requestConversationFileIntake(
    captured,
    'revoked',
    files(),
    () => {
      current = false;
    },
  );
  await expect(pending).rejects.toThrow('no longer selected');
  cleanups.push(
    registerConversationFileReceiver({
      apiBase: captured.apiBase,
      sessionId: 'revoked',
      receive,
    }),
  );
  expect(receive).not.toHaveBeenCalled();
});
