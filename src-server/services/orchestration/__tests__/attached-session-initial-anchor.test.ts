import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { AttachedSessionSource } from '../../../providers/sessions/attached-session-source.js';
import { ClaudeTranscriptSessionSource } from '../../../providers/sessions/claude-transcript-session-source.js';
import { AttachedSessionFollowService } from '../attached-session-follow-service.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';

const tempDir = trackTempDirs();
const windowBytes = 2 * 1024 * 1024;
const padding = `${JSON.stringify({ type: 'unknown', padding: 'x'.repeat(1024) })}\n`;
function transcript(home: string, cwd: string, id = 'cold') {
  const project = join(home, 'projects', 'encoded');
  mkdirSync(project, { recursive: true });
  const path = join(project, `${id}.jsonl`);
  const line = (uuid: string) =>
    `${JSON.stringify({ type: 'user', uuid, sessionId: id, cwd, timestamp: '2026-10-15T00:00:00.000Z', message: { role: 'user', content: uuid } })}\n`;
  return { path, line };
}

test.each([
  { recovery: 'rediscovery', large: false },
  { recovery: 'restart', large: false },
  { recovery: 'restart', large: true },
  { recovery: 'cache eviction', large: true },
] as const)(
  'retains the observed cold page after a real failed write, growth and $recovery (large=$large)',
  async ({ recovery, large }) => {
    const directory = tempDir('station-initial-anchor-');
    const configDir = join(directory, 'claude');
    const file = transcript(configDir, directory);
    writeFileSync(
      file.path,
      (large
        ? file.line('outside-retained-window') + padding.repeat(2100)
        : '') +
        file.line('cold-first') +
        file.line('cold-second'),
    );
    const database = join(directory, 'orchestration.sqlite');
    let store = new EventStore(database);
    const peer = new DatabaseSync(database);
    let source = new ClaudeTranscriptSessionSource({
      configDir,
      maxCandidates: 512,
    });
    let observedIds: string[] = [];
    let threadId = '';
    let hold = true;
    let evict = false;
    const wrapped: AttachedSessionSource = {
      provider: source.provider,
      kind: source.kind,
      async discover() {
        const result = await source.discover();
        return {
          ...result,
          sessions: result.sessions.filter(
            (item) => !evict || item.sessionId !== 'cold',
          ),
        };
      },
      initialCursor: (descriptor) => source.initialCursor(descriptor),
      async read(descriptor, cursor) {
        const result = await source.read(descriptor, cursor);
        if (hold) {
          hold = false;
          observedIds = result.events.map((event) => event.eventId);
          threadId = descriptor.threadId;
          expect(observedIds).toHaveLength(2);
          // The real first page has been observed. Hold the peer writer until
          // the follower's actual SQLite import write exhausts its budget.
          peer.exec('BEGIN IMMEDIATE');
        }
        return result;
      },
    };
    const follow = (item: AttachedSessionSource) =>
      new AttachedSessionFollowService({
        sources: [item],
        eventStore: store,
        eventBus: new EventBus(),
        listProjects: () => [{ slug: 'app', workingDirectory: directory }],
      });
    let service = follow(wrapped);
    try {
      await expect(service.pollNow()).rejects.toThrow(
        /database is locked|SQLITE_BUSY/,
      );
      expect(store.listEvents(threadId).map((event) => event.id)).not.toEqual(
        expect.arrayContaining(observedIds),
      );
      peer.exec('ROLLBACK');
      const retained = readFileSync(file.path);
      appendFileSync(
        file.path,
        padding.repeat(2100) + file.line('after-growth'),
      );
      expect(statSync(file.path).size - retained.length).toBeGreaterThan(
        windowBytes,
      );
      expect(readFileSync(file.path).subarray(0, retained.length)).toEqual(
        retained,
      );

      if (recovery === 'restart') {
        await service.stop();
        store.close();
        store = new EventStore(database);
        source = new ClaudeTranscriptSessionSource({ configDir });
        service = follow(source);
      } else if (recovery === 'cache eviction') {
        // Exceed the real 256-thread LRU without exposing the failed page.
        for (let index = 0; index < 257; index += 1) {
          const other = transcript(configDir, directory, `evict-${index}`);
          writeFileSync(other.path, other.line(`other-${index}`));
        }
        evict = true;
        await service.pollNow();
        evict = false;
      }
      await service.pollNow();
      await service.pollNow();
      await service.pollNow();
      const durable = store.listEvents(threadId);
      expect(durable.map((event) => event.id)).toEqual(
        expect.arrayContaining(observedIds),
      );
      expect(
        durable
          .filter((event) => observedIds.includes(event.id))
          .map((event) => event.id),
      ).toEqual(observedIds);
      expect(new Set(durable.map((event) => event.id)).size).toBe(
        durable.length,
      );
      const session = store
        .readSessions()
        .find((item) => item.threadId === threadId);
      expect(session?.resumeCursor).toMatchObject({
        cursor: { offset: statSync(file.path).size },
      });
      expect(
        Buffer.byteLength(JSON.stringify(session?.resumeCursor)),
      ).toBeLessThan(1024);
      if (recovery === 'restart') {
        // Same native id in a different source home cannot borrow the anchor.
        const otherHome = join(directory, 'other-claude');
        const otherFile = transcript(otherHome, directory);
        writeFileSync(otherFile.path, otherFile.line('wrong-home'));
        const prior = store.readSessions()[0];
        const other = follow(
          new ClaudeTranscriptSessionSource({ configDir: otherHome }),
        );
        try {
          await other.pollNow();
          expect(store.readSessions()[0]).toEqual(prior);
        } finally {
          await other.stop();
        }
      }
    } finally {
      if (peer.isTransaction) peer.exec('ROLLBACK');
      await service.stop();
      peer.close();
      store.close();
    }
  },
  30_000,
);

