import { appendFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  grokSession,
  oneTurn,
} from '../../../providers/sessions/__tests__/grok-session-fixtures.js';
import { GrokSessionSource } from '../../../providers/sessions/grok-session-source.js';
import { AttachedSessionFollowService } from '../attached-session-follow-service.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';

let directory: string;
let homeDir: string;
let project: string;
let database: string;

const makeTempDir = trackTempDirs();

beforeEach(() => {
  directory = realpathSync(makeTempDir('station-grok-follow-'));
  homeDir = join(directory, 'grok');
  project = join(directory, 'project');
  database = join(directory, 'events.sqlite');
  mkdirSync(project);
});

function follower(store: EventStore): AttachedSessionFollowService {
  return new AttachedSessionFollowService({
    sources: [new GrokSessionSource({ homeDir, maxEvents: 2 })],
    eventStore: store,
    eventBus: new EventBus(),
    listProjects: () => [{ slug: 'fixture', workingDirectory: project }],
  });
}

test('a Grok session in a project is followed into the read model and resumes after restart', async () => {
  const { sessionId, file, writer } = grokSession(homeDir, {
    sessionId: '01a0b170-50ce-7203-99d8-000000000001',
    cwd: join(project, 'packages', 'app'),
    lines: '',
  });
  appendFileSync(file, oneTurn(writer, 'Question one', 'Answer one'));
  let store = new EventStore(database);
  try {
    const first = follower(store);
    for (let poll = 0; poll < 6; poll += 1) await first.pollNow();
    const attached = store
      .readSessions()
      .find((session) => session.provider === 'grok-build');
    expect(attached).toMatchObject({
      controlMode: 'read-only-attached',
      cwd: join(project, 'packages', 'app'),
      attachedSource: {
        kind: 'grok-session',
        externalSessionId: sessionId,
        affinity: { kind: 'grok-config-home', ref: expect.any(String) },
      },
    });
    const threadId = attached!.threadId;
    const before = store.listEvents(threadId);
    expect(
      before
        .filter((entry) => entry.payload.method === 'session.configured')
        .at(-1)?.payload,
    ).toMatchObject({ metadata: { projectSlug: 'fixture' } });
    expect(
      before
        .filter((entry) => entry.payload.method === 'turn.started')
        .map((entry) => entry.payload),
    ).toMatchObject([{ prompt: 'Question one' }]);

    store.close();
    appendFileSync(file, oneTurn(writer, 'Question two', 'Answer two'));
    store = new EventStore(database);
    const restarted = follower(store);
    for (let poll = 0; poll < 6; poll += 1) await restarted.pollNow();
    const after = store.listEvents(threadId);
    expect(new Set(after.map((entry) => entry.id)).size).toBe(after.length);
    expect(
      after
        .filter((entry) => entry.payload.method === 'turn.started')
        .map((entry) => entry.payload),
    ).toMatchObject([{ prompt: 'Question one' }, { prompt: 'Question two' }]);
    expect(
      after
        .filter((entry) => entry.payload.method === 'content.text-delta')
        .map((entry) => entry.payload),
    ).toMatchObject([{ delta: 'Answer one' }, { delta: 'Answer two' }]);
    expect(
      after.filter((entry) => entry.payload.method === 'turn.completed'),
    ).toHaveLength(2);
  } finally {
    store.close();
  }
});

test("Station's own Grok session, run through ACP, is not imported a second time", async () => {
  const { sessionId, file, writer } = grokSession(homeDir, {
    sessionId: '01a0b170-50ce-7203-99d8-000000000002',
    cwd: project,
    lines: '',
  });
  appendFileSync(file, oneTurn(writer, 'Station prompt', 'Station answer'));
  const store = new EventStore(database);
  try {
    store.upsertSession({
      provider: 'acp',
      threadId: 'station-grok-thread',
      status: 'ready',
      cwd: project,
      resumeCursor: { acpSessionId: sessionId, connectionId: 'grok-build' },
      controlMode: 'station-owned',
      createdAt: '2026-09-17T16:15:00.000Z',
      updatedAt: '2026-09-17T16:15:00.000Z',
    });
    const follow = follower(store);
    for (let poll = 0; poll < 3; poll += 1) await follow.pollNow();
    expect(store.readSessions().map((session) => session.provider)).toEqual([
      'acp',
    ]);
  } finally {
    store.close();
  }
});
