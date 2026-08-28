import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  executeOwnedProcess,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from '../../../../scripts/lib/owned-process.mjs';
import {
  buildOpenSshLaunchArgs,
  createSystemOpenSshLaunchRunner,
  OpenSshLaunchError,
  parseOpenSshLaunchResponse,
  SSH_LAUNCH_BOOTSTRAP_SOURCE,
  SSH_LAUNCH_PROTOCOL_VERSION,
} from '../openssh-launch-bootstrap.js';

const INPUT = {
  alias: 'brian-media',
  controlPath: '/private/control.sock',
  remoteProjectPath: '~/dev/github/kontourai/station',
  launchKey: '11111111-1111-4111-8111-111111111111',
  targetPort: 3141,
};

const HAS_NATIVE_POSIX_SH = process.platform !== 'win32';

describe('OpenSSH launch bootstrap argv/contract', () => {
  test('assembles the remote command as one POSIX-quoted string, not separate trailing args', () => {
    const args = buildOpenSshLaunchArgs(INPUT);
    expect(args.slice(0, -2)).toEqual([
      '-S',
      '/private/control.sock',
      '-T',
      '-o',
      'ForwardAgent=no',
      '-o',
      'ForwardX11=no',
      '-o',
      'PermitLocalCommand=no',
      '-o',
      'RemoteCommand=none',
      '--',
    ]);
    expect(args.at(-2)).toBe('brian-media');
    const command = args.at(-1) as string;
    expect(command).toBe(
      "sh -s -- '1' '~/dev/github/kontourai/station' '3141' '11111111-1111-4111-8111-111111111111'",
    );
  });

  test('POSIX-quotes a remoteProjectPath containing a single quote without breaking the command', async () => {
    const args = buildOpenSshLaunchArgs({
      ...INPUT,
      remoteProjectPath: "/srv/obrien-box's-checkout",
    });
    const command = args.at(-1) as string;
    // The command string itself is the portable SSH contract. Windows hosts
    // may use OpenSSH, but do not provide the remote POSIX `sh` this command
    // targets, so only execute the local shell proof where it exists.
    expect(command).toBe(
      "sh -s -- '1' '/srv/obrien-box'\\''s-checkout' '3141' '11111111-1111-4111-8111-111111111111'",
    );
    if (!HAS_NATIVE_POSIX_SH) return;
    const echoed = await new Promise<string>((resolve, reject) => {
      const child = spawn('sh', ['-c', command.replace(/^sh -s --/, 'echo')]);
      let out = '';
      child.stdout.on('data', (chunk) => {
        out += chunk.toString();
      });
      child.once('close', () => resolve(out.trim()));
      child.once('error', reject);
    });
    expect(echoed.split(' ')[1]).toBe("/srv/obrien-box's-checkout");
  });

  test('rejects a launch key that is not the profile id shape', () => {
    expect(() =>
      buildOpenSshLaunchArgs({ ...INPUT, launchKey: 'not-a-uuid' }),
    ).toThrow('SSH launch key is invalid');
  });

  test('parses the single-JSON-line success contract', () => {
    const result = parseOpenSshLaunchResponse({
      stdout:
        '{"protocolVersion":1,"remotePort":51234,"serverKind":"managed"}\n',
      stderr: '',
      exitCode: 0,
    });
    expect(result).toEqual({ remotePort: 51234, serverKind: 'managed' });
  });

  test('tolerates leading non-contract stdout chatter such as a PAM motd on a non-interactive session', () => {
    const chatter =
      'Welcome to Ubuntu 24.04 LTS\nSystem information as of Tue Jul 28';
    const result = parseOpenSshLaunchResponse({
      stdout: `${chatter}\n{"protocolVersion":1,"remotePort":51234,"serverKind":"managed"}\n`,
      stderr: '',
      exitCode: 0,
    });
    expect(result).toEqual({ remotePort: 51234, serverKind: 'managed' });
  });

  test('rejects stdout with no line that validates as the contract', () => {
    expect(() =>
      parseOpenSshLaunchResponse({
        stdout: 'not json at all\nnor is this',
        stderr: '',
        exitCode: 0,
      }),
    ).toThrow(OpenSshLaunchError);
    try {
      parseOpenSshLaunchResponse({
        stdout: 'not json at all',
        stderr: '',
        exitCode: 0,
      });
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(OpenSshLaunchError);
      expect((error as OpenSshLaunchError).reason).toBe('protocol-violation');
    }
  });

  test('rejects an out-of-range port or unrecognized serverKind', () => {
    expect(() =>
      parseOpenSshLaunchResponse({
        stdout: JSON.stringify({
          protocolVersion: SSH_LAUNCH_PROTOCOL_VERSION,
          remotePort: 70_000,
          serverKind: 'managed',
        }),
        stderr: '',
        exitCode: 0,
      }),
    ).toThrow(OpenSshLaunchError);
    expect(() =>
      parseOpenSshLaunchResponse({
        stdout: JSON.stringify({
          protocolVersion: SSH_LAUNCH_PROTOCOL_VERSION,
          remotePort: 1234,
          serverKind: 'adopted',
        }),
        stderr: '',
        exitCode: 0,
      }),
    ).toThrow(OpenSshLaunchError);
  });

  test('classifies a structured failure into a closed reason and keeps the safe detail', () => {
    try {
      parseOpenSshLaunchResponse({
        stdout: '',
        stderr: JSON.stringify({
          error: 'unsupported-node-version',
          detail: 'v18.19.0',
        }),
        exitCode: 1,
      });
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(OpenSshLaunchError);
      expect((error as OpenSshLaunchError).reason).toBe(
        'unsupported-node-version',
      );
      expect((error as OpenSshLaunchError).message).toContain('v18.19.0');
    }
  });

  test('classifies a port-conflict failure and keeps the station-generated message', () => {
    // Bounded to <=200 chars, matching the cut -c1-200 truncation the real
    // script applies before ever handing this to fail().
    const message =
      'ports overlap another live Station instance. Requested: 51234 server 51235 terminal - brian-media-dogfood reserves 3141 server 3142 terminal 3143 voice 3000 ui';
    try {
      parseOpenSshLaunchResponse({
        stdout: '',
        stderr: JSON.stringify({ error: 'port-conflict', detail: message }),
        exitCode: 1,
      });
      throw new Error('expected to throw');
    } catch (error) {
      const launchError = error as OpenSshLaunchError;
      expect(launchError.reason).toBe('port-conflict');
      expect(launchError.message).toContain('brian-media-dogfood');
    }
  });

  test('never surfaces raw or unstructured remote stderr as the error reason or message', () => {
    try {
      parseOpenSshLaunchResponse({
        stdout: '',
        stderr:
          'Permission denied publickey some secret path AWS_SECRET=abc123',
        exitCode: 255,
      });
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(OpenSshLaunchError);
      const launchError = error as OpenSshLaunchError;
      expect(launchError.reason).toBe('launch-failed');
      expect(launchError.message).not.toContain('AWS_SECRET');
      expect(launchError.message).not.toContain('publickey');
    }
  });

  test('drops a detail token that contains control characters', () => {
    const controlBearing = `v18 ${String.fromCharCode(10)}DROP TABLE secrets;`;
    try {
      parseOpenSshLaunchResponse({
        stdout: '',
        stderr: JSON.stringify({
          error: 'unsupported-node-version',
          detail: controlBearing,
        }),
        exitCode: 1,
      });
      throw new Error('expected to throw');
    } catch (error) {
      const launchError = error as OpenSshLaunchError;
      expect(launchError.reason).toBe('unsupported-node-version');
      expect(launchError.message).not.toContain('DROP TABLE');
    }
  });

  test('streams the bootstrap script over stdin and forwards it through a runner', async () => {
    const runProcess = vi.fn(async ({ args, stdin }) => {
      expect(args).toEqual(buildOpenSshLaunchArgs(INPUT));
      expect(stdin).toContain('find_node');
      expect(stdin).toContain('ssh-launch');
      return {
        stdout:
          '{"protocolVersion":1,"remotePort":3141,"serverKind":"external"}',
        stderr: '',
        exitCode: 0,
      };
    });
    const run = createSystemOpenSshLaunchRunner(runProcess);
    await expect(run(INPUT)).resolves.toEqual({
      remotePort: 3141,
      serverKind: 'external',
    });
    expect(runProcess).toHaveBeenCalledOnce();
  });
});

