import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
import { scaleLivenessMs } from '../lib/liveness-scale.mjs';
import { redactVerificationOutput } from '../lib/verification-redaction.mjs';
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
  const reportTimeoutMs = 60_000;
  // A caller must outlive its 60s child (or two 30s children), the 10s
  // Windows fixture compile, and assertion/cleanup overhead.
  const callerTimeoutMs = scaleLivenessMs(reportTimeoutMs + 20_000);
  function probeDiagnostics() {
    const output = join(root, '.kontourai', 'verification-output');
    mkdirSync(output, { recursive: true });
    const directory = join(output, `tauri-context-test-${randomUUID()}`);
    mkdirSync(directory);
    process.stderr.write(`Tauri context probe evidence: ${directory}\n`);
    return (phase: string, detail: object = {}) => {
      const redacted = Buffer.from(
        redactVerificationOutput(JSON.stringify(detail)),
      );
      const limit = 64 * 1024;
      writeFileSync(
        join(directory, `${phase}.json`),
        JSON.stringify({
          phase,
          at: new Date().toISOString(),
          detail: redacted.subarray(0, limit).toString('utf8'),
          truncated: redacted.length > limit,
        }),
      );
    };
  }
  function reportFor(contextRoot = root, env = process.env) {
    const diagnostic = probeDiagnostics();
    diagnostic('report-start');
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
      {
        encoding: 'utf8',
        // Above the version probes' 30s bound so a slow-but-healthy probe
        // never turns into a harness timeout of the whole report.
        timeout: reportTimeoutMs,
        windowsHide: true,
        env,
      },
    );
    diagnostic('report-return', {
      status: result.status,
      signal: result.signal,
      error: result.error?.message,
      probeTrace: result.stderr,
    });
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
        // The pid file is renamed into place, so a reader never sees it
        // half-written. The stub exits on its own after 11s, so a cleanup
        // that never ran leaks nothing for long.
        const pidFile = pidDirectory ? join(pidDirectory, tool) : undefined;
        const reportPid = pidFile
          ? `const fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(`${pidFile}.tmp`)}, process.pid + '\\n');\nfs.renameSync(${JSON.stringify(`${pidFile}.tmp`)}, ${JSON.stringify(pidFile)});\n`
          : '';
        writeFileSync(
          join(directory, tool),
          `#!${process.execPath}\n${reportPid}setTimeout(() => {}, 11000);\n`,
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

  test(
    'a report retains real npm and Tauri versions and honest failures when three independent tools stall',
    () => {
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
        expect(report.checks[key].reason, probeTrace).toBe(
          `${id} timed out after 10000ms`,
        );
        expect(report.checks[key].value).toBeUndefined();
        expect(report.findings).toContainEqual(
          expect.objectContaining({ code: `check-failed-${id}` }),
        );
      }
    },
    callerTimeoutMs,
  );

  /**
   * Only an integer pid above 1 that is not this process names one other
   * process. `process.kill(0, …)` signals this runner's whole process group,
   * and an empty pid file parses as `Number('') === 0`: an attached CI shell
   * would be killed and the failure hidden (#3623).
   */
  function isSignalablePid(pid: number): boolean {
    return Number.isInteger(pid) && pid > 1 && pid !== process.pid;
  }

  /** A pid file holds exactly one integer and a newline, or nothing usable. */
  function parsePidFile(file: string): number {
    if (!existsSync(file)) return Number.NaN;
    const text = readFileSync(file, 'utf8');
    return /^\d+\n$/.test(text) ? Number(text.trim()) : Number.NaN;
  }

  /** Wait for a stub's pid file to hold one complete, signalable pid. */
  async function readPidFile(file: string, context: () => string) {
    const deadline = Date.now() + 5_000;
    let pid = parsePidFile(file);
    while (!isSignalablePid(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      pid = parsePidFile(file);
    }
    expect(isSignalablePid(pid), `pid file ${file}: ${context()}`).toBe(true);
    return pid;
  }

  function processGroupOf(pid: number): number {
    return Number(
      execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5_000,
      }).trim(),
    );
  }

  /** Kill one stub by exact pid, never this runner or its group's leader. */
  function stopFixture(pid: number, ownGroup: number) {
    if (!isSignalablePid(pid) || pid === ownGroup) return;
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
      // Resolved before spawning: a failing `ps` must not strand the child.
      const ownGroup = processGroupOf(process.pid);
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
        for (const tool of tools) {
          pids.push(
            await readPidFile(
              join(directory, tool),
              () => `no signalable stub pid; probe trace: ${stderr}`,
            ),
          );
        }
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
          // readPidFile admitted only signalable pids; signal 0 to pid 0
          // would probe this runner's own group and never throw.
          expect(isSignalablePid(pid) && pid !== ownGroup).toBe(true);
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
        // Pids recorded before a failure, plus any whose file landed since;
        // stopFixture refuses anything that is not one other process.
        for (const tool of tools)
          pids.push(parsePidFile(join(directory, tool)));
        for (const pid of new Set(pids)) stopFixture(pid, ownGroup);
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
    callerTimeoutMs,
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
    callerTimeoutMs,
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
    callerTimeoutMs,
  );

  test(
    'probe tracing preserves JSON stdout and failure status while naming the failed child',
    () => {
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
      const diagnostic = probeDiagnostics();
      for (const trace of [false, true]) {
        diagnostic(`trace-${trace}-start`);
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
        diagnostic(`trace-${trace}-return`, {
          status: result.status,
          signal: result.signal,
          error: result.error?.message,
          probeTrace: result.stderr,
        });
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
    },
    callerTimeoutMs,
  );

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
