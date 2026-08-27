import { describe, expect, test } from 'vitest';
import {
  parseProjectTaskRoomBrowserHistory,
  parseProjectTaskRoomBrowserLiveSnapshot,
} from '../project-task-room-browser.js';

function readOutcome(publication: 'published' | 'private' = 'published') {
  return {
    outcome: 'available',
    snapshot: {
      schemaVersion: 'station.live-work-session/v6',
      scope: {
        projectId: 'project-1',
        taskId: 'task-1',
        surfaceId: 'surface-1',
        sessionId: 'generation-1',
        channelId: 'channel-1',
      },
      state: 'active',
      participants: [
        {
          actor: { actorId: 'actor-1', kind: 'agent', label: 'Codex' },
          work: {
            sessionId: 'session-1',
            runId: 'run-1',
            workName: 'Implement room UI',
            workState: 'working',
            startedAt: 1,
          },
          publication,
        },
      ],
      panes: [],
      cursors: [
        {
          actorId: 'actor-1',
          workingRevision: 'revision-1',
          selection: { anchor: 1, focus: 2 },
          expiresAt: 15_001,
        },
      ],
      typing: [],
    },
  };
}

describe('ProjectTaskRoom browser live parser', () => {
  test('allowlists initial and subsequent authoritative live envelopes', () => {
    const initial = parseProjectTaskRoomBrowserLiveSnapshot({
      type: 'snapshot',
      generation: 'generation-1',
      viewerActorId: 'actor-viewer',
      live: readOutcome(),
      document: { ignored: 'not exported' },
    });
    const update = parseProjectTaskRoomBrowserLiveSnapshot({
      type: 'live',
      kind: 'available',
      generation: 'generation-1',
      viewerActorId: 'actor-viewer',
      result: { outcome: 'updated' },
      snapshot: readOutcome('private'),
    });
    expect(initial).toMatchObject({
      generation: 'generation-1',
      viewerActorId: 'actor-viewer',
      scope: { projectId: 'project-1', taskId: 'task-1' },
      participants: [
        {
          actor: { actorId: 'actor-1', label: 'Codex' },
          work: { sessionId: 'session-1', runId: 'run-1' },
          publication: 'published',
        },
      ],
    });
    expect(update?.participants[0]?.publication).toBe('private');
    expect(update?.panes).toEqual([]);
    expect(update?.cursors).toEqual([
      {
        actorId: 'actor-1',
        workingRevision: 'revision-1',
        selection: { anchor: 1, focus: 2 },
        expiresAt: 15_001,
      },
    ]);
    expect(initial).not.toHaveProperty('document');
    expect(update?.result).toEqual({ outcome: 'updated' });
    expect(initial).not.toHaveProperty(
      'participants.0.work.ttlClosureRequestId',
    );
  });

  test('rejects malformed and excessive cursor projections', () => {
    const malformed = readOutcome();
    malformed.snapshot.cursors[0]!.selection.anchor = -1;
    expect(
      parseProjectTaskRoomBrowserLiveSnapshot({
        type: 'snapshot',
        generation: 'generation-1',
        viewerActorId: 'actor-viewer',
        live: malformed,
        document: {},
      }),
    ).toBeUndefined();
    const excessive = readOutcome();
    excessive.snapshot.cursors = Array.from(
      { length: 65 },
      () => readOutcome().snapshot.cursors[0]!,
    );
    expect(
      parseProjectTaskRoomBrowserLiveSnapshot({
        type: 'snapshot',
        generation: 'generation-1',
        viewerActorId: 'actor-viewer',
        live: excessive,
        document: {},
      }),
    ).toBeUndefined();
  });

  test('rejects extra fields, accessors, malformed work, and excessive participants', () => {
    expect(
      parseProjectTaskRoomBrowserLiveSnapshot({
        type: 'snapshot',
        generation: 'generation-1',
        viewerActorId: 'actor-viewer',
        live: readOutcome(),
        document: {},
        injected: true,
      }),
    ).toBeUndefined();
    expect(
      parseProjectTaskRoomBrowserLiveSnapshot(
        Object.defineProperty(
          { type: 'snapshot', live: readOutcome(), document: {} },
          'generation',
          { enumerable: true, get: () => 'generation-1' },
        ),
      ),
    ).toBeUndefined();
    const malformed = readOutcome();
    malformed.snapshot.participants[0]!.publication = 'private';
    malformed.snapshot.participants[0]!.work.sessionId = '';
    expect(
      parseProjectTaskRoomBrowserLiveSnapshot({
        type: 'snapshot',
        generation: 'generation-1',
        viewerActorId: 'actor-viewer',
        live: malformed,
        document: {},
      }),
    ).toBeUndefined();
    const excessive = readOutcome();
    excessive.snapshot.participants = Array.from(
      { length: 257 },
      () => readOutcome().snapshot.participants[0]!,
    );
    expect(
      parseProjectTaskRoomBrowserLiveSnapshot({
        type: 'snapshot',
        generation: 'generation-1',
        viewerActorId: 'actor-viewer',
        live: excessive,
        document: {},
      }),
    ).toBeUndefined();
  });

  test('rejects inherited accessors, generation mismatch, and malformed mutation result', () => {
    const inherited = Object.create({
      get type() {
        throw new Error('must not execute');
      },
    });
    inherited.generation = 'generation-1';
    inherited.live = readOutcome();
    inherited.document = {};
    expect(parseProjectTaskRoomBrowserLiveSnapshot(inherited)).toBeUndefined();
    expect(
      parseProjectTaskRoomBrowserLiveSnapshot({
        type: 'snapshot',
        generation: 'different-generation',
        viewerActorId: 'actor-viewer',
        live: readOutcome(),
        document: {},
      }),
    ).toBeUndefined();
    expect(
      parseProjectTaskRoomBrowserLiveSnapshot({
        type: 'live',
        kind: 'available',
        generation: 'generation-1',
        viewerActorId: 'actor-viewer',
        result: { outcome: 'updated', extra: true },
        snapshot: readOutcome(),
      }),
    ).toBeUndefined();
  });
});

