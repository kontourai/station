import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { createMCPToolProvenanceGeneration } from '../mcp-tool-provenance.js';
import { captureTurnIntent } from '../prepared-turn-intent.js';
import {
  mintWorkItemResultProjectorProvenanceForReviewedLoader,
  WorkItemResultProjector,
} from '../work-item-result-projector.js';
import { at, open } from './fixtures/monument-boundary.js';

const metrics = vi.hoisted(() => ({ count: vi.fn(), duration: vi.fn() }));
vi.mock('../../../telemetry/metrics.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../telemetry/metrics.js')>()),
  orchestrationEventsPersisted: { add: metrics.count },
  orchestrationEventPersistDuration: { record: metrics.duration },
}));
const makeTempDir = trackTempDirs();
const closes: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  metrics.count.mockReset();
  metrics.duration.mockReset();
});
function workItemCandidate() {
  const provenanceGeneration = createMCPToolProvenanceGeneration();
  const provenance = mintWorkItemResultProjectorProvenanceForReviewedLoader(
    provenanceGeneration.mint({
      serverId: 'github',
      originalToolName: 'create_issue',
      runtimeName: 'github_createIssue',
      integrationId: 'github',
    }),
  );
  if (!provenance) throw new Error('Expected reviewed loader provenance');
  const projected = new WorkItemResultProjector().project({
    associationId: 'association-a',
    sessionId: 'session-a',
    conversationId: 'session-a',
    turnId: 'turn-a',
    toolCallId: 'call-a',
    terminalStatus: 'success',
    provenance,
    githubArguments: {
      owner: 'kontourai',
      repo: 'station',
      title: 'Capture issue work',
    },
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          id: '1234567890',
          url: 'https://github.com/kontourai/station/issues/235',
        }),
      },
    ],
  });
  if (!projected) throw new Error('Expected work-item candidate');
  return projected;
}
for (const failOuter of [false, true]) {
  test(`EventStore owns the real commit with the production boundary authority, admission, metrics and publication (outer rollback: ${failOuter})`, () => {
    const root = makeTempDir('monument-append-commit-');
    const path = join(root, 'events.sqlite');
    const store = open(path);
    closes.push(() => {
      store.close();
    });
    const db = store['db'];
    const peer = new DatabaseSync(path);
    closes.push(() => peer.close());
    store.upsertSession({
      provider: 'claude',
      threadId: 'session-a',
      status: 'ready',
      createdAt: at(0),
      updatedAt: at(0),
    });
    expect(
      store.stageSessionWorkItemCandidate({
        candidate: workItemCandidate(),
        current: () => true,
      }),
    ).toEqual({ kind: 'staged' });
    const observations: Array<{
      phase: string;
      inTransaction: boolean | undefined;
      event: boolean;
      boundary: boolean;
      association: boolean;
    }> = [];
    const capture = (phase: string) =>
      observations.push({
        phase,
        inTransaction: db.isTransaction,
        event: !!peer
          .prepare("SELECT 1 FROM orchestration_events WHERE id = 'event-a'")
          .get(),
        boundary: !!peer
          .prepare(
            "SELECT 1 FROM orchestration_turn_boundaries WHERE thread_id = 'session-a' AND provider_turn_id = 'turn-a'",
          )
          .get(),
        association: !!peer
          .prepare(
            "SELECT 1 FROM orchestration_session_work_item_associations WHERE event_id = 'event-a'",
          )
          .get(),
      });
    const registry = store['sessionWorkItemAdmissions'];
    const commit = registry.commit.bind(registry);
    const admission = vi
      .spyOn(registry, 'commit')
      .mockImplementation((claim) => {
        capture('admission');
        return commit(claim);
      });
    metrics.count.mockImplementation(() => capture('metric-counter'));
    metrics.duration.mockImplementation(() => capture('metric-duration'));
    const notices: Array<{ deferred: boolean }> = [];
    store.observeCommits({
      eventCommitted: (notice) => {
        capture('publication');
        notices.push({ deferred: notice.deferred });
      },
    });
    const prepared = store
      .sessionTurnBoundaryAuthority()
      .prepareProviderTurn('session-a', 'turn-a', at(1));
    const event: CanonicalRuntimeEvent = {
      eventId: 'event-a',
      provider: 'claude',
      threadId: 'session-a',
      turnId: 'turn-a',
      createdAt: at(2),
      method: 'tool.completed',
      itemId: 'item-a',
      toolCallId: 'call-a',
      toolName: 'github.create_issue',
      status: 'success',
    };
    const coCommit = () => {
      const result = prepared.record();
      expect(result).toEqual({ kind: 'applied' });
      capture('boundary-return');
    };
    if (failOuter) {
      const exec = db.exec.bind(db);
      let armed = true;
      vi.spyOn(db, 'exec').mockImplementation((sql) => {
        if (armed && sql === 'RELEASE SAVEPOINT append_event_history') {
          armed = false;
          throw new Error('outer append commit failure');
        }
        exec(sql);
      });
      expect(() => store.appendEvent(event, [], coCommit)).toThrow(
        'outer append commit failure',
      );
      expect(db.isTransaction).toBe(false);
      expect(
        peer
          .prepare(
            "SELECT 1 FROM orchestration_turn_boundaries WHERE thread_id = 'session-a' AND provider_turn_id = 'turn-a'",
          )
          .get(),
      ).toBeUndefined();
      expect(store.hasEventId(event.eventId)).toBe(false);
      expect(admission).not.toHaveBeenCalled();
      expect(notices).toEqual([]);
      expect(metrics.count).not.toHaveBeenCalled();
      expect(metrics.duration).not.toHaveBeenCalled();
      observations.length = 0;
    }
    expect(store.appendEvent(event, [], coCommit)).toBe(1);
    expect(observations.filter((o) => o.phase === 'boundary-return')).toEqual([
      {
        phase: 'boundary-return',
        inTransaction: true,
        event: false,
        boundary: false,
        association: false,
      },
    ]);
    expect(observations.filter((o) => o.phase !== 'boundary-return')).toEqual(
      expect.arrayContaining(
        ['admission', 'metric-counter', 'metric-duration', 'publication'].map(
          (phase) => ({
            phase,
            inTransaction: false,
            event: true,
            boundary: true,
            association: true,
          }),
        ),
      ),
    );
    expect(admission).toHaveBeenCalledTimes(1);
    expect(metrics.count).toHaveBeenCalledTimes(1);
    expect(metrics.duration).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([{ deferred: false }]);
  });
}

