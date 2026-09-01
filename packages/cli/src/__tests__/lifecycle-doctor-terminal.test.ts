import { describe, expect, test, vi } from 'vitest';
import type { DoctorDeps } from '../commands/lifecycle-doctor.js';
import {
  collectDoctorReport,
  probeTerminalPtyModule,
} from '../commands/lifecycle-doctor.js';

function stubDeps(overrides: Partial<DoctorDeps> = {}): Partial<DoctorDeps> {
  return {
    exec: vi.fn(() => null),
    checkOllama: vi.fn(async () => false),
    readJson: <T>(_path: string, fallback: T) => fallback,
    exists: vi.fn(() => false),
    env: {},
    projectHome: '/nonexistent/project-home',
    repoRoot: '/nonexistent/repo-root',
    inspectKontourDependencies: vi.fn(() => ({
      exactPins: [],
      mismatches: [],
    })),
    inspectSupervisorWedges: vi.fn(async () => []),
    ...overrides,
  };
}

describe('doctor terminal PTY check (#1244)', () => {
  test('a no-pty configuration produces a loud warn line and the rebuild fix command', async () => {
    const reason =
      'node-pty failed to load. Interactive terminal panes are unavailable; agent execution is unaffected. (cause: Failed to load native module: pty.node)';
    const report = await collectDoctorReport(
      stubDeps({
        probeTerminalPty: vi.fn(() => ({
          state: 'unavailable' as const,
          reason,
        })),
      }),
    );
    const check = report.checks.find(
      (item) => item.label === 'Terminal PTY (node-pty)',
    );
    expect(check).toEqual({
      label: 'Terminal PTY (node-pty)',
      // warn, not fail: the install stays usable, so a degraded terminal
      // must not turn the doctor's exit code into "missing required
      // prerequisites" — the line itself is the loud part.
      status: 'warn',
      detail: reason,
    });
    const fix = report.fixCommands.find(
      (candidate) => candidate.command === 'npm rebuild node-pty',
    );
    expect(fix).toBeDefined();
    expect(fix?.reason).toContain('terminal panes are disabled');
    expect(fix?.reason).toContain('agent execution is unaffected');
  });

  test('a loadable pty passes and adds no fix command', async () => {
    const report = await collectDoctorReport(
      stubDeps({
        probeTerminalPty: vi.fn(() => ({ state: 'available' as const })),
      }),
    );
    const check = report.checks.find(
      (item) => item.label === 'Terminal PTY (node-pty)',
    );
    expect(check?.status).toBe('pass');
    expect(
      report.fixCommands.some(
        (candidate) => candidate.command === 'npm rebuild node-pty',
      ),
    ).toBe(false);
  });

  test('the default probe answers about the checkout it is pointed at', () => {
    // A directory with no node_modules cannot load node-pty: the probe must
    // report the degraded state with the actionable remediation, not throw.
    const capability = probeTerminalPtyModule('/nonexistent/repo-root');
    expect(capability.state).toBe('unavailable');
    if (capability.state !== 'unavailable') return;
    expect(capability.reason).toContain('npm rebuild node-pty');
  });
});