function history(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'available',
    records: [
      {
        actor: { kind: 'human', label: 'Participant' },
        sequence: 1,
        body: { kind: 'human-message', text: 'hello' },
        digests: { proposal: 'a'.repeat(64), checkpoint: 'b'.repeat(64) },
        integrity: 'L0',
      },
    ],
    checkpoint: {
      throughSeq: 1,
      checkpointDigest: 'b'.repeat(64),
      retainedAnchorSeq: 0,
      retainedAnchorDigest: 'c'.repeat(64),
    },
    hasMore: false,
    integrity: 'L0',
    ...overrides,
  };
}

describe('ProjectTaskRoom browser history invariants', () => {
  test('rejects record count, UTF-8 body, anchor, cursor, and ordering violations', () => {
    expect(
      parseProjectTaskRoomBrowserHistory(
        history({
          records: Array.from({ length: 101 }, () => history().records[0]),
        }),
      ),
    ).toBeUndefined();
    expect(
      parseProjectTaskRoomBrowserHistory(
        history({
          records: [
            {
              ...history().records[0],
              body: { kind: 'human-message', text: '🔥'.repeat(5_000) },
            },
          ],
        }),
      ),
    ).toBeUndefined();
    expect(
      parseProjectTaskRoomBrowserHistory(
        history({
          checkpoint: {
            ...history().checkpoint,
            retainedAnchorSeq: 2,
          },
        }),
      ),
    ).toBeUndefined();
    expect(
      parseProjectTaskRoomBrowserHistory(history({ hasMore: true })),
    ).toBeUndefined();
    expect(
      parseProjectTaskRoomBrowserHistory(
        history({ hasMore: false, nextCursor: 'cursor' }),
      ),
    ).toBeUndefined();
    const second = {
      ...history().records[0],
      sequence: 2,
      digests: { proposal: 'd'.repeat(64), checkpoint: 'e'.repeat(64) },
    };
    expect(
      parseProjectTaskRoomBrowserHistory(
        history({
          records: [second, history().records[0]],
          checkpoint: { ...history().checkpoint, throughSeq: 2 },
        }),
      ),
    ).toBeUndefined();
  });
});
