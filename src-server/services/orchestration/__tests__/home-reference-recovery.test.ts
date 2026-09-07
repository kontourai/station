import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProjectTaskRoomBrowserHistory } from '@kontourai/station-contracts/project-task-room-browser';
import {
  createStationHomeBackup,
  restoreStationHomeBackup,
} from '@kontourai/station-shared/station-home-archive';
import { acquireStationHomeRuntimeLease } from '@kontourai/station-shared/station-home-lifecycle';
import { ensureStationHomeSchemaSync } from '@kontourai/station-shared/station-home-schema';
import { afterEach, expect, test } from 'vitest';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { ProjectManifestStore } from '../../projects/project-manifest-store.js';
import { ProjectService } from '../../projects/project-service.js';
import { TaskGraphService } from '../../projects/task-graph-service.js';
import { EnvironmentSecurityService } from '../../ssh/environment-security-service.js';
import { EventStore } from '../event-store.js';
import { projectTaskRoomDocumentId } from '../project-task-room-document-id.js';
import { ProjectTaskRoomRevisionEvidenceBridge } from '../project-task-room-revision-evidence-bridge.js';
import { ProjectTaskRoomRuntime } from '../project-task-room-runtime.js';

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
async function open(home: string, rotate = false) {
  const lease = acquireStationHomeRuntimeLease(home);
  const security = new EnvironmentSecurityService({
    homeDir: home,
    hostIdentity: rotate ? 'recovery-target-host' : 'recovery-source-host',
  });
  const initial = await security.initialize();
  const active = rotate ? await security.rotateCredential() : initial;
  const storage = new FileStorageAdapter(home);
  const manifests = new ProjectManifestStore(home, storage);
  const projects = new ProjectService(storage, manifests);
  const tasks = new TaskGraphService(home, { projectService: projects });
  const events = new EventStore(join(home, 'events.sqlite'));
  const bridge = new ProjectTaskRoomRevisionEvidenceBridge({
    eventStore: events,
    security,
  });
  const lookups: Array<{ requested: string; found?: string }> = [];
  const runtime = new ProjectTaskRoomRuntime({
    taskGraph: tasks,
    projectForId: (id) => {
      const project = projects
        .listProjects()
        .find((project) => project.id === id || project.slug === id);
      return project ? { id, slug: project.slug } : undefined;
    },
    history: (authority) => {
      const history = events.createProjectTaskRoomHistory({
        capabilities: authority.capabilities,
        agents: authority.agents,
        links: authority.links,
      });
      return {
        ...history,
        findByProposal: async (input) => {
          const record = await history.findByProposal(input);
          lookups.push({
            requested: input.proposalId,
            found: record?.envelope.proposal.proposalId,
          });
          return record;
        },
      };
    },
    working: events.createProjectTaskRoomWorkingState(),
    revisionEvidence: bridge,
    // The fixture uses a real environment credential; this adapter does not
    // stand in for browser enrollment or independent-human membership proof.
    requestAuthority: {
      resolve: async (request) =>
        security.verifyOperatorCredential(
          request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '',
        )
          ? {
              kind: 'granted',
              operatorId: 'recovery-operator',
              deviceId: 'recovery-device',
              policyRevision: 'operator',
            }
          : { kind: 'revoked' },
    },
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await runtime.close();
    bridge.close();
    expect(events.close()).toEqual({ kind: 'closed' });
    lease.release();
  };
  closers.push(close);
  return {
    lookups,
    storage,
    manifests,
    projects,
    tasks,
    events,
    bridge,
    runtime,
    security,
    oldCredential: initial.credential,
    request: new Request('http://recovery.test/task', {
      headers: { Authorization: `Bearer ${active.credential}` },
    }),
    close,
  };
}
async function seed(home: string, workspace: string) {
  const source = await open(home);
  const project = await source.projects.createProject({
    name: 'Recovery fixture',
    slug: 'recovery',
    workingDirectory: workspace,
  });
  const task = await source.tasks.createTask({
    projectId: project.slug,
    title: 'Retain exact references',
    createdBy: 'recovery-operator',
  });
  await source.runtime.discover({ taskId: task.id, request: source.request });
  const message = await source.runtime.message({
    taskId: task.id,
    request: source.request,
    proposalId: 'proposal-recovery-fixture',
    text: 'Persisted room message',
  });
  expect(message.kind).toBe('committed');
  const plan = await source.runtime.editPlan({
    taskId: task.id,
    request: source.request,
    intentId: 'edit-recovery-fixture',
    desiredText: 'Persisted revision text',
    selection: { anchor: 23, focus: 23 },
  });
  if (plan.kind !== 'planned') throw new Error('Expected a real edit plan');
  const edited = await source.runtime.submitBatch({
    taskId: task.id,
    request: source.request,
    intentId: plan.intentId,
    intentDigest: plan.digest,
  });
  if (edited.kind !== 'committed') throw new Error('Expected a committed edit');
  if (!('revisionEvidence' in edited))
    throw new Error('Expected the committed edit to report revision evidence');
  expect(edited).toMatchObject({
    kind: 'committed',
    revisionEvidence: { kind: 'linked' },
  });
  const history = parseProjectTaskRoomBrowserHistory(
    await source.runtime.history({
      taskId: task.id,
      request: source.request,
      project: true,
    }),
  );
  if (history?.kind !== 'available')
    throw new Error('Expected source room history');
  const revision = history.records.find(
    (record) =>
      record.body.kind === 'outcome-link' &&
      record.body.link.kind === 'revision',
  );
  if (revision?.body.kind !== 'outcome-link')
    throw new Error('Expected a revision reference');
  const scope = {
    projectId: task.projectId,
    projectSlug: project.slug,
    taskId: task.id,
  };
  const resolved = await source.bridge.links.resolve({
    kind: 'revision',
    reference: revision.body.link.stableId,
    scope,
  });
  expect(resolved.kind).toBe('resolved');
  const laterText = 'Later revision text';
  const later = await source.runtime.editPlan({
    taskId: task.id,
    request: source.request,
    intentId: 'edit-recovery-later',
    desiredText: laterText,
    selection: { anchor: laterText.length, focus: laterText.length },
  });
  if (later.kind !== 'planned') throw new Error('Expected second edit plan');
  expect(
    await source.runtime.submitBatch({
      taskId: task.id,
      request: source.request,
      intentId: later.intentId,
      intentDigest: later.digest,
    }),
  ).toMatchObject({ kind: 'committed', revisionEvidence: { kind: 'linked' } });
  const finalHistory = parseProjectTaskRoomBrowserHistory(
    await source.runtime.history({
      taskId: task.id,
      request: source.request,
      project: true,
    }),
  );
  if (finalHistory?.kind !== 'available')
    throw new Error('Expected final source history');
  const document = await source.runtime.document({
    taskId: task.id,
    request: source.request,
  });
  return {
    source,
    project,
    task,
    history: finalHistory,
    manifest: source.manifests.readProjectManifest(project.slug),
    revision: revision.body.link,
    resolved,
    receipt: {
      intentId: plan.intentId,
      intentDigest: plan.digest,
      settled: edited,
    },
    document,
    scope,
  };
}

for (const removeEvidenceKey of [false, true]) {
  test(`offline home restore reopens exact references with source absent (missing evidence key: ${removeEvidenceKey})`, {
    timeout: 60000,
  }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-reference-recovery-'));
    roots.push(root);
    const sourceHome = join(root, 'source');
    const targetHome = join(root, 'target');
    const backup = join(root, 'backup');
    ensureStationHomeSchemaSync(sourceHome);
    const workspace = join(root, 'external-workspace');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'external.txt'), 'not part of a home backup');
    execFileSync(
      'git',
      ['-C', workspace, 'init', '--template=', '--initial-branch=main'],
      { windowsHide: true, timeout: 10000, stdio: 'pipe' },
    );
    execFileSync(
      'git',
      [
        '-C',
        workspace,
        'remote',
        'add',
        'origin',
        'https://example.invalid/acme/recovery.git',
      ],
      { windowsHide: true, timeout: 10000, stdio: 'pipe' },
    );
    const seeded = await seed(sourceHome, workspace);
    expect(
      (await seeded.source.tasks.readTaskForOpen(seeded.task.id))
        ?.workspaceBinding?.availability,
    ).toBe('available');
    // This reaches the actual runtime/maintenance lease boundary, not an
    // assertInactive stub. An active source cannot produce this backup.
    expect(() =>
      createStationHomeBackup({ homeDir: sourceHome, outputDir: backup }),
    ).toThrow('inactive');
    await seeded.source.close();
    createStationHomeBackup({ homeDir: sourceHome, outputDir: backup });
    rmSync(sourceHome, { recursive: true });
    rmSync(workspace, { recursive: true });
    restoreStationHomeBackup({
      homeDir: targetHome,
      backupDir: backup,
      confirm: true,
    });
    if (removeEvidenceKey) {
      const security = join(targetHome, 'security');
      const keys = readdirSync(security).filter(
        (name) =>
          name.startsWith('revision-evidence-') && name.endsWith('.key'),
      );
      expect(keys).toHaveLength(1);
      rmSync(join(security, keys[0]));
    }
    const restored = await open(targetHome, true);
    expect(
      restored.security.verifyOperatorCredential(seeded.source.oldCredential),
    ).toBe(false);
    expect(restored.projects.getProject(seeded.project.slug)).toEqual(
      seeded.project,
    );
    expect(seeded.manifest?.id).toMatch(/^prj_/);
    expect(restored.manifests.readProjectManifest(seeded.project.slug)).toEqual(
      seeded.manifest,
    );
    expect(restored.tasks.readTaskView(seeded.task.id)).toEqual(seeded.task);
    const reopened = await restored.tasks.readTaskForOpen(seeded.task.id);
    expect(reopened?.id).toBe(seeded.task.id);
    expect(reopened?.workspaceBinding?.availability).toBe('unavailable');
    const history = parseProjectTaskRoomBrowserHistory(
      await restored.runtime.history({
        taskId: seeded.task.id,
        request: restored.request,
        project: true,
      }),
    );
    expect(history).toEqual(seeded.history);
    expect(
      await restored.runtime.document({
        taskId: seeded.task.id,
        request: restored.request,
      }),
    ).toEqual(seeded.document);
    const replayed = await restored.runtime.submitBatch({
      taskId: seeded.task.id,
      request: restored.request,
      intentId: seeded.receipt.intentId,
      intentDigest: seeded.receipt.intentDigest,
    });
    expect(restored.lookups).toEqual([
      {
        requested: `revision-publication:${seeded.receipt.intentId}`,
        found: `revision-publication:${seeded.receipt.intentId}`,
      },
    ]);
    expect(replayed).toMatchObject({
      kind: 'duplicate',
      revision: seeded.receipt.settled.revision,
      text: seeded.receipt.settled.text,
      revisionEvidence: removeEvidenceKey
        ? { kind: 'unavailable' }
        : seeded.receipt.settled.revisionEvidence,
    });
    expect(
      parseProjectTaskRoomBrowserHistory(
        await restored.runtime.history({
          taskId: seeded.task.id,
          request: restored.request,
          project: true,
        }),
      ),
    ).toEqual(seeded.history);
    expect(
      await restored.runtime.document({
        taskId: seeded.task.id,
        request: restored.request,
      }),
    ).toEqual(seeded.document);
    expect(
      restored.bridge.matchesCommittedRevision({
        scope: {
          projectId: seeded.task.projectId,
          taskId: seeded.task.id,
          documentId: projectTaskRoomDocumentId(seeded.scope),
        },
        workingRevision: 'different-working-revision',
        evidenceRevision: seeded.revision.stableId,
      }),
    ).toBe(false);
    const revision = await restored.bridge.links.resolve({
      kind: 'revision',
      reference: seeded.revision.stableId,
      scope: seeded.scope,
    });
    expect(revision).toEqual(
      removeEvidenceKey ? { kind: 'unavailable' } : seeded.resolved,
    );
    expect(existsSync(sourceHome)).toBe(false);
    expect(existsSync(workspace)).toBe(false);
    await restored.close();
  });
}