// The remaining suite runs the ACTUAL bootstrap script (the same source
// streamed over SSH stdin in production) through a real local shell,
// bypassing SSH's network transport but not its argument-handling model: a
// fake runProcess takes the single already-quoted command string
// buildOpenSshLaunchArgs produces and runs it via `sh -c "<command>"`,
// piping in the exact SSH_LAUNCH_BOOTSTRAP_SOURCE as stdin, precisely
// mirroring what a real sshd hands to the remote login shell. This is what
// makes the adversarial-input tests below a genuine proof of the injection
// fix rather than a reconstruction that could drift from the real contract.
const dirs: string[] = [];
const ownedFixtureExecutions: Array<ReturnType<typeof executeOwnedProcess>> =
  [];

type FixtureCleanupError = {
  message: string;
  signal?: string;
  name?: string;
  code?: string;
};

type FixtureCleanupResult = {
  settled: boolean;
  escalated: boolean;
  errors: FixtureCleanupError[];
};

type FixtureTerminator = (
  execution: ReturnType<typeof executeOwnedProcess>,
  options: {
    processLabel: string;
    waitForSuiteSettlement: typeof waitForSuiteSettlement;
    terminationGraceMs: number;
    terminationForceMs: number;
  },
) => Promise<FixtureCleanupResult>;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function teardownFixtureExecutions(
  executions: Array<ReturnType<typeof executeOwnedProcess>>,
  terminate: FixtureTerminator = terminateSuiteExecution as FixtureTerminator,
) {
  for (const execution of executions.splice(0).reverse()) {
    const cleanup = await terminate(execution, {
      processLabel: 'OpenSSH bootstrap fixture',
      waitForSuiteSettlement,
      terminationGraceMs: 1_000,
      terminationForceMs: 1_000,
    });
    if (!cleanup.settled || cleanup.errors?.length) {
      throw new Error(
        'OpenSSH bootstrap fixture process group survived teardown',
      );
    }
  }
}

