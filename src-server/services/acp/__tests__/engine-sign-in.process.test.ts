/**
 * Engine sign-in against a real engine process: the fake ACP agent (the ACP
 * SDK's agent side) behind a stub program with the engine's name, so the
 * built-in descriptor for that engine applies exactly as in production.
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type {
  TerminalEvent,
  TerminalOpenInput,
} from '../../../domain/terminal-types.js';
import { AcpAdapter } from '../../../providers/adapters/acp-adapter.js';
import { BUILTIN_ACP_ENGINES } from '../../../providers/llm/builtin-acp-engines.js';
import {
  clearAll,
  registerACPConnectionRegistryProvider,
} from '../../../providers/registries/registry.js';
import { ACPProbe } from '../acp-probe.js';
import {
  engineSignInStatus,
  resetEngineAuthStatus,
} from '../engine-auth-status.js';
import {
  EngineCredentials,
  registerEngineCredentials,
} from '../engine-credentials.js';
import {
  ENGINE_SIGN_IN_TERMINAL_PROJECT,
  EngineSignInService,
  type SignInTerminalHost,
} from '../engine-sign-in.js';

const FAKE_AGENT = fileURLToPath(
  new URL(
    '../../../providers/__tests__/fixtures/fake-acp-agent.mjs',
    import.meta.url,
  ),
);
const PROFILES = fileURLToPath(
  new URL(
    '../../../providers/__tests__/fixtures/acp-engine-profiles/',
    import.meta.url,
  ),
);
const posix = process.platform !== 'win32';
const makeTempDir = trackTempDirs();
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

beforeEach(() => {
  registerACPConnectionRegistryProvider(
    { listAvailable: () => BUILTIN_ACP_ENGINES.map((entry) => ({ ...entry })) },
    'builtin-acp-connections',
    true,
  );
});
afterEach(() => {
  clearAll();
  resetEngineAuthStatus();
  registerEngineCredentials(null);
});

/** A program named like the engine that runs the fake agent with a profile. */
function engineProgram(
  program: string,
  profile: string,
  extra: string[] = [],
): { command: string; record: () => Array<Record<string, unknown>> } {
  const dir = makeTempDir('station-sign-in-engine-');
  const record = join(dir, 'record.jsonl');
  writeFileSync(record, '');
  const command = join(dir, program);
  const quoted = [
    process.execPath,
    FAKE_AGENT,
    '--engine-profile',
    join(PROFILES, profile),
    '--record',
    record,
    ...extra,
  ]
    .map((part) => `'${part.replaceAll("'", `'\\''`)}'`)
    .join(' ');
  writeFileSync(command, `#!/bin/sh\nexec ${quoted} "$@"\n`);
  chmodSync(command, 0o755);
  return {
    command,
    record: () =>
      readFileSync(record, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}

function connection(id: string, command: string): ACPConnectionConfig {
  return { id, name: id, command, args: [], enabled: true };
}

/** A terminal host that records what it was asked to run. */
function recordingTerminal() {
  const opened: TerminalOpenInput[] = [];
  const listeners = new Set<(event: TerminalEvent) => void>();
  const host: SignInTerminalHost = {
    open: async (input) => {
      opened.push(input);
      return { sessionId: `${input.projectSlug}:${input.terminalId}` };
    },
    close: async () => undefined,
    subscribe: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  return {
    host,
    opened,
    exit: (input: TerminalOpenInput, exitCode: number) => {
      for (const listener of listeners)
        listener({
          type: 'exited',
          sessionId: `${input.projectSlug}:${input.terminalId}`,
          exitCode,
          signal: null,
        });
    },
  };
}

async function settle(service: EngineSignInService, connectionId: string) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const attempt = service.attempt(connectionId);
    if (attempt && attempt.state !== 'running') return attempt;
    if (Date.now() > deadline) throw new Error('sign-in did not finish');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe.runIf(posix)('engine sign-in through a live handshake', () => {
  test('the handshake offers terminal sign-in and lists methods minus hidden ones', async () => {
    const droid = engineProgram('droid', 'factory-droid.json');
    const service = new EngineSignInService({ terminal: null });
    const config = connection('droid', droid.command);
    await service.refreshMethods(config);
    expect(droid.record()[0]).toEqual({
      method: 'initialize',
      clientAuth: { terminal: true },
    });
    // factory-api-key is hidden by the descriptor: the key field replaces it.
    expect(service.methodsView(config).methods).toEqual([
      { id: 'device-pairing', name: 'Pair this device', kind: 'agent' },
    ]);
  });

  test('a terminal method runs the engine program with only the handshake args', async () => {
    const pi = engineProgram('pi-acp', 'pi-acp.json');
    const terminal = recordingTerminal();
    const service = new EngineSignInService({ terminal: terminal.host });
    const config = { ...connection('pi', pi.command), args: ['--from-config'] };
    const attempt = await service.startTerminal(config, 'pi_terminal_login');
    expect(terminal.opened).toHaveLength(1);
    const [opened] = terminal.opened;
    expect(opened.shell).toBe(pi.command);
    // The protocol: the configured invocation plus the method's args.
    expect(opened.shellArgs).toEqual(['--from-config', '--terminal-login']);
    expect(opened.projectSlug).toBe(ENGINE_SIGN_IN_TERMINAL_PROJECT);
    expect(attempt).toMatchObject({
      kind: 'terminal',
      state: 'running',
      terminal: { projectSlug: ENGINE_SIGN_IN_TERMINAL_PROJECT },
    });
    // The descriptor's terms note reaches the method it names.
    expect(service.methodsView(config).methods?.[0]).toMatchObject({
      id: 'pi_terminal_login',
      kind: 'terminal',
      termsNotice: { provider: 'Anthropic' },
    });

    terminal.exit(opened, 0);
    expect(service.attempt('pi')?.state).toBe('succeeded');
    expect(await engineSignInStatus(config)).toMatchObject({
      state: 'authenticated',
      source: 'sign-in',
    });
  });

  test.each([
    ['cancel', (s: EngineSignInService) => s.cancel('pi')],
    ['forget', (s: EngineSignInService) => s.forget('pi')],
    ['dispose', (s: EngineSignInService) => s.dispose()],
  ] as const)(
    '%s closes a terminal whose opening is still pending',
    async (_how, end) => {
      const pi = engineProgram('pi-acp', 'pi-acp.json');
      const terminal = recordingTerminal();
      let finishOpen!: (snapshot: { sessionId: string }) => void;
      let opening!: () => void;
      const opened = new Promise<void>((resolve) => {
        opening = resolve;
      });
      const close = vi.fn(async () => undefined);
      terminal.host.close = close;
      terminal.host.open = (input) => {
        terminal.opened.push(input);
        opening();
        return new Promise((resolve) => {
          finishOpen = resolve;
        });
      };
      const service = new EngineSignInService({ terminal: terminal.host });
      const started = service.startTerminal(
        connection('pi', pi.command),
        'pi_terminal_login',
      );
      await opened;
      end(service);
      const input = terminal.opened[0];
      const sessionId = `${input.projectSlug}:${input.terminalId}`;
      finishOpen({ sessionId });
      expect(await started).toMatchObject({ state: 'cancelled' });
      expect(close).toHaveBeenCalledExactlyOnceWith(sessionId);
      terminal.exit(input, 0);
      expect(
        (await engineSignInStatus(connection('pi', pi.command))).state,
      ).toBe('unknown');
    },
  );

  test('a terminal sign-in that exits non-zero fails and claims nothing', async () => {
    const pi = engineProgram('pi-acp', 'pi-acp.json');
    const terminal = recordingTerminal();
    const service = new EngineSignInService({ terminal: terminal.host });
    const config = connection('pi', pi.command);
    await service.startTerminal(config, 'pi_terminal_login');
    terminal.exit(terminal.opened[0], 1);
    expect(service.attempt('pi')).toMatchObject({ state: 'failed' });
    expect((await engineSignInStatus(config)).state).toBe('unknown');
  });

  test('a method the handshake did not advertise, or a non-terminal one, never opens a terminal', async () => {
    const droid = engineProgram('droid', 'factory-droid.json');
    const terminal = recordingTerminal();
    const service = new EngineSignInService({ terminal: terminal.host });
    const config = connection('droid', droid.command);
    await expect(
      service.startTerminal(config, 'pi_terminal_login'),
    ).rejects.toThrow('does not offer');
    await expect(
      service.startTerminal(config, 'device-pairing'),
    ).rejects.toThrow('does not run in a terminal');
    await expect(
      service.startTerminal(config, 'factory-api-key'),
    ).rejects.toThrow('does not offer');
    expect(terminal.opened).toEqual([]);
  });

  test('an agent method is passed to authenticate and its printed link is shown', async () => {
    const droid = engineProgram('droid', 'factory-droid.json', [
      '--authenticate-stderr',
      'Open https://app.factory.ai/device?code=ABCD-1234 to pair. Your code: ABCD-1234',
      '--authenticate-delay-ms',
      '300',
    ]);
    const service = new EngineSignInService({ terminal: null });
    const config = connection('droid', droid.command);
    const started = await service.startAgent(config, 'device-pairing');
    expect(started).toMatchObject({ kind: 'agent', state: 'running' });
    const finished = await settle(service, 'droid');
    expect(finished.state).toBe('succeeded');
    expect(finished.links).toEqual([
      'https://app.factory.ai/device?code=ABCD-1234',
    ]);
    expect(droid.record()).toContainEqual({
      method: 'authenticate',
      methodId: 'device-pairing',
    });
    expect(await engineSignInStatus(config)).toMatchObject({
      state: 'authenticated',
      source: 'sign-in',
    });
  });

  test('a refused authenticate fails with the engine reason and claims nothing', async () => {
    const droid = engineProgram('droid', 'factory-droid.json', [
      '--authenticate-fail',
    ]);
    const service = new EngineSignInService({ terminal: null });
    const config = connection('droid', droid.command);
    await service.startAgent(config, 'device-pairing');
    const finished = await settle(service, 'droid');
    expect(finished.state).toBe('failed');
    expect(finished.message).toContain('Pairing was declined');
    expect((await engineSignInStatus(config)).state).toBe('unknown');
  });

  test('an authenticate that never finishes times out', async () => {
    const droid = engineProgram('droid', 'factory-droid.json', [
      '--authenticate-delay-ms',
      '60000',
    ]);
    const service = new EngineSignInService({
      terminal: null,
      timeouts: { agent: 300 },
    });
    await service.startAgent(
      connection('droid', droid.command),
      'device-pairing',
    );
    expect((await settle(service, 'droid')).state).toBe('timed-out');
  });

  test.each([
    ['cancel', (s: EngineSignInService) => s.cancel('droid')],
    ['forget', (s: EngineSignInService) => s.forget('droid')],
    ['dispose', (s: EngineSignInService) => s.dispose()],
  ] as const)('%s ends a running sign-in', async (how, end) => {
    const droid = engineProgram('droid', 'factory-droid.json', [
      '--authenticate-delay-ms',
      '60000',
    ]);
    const service = new EngineSignInService({ terminal: null });
    await service.startAgent(
      connection('droid', droid.command),
      'device-pairing',
    );
    expect(service.attempt('droid')?.state).toBe('running');
    end(service);
    if (how === 'forget') {
      expect(service.attempt('droid')).toBeNull();
      // Another start is not refused as "already running".
      await service.startAgent(
        connection('droid', droid.command),
        'device-pairing',
      );
      service.dispose();
      return;
    }
    expect((await settle(service, 'droid')).state).toBe('cancelled');
  });

  test('a terminal method is never passed to authenticate', async () => {
    const pi = engineProgram('pi-acp', 'pi-acp.json');
    const service = new EngineSignInService({ terminal: null });
    await expect(
      service.startAgent(connection('pi', pi.command), 'pi_terminal_login'),
    ).rejects.toThrow('runs in a terminal');
    expect(pi.record().some((entry) => entry.method === 'authenticate')).toBe(
      false,
    );
  });

  test('an engine refusal at the probe is recorded as signed out', async () => {
    const droid = engineProgram('droid', 'factory-droid.json', [
      '--fail',
      'auth-required-on-session-new',
    ]);
    const config = connection('droid', droid.command);
    const probe = new ACPProbe(
      config,
      quiet,
      makeTempDir('station-sign-in-home-'),
    );
    try {
      await probe.probe('request').catch(() => undefined);
      expect(await engineSignInStatus(config)).toMatchObject({
        state: 'unauthenticated',
        source: 'refusal',
      });
    } finally {
      await probe.dispose();
    }
  });
});

describe.runIf(posix)('a stored key reaches only its own connection', () => {
  test('the session launch and the probe give the key to that connection alone', async () => {
    const home = makeTempDir('station-sign-in-keys-');
    const credentials = new EngineCredentials(home);
    registerEngineCredentials(credentials);
    const withKey = engineProgram('droid', 'factory-droid.json', [
      '--record-env',
      'FACTORY_API_KEY',
    ]);
    const withoutKey = engineProgram('droid', 'factory-droid.json', [
      '--record-env',
      'FACTORY_API_KEY',
    ]);
    const keyed = connection('droid-keyed', withKey.command);
    const plain = connection('droid-plain', withoutKey.command);
    await credentials.set(keyed.id, 'FACTORY_API_KEY', 'fk-secret-1', [
      'FACTORY_API_KEY',
    ]);
    const previous = process.env.FACTORY_API_KEY;
    delete process.env.FACTORY_API_KEY;
    const adapter = new AcpAdapter({
      getConnections: async () => [keyed, plain],
      logger: quiet,
    });
    try {
      for (const config of [keyed, plain])
        await adapter.startSession({
          provider: 'acp',
          threadId: `thread-${config.id}`,
          cwd: makeTempDir('station-sign-in-cwd-'),
          confinement: 'workspace',
          metadata: { connectionId: config.id },
        } as never);
      expect(withKey.record()[0]).toEqual({
        env: 'FACTORY_API_KEY',
        value: 'fk-secret-1',
      });
      expect(withoutKey.record()[0]).toEqual({
        env: 'FACTORY_API_KEY',
        value: null,
      });

      const probe = new ACPProbe(keyed, quiet, home);
      try {
        await probe.probe('request').catch(() => undefined);
      } finally {
        await probe.dispose();
      }
      const launches = withKey
        .record()
        .filter((entry) => entry.env === 'FACTORY_API_KEY');
      expect(launches).toHaveLength(2);
      expect(launches[1]).toEqual({
        env: 'FACTORY_API_KEY',
        value: 'fk-secret-1',
      });
    } finally {
      await adapter.stopAll();
      if (previous !== undefined) process.env.FACTORY_API_KEY = previous;
    }
  });
});
