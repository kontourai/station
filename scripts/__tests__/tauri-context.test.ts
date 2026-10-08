import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';
import {
  cargoDependencyVersion,
  collectFindings,
  exactSemver,
  extractDocumentationSection,
  mergeJsonPatch,
  TAURI_CONTEXT_USAGE,
} from '../tauri-context.mjs';

describe('tauri context', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const makeTempDir = trackTempDirs();
  function reportFor(contextRoot = root, env = process.env) {
    const result = spawnSyncBounded(
      process.execPath,
      [
        fileURLToPath(new URL('../tauri-context.mjs', import.meta.url)),
        '--json',
        '--trace-probes',
        '--platform',
        'windows',
        '--root',
        contextRoot,
      ],
      { encoding: 'utf8', timeout: 30_000, windowsHide: true, env },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status).toBe(0);
    return { report: JSON.parse(result.stdout), probeTrace: result.stderr };
  }

  function contextFixture(prefix = 'station-tauri-context-') {
    const directory = makeTempDir(prefix);
    for (const path of [
      'package.json',
      'pnpm-lock.yaml',
      'src-desktop/Cargo.toml',
      'src-desktop/tauri.conf.json',
      'src-desktop/tauri.windows.conf.json',
    ]) {
      const destination = join(directory, path);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(root, path), destination);
    }
    mkdirSync(join(directory, 'src-desktop/capabilities'), { recursive: true });
    return directory;
  }

  function stalledToolEnvironment(pidDirectory?: string): NodeJS.ProcessEnv {
    const directory = makeTempDir('station-tauri-stalled-tools-');
    const tools = ['rustc', 'cargo', 'rustup'];
    if (process.platform === 'win32') {
      const source = join(directory, 'stalled.cs');
      writeFileSync(
        source,
        'class Stalled { static void Main() { System.Threading.Thread.Sleep(11000); } }',
      );
      const binary = join(directory, 'stalled.exe');
      const windows = process.env.WINDIR ?? process.env.SystemRoot;
      if (!windows) throw new Error('Windows compiler root unavailable');
      const compiled = spawnSyncBounded(
        join(windows, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
        ['/nologo', '/target:exe', `/out:${binary}`, source],
        { encoding: 'utf8', timeout: 10_000, windowsHide: true },
      );
      expect(compiled.error, compiled.stderr).toBeUndefined();
      expect(compiled.status, compiled.stderr).toBe(0);
      for (const tool of tools) {
        copyFileSync(binary, join(directory, `${tool}.exe`));
      }
    } else {
      for (const tool of tools) {
        writeFileSync(
          join(directory, tool),
          `#!${process.execPath}\n${pidDirectory ? `require('node:fs').writeFileSync(${JSON.stringify(join(pidDirectory, tool))}, String(process.pid));\n` : ''}setTimeout(() => {}, 11000);\n`,
          { mode: 0o755 },
        );
      }
    }
    const env = { ...process.env };
    const pathKey = Object.keys(env).find(
      (key) => key.toLowerCase() === 'path',
    );
    const existingPath = pathKey ? env[pathKey] : '';
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === 'path') delete env[key];
    }
    env.PATH = `${directory}${delimiter}${existingPath ?? ''}`;
    return env;
  }

  test('a report retains real npm and Tauri versions and honest failures when three independent tools stall', () => {
    const { report, probeTrace } = reportFor(root, stalledToolEnvironment());
    const tauri = JSON.parse(
      readFileSync(
        join(root, 'node_modules/@tauri-apps/cli/package.json'),
        'utf8',
      ),
    );
    expect(
      report.checks.npm.status,
      JSON.stringify({ npmCheck: report.checks.npm, probeTrace }),
    ).toBe('checked');
    expect(report.checks.npm.value).toMatch(/^\d+\.\d+\.\d+$/);
    expect(report.checks.tauriCli.status).toBe('checked');
    expect(report.checks.tauriCli.value).toBe(`tauri-cli ${tauri.version}`);
    for (const [key, id] of [
      ['rustc', 'rustc'],
      ['cargo', 'cargo'],
      ['rustTargets', 'rust-targets'],
    ] as const) {
      expect(report.checks[key].status).toBe('failed');
      expect(report.checks[key].value).toBeUndefined();
      expect(report.findings).toContainEqual(
        expect.objectContaining({ code: `check-failed-${id}` }),
      );
    }
  });

  function stopFixture(pid: number) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
      )
        throw error;
    }
  }

  test
    .skipIf(process.platform === 'win32')
    .each(['SIGINT', 'SIGTERM'] as const)(
    'settles active owned probes before exiting on %s',
    async (signal) => {
      const directory = makeTempDir('station-tauri-cancelled-');
      const child = spawn(
        process.execPath,
        [
          join(root, 'scripts/tauri-context.mjs'),
          '--json',
          '--trace-probes',
          '--platform',
          'windows',
          '--root',
          root,
        ],
        {
          env: stalledToolEnvironment(directory),
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      const tools = ['rustc', 'cargo', 'rustup'];
      const pids: number[] = [];
      try {
        const deadline = Date.now() + 5_000;
        while (!tools.every((tool) => existsSync(join(directory, tool)))) {
          if (Date.now() >= deadline)
            throw new Error(`Stalled probes did not start: ${stderr}`);
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        pids.push(
          ...tools.map((tool) =>
            Number(readFileSync(join(directory, tool), 'utf8')),
          ),
        );
        expect(child.kill(signal)).toBe(true);
        let timer: ReturnType<typeof setTimeout> | undefined;
        let status: number | null;
        try {
          status = await Promise.race([
            closed,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(new Error(`Cancellation did not settle: ${stderr}`)),
                5_000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        expect(stdout).toBe('');
        for (const pid of pids) {
          expect(() => process.kill(pid, 0)).toThrow(
            expect.objectContaining({ code: 'ESRCH' }),
          );
        }
        expect(status).toBe(signal === 'SIGINT' ? 130 : 143);
        const traces = stderr
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        for (const id of ['rustc', 'cargo', 'rust-targets']) {
          expect(traces).toContainEqual(
            expect.objectContaining({ id, phase: 'end', status: 'failed' }),
          );
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
        for (const tool of tools) {
          if (!existsSync(join(directory, tool))) continue;
          const pid = Number(readFileSync(join(directory, tool), 'utf8'));
          stopFixture(pid);
        }
        await closed;
      }
    },
  );

  test.skipIf(process.platform !== 'win32')(
    'reports versions from the real installed npm and local Tauri CLIs on Windows',
    () => {
      const { report, probeTrace } = reportFor();
      const tauri = JSON.parse(
        readFileSync(
          join(root, 'node_modules/@tauri-apps/cli/package.json'),
          'utf8',
        ),
      );
      expect(
        report.checks.npm.status,
        JSON.stringify({ npmCheck: report.checks.npm, probeTrace }),
      ).toBe('checked');
      expect(report.checks.npm.value).toMatch(/^\d+\.\d+\.\d+$/);
      expect(report.checks.tauriCli.status).toBe('checked');
      expect(report.checks.tauriCli.value).toBe(`tauri-cli ${tauri.version}`);
    },
  );

  test.skipIf(process.platform !== 'win32')(
    'reports a failed npm probe when its configured JS entry is missing',
    () => {
      const directory = makeTempDir('station-tauri-npm-');
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.toLowerCase() === 'npm_execpath') delete env[key];
      }
      env.npm_execpath = join(directory, 'missing', 'npm-cli.js');
      const { report } = reportFor(root, env);
      expect(report.checks.npm.status).toBe('failed');
      expect(report.checks.npm.reason).toContain('cannot resolve npm CLI');
      expect(report.checks.npm.value).toBeUndefined();
      expect(report.findings).toContainEqual(
        expect.objectContaining({ code: 'check-failed-npm' }),
      );
    },
  );

  test.skipIf(process.platform !== 'win32')(
    'reports a missing local Tauri CLI even when Node is available',
    () => {
      const directory = contextFixture('station-tauri-missing cli-');
      const { report } = reportFor(directory);
      expect(report.checks.node.status).toBe('checked');
      expect(report.checks.tauriCli.status).toBe('skipped');
      expect(report.checks.tauriCli.reason).toBe('command-not-found');
      expect(report.checks.tauriCli.value).toBeUndefined();
    },
  );

  test('probe tracing preserves JSON stdout and failure status while naming the failed child', () => {
    const directory = contextFixture();
    const cli = join(
      directory,
      'node_modules',
      ...(process.platform === 'win32'
        ? ['@tauri-apps', 'cli', 'tauri.js']
        : ['.bin', 'tauri']),
    );
    mkdirSync(dirname(cli), { recursive: true });
    writeFileSync(
      cli,
      `#!${process.execPath}\nprocess.stderr.write('fixture refusal\\n'); process.exit(7);\n`,
      { mode: 0o755 },
    );
    for (const trace of [false, true]) {
      const result = spawnSyncBounded(
        process.execPath,
        [
          fileURLToPath(new URL('../tauri-context.mjs', import.meta.url)),
          '--json',
          '--platform',
          'windows',
          '--root',
          directory,
          '--strict',
          ...(trace ? ['--trace-probes'] : []),
        ],
        {
          encoding: 'utf8',
          timeout: 30_000,
          windowsHide: true,
          env: { ...process.env, PATH: '' },
        },
      );
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status).toBe(2);
      const report = JSON.parse(result.stdout);
      expect(report.checks.rustTargets.status).toBe('skipped');
      expect(report.checks.rustTargets.reason).toBe('command-not-found');
      expect(report.checks.rustTargets.value).toBeUndefined();
      expect(report.checks.tauriCli.status).toBe('failed');
      expect(report.checks.tauriCli.reason).toBe('fixture refusal');
      expect(report.findings).toContainEqual(
        expect.objectContaining({ code: 'check-failed-tauri-cli' }),
      );
      if (!trace) {
        expect(result.stderr).toBe('');
        continue;
      }
      const events = result.stderr
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(events.filter((event) => event.id === 'tauri-cli')).toEqual([
        { id: 'tauri-cli', phase: 'start', elapsedMs: 0, status: 'running' },
        {
          id: 'tauri-cli',
          phase: 'end',
          elapsedMs: expect.any(Number),
          status: 'failed',
        },
      ]);
      expect(events.every((event) => event.elapsedMs >= 0)).toBe(true);
    }
  });

  test.each(['--help', '-h'])(
    '%s prints usage and exits without a report',
    (flag) => {
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('../tauri-context.mjs', import.meta.url)), flag],
        { encoding: 'utf8', timeout: 30_000, windowsHide: true },
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      // Exactly the usage text: no host report was printed.
      expect(result.stdout).toBe(TAURI_CONTEXT_USAGE);
    },
  );

  test('applies RFC 7396 configuration overlays without mutating the base', () => {
    const base = {
      app: { windows: [{ title: 'Station' }], security: { csp: 'base' } },
      bundle: { active: true, targets: 'all' },
    };
    const merged = mergeJsonPatch(base, {
      app: { security: { csp: 'mobile' } },
      bundle: { targets: null },
    });

    expect(merged).toEqual({
      app: { windows: [{ title: 'Station' }], security: { csp: 'mobile' } },
      bundle: { active: true },
    });
    expect(base.bundle.targets).toBe('all');
  });

  test('reads exact and object Cargo dependency versions', () => {
    const cargo = [
      'tauri = { version = "=2.11.5", features = [] }',
      'tauri-build = "2.6.3"',
    ].join('\n');

    expect(cargoDependencyVersion(cargo, 'tauri')).toBe('=2.11.5');
    expect(cargoDependencyVersion(cargo, 'tauri-build')).toBe('2.6.3');
    expect(exactSemver(cargoDependencyVersion(cargo, 'tauri'))).toBe('2.11.5');
  });

  test('extracts one bounded model-readable documentation topic', () => {
    const source = [
      '<SYSTEM>Guides</SYSTEM>',
      '# Debug',
      'debug body',
      '# Tests',
      'test body',
    ].join('\n');

    expect(extractDocumentationSection(source, 'Debug', 1_000)).toEqual({
      content: '# Debug\ndebug body',
      truncated: false,
    });
    expect(extractDocumentationSection(source, 'Debug', 10)).toEqual({
      content: '# Debug\nde\n\n[TRUNCATED at 10 characters]',
      truncated: true,
    });
  });

  test('fails when an upstream documentation heading disappears', () => {
    expect(() => extractDocumentationSection('# Tests\nbody', 'Debug')).toThrow(
      'Documentation heading not found: Debug',
    );
  });

  test('accepts independent patch releases and reports an offline device', () => {
    const findings = collectFindings({
      versions: { rust: { tauri: '=2.11.5' } },
      checks: {
        tauriCli: {
          id: 'tauri-cli',
          status: 'checked',
          value: 'tauri-cli 2.11.4',
        },
        rustTargets: {
          id: 'rust-targets',
          status: 'checked',
          value: [
            'aarch64-apple-ios',
            'aarch64-apple-ios-sim',
            'aarch64-linux-android',
            'armv7-linux-androideabi',
            'i686-linux-android',
            'x86_64-linux-android',
          ],
        },
        adb: {
          id: 'adb',
          status: 'checked',
          value: [
            { serial: 'pixel-live', state: 'device', details: '' },
            { serial: 'pixel-stale', state: 'offline', details: '' },
          ],
        },
      },
      generated: {
        android: { path: 'src-desktop/gen/android', dirtyPaths: [] },
        ios: { path: 'src-desktop/gen/apple', dirtyPaths: [] },
      },
    });

    expect(findings.map((finding) => finding.code)).toEqual([
      'android-device-not-ready',
    ]);
  });

  test('reports Tauri CLI and core release-line skew', () => {
    const findings = collectFindings({
      versions: { rust: { tauri: '=2.11.5' } },
      checks: {
        tauriCli: {
          id: 'tauri-cli',
          status: 'checked',
          value: 'tauri-cli 2.10.9',
        },
        rustTargets: {
          id: 'rust-targets',
          status: 'checked',
          value: [
            'aarch64-apple-ios',
            'aarch64-apple-ios-sim',
            'aarch64-linux-android',
            'armv7-linux-androideabi',
            'i686-linux-android',
            'x86_64-linux-android',
          ],
        },
        adb: { id: 'adb', status: 'checked', value: [] },
      },
      generated: {
        android: { path: 'src-desktop/gen/android', dirtyPaths: [] },
        ios: { path: 'src-desktop/gen/apple', dirtyPaths: [] },
      },
    });

    expect(findings).toEqual([
      expect.objectContaining({ code: 'tauri-cli-core-release-line-skew' }),
    ]);
  });
});
