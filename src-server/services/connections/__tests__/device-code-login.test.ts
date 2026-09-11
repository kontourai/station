import { describe, expect, test, vi } from 'vitest';
import type { EnrolmentAuthState } from '../credential-enrolment.js';
import {
  DEVICE_CODE_LOGIN_TIMEOUT_MS,
  DEVICE_CODE_MAX_LIVE_LOGINS,
  DEVICE_CODE_PROMPT_TIMEOUT_MS,
  type DeviceCodeChildProcess,
  type DeviceCodeLoginDeps,
  DeviceCodeLoginManager,
  parseDeviceCodePrompt,
} from '../device-code-login.js';
import type { EngineLoginCapabilities } from '../engine-login-capabilities.js';
import {
  CODEX_DEVICE_CODE_EXPECTED,
  CODEX_DEVICE_CODE_STDOUT,
  MUSE_DEVICE_CODE_EXPECTED,
  MUSE_DEVICE_CODE_STDOUT,
} from './device-code-cli-output.js';

const PROFILE_DIR = '/app-homes/credential-profile-abc';

class FakeStream {
  #listener?: (chunk: unknown) => void;
  on(_event: 'data', listener: (chunk: unknown) => void) {
    this.#listener = listener;
    return this;
  }
  write(text: string) {
    this.#listener?.(Buffer.from(text, 'utf8'));
  }
}

class FakeChild implements DeviceCodeChildProcess {
  readonly stdout = new FakeStream() as unknown as NodeJS.ReadableStream & {
    write(text: string): void;
  };
  readonly stderr = new FakeStream() as unknown as NodeJS.ReadableStream & {
    write(text: string): void;
  };
  readonly signals: string[] = [];
  #exit?: (code: number | null) => void;
  #error?: (error: Error) => void;

  on(event: 'exit' | 'error', listener: never) {
    if (event === 'exit') this.#exit = listener;
    else this.#error = listener;
    return this;
  }
  kill(signal?: NodeJS.Signals) {
    this.signals.push(signal ?? 'SIGTERM');
    return true;
  }
  emitExit(code: number | null) {
    this.#exit?.(code);
  }
  emitError(error: Error) {
    this.#error?.(error);
  }
}

