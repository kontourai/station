/**
 * Dispatch-as-claim tests (roadmap #584, part of epic #580, S4; hardened
 * post-ship against independent review findings #1-#6, see this file's
 * per-test comments for which finding each test proves).
 *
 * Fixture discipline: every assignment-provider claim record below is
 * written by REAL calls to the pinned `@kontourai/flow-agents` package's own
 * `assignment-provider` CLI bin (never a shell redirect into a
 * sidecar-shaped path — the repo's config-protection hook blocks those),
 * against a temp `artifactRoot` that mirrors `<workspace>/.kontourai/
 * flow-agents` but is never the repo's own `.kontourai/flow-agents`. This
 * exercises the real CLI end to end (not a stubbed runner) for the tests
 * that assert genuine on-disk claim behavior; only the operational-failure
 * simulations (lock timeout, release failure) inject a stubbed runner —
 * there is no other way to deterministically reproduce a CLI-side timeout.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AssignmentClaimService } from '../../evidence/assignment-claim-service.js';
import { TaskGraphService } from '../task-graph-service.js';
import { dispatchTaskForTest } from './task-dispatch-test-helpers.js';

const require = createRequire(import.meta.url);
// Package "exports" only defines "." and "./package.json" subpaths — the
// CLI bin itself is not an exported subpath, so it is resolved the SAME way
// `AssignmentClaimService.resolvePackageRoot` resolves it: via the package
// root directory (require.resolve('.../package.json')), not a direct
// subpath require.resolve.
const FLOW_AGENTS_PACKAGE_ROOT = dirname(
  require.resolve('@kontourai/flow-agents/package.json'),
);
const ASSIGNMENT_PROVIDER_CLI = join(
  FLOW_AGENTS_PACKAGE_ROOT,
  'build',
  'src',
  'cli',
  'assignment-provider.js',
);

const tmpDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) require('node:fs').rmSync(dir, { recursive: true, force: true });
  }
});

/** Real CLI status read (never guesses on-disk shape) — the same tool the
 * assignment-claim-service itself shells out to. */
function readAssignmentStatus(
  artifactRoot: string,
  subjectId: string,
): { claimed: boolean; actorKey?: string } {
  const stdout = execFileSync(
    process.execPath,
    [
      ASSIGNMENT_PROVIDER_CLI,
      'status',
      '--provider',
      'local-file',
      '--artifact-root',
      artifactRoot,
      '--subject-id',
      subjectId,
    ],
    { encoding: 'utf-8' },
  );
  const parsed = JSON.parse(stdout);
  const record = parsed.assignment?.record;
  if (record?.status !== 'claimed') return { claimed: false };
  return { claimed: true, actorKey: parsed.assignment.assignee };
}

/** Seeds a claim for a DIFFERENT actor via the real CLI, so the
 * claimed-by-other-guard test exercises a genuine ownership conflict. */
function seedOtherActorClaim(
  artifactRoot: string,
  subjectId: string,
  tmpDirForActor: string,
): void {
  const actorJsonPath = join(tmpDirForActor, 'other-actor.json');
  writeFileSync(
    actorJsonPath,
    JSON.stringify({
      runtime: 'flow-agents-cli',
      session_id: 'cli-session-9',
      host: 'other-host',
    }),
  );
  execFileSync(process.execPath, [
    ASSIGNMENT_PROVIDER_CLI,
    'claim',
    '--provider',
    'local-file',
    '--artifact-root',
    artifactRoot,
    '--subject-id',
    subjectId,
    '--actor-json',
    actorJsonPath,
    '--branch',
    'agent/other/task',
    '--artifact-dir',
    join(artifactRoot, 'other-artifact-dir'),
    '--reason',
    'pre-existing CLI claim',
  ]);
}

function createService(options: {
  workspace: string;
  assignmentClaimService?: Pick<
    AssignmentClaimService,
    'claim' | 'release' | 'status'
  >;
}): { service: TaskGraphService; taskGraphPath: string } {
  const projectHomeDir = makeTempDir('station-tasks-claim-');
  const service = new TaskGraphService(projectHomeDir, {
    assignmentClaimService: options.assignmentClaimService,
    resolveProjectWorkspace: () => options.workspace,
  });
  return { service, taskGraphPath: join(projectHomeDir, 'task-graph.json') };
}

function readPersistedDispatch(taskGraphPath: string, taskId: string): any {
  const persisted = JSON.parse(readFileSync(taskGraphPath, 'utf-8'));
  return persisted.dispatches.find(
    (d: { taskId: string }) => d.taskId === taskId,
  );
}

function claimServiceWithClaimedAt(
  claimedAt: string,
): Pick<AssignmentClaimService, 'claim' | 'release' | 'status'> {
  return {
    claim: async () => ({
      outcome: 'claimed',
      record: {
        schema_version: '1',
        role: 'assignee',
        subject_id: 'github:kontourai/station#provider-timestamp',
        actor: {
          runtime: 'station',
          session_id: 'provider-session',
          host: 'provider-host',
        },
        claimed_at: claimedAt,
        ttl_seconds: 300,
        branch: 'station/provider-session',
        artifact_dir: '/tmp/provider-claim',
        status: 'claimed',
      },
    }),
    release: async () => ({ outcome: 'skipped', reason: 'test cleanup' }),
    status: async () => ({ outcome: 'free' }),
  };
}