afterEach(async () => {
  await teardownFixtureExecutions(ownedFixtureExecutions);
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface LocalRig {
  home: string;
  binDir: string;
  projectDir: string;
  stationMarker: string;
  writeStationFixture: (script: string) => void;
  writeRealNodeShim: () => void;
  markBuilt: () => void;
  markBuiltAs: (instanceId: string) => void;
}

function createRig(): LocalRig {
  const home = tempDir('station-launch-home-');
  const binDir = tempDir('station-launch-bin-');
  const projectDir = tempDir('station-launch-project-');
  const stationMarker = join(projectDir, 'station.invocations');
  return {
    home,
    binDir,
    projectDir,
    stationMarker,
    writeStationFixture(script: string) {
      const path = join(projectDir, 'station');
      writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
      chmodSync(path, 0o755);
    },
    writeRealNodeShim() {
      // Delegates to the real system node (this test process's own
      // interpreter, which the repo already pins to the required major) so
      // the cascade's first (bare PATH) branch succeeds exactly like a
      // correctly configured dogfood host.
      const path = join(binDir, 'node');
      writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, {
        mode: 0o755,
      });
      chmodSync(path, 0o755);
    },
    markBuilt() {
      // archive#1133 live-verification finding: a managed launch must
      // never trigger station's own build. The bootstrap checks for a
      // build under SOME instance name (mirroring lifecycle.ts's
      // isInstalled/resolveBuildPaths, which namespace build directories
      // per instance) before ever attempting to start. This is the bare
      // 'default'-instance layout a source checkout typically has.
      mkdirSync(join(projectDir, 'dist-server'), { recursive: true });
      mkdirSync(join(projectDir, 'dist-ui'), { recursive: true });
    },
    markBuiltAs(instanceId: string) {
      // The portable/release install layout: a real deployment (e.g. a
      // systemd-managed dogfood host) is very often built under a NAMED
      // instance, not 'default' — archive#1133 live verification found the
      // pre-flight check refusing this exact, fully-built, runnable layout.
      mkdirSync(join(projectDir, `dist-server-${instanceId}`), {
        recursive: true,
      });
      mkdirSync(join(projectDir, `dist-ui-${instanceId}`), {
        recursive: true,
      });
    },
  };
}

/** A minimal "station" stand-in that starts a real tiny HTTP server on the
 * requested --port, answering the same /.well-known/station/v1 and
 * /api/system/identity shape the hardened readiness check requires, then
 * returns immediately (mirrors station start's own detach-and-return
 * behavior). Every invocation is recorded to markerFile so tests can
 * assert whether a second process was started. */
function fakeStationStartScript(markerFile: string): string {
  const lines = [
    `marker="${markerFile}"`,
    'port=""',
    'instance=""',
    'for arg in "$@"; do',
    '  case "$arg" in',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal POSIX shell parameter expansion in a fixture script, not a JS template.
    '    --port=*) port="${arg#--port=}" ;;',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal POSIX shell parameter expansion in a fixture script, not a JS template.
    '    --instance=*) instance="${arg#--instance=}" ;;',
    '  esac',
    'done',
    'echo "$$ $port $instance" >> "$marker"',
    "node -e '",
    'const http = require("node:http");',
    'const port = Number(process.argv[1]);',
    'const server = http.createServer((req, res) => {',
    '  if (req.url === "/.well-known/station/v1") {',
    '    res.writeHead(200, { "content-type": "application/json" });',
    '    res.end(JSON.stringify({ environmentId: "fixture" }));',
    '    return;',
    '  }',
    '  if (req.url === "/api/system/identity") {',
    '    res.writeHead(200, { "content-type": "application/json" });',
    '    res.end(JSON.stringify({ instanceId: "fixture", sha: "a".repeat(40), bootId: "boot-fixture" }));',
    '    return;',
    '  }',
    '  res.writeHead(404);',
    '  res.end();',
    '});',
    'server.listen(port, "127.0.0.1");',
    '\' "$port" >/dev/null 2>&1 &',
    'exit 0',
  ];
  return lines.join('\n');
}

function identityFixtureServerScript(port: number): string {
  const lines = [
    "const http = require('node:http');",
    'const server = http.createServer((req, res) => {',
    "  if (req.url === '/.well-known/station/v1') {",
    "    res.writeHead(200, { 'content-type': 'application/json' });",
    "    res.end(JSON.stringify({ environmentId: 'external-fixture' }));",
    '    return;',
    '  }',
    "  if (req.url === '/api/system/identity') {",
    "    res.writeHead(200, { 'content-type': 'application/json' });",
    "    res.end(JSON.stringify({ instanceId: 'external-fixture', sha: 'b'.repeat(40), bootId: 'boot-external' }));",
    '    return;',
    '  }',
    '  res.writeHead(404);',
    '  res.end();',
    '});',
    `server.listen(${port}, '127.0.0.1', () => {`,
    "  process.stdout.write('ready');",
    '});',
  ];
  return lines.join('\n');
}

function runScriptLocally(rig: LocalRig, extraEnv: NodeJS.ProcessEnv = {}) {
  return async (input: {
    args: readonly string[];
    stdin: string;
    timeoutMs: number;
  }): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    // The single already-quoted trailing command string is exactly what a
    // real sshd hands to `$SHELL -c` on the remote end.
    const commandString = input.args.at(-1) ?? '';
    const execution = executeOwnedProcess(
      'sh',
      ['-c', commandString],
      spawn,
      'OpenSSH bootstrap local shell',
      {
        // A real sshd session's cwd is the login shell's home directory —
        // matched here so a would-be-injected relative-path command (or
        // this script's own `cd "$PROJECT_DIR"`) behaves like the real
        // remote execution model, not like whatever directory happens to
        // be the test runner's own cwd.
        cwd: rig.home,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: `${rig.binDir}:${process.env.PATH ?? ''}`,
          HOME: rig.home,
          ...extraEnv,
        },
      },
    );
    ownedFixtureExecutions.push(execution);
    let stdout = '';
    let stderr = '';
    execution.child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    execution.child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    execution.child.stdin?.end(input.stdin);
    const result = await execution.completion;
    return { stdout, stderr, exitCode: result.status ?? 1 };
  };
}

