import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  type AssignmentClaimActor,
  type AssignmentClaimRecord,
  AssignmentClaimService,
} from '../../evidence/assignment-claim-service.js';
import { composeTaskDispatcher } from '../task-dispatch-composition.js';
import { TaskDispatchStartRefusedError } from '../task-dispatcher.js';
import { TaskGraphService } from '../task-graph-service.js';
import { fixtureAgentStartResolver } from './task-dispatch-test-helpers.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe('TaskDispatcher runtime composition', () => {
  test('compensates a definite start refusal against the root that actually acquired the claim', async () => {
    const firstWorkspace = temporaryDirectory('station-task-claim-first-');
    const nextWorkspace = temporaryDirectory('station-task-claim-next-');
    let workspace = firstWorkspace;
    const packageRoot = temporaryDirectory('station-task-claim-package-');
    mkdirSync(join(packageRoot, 'build/src/cli'), { recursive: true });
    writeFileSync(
      join(packageRoot, 'build/src/cli/assignment-provider.js'),
      '// controlled transport; never executed',
    );
    const held = new Map<string, AssignmentClaimRecord>();
    const claimRoots: string[] = [];
    const releaseRoots: string[] = [];
    const claims = new AssignmentClaimService({
      packageRoot,
      runCli: async (_bin, args) => {
        const flag = (name: string) => {
          const index = args.indexOf(name);
          const value = args[index + 1];
          if (index < 0 || !value)
            throw new Error(`Missing controlled CLI flag ${name}`);
          return value;
        };
        const root = flag('--artifact-root');
        if (args[0] === 'claim') {
          const actor: AssignmentClaimActor = JSON.parse(
            readFileSync(flag('--actor-json'), 'utf8'),
          );
          const record: AssignmentClaimRecord = {
            schema_version: '1.0',
            role: 'AssignmentClaimRecord',
            subject_id: flag('--subject-id'),
            actor,
            claimed_at: '2026-10-31T00:00:00.000Z',
            ttl_seconds: 1800,
            branch: flag('--branch'),
            artifact_dir: flag('--artifact-dir'),
            status: 'claimed',
          };
          held.set(root, record);
          claimRoots.push(root);
          return {
            exitCode: 0,
            stderr: '',
            stdout: JSON.stringify({ role: 'AssignmentClaimResult', record }),
          };
        }
        if (args[0] !== 'release')
          throw new Error('Unexpected controlled CLI operation');
        releaseRoots.push(root);
        const record = held.get(root);
        if (!record)
          return {
            exitCode: 1,
            stdout: '',
            stderr: `no active claim to release for subject: ${flag('--subject-id')}`,
          };
        held.delete(root);
        return {
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            role: 'AssignmentClaimResult',
            record: { ...record, status: 'released' },
          }),
        };
      },
    });
    const graph = new TaskGraphService(
      temporaryDirectory('station-task-claim-graph-'),
      {
        projectService: {
          getProject: (slug) => ({
            id: slug,
            slug,
            name: slug,
            workingDirectory: workspace,
            createdAt: '2026-10-31T00:00:00.000Z',
            updatedAt: '2026-10-31T00:00:00.000Z',
          }),
        },
      },
    );
    const task = await graph.createTask({
      projectId: 'project-alpha',
      title: 'Refused after claim',
      workItemRef: 'github:example/project#1',
    });
    const dispatcher = composeTaskDispatcher(graph, {
      assignmentClaimService: claims,
      resolveProjectWorkspace: async () => workspace,
      resolveAgentStart: fixtureAgentStartResolver('codex'),
      orchestrationService: {
        dispatch: async () => {
          workspace = nextWorkspace;
          throw new TaskDispatchStartRefusedError(
            'Controlled pre-effect provider refusal',
          );
        },
        seedSessionRecord: () => {
          throw new Error('Unexpected seeded Session');
        },
      },
    });
    const outcome = await dispatcher.dispatch(task.id, {
      ownerUserId: 'test-owner',
      fullAccessGrant: null,
      agentId: 'task-dispatch-agent',
      runtimeConfig: { provider: 'codex', cwd: firstWorkspace },
    });
    expect(outcome).toMatchObject({ kind: 'failed' });
    expect(claimRoots).toHaveLength(1);
    expect(releaseRoots).toEqual(claimRoots);
    expect(held.size).toBe(0);
    expect(graph.readTask(task.id)?.status).toBe(task.status);
    expect(graph.readTask(task.id)?.sessionId).toBe(task.sessionId);
  });

  test('composes real graph, session, and telemetry Adapters behind the dispatcher Interface', async () => {
    const workspace = temporaryDirectory('station-task-dispatch-workspace-');
    const service = new TaskGraphService(
      temporaryDirectory('station-task-dispatch-graph-'),
      {
        projectService: {
          getProject: (slug) => ({
            id: slug,
            slug,
            name: slug,
            workingDirectory: workspace,
            createdAt: '2026-08-13T00:00:00.000Z',
            updatedAt: '2026-08-13T00:00:00.000Z',
          }),
        },
      },
    );
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Compose a dispatcher',
    });

    const outcome = await composeTaskDispatcher(service).dispatch(task.id, {
      ownerUserId: 'test-owner',
      fullAccessGrant: null,
      sourceSurface: 'composition-test',
    });

    expect(outcome).toMatchObject({
      kind: 'dispatched',
      result: {
        task: { id: task.id, status: 'ready' },
        dispatch: { outcome: 'seeded', sourceSurface: 'composition-test' },
      },
    });
    expect(service.readTask(task.id)).toMatchObject({
      id: task.id,
      status: 'ready',
      sessionId: expect.any(String),
    });
    await expect(
      composeTaskDispatcher(service).dispatch('missing-task', {
        ownerUserId: 'test-owner',
        fullAccessGrant: null,
      }),
    ).resolves.toEqual({
      kind: 'not-found',
      reason: 'Task not found: missing-task',
    });
  });
});