function manualScheduler() {
  const timers: Array<{
    run: () => void;
    delayMs: number;
    cancelled: boolean;
  }> = [];
  return {
    schedule(run: () => void, delayMs: number) {
      const timer = { run, delayMs, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    /** Run every live timer registered for exactly this delay. */
    fire(delayMs: number) {
      for (const timer of [...timers]) {
        if (!timer.cancelled && timer.delayMs === delayMs) timer.run();
      }
    },
    liveCount() {
      return timers.filter((timer) => !timer.cancelled).length;
    },
  };
}

function capabilitiesWith(
  argument: string | undefined,
  mechanism: 'device-code' | 'api-key-stdin' = 'device-code',
): EngineLoginCapabilities {
  return {
    engine: 'codex',
    observedAt: '2026-09-11T00:00:00.000Z',
    evidence: [
      {
        mechanism,
        observedCommand: ['codex', 'login', '--help'],
        observedMatch: argument ?? 'stdin',
        ...(argument ? { argument } : {}),
      },
    ],
  };
}

const BASE_ENV = { PATH: '/usr/bin', TMPDIR: '/tmp/station-engine' };

function harness(
  overrides: {
    capabilities?: EngineLoginCapabilities;
    authState?: EnrolmentAuthState;
    authDetail?: string;
    schedule?: DeviceCodeLoginDeps['schedule'];
  } = {},
) {
  const children: FakeChild[] = [];
  const spawned: Array<{
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    windowsHide: boolean;
  }> = [];
  const scheduler = manualScheduler();
  const verify = vi.fn(async () => ({
    state: overrides.authState ?? ('authenticated' as EnrolmentAuthState),
    ...(overrides.authDetail ? { detail: overrides.authDetail } : {}),
  }));
  const spawnLogin = vi.fn((command: string, args: string[], options) => {
    spawned.push({ ...options, command, args });
    const child = new FakeChild();
    children.push(child);
    return child as unknown as DeviceCodeChildProcess;
  });
  const capabilities = vi.fn(
    async () => overrides.capabilities ?? capabilitiesWith('--device-auth'),
  );
  const deps: DeviceCodeLoginDeps = {
    spawnLogin: spawnLogin as never,
    baseEnv: async () => ({ ...BASE_ENV }),
    capabilities: capabilities as never,
    verify: verify as never,
    now: () => new Date('2026-09-11T12:00:00.000Z'),
    schedule: overrides.schedule ?? scheduler.schedule,
  };
  return {
    manager: new DeviceCodeLoginManager(deps),
    children,
    spawned,
    spawnLogin,
    verify,
    capabilities,
    scheduler,
  };
}

describe('reading a device-code prompt out of a CLI', () => {
  test("parses codex's live output, ANSI attributes and banner included", () => {
    expect(parseDeviceCodePrompt(CODEX_DEVICE_CODE_STDOUT)).toEqual(
      CODEX_DEVICE_CODE_EXPECTED,
    );
  });

  test("parses muse's live output, whose code is also inside the URL", () => {
    expect(parseDeviceCodePrompt(MUSE_DEVICE_CODE_STDOUT)).toEqual(
      MUSE_DEVICE_CODE_EXPECTED,
    );
  });

  test('a code printed before any URL is not read as this login’s code', () => {
    // Synthetic: neither observed CLI prints an all-caps banner, but the
    // ordering rule exists so one could not be mistaken for a code.
    const output = [
      'ACME-CLI',
      'Open this page to sign in:',
      '  https://auth.example.com/device',
      '  WXYZ-4321',
    ].join('\n');
    expect(parseDeviceCodePrompt(output)?.userCode).toBe('WXYZ-4321');
  });

  test('a prompt with no code yields nothing rather than half of one', () => {
    expect(
      parseDeviceCodePrompt('Open https://auth.example.com/device to sign in.'),
    ).toBeUndefined();
  });

  test('a plaintext verification URL is not relayed', () => {
    const output = [
      'Open this page:',
      '  http://auth.example.com/device',
      '  WXYZ-4321',
    ].join('\n');
    expect(parseDeviceCodePrompt(output)).toBeUndefined();
  });

  test('a number on its own line is not a user code', () => {
    const output = [
      'Open this page:',
      '  https://auth.example.com/device',
      '  12345678',
      '  WXYZ-4321',
    ].join('\n');
    expect(parseDeviceCodePrompt(output)?.userCode).toBe('WXYZ-4321');
  });
});

describe('starting a login', () => {
  test("runs the engine's own login with the observed flag, adding only the config-home override", async () => {
    const { manager, spawned } = harness();

    const result = await manager.start('codex', PROFILE_DIR);

    expect(result.kind).toBe('started');
    expect(spawned).toHaveLength(1);
    expect(spawned[0].command).toBe('codex');
    expect(spawned[0].args).toEqual(['login', '--device-auth']);
    expect(spawned[0].windowsHide).toBe(true);
    // The child's environment is the base environment plus exactly one key.
    expect(spawned[0].env).toEqual({ ...BASE_ENV, CODEX_HOME: PROFILE_DIR });
    expect(JSON.stringify(spawned[0].env)).not.toMatch(
      /token|secret|password/i,
    );
  });

  test('passes no extra argument when the mechanism needs none', async () => {
    const { manager, spawned } = harness({
      capabilities: capabilitiesWith(undefined),
    });

    await manager.start('codex', PROFILE_DIR);
    expect(spawned[0].args).toEqual(['login']);
  });

  test('refuses, and spawns nothing, when no evidence establishes device-code', async () => {
    const { manager, spawnLogin } = harness({
      capabilities: capabilitiesWith('--with-api-key', 'api-key-stdin'),
    });

    const result = await manager.start('codex', PROFILE_DIR);

    expect(result).toEqual({
      kind: 'unsupported',
      reason: expect.stringMatching(/does not offer a device-code login/),
    });
    expect(spawnLogin).not.toHaveBeenCalled();
  });

  test("relays the CLI's unavailable reason rather than inventing one", async () => {
    const { manager } = harness({
      capabilities: {
        engine: 'codex',
        observedAt: '2026-09-11T00:00:00.000Z',
        evidence: [],
        unavailableReason: 'The codex command was not found on this host.',
      },
    });

    const result = await manager.start('codex', PROFILE_DIR);
    expect(result).toEqual({
      kind: 'unsupported',
      reason: 'The codex command was not found on this host.',
    });
  });

  test('surfaces the URL and code the CLI printed', async () => {
    const { manager, children } = harness();
    await manager.start('codex', PROFILE_DIR);

    children[0].stdout.write(CODEX_DEVICE_CODE_STDOUT);

    expect(manager.status(PROFILE_DIR)).toMatchObject({
      phase: 'awaiting-approval',
      ...CODEX_DEVICE_CODE_EXPECTED,
    });
  });

  test('a second start while one is live returns the same login and spawns nothing', async () => {
    const { manager, children, spawnLogin, capabilities } = harness();
    await manager.start('codex', PROFILE_DIR);
    children[0].stdout.write(CODEX_DEVICE_CODE_STDOUT);

    const second = await manager.start('codex', PROFILE_DIR);

    expect(second.kind).toBe('existing');
    expect(second.kind === 'existing' && second.record.userCode).toBe(
      CODEX_DEVICE_CODE_EXPECTED.userCode,
    );
    expect(spawnLogin).toHaveBeenCalledTimes(1);
    // The live session short-circuits BEFORE the capability probe. Without
    // this the pre-await guard is unobservable: the post-await re-check
    // (which exists for the concurrent case) already covers the sequential
    // one, so removing the first guard passed every other assertion here.
    expect(capabilities).toHaveBeenCalledTimes(1);
  });

  test('concurrent starts race through the capability probe without a second process', async () => {
    const { manager, spawnLogin } = harness();

    await Promise.all([
      manager.start('codex', PROFILE_DIR),
      manager.start('codex', PROFILE_DIR),
    ]);

    expect(spawnLogin).toHaveBeenCalledTimes(1);
  });

  test('refuses to exceed the live-login cap', async () => {
    const { manager, children, spawnLogin } = harness();
    for (let index = 0; index < DEVICE_CODE_MAX_LIVE_LOGINS; index += 1) {
      await manager.start('codex', `${PROFILE_DIR}-${index}`);
      children[index].stdout.write(CODEX_DEVICE_CODE_STDOUT);
    }

    const overflow = await manager.start('codex', `${PROFILE_DIR}-overflow`);

    expect(overflow.kind).toBe('busy');
    expect(spawnLogin).toHaveBeenCalledTimes(DEVICE_CODE_MAX_LIVE_LOGINS);
  });

  test('a CLI that cannot be executed fails with a stated reason', async () => {
    const { manager, children } = harness();
    await manager.start('codex', PROFILE_DIR);

    const missing = new Error('spawn codex ENOENT') as NodeJS.ErrnoException;
    missing.code = 'ENOENT';
    children[0].emitError(missing);

    expect(manager.status(PROFILE_DIR)).toMatchObject({
      phase: 'failed',
      reason: 'The codex command was not found on this host.',
    });
  });
});

describe('completion is the engine’s answer, not the exit code', () => {
  test('a clean exit with no account signed in is a failure', async () => {
    const { manager, children, verify } = harness({
      authState: 'unauthenticated',
    });
    await manager.start('codex', PROFILE_DIR);
    children[0].stdout.write(CODEX_DEVICE_CODE_STDOUT);

    children[0].emitExit(0);
    await vi.waitFor(() =>
      expect(manager.status(PROFILE_DIR)?.phase).toBe('failed'),
    );

    expect(verify).toHaveBeenCalledWith('codex', PROFILE_DIR);
    expect(manager.status(PROFILE_DIR)?.reason).toMatch(/still signed out/);
  });

  test('a non-zero exit with an account signed in is a completion', async () => {
    const { manager, children } = harness({
      authState: 'authenticated',
      authDetail: 'Logged in using ChatGPT',
    });
    await manager.start('codex', PROFILE_DIR);
    children[0].stdout.write(CODEX_DEVICE_CODE_STDOUT);

    children[0].emitExit(1);
    await vi.waitFor(() =>
      expect(manager.status(PROFILE_DIR)?.phase).toBe('completed'),
    );

    expect(manager.status(PROFILE_DIR)?.detail).toBe('Logged in using ChatGPT');
  });

  test('an engine that cannot answer leaves the login failed, never completed', async () => {
    const { manager, children } = harness({ authState: 'unknown' });
    await manager.start('codex', PROFILE_DIR);
    children[0].stdout.write(CODEX_DEVICE_CODE_STDOUT);

    children[0].emitExit(0);
    await vi.waitFor(() =>
      expect(manager.status(PROFILE_DIR)?.phase).toBe('failed'),
    );
    expect(manager.status(PROFILE_DIR)?.reason).toMatch(
      /could not report whether the sign-in succeeded/,
    );
  });

  test('an exit before any code was printed fails without asking the engine', async () => {
    const { manager, children, verify } = harness();
    await manager.start('codex', PROFILE_DIR);

    children[0].emitExit(2);

    expect(verify).not.toHaveBeenCalled();
    expect(manager.status(PROFILE_DIR)).toMatchObject({
      phase: 'failed',
      reason:
        'The codex login exited with code 2 without printing a verification code.',
    });
  });
});

describe('a login cannot outlive its bounds', () => {
  test('a CLI that never prints a code is killed and reported, not parked', async () => {
    const { manager, children, scheduler } = harness();
    await manager.start('codex', PROFILE_DIR);
    children[0].stdout.write('Contacting the provider...\n');

    scheduler.fire(DEVICE_CODE_PROMPT_TIMEOUT_MS);

    expect(children[0].signals).toContain('SIGTERM');
    expect(manager.status(PROFILE_DIR)).toMatchObject({
      phase: 'failed',
      reason: expect.stringMatching(/did not print a verification code/),
    });
  });

  test('an approval that never arrives is killed at the code’s own expiry', async () => {
    const { manager, children, scheduler } = harness();
    await manager.start('codex', PROFILE_DIR);
    children[0].stdout.write(CODEX_DEVICE_CODE_STDOUT);

    scheduler.fire(DEVICE_CODE_LOGIN_TIMEOUT_MS);

    expect(children[0].signals).toContain('SIGTERM');
    expect(manager.status(PROFILE_DIR)).toMatchObject({
      phase: 'failed',
      reason: 'The device code expired before it was approved.',
    });
  });

  test('the prompt deadline does not fire once a code has been printed', async () => {
    const { manager, children, scheduler } = harness();
    await manager.start('codex', PROFILE_DIR);
    children[0].stdout.write(CODEX_DEVICE_CODE_STDOUT);

    scheduler.fire(DEVICE_CODE_PROMPT_TIMEOUT_MS);

    expect(children[0].signals).toEqual([]);
    expect(manager.status(PROFILE_DIR)?.phase).toBe('awaiting-approval');
  });

  test('settling a login cancels its remaining deadlines', async () => {
    const { manager, children, scheduler } = harness();
    await manager.start('codex', PROFILE_DIR);
    const armed = scheduler.liveCount();
    expect(armed).toBeGreaterThanOrEqual(2);

    manager.cancel(PROFILE_DIR);

    expect(scheduler.liveCount()).toBeLessThan(armed);
    expect(children[0].signals).toContain('SIGTERM');
  });
});

describe('cancelling', () => {
  test('kills the process and records the cancellation', async () => {
    const { manager, children } = harness();
    await manager.start('codex', PROFILE_DIR);
    children[0].stdout.write(CODEX_DEVICE_CODE_STDOUT);

    const cancelled = manager.cancel(PROFILE_DIR);

    expect(cancelled?.phase).toBe('cancelled');
    expect(children[0].signals).toContain('SIGTERM');
  });

  test('a cancelled login is not revised into a completion by a late exit', async () => {
    const { manager, children, verify } = harness({
      authState: 'authenticated',
    });
    await manager.start('codex', PROFILE_DIR);
    children[0].stdout.write(CODEX_DEVICE_CODE_STDOUT);
    manager.cancel(PROFILE_DIR);

    children[0].emitExit(0);
    await Promise.resolve();

    expect(verify).not.toHaveBeenCalled();
    expect(manager.status(PROFILE_DIR)?.phase).toBe('cancelled');
  });

  test('cancelling nothing reports nothing rather than inventing a record', async () => {
    const { manager } = harness();
    expect(manager.cancel(PROFILE_DIR)).toBeUndefined();
  });

  test('a cancelled profile can start a new login', async () => {
    const { manager, children, spawnLogin } = harness();
    await manager.start('codex', PROFILE_DIR);
    manager.cancel(PROFILE_DIR);

    const restarted = await manager.start('codex', PROFILE_DIR);

    expect(restarted.kind).toBe('started');
    expect(spawnLogin).toHaveBeenCalledTimes(2);
    expect(children).toHaveLength(2);
  });
});
