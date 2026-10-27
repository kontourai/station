import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { parseProjectTaskRoomBrowserHistory } from '@kontourai/station-contracts/project-task-room-browser';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { TaskReviewModule } from '../../projects/task-review-module.js';
import { EnvironmentSecurityService } from '../../ssh/environment-security-service.js';
import { EventStore } from '../event-store.js';
import { projectTaskRoomDocumentId } from '../project-task-room-document-id.js';
import { ProjectTaskRoomRevisionEvidenceBridge } from '../project-task-room-revision-evidence-bridge.js';
import { ProjectTaskRoomRuntime } from '../project-task-room-runtime.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
  ) => {
    prepare(sql: string): {
      run(...values: unknown[]): unknown;
      all(...values: unknown[]): unknown[];
    };
    close(): void;
  };
};
const homes: string[] = [];
const makeTempDir = trackTempDirs();
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

const task = {
  id: 'task-1',
  projectId: 'project-1',
  title: 'Revision bridge',
  description: '',
  priority: 'normal',
  status: 'ready',
  createdBy: 'operator',
  createdAt: '2026-08-21T00:00:00.000Z',
  updatedAt: '2026-08-21T00:00:00.000Z',
} as const;
const request = new Request('http://station/task');

async function composition(
  home: string,
  options: {
    securityHome?: string;
    operatorId?: string;
    bridge?: boolean;
    taskRecord?: TaskRecord;
    otherTask?: TaskRecord;
    afterRevisionPublicationStep?: (
      step: 'document-commit' | 'freeze' | 'link-commit',
    ) => void;
  } = {},
) {
  const securityHome = options.securityHome ?? home;
  const taskRecord = options.taskRecord ?? task;
  const security = new EnvironmentSecurityService({ homeDir: securityHome });
  await security.initialize();
  const store = new EventStore(join(home, 'events.sqlite'));
  const bridge = new ProjectTaskRoomRevisionEvidenceBridge({
    eventStore: store,
    security,
  });
  const working = { ...store.createProjectTaskRoomWorkingState() };
  const runtime = new ProjectTaskRoomRuntime({
    taskGraph: {
      readTaskView: (id) =>
        id === taskRecord.id
          ? taskRecord
          : id === options.otherTask?.id
            ? options.otherTask
            : null,
    },
    projectForId: (id) =>
      id === task.projectId ? { id, slug: 'project' } : undefined,
    history: (authority) =>
      store.createProjectTaskRoomHistory({
        capabilities: authority.capabilities,
        agents: authority.agents,
        ...(authority.links ? { links: authority.links } : {}),
      }),
    working,
    ...(options.bridge === false ? {} : { revisionEvidence: bridge }),
    ...(options.afterRevisionPublicationStep
      ? {
          afterRevisionPublicationStep: options.afterRevisionPublicationStep,
        }
      : {}),
    requestAuthority: {
      isCurrent: () => true,
      resolve: async () => ({
        kind: 'granted',
        operatorId: options.operatorId ?? 'operator-1',
        deviceId: 'device-1',
        policyRevision: 'pairing-v1',
      }),
    },
  });
  return { store, bridge, runtime, security, working };
}

async function commitText(
  runtime: ProjectTaskRoomRuntime,
  desiredText: string,
) {
  const plan = await runtime.editPlan({
    taskId: task.id,
    request,
    intentId: `browser-${randomUUID()}`,
    desiredText,
    selection: { anchor: desiredText.length, focus: desiredText.length },
  });
  if (plan.kind !== 'planned') throw new Error('expected plan');
  return {
    plan,
    settled: await runtime.submitBatch({
      taskId: task.id,
      request,
      intentId: plan.intentId,
      intentDigest: plan.digest,
    }),
  };
}

async function freeze(
  runtime: ProjectTaskRoomRuntime,
  workingRevision: string,
) {
  return runtime.freezeDocumentRevision({
    taskId: task.id,
    documentId: projectTaskRoomDocumentId({
      projectId: task.projectId,
      taskId: task.id,
    }),
    workingRevision,
    beforeCommit: () => true,
  });
}

async function freezeCurrent(runtime: ProjectTaskRoomRuntime) {
  const doc = await runtime.readTaskDocumentForBrief(task.id);
  if (doc.kind !== 'available') throw new Error('expected document');
  return freeze(runtime, doc.revision);
}

