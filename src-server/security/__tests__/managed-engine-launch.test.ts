/**
 * #4520: a managed policy's pinned launch fields reach the engine child on
 * every engine family's real spawn path. Each test pins `binaryPath` to a
 * script that records the arguments and environment it was started with,
 * so an assertion reads what the child actually received.
 */
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import {
  parseManagedPolicyDocument,
  summarizeManagedPolicy,
} from '@kontourai/station-contracts/managed-policy';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { createClaudeEngineProcess } from '../../providers/adapters/claude-code-spawn.js';
import { spawnCodexProcess } from '../../providers/adapters/codex-adapter-transport.js';
import {
  createMuseProcess,
  createMuseServeHost,
} from '../../providers/adapters/muse-adapter.js';
import { ACPProcess } from '../../services/acp/acp-process.js';
import { connectionSpawnEnv } from '../../services/connections/connection-env.js';
import { engineProxyLaunch } from '../../services/connections/engine-proxy-routing.js';
import {
  installManagedEngineLimits,
  managedEngineLaunch,
} from '../managed-engine-limits.js';

const makeTempDir = trackTempDirs();

afterEach(() => installManagedEngineLimits(null));

function install(engines: unknown) {
  const parsed = parseManagedPolicyDocument({
    schemaVersion: 1,
    organization: 'Acme',
    limits: { engines },
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
  installManagedEngineLimits({
    document: parsed.document,
    summary: summarizeManagedPolicy(parsed.document),
  });
}

/** An executable that writes `{ argv, env }` beside itself, then exits 0. */
function recordingEngine(): { binary: string; read: () => Recorded } {
  const dir = makeTempDir('station-managed-engine-');
  const binary = join(dir, 'engine');
  const out = join(dir, 'launch.json');
  writeFileSync(
    binary,
    `#!${process.execPath}\n` +
      `require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));\n`,
    { mode: 0o755 },
  );
  return {
    binary,
    read: () => JSON.parse(readFileSync(out, 'utf8')) as Recorded,
  };
}

interface Recorded {
  argv: string[];
  env: Record<string, string>;
}

function exited(child: {
  once: (event: 'exit', listener: () => void) => unknown;
  exitCode: number | null;
}): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

describe('pinned launch fields reach the engine child', () => {
  test('Codex: the pinned binary, arguments after app-server, and environment', async () => {
    const engine = recordingEngine();
    install({
      instances: {
        codex: {
          locked: true,
          binaryPath: engine.binary,
          launchArgs: ['-c', 'model_provider="acme"'],
          environment: { OPENAI_BASE_URL: 'https://gw.example.com/v1' },
        },
      },
    });
    const child = spawnCodexProcess(
      { OPENAI_BASE_URL: 'https://user.example.com' },
      ['-c', 'mcp_servers.x.command="y"'],
    );
    await exited(child);
    const recorded = engine.read();
    expect(recorded.argv).toEqual([
      'app-server',
      '-c',
      'mcp_servers.x.command="y"',
      '-c',
      'model_provider="acme"',
    ]);
    // Locked: the pinned value wins over the connection's own.
    expect(recorded.env.OPENAI_BASE_URL).toBe('https://gw.example.com/v1');
  });

  test('Muse: muse exec and muse serve both run the pinned launch', async () => {
    const engine = recordingEngine();
    install({
      instances: {
        muse: {
          locked: false,
          binaryPath: engine.binary,
          launchArgs: ['--profile', 'acme'],
          environment: { MUSE_GATEWAY: 'https://gw.example.com' },
        },
      },
    });
    const exec = createMuseProcess(['exec', '--json', 'hello']);
    await exited(exec.process as never);
    exec.release?.();
    let recorded = engine.read();
    expect(recorded.argv).toEqual([
      'exec',
      '--json',
      'hello',
      '--profile',
      'acme',
    ]);
    expect(recorded.env.MUSE_GATEWAY).toBe('https://gw.example.com');

    const serve = createMuseServeHost({ disableSandbox: false });
    await exited(serve.process as never);
    serve.release?.();
    recorded = engine.read();
    expect(recorded.argv).toEqual(['serve', '--profile', 'acme']);
    expect(recorded.env.MUSE_GATEWAY).toBe('https://gw.example.com');
  });

  test("ACP: a locked pin replaces the connection's command and arguments", async () => {
    const engine = recordingEngine();
    install({
      instances: {
        acp: {
          locked: true,
          binaryPath: engine.binary,
          launchArgs: ['--acp', '--acme'],
          environment: { ACME_ROUTE: 'gateway' },
        },
      },
    });
    const launches: unknown[] = [];
    const acp = new ACPProcess({
      command: 'user-chosen-agent',
      args: ['--yolo'],
      cwd: makeTempDir('station-managed-acp-cwd-'),
      createClient: (launch) => {
        launches.push(launch);
        return {} as never;
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      launchEnv: { ACME_ROUTE: 'user-route' },
    });
    // The recorder exits instead of answering `initialize`.
    await expect(acp.start()).rejects.toThrow();
    await acp.destroy();
    const recorded = engine.read();
    expect(recorded.argv).toEqual(['--acp', '--acme']);
    expect(recorded.env.ACME_ROUTE).toBe('gateway');
    // The client is told the launch is not the connection's own, so host
    // auth installs no responders for it.
    expect(launches).toEqual([{ launchReplacedByPolicy: true }]);
  });

  test('ACP: an unlocked pin that changes nothing reports the launch as the connection resolved it', async () => {
    const engine = recordingEngine();
    install({ instances: { acp: { locked: false, launchArgs: ['--x'] } } });
    const launches: unknown[] = [];
    const acp = new ACPProcess({
      command: engine.binary,
      args: ['--own'],
      cwd: makeTempDir('station-managed-acp-cwd-'),
      createClient: (launch) => {
        launches.push(launch);
        return {} as never;
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    await expect(acp.start()).rejects.toThrow();
    await acp.destroy();
    expect(engine.read().argv).toEqual(['--own']);
    expect(launches).toEqual([{ launchReplacedByPolicy: false }]);
  });

  test('Claude: pinned arguments and environment are merged into the SDK launch', async () => {
    const engine = recordingEngine();
    install({
      instances: {
        claude: {
          locked: true,
          binaryPath: engine.binary,
          launchArgs: ['--settings', '/opt/acme/claude.json'],
          environment: { ANTHROPIC_BASE_URL: 'https://gw.example.com' },
        },
      },
    });
    const owner = createClaudeEngineProcess();
    // What the SDK hands its spawner for a native executable it was given
    // as `pathToClaudeCodeExecutable` (the adapter passes the pinned one).
    const child = owner.spawn({
      command: engine.binary,
      args: ['--output-format', 'stream-json'],
      cwd: undefined,
      env: { ...process.env, ANTHROPIC_BASE_URL: 'https://user.example.com' },
      signal: new AbortController().signal,
    });
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const recorded = engine.read();
    expect(recorded.argv).toEqual([
      '--output-format',
      'stream-json',
      '--settings',
      '/opt/acme/claude.json',
    ]);
    expect(recorded.env.ANTHROPIC_BASE_URL).toBe('https://gw.example.com');
    await owner.terminate();
  });

  test('Claude: a launch that does not run the pinned executable is refused', () => {
    install({
      instances: { claude: { locked: true, binaryPath: '/opt/acme/claude' } },
    });
    const owner = createClaudeEngineProcess(() => {
      throw new Error('nothing may be spawned');
    });
    // The SDK falls back to its bundled copy when the pinned path is gone.
    expect(() =>
      owner.spawn({
        command: process.execPath,
        args: ['/sdk/cli.js', '--output-format', 'stream-json'],
        cwd: undefined,
        env: {},
        signal: new AbortController().signal,
      }),
    ).toThrow(/Acme's policy manages how claude is launched/);
  });
});

// #4515 fix round 2: the Codex and Muse builders hand the merged launch env
// to `childProcessEnvironment`, which layers it over `process.env` again. On
// Windows an inherited `HTTPS_PROXY` came back beside a locked
// `https_proxy`, and the child got the first of the two. This drives the
// real builders with the platform read as Windows; the recorder (run here
// on a case-sensitive host) reports every name spawn was handed.
describe('on Windows a locked variable is the only case-variant the engine child gets', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const inherited = process.env.HTTPS_PROXY;
  afterEach(() => {
    if (platform) Object.defineProperty(process, 'platform', platform);
    if (inherited === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = inherited;
  });

  function asWindows<T>(launch: () => T): T {
    process.env.HTTPS_PROXY = 'http://inherited:1';
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      return launch();
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  }

  function proxyVariants(env: Record<string, string>) {
    return Object.entries(env).filter(
      ([name]) => name.toUpperCase() === 'HTTPS_PROXY',
    );
  }

  test('Codex', async () => {
    const engine = recordingEngine();
    install({
      instances: {
        codex: {
          locked: true,
          binaryPath: engine.binary,
          environment: { https_proxy: 'http://pinned:2' },
        },
      },
    });
    const tmpDir = makeTempDir('station-managed-codex-tmp-');
    const child = asWindows(() => spawnCodexProcess(undefined, [], tmpDir));
    await exited(child);
    expect(proxyVariants(engine.read().env)).toEqual([
      ['https_proxy', 'http://pinned:2'],
    ]);
  });

  test('Muse: muse exec and muse serve', async () => {
    const engine = recordingEngine();
    install({
      instances: {
        muse: {
          locked: true,
          binaryPath: engine.binary,
          environment: { https_proxy: 'http://pinned:2' },
        },
      },
    });
    const tmpDir = makeTempDir('station-managed-muse-tmp-');
    const exec = asWindows(() =>
      createMuseProcess(['exec'], undefined, tmpDir),
    );
    await exited(exec.process as never);
    exec.release?.();
    expect(proxyVariants(engine.read().env)).toEqual([
      ['https_proxy', 'http://pinned:2'],
    ]);
    const serve = asWindows(() =>
      createMuseServeHost(
        { disableSandbox: false },
        undefined,
        undefined,
        tmpDir,
      ),
    );
    await exited(serve.process as never);
    serve.release?.();
    expect(proxyVariants(engine.read().env)).toEqual([
      ['https_proxy', 'http://pinned:2'],
    ]);
  });

  test('control: elsewhere both names reach the child, as the platform keeps both', async () => {
    const engine = recordingEngine();
    install({
      instances: {
        codex: {
          locked: true,
          binaryPath: engine.binary,
          environment: { https_proxy: 'http://pinned:2' },
        },
      },
    });
    process.env.HTTPS_PROXY = 'http://inherited:1';
    const child = spawnCodexProcess(
      undefined,
      [],
      makeTempDir('station-managed-codex-tmp-'),
    );
    await exited(child);
    expect(proxyVariants(engine.read().env).sort()).toEqual([
      ['HTTPS_PROXY', 'http://inherited:1'],
      ['https_proxy', 'http://pinned:2'],
    ]);
  });
});

// #4515 fix round 2: the launch leaves refuse an engine the policy does not
// allow, whichever caller reached them (a session, a model listing).
describe('a disallowed engine is refused at its launch, before anything runs', () => {
  // A disallowed engine cannot be pinned, so the recorder is found the way
  // an installed CLI is: first on the PATH, under the engine's name.
  const path = process.env.PATH;
  afterEach(() => {
    process.env.PATH = path;
  });
  const onPath = () => {
    const engine = recordingEngine();
    const dir = dirname(engine.binary);
    for (const name of ['codex', 'muse'])
      symlinkSync(engine.binary, join(dir, name));
    process.env.PATH = `${dir}${delimiter}${path ?? ''}`;
    const ran = () => {
      try {
        engine.read();
        return true;
      } catch {
        return false;
      }
    };
    return { engine, ran };
  };
  const refused = /Acme's policy manages which engines run on this computer/;

  test('Codex, Muse and the Claude SDK spawn', () => {
    const { engine, ran } = onPath();
    install({ allowed: ['station-agent'] });
    expect(() => spawnCodexProcess()).toThrow(refused);
    expect(() => createMuseProcess(['exec'])).toThrow(refused);
    expect(() => createMuseServeHost({ disableSandbox: false })).toThrow(
      refused,
    );
    const owner = createClaudeEngineProcess(() => {
      throw new Error('nothing may be spawned');
    });
    expect(() =>
      owner.spawn({
        command: engine.binary,
        args: [],
        cwd: undefined,
        env: {},
        signal: new AbortController().signal,
      }),
    ).toThrow(refused);
    expect(ran()).toBe(false);
  });

  test('control: allowed, the same Codex launch runs the CLI on the PATH', async () => {
    const { ran } = onPath();
    install({ allowed: ['codex'] });
    await exited(spawnCodexProcess());
    expect(ran()).toBe(true);
  });
});

describe('merge rules', () => {
  const launch = {
    command: '/usr/bin/user-agent',
    args: ['--user'],
    env: { SET_BY_USER: 'user', ONLY_USER: 'u' } as Record<
      string,
      string | undefined
    >,
  };

  test('an unlocked pin fills only what the launch leaves unset', () => {
    install({
      instances: {
        acp: {
          locked: false,
          binaryPath: '/opt/acme/agent',
          launchArgs: ['--acme'],
          environment: { SET_BY_USER: 'pinned', ONLY_PIN: 'p' },
        },
      },
    });
    expect(managedEngineLaunch('acp', launch, 'user')).toEqual({
      command: '/usr/bin/user-agent',
      args: ['--user'],
      env: { SET_BY_USER: 'user', ONLY_USER: 'u', ONLY_PIN: 'p' },
    });
    expect(
      managedEngineLaunch('acp', { ...launch, args: [] }, 'user').args,
    ).toEqual(['--acme']);
  });

  test('a locked pin overrides each field it sets and leaves the rest', () => {
    install({
      instances: {
        acp: { locked: true, environment: { SET_BY_USER: 'pinned' } },
      },
    });
    expect(managedEngineLaunch('acp', launch, 'user')).toEqual({
      command: '/usr/bin/user-agent',
      args: ['--user'],
      env: { SET_BY_USER: 'pinned', ONLY_USER: 'u' },
    });
  });

  test('without a pin the launch is unchanged', () => {
    expect(managedEngineLaunch('codex', launch, 'station')).toBe(launch);
  });

  // #4515 fix round 1: on Windows a child gets one of `HTTPS_PROXY` and
  // `https_proxy` (Node keeps the first in its sorted, case-insensitive
  // order), so an inherited `HTTPS_PROXY` would beat a locked `https_proxy`.
  const inherited = {
    command: '/usr/bin/user-agent',
    args: [],
    env: { HTTPS_PROXY: 'http://inherited:1', Path: 'C:\\Windows' } as Record<
      string,
      string | undefined
    >,
  };

  test('on Windows a locked variable removes every case-variant, then sets its own', () => {
    install({
      instances: {
        acp: { locked: true, environment: { https_proxy: 'http://pinned:2' } },
      },
    });
    expect(managedEngineLaunch('acp', inherited, 'user', 'win32').env).toEqual({
      https_proxy: 'http://pinned:2',
      Path: 'C:\\Windows',
    });
  });

  test('on Windows an unlocked variable fills only when no case-variant is set', () => {
    install({
      instances: {
        acp: {
          locked: false,
          environment: { https_proxy: 'http://pinned:2', PATH: 'C:\\Other' },
        },
      },
    });
    expect(managedEngineLaunch('acp', inherited, 'user', 'win32').env).toEqual(
      inherited.env,
    );
    expect(
      managedEngineLaunch('acp', { ...inherited, env: {} }, 'user', 'win32')
        .env,
    ).toEqual({ https_proxy: 'http://pinned:2', PATH: 'C:\\Other' });
  });

  test('elsewhere names stay case-sensitive, as the platform treats them', () => {
    install({
      instances: {
        acp: { locked: true, environment: { https_proxy: 'http://pinned:2' } },
      },
    });
    expect(managedEngineLaunch('acp', inherited, 'user', 'linux').env).toEqual({
      ...inherited.env,
      https_proxy: 'http://pinned:2',
    });
  });
});

describe("a locked environment owns the connection's launch configuration", () => {
  const config = {
    env: { ANTHROPIC_BASE_URL: 'https://user.example.com' },
    configHome: '/Users/someone/.claude-wrapper',
    proxyConnectionId: 'proxy',
  };
  const proxies = [
    {
      id: 'proxy',
      type: 'openai-compat',
      name: 'Proxy',
      enabled: true,
      capabilities: ['llm' as const],
      config: { baseUrl: 'http://127.0.0.1:9999/v1', apiKey: 'k' },
    },
  ];

  test('without a policy the connection env, config home and proxy apply', () => {
    expect(connectionSpawnEnv(config, 'claude')).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://user.example.com',
      CLAUDE_CONFIG_DIR: '/Users/someone/.claude-wrapper',
    });
    expect(engineProxyLaunch('claude', config, proxies).route).toBeDefined();
  });

  test('a locked environment drops all three', () => {
    install({
      instances: {
        claude: { locked: true, environment: { CLAUDE_CONFIG_DIR: '/opt/a' } },
      },
    });
    expect(connectionSpawnEnv(config, 'claude')).toBeUndefined();
    expect(engineProxyLaunch('claude', config, proxies)).toEqual({
      env: undefined,
      args: [],
    });
    // Codex has no locked entry, so its connection keeps its own.
    expect(connectionSpawnEnv(config, 'codex')).toBeDefined();
  });

  test('an unlocked environment leaves the connection its own', () => {
    install({
      instances: {
        claude: { locked: false, environment: { CLAUDE_CONFIG_DIR: '/opt/a' } },
      },
    });
    expect(connectionSpawnEnv(config, 'claude')).toBeDefined();
  });
});
