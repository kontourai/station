/**
 * station#2252 — durable, serialized mutation of the message transcript.
 *
 * The conversation document next door was hardened in #1566 (atomic
 * temp+rename, per-id serialized queue). The transcript never was, and the two
 * destructive operations — delete-by-id and remove-last — were read-modify-write
 * over the whole file with `writeFile(path)`. Two consequences:
 *
 *  - a message appended between their read and their write was destroyed;
 *  - `writeFile` truncates in place, so a crash mid-write left a half-written
 *    transcript.
 *
 * These tests drive the real adapter against a real temp filesystem.
 *
 * Scope note: serialization here is IN-PROCESS by design, and there is
 * deliberately no cross-process lock to test. Not because only one writer can
 * exist — `station start` conflict-checks ports only, never the home, so two
 * instances sharing `~/.station` remain possible and remain lossy between
 * them. Because a lock protocol hand-rolled over NDJSON is the wrong shape:
 * when concurrent writers become a supported shape, the answer is an adapter
 * with real transactions (#2904).
 */

import { readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { UIMessage } from 'ai';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { FileMemoryAdapter } from '../memory-adapter.js';

const USER = 'u1';
const CONVERSATION = 'c1';

function message(id: string, text: string): UIMessage {
  return {
    id,
    role: 'user',
    parts: [{ type: 'text', text }],
  } as UIMessage;
}

describe('FileMemoryAdapter message mutations (station#2252)', () => {
  let projectHomeDir: string;
  let adapter: FileMemoryAdapter;

  beforeEach(async () => {
    projectHomeDir = await mkdtemp(join(tmpdir(), 'station-memory-msg-'));
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
    await rm(projectHomeDir, { recursive: true, force: true });
  });

  async function ids(): Promise<string[]> {
    const messages = await adapter.getMessages(USER, CONVERSATION);
    return messages.map((m) => String(m.id));
  }

  /**
   * NB: this one does NOT prove serialization, and is not offered as proof.
   * Verified against an unserialized build (and again at a 4000-message
   * fixture): it stays green either way. `deleteMessages` streams the file,
   * so an append landing during the read is simply picked up by the read and
   * survives the rewrite; the losing window is the narrow gap between the
   * read finishing and the write landing, which this cannot force.
   *
   * `removeLastMessage` below is the discriminating case — there the appended
   * line becomes the last line and gets popped — and it reds without the
   * queue. This test earns its place as coexistence coverage for the delete
   * path, not as evidence for the fix.
   */
  test('a delete and a concurrent append both apply', async () => {
    await adapter.addMessages(
      [message('m1', 'one'), message('m2', 'two')],
      USER,
      CONVERSATION,
    );

    // Fired back-to-back with no await between them, so both calls'
    // synchronous prefix runs before either write lands — the exact interleave
    // that used to let the delete's stale snapshot clobber the append.
    const deleting = adapter.deleteMessages(['m1'], USER, CONVERSATION);
    const appending = adapter.addMessage(
      message('m3', 'three'),
      USER,
      CONVERSATION,
    );
    await Promise.all([deleting, appending]);

    const remaining = await ids();
    expect(remaining).toContain('m3');
    expect(remaining).not.toContain('m1');
    expect(remaining).toContain('m2');
  });

  test('an append landing during removeLastMessage is not destroyed', async () => {
    await adapter.addMessages(
      [message('m1', 'one'), message('m2', 'two')],
      USER,
      CONVERSATION,
    );

    const removing = adapter.removeLastMessage(USER, CONVERSATION);
    const appending = adapter.addMessage(
      message('m3', 'three'),
      USER,
      CONVERSATION,
    );
    await Promise.all([removing, appending]);

    // NB the ordering here is incidental, not guaranteed: `removeLast` reaches
    // the queue first because it awaits one cached `resolveResourceId` while
    // the append additionally awaits a real `mkdir`. If the append won the
    // slot, `removeLast` would legitimately pop m3 and this would red — that
    // ambiguity is intrinsic to "remove the last message" under a concurrent
    // append, not a defect. What the serialization guarantees, and what this
    // pins, is that the two operations compose instead of one silently
    // erasing the other: without the queue m3 vanishes entirely.
    const remaining = await ids();
    expect(remaining).toContain('m3');
    expect(remaining).toHaveLength(2);
  });

  test('a delete keeps a line it cannot parse instead of sweeping it away', async () => {
    await adapter.addMessages(
      [message('m1', 'one'), message('m2', 'two')],
      USER,
      CONVERSATION,
    );

    const path = await messagesPath();
    const original = await readFile(path, 'utf-8');
    await writeFile(path, `${original}{ not json\n`, 'utf-8');

    await adapter.deleteMessages(['m1'], USER, CONVERSATION);

    // The reader drops unparseable lines, so rewriting from ITS output would
    // silently discard this line. A delete-by-id must not double as a
    // corruption sweep.
    const raw = await readFile(path, 'utf-8');
    expect(raw).toContain('{ not json');
    expect(raw).not.toContain('"m1"');
    expect(raw).toContain('"m2"');
  });

  test('surviving messages are written back byte-identically', async () => {
    await adapter.addMessages(
      [message('m1', 'one'), message('m2', 'two')],
      USER,
      CONVERSATION,
    );
    const path = await messagesPath();
    const before = (await readFile(path, 'utf-8'))
      .split('\n')
      .filter((line) => line.includes('"m2"'));

    await adapter.deleteMessages(['m1'], USER, CONVERSATION);

    const after = (await readFile(path, 'utf-8'))
      .split('\n')
      .filter((line) => line.includes('"m2"'));
    // Re-serializing through the parsed object would be lossy for any field
    // the reader does not model; keeping the original line text is not.
    expect(after).toEqual(before);
  });

  test('a destructive rewrite leaves no temp file behind', async () => {
    await adapter.addMessages(
      [message('m1', 'one'), message('m2', 'two')],
      USER,
      CONVERSATION,
    );
    await adapter.deleteMessages(['m1'], USER, CONVERSATION);

    const dir = dirname(await messagesPath());
    const strays = readdirSync(dir).filter((name) => name.endsWith('.tmp'));
    expect(strays).toEqual([]);
  });

  test('deleting an id that is not present rewrites nothing', async () => {
    await adapter.addMessages([message('m1', 'one')], USER, CONVERSATION);
    const path = await messagesPath();
    const before = await readFile(path, 'utf-8');

    await adapter.deleteMessages(['nope'], USER, CONVERSATION);

    expect(await readFile(path, 'utf-8')).toBe(before);
  });

  async function messagesPath(): Promise<string> {
    // Resolve the same way the adapter does rather than reconstructing the
    // layout here, so a path-scheme change fails the adapter's own tests
    // instead of silently pointing this helper at nothing.
    const paths = (adapter as unknown as { paths: MessagePaths }).paths;
    const conversations = (
      adapter as unknown as { conversations: ConversationResolver }
    ).conversations;
    const resourceId = await conversations.resolveResourceId(
      CONVERSATION,
      USER,
    );
    return paths.getMessagesPath(resourceId, CONVERSATION);
  }
});

interface MessagePaths {
  getMessagesPath(resourceId: string, conversationId: string): string;
}

interface ConversationResolver {
  resolveResourceId(conversationId?: string, userId?: string): Promise<string>;
}