async function browserRevisionLinks(runtime: ProjectTaskRoomRuntime) {
  const history = parseProjectTaskRoomBrowserHistory(
    await runtime.history({ taskId: task.id, request, project: true }),
  );
  if (history?.kind !== 'available') throw new Error('expected history');
  return history.records.filter(
    (record) =>
      record.body.kind === 'outcome-link' &&
      record.body.link.kind === 'revision',
  );
}

describe('ProjectTaskRoomRevisionEvidenceBridge production composition', () => {
  test('hundreds of one-character saves beyond 256 do not exhaust evidence or stop another room', async () => {
    const home = makeTempDir('station-room-ledger-capacity-');
    const otherTask = { ...task, id: 'task-2' };
    const composed = await composition(home, { otherTask });
    try {
      for (let edit = 1; edit <= 600; edit += 1) {
        const desiredText = 'x'.repeat(edit);
        const { settled } = await commitText(composed.runtime, desiredText);
        expect(settled, `primary room edit ${edit}`).toMatchObject({
          kind: 'committed',
          text: desiredText,
        });
        if (edit % 100 === 0) {
          const plan = await composed.runtime.editPlan({
            taskId: otherTask.id,
            request,
            intentId: `other-${edit}`,
            desiredText: String(edit),
            selection: { anchor: 0, focus: 0 },
          });
          if (plan.kind !== 'planned')
            throw new Error('expected other room plan');
          expect(
            await composed.runtime.submitBatch({
              taskId: otherTask.id,
              request,
              intentId: plan.intentId,
              intentDigest: plan.digest,
            }),
            `other room at edit ${edit}`,
          ).toMatchObject({
            kind: 'committed',
            text: String(edit),
          });
        }
      }
      const database = new DatabaseSync(join(home, 'events.sqlite'));
      try {
        expect(
          database
            .prepare('SELECT revision_id FROM revision_evidence_receipts')
            .all(),
        ).toHaveLength(0);
      } finally {
        database.close();
      }
      expect(await freezeCurrent(composed.runtime)).toBe(true);
      expect(await browserRevisionLinks(composed.runtime)).toHaveLength(1);
    } finally {
      await composed.runtime.close();
      composed.store.close();
    }
  }, 300_000);

  test('Task Review freezes its exact plan revision and refuses a stale revision raced by another save', async () => {
    const home = makeTempDir('station-room-review-freeze-');
    const composed = await composition(home);
    const module = new TaskReviewModule({
      logger: { warn: () => {} },
      store: composed.store.taskReviewStore(),
      memory: { readSummary: () => undefined },
      outputs: {
        list: async () => [],
        read: async () => {
          throw new Error('unexpected output');
        },
        readContent: async () => {
          throw new Error('unexpected output content');
        },
      },
      readPlan: (id, req) => composed.runtime.readPlanForReview(id, req),
      freezePlan: (input) => composed.runtime.freezeDocumentRevision(input),
      readAnswers: async () => [],
    });
    try {
      await commitText(composed.runtime, 'first plan');
      const access = await composed.runtime.personTaskReviewAccess({
        taskId: task.id,
        request,
      });
      if (access.kind !== 'granted') throw new Error('expected access');
      const item = (await module.read(access, request)).items.find(
        (i) => i.kind === 'plan',
      );
      if (item?.status !== 'available') throw new Error('expected plan item');
      const original = composed.working.requestRevisionPublication!;
      vi.spyOn(
        composed.working,
        'requestRevisionPublication',
      ).mockImplementationOnce(async (input) => {
        await commitText(composed.runtime, 'second plan');
        return original(input);
      });
      const input = {
        artifact: item.artifact,
        anchor: { kind: 'whole' as const },
        body: 'Review this plan',
        operationId: 'review-plan',
      };
      await expect(module.create(access, request, input)).rejects.toMatchObject(
        { code: 'artifact-unavailable' },
      );
      expect((await module.read(access, request)).threads).toHaveLength(0);
      const current = (await module.read(access, request)).items.find(
        (i) => i.kind === 'plan',
      );
      if (current?.status !== 'available')
        throw new Error('expected current plan');
      const created = await module.create(access, request, {
        ...input,
        artifact: current.artifact,
      });
      expect(created.artifact).toEqual(current.artifact);
      await commitText(composed.runtime, 'third plan');
      const database = new DatabaseSync(join(home, 'events.sqlite'));
      try {
        const rows = database
          .prepare('SELECT record_json FROM revision_evidence_receipts')
          .all() as Array<{ record_json: string }>;
        expect(rows).toHaveLength(1);
        expect(JSON.parse(rows[0]!.record_json)).toMatchObject({
          text: 'second plan',
          sharedRevision: current.artifact.revision,
        });
      } finally {
        database.close();
      }
    } finally {
      await composed.runtime.close();
      composed.store.close();
    }
  });

  test('a peer save during freeze-to-mark retains the claimed revision and its parent chain', async () => {
    const home = makeTempDir('station-room-peer-freeze-');
    const first = await composition(home);
    const peer = await composition(home);
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mark = first.working.markRevisionPublication;
    vi.spyOn(first.working, 'markRevisionPublication').mockImplementationOnce(
      async (input) => {
        entered();
        await resume;
        return mark(input);
      },
    );
    let freezing: Promise<boolean> | undefined;
    try {
      await commitText(first.runtime, 'claimed text');
      const original = await first.runtime.readTaskDocumentForBrief(task.id);
      if (original.kind !== 'available') throw new Error('expected document');
      freezing = freeze(first.runtime, original.revision);
      await paused;
      expect(
        (await commitText(peer.runtime, 'peer text')).settled,
      ).toMatchObject({ kind: 'committed', text: 'peer text' });
      release();
      await freezing;
      expect(await freezeCurrent(peer.runtime)).toBe(true);
      const database = new DatabaseSync(join(home, 'events.sqlite'));
      try {
        const rows = database
          .prepare(
            'SELECT record_json FROM revision_evidence_receipts ORDER BY rowid',
          )
          .all() as Array<{ record_json: string }>;
        expect(rows).toHaveLength(2);
        const [before, after] = rows.map((row) => JSON.parse(row.record_json));
        expect(before).toMatchObject({
          text: 'claimed text',
          sharedRevision: original.revision,
        });
        expect(after).toMatchObject({
          text: 'peer text',
          parents: [before.revisionId],
        });
      } finally {
        database.close();
      }
    } finally {
      release();
      await freezing;
      await peer.runtime.close();
      peer.store.close();
      await first.runtime.close();
      first.store.close();
    }
  });

  test('revocation at the worker claim fence leaves the candidate replaceable without a receipt', async () => {
    const home = makeTempDir('station-room-claim-revoked-');
    const composed = await composition(home);
    const original = composed.working.requestRevisionPublication!;
    let current = true;
    vi.spyOn(
      composed.working,
      'requestRevisionPublication',
    ).mockImplementationOnce((input) =>
      original({
        ...input,
        beforeCommit: async () => {
          current = false;
          return false;
        },
      }),
    );
    try {
      await commitText(composed.runtime, 'candidate');
      const document = await composed.runtime.readTaskDocumentForBrief(task.id);
      if (document.kind !== 'available') throw new Error('expected document');
      expect(
        await composed.runtime.freezeDocumentRevision({
          taskId: task.id,
          documentId: projectTaskRoomDocumentId({
            projectId: task.projectId,
            taskId: task.id,
          }),
          workingRevision: document.revision,
          beforeCommit: () => current,
        }),
      ).toBe(false);
      expect(
        (await commitText(composed.runtime, 'later save')).settled,
      ).toMatchObject({ kind: 'committed' });
      expect(await browserRevisionLinks(composed.runtime)).toHaveLength(0);
      expect(await freezeCurrent(composed.runtime)).toBe(true);
    } finally {
      await composed.runtime.close();
      composed.store.close();
    }
  });

  test('a worker awaiting main-thread approval cannot stall evidence freeze or wedge later person saves', async () => {
    const home = makeTempDir('station-room-revision-lock-');
    const composed = await composition(home);
    const worker = new Worker(
      new URL('../project-task-room-history-worker.ts', import.meta.url),
      {
        execArgv: ['--import', 'tsx'],
        workerData: {
          databasePath: join(home, 'events.sqlite'),
          retentionRecords: 100,
          retentionBytes: 1024 * 1024,
          maxIdentities: 100,
          lockWaitMs: 5000,
        },
      },
    );
    const livenessBoundMs = 1000;
    let approvalDelayMs = Number.POSITIVE_INFINITY;
    let approvalTimer: ReturnType<typeof setTimeout> | undefined;
    let workerCommit: Promise<unknown[]> | undefined;
    const readPublication = composed.working.readRevisionPublication;
    vi.spyOn(
      composed.working,
      'readRevisionPublication',
    ).mockImplementationOnce(async (input) => {
      const publication = await readPublication(input);
      expect(publication.kind).toBe('available');
      const approval = once(worker, 'message');
      worker.postMessage({
        id: 1,
        request: {
          type: 'open',
          scope: {
            projectId: task.projectId,
            projectSlug: 'project',
            taskId: 'contending-room',
          },
          channelId: 'contending-room-channel',
          policyRevision: 'pairing-v1',
          authorizationId: 'lock-approval',
        },
      });
      // The real worker sends this only after BEGIN IMMEDIATE succeeds.
      const [message] = await approval;
      expect(message).toEqual({
        type: 'authorize',
        id: 1,
        authorizationId: 'lock-approval',
        phase: 'authorize',
      });
      workerCommit = once(worker, 'message');
      const started = performance.now();
      approvalTimer = setTimeout(() => {
        approvalDelayMs = performance.now() - started;
        worker.postMessage({
          ...message,
          type: 'authorization',
          disposition: 'admitted',
        });
      }, 25);
      // Freeze now runs while the worker needs this event loop to release
      // its write lock. A synchronous SQLite busy wait creates the inversion.
      return publication;
    });
    try {
      const first = await commitText(composed.runtime, 'first save');
      expect(first.settled).toMatchObject({
        kind: 'committed',
        revisionEvidence: { kind: 'unavailable' },
      });
      expect(await freezeCurrent(composed.runtime)).toBe(false);
      expect(workerCommit).toBeDefined();
      expect(await workerCommit).toEqual([
        { id: 1, result: { kind: 'opened' } },
      ]);
      expect.soft(approvalDelayMs).toBeLessThan(livenessBoundMs);

      // There is still an un-frozen outbox row. The next person save must
      // drain it and retry the exact plan without restarting Station.
      const second = await commitText(composed.runtime, 'second save');
      expect(second.settled).toMatchObject({
        kind: 'committed',
        text: 'second save',
        revisionEvidence: { kind: 'unavailable' },
      });
      expect(await freezeCurrent(composed.runtime)).toBe(true);
      const third = await commitText(composed.runtime, 'third save');
      expect(third.settled).toMatchObject({
        kind: 'committed',
        text: 'third save',
        revisionEvidence: { kind: 'unavailable' },
      });
      expect(await freezeCurrent(composed.runtime)).toBe(true);
      expect(await browserRevisionLinks(composed.runtime)).toHaveLength(3);
    } finally {
      if (approvalTimer) clearTimeout(approvalTimer);
      await worker.terminate();
      await composed.runtime.close();
      composed.store.close();
    }
  }, 30_000);

  test('freezes a committed document, publishes a browser revision link, and resolves it after restart', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-room-revision-'));
    homes.push(home);
    const first = await composition(home);
    const discovered = await first.runtime.discover({
      taskId: task.id,
      request,
    });
    expect(discovered).toMatchObject({ revisionLinksAvailable: true });
    const plan = await first.runtime.editPlan({
      taskId: task.id,
      request,
      intentId: 'browser-intent',
      desiredText: 'durable shared text',
      selection: { anchor: 19, focus: 19 },
    });
    expect(plan.kind).toBe('planned');
    if (plan.kind !== 'planned') throw new Error('expected plan');
    const settled = await first.runtime.submitBatch({
      taskId: task.id,
      request,
      intentId: plan.intentId,
      intentDigest: plan.digest,
    });
    expect(settled).toMatchObject({
      kind: 'committed',
      revisionEvidence: { kind: 'unavailable' },
    });
    expect(await freezeCurrent(first.runtime)).toBe(true);
    const history = parseProjectTaskRoomBrowserHistory(
      await first.runtime.history({
        taskId: task.id,
        request,
        project: true,
      }),
    );
    expect(history?.kind).toBe('available');
    if (history?.kind !== 'available') throw new Error('expected history');
    const revisionRecord = history.records.find(
      (record) =>
        record.body.kind === 'outcome-link' &&
        record.body.link.kind === 'revision',
    );
    expect(revisionRecord).toBeDefined();
    if (revisionRecord?.body.kind !== 'outcome-link')
      throw new Error('expected revision link');
    const link = revisionRecord.body.link;
    expect(link.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(revisionRecord)).not.toContain('durable shared text');
    await first.security.rotateCredential();
    expect(first.bridge.available()).toBe(true);
    await expect(
      first.bridge.links.resolve({
        kind: 'revision',
        reference: link.stableId,
        scope: {
          projectId: task.projectId,
          projectSlug: 'project',
          taskId: task.id,
        },
      }),
    ).resolves.toMatchObject({ kind: 'resolved' });
    await first.runtime.close();
    expect(first.store.close()).toEqual({ kind: 'closed' });

    const restarted = await composition(home);
    await expect(
      restarted.bridge.links.resolve({
        kind: 'revision',
        reference: link.stableId,
        scope: {
          projectId: task.projectId,
          projectSlug: 'project',
          taskId: task.id,
        },
      }),
    ).resolves.toMatchObject({
      kind: 'resolved',
      link: { stableId: link.stableId, digest: link.digest },
    });
    await restarted.runtime.close();
    expect(restarted.store.close()).toEqual({ kind: 'closed' });
  });

  test('retains exact agent kind and session/run correlation in immutable evidence across restart', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-room-agent-revision-'));
    homes.push(home);
    const associatedTask: TaskRecord = {
      ...task,
      agentId: 'station',
      sessionId: 'agent-session-1',
    };
    const first = await composition(home, { taskRecord: associatedTask });
    await expect(
      first.runtime.publishAgentDocumentEdit({
        taskId: task.id,
        agentId: 'station',
        sessionId: 'agent-session-1',
        provider: 'task-dispatch',
        desiredText: 'agent evidence',
      }),
    ).resolves.toMatchObject({ kind: 'committed', text: 'agent evidence' });
    expect(await freezeCurrent(first.runtime)).toBe(true);
    const links = await browserRevisionLinks(first.runtime);
    expect(links).toHaveLength(1);
    const revisionId =
      links[0]!.body.kind === 'outcome-link'
        ? links[0]!.body.link.stableId
        : '';
    await first.runtime.close();
    first.store.close();

    const restarted = await composition(home, { taskRecord: associatedTask });
    await expect(
      restarted.bridge.links.resolve({
        kind: 'revision',
        reference: revisionId,
        scope: {
          projectId: task.projectId,
          projectSlug: 'project',
          taskId: task.id,
        },
      }),
    ).resolves.toMatchObject({
      kind: 'resolved',
      link: { stableId: revisionId },
    });
    const database = new DatabaseSync(join(home, 'events.sqlite'));
    const records = database
      .prepare('SELECT record_json FROM revision_evidence_receipts')
      .all() as Array<{ record_json: string }>;
    database.close();
    expect(records).toHaveLength(1);
    expect(JSON.parse(records[0]!.record_json)).toMatchObject({
      revisionId,
      actor: { kind: 'agent', displayLabel: 'station' },
      correlation: {
        projectId: task.projectId,
        taskId: task.id,
        agentSessionId: 'agent-session-1',
        runId: 'orchestration:task-dispatch:agent-session-1',
      },
    });
    await restarted.runtime.close();
    restarted.store.close();
  });

  test('marks incompatible authority and corrupt persistence unavailable', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-room-revision-bad-'));
    const otherSecurity = mkdtempSync(
      join(tmpdir(), 'station-room-revision-key-'),
    );
    homes.push(home, otherSecurity);
    const first = await composition(home);
    const plan = await first.runtime.editPlan({
      taskId: task.id,
      request,
      intentId: 'one',
      desiredText: 'evidence',
      selection: { anchor: 8, focus: 8 },
    });
    if (plan.kind !== 'planned') throw new Error('expected plan');
    await first.runtime.submitBatch({
      taskId: task.id,
      request,
      intentId: plan.intentId,
      intentDigest: plan.digest,
    });
    expect(await freezeCurrent(first.runtime)).toBe(true);
    await first.runtime.close();
    first.store.close();

    const incompatible = await composition(home, {
      securityHome: otherSecurity,
    });
    expect(incompatible.bridge.available()).toBe(false);
    await expect(
      incompatible.runtime.discover({ taskId: task.id, request }),
    ).resolves.toMatchObject({ revisionLinksAvailable: false });
    await incompatible.runtime.close();
    incompatible.store.close();

    const database = new DatabaseSync(join(home, 'events.sqlite'));
    database
      .prepare('UPDATE revision_evidence_receipts SET record_digest = ?')
      .run('forged');
    database.close();
    const corrupt = await composition(home);
    expect(corrupt.bridge.available()).toBe(false);
    await expect(
      corrupt.runtime.discover({ taskId: task.id, request }),
    ).resolves.toMatchObject({ revisionLinksAvailable: false });
    await corrupt.runtime.close();
    corrupt.store.close();
  });

  test('withdraws revision-link discovery after the durable authority key becomes corrupt', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-room-revision-health-'));
    homes.push(home);
    const composed = await composition(home);
    await expect(
      composed.runtime.discover({ taskId: task.id, request }),
    ).resolves.toMatchObject({ revisionLinksAvailable: true });
    const identity = await composed.security.initialize();
    writeFileSync(
      join(home, 'security', `revision-evidence-${identity.environmentId}.key`),
      'corrupt',
      { mode: 0o600 },
    );
    expect(composed.bridge.available()).toBe(false);
    await expect(
      composed.runtime.discover({ taskId: task.id, request }),
    ).resolves.toMatchObject({ revisionLinksAvailable: false });
    await composed.runtime.close();
    composed.store.close();
  });

  test.each(['document-commit', 'freeze', 'link-commit'] as const)(
    'recovers exactly once after the %s publication boundary',
    async (faultPoint) => {
      const home = mkdtempSync(join(tmpdir(), 'station-room-revision-fault-'));
      homes.push(home);
      let faulted = false;
      const first = await composition(home, {
        afterRevisionPublicationStep: (step) => {
          if (!faulted && step === faultPoint) {
            faulted = true;
            throw new Error(`fault after ${step}`);
          }
        },
      });
      const plan = await first.runtime.editPlan({
        taskId: task.id,
        request,
        intentId: `fault-${faultPoint}`,
        desiredText: `fault-${faultPoint}`,
        selection: { anchor: 0, focus: 0 },
      });
      if (plan.kind !== 'planned') throw new Error('expected plan');
      let settled:
        | Awaited<ReturnType<ProjectTaskRoomRuntime['submitBatch']>>
        | undefined;
      try {
        settled = await first.runtime.submitBatch({
          taskId: task.id,
          request,
          intentId: plan.intentId,
          intentDigest: plan.digest,
        });
      } catch (error) {
        if (faultPoint !== 'document-commit') throw error;
        expect(error).toEqual(new Error('fault after document-commit'));
      }
      if (faultPoint !== 'document-commit') {
        expect(await freezeCurrent(first.runtime)).toBe(false);
        if (!settled) throw new Error('expected committed document response');
        expect(settled).toMatchObject({
          kind: 'committed',
          revisionEvidence: { kind: 'unavailable' },
        });
      }
      await first.runtime.close();
      first.store.close();
      if (faultPoint === 'document-commit') {
        const legacy = new DatabaseSync(join(home, 'events.sqlite'));
        try {
          legacy
            .prepare(
              'ALTER TABLE project_task_room_revision_publication_outbox DROP COLUMN freeze_requested',
            )
            .run();
        } finally {
          legacy.close();
        }
      }

      const restarted = await composition(home, { operatorId: 'retry-caller' });
      await restarted.runtime.reconcileRevisionPublications([task.id]);
      expect(await browserRevisionLinks(restarted.runtime)).toHaveLength(1);
      const recovered = new DatabaseSync(join(home, 'events.sqlite'));
      try {
        expect(
          recovered
            .prepare(
              'SELECT intent_id FROM project_task_room_revision_publication_outbox',
            )
            .all(),
        ).toHaveLength(0);
        expect(
          recovered
            .prepare('SELECT revision_id FROM revision_evidence_receipts')
            .all(),
        ).toHaveLength(1);
      } finally {
        recovered.close();
      }
      await expect(
        restarted.runtime.submitBatch({
          taskId: task.id,
          request,
          intentId: plan.intentId,
          intentDigest: plan.digest,
        }),
      ).resolves.toMatchObject({
        kind: 'duplicate',
        revisionEvidence: { kind: 'linked' },
      });
      await expect(
        restarted.runtime.discover({ taskId: task.id, request }),
      ).resolves.toMatchObject({ revisionLinksAvailable: true });
      expect(await browserRevisionLinks(restarted.runtime)).toHaveLength(1);
      const database = new DatabaseSync(join(home, 'events.sqlite'));
      const records = database
        .prepare('SELECT record_json FROM revision_evidence_receipts')
        .all() as Array<{ record_json: string }>;
      database.close();
      expect(records).toHaveLength(1);
      expect(JSON.parse(records[0]!.record_json)).toMatchObject({
        actor: { displayLabel: 'operator-1' },
        correlation: { projectId: task.projectId, taskId: task.id },
      });
      await restarted.runtime.close();
      restarted.store.close();
    },
  );

  test('retains pending publication without a bridge and drains it on a later healthy restart', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-room-revision-late-'));
    homes.push(home);
    const absent = await composition(home, { bridge: false });
    const first = await commitText(absent.runtime, 'waiting for evidence');
    expect(first.settled).toMatchObject({
      kind: 'committed',
      revisionEvidence: { kind: 'unavailable' },
    });
    await absent.runtime.close();
    absent.store.close();

    const healthy = await composition(home, { operatorId: 'later-operator' });
    expect(await freezeCurrent(healthy.runtime)).toBe(true);
    await healthy.runtime.reconcileRevisionPublications([task.id]);
    expect(await browserRevisionLinks(healthy.runtime)).toHaveLength(1);
    await healthy.runtime.close();
    healthy.store.close();
  });

  test('a refused freeze without a bridge leaves later saves committing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-room-revision-nobridge-'));
    homes.push(home);
    const absent = await composition(home, { bridge: false });
    const first = await commitText(absent.runtime, 'plan before comment');
    expect(first.settled).toMatchObject({ kind: 'committed' });
    expect(await freezeCurrent(absent.runtime)).toBe(false);
    const after = await commitText(absent.runtime, 'plan after comment');
    expect(after.settled).toMatchObject({ kind: 'committed' });
    await absent.runtime.close();
    absent.store.close();
  });

  test('chains successive evidence parents across a runtime restart without duplicate room links', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-room-revision-chain-'));
    homes.push(home);
    const first = await composition(home);
    await commitText(first.runtime, 'one');
    expect(await freezeCurrent(first.runtime)).toBe(true);
    await commitText(first.runtime, 'skipped');
    await commitText(first.runtime, 'two');
    expect(await freezeCurrent(first.runtime)).toBe(true);
    await first.runtime.close();
    first.store.close();

    const restarted = await composition(home);
    await commitText(restarted.runtime, 'also skipped');
    await commitText(restarted.runtime, 'three');
    expect(await freezeCurrent(restarted.runtime)).toBe(true);
    const links = await browserRevisionLinks(restarted.runtime);
    expect(links).toHaveLength(3);
    const database = new DatabaseSync(join(home, 'events.sqlite'));
    const records = database
      .prepare(
        'SELECT record_json FROM revision_evidence_receipts ORDER BY rowid ASC',
      )
      .all() as Array<{ record_json: string }>;
    database.close();
    const parsed = records.map((row) => JSON.parse(row.record_json));
    expect(parsed).toHaveLength(3);
    expect(parsed[0]?.parents).toEqual([]);
    expect(parsed[1]?.parents).toEqual([parsed[0]?.revisionId]);
    expect(parsed[2]?.parents).toEqual([parsed[1]?.revisionId]);
    expect(parsed.map((record) => record.actor.displayLabel)).toEqual([
      'operator-1',
      'operator-1',
      'operator-1',
    ]);
    await restarted.runtime.close();
    restarted.store.close();
  });
});