test('does not observe a cold page until its anchor write succeeds', async () => {
  const directory = tempDir('station-anchor-before-read-');
  const configDir = join(directory, 'claude');
  const file = transcript(configDir, directory);
  writeFileSync(file.path, file.line('first'));
  const database = join(directory, 'orchestration.sqlite');
  const store = new EventStore(database);
  const peer = new DatabaseSync(database);
  const source = new ClaudeTranscriptSessionSource({ configDir });
  const metadataWrites = vi.spyOn(store, 'upsertSession');
  let reads = 0;
  let hold = true;
  const wrapped: AttachedSessionSource = {
    provider: source.provider,
    kind: source.kind,
    discover: () => source.discover(),
    async initialCursor(descriptor) {
      const cursor = await source.initialCursor(descriptor);
      if (hold) {
        hold = false;
        peer.exec('BEGIN IMMEDIATE');
      }
      return cursor;
    },
    async read(descriptor, cursor) {
      reads += 1;
      return source.read(descriptor, cursor);
    },
  };
  const service = new AttachedSessionFollowService({
    sources: [wrapped],
    eventStore: store,
    eventBus: new EventBus(),
    listProjects: () => [{ slug: 'app', workingDirectory: directory }],
  });
  try {
    await expect(service.pollNow()).rejects.toThrow(
      /database is locked|SQLITE_BUSY/,
    );
    expect(reads).toBe(0);
    expect(store.readSessions()).toEqual([]);
    peer.exec('ROLLBACK');
    metadataWrites.mockClear();
    await service.pollNow();
    expect(metadataWrites).toHaveBeenCalledTimes(2);
    expect(reads).toBe(1);
    expect(store.readSessions()[0]?.resumeCursor).toMatchObject({
      cursor: { offset: statSync(file.path).size },
    });
  } finally {
    if (peer.isTransaction) peer.exec('ROLLBACK');
    await service.stop();
    peer.close();
    store.close();
  }
}, 15_000);

test('resumes following a rewritten transcript after its saved offset exceeds the file size', async () => {
  const directory = tempDir('station-truncated-transcript-');
  const configDir = join(directory, 'claude');
  const file = transcript(configDir, directory);
  writeFileSync(
    file.path,
    file.line('original-first') + file.line('original-second'),
  );
  const store = new EventStore(join(directory, 'orchestration.sqlite'));
  const source = new ClaudeTranscriptSessionSource({ configDir });
  const service = new AttachedSessionFollowService({
    sources: [source],
    eventStore: store,
    eventBus: new EventBus(),
    listProjects: () => [{ slug: 'app', workingDirectory: directory }],
  });
  const importedPrompts = () =>
    store
      .listEvents(store.readSessions()[0].threadId)
      .flatMap((event) =>
        event.payload.method === 'turn.started' ? [event.payload.prompt] : [],
      );
  try {
    await service.pollNow();
    expect(importedPrompts()).toEqual(['original-first', 'original-second']);
    writeFileSync(file.path, file.line('short'));
    await service.pollNow();
    await service.pollNow();
    expect(importedPrompts()).toContain('short');
    appendFileSync(file.path, file.line('appended'));
    await service.pollNow();
    expect(importedPrompts()).toEqual([
      'original-first',
      'original-second',
      'short',
      'appended',
    ]);
    expect(store.readSessions()[0].resumeCursor).toMatchObject({
      cursor: { offset: statSync(file.path).size },
    });
  } finally {
    await service.stop();
    store.close();
  }
});
