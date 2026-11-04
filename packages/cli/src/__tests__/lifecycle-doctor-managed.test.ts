/**
 * #4517 round 2: `station doctor` derives runtime readiness from the settings
 * in effect, with the managed policy applied the way the server applies it.
 * The policy is built by the real decoder; the stored file is a stub.
 */
import { summarizeManagedPolicy } from '@kontourai/station-contracts/managed-policy';
import {
  decodeManagedPolicy,
  type LoadedManagedPolicy,
  ManagedPolicyInvalidError,
  managedPolicyDigest,
} from '@kontourai/station-shared/managed-policy';
import { describe, expect, test, vi } from 'vitest';
import {
  collectDoctorReport,
  type DoctorDeps,
} from '../commands/lifecycle-doctor.js';

function policy(
  settings: Record<string, { value: unknown; locked: boolean }>,
): LoadedManagedPolicy {
  const document = decodeManagedPolicy('/test/policy.json', {
    kind: 'value',
    value: { schemaVersion: 1, organization: 'Acme', settings },
  });
  return {
    source: { kind: 'test-override', location: '/test/policy.json' },
    document,
    digest: managedPolicyDigest(document),
    summary: summarizeManagedPolicy(document),
  };
}

const STORED = { agentConnections: { codex: { enabled: true } } };

function deps(
  loadManagedPolicy: DoctorDeps['loadManagedPolicy'],
  { codexCli = false }: { codexCli?: boolean } = {},
): Partial<DoctorDeps> {
  return {
    // No credentials. Without `codexCli`, no CLI either: only the stored
    // connection can make it ready.
    exec: vi.fn((command: string) =>
      codexCli && command === 'codex --version' ? 'codex-cli 1.0.0' : null,
    ),
    checkOllama: vi.fn(async () => false),
    readJson: <T>(path: string, fallback: T) =>
      (path.endsWith('app.json') ? STORED : fallback) as T,
    exists: vi.fn(() => false),
    env: {},
    projectHome: '/nonexistent/project-home',
    repoRoot: '/nonexistent/repo-root',
    inspectKontourDependencies: vi.fn(() => ({
      exactPins: [],
      mismatches: [],
    })),
    inspectSupervisorWedges: vi.fn(async () => []),
    inspectShellHosts: vi.fn(() => []),
    probeTerminalPty: vi.fn(() => ({ state: 'available' as const })),
    loadManagedPolicy,
  };
}

describe('station doctor under a managed policy', () => {
  test('a stored connection with no policy is ready', async () => {
    const report = await collectDoctorReport(deps(() => null));
    expect(report.runtimeReady).toBe(true);
    expect(report.runtimeState.configured).toEqual(['codex']);
  });

  test('a connection the policy disables is not reported as ready', async () => {
    const report = await collectDoctorReport(
      deps(() =>
        policy({
          agentConnections: {
            value: { codex: { enabled: false } },
            locked: true,
          },
        }),
      ),
    );
    expect(report.runtimeReady).toBe(false);
    expect(report.runtimeState.configured).toEqual([]);
  });

  test('a detected CLI whose connection the policy disables is not a runtime', async () => {
    const disabled = () =>
      policy({
        agentConnections: {
          value: { codex: { enabled: false } },
          locked: true,
        },
      });
    // Control: the same detected CLI is a runtime without the policy.
    const unmanaged = await collectDoctorReport(
      deps(() => null, { codexCli: true }),
    );
    expect(unmanaged.runtimeState.detected).toContain('codex-cli');
    const report = await collectDoctorReport(
      deps(disabled, { codexCli: true }),
    );
    expect(report.runtimeReady).toBe(false);
    expect(report.runtimeState.detected).not.toContain('codex-cli');
    expect(report.runtimeState.effective).toBeNull();
  });

  test('a policy startup would refuse is a failing check, not readiness', async () => {
    const report = await collectDoctorReport(
      deps(
        () => {
          throw new ManagedPolicyInvalidError('/test/policy.json', 'bad value');
        },
        { codexCli: true },
      ),
    );
    expect(report.runtimeReady).toBe(false);
    expect(report.runtimeState.effective).toBeNull();
    const check = report.checks.find((item) => item.label === 'Managed policy');
    expect(check?.status).toBe('fail');
    expect(check?.detail).toContain('/test/policy.json');
  });
});