test.each(['ABORT', 'ROLLBACK'] as const)(
  'pending acceptance %s during provider-start cleanup cannot commit outside the owning append',
  (failure) => {
    const store = open(':memory:');
    closes.push(() => {
      store.close();
    });
    const db = store['db'];
    const authority = store.sessionTurnBoundaryAuthority();
    store.appendEvent({
      eventId: 'older-A',
      provider: 'claude',
      threadId: 'cleanup-t',
      turnId: 'A',
      invocationId: 'older-A',
      method: 'turn.completed',
      createdAt: at(0),
    });
    const owned = authority.reserve!('cleanup-t', at(1));
    if (owned.kind !== 'owner') throw new Error('cleanup reserve prerequisite');
    const capture = captureTurnIntent(
      { threadId: 'cleanup-t', clientTurnId: 'B-key', input: 'B' },
      { binding: {}, requiresFreshCompanions: false },
    );
    const keyed = store
      .createTurnDeduplicator()
      .claim({ threadId: 'cleanup-t', clientTurnId: 'B-key' });
    if (keyed.kind !== 'owner') throw new Error('cleanup dedup prerequisite');
    expect(owned.claim.prepareIntent!(capture, keyed.claim, at(2))).toEqual({
      kind: 'applied',
    });
    expect(owned.claim.beginInvocation(at(3))).toEqual({ kind: 'applied' });
    db.exec(
      "CREATE TRIGGER fail_accept BEFORE UPDATE ON orchestration_turn_boundaries WHEN NEW.state='accepted' AND OLD.invocation_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'queued acceptance abort'); END",
    );
    expect(owned.claim.accepted('N', at(4))).toEqual({ kind: 'unavailable' });
    const prepared = authority.prepareProviderTurn('cleanup-t', 'P', at(5));
    db.exec('DROP TRIGGER fail_accept');
    db.exec(
      `CREATE TRIGGER fail_accept BEFORE UPDATE ON orchestration_turn_boundaries WHEN NEW.state='accepted' AND OLD.invocation_id IS NOT NULL BEGIN SELECT RAISE(${failure},'cleanup transaction loss'); END`,
    );
    const before = {
      boundary: db.prepare('SELECT * FROM orchestration_turn_boundaries').all(),
      audit: db.prepare('SELECT * FROM orchestration_prepared_turns').all(),
      dedup: db.prepare('SELECT * FROM orchestration_turn_dedup').all(),
    };
    const event: CanonicalRuntimeEvent = {
      eventId: 'provider-P-start',
      provider: 'claude',
      threadId: 'cleanup-t',
      turnId: 'P',
      method: 'turn.started',
      prompt: 'engine opened',
      createdAt: at(6),
    };
    if (failure === 'ROLLBACK') {
      expect(() =>
        store.appendEvent(event, [], () => {
          expect(prepared.record()).toEqual({ kind: 'applied' });
        }),
      ).toThrow();
      expect(store.hasEventId(event.eventId)).toBe(false);
      expect(
        db.prepare('SELECT * FROM orchestration_turn_boundaries').all(),
      ).toEqual(before.boundary);
      expect(
        db.prepare('SELECT * FROM orchestration_prepared_turns').all(),
      ).toEqual(before.audit);
      expect(
        db.prepare('SELECT * FROM orchestration_turn_dedup').all(),
      ).toEqual(before.dedup);
    } else {
      expect(() =>
        store.appendEvent(event, [], () => {
          expect(prepared.record()).toEqual({ kind: 'applied' });
        }),
      ).not.toThrow();
      expect(store.hasEventId(event.eventId)).toBe(true);
      expect(
        db
          .prepare(
            "SELECT provider_turn_id FROM orchestration_turn_boundaries WHERE provider_turn_id='P'",
          )
          .get(),
      ).toEqual({ provider_turn_id: 'P' });
    }
  },
);
