import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { OpenCodeFixtureWriter } from '../../../providers/sessions/__tests__/opencode-fixture.js';
import { OpenCodeSessionSource } from '../../../providers/sessions/opencode-session-source.js';
import { AttachedSessionFollowService } from '../attached-session-follow-service.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { buildOrchestrationSessionSummary } from '../orchestration-session-state.js';

const tempDir = trackTempDirs();

function turn(
  store: OpenCodeFixtureWriter,
  sessionId: string,
  question: string,
  answer: string,
): string {
  const user = store.user(sessionId, [question]);
  const reply = store.assistant(sessionId, user, { finish: 'stop' });
  store.text(sessionId, reply, answer);
  store.stepFinish(sessionId, reply, {
    input: 10,
    output: 5,
    reasoning: 0,
    read: 0,
    write: 0,
  });
  return user;
}

test('an OpenCode session in a project appears in the read model and resumes after a cold restart', async () => {
  const directory = realpathSync(tempDir('station-opencode-follow-'));
  const dataDir = join(directory, 'opencode');
  const project = join(directory, 'project');
  mkdirSync(project);
  const writer = new OpenCodeFixtureWriter(dataDir);
  writer.session('ses_fixture', join(project, 'packages', 'app'));
  const firstTurn = turn(writer, 'ses_fixture', 'Question one', 'Answer one');

  const database = join(directory, 'events.sqlite');
  let store = new EventStore(database);
  const follow = () =>
    new AttachedSessionFollowService({
      sources: [new OpenCodeSessionSource({ dataDir, maxEvents: 2 })],
      eventStore: store,
      eventBus: new EventBus(),
      listProjects: () => [{ slug: 'fixture', workingDirectory: project }],
    });
  try {
    const first = follow();
    for (let index = 0; index < 8; index++) await first.pollNow();
    const attached = store
      .readSessions()
      .find((session) => session.provider === 'opencode');
    expect(attached).toMatchObject({
      controlMode: 'read-only-attached',
      attachedSource: {
        kind: 'opencode-session',
        externalSessionId: 'ses_fixture',
        affinity: { kind: 'opencode-data-home', ref: expect.any(String) },
      },
    });
    const threadId = attached!.threadId;
    // The session's cwd is inside the project, so the read model files it
    // under that project.
    const summary = buildOrchestrationSessionSummary({
      answerability: {
        threadAttachment: 'detached',
        providerRegistered: true,
        observedBy: 'test-instance#0',
        observedAt: '2026-10-01T00:00:00.000Z',
      },
      persisted: attached!,
      events: store
        .listEvents(threadId)
        .map((item) => item.payload as unknown as CanonicalRuntimeEvent),
    });
    expect(summary).toMatchObject({
      provider: 'opencode',
      projectSlug: 'fixture',
    });
    const before = store.listEvents(threadId);
    expect(
      before
        .filter((entry) => entry.payload.method === 'turn.started')
        .map((entry) => entry.payload),
    ).toMatchObject([{ prompt: 'Question one', turnId: firstTurn }]);
    expect(
      before
        .filter((entry) => entry.payload.method === 'content.text-delta')
        .map((entry) => entry.payload),
    ).toMatchObject([{ delta: 'Answer one', turnId: firstTurn }]);
    expect(
      before.filter((entry) => entry.payload.method === 'turn.completed'),
    ).toHaveLength(1);
    const beforeIds = before.map((entry) => entry.id);

    store.close();
    const secondTurn = turn(
      writer,
      'ses_fixture',
      'Question two',
      'Answer two',
    );
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
      { prompt: 'Question one', turnId: firstTurn },
      { prompt: 'Question two', turnId: secondTurn },
    ]);
    expect(
      after.filter((entry) => entry.payload.method === 'turn.completed'),
    ).toHaveLength(2);
  } finally {
    store.close();
    writer.close();
  }
});

