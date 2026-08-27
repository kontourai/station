import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProjectTaskRoomBrowserHistory } from '@kontourai/station-contracts/project-task-room-browser';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { afterEach, describe, expect, test } from 'vitest';
import { EnvironmentSecurityService } from '../../ssh/environment-security-service.js';
import { EventStore } from '../event-store.js';
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
  const runtime = new ProjectTaskRoomRuntime({
    taskGraph: {
      readTaskView: (id) => (id === taskRecord.id ? taskRecord : null),
    },
    projectForId: (id) =>
      id === task.projectId ? { id, slug: 'project' } : undefined,
    history: (authority) =>
      store.createProjectTaskRoomHistory({
        capabilities: authority.capabilities,
        agents: authority.agents,
        ...(authority.links ? { links: authority.links } : {}),
      }),
    working: store.createProjectTaskRoomWorkingState(),
    ...(options.bridge === false ? {} : { revisionEvidence: bridge }),
    ...(options.afterRevisionPublicationStep
      ? {
          afterRevisionPublicationStep: options.afterRevisionPublicationStep,
        }
      : {}),
    requestAuthority: {
      resolve: async () => ({
        kind: 'granted',
        operatorId: options.operatorId ?? 'operator-1',
        deviceId: 'device-1',
        policyRevision: 'pairing-v1',
      }),
    },
  });
  return { store, bridge, runtime, security };
}

async function commitText(
  runtime: ProjectTaskRoomRuntime,
  desiredText: string,
) {
  const plan = await runtime.editPlan({
    taskId: task.id,
    request,
    intentId: `browser-${desiredText}`,
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
      revisionEvidence: { kind: 'linked' },
    });
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
        if (!settled) throw new Error('expected committed document response');
        expect(settled).toMatchObject({
          kind: 'committed',
          revisionEvidence: { kind: 'unavailable' },
        });
      }
      await first.runtime.close();
      first.store.close();

      const restarted = await composition(home, { operatorId: 'retry-caller' });
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
    await healthy.runtime.reconcileRevisionPublications([task.id]);
    expect(await browserRevisionLinks(healthy.runtime)).toHaveLength(1);
    await healthy.runtime.close();
    healthy.store.close();
  });

  test('chains successive evidence parents across a runtime restart without duplicate room links', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-room-revision-chain-'));
    homes.push(home);
    const first = await composition(home);
    await commitText(first.runtime, 'one');
    await commitText(first.runtime, 'two');
    await first.runtime.close();
    first.store.close();

    const restarted = await composition(home);
    await commitText(restarted.runtime, 'three');
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
