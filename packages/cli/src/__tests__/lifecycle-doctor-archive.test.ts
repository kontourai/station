/**
 * #2675 B1: `station doctor` from a prebuilt archive reports the runtime the
 * archive ships and its release, instead of judging a host toolchain the
 * archive neither needs nor can use.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import {
  PREBUILT_ARCHIVE_MARKER_CONTENT,
  PREBUILT_ARCHIVE_MARKER_FILENAME,
  resolveLifecycleCodeRoot,
} from '../commands/lifecycle-code-root.js';
import {
  collectDoctorReport,
  type DoctorDeps,
} from '../commands/lifecycle-doctor.js';

const makeTempDir = trackTempDirs();

// The exact .station-release.json the portable archive builder embeds.
const RELEASE = {
  schemaVersion: 2,
  sha: 'a'.repeat(40),
  ref: 'v0.0.0',
  createdAt: '2026-09-26T00:00:00.000Z',
  channel: 'stable',
  releaseChannel: 'stable',
  prerelease: false,
};

function archiveCodeRoot() {
  const root = makeTempDir('station-doctor-archive-');
  writeFileSync(
    join(root, '.station-release.json'),
    `${JSON.stringify(RELEASE, null, 2)}\n`,
  );
  writeFileSync(
    join(root, PREBUILT_ARCHIVE_MARKER_FILENAME),
    PREBUILT_ARCHIVE_MARKER_CONTENT,
  );
  const stationRoot = makeTempDir('station-doctor-root-');
  return resolveLifecycleCodeRoot(root, { STATION_ROOT: stationRoot });
}

function sourceCodeRoot() {
  const root = makeTempDir('station-doctor-checkout-');
  mkdirSync(join(root, '.git'));
  return resolveLifecycleCodeRoot(root, {});
}

/** A host with nothing on PATH: no node, npm, tsx, git or Rust. */
function bareHostDeps(overrides: Partial<DoctorDeps>): Partial<DoctorDeps> {
  return {
    exec: vi.fn(() => null),
    checkOllama: vi.fn(async () => false),
    readJson: <T>(_path: string, fallback: T) => fallback,
    exists: vi.fn(() => false),
    env: {},
    projectHome: '/nonexistent/project-home',
    inspectKontourDependencies: vi.fn(() => ({
      exactPins: [],
      mismatches: [],
    })),
    inspectSupervisorWedges: vi.fn(async () => []),
    probeTerminalPty: vi.fn(() => ({
      state: 'unavailable' as const,
      reason: 'node-pty failed to load.',
    })),
    ...overrides,
  };
}

describe('doctor from a prebuilt archive (#2675)', () => {
  test('reports the bundled runtime and the release, not the host toolchain', async () => {
    const codeRoot = archiveCodeRoot();
    if (codeRoot.kind !== 'prebuilt-archive') throw new Error('fixture');
    const execPath = join(codeRoot.root, 'runtime', 'bin', 'node');
    const exec = vi.fn((_command: string) => null);
    const inspectKontourDependencies = vi.fn(() => {
      throw new Error('ENOENT: no package.json');
    });
    const report = await collectDoctorReport(
      bareHostDeps({
        exec,
        inspectKontourDependencies,
        codeRoot,
        repoRoot: codeRoot.root,
        processRuntime: { version: 'v24.11.1', execPath },
      }),
    );

    expect(report.checks.slice(0, 3)).toEqual([
      {
        label: 'Node.js',
        status: 'pass',
        detail: `v24.11.1 (bundled: ${execPath})`,
      },
      {
        label: 'Prebuilt archive',
        status: 'pass',
        detail: `v0.0.0 (aaaaaaaaaaaa, stable ring, stable channel) at ${codeRoot.root}; lifecycle state in ${codeRoot.stateDir}`,
      },
      { label: 'git', status: 'fail', detail: 'Not found' },
    ]);
    const labels = report.checks.map((check) => check.label);
    for (const toolchain of ['npm', 'tsx', 'Kontour package pins', 'Rust']) {
      expect(labels).not.toContain(toolchain);
    }
    // No source toolchain is probed, and the host's `node` is never
    // consulted: the archive runs its own.
    expect(exec.mock.calls.map(([command]) => command)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^(node|npm|tsx|rustc) /)]),
    );
    // An archive has no package.json; inspecting its pins threw (#2675).
    expect(inspectKontourDependencies).not.toHaveBeenCalled();
    const commands = report.fixCommands.map((fix) => fix.command);
    expect(commands).not.toContain('npm install');
    expect(commands).not.toContain('npm run dependencies:install');
    expect(commands.some((command) => command.startsWith('nvm '))).toBe(false);
  });

  test('warns when the archive is run by a Node.js other than its own', async () => {
    const codeRoot = archiveCodeRoot();
    if (codeRoot.kind !== 'prebuilt-archive') throw new Error('fixture');
    const report = await collectDoctorReport(
      bareHostDeps({
        codeRoot,
        repoRoot: codeRoot.root,
        processRuntime: {
          version: 'v24.11.1',
          execPath: '/usr/local/bin/node',
        },
      }),
    );

    expect(report.checks[0]).toEqual({
      label: 'Node.js',
      status: 'warn',
      detail: `v24.11.1 from /usr/local/bin/node, not this archive's bundled runtime; run Station through ${join(codeRoot.root, 'bin', 'station')}`,
    });
  });

  test('a source checkout still checks the host toolchain', async () => {
    const codeRoot = sourceCodeRoot();
    const report = await collectDoctorReport(
      bareHostDeps({
        codeRoot,
        repoRoot: codeRoot.root,
        processRuntime: { version: 'v24.11.1', execPath: '/x/node' },
      }),
    );

    expect(report.checks.slice(0, 4)).toEqual([
      {
        label: 'Node.js',
        status: 'fail',
        detail: 'Not found — Node.js 24.x required',
      },
      { label: 'npm', status: 'fail', detail: 'Not found' },
      { label: 'git', status: 'fail', detail: 'Not found' },
      { label: 'tsx', status: 'fail', detail: 'Not found' },
    ]);
    expect(report.checks.map((check) => check.label)).not.toContain(
      'Prebuilt archive',
    );
    expect(report.fixCommands.map((fix) => fix.command)).toEqual(
      expect.arrayContaining([
        'nvm install 24 && nvm use 24',
        'npm install',
        'npm run dependencies:install',
      ]),
    );
  });
});