test("Station's own OpenCode session, run through ACP, is not imported a second time", async () => {
  const directory = realpathSync(tempDir('station-opencode-owned-'));
  const dataDir = join(directory, 'opencode');
  const project = join(directory, 'project');
  mkdirSync(project);
  const writer = new OpenCodeFixtureWriter(dataDir);
  writer.session('ses_station_owned', project);
  turn(writer, 'ses_station_owned', 'Station prompt', 'Station answer');
  writer.session('ses_terminal', project);
  turn(writer, 'ses_terminal', 'Terminal prompt', 'Terminal answer');
  const store = new EventStore(join(directory, 'events.sqlite'));
  try {
    store.upsertSession({
      provider: 'acp',
      threadId: 'station-opencode-thread',
      status: 'ready',
      cwd: project,
      resumeCursor: {
        acpSessionId: 'ses_station_owned',
        connectionId: 'opencode',
      },
      controlMode: 'station-owned',
      createdAt: '2026-10-01T12:00:00.000Z',
      updatedAt: '2026-10-01T12:00:00.000Z',
    });
    const follow = new AttachedSessionFollowService({
      sources: [new OpenCodeSessionSource({ dataDir })],
      eventStore: store,
      eventBus: new EventBus(),
      listProjects: () => [{ slug: 'fixture', workingDirectory: project }],
    });
    for (let poll = 0; poll < 3; poll += 1) await follow.pollNow();
    expect(
      store
        .readSessions()
        .map((session) => [
          session.provider,
          session.attachedSource?.externalSessionId,
        ]),
    ).toEqual(
      expect.arrayContaining([
        ['acp', undefined],
        ['opencode', 'ses_terminal'],
      ]),
    );
    expect(store.readSessions()).toHaveLength(2);
  } finally {
    store.close();
    writer.close();
  }
});

test('stopping the follower closes the OpenCode store connections', async () => {
  const directory = realpathSync(tempDir('station-opencode-stop-'));
  const dataDir = join(directory, 'opencode');
  const project = join(directory, 'project');
  mkdirSync(project);
  const writer = new OpenCodeFixtureWriter(dataDir);
  writer.session('ses_fixture', project);
  turn(writer, 'ses_fixture', 'Question', 'Answer');
  const store = new EventStore(join(directory, 'events.sqlite'));
  const source = new OpenCodeSessionSource({ dataDir });
  const close = vi.spyOn(source, 'close');
  try {
    const follow = new AttachedSessionFollowService({
      sources: [source],
      eventStore: store,
      eventBus: new EventBus(),
      listProjects: () => [{ slug: 'fixture', workingDirectory: project }],
    });
    follow.start();
    await follow.pollNow();
    await follow.stop();
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    store.close();
    writer.close();
  }
});

test('stop waits for a poll in flight before closing the sources', async () => {
  const order: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const source = {
    provider: 'opencode',
    kind: 'opencode-session',
    discover: async () => {
      order.push('discover-start');
      await gate;
      order.push('discover-end');
      return { outcome: 'ok' as const, sessions: [] };
    },
    read: async () => ({ outcome: 'ok' as const, events: [], cursor: 0 }),
    close: () => {
      order.push('close');
    },
  };
  const directory = realpathSync(tempDir('station-opencode-stop-poll-'));
  const store = new EventStore(join(directory, 'events.sqlite'));
  try {
    const follow = new AttachedSessionFollowService({
      sources: [source],
      eventStore: store,
      eventBus: new EventBus(),
      listProjects: () => [],
    });
    const poll = follow.pollNow();
    await vi.waitFor(() => expect(order).toContain('discover-start'));
    const stopped = follow.stop();
    await Promise.resolve();
    expect(order).not.toContain('close');
    release();
    await stopped;
    await poll;
    expect(order).toEqual(['discover-start', 'discover-end', 'close']);
  } finally {
    store.close();
  }
});
