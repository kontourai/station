import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));
vi.mock('../client/http', () => ({
  authenticatedFetch: mocks.authenticatedFetch,
  fetchSSE: vi.fn(),
}));

import {
  commandProjectTaskRoomLive,
  parseAuthoritativeProjectTaskRoomDocumentEvent,
  planProjectTaskRoomEdit,
  submitProjectTaskRoomBatch,
} from '../client/project-task-rooms';

function response(data: unknown) {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function liveRead() {
  return {
    generation: 'generation-1',
    viewerActorId: 'actor-viewer',
    scope: { projectId: 'project-1', taskId: 'task-1' },
    state: 'active',
    participants: [
      {
        actor: { actorId: 'actor-1', kind: 'agent', label: 'Codex' },
        work: {
          sessionId: 'session-1',
          workName: 'Room UI',
          workState: 'working',
          startedAt: 1,
        },
        publication: 'published',
      },
    ],
    panes: [],
    cursors: [],
    result: { outcome: 'updated' },
  };
}

beforeEach(() => mocks.authenticatedFetch.mockReset());

describe('ProjectTaskRoom SDK client', () => {
  test.each([
    [{ kind: 'unchanged' }, { kind: 'unchanged' }],
    [
      { kind: 'refused', reason: 'stale authority' },
      { kind: 'refused', reason: 'stale authority' },
    ],
  ])('parses edit planning outcome %#', async (wire, expected) => {
    mocks.authenticatedFetch.mockResolvedValue(response(wire));
    await expect(
      planProjectTaskRoomEdit('https://station.test', 'task-1', {
        intentId: 'intent-1',
        desiredText: 'draft',
        selection: { anchor: 5, focus: 5 },
      }),
    ).resolves.toEqual(expected);
  });

  test('preserves exact settled batch text for authoritative adoption', async () => {
    mocks.authenticatedFetch.mockResolvedValue(
      response({
        kind: 'duplicate',
        revision: 'revision-2',
        text: 'server-settled text',
      }),
    );
    await expect(
      submitProjectTaskRoomBatch('https://station.test', 'task-1', {
        intentId: 'intent-1',
        intentDigest: 'a'.repeat(64),
      }),
    ).resolves.toEqual({
      kind: 'duplicate',
      revision: 'revision-2',
      text: 'server-settled text',
    });
  });

  test('normalizes only ordered committed document events without a GET', () => {
    expect(
      parseAuthoritativeProjectTaskRoomDocumentEvent({
        kind: 'committed',
        revision: 'swsr-v1:revision',
        text: 'authoritative document',
      }),
    ).toEqual({
      kind: 'snapshot',
      revision: 'swsr-v1:revision',
      text: 'authoritative document',
    });
    expect(
      parseAuthoritativeProjectTaskRoomDocumentEvent({
        kind: 'duplicate',
        revision: 'swsr-v1:old',
        text: 'older document',
      }),
    ).toBeUndefined();
    expect(
      parseAuthoritativeProjectTaskRoomDocumentEvent({ kind: 'committed' }),
    ).toBeUndefined();
  });

  test('returns only the parsed live snapshot and sends a closed watch command', async () => {
    mocks.authenticatedFetch.mockResolvedValue(
      response({
        kind: 'available',
        generation: 'generation-1',
        viewerActorId: 'actor-viewer',
        snapshot: liveRead(),
        result: { outcome: 'updated' },
      }),
    );
    const result = await commandProjectTaskRoomLive(
      'https://station.test',
      'task-1',
      {
        command: 'watch',
        paneId: 'pane-1',
        targetActorId: 'actor-1',
      },
    );
    expect(result).toMatchObject({
      kind: 'available',
      snapshot: {
        participants: [{ work: { sessionId: 'session-1' } }],
      },
    });
    expect(result).not.toHaveProperty('result');
    expect(result).toHaveProperty('snapshot.result.outcome', 'updated');
    const request = mocks.authenticatedFetch.mock.calls[0]?.[1] as RequestInit;
    expect(mocks.authenticatedFetch.mock.calls[0]?.[0]).toBe(
      'https://station.test/api/tasks/task-1/room/live',
    );
    expect(JSON.parse(String(request.body))).toEqual({
      command: 'watch',
      paneId: 'pane-1',
      targetActorId: 'actor-1',
    });
  });

  test.each([
    [{ command: 'join' }, { command: 'join' }],
    [{ command: 'announce' }, { command: 'announce' }],
    [{ command: 'depart' }, { command: 'depart' }],
    [
      { command: 'stop', paneId: 'pane-1' },
      { command: 'stop', paneId: 'pane-1' },
    ],
    [
      { command: 'typing', active: true },
      { command: 'typing', active: true },
    ],
    [
      {
        command: 'cursor',
        generation: 'generation-1',
        workingRevision: 'revision-1',
        selection: { anchor: 1, focus: 2 },
      },
      {
        command: 'cursor',
        generation: 'generation-1',
        workingRevision: 'revision-1',
        selection: { anchor: 1, focus: 2 },
      },
    ],
  ] as const)(
    'sends supported closed live command %#',
    async (command, body) => {
      mocks.authenticatedFetch.mockResolvedValue(
        response({
          kind: 'available',
          generation: 'generation-1',
          viewerActorId: 'actor-viewer',
          snapshot: liveRead(),
          result: { outcome: 'updated' },
        }),
      );
      await commandProjectTaskRoomLive(
        'https://station.test',
        'task-1',
        command,
      );
      const request = mocks.authenticatedFetch.mock
        .calls[0]?.[1] as RequestInit;
      expect(JSON.parse(String(request.body))).toEqual(body);
    },
  );

  test('rejects discovery and live projections bound to another requested task', async () => {
    mocks.authenticatedFetch.mockResolvedValueOnce(
      response({
        kind: 'existing',
        scope: { projectId: 'project-1', taskId: 'other-task' },
        channelId: 'channel-1',
        assurance: 'L0',
        capabilities: {
          historyRead: true,
          messageWrite: true,
          live: true,
          documentRead: true,
          documentWrite: true,
          revisionLinks: false,
        },
      }),
    );
    await expect(
      import('../client/project-task-rooms').then(
        ({ discoverProjectTaskRoom }) =>
          discoverProjectTaskRoom('https://station.test', 'task-1'),
      ),
    ).rejects.toThrow('Room discovery is invalid');
  });
});
