/**
 * `station doctor` must see ACP engine connections, which are saved in
 * `config/acp.json` (the file the server's ACP adapter reads), not under
 * `agentConnections`. Before this, a Station chatting on an OpenCode ACP
 * connection reported "No ACP runtime detected" and chat ready false, and
 * that report seeded in-app troubleshooting.
 */
import { describe, expect, test, vi } from 'vitest';
import {
  collectDoctorReport,
  type DoctorDeps,
} from '../commands/lifecycle-doctor.js';

const PROJECT_HOME = '/nonexistent/project-home';

/** The shape `saveACPConfigFile` writes (config-loader-storage.ts). */
function acpFile(enabled: boolean) {
  return {
    connections: [
      {
        id: 'opencode',
        name: 'OpenCode',
        command: 'opencode',
        args: ['acp'],
        enabled,
        source: 'user',
      },
    ],
  };
}

function deps(acp: unknown): Partial<DoctorDeps> {
  return {
    // No CLI, no model connection, no Ollama, no AWS: only acp.json can
    // make chat or the runtime ready.
    exec: vi.fn(() => null),
    checkOllama: vi.fn(async () => false),
    readJson: <T>(path: string, fallback: T) =>
      (path === `${PROJECT_HOME}/config/acp.json` && acp !== undefined
        ? acp
        : fallback) as T,
    exists: vi.fn(() => false),
    env: {},
    projectHome: PROJECT_HOME,
    repoRoot: '/nonexistent/repo-root',
    inspectKontourDependencies: vi.fn(() => ({
      exactPins: [],
      mismatches: [],
    })),
    inspectSupervisorWedges: vi.fn(async () => []),
    inspectShellHosts: vi.fn(() => []),
    probeTerminalPty: vi.fn(() => ({ state: 'available' as const })),
    loadManagedPolicy: () => null,
  };
}

const acpRow = (report: Awaited<ReturnType<typeof collectDoctorReport>>) =>
  report.checks.find((check) => check.label === 'ACP / external runtime');

describe('station doctor with ACP connections', () => {
  test('an enabled ACP connection is a runtime and makes chat ready', async () => {
    const report = await collectDoctorReport(deps(acpFile(true)));
    expect(acpRow(report)).toEqual({
      label: 'ACP / external runtime',
      status: 'pass',
      detail: '1 enabled ACP connection(s): OpenCode',
    });
    expect(report.chatReady).toBe(true);
    expect(report.runtimeReady).toBe(true);
    expect(report.runtimeState.configured).toEqual(['acp:opencode']);
    expect(report.recommendation).not.toContain('No chat-capable path');
    expect(report.fixCommands.map((fix) => fix.label)).not.toContain(
      'Start a local Ollama runtime',
    );
  });

  test('a disabled ACP connection, or none, still reports no runtime', async () => {
    for (const acp of [acpFile(false), undefined]) {
      const report = await collectDoctorReport(deps(acp));
      expect(acpRow(report)).toMatchObject({
        status: 'warn',
        detail: 'No ACP runtime detected.',
      });
      expect(report.chatReady).toBe(false);
      expect(report.runtimeReady).toBe(false);
    }
  });

  test('a malformed acp.json is not a runtime', async () => {
    const report = await collectDoctorReport(
      deps({ connections: [{ enabled: true }, null, 'x'] }),
    );
    expect(acpRow(report)?.status).toBe('warn');
    expect(report.chatReady).toBe(false);
  });
});