describe('TaskGraphService dispatch-as-claim (#584)', () => {
  test.each([
    ['locale timestamp', '08/01/2026'],
    ['date-only timestamp', '2026-08-01'],
    ['offset timestamp', '2026-08-01T12:34:56+00:00'],
    ['malformed calendar timestamp', '2026-13-01T12:34:56Z'],
  ])(
    'rejects assignment-provider %s before persisting a dispatch',
    async (_label, claimedAt) => {
      const workspace = makeTempDir('station-workspace-');
      const { service, taskGraphPath } = createService({
        workspace,
        assignmentClaimService: claimServiceWithClaimedAt(claimedAt),
      });
      const task = await service.createTask({
        projectId: 'project-alpha',
        title: 'Provider timestamp validation',
        workItemRef: 'github:kontourai/station#provider-timestamp',
      });

      await expect(dispatchTaskForTest(service, task.id, {})).rejects.toThrow(
        /assignment-provider claimed_at must be an rfc3339 utc timestamp/i,
      );
      expect(readPersistedDispatch(taskGraphPath, task.id)).toBeUndefined();
    },
  );

  test.each([
    ['2026-08-01T12:34:56Z', '2026-08-01T12:34:56.000Z'],
    ['2026-08-01T12:34:56.123456Z', '2026-08-01T12:34:56.123Z'],
  ])(
    'canonicalizes accepted assignment-provider UTC timestamp %s',
    async (claimedAt, expectedClaimedAt) => {
      const workspace = makeTempDir('station-workspace-');
      const { service } = createService({
        workspace,
        assignmentClaimService: claimServiceWithClaimedAt(claimedAt),
      });
      const task = await service.createTask({
        projectId: 'project-alpha',
        title: 'Provider timestamp canonicalization',
        workItemRef: 'github:kontourai/station#provider-timestamp',
      });

      const result = await dispatchTaskForTest(service, task.id, {});

      expect(result.dispatch.claim).toMatchObject({
        outcome: 'claimed',
        claimedAt: expectedClaimedAt,
      });
    },
  );

  test('dispatch of a provider-backed task records a real AssignmentProvider claim', async () => {
    const workspace = makeTempDir('station-workspace-');
    const assignmentClaimService = new AssignmentClaimService();
    expect(assignmentClaimService.isPackageAvailable).toBe(true);
    const { service } = createService({ workspace, assignmentClaimService });

    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Fix the thing',
      workItemRef: 'github:kontourai/station#584',
    });

    const result = await dispatchTaskForTest(service, task.id, {});

    expect(result.dispatch.claim?.outcome).toBe('claimed');
    expect(result.dispatch.claim?.subjectId).toBe(
      'github:kontourai/station#584',
    );
    expect(result.dispatch.claim?.actor).toMatchObject({
      runtime: 'station',
      sessionId: result.dispatch.sessionId,
    });

    // Genuine on-disk verification via the real CLI (never guessed).
    const artifactRoot = join(workspace, '.kontourai', 'flow-agents');
    const status = readAssignmentStatus(
      artifactRoot,
      'github:kontourai/station#584',
    );
    expect(status.claimed).toBe(true);
    expect(status.actorKey).toBe(
      `station:${result.dispatch.sessionId}:${require('node:os').hostname()}`,
    );
  });

  // Review finding #2: proves the FULL claim -> dispatch -> release round
  // trip on the ACTUAL UI dispatch path — `dispatchTask` called with no
  // `provider` (defaults to 'task-dispatch'), which seeds a session via
  // `seedSessionRecord` and emits NO `session.exited` event at all
  // (verified against `orchestration-service.ts`). Release must fire from
  // the task-lifecycle boundary (`updateTaskStatus` -> done/canceled), not
  // `releaseClaimForSession`, or the claim leaks forever on this path.
  test('round trip on the real UI dispatch path: task-dispatch provider, seeded session, released at task completion', async () => {
    const workspace = makeTempDir('station-workspace-');
    const assignmentClaimService = new AssignmentClaimService();
    const { service, taskGraphPath } = createService({
      workspace,
      assignmentClaimService,
    });
    const artifactRoot = join(workspace, '.kontourai', 'flow-agents');
    const subjectId = 'github:kontourai/station#600';

    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Real dispatch path',
      workItemRef: subjectId,
    });

    // The actual UI (ProjectTasksSection.dispatchSelectedTask) never sets
    // `provider` — this is the exact same shape it sends.
    const result = await dispatchTaskForTest(service, task.id, {
      sourceSurface: 'project-page',
    });
    expect(result.dispatch.provider).toBe('task-dispatch');
    expect(result.dispatch.outcome).toBe('seeded');
    expect(result.dispatch.claim?.outcome).toBe('claimed');
    expect(result.task.status).toBe('ready');
    expect(readAssignmentStatus(artifactRoot, subjectId).claimed).toBe(true);

    // The task reaches its terminus the way a real user does: 'ready' ->
    // 'in_progress' -> 'done' (a direct 'ready' -> 'done' transition isn't
    // legal in the task status machine).
    await service.updateTaskStatus(task.id, 'in_progress');
    expect(readAssignmentStatus(artifactRoot, subjectId).claimed).toBe(true);
    await service.updateTaskStatus(task.id, 'done');

    // The claim is genuinely gone — verified via the real CLI, not guessed.
    expect(readAssignmentStatus(artifactRoot, subjectId).claimed).toBe(false);
    const dispatch = readPersistedDispatch(taskGraphPath, task.id);
    expect(dispatch.claim.outcome).toBe('released');

    // The NEXT dispatch of this (now-done) task's own claim is provably not
    // self-blocked (the whole point of finding #2's symptom) — but 'done'
    // is terminal, so redispatch itself is refused at the STATUS layer,
    // which is the correct, stronger guarantee.
    await expect(dispatchTaskForTest(service, task.id, {})).rejects.toThrow(
      /cannot be dispatched from done/i,
    );
  });

  // Same round trip via the 'canceled' terminus, and via a DIRECT
  // 'ready' -> 'canceled' transition (no 'in_progress' hop needed).
  test('round trip on the real UI dispatch path: released at task cancellation', async () => {
    const workspace = makeTempDir('station-workspace-');
    const assignmentClaimService = new AssignmentClaimService();
    const { service, taskGraphPath } = createService({
      workspace,
      assignmentClaimService,
    });
    const artifactRoot = join(workspace, '.kontourai', 'flow-agents');
    const subjectId = 'github:kontourai/station#601';

    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Real dispatch path, cancel',
      workItemRef: subjectId,
    });
    const result = await dispatchTaskForTest(service, task.id, {});
    expect(result.dispatch.claim?.outcome).toBe('claimed');

    await service.updateTaskStatus(task.id, 'canceled');

    expect(readAssignmentStatus(artifactRoot, subjectId).claimed).toBe(false);
    const dispatch = readPersistedDispatch(taskGraphPath, task.id);
    expect(dispatch.claim.outcome).toBe('released');
  });

  test('releaseClaimForSession releases the real claim recorded at dispatch (real orchestrated session path)', async () => {
    const workspace = makeTempDir('station-workspace-');
    const assignmentClaimService = new AssignmentClaimService();
    const { service, taskGraphPath } = createService({
      workspace,
      assignmentClaimService,
    });

    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Fix the thing',
      workItemRef: 'github:kontourai/station#585',
    });
    const result = await dispatchTaskForTest(service, task.id, {});
    expect(result.dispatch.claim?.outcome).toBe('claimed');

    const artifactRoot = join(workspace, '.kontourai', 'flow-agents');
    expect(
      readAssignmentStatus(artifactRoot, 'github:kontourai/station#585')
        .claimed,
    ).toBe(true);

    await service.releaseClaimForSession(
      result.dispatch.sessionId,
      'session.exited',
    );

    expect(
      readAssignmentStatus(artifactRoot, 'github:kontourai/station#585')
        .claimed,
    ).toBe(false);
    expect(readPersistedDispatch(taskGraphPath, task.id).claim.outcome).toBe(
      'released',
    );

    // Idempotent: a second release (e.g. a duplicate session.exited) is a
    // safe no-op, never a throw.
    await expect(
      service.releaseClaimForSession(result.dispatch.sessionId, 'again'),
    ).resolves.toBeUndefined();
  });

  test('dispatch of a local task (no workItemRef) never calls the claim service', async () => {
    const workspace = makeTempDir('station-workspace-');
    let claimCalls = 0;
    const spyingClaimService: Pick<
      AssignmentClaimService,
      'claim' | 'release' | 'status'
    > = {
      claim: async () => {
        claimCalls += 1;
        throw new Error('claim should not be called for a local task');
      },
      release: async () => {
        throw new Error('release should not be called for a local task');
      },
      status: async () => ({ outcome: 'free' }),
    };
    const projectHomeDir = makeTempDir('station-tasks-claim-');
    const service = new TaskGraphService(projectHomeDir, {
      assignmentClaimService: spyingClaimService,
      resolveProjectWorkspace: () => workspace,
    });

    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Local-only task',
    });
    const result = await dispatchTaskForTest(service, task.id, {});

    expect(claimCalls).toBe(0);
    expect(result.dispatch.claim).toBeUndefined();
    expect(result.task.status).toBe('ready');
  });

  test('dispatch refuses when the AssignmentProvider claim is held by a different actor', async () => {
    const workspace = makeTempDir('station-workspace-');
    const artifactRoot = join(workspace, '.kontourai', 'flow-agents');
    const otherActorTmpDir = makeTempDir('station-other-actor-');
    seedOtherActorClaim(
      artifactRoot,
      'github:kontourai/station#586',
      otherActorTmpDir,
    );

    const assignmentClaimService = new AssignmentClaimService();
    const { service } = createService({ workspace, assignmentClaimService });
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Contested task',
      workItemRef: 'github:kontourai/station#586',
    });

    await expect(dispatchTaskForTest(service, task.id, {})).rejects.toThrow(
      /claimed by another actor/,
    );

    // The task is untouched — no session/status mutation on a blocked
    // dispatch.
    const reread = service.readTask(task.id);
    expect(reread?.status).toBe('todo');
    expect(reread?.sessionId).toBeUndefined();

    // The pre-existing claim is still held by the other actor (Station
    // never overwrote it).
    const status = readAssignmentStatus(
      artifactRoot,
      'github:kontourai/station#586',
    );
    expect(status.claimed).toBe(true);
    expect(status.actorKey).toBe('flow-agents-cli:cli-session-9:other-host');
  });

  // Review finding #4: an OPERATIONAL claim failure (simulated lock
  // timeout) must BLOCK dispatch, not silently proceed unclaimed — even
  // though it is not an actual actor conflict, ownership is indeterminate.
  test('dispatch refuses (fails closed) when the assignment CLI reports an operational failure — simulated lock timeout', async () => {
    const workspace = makeTempDir('station-workspace-');
    const lockTimeoutClaimService = new AssignmentClaimService({
      packageRoot: FLOW_AGENTS_PACKAGE_ROOT,
      runCli: async () => ({
        stdout: '',
        stderr:
          'assignment-provider: timed out waiting for assignment lock for subject github:kontourai/station#589',
        exitCode: 1,
      }),
    });
    const { service } = createService({
      workspace,
      assignmentClaimService: lockTimeoutClaimService,
    });
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Lock contention',
      workItemRef: 'github:kontourai/station#589',
    });

    await expect(dispatchTaskForTest(service, task.id, {})).rejects.toThrow(
      /indeterminate/i,
    );

    // No session/status mutation on a blocked dispatch, exactly like a
    // genuine actor conflict.
    const reread = service.readTask(task.id);
    expect(reread?.status).toBe('todo');
    expect(reread?.sessionId).toBeUndefined();
  });

  test('dispatch proceeds without a claim when the assignment-provider CLI is unavailable (package genuinely not installed)', async () => {
    const workspace = makeTempDir('station-workspace-');
    const missingPackageRoot = makeTempDir('flow-agents-missing-');
    const assignmentClaimService = new AssignmentClaimService({
      packageRoot: missingPackageRoot,
    });
    expect(assignmentClaimService.isPackageAvailable).toBe(false);
    const { service } = createService({ workspace, assignmentClaimService });

    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Fix the thing',
      workItemRef: 'github:kontourai/station#587',
    });
    const result = await dispatchTaskForTest(service, task.id, {});

    expect(result.dispatch.claim).toEqual({
      outcome: 'unavailable',
      subjectId: 'github:kontourai/station#587',
      reason: '@kontourai/flow-agents is not installed',
    });
    expect(result.task.status).toBe('ready');
  });

  // Confirmation-pass follow-up on finding #4: `resolveProjectWorkspace`
  // returning undefined is production-reachable (a project's
  // `workingDirectory` is optional) — it must fail CLOSED (blocked), not
  // silently proceed unclaimed like a confirmed package-absence would.
  test('dispatch BLOCKS (does not proceed claimless) when the project workspace is unresolvable', async () => {
    const assignmentClaimService = new AssignmentClaimService();
    const projectHomeDir = makeTempDir('station-tasks-claim-');
    const service = new TaskGraphService(projectHomeDir, {
      assignmentClaimService,
      resolveProjectWorkspace: () => undefined, // unresolvable, by construction
    });
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Unresolvable workspace',
      workItemRef: 'github:kontourai/station#602',
    });

    await expect(dispatchTaskForTest(service, task.id, {})).rejects.toThrow(
      /indeterminate.*project workspace not resolvable/i,
    );

    // No claim was ever attempted (nothing to release), and the task/session
    // are untouched — exactly like every other blocked-dispatch path.
    const reread = service.readTask(task.id);
    expect(reread?.status).toBe('todo');
    expect(reread?.sessionId).toBeUndefined();
  });

  // Same confirmation-pass fix: no assignmentClaimService wired at all is
  // also an operational gap, not a confirmed absence of the claim system.
  test('dispatch BLOCKS (does not proceed claimless) when no assignment claim service is wired', async () => {
    const projectHomeDir = makeTempDir('station-tasks-claim-');
    const service = new TaskGraphService(projectHomeDir, {
      resolveProjectWorkspace: () => makeTempDir('station-workspace-'),
      // assignmentClaimService intentionally omitted.
    });
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'No claim service wired',
      workItemRef: 'github:kontourai/station#603',
    });

    await expect(dispatchTaskForTest(service, task.id, {})).rejects.toThrow(
      /indeterminate.*assignment claim service not configured/i,
    );

    const reread = service.readTask(task.id);
    expect(reread?.status).toBe('todo');
    expect(reread?.sessionId).toBeUndefined();
  });

  // Review finding #1: a claim was acquired, but a LATER step in the same
  // dispatchTask call (seedSessionRecord, on the real default UI dispatch
  // path) then throws. The claim must not be orphaned.
  test('a mid-dispatch failure (seedSessionRecord throws, default task-dispatch path) leaves no orphaned claim', async () => {
    const workspace = makeTempDir('station-workspace-');
    const assignmentClaimService = new AssignmentClaimService();
    const projectHomeDir = makeTempDir('station-tasks-claim-');
    const service = new TaskGraphService(projectHomeDir, {
      assignmentClaimService,
      resolveProjectWorkspace: () => workspace,
      orchestrationService: {
        dispatch: vi.fn(),
        seedSessionRecord: vi.fn(() => {
          throw new Error('simulated seedSessionRecord failure');
        }),
      },
    });
    const subjectId = 'github:kontourai/station#590';
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Mid-dispatch failure',
      workItemRef: subjectId,
    });

    await expect(dispatchTaskForTest(service, task.id, {})).rejects.toThrow(
      /simulated seedSessionRecord failure/,
    );

    // The compensating release ran: the CLI-side claim is genuinely gone.
    const artifactRoot = join(workspace, '.kontourai', 'flow-agents');
    expect(readAssignmentStatus(artifactRoot, subjectId).claimed).toBe(false);
    // No dispatch record was ever persisted for the failed attempt.
    const persisted = JSON.parse(
      readFileSync(join(projectHomeDir, 'task-graph.json'), 'utf-8'),
    );
    expect(
      persisted.dispatches.filter(
        (d: { taskId: string }) => d.taskId === task.id,
      ),
    ).toHaveLength(0);
    // The task itself is untouched.
    expect(service.readTask(task.id)?.status).toBe('todo');
  });

  test('a real-provider dispatch failure remains explicitly indeterminate rather than guessing that no external start occurred', async () => {
    const workspace = makeTempDir('station-workspace-');
    const assignmentClaimService = new AssignmentClaimService();
    const projectHomeDir = makeTempDir('station-tasks-claim-');
    const service = new TaskGraphService(projectHomeDir, {
      assignmentClaimService,
      resolveProjectWorkspace: () => workspace,
      orchestrationService: {
        dispatch: vi.fn(async () => {
          throw new Error('simulated orchestration dispatch failure');
        }),
        seedSessionRecord: vi.fn(),
      },
    });
    const subjectId = 'github:kontourai/station#591';
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Mid-dispatch failure, real provider',
      workItemRef: subjectId,
    });

    await expect(
      dispatchTaskForTest(service, task.id, {
        runtimeConfig: { provider: 'claude' },
      }),
    ).rejects.toThrow(/simulated orchestration dispatch failure/);

    const artifactRoot = join(workspace, '.kontourai', 'flow-agents');
    expect(readAssignmentStatus(artifactRoot, subjectId).claimed).toBe(true);
    const persisted = JSON.parse(
      readFileSync(join(projectHomeDir, 'task-graph.json'), 'utf-8'),
    );
    expect(
      persisted.dispatches.filter(
        (d: { taskId: string }) => d.taskId === task.id,
      ),
    ).toHaveLength(0);
    expect(persisted.tasks[0]).toMatchObject({
      status: 'in_progress',
      dispatchReservation: { phase: 'indeterminate' },
    });
  });

  // Review finding #3: a release that itself FAILS must not be recorded as
  // success — the durable claim is still held, and the dispatch record must
  // remain 'claimed' so it is retried later (never silently 'released').
  test('a failed release leaves the claim active and the dispatch record retryable', async () => {
    const workspace = makeTempDir('station-workspace-');
    const realClaimService = new AssignmentClaimService();
    const subjectId = 'github:kontourai/station#592';
    let releaseCalls = 0;
    const flakyReleaseService: Pick<
      AssignmentClaimService,
      'claim' | 'release' | 'status'
    > = {
      claim: (params) => realClaimService.claim(params),
      status: (params) => realClaimService.status(params),
      release: async () => {
        releaseCalls += 1;
        return {
          outcome: 'failed',
          reason: 'simulated lock timeout on release',
        };
      },
    };
    let activeClaimService: Pick<
      AssignmentClaimService,
      'claim' | 'release' | 'status'
    > = flakyReleaseService;
    const { service, taskGraphPath } = createService({
      workspace,
      assignmentClaimService: {
        claim: (params) => activeClaimService.claim(params),
        release: (params) => activeClaimService.release(params),
        status: (params) => activeClaimService.status(params),
      },
    });
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Flaky release',
      workItemRef: subjectId,
    });
    const dispatchResult = await dispatchTaskForTest(service, task.id, {});
    expect(dispatchResult.dispatch.claim?.outcome).toBe('claimed');

    // Task completion attempts release; the injected service always fails.
    await service.updateTaskStatus(task.id, 'canceled');
    expect(releaseCalls).toBe(1);

    const artifactRoot = join(workspace, '.kontourai', 'flow-agents');
    // The underlying claim is STILL held — the release never actually
    // happened.
    expect(readAssignmentStatus(artifactRoot, subjectId).claimed).toBe(true);
    // The persisted dispatch record's claim summary is STILL 'claimed',
    // never silently flipped to 'released'.
    expect(readPersistedDispatch(taskGraphPath, task.id).claim.outcome).toBe(
      'claimed',
    );

    // Retrying with a WORKING release service (e.g. a later
    // reconciliation sweep) succeeds and flips it for real.
    activeClaimService = realClaimService;
    await service.releaseClaimForTask(task.id, 'retry');
    expect(readAssignmentStatus(artifactRoot, subjectId).claimed).toBe(false);
    expect(readPersistedDispatch(taskGraphPath, task.id).claim.outcome).toBe(
      'released',
    );
  });

  // Bonus hardening beyond the literal review findings, directly implied by
  // finding #2's own diagnostic ("its NEXT dispatch self-blocks on its own
  // leaked claim"): redispatching a still-'ready' task (the normal release
  // triggers haven't fired yet) must not self-block on Station's own prior
  // claim.
  test('redispatching a still-active task releases its own prior claim first (no self-block)', async () => {
    const workspace = makeTempDir('station-workspace-');
    const assignmentClaimService = new AssignmentClaimService();
    const { service, taskGraphPath } = createService({
      workspace,
      assignmentClaimService,
    });
    const subjectId = 'github:kontourai/station#593';
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Redispatch self-handoff',
      workItemRef: subjectId,
    });

    const first = await dispatchTaskForTest(service, task.id, {});
    expect(first.dispatch.claim?.outcome).toBe('claimed');
    expect(first.task.status).toBe('ready'); // task-dispatch never advances past 'ready'

    // Redispatch the SAME still-'ready' task — without the fix, this would
    // be refused ("claimed by another actor: station:<first-session>...").
    const second = await dispatchTaskForTest(service, task.id, {});
    expect(second.dispatch.claim?.outcome).toBe('claimed');
    expect(second.dispatch.sessionId).not.toBe(first.dispatch.sessionId);

    // The CLI-side claim now belongs to the SECOND session.
    const artifactRoot = join(workspace, '.kontourai', 'flow-agents');
    const status = readAssignmentStatus(artifactRoot, subjectId);
    expect(status.claimed).toBe(true);
    expect(status.actorKey).toBe(
      `station:${second.dispatch.sessionId}:${require('node:os').hostname()}`,
    );

    // The FIRST dispatch record reflects its claim was superseded/released.
    const persisted = JSON.parse(readFileSync(taskGraphPath, 'utf-8'));
    const firstDispatch = persisted.dispatches.find(
      (d: { id: string }) => d.id === first.dispatch.id,
    );
    expect(firstDispatch.claim.outcome).toBe('released');
  });

  test('persists a confirmed prior-claim release even when the replacement dispatch becomes indeterminate', async () => {
    const workspace = makeTempDir('station-workspace-');
    const projectHomeDir = makeTempDir('station-tasks-claim-');
    const assignmentClaimService = new AssignmentClaimService();
    const service = new TaskGraphService(projectHomeDir, {
      assignmentClaimService,
      resolveProjectWorkspace: () => workspace,
      orchestrationService: {
        dispatch: vi.fn(async () => {
          throw new Error('remote start acknowledgement lost');
        }),
        seedSessionRecord: vi.fn(),
      },
    });
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Persist prior release before later failure',
      workItemRef: 'github:kontourai/station#2528',
    });
    const first = await dispatchTaskForTest(service, task.id, {});

    await expect(
      dispatchTaskForTest(service, task.id, {
        runtimeConfig: { provider: 'claude' },
      }),
    ).rejects.toThrow('remote start acknowledgement lost');

    const persisted = JSON.parse(
      readFileSync(join(projectHomeDir, 'task-graph.json'), 'utf-8'),
    );
    const firstDispatch = persisted.dispatches.find(
      (dispatch: { id: string }) => dispatch.id === first.dispatch.id,
    );
    expect(firstDispatch.claim.outcome).toBe('released');
    expect(persisted.tasks[0].dispatchReservation).toMatchObject({
      phase: 'indeterminate',
    });
  });

  test('readClaimStatus reports none for a local task and free/claimed for provider-backed tasks', async () => {
    const workspace = makeTempDir('station-workspace-');
    const assignmentClaimService = new AssignmentClaimService();
    const { service } = createService({ workspace, assignmentClaimService });

    const localTask = await service.createTask({
      projectId: 'project-alpha',
      title: 'Local',
    });
    expect(await service.readClaimStatus(localTask.id)).toEqual({
      state: 'none',
    });

    const providerTask = await service.createTask({
      projectId: 'project-alpha',
      title: 'Provider-backed',
      workItemRef: 'github:kontourai/station#588',
    });
    expect(await service.readClaimStatus(providerTask.id)).toEqual({
      state: 'free',
      subjectId: 'github:kontourai/station#588',
    });

    const result = await dispatchTaskForTest(service, providerTask.id, {});
    expect(result.dispatch.claim?.outcome).toBe('claimed');
    const claimedStatus = await service.readClaimStatus(providerTask.id);
    expect(claimedStatus.state).toBe('claimed-by-me');
    expect(claimedStatus.actor?.sessionId).toBe(result.dispatch.sessionId);
  });

  // Review finding #5: startup reconciliation sweep.
  describe('reconcileStaleAssignmentClaims', () => {
    test('releases a claim left behind by a task that reached a terminal status without a release completing (simulated crash)', async () => {
      const workspace = makeTempDir('station-workspace-');
      const assignmentClaimService = new AssignmentClaimService();
      const { service, taskGraphPath } = createService({
        workspace,
        assignmentClaimService,
      });
      const subjectId = 'github:kontourai/station#594';
      const task = await service.createTask({
        projectId: 'project-alpha',
        title: 'Crash before release',
        workItemRef: subjectId,
      });
      await dispatchTaskForTest(service, task.id, {});

      // Simulate "Station crashed after the task reached 'done' but before
      // the release completed": patch the persisted status directly,
      // bypassing updateTaskStatus (which would have released it) entirely.
      const persisted = JSON.parse(readFileSync(taskGraphPath, 'utf-8'));
      persisted.tasks = persisted.tasks.map(
        (t: { id: string; status: string }) =>
          t.id === task.id ? { ...t, status: 'done' } : t,
      );
      require('node:fs').writeFileSync(
        taskGraphPath,
        JSON.stringify(persisted, null, 2),
      );

      const artifactRoot = join(workspace, '.kontourai', 'flow-agents');
      expect(readAssignmentStatus(artifactRoot, subjectId).claimed).toBe(true);

      const sweep = await service.reconcileStaleAssignmentClaims();
      expect(sweep.releasedSubjects).toContain(subjectId);
      expect(readAssignmentStatus(artifactRoot, subjectId).claimed).toBe(false);
      expect(readPersistedDispatch(taskGraphPath, task.id).claim.outcome).toBe(
        'released',
      );
    });

    test('leaves a genuinely still-active claim alone', async () => {
      const workspace = makeTempDir('station-workspace-');
      const assignmentClaimService = new AssignmentClaimService();
      const { service } = createService({ workspace, assignmentClaimService });
      const subjectId = 'github:kontourai/station#595';
      const task = await service.createTask({
        projectId: 'project-alpha',
        title: 'Still active',
        workItemRef: subjectId,
      });
      await dispatchTaskForTest(service, task.id, {}); // status stays 'ready', current session

      const sweep = await service.reconcileStaleAssignmentClaims();
      expect(sweep.releasedSubjects).toEqual([]);

      const artifactRoot = join(workspace, '.kontourai', 'flow-agents');
      expect(readAssignmentStatus(artifactRoot, subjectId).claimed).toBe(true);
    });

    test("never releases a claim held by a different runtime, even for one of Station's own terminal tasks", async () => {
      const workspace = makeTempDir('station-workspace-');
      const artifactRoot = join(workspace, '.kontourai', 'flow-agents');
      const subjectId = 'github:kontourai/station#596';
      const otherActorTmpDir = makeTempDir('station-other-actor-');
      // A flow-agents CLI session independently holds this subject —
      // Station never dispatched it at all.
      seedOtherActorClaim(artifactRoot, subjectId, otherActorTmpDir);

      const assignmentClaimService = new AssignmentClaimService();
      const { service, taskGraphPath } = createService({
        workspace,
        assignmentClaimService,
      });
      // A Station task happens to reference the SAME subject and is
      // already 'done' (e.g. it was marked done locally without ever
      // successfully claiming — the claim attempt was blocked, so no
      // dispatch record with an active claim exists for it).
      const task = await service.createTask({
        projectId: 'project-alpha',
        title: 'Unrelated done task, same subject',
        workItemRef: subjectId,
      });
      const persisted = JSON.parse(readFileSync(taskGraphPath, 'utf-8'));
      persisted.tasks = persisted.tasks.map(
        (t: { id: string; status: string }) =>
          t.id === task.id ? { ...t, status: 'done' } : t,
      );
      require('node:fs').writeFileSync(
        taskGraphPath,
        JSON.stringify(persisted, null, 2),
      );

      const sweep = await service.reconcileStaleAssignmentClaims();
      expect(sweep.releasedSubjects).toEqual([]);
      // The flow-agents CLI session's claim is completely untouched.
      const status = readAssignmentStatus(artifactRoot, subjectId);
      expect(status.claimed).toBe(true);
      expect(status.actorKey).toBe('flow-agents-cli:cli-session-9:other-host');
    });

    // Confirmation-pass finding: per-task evaluation of a SHARED subject let
    // one task's own terminal status release ANOTHER task's genuinely live
    // claim, since `runtime === 'station'` alone is not ownership proof.
    test("does not release an active task's claim just because a SIBLING task sharing the same workItemRef is terminal", async () => {
      const workspace = makeTempDir('station-workspace-');
      const assignmentClaimService = new AssignmentClaimService();
      const { service, taskGraphPath } = createService({
        workspace,
        assignmentClaimService,
      });
      const subjectId = 'github:kontourai/station#597';

      // Task A: dispatched, genuinely holds the live claim, still active
      // ('ready' — the task-dispatch path never advances past it).
      const taskA = await service.createTask({
        projectId: 'project-alpha',
        title: 'Active task A',
        workItemRef: subjectId,
      });
      const dispatchA = await dispatchTaskForTest(service, taskA.id, {});
      expect(dispatchA.dispatch.claim?.outcome).toBe('claimed');

      // Task B: a SEPARATE local task that happens to reference the SAME
      // subject and is already terminal — it never held the claim itself.
      const taskB = await service.createTask({
        projectId: 'project-alpha',
        title: 'Unrelated terminal task B, same subject',
        workItemRef: subjectId,
      });
      const persisted = JSON.parse(readFileSync(taskGraphPath, 'utf-8'));
      persisted.tasks = persisted.tasks.map(
        (t: { id: string; status: string }) =>
          t.id === taskB.id ? { ...t, status: 'done' } : t,
      );
      require('node:fs').writeFileSync(
        taskGraphPath,
        JSON.stringify(persisted, null, 2),
      );

      const artifactRoot = join(workspace, '.kontourai', 'flow-agents');
      expect(readAssignmentStatus(artifactRoot, subjectId).claimed).toBe(true);

      const sweep = await service.reconcileStaleAssignmentClaims();

      // Task A's still-active claim is untouched — task B being terminal
      // must never be read as "this subject is done with, release it".
      expect(sweep.releasedSubjects).toEqual([]);
      const status = readAssignmentStatus(artifactRoot, subjectId);
      expect(status.claimed).toBe(true);
      expect(status.actorKey).toBe(
        `station:${dispatchA.dispatch.sessionId}:${require('node:os').hostname()}`,
      );
      expect(readPersistedDispatch(taskGraphPath, taskA.id).claim.outcome).toBe(
        'claimed',
      );
    });

    // Confirmation-pass finding: `runtime === 'station'` is not ownership
    // proof by itself — it only means SOME Station instance/session made
    // the claim (could be another Station home entirely, or a crash-
    // orphaned claim with no matching persisted dispatch in THIS store).
    // Without a proving dispatch record, the sweep must leave it alone.
    test('does not release a claim whose session_id matches no dispatch record this instance persisted', async () => {
      const workspace = makeTempDir('station-workspace-');
      const artifactRoot = join(workspace, '.kontourai', 'flow-agents');
      const subjectId = 'github:kontourai/station#598';
      const foreignSessionTmpDir = makeTempDir('station-foreign-session-');
      // A claim genuinely held under `runtime: 'station'`, but by a session
      // id THIS instance never dispatched and has no record of — simulates
      // either a sibling Station home sharing the same workspace/subject,
      // or a crash-orphaned claim from before this store's first write for
      // that attempt ever landed.
      const foreignActorJsonPath = join(
        foreignSessionTmpDir,
        'foreign-actor.json',
      );
      writeFileSync(
        foreignActorJsonPath,
        JSON.stringify({
          runtime: 'station',
          session_id: 'task-unknown-elsewhere-1',
          host: 'another-station-host',
        }),
      );
      execFileSync(process.execPath, [
        ASSIGNMENT_PROVIDER_CLI,
        'claim',
        '--provider',
        'local-file',
        '--artifact-root',
        artifactRoot,
        '--subject-id',
        subjectId,
        '--actor-json',
        foreignActorJsonPath,
        '--branch',
        'station/task-unknown-elsewhere-1',
        '--artifact-dir',
        join(artifactRoot, 'foreign-artifact-dir'),
        '--reason',
        'claimed by a sibling Station instance',
      ]);

      const assignmentClaimService = new AssignmentClaimService();
      const { service, taskGraphPath } = createService({
        workspace,
        assignmentClaimService,
      });
      // A LOCAL task referencing the same subject, terminal, but NEVER
      // dispatched through this instance — no dispatch record exists for
      // it at all, so there is nothing to prove ownership with.
      const task = await service.createTask({
        projectId: 'project-alpha',
        title: 'Terminal task, never dispatched locally',
        workItemRef: subjectId,
      });
      const persisted = JSON.parse(readFileSync(taskGraphPath, 'utf-8'));
      persisted.tasks = persisted.tasks.map(
        (t: { id: string; status: string }) =>
          t.id === task.id ? { ...t, status: 'done' } : t,
      );
      require('node:fs').writeFileSync(
        taskGraphPath,
        JSON.stringify(persisted, null, 2),
      );

      expect(readAssignmentStatus(artifactRoot, subjectId).claimed).toBe(true);

      const sweep = await service.reconcileStaleAssignmentClaims();

      expect(sweep.releasedSubjects).toEqual([]);
      const status = readAssignmentStatus(artifactRoot, subjectId);
      expect(status.claimed).toBe(true);
      expect(status.actorKey).toBe(
        'station:task-unknown-elsewhere-1:another-station-host',
      );
    });
  });

  // station#1501 slice 3b, seam S4's second input (consumer A7): production
  // composes an ASYNC project-workspace resolver. Both the
  // artifact-root derivation and the fail-closed blocked path must await it —
  // an unawaited Promise is truthy, so a missing `await` would turn "the
  // workspace is unresolvable" into a claim rooted at
  // "[object Promise]/.kontourai/flow-agents" and dispatch would proceed.
  test('an ASYNC project workspace resolver is awaited on the claim path', async () => {
    const workspace = makeTempDir('station-workspace-');
    const assignmentClaimService = new AssignmentClaimService();
    const projectHomeDir = makeTempDir('station-tasks-claim-');
    const service = new TaskGraphService(projectHomeDir, {
      assignmentClaimService,
      resolveProjectWorkspace: async () => workspace,
    });
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Async resolver',
      workItemRef: 'github:kontourai/station#1501',
    });

    const result = await dispatchTaskForTest(service, task.id, {});

    expect(result.dispatch.claim).toMatchObject({
      outcome: 'claimed',
      subjectId: 'github:kontourai/station#1501',
    });
    expect(existsSync(join(workspace, '.kontourai', 'flow-agents'))).toBe(true);
  });

  test('an ASYNC resolver answering undefined still BLOCKS dispatch', async () => {
    const assignmentClaimService = new AssignmentClaimService();
    const projectHomeDir = makeTempDir('station-tasks-claim-');
    const service = new TaskGraphService(projectHomeDir, {
      assignmentClaimService,
      resolveProjectWorkspace: async () => undefined,
    });
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Async unresolvable workspace',
      workItemRef: 'github:kontourai/station#1502',
    });

    await expect(dispatchTaskForTest(service, task.id, {})).rejects.toThrow(
      /indeterminate.*project workspace not resolvable/i,
    );
    expect(service.readTask(task.id)?.status).toBe('todo');
  });
});