function assertManagedLaunchGroupIsRegistered(rig: LocalRig): void {
  // `runScriptLocally` owns the SSH-shell process group before the bootstrap
  // starts Station.  Its background descendant stays in that exact group, so
  // afterEach can terminate and verify the group without PID reuse or a
  // process-name pattern. The marker remains a behavioral assertion only.
  expect(existsSync(rig.stationMarker)).toBe(true);
}

async function reserveFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

describe('OpenSSH launch bootstrap fixture cleanup', () => {
  test('fixture teardown fails closed when an exact owned process group survives', async () => {
    const execution = {
      completion: Promise.resolve({ status: 0 }),
      isAlive: () => true,
    } as unknown as ReturnType<typeof executeOwnedProcess>;
    await expect(
      teardownFixtureExecutions([execution], async () => ({
        settled: false,
        escalated: true,
        errors: [],
      })),
    ).rejects.toThrow('process group survived teardown');
  });

  test('fixture teardown fails closed when a settled cleanup reports errors', async () => {
    const execution = {
      completion: Promise.resolve({ status: 0 }),
      isAlive: () => false,
    } as unknown as ReturnType<typeof executeOwnedProcess>;
    await expect(
      teardownFixtureExecutions([execution], async () => ({
        settled: true,
        escalated: false,
        errors: [{ message: 'taskkill dispatch failed' }],
      })),
    ).rejects.toThrow('process group survived teardown');
  });
});

