/**
 * Fixture discipline: every fixture below is written to a real temp
 * directory via fs.writeFileSync/mkdtempSync at test runtime (never a
 * checked-in sidecar-shaped path, never a shell redirect) — the repo's
 * config-protection hook blocks sidecar-shaped shell redirects.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { FlowAgentsCliResult } from '../../work-item-providers/flow-agents-work-item-provider.js';
import {
  type AssignmentClaimActor,
  AssignmentClaimService,
} from '../assignment-claim-service.js';

const ASSIGNMENT_PROVIDER_CLI = 'build/src/cli/assignment-provider.js';

const tmpDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** A fake pinned-package root with the assignment-provider CLI bin present
 * (an empty stub file — the runner is stubbed, so it is only used for the
 * `existsSync` package-root check). */
function makePackageRootWithCli(): string {
  const root = makeTempDir('flow-agents-pkg-');
  mkdirSync(join(root, 'build', 'src', 'cli'), { recursive: true });
  writeFileSync(join(root, ASSIGNMENT_PROVIDER_CLI), '// stub');
  return root;
}

interface Call {
  bin: string;
  args: string[];
}

const ACTOR: AssignmentClaimActor = {
  runtime: 'station',
  session_id: 'task-alpha-1',
  host: 'test-host',
};

