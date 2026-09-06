import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { CodexRolloutSessionSource } from '../../../providers/sessions/codex-rollout-session-source.js';
import { AttachedSessionFollowService } from '../attached-session-follow-service.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';

const timestamp = '2026-09-06T00:00:00.000Z';
function line(type: string, payload: Record<string, unknown>): string {
  return `${JSON.stringify({ timestamp, type, payload })}\n`;
}
function turn(id: string): string {
  return [
    line('event_msg', { type: 'task_started', turn_id: id }),
    line('event_msg', { type: 'user_message', message: `Question ${id}` }),
    line('response_item', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: `Answer ${id}` }],
    }),
    line('event_msg', { type: 'task_complete', turn_id: id }),
  ].join('');
}

test('imports real rollout pages through durable follower cursors and resumes append after cold restart', async () => {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), 'station-codex-follow-')),
  );
  const homeDir = join(directory, 'codex');
  const project = join(directory, 'project');
  const sessions = join(homeDir, 'sessions', '2026', '09', '06');
  mkdirSync(project);
  mkdirSync(sessions, { recursive: true });
  const file = join(sessions, 'rollout-fixture.jsonl');
  writeFileSync(
    file,
    line('session_meta', { id: 'native-fixture', cwd: project }) + turn('t1'),
  );
  const database = join(directory, 'events.sqlite');
  let store = new EventStore(database);
  const follow = () =>
    new AttachedSessionFollowService({
      sources: [
        new CodexRolloutSessionSource({
          homeDir,
          maxEvents: 1,
          maxBytes: 512,
          maxLineBytes: 384,
        }),
      ],
      eventStore: store,
      eventBus: new EventBus(),
      listProjects: () => [{ slug: 'fixture', workingDirectory: project }],
    });
  try {
    const first = follow();
    for (let index = 0; index < 8; index++) await first.pollNow();
    const attached = store
      .readSessions()
      .find((session) => session.provider === 'codex');
    expect(attached).toMatchObject({
      controlMode: 'read-only-attached',
      attachedSource: {
        kind: 'codex-rollout',
        externalSessionId: 'native-fixture',
      },
    });
    const threadId = attached!.threadId;
    const before = store.listEvents(threadId);
    expect(
      before
        .filter((entry) => entry.payload.method === 'turn.started')
        .map((entry) => entry.payload),
    ).toMatchObject([{ prompt: 'Question t1', turnId: 't1' }]);
    expect(
      before
        .filter((entry) => entry.payload.method === 'content.text-delta')
        .map((entry) => entry.payload),
    ).toMatchObject([{ delta: 'Answer t1', turnId: 't1' }]);
    expect(
      before.filter((entry) => entry.payload.method === 'turn.completed'),
    ).toHaveLength(1);
    const beforeIds = before.map((entry) => entry.id);
    expect(attached!.resumeCursor).toMatchObject({
      cursor: { sourceState: { version: 1 } },
    });

    store.close();
    appendFileSync(file, turn('t2'));
    store = new EventStore(database);
    const restarted = follow();
    for (let index = 0; index < 8; index++) await restarted.pollNow();
    const after = store.listEvents(threadId);
    expect(after.filter((entry) => beforeIds.includes(entry.id))).toHaveLength(
      beforeIds.length,
    );
    expect(new Set(after.map((entry) => entry.id)).size).toBe(after.length);
    expect(
      after
        .filter((entry) => entry.payload.method === 'turn.started')
        .map((entry) => entry.payload),
    ).toMatchObject([
      { prompt: 'Question t1', turnId: 't1' },
      { prompt: 'Question t2', turnId: 't2' },
    ]);
    expect(
      after.filter((entry) => entry.payload.method === 'turn.completed'),
    ).toHaveLength(2);
    expect(
      store.readSessions().find((session) => session.threadId === threadId)
        ?.controlMode,
    ).toBe('read-only-attached');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