// This suite executes the remote POSIX bootstrap through a real local `sh`.
// Windows validates the portable argv/protocol tests above; it cannot truthfully
// execute this remote-shell proof because it has no native POSIX shell.
describe.skipIf(!HAS_NATIVE_POSIX_SH)(
  'OpenSSH launch bootstrap script (real local sh, no SSH)',
  () => {
    test('AC1: nothing running - starts Station fresh and reports managed', async () => {
      const rig = createRig();
      rig.writeRealNodeShim();
      rig.markBuilt();
      rig.writeStationFixture(fakeStationStartScript(rig.stationMarker));
      const targetPort = await reserveFreePort();

      const run = createSystemOpenSshLaunchRunner(runScriptLocally(rig));
      const result = await run({
        ...INPUT,
        remoteProjectPath: rig.projectDir,
        targetPort,
      });
      assertManagedLaunchGroupIsRegistered(rig);
      expect(result.serverKind).toBe('managed');
      expect(result.remotePort).toBeGreaterThan(0);
      expect(result.remotePort).not.toBe(targetPort);
    }, 20_000);

    // archive#1133 live-verification finding: build directories are
    // instance-scoped, and a real portable/release deployment's already-built
    // instance is frequently a NAMED one (e.g. a systemd-managed dogfood
    // host), not the bare 'default' a source checkout typically has. Both
    // layouts are the whole matrix here — this pairs with AC1 above (source
    // checkout / bare 'default') to cover the release/portable layout too.
    test('release/portable layout built under a NAMED operator instance is correctly detected as runnable, not requires-build', async () => {
      const rig = createRig();
      rig.writeRealNodeShim();
      rig.markBuiltAs('brian-media-dogfood');
      rig.writeStationFixture(fakeStationStartScript(rig.stationMarker));
      const targetPort = await reserveFreePort();

      const run = createSystemOpenSshLaunchRunner(runScriptLocally(rig));
      const result = await run({
        ...INPUT,
        remoteProjectPath: rig.projectDir,
        targetPort,
      });
      assertManagedLaunchGroupIsRegistered(rig);

      expect(result.serverKind).toBe('managed');
    }, 20_000);

    // archive#1133 live-verification finding (BLOCKER, round 3): an earlier
    // revision discovered an already-built operator instance and ran
    // `station start` directly UNDER THAT DISCOVERED NAME — starting/adopting
    // the host's systemd-managed dogfood instance out from under its own
    // service manager, breaking this feature's own "never adopt or kill a
    // process it did not start" promise. A managed launch must always run
    // under a dedicated, feature-owned instance name, deriving (never
    // adopting) the build layout from whatever instance discovery finds.
    test('a managed launch always runs under its own feature-owned instance, never a discovered operator instance name', async () => {
      const rig = createRig();
      rig.writeRealNodeShim();
      rig.markBuiltAs('brian-media-dogfood');
      rig.writeStationFixture(fakeStationStartScript(rig.stationMarker));
      const targetPort = await reserveFreePort();

      const run = createSystemOpenSshLaunchRunner(runScriptLocally(rig));
      await run({ ...INPUT, remoteProjectPath: rig.projectDir, targetPort });
      assertManagedLaunchGroupIsRegistered(rig);

      const [, , invokedInstance] = readFileSync(rig.stationMarker, 'utf8')
        .trim()
        .split(' ');
      expect(invokedInstance).toBe(`ssh-launch-${INPUT.launchKey}`);
      expect(invokedInstance).not.toBe('brian-media-dogfood');

      // The build was DERIVED (a symlink to the discovered operator build),
      // not copied and not a fresh build — proving the discovered bytes were
      // reused without ever running under that build's own instance identity.
      const ownServerBuild = join(
        rig.projectDir,
        `dist-server-ssh-launch-${INPUT.launchKey}`,
      );
      const ownUiBuild = join(
        rig.projectDir,
        `dist-ui-ssh-launch-${INPUT.launchKey}`,
      );
      expect(lstatSync(ownServerBuild).isSymbolicLink()).toBe(true);
      expect(readlinkSync(ownServerBuild)).toContain(
        'dist-server-brian-media-dogfood',
      );
      expect(lstatSync(ownUiBuild).isSymbolicLink()).toBe(true);
      expect(readlinkSync(ownUiBuild)).toContain('dist-ui-brian-media-dogfood');
    }, 20_000);

    test('a managed launch derives its own build from a bare default build too, still under its own instance name', async () => {
      const rig = createRig();
      rig.writeRealNodeShim();
      rig.markBuilt();
      rig.writeStationFixture(fakeStationStartScript(rig.stationMarker));
      const targetPort = await reserveFreePort();

      const run = createSystemOpenSshLaunchRunner(runScriptLocally(rig));
      await run({ ...INPUT, remoteProjectPath: rig.projectDir, targetPort });
      assertManagedLaunchGroupIsRegistered(rig);

      const [, , invokedInstance] = readFileSync(rig.stationMarker, 'utf8')
        .trim()
        .split(' ');
      expect(invokedInstance).toBe(`ssh-launch-${INPUT.launchKey}`);
      expect(invokedInstance).not.toBe('default');
    }, 20_000);

    test('AC2: an unmanaged Station already answers on the target port - attaches without starting one', async () => {
      const rig = createRig();
      rig.writeRealNodeShim();
      rig.markBuilt();
      rig.writeStationFixture(fakeStationStartScript(rig.stationMarker));
      const externalPort = await reserveFreePort();

      const external = spawn(
        process.execPath,
        ['-e', identityFixtureServerScript(externalPort)],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      try {
        await new Promise<void>((resolve) => {
          external.stdout.once('data', () => resolve());
        });

        const run = createSystemOpenSshLaunchRunner(runScriptLocally(rig));
        const result = await run({
          ...INPUT,
          remoteProjectPath: rig.projectDir,
          targetPort: externalPort,
        });
        expect(result).toEqual({
          remotePort: externalPort,
          serverKind: 'external',
        });
      } finally {
        external.kill('SIGKILL');
      }
      expect(existsSync(rig.stationMarker)).toBe(false);
    }, 20_000);

    test('AC2b: a non-Station service answering 200 on the target port is never mistaken for external', async () => {
      const rig = createRig();
      rig.writeRealNodeShim();
      rig.markBuilt();
      rig.writeStationFixture(fakeStationStartScript(rig.stationMarker));
      const decoyPort = await reserveFreePort();

      const decoy = spawn(
        process.execPath,
        [
          '-e',
          [
            "const http = require('node:http');",
            'const server = http.createServer((req, res) => {',
            "  res.writeHead(200, { 'content-type': 'application/json' });",
            "  res.end('{}');",
            '});',
            `server.listen(${decoyPort}, '127.0.0.1', () => process.stdout.write('ready'));`,
          ].join('\n'),
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      try {
        await new Promise<void>((resolve) => {
          decoy.stdout.once('data', () => resolve());
        });

        const run = createSystemOpenSshLaunchRunner(runScriptLocally(rig));
        const result = await run({
          ...INPUT,
          remoteProjectPath: rig.projectDir,
          targetPort: decoyPort,
        });
        assertManagedLaunchGroupIsRegistered(rig);
        expect(result.serverKind).toBe('managed');
        expect(result.remotePort).not.toBe(decoyPort);
      } finally {
        decoy.kill('SIGKILL');
      }
    }, 20_000);

    test('AC3: a second connect reuses the running managed instance, no new process', async () => {
      const rig = createRig();
      rig.writeRealNodeShim();
      rig.markBuilt();
      rig.writeStationFixture(fakeStationStartScript(rig.stationMarker));
      const targetPort = await reserveFreePort();

      const run = createSystemOpenSshLaunchRunner(runScriptLocally(rig));
      const first = await run({
        ...INPUT,
        remoteProjectPath: rig.projectDir,
        targetPort,
      });
      assertManagedLaunchGroupIsRegistered(rig);
      expect(first.serverKind).toBe('managed');
      expect(
        readFileSync(rig.stationMarker, 'utf8').trim().split('\n'),
      ).toHaveLength(1);

      const second = await run({
        ...INPUT,
        remoteProjectPath: rig.projectDir,
        targetPort,
      });
      expect(second).toEqual(first);
      expect(
        readFileSync(rig.stationMarker, 'utf8').trim().split('\n'),
      ).toHaveLength(1);
    }, 20_000);

    test('AC3b: two concurrent connects for the same launch key coalesce through the lock', async () => {
      const rig = createRig();
      rig.writeRealNodeShim();
      rig.markBuilt();
      rig.writeStationFixture(fakeStationStartScript(rig.stationMarker));
      const targetPort = await reserveFreePort();

      const run = createSystemOpenSshLaunchRunner(runScriptLocally(rig));
      const [first, second] = await Promise.all([
        run({ ...INPUT, remoteProjectPath: rig.projectDir, targetPort }),
        run({ ...INPUT, remoteProjectPath: rig.projectDir, targetPort }),
      ]);
      assertManagedLaunchGroupIsRegistered(rig);

      expect(first.serverKind).toBe('managed');
      expect(second).toEqual(first);
      expect(
        readFileSync(rig.stationMarker, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean),
      ).toHaveLength(1);
    }, 30_000);

    test('AC5: node-not-found is typed when no compatible node exists anywhere in the cascade', async () => {
      const rig = createRig();
      rig.markBuilt();
      rig.writeStationFixture(fakeStationStartScript(rig.stationMarker));

      const run = createSystemOpenSshLaunchRunner(
        runScriptLocally(rig, { PATH: `/usr/bin:/bin:${rig.binDir}` }),
      );
      await expect(
        run({
          ...INPUT,
          remoteProjectPath: rig.projectDir,
          targetPort: await reserveFreePort(),
        }),
      ).rejects.toMatchObject({ reason: 'node-not-found' });
    }, 20_000);

    test('AC5: unsupported-node-version is typed and carries the observed version, not raw stderr', async () => {
      const rig = createRig();
      writeFileSync(join(rig.binDir, 'node'), '#!/bin/sh\necho v18.19.0\n', {
        mode: 0o755,
      });
      chmodSync(join(rig.binDir, 'node'), 0o755);
      rig.markBuilt();
      rig.writeStationFixture(fakeStationStartScript(rig.stationMarker));

      const run = createSystemOpenSshLaunchRunner(runScriptLocally(rig));
      try {
        await run({
          ...INPUT,
          remoteProjectPath: rig.projectDir,
          targetPort: await reserveFreePort(),
        });
        throw new Error('expected to reject');
      } catch (error) {
        expect((error as OpenSshLaunchError).reason).toBe(
          'unsupported-node-version',
        );
        expect((error as OpenSshLaunchError).message).toContain('v18.19.0');
      }
    }, 20_000);

    test('AC5: readiness-timeout is typed when the started process never answers', async () => {
      const rig = createRig();
      rig.writeRealNodeShim();
      rig.markBuilt();
      rig.writeStationFixture(`echo "$$" >> "${rig.stationMarker}"\nexit 0`);

      const run = createSystemOpenSshLaunchRunner(
        runScriptLocally(rig, { STATION_SSH_LAUNCH_READY_TIMEOUT_S: '2' }),
      );
      await expect(
        run({
          ...INPUT,
          remoteProjectPath: rig.projectDir,
          targetPort: await reserveFreePort(),
        }),
      ).rejects.toMatchObject({ reason: 'readiness-timeout' });
    }, 20_000);

    test('AC5: requires-build is typed for an unbuilt checkout, and never triggers a build', async () => {
      const rig = createRig();
      rig.writeRealNodeShim();
      rig.writeStationFixture(fakeStationStartScript(rig.stationMarker));

      const run = createSystemOpenSshLaunchRunner(runScriptLocally(rig));
      await expect(
        run({
          ...INPUT,
          remoteProjectPath: rig.projectDir,
          targetPort: await reserveFreePort(),
        }),
      ).rejects.toMatchObject({ reason: 'requires-build' });
      expect(existsSync(rig.stationMarker)).toBe(false);
    }, 20_000);

    test('AC5: port-conflict is typed and carries station start own bounded message', async () => {
      const rig = createRig();
      rig.writeRealNodeShim();
      rig.markBuilt();
      const conflictLines = [
        `echo "$$" >> "${rig.stationMarker}"`,
        "echo 'Error: start is blocked because the requested ports overlap another live Station instance.'",
        "echo '  - brian-media-dogfood reserves 3141 server 3142 terminal 3143 voice 3000 ui'",
        'exit 1',
      ];
      rig.writeStationFixture(conflictLines.join('\n'));

      const run = createSystemOpenSshLaunchRunner(runScriptLocally(rig));
      try {
        await run({
          ...INPUT,
          remoteProjectPath: rig.projectDir,
          targetPort: await reserveFreePort(),
        });
        throw new Error('expected to reject');
      } catch (error) {
        const launchError = error as OpenSshLaunchError;
        expect(launchError.reason).toBe('port-conflict');
        expect(launchError.message).toContain('brian-media-dogfood');
      }
    }, 20_000);

    test('project-unavailable when the remote project path does not exist', async () => {
      const rig = createRig();
      rig.writeRealNodeShim();

      const run = createSystemOpenSshLaunchRunner(runScriptLocally(rig));
      await expect(
        run({
          ...INPUT,
          remoteProjectPath: join(rig.projectDir, 'does-not-exist'),
          targetPort: await reserveFreePort(),
        }),
      ).rejects.toMatchObject({ reason: 'project-unavailable' });
    }, 20_000);

    test('protocol-violation when the protocol version positional does not match', async () => {
      const rig = createRig();
      const baseArgs = buildOpenSshLaunchArgs({
        ...INPUT,
        remoteProjectPath: rig.projectDir,
      });
      const command = (baseArgs.at(-1) as string).replace("-- '1' ", "-- '2' ");
      const forcedArgs = [...baseArgs.slice(0, -1), command];
      const runner = runScriptLocally(rig);
      const result = await runner({
        args: forcedArgs,
        stdin: SSH_LAUNCH_BOOTSTRAP_SOURCE,
        timeoutMs: 5000,
      });
      expect(result.exitCode).not.toBe(0);
      expect(JSON.parse(result.stderr)).toMatchObject({
        error: 'protocol-violation',
      });
    }, 20_000);

    // archive#1133 live security review: an earlier version of this bootstrap
    // passed remoteProjectPath as one of several separate trailing ssh
    // command arguments; ssh space-joins those into ONE string handed to the
    // remote login shell via $SHELL -c, so any shell metacharacter in the
    // path executed on the remote host on every connect. These prove the
    // fix through the exact same runScriptLocally harness used above, which
    // runs `sh -c "<the one already-quoted command>"`, faithfully
    // reproducing what a real sshd does.
    describe('injection defense (station#1133 live-verified RCE fix)', () => {
      const payloadBuilders: Array<[string, (markerPath: string) => string]> = [
        [
          'semicolon-chained command',
          (marker) => `/tmp/legit; touch ${marker}`,
        ],
        [
          'backtick command substitution',
          (marker) => `/tmp/legit\`touch ${marker}\``,
        ],
        [
          'dollar-paren command substitution',
          (marker) => `/tmp/legit$(touch ${marker})`,
        ],
        [
          'pipe to a second command',
          (marker) => `/tmp/legit | touch ${marker}`,
        ],
      ];

      test('an embedded newline is rejected client-side before ssh is ever invoked', () => {
        // A newline is already a control character rejected by the existing
        // safeRemoteProjectPathArg validation, independent of the quoting fix
        // — an even stronger defense (nothing is sent to the remote at all)
        // than the shell-level proofs below. Confirms that path specifically
        // rather than assuming coverage from the other payloads.
        expect(() =>
          buildOpenSshLaunchArgs({
            ...INPUT,
            remoteProjectPath: `/tmp/legit${String.fromCharCode(10)}touch INJECTED`,
          }),
        ).toThrow('Remote project path is invalid');
      });

      test.each(payloadBuilders)(
        '%s never executes on the remote shell',
        async (_name, buildPayload) => {
          const rig = createRig();
          rig.writeRealNodeShim();
          // An absolute path, independent of whatever the shell's cwd happens
          // to be at the point of execution — a strictly stronger check than
          // relying on a relative marker landing in a directory this test
          // merely expects to be the cwd.
          const markerPath = join(rig.home, 'INJECTED');

          const args = buildOpenSshLaunchArgs({
            ...INPUT,
            remoteProjectPath: buildPayload(markerPath),
            targetPort: await reserveFreePort(),
          });
          const runner = runScriptLocally(rig);
          await runner({
            args,
            stdin: SSH_LAUNCH_BOOTSTRAP_SOURCE,
            timeoutMs: 10_000,
          });

          expect(existsSync(markerPath)).toBe(false);
        },
      );

      test('a legitimate path containing a space now works correctly end to end, not just fails safely', async () => {
        const rig = createRig();
        rig.writeRealNodeShim();
        const spacedRoot = tempDir('station-launch-spaced-');
        const spacedProjectDir = join(spacedRoot, 'My Station Checkout');
        mkdirSync(spacedProjectDir, { recursive: true });
        mkdirSync(join(spacedProjectDir, 'dist-server'), { recursive: true });
        mkdirSync(join(spacedProjectDir, 'dist-ui'), { recursive: true });
        const stationMarker = join(spacedProjectDir, 'station.invocations');
        writeFileSync(
          join(spacedProjectDir, 'station'),
          `#!/bin/sh\n${fakeStationStartScript(stationMarker)}\n`,
          { mode: 0o755 },
        );
        chmodSync(join(spacedProjectDir, 'station'), 0o755);

        const run = createSystemOpenSshLaunchRunner(runScriptLocally(rig));
        const result = await run({
          ...INPUT,
          remoteProjectPath: spacedProjectDir,
          targetPort: await reserveFreePort(),
        });
        const cleanupRig: LocalRig = { ...rig, stationMarker };
        assertManagedLaunchGroupIsRegistered(cleanupRig);
        expect(result.serverKind).toBe('managed');
      }, 20_000);
    });
  },
);