describe('AssignmentClaimService', () => {
  test('reports unavailable when the CLI bin is not found on the package root', async () => {
    const emptyRoot = makeTempDir('flow-agents-empty-');
    const service = new AssignmentClaimService({
      packageRoot: emptyRoot,
      runCli: async () => {
        throw new Error('not called');
      },
    });
    expect(service.isPackageAvailable).toBe(false);

    const claim = await service.claim({
      artifactRoot: '/tmp/does-not-matter',
      subjectId: 'github:kontourai/station#1',
      actor: ACTOR,
      branch: 'station/task-alpha-1',
      artifactDir: '/tmp/does-not-matter/artifact',
      reason: 'test',
    });
    expect(claim).toEqual({
      outcome: 'unavailable',
      reason: '@kontourai/flow-agents is not installed',
    });

    const release = await service.release({
      artifactRoot: '/tmp/does-not-matter',
      subjectId: 'github:kontourai/station#1',
      actor: ACTOR,
      reason: 'test',
    });
    expect(release).toEqual({
      outcome: 'unavailable',
      reason: '@kontourai/flow-agents is not installed',
    });

    const status = await service.status({
      artifactRoot: '/tmp/does-not-matter',
      subjectId: 'github:kontourai/station#1',
    });
    expect(status).toEqual({
      outcome: 'unavailable',
      reason: '@kontourai/flow-agents is not installed',
    });
  });

  test('claim writes a real actor-json temp file (never a shell redirect) and cleans it up', async () => {
    const calls: Call[] = [];
    let capturedActorJson: string | undefined;
    const claimedRecord = {
      schema_version: '1.0',
      role: 'AssignmentClaimRecord',
      subject_id: 'github:kontourai/station#1',
      actor: { ...ACTOR, human: null },
      claimed_at: '2026-07-22T00:00:00Z',
      ttl_seconds: 1800,
      branch: 'station/task-alpha-1',
      artifact_dir: '/tmp/root/artifact',
      status: 'claimed' as const,
    };
    const service = new AssignmentClaimService({
      packageRoot: makePackageRootWithCli(),
      runCli: async (bin, args, options) => {
        calls.push({ bin, args });
        const actorJsonIndex = args.indexOf('--actor-json');
        capturedActorJson = args[actorJsonIndex + 1];
        expect(options.cwd).toBeTruthy();
        const result: FlowAgentsCliResult = {
          stdout: JSON.stringify({
            role: 'AssignmentClaimResult',
            subject_id: claimedRecord.subject_id,
            record: claimedRecord,
          }),
          stderr: '',
          exitCode: 0,
        };
        return result;
      },
    });

    const result = await service.claim({
      artifactRoot: '/tmp/root',
      subjectId: 'github:kontourai/station#1',
      actor: ACTOR,
      branch: 'station/task-alpha-1',
      artifactDir: '/tmp/root/artifact',
      reason: 'Station dispatch: task alpha',
    });

    expect(result).toEqual({ outcome: 'claimed', record: claimedRecord });
    expect(calls[0]?.args).toEqual(
      expect.arrayContaining([
        'claim',
        '--provider',
        'local-file',
        '--artifact-root',
        '/tmp/root',
        '--subject-id',
        'github:kontourai/station#1',
        '--branch',
        'station/task-alpha-1',
        '--artifact-dir',
        '/tmp/root/artifact',
        '--reason',
        'Station dispatch: task alpha',
      ]),
    );
    // The actor-json path is a real temp file the service wrote itself
    // (fs.writeFileSync), not a shell-redirected sidecar-shaped path.
    expect(capturedActorJson).toMatch(
      /[\\/]station[\\/]assignment-claim-[^\\/]+[\\/]actor\.json$/,
    );
    // Cleaned up by the time claim() resolves (best-effort finally block).
    expect(existsSync(capturedActorJson!)).toBe(false);
  });

  test('claim reports blocked with the holder actor when the CLI refuses ownership', async () => {
    const holderRecord = {
      schema_version: '1.0',
      role: 'AssignmentClaimRecord',
      subject_id: 'github:kontourai/station#1',
      actor: {
        runtime: 'flow-agents-cli',
        session_id: 'sess-9',
        host: 'other-host',
        human: null,
      },
      claimed_at: '2026-07-22T00:00:00Z',
      ttl_seconds: 1800,
      branch: 'agent/other/task',
      artifact_dir: '/tmp/root/artifact',
      status: 'claimed' as const,
    };
    const service = new AssignmentClaimService({
      packageRoot: makePackageRootWithCli(),
      runCli: async (_bin, args) => {
        if (args[0] === 'claim') {
          return {
            stdout: '',
            stderr:
              'assignment-provider: subject already claimed by a different actor: flow-agents-cli:sess-9:other-host (claimed_at 2026-07-22T00:00:00Z); refusing to overwrite — use supersede to reassign',
            exitCode: 1,
          };
        }
        if (args[0] === 'status') {
          return {
            stdout: JSON.stringify({
              role: 'AssignmentStatus',
              provider: 'local-file',
              assignment: {
                subject_id: holderRecord.subject_id,
                provider: 'local-file',
                assignee: 'flow-agents-cli:sess-9:other-host',
                record: holderRecord,
              },
              effective: { effective_state: null, reason: 'n/a' },
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        throw new Error(`unexpected command: ${args[0]}`);
      },
    });

    const result = await service.claim({
      artifactRoot: '/tmp/root',
      subjectId: 'github:kontourai/station#1',
      actor: ACTOR,
      branch: 'station/task-alpha-1',
      artifactDir: '/tmp/root/artifact',
      reason: 'test',
    });

    expect(result.outcome).toBe('blocked');
    if (result.outcome !== 'blocked') throw new Error('expected blocked');
    expect(result.kind).toBe('conflict');
    expect(result.reason).toMatch(/already claimed by a different actor/);
    expect(result.holderActor).toEqual(holderRecord.actor);
  });

  // Review finding #4: an operational claim failure (lock timeout, corrupt
  // record, CLI usage error — anything other than the exact "already
  // claimed by a different actor" refusal) must fail CLOSED, not open.
  // Ownership is indeterminate, not absent — a caller must never proceed
  // unclaimed just because the CLI had an unrelated problem.
  test('claim fails CLOSED (blocked, operational-error) on a non-conflict CLI failure — simulated lock timeout', async () => {
    const service = new AssignmentClaimService({
      packageRoot: makePackageRootWithCli(),
      runCli: async () => ({
        stdout: '',
        stderr:
          'assignment-provider: timed out waiting for assignment lock for subject github:kontourai/station#1',
        exitCode: 1,
      }),
    });

    const result = await service.claim({
      artifactRoot: '/tmp/root',
      subjectId: 'github:kontourai/station#1',
      actor: ACTOR,
      branch: 'station/task-alpha-1',
      artifactDir: '/tmp/root/artifact',
      reason: 'test',
    });

    expect(result.outcome).toBe('blocked');
    if (result.outcome !== 'blocked') throw new Error('expected blocked');
    expect(result.kind).toBe('operational-error');
    expect(result.reason).toMatch(/timed out waiting for assignment lock/);
    expect(result.holderActor).toBeUndefined();
  });

  test('claim fails CLOSED (blocked, operational-error) on a reported success with unparseable output', async () => {
    const service = new AssignmentClaimService({
      packageRoot: makePackageRootWithCli(),
      runCli: async () => ({
        stdout: 'not json',
        stderr: '',
        exitCode: 0,
      }),
    });

    const result = await service.claim({
      artifactRoot: '/tmp/root',
      subjectId: 'github:kontourai/station#1',
      actor: ACTOR,
      branch: 'station/task-alpha-1',
      artifactDir: '/tmp/root/artifact',
      reason: 'test',
    });

    expect(result.outcome).toBe('blocked');
    if (result.outcome !== 'blocked') throw new Error('expected blocked');
    expect(result.kind).toBe('operational-error');
    expect(result.reason).toMatch(/malformed JSON/);
  });

  test('claim fails CLOSED (blocked, operational-error), never unavailable, when the injected runner throws', async () => {
    const service = new AssignmentClaimService({
      packageRoot: makePackageRootWithCli(),
      runCli: async () => {
        throw new Error('spawn EPERM');
      },
    });

    const result = await service.claim({
      artifactRoot: '/tmp/root',
      subjectId: 'github:kontourai/station#1',
      actor: ACTOR,
      branch: 'station/task-alpha-1',
      artifactDir: '/tmp/root/artifact',
      reason: 'test',
    });
    expect(result).toEqual({
      outcome: 'blocked',
      kind: 'operational-error',
      reason: 'spawn EPERM',
    });
  });

  // Package-absence stays the ONE fail-open path (finding #4): no CLI bin
  // on the resolved package root means no claim system exists at all, so
  // there is nothing indeterminate to fail closed about.
  test('claim fails OPEN (unavailable) only for genuine package absence', async () => {
    const service = new AssignmentClaimService({
      packageRoot: makeTempDir('flow-agents-empty-'),
      runCli: async () => {
        throw new Error('not called');
      },
    });
    const result = await service.claim({
      artifactRoot: '/tmp/root',
      subjectId: 'github:kontourai/station#1',
      actor: ACTOR,
      branch: 'station/task-alpha-1',
      artifactDir: '/tmp/root/artifact',
      reason: 'test',
    });
    expect(result).toEqual({
      outcome: 'unavailable',
      reason: '@kontourai/flow-agents is not installed',
    });
  });

  test('release reports skipped (safe idempotent no-op) ONLY on the CLI\'s exact "no active claim" message', async () => {
    const service = new AssignmentClaimService({
      packageRoot: makePackageRootWithCli(),
      runCli: async () => ({
        stdout: '',
        stderr:
          'assignment-provider: no active claim to release for subject: x',
        exitCode: 1,
      }),
    });

    const result = await service.release({
      artifactRoot: '/tmp/root',
      subjectId: 'github:kontourai/station#1',
      actor: ACTOR,
      reason: 'session.exited',
    });
    expect(result.outcome).toBe('skipped');
    if (result.outcome !== 'skipped') throw new Error('expected skipped');
    expect(result.reason).toMatch(/no active claim to release/);
  });

  // Review finding #3: every OTHER non-zero release exit (actor mismatch,
  // lock timeout, corrupt record) must be reported as 'failed', never
  // 'skipped' — the caller must not treat a failed release as success.
  test('release reports failed (never skipped) on an actor-mismatch refusal', async () => {
    const service = new AssignmentClaimService({
      packageRoot: makePackageRootWithCli(),
      runCli: async () => ({
        stdout: '',
        stderr:
          'assignment-provider: --actor-json does not match the current holder (other:sess:host); refusing to release a claim held by someone else',
        exitCode: 1,
      }),
    });

    const result = await service.release({
      artifactRoot: '/tmp/root',
      subjectId: 'github:kontourai/station#1',
      actor: ACTOR,
      reason: 'session.exited',
    });
    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') throw new Error('expected failed');
    expect(result.reason).toMatch(/does not match the current holder/);
  });

  test('release reports failed (never skipped) on a simulated lock timeout', async () => {
    const service = new AssignmentClaimService({
      packageRoot: makePackageRootWithCli(),
      runCli: async () => ({
        stdout: '',
        stderr:
          'assignment-provider: timed out waiting for assignment lock for subject github:kontourai/station#1',
        exitCode: 1,
      }),
    });

    const result = await service.release({
      artifactRoot: '/tmp/root',
      subjectId: 'github:kontourai/station#1',
      actor: ACTOR,
      reason: 'session.exited',
    });
    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') throw new Error('expected failed');
    expect(result.reason).toMatch(/timed out waiting for assignment lock/);
  });

  test('release reports failed (never unavailable), never throws, when the injected runner throws', async () => {
    const service = new AssignmentClaimService({
      packageRoot: makePackageRootWithCli(),
      runCli: async () => {
        throw new Error('spawn EPERM');
      },
    });
    const result = await service.release({
      artifactRoot: '/tmp/root',
      subjectId: 'github:kontourai/station#1',
      actor: ACTOR,
      reason: 'session.exited',
    });
    expect(result).toEqual({ outcome: 'failed', reason: 'spawn EPERM' });
  });

  test('release fails OPEN (unavailable) only for genuine package absence', async () => {
    const service = new AssignmentClaimService({
      packageRoot: makeTempDir('flow-agents-empty-'),
      runCli: async () => {
        throw new Error('not called');
      },
    });
    const result = await service.release({
      artifactRoot: '/tmp/root',
      subjectId: 'github:kontourai/station#1',
      actor: ACTOR,
      reason: 'test',
    });
    expect(result).toEqual({
      outcome: 'unavailable',
      reason: '@kontourai/flow-agents is not installed',
    });
  });

  test('release reports released on success', async () => {
    const releasedRecord = {
      schema_version: '1.0',
      role: 'AssignmentClaimRecord',
      subject_id: 'github:kontourai/station#1',
      actor: { ...ACTOR, human: null },
      claimed_at: '2026-07-22T00:00:00Z',
      ttl_seconds: 1800,
      branch: 'station/task-alpha-1',
      artifact_dir: '/tmp/root/artifact',
      status: 'released' as const,
    };
    const service = new AssignmentClaimService({
      packageRoot: makePackageRootWithCli(),
      runCli: async () => ({
        stdout: JSON.stringify({
          role: 'AssignmentReleaseResult',
          subject_id: releasedRecord.subject_id,
          record: releasedRecord,
        }),
        stderr: '',
        exitCode: 0,
      }),
    });

    const result = await service.release({
      artifactRoot: '/tmp/root',
      subjectId: 'github:kontourai/station#1',
      actor: ACTOR,
      reason: 'session.exited',
    });
    expect(result).toEqual({ outcome: 'released', record: releasedRecord });
  });

  test('status reports free when there is no active claim record', async () => {
    const service = new AssignmentClaimService({
      packageRoot: makePackageRootWithCli(),
      runCli: async () => ({
        stdout: JSON.stringify({
          role: 'AssignmentStatus',
          provider: 'local-file',
          assignment: {
            subject_id: 'github:kontourai/station#1',
            provider: 'local-file',
            assignee: null,
            record: null,
          },
          effective: { effective_state: null, reason: 'n/a' },
        }),
        stderr: '',
        exitCode: 0,
      }),
    });

    const result = await service.status({
      artifactRoot: '/tmp/root',
      subjectId: 'github:kontourai/station#1',
    });
    expect(result).toEqual({ outcome: 'free' });
  });

  test('status reports unavailable on malformed CLI JSON', async () => {
    const service = new AssignmentClaimService({
      packageRoot: makePackageRootWithCli(),
      runCli: async () => ({
        stdout: 'not json',
        stderr: '',
        exitCode: 0,
      }),
    });

    const result = await service.status({
      artifactRoot: '/tmp/root',
      subjectId: 'github:kontourai/station#1',
    });
    expect(result).toEqual({
      outcome: 'unavailable',
      reason: 'assignment-provider status returned malformed JSON',
    });
  });
});
