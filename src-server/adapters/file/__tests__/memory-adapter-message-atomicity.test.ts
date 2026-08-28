/**
 * archive#2252 — a destructive rewrite must publish atomically.
 *
 * Separate file because it mocks `node:fs/promises`, and a module mock is
 * file-scoped: keeping it here leaves the behavioural suite next door running
 * against the real filesystem.
 *
 * The discriminating property is that the transcript is written to a
 * temporary path and moved into place. `writeFile(path)` truncates in place,
 * so a failure part-way through leaves a half-written transcript; with
 * temp+rename a failure at publication leaves the previous file untouched.
 *
 * Forcing `rename` to fail is what separates the two implementations. Under
 * temp+rename the original survives and the caller sees the error. Under an
 * in-place write the file has already been replaced before anything could
 * fail — which is exactly the state a crash would leave behind.
 */

import { readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { UIMessage } from 'ai';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let failRename = false;

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    default: actual,
    rename: async (from: string, to: string) => {
      if (failRename) throw new Error('injected rename failure');
      return actual.rename(from, to);
    },
  };
});

const { FileMemoryAdapter } = await import('../memory-adapter.js');

const USER = 'u1';
const CONVERSATION = 'c1';

function message(id: string): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text: id }] } as UIMessage;
}

describe('destructive message rewrites publish atomically (station#2252)', () => {
  let projectHomeDir: string;
  let adapter: InstanceType<typeof FileMemoryAdapter>;

  beforeEach(async () => {
    failRename = false;
    projectHomeDir = await mkdtemp(join(tmpdir(), 'station-memory-atomic-'));
    adapter = new FileMemoryAdapter({ projectHomeDir });
    await adapter.createConversation({
      id: CONVERSATION,
      resourceId: 'agent-a',
      userId: USER,
      title: 'T',
      metadata: {},
    });
  });

  afterEach(async () => {
    failRename = false;
    await rm(projectHomeDir, { recursive: true, force: true });
  });

  async function messagesPath(): Promise<string> {
    const paths = (adapter as unknown as { paths: MessagePaths }).paths;
    const conversations = (
      adapter as unknown as { conversations: ConversationResolver }
    ).conversations;
    return paths.getMessagesPath(
      await conversations.resolveResourceId(CONVERSATION, USER),
      CONVERSATION,
    );
  }

  test('a failure at publication leaves the previous transcript intact', async () => {
    await adapter.addMessages(
      [message('m1'), message('m2'), message('m3')],
      USER,
      CONVERSATION,
    );
    const path = await messagesPath();
    const before = await readFile(path, 'utf-8');

    failRename = true;
    await expect(
      adapter.deleteMessages(['m2'], USER, CONVERSATION),
    ).rejects.toThrow(/injected rename failure/);

    // The whole point: no partially-rewritten transcript. An in-place write
    // has already replaced the file by the time anything can fail.
    expect(await readFile(path, 'utf-8')).toBe(before);
    const messages = await adapter.getMessages(USER, CONVERSATION);
    expect(messages.map((m) => String(m.id))).toEqual(['m1', 'm2', 'm3']);
  });

  test('a failed publication does not strand its temporary file', async () => {
    await adapter.addMessages(
      [message('m1'), message('m2')],
      USER,
      CONVERSATION,
    );
    const path = await messagesPath();

    failRename = true;
    await expect(
      adapter.deleteMessages(['m1'], USER, CONVERSATION),
    ).rejects.toThrow(/injected rename failure/);

    const strays = readdirSync(dirname(path)).filter((name) =>
      name.endsWith('.tmp'),
    );
    expect(strays).toEqual([]);
  });

  test('a later mutation still succeeds after a failed one', async () => {
    await adapter.addMessages(
      [message('m1'), message('m2')],
      USER,
      CONVERSATION,
    );

    failRename = true;
    await expect(
      adapter.deleteMessages(['m1'], USER, CONVERSATION),
    ).rejects.toThrow();

    // The per-file queue chains off the SETTLED tail, so one rejected
    // mutation must not wedge every later caller on that file.
    failRename = false;
    await adapter.deleteMessages(['m1'], USER, CONVERSATION);
    const messages = await adapter.getMessages(USER, CONVERSATION);
    expect(messages.map((m) => String(m.id))).toEqual(['m2']);
  });
});

interface MessagePaths {
  getMessagesPath(resourceId: string, conversationId: string): string;
}

interface ConversationResolver {
  resolveResourceId(conversationId?: string, userId?: string): Promise<string>;
}
