import { getEventListeners } from 'node:events';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as nodeResolve } from 'node:path';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import { describe, expect, test, vi } from 'vitest';
import { acpProviderRoutingStatus } from '../../connections/connection-service-helpers.js';
import { getACPManagerStatus } from '../acp-manager-view.js';
import { ACPProbe, MAX_CLEANUP_RETRY_ATTEMPTS } from '../acp-probe.js';
import { ACPProcess } from '../acp-process.js';

describe('ACPProbe', () => {
  test.each([
    ['explicit probe capabilities', {}, {}],
    [
      'omitted interactive capabilities',
      undefined,
      {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    ],
  ])(
    'ACPProcess initialize wire preserves %s',
    async (_name, clientCapabilities, expected) => {
      const directory = mkdtempSync(join(tmpdir(), 'station-acp-init-wire-'));
      const agentPath = join(directory, 'agent.cjs');
      const capturePath = join(directory, 'initialize.json');
      writeFileSync(
        agentPath,
        `
const fs = require('node:fs');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method !== 'initialize') continue;
    fs.writeFileSync(process.argv[2], JSON.stringify(request.params.clientCapabilities));
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: { protocolVersion: 1, agentCapabilities: {} },
    }) + '\\n');
  }
});
`,
      );
      const acpProcess = new ACPProcess({
        command: process.execPath,
        args: [agentPath, capturePath],
        cwd: directory,
        createClient: () => ({}) as any,
        ...(clientCapabilities === undefined ? {} : { clientCapabilities }),
        logger: { debug: vi.fn(), warn: vi.fn() },
      });
      try {
        await expect(acpProcess.start()).resolves.toMatchObject({
          protocolVersion: 1,
        });
        expect(JSON.parse(readFileSync(capturePath, 'utf8'))).toEqual(expected);
      } finally {
        await acpProcess.destroy();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  test('escalates a failed cleanup to a group SIGKILL instead of abandoning it (#1863)', async () => {
    let destroyError: Error | undefined = new Error('cleanup not confirmed');
    const forceGroupKill = vi.fn();
    const process = {
      start: vi.fn().mockResolvedValue({ protocolVersion: 1 }),
      newSession: vi.fn().mockResolvedValue({
        sessionId: 'probe-session',
        modes: { availableModes: [] },
        configOptions: [],
      }),
      destroy: vi.fn(async () => {
        if (destroyError) throw destroyError;
      }),
      forceGroupKill,
      // Cleanup worked: the child is gone (archive#3422 keeps survivors).
      survivesCleanup: () => false,
      releaseIfConfirmedGone: () => {},
    };
    const processFactory = vi.fn(() => process as unknown as ACPProcess);
    const logger = { warn: vi.fn() };
    const config: ACPConnectionConfig = {
      id: 'kiro',
      name: 'Kiro',
      command: 'kiro-cli',
      enabled: true,
    };
    const probe = new ACPProbe(config, logger, '/tmp/project', processFactory);

    await expect(probe.probe()).resolves.toBe(false);
    expect(processFactory).toHaveBeenCalledOnce();
    // destroy is invoked twice: once in the deadline race, then again after
    // the escalation so the process's internal state can converge.
    expect(process.destroy).toHaveBeenCalledTimes(2);
    // archive#1863: a destroy that fails no longer leaks — it escalates to an
    // unconditional group SIGKILL rather than being silently abandoned.
    expect(forceGroupKill).toHaveBeenCalledOnce();

    // The escalated process is reaped, so dispose converges without retrying
    // a dead process.
    destroyError = undefined;
    await expect(probe.dispose()).resolves.toBeUndefined();
  });

  test('shutdown waits for an active probe and owns its process immediately', async () => {
    let releaseStart!: (value: { protocolVersion: number }) => void;
    const start = new Promise<{ protocolVersion: number }>((resolve) => {
      releaseStart = resolve;
    });
    const process = {
      start: vi.fn(() => start),
      newSession: vi.fn(),
      destroy: vi.fn().mockResolvedValue(undefined),
      survivesCleanup: () => false,
      releaseIfConfirmedGone: () => {},
    };
    const probe = new ACPProbe(
      {
        id: 'kiro',
        name: 'Kiro',
        command: 'kiro-cli',
        enabled: true,
      },
      { warn: vi.fn() },
      '/tmp/project',
      () => process as unknown as ACPProcess,
    );

    const activeProbe = probe.probe();
    await vi.waitFor(() => expect(process.start).toHaveBeenCalledOnce());
    let disposed = false;
    const disposal = probe.dispose().then(() => {
      disposed = true;
    });
    await vi.waitFor(() => expect(process.destroy).toHaveBeenCalled());
    expect(disposed).toBe(false);

    releaseStart({ protocolVersion: 1 });
    await expect(activeProbe).resolves.toBe(false);
    await disposal;

    expect(disposed).toBe(true);
    expect(process.newSession).not.toHaveBeenCalled();
    await expect(probe.probe()).resolves.toBe(false);
  });

  test('bounds a hung handshake and disposes without external release', async () => {
    const process = {
      start: vi.fn(() => new Promise(() => {})),
      newSession: vi.fn(),
      destroy: vi.fn().mockResolvedValue(undefined),
      survivesCleanup: () => false,
      releaseIfConfirmedGone: () => {},
    };
    const probe = new ACPProbe(
      {
        id: 'kiro',
        name: 'Kiro',
        command: 'kiro-cli',
        enabled: true,
      },
      { warn: vi.fn() },
      '/tmp/project',
      () => process as unknown as ACPProcess,
      10,
    );
    // archive#3404: `probe()` defaults to the `'request'` initiator, which
    // never takes the 60s cold budget — so this never-settling handshake is
    // bounded at the 10ms budget above and the claim under test (a hung
    // handshake is bounded and the process reaped) needs no special setup.
    await expect(probe.probe()).resolves.toBe(false);
    expect(process.destroy).toHaveBeenCalledOnce();
    await expect(probe.dispose()).resolves.toBeUndefined();
    expect(process.newSession).not.toHaveBeenCalled();
  });

  test('bounds asynchronous command discovery before a process is spawned', async () => {
    const probe = new ACPProbe(
      {
        id: 'kiro',
        name: 'Kiro',
        command: 'kiro-cli',
        enabled: true,
      },
      { warn: vi.fn(), debug: vi.fn() },
      '/tmp/project',
      (options) =>
        new ACPProcess({
          ...options,
          resolveCommand: () => new Promise<string | null>(() => {}),
        }),
      10,
    );
    // archive#3404: `probe()` defaults to the `'request'` initiator, so this
    // runs on the 10ms budget rather than the 60s cold one, preserving the
    // test's claim: discovery is bounded before a process is spawned.
    await expect(probe.probe()).resolves.toBe(false);
    await expect(probe.dispose()).resolves.toBeUndefined();
  });

  test('does not spawn after destruction while command discovery is pending', async () => {
    let resolveCommand!: (path: string | null) => void;
    const command = new Promise<string | null>((resolve) => {
      resolveCommand = resolve;
    });
    const process = new ACPProcess({
      command: 'kiro-cli',
      cwd: '/tmp/project',
      createClient: () => ({}) as any,
      logger: { debug: vi.fn() },
      resolveCommand: () => command,
    });

    const starting = process.start();
    await process.destroy();
    resolveCommand('/usr/local/bin/kiro-cli');

    await expect(starting).rejects.toThrow('ACPProcess already destroyed');
    expect(process.isAlive).toBe(false);
  });

  test('caches the full initialize agentCapabilities (loadSession, mcpCapabilities, sessionCapabilities) across probe success and staleness', async () => {
    const agentCapabilities = {
      loadSession: true,
      promptCapabilities: { image: true },
      mcpCapabilities: { http: true, sse: false },
      sessionCapabilities: { resume: {} },
      providers: {},
    };
    const process = {
      start: vi.fn().mockResolvedValue({
        protocolVersion: 1,
        agentCapabilities,
        providerRouting: [
          {
            providerId: 'main',
            supported: ['openai'],
            required: false,
            current: null,
          },
        ],
      }),
      newSession: vi.fn().mockResolvedValue({
        sessionId: 'probe-session',
        modes: { availableModes: [] },
        configOptions: [],
      }),
      destroy: vi.fn().mockResolvedValue(undefined),
      survivesCleanup: () => false,
      releaseIfConfirmedGone: () => {},
    };
    const config: ACPConnectionConfig = {
      id: 'kiro',
      name: 'Kiro',
      command: 'kiro-cli',
      enabled: true,
    };
    const probe = new ACPProbe(
      config,
      { warn: vi.fn() },
      '/tmp/project',
      () => process as unknown as ACPProcess,
    );

    await expect(probe.probe()).resolves.toBe(true);
    expect(probe.getAgentCapabilities()).toEqual(agentCapabilities);
    expect(probe.getProviderRouting()).toEqual([
      {
        providerId: 'main',
        supported: ['openai'],
        required: false,
        current: null,
      },
    ]);

    // A later failed probe retains the stale cache (mirrors
    // cachedCapabilities/cachedModes' existing stale-retention behavior).
    process.start.mockRejectedValueOnce(new Error('handshake failed'));
    await expect(probe.probe()).resolves.toBe(false);
    expect(probe.getAgentCapabilities()).toEqual(agentCapabilities);
    expect(probe.getProviderRouting()).toHaveLength(1);
  });

  test('does not report a committed provider mutation as failed when readback refresh fails', async () => {
    const process = {
      start: vi
        .fn()
        .mockResolvedValueOnce({
          protocolVersion: 1,
          agentCapabilities: { providers: {} },
          providerRouting: [],
        })
        .mockRejectedValueOnce(new Error('refresh failed')),
      setProvider: vi.fn().mockResolvedValue(undefined),
      newSession: vi.fn(),
      destroy: vi.fn().mockResolvedValue(undefined),
      survivesCleanup: vi.fn().mockResolvedValue(false),
      releaseIfConfirmedGone: vi.fn(),
    };
    const logger = { warn: vi.fn() };
    const probe = new ACPProbe(
      {
        id: 'opencode',
        name: 'OpenCode',
        command: 'opencode',
        cwd: '/tmp/provider-routing',
        enabled: true,
      },
      logger,
      '/tmp/project',
      () => process as unknown as ACPProcess,
    );

    await expect(
      probe.setProvider({
        providerId: 'main',
        apiType: 'openai',
        baseUrl: 'https://openrouter.ai/api/v1',
        headers: { Authorization: 'Bearer transient' },
      }),
    ).resolves.toBeUndefined();
    expect(process.setProvider).toHaveBeenCalledOnce();
    expect(process.start).toHaveBeenCalledTimes(2);
    expect(probe.getProviderRoutingCurrent()).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      'ACP provider mutation succeeded; refresh failed',
      { id: 'opencode' },
    );
  });

  test('an indeterminate mutation timeout fences routing and makes stale cache non-authoritative', async () => {
    let settleMutation!: () => void;
    const lateResponse = new Promise<void>((resolve) => {
      settleMutation = resolve;
    });
    let externalDestination = 'https://old.example/v1';
    const observedProcess = {
      start: vi.fn().mockResolvedValue({
        protocolVersion: 1,
        agentCapabilities: { providers: {} },
        providerRouting: [
          {
            providerId: 'main',
            supported: ['openai'],
            required: false,
            current: { apiType: 'openai', baseUrl: externalDestination },
          },
        ],
      }),
      newSession: vi.fn().mockResolvedValue({
        sessionId: 'observed',
        modes: { availableModes: [] },
        configOptions: [],
      }),
      destroy: vi.fn().mockResolvedValue(undefined),
      survivesCleanup: vi.fn().mockResolvedValue(false),
      releaseIfConfirmedGone: vi.fn(),
    };
    const mutationProcess = {
      start: vi.fn().mockResolvedValue({
        protocolVersion: 1,
        agentCapabilities: { providers: {} },
        providerRouting: [],
      }),
      setProvider: vi.fn(() => {
        externalDestination = 'https://new.example/v1';
        return lateResponse;
      }),
      destroy: vi.fn().mockResolvedValue(undefined),
      survivesCleanup: vi.fn().mockResolvedValue(false),
      releaseIfConfirmedGone: vi.fn(),
    };
    const processFactory = vi
      .fn()
      .mockReturnValueOnce(observedProcess)
      .mockReturnValueOnce(mutationProcess);
    const probe = new ACPProbe(
      {
        id: 'opencode',
        name: 'OpenCode',
        command: 'opencode',
        cwd: '/tmp/provider-routing',
        enabled: true,
      },
      { warn: vi.fn() },
      '/tmp/project',
      processFactory as never,
      20,
    );

    await expect(probe.probe()).resolves.toBe(true);
    expect(probe.getProviderRoutingCurrent()).toBe(true);
    expect(() => probe.assertProviderSupported('main', 'anthropic')).toThrow(
      'did not advertise protocol',
    );
    await expect(
      probe.setProvider({
        providerId: 'main',
        apiType: 'openai',
        baseUrl: 'https://new.example/v1',
      }),
    ).rejects.toThrow('provider mutation did not settle');
    expect(externalDestination).toBe('https://new.example/v1');
    expect(probe.getProviderRoutingCurrent()).toBe(false);
    expect(() =>
      probe.assertProviderSupported('main', 'anthropic'),
    ).not.toThrow();
    const managerStatus = getACPManagerStatus(
      new Map([['opencode', probe]]),
      new Map([
        [
          'opencode',
          {
            id: 'opencode',
            name: 'OpenCode',
            command: 'opencode',
            enabled: true,
          },
        ],
      ]),
      0,
    );
    expect(
      acpProviderRoutingStatus(managerStatus.connections[0]),
    ).toMatchObject({
      source: 'stale',
      reason: expect.stringContaining('no post-mutation observation'),
    });

    settleMutation();
    await lateResponse;
    expect(probe.getProviderRoutingCurrent()).toBe(false);
  });

  /**
   * archive#1088. Measured on origin/main (1e5b45d2) with a stub ACP CLI that
   * logs its own `getcwd`: adding a connection with no `cwd` spawned it in
   * `/Users/brian/dev/github/kontourai/station-worktrees/s1088-acp` — the
   * Station checkout — and repeated on the 60s `probeTimer` with no chat
   * session in existence (`lsof -a -p <pid> -d cwd` on the live child agreed).
   */
  describe('#1088 probe working directory', () => {
    const probeProcess = () => ({
      start: vi.fn().mockResolvedValue({ protocolVersion: 1 }),
      newSession: vi.fn().mockResolvedValue({
        sessionId: 'probe-session',
        modes: { availableModes: [] },
        configOptions: [],
      }),
      destroy: vi.fn().mockResolvedValue(undefined),
      survivesCleanup: () => false,
      releaseIfConfirmedGone: () => {},
    });

    test('spawns and opens its session in the SAME directory when the connection configures one', async () => {
      const process = probeProcess();
      const processFactory = vi.fn(
        (_options: ConstructorParameters<typeof ACPProcess>[0]) =>
          process as unknown as ACPProcess,
      );
      const probe = new ACPProbe(
        {
          id: 'kiro',
          name: 'Kiro',
          command: 'kiro-cli',
          cwd: '/tmp/connection-dir',
          enabled: true,
        },
        { warn: vi.fn() },
        '/home/tester',
        processFactory,
      );

      await expect(probe.probe()).resolves.toBe(true);

      expect(processFactory.mock.calls[0][0]).toMatchObject({
        cwd: '/tmp/connection-dir',
      });
      // The bug this pins: `newSession` was handed the fallback while the
      // spawn used the connection directory, so the CLI ran in one place and
      // was told its session lived in another.
      expect(process.newSession).toHaveBeenCalledWith('/tmp/connection-dir');
    });

    test('resolves a RELATIVE connection directory instead of spawning against Station itself', async () => {
      // Review of archive#1135: the tilde case was fixed, the relative case was not.
      // `config.cwd` is free text and the route schema is
      // `cwd: z.string().optional()` with no shape validation, so `"."` is
      // accepted — and unresolved, `spawn` interprets it against Station's own
      // directory, landing the agent in the install root. That is the exact
      // outcome archive#1088 is named after, reached by a second route. `".."` walks
      // further out. `session/new` was also handed the bare relative string,
      // which means something different to the agent than to Station.
      const process = probeProcess();
      const processFactory = vi.fn(
        (_options: ConstructorParameters<typeof ACPProcess>[0]) =>
          process as unknown as ACPProcess,
      );
      const probe = new ACPProbe(
        {
          id: 'kiro',
          name: 'Kiro',
          command: 'kiro-cli',
          cwd: '.',
          enabled: true,
        },
        { warn: vi.fn() },
        '/home/tester',
        processFactory,
      );

      await expect(probe.probe()).resolves.toBe(true);

      const spawned = processFactory.mock.calls[0][0].cwd;
      expect(spawned).toBe(nodeResolve('.'));
      expect(spawned).not.toBe('.');
      // Spawn and session must still agree, as the sibling test pins.
      expect(process.newSession).toHaveBeenCalledWith(spawned);
    });

    test('expands a tilde in the connection directory instead of handing spawn a relative path', async () => {
      const process = probeProcess();
      const processFactory = vi.fn(
        (_options: ConstructorParameters<typeof ACPProcess>[0]) =>
          process as unknown as ACPProcess,
      );
      const probe = new ACPProbe(
        {
          id: 'kiro',
          name: 'Kiro',
          command: 'kiro-cli',
          cwd: '~/work',
          enabled: true,
        },
        { warn: vi.fn() },
        '/home/tester',
        processFactory,
      );

      await expect(probe.probe()).resolves.toBe(true);

      const spawned = processFactory.mock.calls[0][0].cwd;
      expect(spawned.startsWith('~')).toBe(false);
      expect(spawned.endsWith('/work')).toBe(true);
      expect(process.newSession).toHaveBeenCalledWith(spawned);
    });

    test('uses a managed probe workspace when the connection configures an EMPTY cwd', async () => {
      // The connection form persists `cwd: ""` for an untouched Working
      // Directory field, and `spawn` reads `cwd: ''` as "inherit the
      // parent's" — the exact behavior this chain exists to stop. `??` let
      // that empty string win.
      const process = probeProcess();
      const processFactory = vi.fn(
        (_options: ConstructorParameters<typeof ACPProcess>[0]) =>
          process as unknown as ACPProcess,
      );
      const stationHome = mkdtempSync(join(tmpdir(), 'station-acp-probe-'));
      const probe = new ACPProbe(
        {
          id: 'kiro',
          name: 'Kiro',
          command: 'kiro-cli',
          cwd: '',
          enabled: true,
        },
        { warn: vi.fn() },
        stationHome,
        processFactory,
      );

      try {
        await expect(probe.probe()).resolves.toBe(true);

        const cwd = processFactory.mock.calls[0][0].cwd;
        expect(cwd).toContain('/runtime/acp-workspaces/probe/');
        expect(process.newSession).toHaveBeenCalledWith(cwd);
      } finally {
        rmSync(stationHome, { recursive: true, force: true });
      }
    });

    test('reuses one probe workspace per connection and isolates different connections', async () => {
      const stationHome = mkdtempSync(join(tmpdir(), 'station-acp-probe-'));
      const processes = [probeProcess(), probeProcess(), probeProcess()];
      const processFactory = vi.fn(
        (_options: ConstructorParameters<typeof ACPProcess>[0]) =>
          processes.shift() as unknown as ACPProcess,
      );
      const first = new ACPProbe(
        { id: 'first', name: 'First', command: 'first', enabled: true },
        { warn: vi.fn() },
        stationHome,
        processFactory,
      );
      const second = new ACPProbe(
        { id: 'second', name: 'Second', command: 'second', enabled: true },
        { warn: vi.fn() },
        stationHome,
        processFactory,
      );

      try {
        await first.probe();
        await first.probe();
        await second.probe();
        const [firstCwd, repeatedCwd, secondCwd] =
          processFactory.mock.calls.map(([options]) => options.cwd);
        expect(repeatedCwd).toBe(firstCwd);
        expect(secondCwd).not.toBe(firstCwd);
      } finally {
        rmSync(stationHome, { recursive: true, force: true });
      }
    });

    test('workspace preparation failure fails closed before process construction', async () => {
      const stationHome = mkdtempSync(join(tmpdir(), 'station-acp-probe-'));
      const outside = mkdtempSync(join(tmpdir(), 'station-acp-probe-outside-'));
      const runtime = join(stationHome, 'runtime');
      symlinkSync(outside, runtime, 'dir');
      const processFactory = vi.fn();
      const probe = new ACPProbe(
        { id: 'kiro', name: 'Kiro', command: 'kiro-cli', enabled: true },
        { warn: vi.fn() },
        stationHome,
        processFactory as never,
      );

      try {
        await expect(probe.probe()).resolves.toBe(false);
        expect(processFactory).not.toHaveBeenCalled();
      } finally {
        rmSync(stationHome, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });

    test('configured cwd wins even when managed workspace preparation would fail', async () => {
      const stationHomeParent = mkdtempSync(
        join(tmpdir(), 'station-acp-probe-'),
      );
      const invalidHome = join(stationHomeParent, 'occupied');
      writeFileSync(invalidHome, 'not a directory');
      const process = probeProcess();
      const processFactory = vi.fn(() => process as unknown as ACPProcess);
      const probe = new ACPProbe(
        {
          id: 'kiro',
          name: 'Kiro',
          command: 'kiro-cli',
          cwd: '/tmp',
          enabled: true,
        },
        { warn: vi.fn() },
        invalidHome,
        processFactory,
      );

      try {
        await expect(probe.probe()).resolves.toBe(true);
        expect(processFactory).toHaveBeenCalledWith(
          expect.objectContaining({ cwd: '/tmp' }),
        );
        expect(process.newSession).toHaveBeenCalledWith('/tmp');
      } finally {
        rmSync(stationHomeParent, { recursive: true, force: true });
      }
    });
  });

  test('a destroy that cannot complete escalates to a group SIGKILL, not abandonment (#1863)', async () => {
    // destroy rejects (a destroy that cannot settle) — the old code abandoned
    // it via runWithinProbeDeadline's swallow. The fix escalates.
    const forceGroupKill = vi.fn();
    const process = {
      start: vi.fn().mockResolvedValue({ protocolVersion: 1 }),
      newSession: vi.fn().mockResolvedValue({
        sessionId: 'probe-session',
        modes: { availableModes: [] },
        configOptions: [],
      }),
      destroy: vi.fn().mockRejectedValue(new Error('destroy unreachable')),
      forceGroupKill,
      // Cleanup worked: the child is gone (archive#3422 keeps survivors).
      survivesCleanup: () => false,
      releaseIfConfirmedGone: () => {},
    };
    const probe = new ACPProbe(
      {
        id: 'kiro',
        name: 'Kiro',
        command: 'kiro-cli',
        enabled: true,
      },
      { warn: vi.fn() },
      '/tmp/project',
      () => process as unknown as ACPProcess,
    );

    await expect(probe.probe()).resolves.toBe(false);
    // The escalation fired, so the engine is not left running.
    expect(forceGroupKill).toHaveBeenCalledOnce();
    // dispose converges (nothing retained to retry).
    await expect(probe.dispose()).resolves.toBeUndefined();
  });

  describe('station#1549: dating the agentCapabilities observation', () => {
    function makeProbe(process: any, timeoutMs = 1000) {
      return new ACPProbe(
        {
          id: 'kiro',
          name: 'Kiro',
          command: 'kiro-cli',
          enabled: true,
        } as ACPConnectionConfig,
        { warn: vi.fn() },
        '/tmp/project',
        () => process as unknown as ACPProcess,
        timeoutMs,
      );
    }

    test('a successful handshake stamps the observation instant alongside the capabilities', async () => {
      const process = {
        start: vi.fn().mockResolvedValue({
          protocolVersion: 1,
          agentCapabilities: { mcpCapabilities: { http: true } },
        }),
        newSession: vi.fn().mockResolvedValue({
          sessionId: 's',
          modes: { availableModes: [] },
          configOptions: [],
        }),
        destroy: vi.fn().mockResolvedValue(undefined),
        survivesCleanup: () => false,
        releaseIfConfirmedGone: () => {},
      };
      const probe = makeProbe(process);
      const before = Date.now();
      await expect(probe.probe()).resolves.toBe(true);
      const observedAt = probe.getHandshakeObservedAt();
      expect(observedAt).toBeGreaterThanOrEqual(before);
      expect(observedAt).toBeLessThanOrEqual(Date.now());
      await probe.dispose();
    });

    test('a FAILED probe that retains the stale cache does NOT re-date it — the observation is the handshake, not the attempt', async () => {
      // This is the whole reason the timestamp is not `lastProbeAt`: the
      // retain-stale-cache branch below bumps `lastProbeAt` while leaving
      // the capabilities untouched, so a `lastProbeAt`-derived date would
      // claim an observation that never happened.
      let fail = false;
      const process = {
        start: vi.fn(async () => {
          if (fail) throw new Error('spawn failed');
          return {
            protocolVersion: 1,
            agentCapabilities: { mcpCapabilities: { http: true } },
          };
        }),
        newSession: vi.fn().mockResolvedValue({
          sessionId: 's',
          modes: { availableModes: [] },
          configOptions: [],
        }),
        destroy: vi.fn().mockResolvedValue(undefined),
        survivesCleanup: () => false,
        releaseIfConfirmedGone: () => {},
      };
      const probe = makeProbe(process);
      await expect(probe.probe()).resolves.toBe(true);
      const firstObservedAt = probe.getHandshakeObservedAt();
      expect(firstObservedAt).toBeGreaterThan(0);

      fail = true;
      await new Promise((resolve) => setTimeout(resolve, 2));
      await expect(probe.probe()).resolves.toBe(false);

      expect(probe.getAgentCapabilities()).not.toBeNull();
      expect(probe.getHandshakeObservedAt()).toBe(firstObservedAt);
      expect(probe.lastProbeAt).toBeGreaterThan(firstObservedAt);
      await probe.dispose();
    });

    test('a probe that never succeeded clears the timestamp with the cache — no dangling date', async () => {
      const process = {
        start: vi.fn().mockRejectedValue(new Error('nope')),
        newSession: vi.fn(),
        destroy: vi.fn().mockResolvedValue(undefined),
        survivesCleanup: () => false,
        releaseIfConfirmedGone: () => {},
      };
      const probe = makeProbe(process);
      await expect(probe.probe()).resolves.toBe(false);
      expect(probe.getAgentCapabilities()).toBeNull();
      expect(probe.getHandshakeObservedAt()).toBe(0);
      await probe.dispose();
    });
  });
});

describe("ACPProbe's client does not fabricate extension answers", () => {
  test('advertises no fs/terminal support and refuses every undeclared callback', async () => {
    let client: any;
    let processOptions: ConstructorParameters<typeof ACPProcess>[0] | undefined;
    const process = {
      start: vi.fn().mockResolvedValue({ protocolVersion: 1 }),
      newSession: vi.fn().mockResolvedValue({
        sessionId: 'probe-session',
        modes: { availableModes: [] },
        configOptions: [],
      }),
      destroy: vi.fn().mockResolvedValue(undefined),
      survivesCleanup: () => false,
      releaseIfConfirmedGone: () => {},
    };
    const probe = new ACPProbe(
      { id: 'kiro', name: 'Kiro', command: 'kiro-cli', enabled: true },
      { warn: vi.fn() },
      '/tmp/project',
      (options) => {
        processOptions = options;
        client = options.createClient(undefined as never);
        return process as unknown as ACPProcess;
      },
    );

    await expect(probe.probe()).resolves.toBe(true);
    expect(processOptions?.clientCapabilities).toEqual({});

    const requests = [
      () => client.readTextFile({ path: '/workspace/a' }),
      () => client.writeTextFile({ path: '/workspace/a', content: 'changed' }),
      () => client.createTerminal({ command: 'touch', args: ['sentinel'] }),
      () => client.terminalOutput({ terminalId: 'not-created' }),
      () => client.releaseTerminal({ terminalId: 'not-created' }),
      () => client.waitForTerminalExit({ terminalId: 'not-created' }),
      () => client.killTerminal({ terminalId: 'not-created' }),
    ];
    for (const request of requests) {
      await expect(request()).rejects.toMatchObject({ code: -32601 });
    }

    await probe.dispose();
  });

  test('an inbound extension request during a probe is refused with -32601', async () => {
    // Kiro under `--agent-engine v3` sends its token-refresh callback
    // `_kiro/auth/getAccessToken` to the CLIENT before it answers
    // `initialize` — inside the probe's lifetime, not just the chat
    // adapter's. This client used to answer it with `{}`.
    let client: any;
    const process = {
      start: vi.fn(async function (this: unknown) {
        return { protocolVersion: 1 };
      }),
      newSession: vi.fn().mockResolvedValue({
        sessionId: 'probe-session',
        modes: { availableModes: [] },
        configOptions: [],
      }),
      destroy: vi.fn().mockResolvedValue(undefined),
      survivesCleanup: () => false,
      releaseIfConfirmedGone: () => {},
    };
    const warn = vi.fn();
    const probe = new ACPProbe(
      { id: 'kiro', name: 'Kiro', command: 'kiro-cli', enabled: true },
      { warn },
      '/tmp/project',
      (options) => {
        client = options.createClient(undefined as never);
        return process as unknown as ACPProcess;
      },
    );

    await probe.probe();
    expect(client).toBeDefined();

    await expect(
      client.extMethod('_kiro/auth/getAccessToken', {}),
    ).rejects.toMatchObject({ code: -32601 });
    await expect(
      client.extMethod('_kiro/terminal/shell_type', {}),
    ).rejects.toMatchObject({ code: -32601 });
    expect(
      warn.mock.calls.some(
        (call) =>
          (call[1] as { method?: string } | undefined)?.method ===
          '_kiro/auth/getAccessToken',
      ),
    ).toBe(true);

    await probe.dispose();
  });

  test('re-probing does NOT re-log the same refusal — one handler per probe, not per run', async () => {
    // acp-manager re-probes every connection every 60s with no staleness
    // gate, and a v3 connection refuses on every single run. If the handler
    // were rebuilt per run its dedupe could never fire, and this would be
    // one identical warning per connection per minute, forever.
    //
    // This test exists because the fault injection that reverted the
    // per-instance handler to a per-run one was UNCAUGHT by the suite.
    const clients: any[] = [];
    const process = {
      start: vi.fn().mockResolvedValue({ protocolVersion: 1 }),
      newSession: vi.fn().mockResolvedValue({
        sessionId: 'probe-session',
        modes: { availableModes: [] },
        configOptions: [],
      }),
      destroy: vi.fn().mockResolvedValue(undefined),
      survivesCleanup: () => false,
      releaseIfConfirmedGone: () => {},
    };
    const warn = vi.fn();
    const probe = new ACPProbe(
      { id: 'kiro', name: 'Kiro', command: 'kiro-cli', enabled: true },
      { warn },
      '/tmp/project',
      (options) => {
        clients.push(options.createClient(undefined as never));
        return process as unknown as ACPProcess;
      },
    );

    await probe.probe();
    await clients[0].extMethod('_kiro/auth/getAccessToken', {}).catch(() => {});
    await probe.probe();
    await clients[1].extMethod('_kiro/auth/getAccessToken', {}).catch(() => {});

    expect(clients).toHaveLength(2);
    const refusalLogs = warn.mock.calls.filter(
      (call) =>
        (call[1] as { method?: string } | undefined)?.method ===
        '_kiro/auth/getAccessToken',
    );
    expect(refusalLogs).toHaveLength(1);

    await probe.dispose();
  });
});

// archive#3403: a probe that has NEVER succeeded discarded its error entirely
// -- the catch block logged only on the branch where a previous probe had
// succeeded. The connection then reported "unavailable" with no reason in the
// log, none in the API projection, and no way to reach one.
describe('a failing probe says why', () => {
  function failingProbe(err: Error) {
    const process = {
      start: vi.fn(async () => {
        throw err;
      }),
      newSession: vi.fn(async () => ({
        modes: { availableModes: [] },
        configOptions: [],
      })),
      destroy: vi.fn(async () => {}),
      forceGroupKill: vi.fn(),
      // Cleanup worked: the child is gone (archive#3422 keeps survivors).
      survivesCleanup: () => false,
      releaseIfConfirmedGone: () => {},
    };
    const logger = { warn: vi.fn() };
    const config: ACPConnectionConfig = {
      id: 'opencode',
      name: 'OpenCode',
      command: '/opt/engines/opencode',
      enabled: true,
    };
    const probe = new ACPProbe(
      config,
      logger,
      '/tmp/project',
      vi.fn(() => process as unknown as ACPProcess),
    );
    return { probe, logger };
  }

  test('logs the first failure, when there is no cache to retain', async () => {
    const { probe, logger } = failingProbe(new Error('spawn ENOENT'));

    await expect(probe.probe()).resolves.toBe(false);

    // The point of the fix: a never-succeeded probe reaches the log at all.
    expect(logger.warn).toHaveBeenCalled();
    const logged = logger.warn.mock.calls.map(([message]) => String(message));
    expect(logged.some((message) => /no cache to retain/i.test(message))).toBe(
      true,
    );
    await probe.dispose();
  });

  test('records the reason and the phase it failed in', async () => {
    const { probe } = failingProbe(new Error('spawn ENOENT'));

    await expect(probe.probe()).resolves.toBe(false);

    expect(probe.lastError).toMatchObject({
      message: expect.stringContaining('ENOENT'),
      phase: 'initialize',
    });
    await probe.dispose();
  });

  test('redacts a secret the engine echoed back in its error text', async () => {
    // An engine that fails to start routinely quotes its own command line, and
    // a connection's args are operator-supplied. The reason is projected into
    // an API response, so it must not carry the token through.
    const { probe } = failingProbe(
      new Error('spawn failed: opencode --api-key=sk-live-abcdef1234567890'),
    );

    await expect(probe.probe()).resolves.toBe(false);

    expect(probe.lastError?.message).not.toContain('sk-live-abcdef1234567890');
    await probe.dispose();
  });

  test('clears the reason once a probe succeeds', async () => {
    const process = {
      start: vi.fn(async () => ({ agentCapabilities: {} })),
      newSession: vi.fn(async () => ({
        modes: { availableModes: [] },
        configOptions: [],
      })),
      destroy: vi.fn(async () => {}),
      forceGroupKill: vi.fn(),
      // Cleanup worked: the child is gone (archive#3422 keeps survivors).
      survivesCleanup: () => false,
      releaseIfConfirmedGone: () => {},
    };
    const probe = new ACPProbe(
      {
        id: 'opencode',
        name: 'OpenCode',
        command: '/opt/engines/opencode',
        enabled: true,
      } as ACPConnectionConfig,
      { warn: vi.fn() },
      '/tmp/project',
      vi.fn(() => process as unknown as ACPProcess),
    );
    probe.lastError = { message: 'stale', phase: 'initialize' };

    await expect(probe.probe()).resolves.toBe(true);

    // "Unavailable with no reason" must not be able to outlive the failure --
    // and neither may a reason outlive the recovery.
    expect(probe.lastError).toBeNull();
    await probe.dispose();
  });
});

// archive#3422: `pendingCleanup` is named for retrying and used to forget. It
// dropped every entry unconditionally, and destroyProcessWithEscalation never
// throws -- it catches and escalates -- so an engine that SURVIVED its own
// reaping was indistinguishable from one that died and was removed from the
// only list that would have brought Station back to it.
describe('an engine that survives cleanup is retried, not forgotten', () => {
  // A DISTINCT process per spawn, so "the first child was revisited" is
  // distinguishable from "the second child was cleaned up" — the same mock for
  // both cycles cannot tell those apart.
  function probeSpawning(survives: boolean) {
    const spawned: Array<{
      destroy: ReturnType<typeof vi.fn>;
      survivesCleanup: ReturnType<typeof vi.fn>;
    }> = [];
    const logger = { warn: vi.fn() };
    const factory = vi.fn(() => {
      const proc = {
        start: vi.fn(async () => {
          throw new Error('spawn ENOENT');
        }),
        newSession: vi.fn(async () => ({
          modes: { availableModes: [] },
          configOptions: [],
        })),
        destroy: vi.fn(async () => {}),
        forceGroupKill: vi.fn(),
        survivesCleanup: vi.fn(() => survives),
        releaseIfConfirmedGone: vi.fn(),
      };
      spawned.push(proc);
      return proc as unknown as ACPProcess;
    });
    const probe = new ACPProbe(
      {
        id: 'opencode',
        name: 'OpenCode',
        command: '/opt/engines/opencode',
        enabled: true,
      } as ACPConnectionConfig,
      logger,
      '/tmp/project',
      factory,
    );
    return { probe, spawned, logger };
  }

  test('revisits a survivor on the next probe instead of dropping it', async () => {
    const { probe, spawned, logger } = probeSpawning(true);

    await probe.probe();
    const firstChildDestroys = spawned[0].destroy.mock.calls.length;
    await probe.probe();

    // The FIRST child — the one that survived — is destroyed again.
    expect(spawned[0].destroy.mock.calls.length).toBeGreaterThan(
      firstChildDestroys,
    );
    expect(
      logger.warn.mock.calls.some(([message]) =>
        /survived cleanup/i.test(String(message)),
      ),
    ).toBe(true);
    await probe.dispose();
  });

  test('a reaped engine is never revisited', async () => {
    const { probe, spawned } = probeSpawning(false);

    await probe.probe();
    const firstChildDestroys = spawned[0].destroy.mock.calls.length;
    await probe.probe();

    // Cycle two spawns its own child; the first must be left alone, or a
    // healthy connection accumulates work proportional to its uptime.
    expect(spawned[0].destroy.mock.calls.length).toBe(firstChildDestroys);
    expect(spawned.length).toBe(2);
    await probe.dispose();
  });

  // archive#3441: retryPendingCleanup used to retry a survivor forever. A
  // systematically unkillable engine therefore added one entry per cycle and
  // every cycle re-attempted every entry still pending -- unbounded cost on
  // a set that never shrinks. This proves the bound: after
  // MAX_CLEANUP_RETRY_ATTEMPTS destroy attempts, Station stops paying for it.
  test('gives up on a permanently unkillable survivor after the retry bound instead of retrying forever', async () => {
    const { probe, spawned, logger } = probeSpawning(true);

    // Cycle 1 spawns the survivor and makes its first (0th->1st) destroy
    // attempt in runProbe's own finally block.
    await probe.probe();
    // Each further cycle's retryPendingCleanup makes one more attempt on the
    // SAME first survivor (this connection's later spawns also fail to
    // start, but only the first child is the one under the retention cap
    // since every later probe's OWN process also survives and is retained --
    // we only assert on spawned[0], which crosses the bound first).
    for (let i = 0; i < MAX_CLEANUP_RETRY_ATTEMPTS; i++) {
      await probe.probe();
    }

    // spawned[0] was attempted exactly MAX_CLEANUP_RETRY_ATTEMPTS times: once
    // in its own runProbe finally, then once per subsequent retryPendingCleanup
    // call until the bound was reached -- never once more after that, no
    // matter how many further cycles run.
    const attemptsAtBound = spawned[0].destroy.mock.calls.length;
    expect(attemptsAtBound).toBe(MAX_CLEANUP_RETRY_ATTEMPTS);

    await probe.probe();
    await probe.probe();
    expect(spawned[0].destroy.mock.calls.length).toBe(attemptsAtBound);

    expect(
      logger.warn.mock.calls.some(([message]) =>
        /survived cleanup across the retry bound; abandoning/i.test(
          String(message),
        ),
      ),
    ).toBe(true);
    await probe.dispose();
  });

  // archive#3441 MEDIUM-1: pre-fix, `attemptCleanup` signalled first and
  // asked identity only afterward -- so a retry whose pid had been recycled
  // between cycles still received a real SIGTERM/SIGKILL before anything
  // noticed it was no longer this object's process. `spawned[0]`'s
  // `survivesCleanup` reports true only on its OWN first check (the initial
  // attempt from `runProbe`'s finally, `priorAttempts === 0`) and false on
  // every check after that -- exactly what identity reports once the pid has
  // been reused.
  test('a retry checks identity BEFORE signalling again -- a recycled pid is not re-signalled (station#3441 MEDIUM-1)', async () => {
    const spawned: Array<{
      destroy: ReturnType<typeof vi.fn>;
      forceGroupKill: ReturnType<typeof vi.fn>;
      survivesCleanup: ReturnType<typeof vi.fn>;
    }> = [];
    const logger = { warn: vi.fn() };
    const factory = vi.fn(() => {
      let checks = 0;
      const proc = {
        start: vi.fn(async () => {
          throw new Error('spawn ENOENT');
        }),
        newSession: vi.fn(async () => ({
          modes: { availableModes: [] },
          configOptions: [],
        })),
        destroy: vi.fn(async () => {}),
        forceGroupKill: vi.fn(),
        survivesCleanup: vi.fn(async () => {
          checks += 1;
          return checks === 1;
        }),
        releaseIfConfirmedGone: vi.fn(),
      };
      spawned.push(proc);
      return proc as unknown as ACPProcess;
    });
    const probe = new ACPProbe(
      {
        id: 'opencode',
        name: 'OpenCode',
        command: '/opt/engines/opencode',
        enabled: true,
      } as ACPConnectionConfig,
      logger,
      '/tmp/project',
      factory,
    );

    // Cycle 1: spawned[0] is created; its own first cleanup attempt (the
    // FIRST survivesCleanup() call) reports true -> retained.
    await probe.probe();
    expect(spawned[0].destroy).toHaveBeenCalledTimes(1);
    expect(spawned[0].survivesCleanup).toHaveBeenCalledTimes(1);

    // Cycle 2: retryPendingCleanup revisits spawned[0] at priorAttempts=1.
    // Its SECOND survivesCleanup() call reports false (pid recycled).
    await probe.probe();
    expect(spawned[0].survivesCleanup).toHaveBeenCalledTimes(2);
    // The pre-check fired, decided "not mine", and stopped -- destroy() and
    // forceGroupKill() must never see this pid again.
    expect(spawned[0].destroy).toHaveBeenCalledTimes(1);
    expect(spawned[0].forceGroupKill).not.toHaveBeenCalled();

    await probe.dispose();
  });
});

// archive#3448: `retryPendingCleanup` used to be the first AWAITED
// statement in `runProbe`, so the user-facing Reconnect route paid the full
// pending-cleanup retry cost -- serially, on every survivor still pending
// from earlier cycles -- before a fresh engine could even be spawned. These
// tests pin the fix: the retry now runs fire-and-forget, off the promise
// `probe()` returns, and nothing about that move silently drops a survivor.
describe('station#3448: pending-cleanup retries do not gate the returned probe', () => {
  // A real macrotask boundary, not just a microtask flush: `probe()`'s
  // returned promise only reflects its OWN spawn/handshake chain, never the
  // fire-and-forget retry it kicks off alongside -- so `await probe.probe()`
  // settling is no guarantee that cycle's own retry pass (and the dedupe
  // field it holds while running) has ALSO settled. Without this flush
  // between setup cycles below, a later cycle's retryPendingCleanup() call
  // can land while an EARLIER cycle's pass is still the one occupying
  // `cleanupRetryFlight`, join THAT stale pass instead of starting a fresh
  // one, and never see the hold this test arms afterward -- observed live
  // while writing these tests (the stall never happened at all).
  async function flushBackgroundWork() {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  // A retry attempt (a process's SECOND-OR-LATER `destroy()` call) only
  // stalls once the test calls `armRetryHold()` -- never during setup. This
  // is deliberate and load-bearing for the test's own soundness: with three
  // setup cycles each retaining a fresh survivor, EVERY setup cycle from the
  // second onward also retries whatever survived the previous cycle. If
  // retries stalled unconditionally on `destroyCalls > 1`, a REGRESSION back
  // to the old awaited-gate shape would make one of those SETUP cycles hang
  // instead of the measured one -- the elapsed-time assertion below would
  // then measure a cycle that was never blocked, and the test would pass
  // for the wrong reason. Arming the hold only immediately before the
  // measured call guarantees the stall -- if the code regresses to gating on
  // it -- always lands on the call actually being timed, regardless of
  // which cycle in setup happened to trigger which survivor's retry.
  function probeSpawningWithControllableRetryHold() {
    const spawned: Array<{
      destroy: ReturnType<typeof vi.fn>;
      survivesCleanup: ReturnType<typeof vi.fn>;
      forceGroupKill: ReturnType<typeof vi.fn>;
    }> = [];
    const pendingRetryDestroys: Array<() => void> = [];
    let holdRetryDestroys = false;
    const logger = { warn: vi.fn() };
    const factory = vi.fn(() => {
      let destroyCalls = 0;
      const proc = {
        start: vi.fn(async () => {
          throw new Error('spawn ENOENT');
        }),
        newSession: vi.fn(async () => ({
          modes: { availableModes: [] },
          configOptions: [],
        })),
        destroy: vi.fn(() => {
          destroyCalls += 1;
          // A process's OWN first cleanup attempt (destroyCalls===1, always
          // from runProbe's own finally block, never retryPendingCleanup)
          // never stalls, regardless of the hold -- only a RETRY. The hold
          // is ONE-SHOT (cleared the instant it fires): the retry loop is a
          // plain sequential `for...of`, so only one destroy() call is ever
          // in flight at a time regardless -- a non-one-shot hold would
          // silently stall EVERY later retry it reaches too (recorded as
          // "called" the moment it's invoked, well before whichever promise
          // it returns ever resolves), which reads as forward progress on
          // any assertion that only checks invocation counts. Observed live
          // while writing this test: spawned[1]'s retry looked like it had
          // completed because it had been *invoked*, while the promise it
          // returned sat unresolved right alongside spawned[0]'s.
          if (destroyCalls > 1 && holdRetryDestroys) {
            holdRetryDestroys = false;
            return new Promise<void>((resolve) => {
              pendingRetryDestroys.push(resolve);
            });
          }
          return Promise.resolve();
        }),
        forceGroupKill: vi.fn(async () => {}),
        survivesCleanup: vi.fn(async () => true),
        releaseIfConfirmedGone: vi.fn(),
      };
      spawned.push(proc);
      return proc as unknown as ACPProcess;
    });
    const probe = new ACPProbe(
      {
        id: 'opencode',
        name: 'OpenCode',
        command: '/opt/engines/opencode',
        // Configured, unlike `probeSpawning` above: this describe measures
        // wall time, and real filesystem workspace prep would add noise a
        // configured cwd skips.
        cwd: '/tmp/station-acp-3448-fixture',
        enabled: true,
      } as ACPConnectionConfig,
      logger,
      '/tmp/project',
      factory,
    );
    return {
      probe,
      spawned,
      logger,
      pendingRetryDestroys,
      armRetryHold: () => {
        holdRetryDestroys = true;
      },
    };
  }

  test("the user-facing Reconnect path ('request') resolves promptly even with pending survivors whose retry destroy() never settles", async () => {
    const { probe, spawned, pendingRetryDestroys, armRetryHold } =
      probeSpawningWithControllableRetryHold();

    // Three background cycles, each retaining its own new survivor. None of
    // these hang: the hold is not armed yet, so every destroy() call --
    // including the retries later cycles make on earlier survivors --
    // resolves immediately.
    for (let i = 0; i < 3; i++) {
      await probe.probe('background');
      await flushBackgroundWork();
    }
    expect(spawned).toHaveLength(3);

    // Arm the hold immediately before the measured call: this cycle's
    // retryPendingCleanup pass reaches the oldest pending survivor and gets
    // stuck on its retry destroy(). On the OLD (awaited) behaviour this call
    // would have blocked on that indefinitely (and, in the real system, for
    // at least DESTROY_ESCALATION_UPPER_BOUND_MS before even starting its
    // own spawn). It must not block this call at all.
    armRetryHold();
    const start = Date.now();
    const ok = await probe.probe('request');
    const elapsed = Date.now() - start;

    expect(ok).toBe(false); // spawn ENOENT, as designed -- elapsed is the point
    expect(elapsed).toBeLessThan(1_000);
    // Confirms the retry really did get stuck (proving this run is actually
    // exercising the scenario under test, not passing vacuously because the
    // stuck path was never reached). Polled rather than asserted eagerly:
    // the fire-and-forget retry runs concurrently with, not ahead of, the
    // spawn/handshake work `probe()`'s own promise resolves on, so it can
    // still be a microtask or two behind at the instant that promise settles
    // -- exactly the decoupling this fix introduces, not a flaw in it.
    await vi.waitFor(() =>
      expect(pendingRetryDestroys.length).toBeGreaterThan(0),
    );

    // Never resolved -- left dangling deliberately (a bare unresolved
    // promise, not a timer or process), so no `dispose()` call here would
    // ever settle either.
  });

  test('a survivor stuck behind another survivor is still retried once unblocked -- moving cleanup off the probe path does not silently drop it', async () => {
    const { probe, spawned, pendingRetryDestroys, armRetryHold } =
      probeSpawningWithControllableRetryHold();

    for (let i = 0; i < 3; i++) {
      await probe.probe('background');
      await flushBackgroundWork();
    }
    armRetryHold();
    await probe.probe('request'); // spawns a 4th survivor, stalls the retry pass on the oldest one
    expect(spawned).toHaveLength(4);
    // Polled for the same reason as the promptness test above: the
    // fire-and-forget retry can still be a microtask or two behind once
    // probe() itself has resolved.
    await vi.waitFor(() => expect(pendingRetryDestroys).toHaveLength(1));

    // Deliberately bounded to exactly 4 total survivors (spawned[0..3]) and
    // NO further probe cycles below -- archive#3448 HIGH fix-round: once the
    // set is AT `MAX_PENDING_CLEANUP_SIZE` (4), retaining one MORE survivor
    // is refused (see that constant's own docblock), so driving additional
    // 'background' cycles here (each spawning yet another new survivor of
    // its own, since this harness's spawn always fails and always gets
    // retained) would eventually push spawned[0] past the cap and abandon it
    // -- correctly, by the new design, but that is a DIFFERENT scenario
    // (covered by its own test below), not what this one is proving. This
    // test stays at exactly the cap and shows every entry already queued
    // when the stall happened -- spawned[0..2], captured in the ORIGINAL
    // stalled pass's snapshot before spawned[3] even existed -- still gets
    // retried once unblocked, with no extra cycle needed: the same pass
    // resumes and walks its own snapshot through to the end.
    //
    // spawned[0]'s own signal is `survivesCleanup`, not `destroy`:
    // unblocking its STALLED (4th) destroy() call lets THAT SAME
    // attemptCleanup invocation finish (a post-destroy survivesCleanup
    // check, then retain) -- it does not itself produce a FIFTH destroy()
    // call, which would only happen on a later cycle this test does not
    // run. spawned[1] and spawned[2], by contrast, get a genuinely NEW
    // destroy() call once the resumed pass reaches them (their retry hadn't
    // started yet when the pass stalled on spawned[0]), so their destroy
    // counts are the right signal for them.
    const survivesCleanupCallsBefore =
      spawned[0].survivesCleanup.mock.calls.length;
    const destroyCountsBefore = spawned
      .slice(1, 3)
      .map((p) => p.destroy.mock.calls.length);

    // Unblock the stalled retry.
    pendingRetryDestroys.shift()!();

    await vi.waitFor(() => {
      expect(spawned[0].survivesCleanup.mock.calls.length).toBeGreaterThan(
        survivesCleanupCallsBefore,
      );
      const stillStuck = spawned
        .slice(1, 3)
        .map((p, index) => ({
          index: index + 1,
          count: p.destroy.mock.calls.length,
        }))
        .filter(({ index, count }) => count <= destroyCountsBefore[index - 1]);
      expect(stillStuck).toEqual([]);
    });
    // No further spawns happened -- the resumed pass alone accounted for
    // spawned[0..2]; spawned[3] needed nothing further because its OWN
    // first retention already happened via the 'request' cycle's own
    // primary path, not this background pass.
    expect(spawned).toHaveLength(4);
  });

  // archive#3448 HIGH fix-round: the companion proof for {@link
  // MAX_PENDING_CLEANUP_SIZE} -- once the set is already full, a survivor
  // that would otherwise be retained is abandoned immediately instead,
  // rather than growing the set past its cap. Without this, the earlier
  // test would eventually fail for a DIFFERENT reason once enough cycles
  // ran (an uncapped set climbing without bound, exactly the HIGH finding),
  // so this proves the cap fires -- not merely that it doesn't come up
  // within one test's bounded scenario.
  //
  // Deliberately a DIFFERENT, simpler harness than
  // `probeSpawningWithControllableRetryHold` above: that one lets every
  // retry succeed, which means each of the 4 setup survivors also AGES
  // toward its own independent MAX_CLEANUP_RETRY_ATTEMPTS (5) bound on
  // every cycle -- with exactly 4 cycles needed to create 4 survivors, the
  // oldest is already at 4 attempts by the time a 5th spawn would need to
  // observe the size cap, so one more cycle ages it to 5 and abandons it
  // via the RETRY bound first, freeing a slot and making the size bound
  // never fire at all (caught by this exact test, the first time it was
  // written that way -- the two bounds interact and a scenario has to
  // isolate one from the other to prove either cleanly). Here, every RETRY
  // attempt (a process's second-or-later `destroy()` call) hangs forever,
  // so the 4 setup survivors are never aged past their own first attempt at
  // all -- only a genuinely NEW, sixth spawn's own PRIMARY attempt (which
  // always resolves fast, see `destroyCalls === 1` below) can observe the
  // size bound uncontaminated by retry-bound aging.
  test('the pending-cleanup set does not grow past MAX_PENDING_CLEANUP_SIZE -- an extra survivor is abandoned, not retained', async () => {
    const spawned: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];
    const logger = { warn: vi.fn() };
    const factory = vi.fn(() => {
      let destroyCalls = 0;
      const proc = {
        start: vi.fn(async () => {
          throw new Error('spawn ENOENT');
        }),
        newSession: vi.fn(async () => ({
          modes: { availableModes: [] },
          configOptions: [],
        })),
        destroy: vi.fn(() => {
          destroyCalls += 1;
          if (destroyCalls === 1) return Promise.resolve();
          // Every RETRY attempt hangs forever -- deliberately never
          // resolved, so none of these 4 survivors is ever aged by a
          // background pass during this test.
          return new Promise<void>(() => {});
        }),
        forceGroupKill: vi.fn(async () => {}),
        survivesCleanup: vi.fn(async () => true),
        releaseIfConfirmedGone: vi.fn(),
      };
      spawned.push(proc);
      return proc as unknown as ACPProcess;
    });
    // archive#3526: this test asserts an exact array against
    // `acpProbeCleanupRetention`, so it takes the same disjoint per-test
    // recorder the telemetry describe below uses -- see the file-scoped
    // comment above that describe for why a shared spy cannot isolate a
    // single instance's emissions in this test environment.
    const cleanupRetentionRecorder = { add: vi.fn() };
    const probe = new ACPProbe(
      {
        id: 'opencode',
        name: 'OpenCode',
        command: '/opt/engines/opencode',
        cwd: '/tmp/station-acp-3448-fixture',
        enabled: true,
      } as ACPConnectionConfig,
      logger,
      '/tmp/project',
      factory,
      undefined,
      cleanupRetentionRecorder,
    );
    const add = cleanupRetentionRecorder.add;

    // MAX_PENDING_CLEANUP_SIZE (4) survivors, each retained via its own
    // primary path. Each cycle's fire-and-forget pass ALSO fires a retry
    // attempt on whatever survivor is oldest -- but that attempt hangs
    // forever (see the factory above), so the dedupe join means EVERY
    // later cycle's own retryPendingCleanup() call just joins that same
    // still-running, still-stuck pass rather than starting a fresh one:
    // none of spawned[0..3] is ever actually retried again during setup.
    for (let i = 0; i < 4; i++) {
      await probe.probe('background');
    }
    expect(spawned).toHaveLength(4);
    expect(
      add.mock.calls.map((call) => (call[1] as { outcome?: string }).outcome),
    ).toEqual(['retained', 'retained', 'retained', 'retained']);
    add.mockClear();

    // A fifth spawn's own PRIMARY cleanup (its own first, always-fast
    // destroy() call) finds it survives too -- but the set is already at
    // the cap (4 OTHER entries already retained, untouched since setup), so
    // it must be abandoned on the spot, by the SET-SIZE reason
    // specifically, rather than becoming a 5th retained entry.
    await probe.probe('background');
    expect(spawned).toHaveLength(5);
    expect(
      add.mock.calls.map(
        (call) => call[1] as { outcome?: string; reason?: string },
      ),
    ).toEqual([{ outcome: 'abandoned', reason: 'set-size-bound' }]);
  });

  // archive#3448 HIGH fix-round, second pass (independent review): the FIRST
  // version of the size-bound check applied unconditionally to every
  // retention decision, including a retry of an ALREADY-retained survivor --
  // which does not grow the set (see `MAX_PENDING_CLEANUP_SIZE`'s own
  // docblock), so applying the same cap there just evicted an older entry
  // mid-retry to make room for a newer arrival, inverting the documented
  // intent (a new process's own attempt should be the one refused). The test
  // above cannot see this: its retries hang forever, so the eviction branch
  // is never even reached for spawned[0..3]. This test uses retries that
  // actually RESOLVE, so a concurrent background pass genuinely reaches the
  // check for an existing entry while a new arrival is also being decided.
  test('station#3448 HIGH fix-round: the size bound refuses a NEW entry, it does not evict an already-retained one', async () => {
    const spawned: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];
    const logger = { warn: vi.fn() };
    let heldOnce = false;
    let unblock: (() => void) | undefined;
    // Ordering control for phase 2 below -- load-bearing, not incidental,
    // and TWO gates, not one. `survivesCleanup` for spawned[0..3] (index <
    // 4) blocks on `existingGate` while it is set; spawned[4]'s own
    // `start()` blocks on `newEntryGate`. A first version of this test used
    // only the first gate, released once `spawned.length === 5` -- and that
    // was too late: `pendingCleanup.set(process4, 0)` and spawned[4]'s own
    // full decision (add THEN abandon-or-retain) both complete inside the
    // same fast synchronous-ish chain, well before a real-timer `vi.waitFor`
    // poll can observe the array growing, so by the time the gate released,
    // spawned[4] had usually already been decided and removed again -- the
    // existing four never actually saw size 5. Holding spawned[4] at its own
    // `start()` (which runs AFTER `pendingCleanup.set`, so the set-add is
    // guaranteed to have happened) freezes it mid-decision, giving a real
    // window where the set genuinely holds 5 members.
    let existingGate: Promise<void> | undefined;
    let releaseExistingGate: (() => void) | undefined;
    let newEntryGate: Promise<void> | undefined;
    let releaseNewEntryGate: (() => void) | undefined;
    const factory = vi.fn(() => {
      const index = spawned.length;
      let destroyCalls = 0;
      const proc = {
        start: vi.fn(async () => {
          if (index === 4 && newEntryGate) await newEntryGate;
          throw new Error('spawn ENOENT');
        }),
        newSession: vi.fn(async () => ({
          modes: { availableModes: [] },
          configOptions: [],
        })),
        destroy: vi.fn(() => {
          destroyCalls += 1;
          if (destroyCalls === 1) return Promise.resolve(); // own primary
          // The very FIRST retry attempt across the whole harness (whichever
          // survivor the stalled pass first reaches) is held open, so setup
          // below builds 4 UNAGED survivors (attempts === 1 each) without any
          // of them approaching their own 5-attempt bound -- every retry
          // after that (once unblocked) resolves immediately.
          if (!heldOnce) {
            heldOnce = true;
            return new Promise<void>((resolve) => {
              unblock = resolve;
            });
          }
          return Promise.resolve();
        }),
        forceGroupKill: vi.fn(async () => {}),
        survivesCleanup: vi.fn(async () => {
          if (index < 4 && existingGate) await existingGate;
          return true;
        }),
        releaseIfConfirmedGone: vi.fn(),
      };
      spawned.push(proc);
      return proc as unknown as ACPProcess;
    });
    // archive#3526: this test asserts an exact array against
    // `acpProbeCleanupRetention`, so it takes the same disjoint per-test
    // recorder the telemetry describe below uses -- see the file-scoped
    // comment above that describe for why a shared spy cannot isolate a
    // single instance's emissions in this test environment.
    const cleanupRetentionRecorder = { add: vi.fn() };
    const probe = new ACPProbe(
      {
        id: 'opencode',
        name: 'OpenCode',
        command: '/opt/engines/opencode',
        cwd: '/tmp/station-acp-3448-fixture',
        enabled: true,
      } as ACPConnectionConfig,
      logger,
      '/tmp/project',
      factory,
      undefined,
      cleanupRetentionRecorder,
    );

    for (let i = 0; i < 4; i++) {
      await probe.probe('background');
    }
    expect(spawned).toHaveLength(4);
    expect(unblock).toBeDefined();

    // Unblock the one stalled retry and let its pass finish -- gated on
    // `priorAttempts === 0` (the fix), this retry (`priorAttempts === 1`)
    // skips the size check entirely regardless of set size.
    unblock!();
    await flushBackgroundWork();

    const add = cleanupRetentionRecorder.add;
    add.mockClear();
    logger.warn.mockClear();

    // Arm both gates, then trigger the fifth cycle. spawned[4]'s own
    // `pendingCleanup.set(process, 0)` runs before its (held) `start()`
    // call, so once `spawned` genuinely has 5 entries, the set truly holds
    // 5 members AND spawned[4]'s own decision is frozen mid-flight. THAT is
    // when the existing four are released to make their (now genuinely
    // size-5) retention decisions; only afterward is spawned[4] released to
    // make its own. With the fix, the cap only ever gates spawned[4]'s own
    // admission -- none of the 4 already-retained survivors should be
    // evicted to make room for it.
    existingGate = new Promise((resolve) => {
      releaseExistingGate = resolve;
    });
    newEntryGate = new Promise((resolve) => {
      releaseNewEntryGate = resolve;
    });
    const pending = probe.probe('background');
    await vi.waitFor(() => expect(spawned).toHaveLength(5));
    releaseExistingGate!();
    await flushBackgroundWork();
    releaseNewEntryGate!();
    await pending;
    await flushBackgroundWork();

    const outcomes = add.mock.calls.map(
      (call) => call[1] as { outcome?: string; reason?: string },
    );
    const abandoned = outcomes.filter((attrs) => attrs.outcome === 'abandoned');
    const retained = outcomes.filter((attrs) => attrs.outcome === 'retained');
    // The AGGREGATE shape alone does not discriminate: with the bug present,
    // one of spawned[0..3] gets wrongly evicted (freeing a slot), and
    // spawned[4] then gets wrongly RETAINED into that freed slot instead of
    // refused -- net one 'abandoned' and four 'retained' either way, just
    // naming a different process each time (observed live while writing
    // this test: the aggregate-only version of this assertion stayed green
    // with the fix reverted). Naming WHICH process is what discriminates.
    expect(abandoned).toEqual([
      { outcome: 'abandoned', reason: 'set-size-bound' },
    ]);
    expect(retained.length).toBe(4);
    // `destroy()`'s call count does NOT discriminate outcome: it fires
    // BEFORE the retained-vs-abandoned decision either way (a survivor that
    // gets wrongly evicted was still destroyed first), so "was retried
    // again" is true of an evicted entry too -- confirmed live: a version of
    // this test asserting only "destroy() called again" for spawned[0..3]
    // stayed green with the fix reverted, for exactly this reason.
    //
    // `logger.warn`'s `attempts` metadata is what actually names the
    // decision, and in THIS scenario every process reaches a distinct
    // `attempts` value this cycle: spawned[0] -> 3 (own primary=1, the
    // "unblock" retry=2, this cycle=3), spawned[1..3] -> 2, spawned[4] -> 1.
    // So "was spawned[0] specifically retained or abandoned" is answerable
    // by asking which log line carries `attempts: 3`.
    const attemptsLoggedFor = (pattern: RegExp) =>
      logger.warn.mock.calls
        .filter(([message]) => pattern.test(String(message)))
        .map(
          ([, meta]) => (meta as { attempts?: number } | undefined)?.attempts,
        );
    const retainedAttempts = attemptsLoggedFor(
      /retaining it for another attempt/i,
    );
    const sizeBoundAbandonedAttempts = attemptsLoggedFor(
      /pending-cleanup set is already at its size bound/i,
    );
    // Only spawned[4] (attempts === 1 this cycle) was refused by the size
    // bound -- not spawned[0] (attempts === 3), which the aggregate-only
    // assertions above cannot tell apart from a correct run. (Reverting the
    // `priorAttempts === 0` gate makes THIS assertion the one that goes
    // red: `sizeBoundAbandonedAttempts` gains a 3 alongside the 1, naming
    // spawned[0] as also abandoned, while `abandoned.length` stays at 1 the
    // whole time because spawned[4] is then wrongly retained into the slot
    // spawned[0]'s eviction freed.)
    expect(sizeBoundAbandonedAttempts).toEqual([1]);
    expect(retainedAttempts).toContain(3);
  });

  // archive#3448 BLOCKING fix-round finding (independent review): a
  // background survivor's cleanup miss must never contaminate a concurrent,
  // genuinely successful handshake's own result. `cleanupProbeProcess`'s
  // `onMiss` callback used to write `this.lastSuccess = false`
  // unconditionally on ANY destroy-race miss -- not only a deadline miss,
  // but also the ordinary "destroy() rejects quickly but never confirms"
  // mode. On the old awaited-retry shape that was harmless (the retry
  // finished before the handshake started, so its own write was always
  // overwritten); decoupled, a survivor's miss can land WHILE or AFTER a
  // concurrent handshake has already written `lastSuccess = true`, silently
  // flipping an available connection to reporting unavailable with
  // `lastError === null` -- the exact "unavailable with no reason" shape
  // `lastError`'s own docblock forbids.
  test('station#3448 BLOCKING: a background survivor whose retry destroy() rejects does not contaminate a concurrent successful handshake', async () => {
    const spawned: Array<{
      destroy: ReturnType<typeof vi.fn>;
      forceGroupKill: ReturnType<typeof vi.fn>;
    }> = [];
    const logger = { warn: vi.fn() };
    let spawnCount = 0;
    // Held open until the test explicitly rejects it -- see the ordering
    // note below for why this control is load-bearing, not incidental.
    let rejectSurvivorRetryDestroy: (() => void) | undefined;
    const factory = vi.fn(() => {
      const index = spawnCount++;
      if (index === 0) {
        // The survivor: fails to spawn, so its own primary cleanup RETAINS
        // it (survivesCleanup always true). Its retry destroy() -- driven
        // by the SECOND probe cycle's fire-and-forget pass, concurrently
        // with that cycle's own (successful) handshake -- rejects, the
        // "destroy() rejects quickly but never confirms" mode that fires
        // `onMiss`.
        const proc = {
          start: vi.fn(async () => {
            throw new Error('spawn ENOENT');
          }),
          newSession: vi.fn(async () => ({
            modes: { availableModes: [] },
            configOptions: [],
          })),
          destroy: vi.fn(() => {
            if (proc.destroy.mock.calls.length === 1) return Promise.resolve(); // own primary: succeeds
            // The retry: held open until the test rejects it explicitly.
            return new Promise<void>((_, reject) => {
              rejectSurvivorRetryDestroy = () =>
                reject(new Error('destroy rejected'));
            });
          }),
          forceGroupKill: vi.fn(async () => {}),
          survivesCleanup: vi.fn(async () => true),
          releaseIfConfirmedGone: vi.fn(),
        };
        spawned.push(proc);
        return proc as unknown as ACPProcess;
      }
      // The second cycle's OWN process: a genuinely successful handshake,
      // reaped cleanly afterward (no interference from its own primary
      // cleanup either).
      const proc = {
        start: vi.fn(async () => ({
          protocolVersion: 1,
          agentCapabilities: {},
        })),
        newSession: vi.fn(async () => ({
          modes: { availableModes: [] },
          configOptions: [],
        })),
        destroy: vi.fn(async () => {}),
        forceGroupKill: vi.fn(async () => {}),
        survivesCleanup: vi.fn(async () => false),
        releaseIfConfirmedGone: vi.fn(),
      };
      spawned.push(proc);
      return proc as unknown as ACPProcess;
    });
    const probe = new ACPProbe(
      {
        id: 'opencode',
        name: 'OpenCode',
        command: '/opt/engines/opencode',
        cwd: '/tmp/station-acp-3448-fixture',
        enabled: true,
      } as ACPConnectionConfig,
      logger,
      '/tmp/project',
      factory,
    );

    await probe.probe('background'); // builds the survivor
    await flushBackgroundWork();

    const pending = probe.probe('request');
    // Ordering is load-bearing, not incidental: the bug this test targets
    // only manifests when the survivor's contaminating write lands AFTER
    // the handshake's own `lastSuccess = true` write -- if it lands first,
    // the handshake's later write masks it (observed live while writing
    // this test: an uncontrolled race let the handshake win most of the
    // time, and the first version of this test passed even with the bug
    // reintroduced). Waiting for `isAvailable()` to already read `true`
    // before rejecting the survivor's retry guarantees the contaminating
    // write, if the bug is present, is strictly the LAST one.
    await vi.waitFor(() => expect(probe.isAvailable()).toBe(true));
    rejectSurvivorRetryDestroy!();

    const ok = await pending;
    // `pending` (the 'request' cycle's OWN promise) resolving is NOT proof
    // the survivor's rejection has been processed -- that is exactly what
    // this fix decouples. `onMiss` runs synchronously inside
    // `destroyProcessWithEscalation`'s catch block, immediately before it
    // awaits `forceGroupKill()`, so waiting for that call is what actually
    // proves the (possible) contaminating write has already happened before
    // the assertions below read the final state. Missing this was the
    // second bug found while writing this test: the first version asserted
    // immediately after `await pending` and passed even with the fix
    // reverted, because the contamination hadn't landed yet.
    await vi.waitFor(() =>
      expect(spawned[0].forceGroupKill).toHaveBeenCalled(),
    );

    expect(ok).toBe(true);
    expect(probe.isAvailable()).toBe(true);
    expect(probe.lastError).toBeNull();
  });

  // archive#3448: firing retryPendingCleanup fire-and-forget makes an
  // overlap possible that could not happen before -- `probe()`'s own
  // `probeFlight` dedupe means only one `runProbe` (and so only one
  // fire-and-forget retry) is ever in flight PER CYCLE, but that retry now
  // outlives the cycle that started it (the returned promise no longer
  // waits for it), so a SECOND probe cycle can start, and fire its OWN
  // retryPendingCleanup call, while the first cycle's retry is still
  // running. Without a join, two passes could both read the same survivor's
  // `priorAttempts` from the map before either writes back its update,
  // computing the SAME next value independently -- silently evading the
  // archive#3441 retry-count bound this issue also requires stay preserved.
  test("a second probe cycle starting while the first cycle's retry is still in flight joins it rather than double-attempting the same survivor", async () => {
    const { probe, spawned, pendingRetryDestroys, armRetryHold } =
      probeSpawningWithControllableRetryHold();

    await probe.probe('background'); // spawned[0], retained attempts=1
    await flushBackgroundWork();

    armRetryHold();
    await probe.probe('background'); // spawns spawned[1]; stalls spawned[0]'s retry
    await vi.waitFor(() => expect(pendingRetryDestroys).toHaveLength(1));
    const destroyCallsWhileStalled = spawned[0].destroy.mock.calls.length;

    // A third cycle starts while spawned[0]'s retry from the SECOND cycle is
    // still stuck (never unblocked). Its own retryPendingCleanup() call must
    // join that in-flight pass, not start a fresh one.
    await probe.probe('background'); // spawns spawned[2]
    await flushBackgroundWork();

    expect(spawned[0].destroy.mock.calls.length).toBe(destroyCallsWhileStalled);
    // Exactly one destroy() call on spawned[0] is outstanding -- a second,
    // concurrent one would have pushed a second resolver here (this test's
    // one-shot hold only guards the FIRST stall; a second, undeduped pass
    // reaching spawned[0] again resolves immediately, so a regression here
    // shows up as the call count above climbing, not as a second entry in
    // this array).
    expect(pendingRetryDestroys).toHaveLength(1);
  });
});

// archive#3441 LOW-2: `acpProbeCleanupRetention` had no test naming any of
// its three outcomes. Each of these pins one, with `probeSpawning`'s same
// distinct-process-per-spawn harness so cross-cycle counts cannot be
// confused with a different connection's own spawn.
//
// archive#3526 FIX: these assertions are exact-array checks, and the
// archive#3448 describe ABOVE leaves fire-and-forget retry passes running
// past the end of its own tests -- several deliberately hold a destroy open
// that never settles, so no `dispose()` there could ever join them (see that
// describe's own comments). A late `retained` emit from one of those passes
// used to land on the SAME module-singleton counter this describe spied on
// and fail an unrelated test here:
//
//   AssertionError: expected [ 'retained', 'reaped' ] to deeply equal [ 'reaped' ]
//
// A per-test `vi.resetModules()` re-import of `acp-probe.js` was tried first
// (the module-memoised-singleton pattern `serving-instance.test.ts` uses for
// an unrelated module) and does NOT isolate this emitter: confirmed live,
// the freshly re-imported `ACPProbe` class was a genuinely distinct class,
// but its `acpProbeCleanupRetention` was still `===` the original -- NOT
// because OTel's API spec requires it (it does not). The actual cause: this
// test environment registers no OTel `MeterProvider` anywhere (grepped --
// `initializeTelemetry` in `telemetry.ts` only starts a real one when
// `OTEL_EXPORTER_OTLP_ENDPOINT` is set, which nothing in this repo's test/CI
// setup does), so `metrics.getMeter('station')` resolves OTel's process-wide
// NOOP meter, whose `createCounter` hands back ONE module-level singleton
// object for EVERY counter name and EVERY meter in the process -- not merely
// every `ACPProbe` instance, but every counter `metrics.ts` exports. A spy on
// `acpProbeCleanupRetention.add` under this regime is a spy on the shared
// sink for the whole file's telemetry, wider than "another ACPProbe" alone.
// This is an environment fact, not a spec guarantee: `@opentelemetry
// /sdk-metrics` returns a DISTINCT instrument per name once a real
// `MeterProvider` is registered, and if this repo's test setup ever starts
// registering one, `vi.resetModules()` re-importing would begin isolating
// correctly on its own and the fix below would become belt-and-braces rather
// than the only mechanism that works.
//
// Fixed instead by making the recorder injectable at the source
// (`ACPProbe`'s `cleanupRetentionRecorder` constructor parameter,
// `acp-probe.ts`) -- defaulted to the real shared counter for every
// production call site and every test that does not need per-instance
// isolation. `probeSpawning` below, and two tests inside the archive#3448
// describe above with the same exact-array exposure ("the pending-cleanup
// set does not grow past MAX_PENDING_CLEANUP_SIZE..." and "the size bound
// refuses a NEW entry..."), pass their own plain `{ add: vi.fn() }` instead:
// an object no other `ACPProbe` instance holds a reference to, so a
// background pass from another test -- however long it keeps running -- has
// no way to reach it. The REST of the archive#3448 describe still defaults
// to the real shared counter, because those tests assert on call counts and
// timing, never on `acpProbeCleanupRetention` itself, so they carry none of
// this exposure.
describe('station.acp.probe_cleanup_retention records the outcome it claims (station#3441 LOW-2)', () => {
  function probeSpawning(survives: boolean) {
    const spawned: Array<{
      destroy: ReturnType<typeof vi.fn>;
      forceGroupKill: ReturnType<typeof vi.fn>;
      survivesCleanup: ReturnType<typeof vi.fn>;
    }> = [];
    const logger = { warn: vi.fn() };
    // archive#3526: this describe's own recorder, disjoint from the shared
    // `acpProbeCleanupRetention` every other `ACPProbe` in this file defaults
    // to -- see the file-scoped comment above.
    const cleanupRetentionRecorder = { add: vi.fn() };
    const factory = vi.fn(() => {
      const proc = {
        start: vi.fn(async () => {
          throw new Error('spawn ENOENT');
        }),
        newSession: vi.fn(async () => ({
          modes: { availableModes: [] },
          configOptions: [],
        })),
        destroy: vi.fn(async () => {}),
        forceGroupKill: vi.fn(),
        survivesCleanup: vi.fn(async () => survives),
        releaseIfConfirmedGone: vi.fn(),
      };
      spawned.push(proc);
      return proc as unknown as ACPProcess;
    });
    const probe = new ACPProbe(
      {
        id: 'opencode',
        name: 'OpenCode',
        command: '/opt/engines/opencode',
        enabled: true,
      } as ACPConnectionConfig,
      logger,
      '/tmp/project',
      factory,
      undefined,
      cleanupRetentionRecorder,
    );
    return { probe, spawned, logger, cleanupRetentionRecorder };
  }

  function outcomesOf(add: ReturnType<typeof vi.fn>): string[] {
    return add.mock.calls.map((call: unknown[]) => {
      const attrs = call[1] as { outcome?: string } | undefined;
      return attrs?.outcome as string;
    });
  }

  test("a probe that needed no retention records 'reaped', nothing else", async () => {
    const { probe, cleanupRetentionRecorder } = probeSpawning(false);

    await probe.probe();

    expect(outcomesOf(cleanupRetentionRecorder.add)).toEqual(['reaped']);
    await probe.dispose();
  });

  test("a survivor kept for another attempt records 'retained'", async () => {
    const { probe, cleanupRetentionRecorder } = probeSpawning(true);

    await probe.probe();

    expect(outcomesOf(cleanupRetentionRecorder.add)).toEqual(['retained']);
    await probe.dispose();
  });

  test("reaching the retry bound records 'abandoned', and forceGroupKill is never called by the abandon path itself", async () => {
    const { probe, spawned, cleanupRetentionRecorder } = probeSpawning(true);

    // Every cycle's OWN new spawn also survives forever in this harness, so
    // beyond the bound MULTIPLE entries cross it (spawned[0] first, then
    // spawned[1] one cycle later, ...) -- 'abandoned' is asserted present,
    // not counted exactly, so this stays robust to that cross-process
    // interaction. `MAX_CLEANUP_RETRY_ATTEMPTS - 1` further cycles is exactly
    // enough for spawned[0] (created in the first probe() call) to cross the
    // bound once and only once.
    await probe.probe();
    for (let i = 0; i < MAX_CLEANUP_RETRY_ATTEMPTS - 1; i++) {
      await probe.probe();
    }

    expect(spawned[0].destroy).toHaveBeenCalledTimes(
      MAX_CLEANUP_RETRY_ATTEMPTS,
    );
    const outcomes = outcomesOf(cleanupRetentionRecorder.add);
    expect(outcomes).toContain('abandoned');
    expect(outcomes.filter((o) => o === 'abandoned')).toHaveLength(1);
    // docblock: "Abandoning an entry does not kill it" -- the mock destroy()
    // always resolves (never rejects), so destroyProcessWithEscalation's
    // catch/forceGroupKill branch is never reached by ANY attempt in this
    // scenario; this assertion is what would catch an abandon branch that
    // started calling forceGroupKill() directly, contradicting the docblock.
    expect(spawned[0].forceGroupKill).not.toHaveBeenCalled();

    await probe.dispose();
  });
});

// archive#3441 LOW-1: both of `attemptCleanup`'s 'reaped' branches independently
// confirm the process is gone (via `survivesCleanup()`) but previously never
// released the owned-process registry record for it -- a leak for the rest of
// this Station's lifetime. `releaseIfConfirmedGone` is the release; these pin
// that it is actually called from BOTH sites.
describe('station#3441 LOW-1: a confirmed-gone survivor releases its registry record', () => {
  test("the pre-signal identity check (MEDIUM-1's retry path) releases on discovering the pid is gone", async () => {
    // A DISTINCT process object per spawn (same pattern the sibling
    // `probeSpawning` helpers above use): the second `probe()` call spawns
    // its OWN new process in addition to retrying the first one, and the two
    // must not be conflated -- reusing a single mock object for both was
    // caught by this test itself double-counting the release.
    const spawned: Array<{
      destroy: ReturnType<typeof vi.fn>;
      forceGroupKill: ReturnType<typeof vi.fn>;
      survivesCleanup: ReturnType<typeof vi.fn>;
      releaseIfConfirmedGone: ReturnType<typeof vi.fn>;
    }> = [];
    const factory = vi.fn(() => {
      let checks = 0;
      const proc = {
        start: vi.fn(async () => {
          throw new Error('spawn ENOENT');
        }),
        newSession: vi.fn(async () => ({
          modes: { availableModes: [] },
          configOptions: [],
        })),
        destroy: vi.fn(async () => {}),
        forceGroupKill: vi.fn(),
        // First check (priorAttempts===0, runProbe's own finally) survives ->
        // retained. Second check (priorAttempts===1, the MEDIUM-1 pre-check
        // on a later cycle) reports gone -> the pre-check 'reaped' branch,
        // which never calls destroy() or forceGroupKill() at all.
        survivesCleanup: vi.fn(async () => {
          checks += 1;
          return checks === 1;
        }),
        releaseIfConfirmedGone: vi.fn(),
      };
      spawned.push(proc);
      return proc as unknown as ACPProcess;
    });
    const probe = new ACPProbe(
      {
        id: 'opencode',
        name: 'OpenCode',
        command: '/opt/engines/opencode',
        enabled: true,
      } as ACPConnectionConfig,
      { warn: vi.fn() },
      '/tmp/project',
      factory,
    );

    await probe.probe();
    expect(spawned[0].releaseIfConfirmedGone).not.toHaveBeenCalled();
    await probe.probe();

    expect(spawned[0].releaseIfConfirmedGone).toHaveBeenCalledTimes(1);
    // The pre-check path: no destroy/signal in the cycle that released it.
    expect(spawned[0].destroy).toHaveBeenCalledTimes(1);
    expect(spawned[0].forceGroupKill).not.toHaveBeenCalled();
    // The SECOND cycle's own fresh spawn survives its own first check and
    // must not be conflated with the first one's release.
    expect(spawned[1].releaseIfConfirmedGone).not.toHaveBeenCalled();

    await probe.dispose();
  });

  test('the post-cleanup reaped branch releases on discovering the pid is gone', async () => {
    const releaseIfConfirmedGone = vi.fn();
    const proc = {
      start: vi.fn(async () => {
        throw new Error('spawn ENOENT');
      }),
      newSession: vi.fn(async () => ({
        modes: { availableModes: [] },
        configOptions: [],
      })),
      destroy: vi.fn(async () => {}),
      forceGroupKill: vi.fn(),
      survivesCleanup: vi.fn(async () => false),
      releaseIfConfirmedGone,
    };
    const factory = vi.fn(() => proc as unknown as ACPProcess);
    const probe = new ACPProbe(
      {
        id: 'opencode',
        name: 'OpenCode',
        command: '/opt/engines/opencode',
        enabled: true,
      } as ACPConnectionConfig,
      { warn: vi.fn() },
      '/tmp/project',
      factory,
    );

    await probe.probe();

    expect(releaseIfConfirmedGone).toHaveBeenCalledTimes(1);
    await probe.dispose();
  });
});

describe('ACPProbe cold/warm deadline split (station#3404)', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  function makeProcess() {
    const start = deferred<any>();
    const proc = {
      start: vi.fn(() => start.promise),
      newSession: vi.fn(
        async () =>
          ({
            sessionId: 's',
            modes: { availableModes: [] },
            configOptions: [],
          }) as any,
      ),
      destroy: vi.fn(async () => {}),
      forceGroupKill: vi.fn(),
      survivesCleanup: () => false,
      releaseIfConfirmedGone: () => {},
    };
    return { proc, start };
  }

  function makeProbe(proc: ReturnType<typeof makeProcess>['proc']) {
    const probe = new ACPProbe(
      {
        id: 'opencode',
        name: 'OpenCode',
        command: '/opt/engines/opencode',
        // A configured cwd keeps probeCwd on the synchronous `configured`
        // branch: under fake timers the managed-workspace fs path would never
        // settle, and it is not what these deadline tests exercise.
        cwd: '/tmp/station-acp-3404',
        enabled: true,
      } as ACPConnectionConfig,
      { warn: vi.fn() },
      '/tmp/project',
      () => proc as unknown as ACPProcess,
      // Warm budget: deliberately small so a cold probe surviving far past it
      // proves the cold budget is a different, larger number.
      1_000,
    );
    return probe;
  }

  // Run the probe until it reaches the deferred `start` (the initialize
  // deadline race). Real fs happens in probeCwd; fake timers don't advance on
  // real awaits, so a bounded loop of microtask-flushing timer advances is
  // enough for it to land. Takes a GETTER: the factory may not have run yet
  // when this is first evaluated.
  async function untilStartCalled(
    getProc: () => ReturnType<typeof makeProcess>['proc'] | undefined,
  ) {
    let proc: ReturnType<typeof makeProcess>['proc'] | undefined;
    for (let i = 0; i < 200; i++) {
      proc = getProc();
      if (proc?.start.mock.calls.length) break;
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(proc?.start).toHaveBeenCalled();
  }

  test('the cold first background probe runs on the 60s budget, far past the warm one', async () => {
    vi.useFakeTimers();
    try {
      const { proc } = makeProcess();
      const probe = makeProbe(proc);
      const pending = probe.probe('background');

      await untilStartCalled(() => proc);

      // 59s in: FAR past the 1s warm budget. If the first probe ran on the
      // warm budget it would have settled (and destroyed the process) at
      // 1s. A cold engine measured at 40s initialize is still in flight.
      await vi.advanceTimersByTimeAsync(59_000);
      expect(proc.destroy).not.toHaveBeenCalled();
      expect(probe.lastProbeAt).toBe(0);

      // One tick past the 60s cold budget the deadline fires.
      await vi.advanceTimersByTimeAsync(1_001);
      await expect(pending).resolves.toBe(false);
      expect(proc.destroy).toHaveBeenCalled();
      expect(probe.lastError?.phase).toBe('initialize');
      expect(probe.lastError?.message).toContain('60000ms probe budget');
      await probe.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test('the second probe (warm re-probe) runs on the tight warm budget', async () => {
    vi.useFakeTimers();
    try {
      const procs: ReturnType<typeof makeProcess>[] = [];
      const probe = new ACPProbe(
        {
          id: 'opencode',
          name: 'OpenCode',
          command: '/opt/engines/opencode',
          // Configured cwd: see makeProbe — no fs under fake timers.
          cwd: '/tmp/station-acp-3404',
          enabled: true,
        } as ACPConnectionConfig,
        { warn: vi.fn() },
        '/tmp/project',
        () => {
          const made = makeProcess();
          procs.push(made);
          return made.proc as unknown as ACPProcess;
        },
        1_000,
      );

      // First probe succeeds, recording a handshake observation.
      const firstRun = probe.probe('background');
      await untilStartCalled(() => procs[0]?.proc);
      procs[0].start.resolve({ protocolVersion: 1, agentCapabilities: {} });
      const dbgVal = await firstRun;
      expect(dbgVal).toBe(true);
      expect(probe.getHandshakeObservedAt()).toBeGreaterThan(0);
      // Second probe: warm, and on the SAME background path — so what makes
      // it warm is the handshake it already has, not the initiator.
      const pending = probe.probe('background');
      await untilStartCalled(() => procs[1]?.proc);

      // Just past the 1s warm budget, the warm deadline fires. Assert the
      // teardown BEFORE awaiting `pending`: on a widened budget this probe
      // would still be in flight here, and awaiting it would hang to the test
      // timeout instead of failing at a guard that names what went wrong.
      await vi.advanceTimersByTimeAsync(1_001);
      expect(procs[1].proc.destroy).toHaveBeenCalled();
      await expect(pending).resolves.toBe(false);
      expect(probe.lastError?.message).toContain('1000ms probe budget');
      await probe.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  function makeProbeWithFactory(
    factory: () => ACPProcess,
    warmBudgetMs = 1_000,
  ) {
    return new ACPProbe(
      {
        id: 'opencode',
        name: 'OpenCode',
        command: '/opt/engines/opencode',
        cwd: '/tmp/station-acp-3404',
        enabled: true,
      } as ACPConnectionConfig,
      { warn: vi.fn() },
      '/tmp/project',
      factory,
      warmBudgetMs,
    );
  }

  test('a first attempt that never reached the engine does not consume the cold budget', async () => {
    vi.useFakeTimers();
    try {
      // The archive#3404 user story: Station probes an engine that is not installed
      // yet, the spawn fails with ENOENT in milliseconds, and the user then
      // installs it. The old discriminator (`lastProbeAt === 0`) treated that
      // failure as first contact ALREADY SPENT, so every later probe of this
      // same probe object ran on the warm budget against a stone-cold engine
      // and could never succeed.
      const { proc } = makeProcess();
      let spawns = 0;
      const probe = makeProbeWithFactory(() => {
        spawns += 1;
        if (spawns === 1) {
          throw Object.assign(new Error('spawn ENOENT /opt/engines/opencode'), {
            code: 'ENOENT',
          });
        }
        return proc as unknown as ACPProcess;
      });

      await expect(probe.probe('background')).rejects.toThrow('ENOENT');
      // The attempt is recorded — and it recorded nothing about the engine.
      expect(probe.lastProbeAt).toBeGreaterThan(0);
      expect(probe.getHandshakeObservedAt()).toBe(0);

      const pending = probe.probe('background');
      await untilStartCalled(() => proc);
      // 59s in — 58s past the warm budget this probe would be on if the
      // ENOENT had counted as first contact.
      await vi.advanceTimersByTimeAsync(59_000);
      expect(proc.destroy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_001);
      await expect(pending).resolves.toBe(false);
      expect(probe.lastError?.message).toContain('60000ms probe budget');
      await probe.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a request-initiated first contact stays on the warm budget', async () => {
    vi.useFakeTimers();
    try {
      // Create/update/Reconnect sit under the SDK client's 30s deadline and
      // the desktop broker's 20s one, inside the serialized configuration
      // -mutation queue. First contact or not, they do not get 60s.
      const { proc } = makeProcess();
      const probe = makeProbe(proc);
      expect(probe.getHandshakeObservedAt()).toBe(0);

      const pending = probe.probe('request');
      await untilStartCalled(() => proc);

      await vi.advanceTimersByTimeAsync(1_001);
      // Before awaiting: if the request path could take the cold budget this
      // handshake would still be in flight, and awaiting it would hang to the
      // test timeout rather than naming the guard that failed.
      expect(proc.destroy).toHaveBeenCalled();
      await expect(pending).resolves.toBe(false);
      expect(probe.lastError?.message).toContain('1000ms probe budget');
      await probe.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test('initialize and session/new share ONE deadline, not a budget each', async () => {
    vi.useFakeTimers();
    try {
      // Under a per-phase budget, `session/new` would start a FRESH 1000ms
      // allowance at t=600 and still be in flight at t=1001 — the probe would
      // cost up to 2x the number the budget names. The shared deadline is
      // what makes the documented ceiling arithmetic true.
      const start = deferred<any>();
      const session = deferred<any>();
      const proc = {
        start: vi.fn(() => start.promise),
        newSession: vi.fn(() => session.promise),
        destroy: vi.fn(async () => {}),
        forceGroupKill: vi.fn(),
        survivesCleanup: () => false,
        releaseIfConfirmedGone: () => {},
      };
      const probe = makeProbeWithFactory(() => proc as unknown as ACPProcess);

      const pending = probe.probe('request');
      await untilStartCalled(() => proc as any);

      // Spend 600ms of the 1000ms budget in `initialize`, then hand over to a
      // `session/new` that never settles.
      await vi.advanceTimersByTimeAsync(600);
      start.resolve({ protocolVersion: 1, agentCapabilities: {} });
      await vi.advanceTimersByTimeAsync(1);
      expect(proc.newSession).toHaveBeenCalled();

      // 401ms later the SHARED deadline is spent, and the failure names the
      // remainder it actually had rather than a second full budget. Assert
      // the teardown BEFORE awaiting `pending`: under a per-phase budget
      // `session/new` would still be inside a fresh 1000ms allowance here and
      // awaiting the probe would hang to the test timeout instead of naming
      // what went wrong.
      await vi.advanceTimersByTimeAsync(400);
      expect(proc.destroy).toHaveBeenCalled();
      await expect(pending).resolves.toBe(false);
      expect(probe.lastError?.phase).toBe('session creation');
      expect(probe.lastError?.message).toContain('probe budget');
      const remaining = Number(
        /within its (\d+)ms share/.exec(probe.lastError?.message ?? '')?.[1],
      );
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThan(1_000);
      await probe.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a handshake observation survives CONSECUTIVE failures, so a once-known connection never re-earns the cold budget', async () => {
    vi.useFakeTimers();
    try {
      // The engine handshakes at boot, then the user uninstalls it and two
      // sweeps fail. `lastSuccess` still holds the PREVIOUS run's outcome at
      // the top of the catch, so keying "has this ever handshaked" on it made
      // the SECOND consecutive failure reset `lastHandshakeObservedAt` to 0 —
      // putting a permanently broken connection back onto the 60s cold budget
      // (and onto PROBING in the manager view) for every sweep thereafter.
      const hang = deferred<any>();
      let attempt = 0;
      const spawned: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];
      // NON-EMPTY on purpose. The `else` branch this test guards against does
      // two things: it used to reset `lastHandshakeObservedAt`, and it still
      // clears the capability caches. With the empty payloads the rest of this
      // file uses, "cleared" and "retained" are byte-identical — so the
      // observation assertions below had power over the reset and none at all
      // over the branch's surviving effect, and reverting the discriminator to
      // `lastSuccess` went undetected in both directions.
      const makeProc = (start: () => Promise<any>) => {
        const proc = {
          start: vi.fn(start),
          newSession: vi.fn(
            async () =>
              ({
                sessionId: 's',
                modes: {
                  availableModes: [{ id: 'build', name: 'Build' }],
                },
                configOptions: [{ id: 'model', name: 'Model' }],
              }) as any,
          ),
          destroy: vi.fn(async () => {}),
          forceGroupKill: vi.fn(),
          survivesCleanup: () => false,
          releaseIfConfirmedGone: () => {},
        };
        spawned.push(proc);
        return proc as unknown as ACPProcess;
      };
      const probe = makeProbeWithFactory(() => {
        attempt += 1;
        if (attempt === 1) {
          return makeProc(async () => ({
            protocolVersion: 1,
            agentCapabilities: { mcpCapabilities: { http: true } },
          }));
        }
        if (attempt <= 3) {
          return makeProc(async () => {
            throw new Error('engine is no longer installed');
          });
        }
        return makeProc(() => hang.promise);
      });

      await expect(probe.probe('background')).resolves.toBe(true);
      const observedAt = probe.getHandshakeObservedAt();
      expect(observedAt).toBeGreaterThan(0);
      expect(probe.getModes()).toHaveLength(1);

      await expect(probe.probe('background')).resolves.toBe(false);
      await expect(probe.probe('background')).resolves.toBe(false);
      // The observation is a fact about the past. Two failures do not unmake
      // the handshake that happened.
      expect(probe.getHandshakeObservedAt()).toBe(observedAt);
      // And the SECOND consecutive failure still takes the retain branch. This
      // is the half `getHandshakeObservedAt` cannot see: with the
      // discriminator read off `lastSuccess` (which holds the PREVIOUS run's
      // outcome) the third run falls into the `else` and throws the cache the
      // engine actually gave us away, leaving the Connections hub's mode and
      // model pickers empty for a connection Station has met.
      expect(probe.getModes()).toHaveLength(1);
      expect(probe.getConfigOptions()).toHaveLength(1);
      expect(probe.getAgentCapabilities()).toEqual({
        mcpCapabilities: { http: true },
      });

      // And the budget follows it: a fourth probe on the SAME background path
      // is warm (1000ms here), not cold (60000ms).
      const pending = probe.probe('background');
      await untilStartCalled(() => spawned[3] as any);
      await vi.advanceTimersByTimeAsync(1_001);
      expect(spawned[3].destroy).toHaveBeenCalled();
      await expect(pending).resolves.toBe(false);
      expect(probe.lastError?.message).toContain('1000ms probe budget');
      await probe.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a settled probe run leaves nothing attached to the probe-lifetime dispose signal', async () => {
    vi.useFakeTimers();
    try {
      // The dispose signal is created once per CONNECTION and never fires
      // until `dispose()`, while `runWithinProbeDeadline` observes it twice
      // per probe run — so an observer that cannot be detached accumulates on
      // it for the life of the process. The first version of the abandon race
      // was `disposeRequested.then(...)` on a long-pending promise, which is
      // exactly that shape: measured at ~1,080 bytes retained per call, or
      // ~55MB after a month of five-minute sweeps on one connection.
      const procs: ReturnType<typeof makeProcess>[] = [];
      const probe = makeProbeWithFactory(() => {
        const made = makeProcess();
        procs.push(made);
        return made.proc as unknown as ACPProcess;
      });
      const disposeSignal = (
        probe as unknown as { disposeRequested: AbortController }
      ).disposeRequested.signal;

      // The instrument has power: a handshake phase that is actually in
      // flight is visible here as exactly one observer.
      const first = probe.probe('background');
      await untilStartCalled(() => procs[0]?.proc);
      expect(getEventListeners(disposeSignal, 'abort')).toHaveLength(1);
      procs[0].start.resolve({ protocolVersion: 1, agentCapabilities: {} });
      await expect(first).resolves.toBe(true);
      expect(getEventListeners(disposeSignal, 'abort')).toHaveLength(0);

      // Five more sweeps — ten more handshake phases — and the count is still
      // flat rather than growing by two a run.
      for (let i = 1; i <= 5; i++) {
        const run = probe.probe('background');
        await untilStartCalled(() => procs[i]?.proc);
        procs[i].start.resolve({ protocolVersion: 1, agentCapabilities: {} });
        await expect(run).resolves.toBe(true);
        expect(getEventListeners(disposeSignal, 'abort')).toHaveLength(0);
      }

      await probe.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a dispose that lands BEFORE the first handshake phase abandons it at once, not at its deadline', async () => {
    vi.useFakeTimers();
    try {
      // `runProbe` checks `disposed` before `await this.probeCwd()` and not
      // again before `initialize`, so a dispose landing in that window reaches
      // the race with the signal ALREADY aborted. A listener added to an
      // aborted `AbortSignal` never fires — so without the short-circuit that
      // rejects immediately, this probe would sit out its whole 60s cold
      // budget with nothing left to abandon it, which is the regression the
      // move off the pending promise could have introduced. The factory
      // callback is where the test gets to stand in that window.
      const { proc } = makeProcess();
      let disposal: Promise<void> | undefined;
      let probe: ACPProbe | undefined;
      probe = makeProbeWithFactory(() => {
        disposal ??= probe?.dispose();
        return proc as unknown as ACPProcess;
      });

      let settled = false;
      const pending = probe.probe('background').then((value) => {
        settled = true;
        return value;
      });
      // Microtasks only — deliberately NO timer advance, so the failure of a
      // probe that waits for its deadline is this named assertion rather than
      // a test timeout.
      for (let i = 0; i < 200; i++) await Promise.resolve();
      expect(settled).toBe(true);
      await expect(pending).resolves.toBe(false);
      expect(proc.destroy).toHaveBeenCalled();
      await disposal;
    } finally {
      vi.useRealTimers();
    }
  });

  test('dispose ABANDONS an in-flight cold handshake instead of waiting out its budget', async () => {
    vi.useFakeTimers();
    try {
      // `removeConnection` (PUT / DELETE / idempotent re-POST on
      // /api/connections/acp) awaits `dispose()` inside the serialized
      // agent-configuration queue. `runProbe` only observes `disposed`
      // BETWEEN phases, so a dispose landing during a 60s cold `initialize`
      // used to sit through the whole thing — a request paying for a
      // background probe's cold budget, past the 20s desktop broker bound and
      // the 30s SDK client deadline.
      const { proc } = makeProcess();
      const probe = makeProbe(proc);
      const pending = probe.probe('background');
      await untilStartCalled(() => proc);

      // 5s into a 60s cold budget: 55s of it remain and no timer is due.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(proc.destroy).not.toHaveBeenCalled();

      let disposeSettled = false;
      const disposal = probe.dispose().then(() => {
        disposeSettled = true;
      });
      // Microtasks only — deliberately NO timer advance. A dispose that
      // joined `probeFlight` on its own terms could not settle here, and the
      // failure is this named assertion rather than a test timeout.
      for (let i = 0; i < 100; i++) await Promise.resolve();
      expect(disposeSettled).toBe(true);
      await disposal;

      expect(proc.destroy).toHaveBeenCalled();
      await expect(pending).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('station#3404: isProbeInFlight tracks a real probe run', () => {
  // MEDIUM-1: the manager view reads this method to report PROBING instead of
  // UNAVAILABLE for a connection whose first handshake is still outstanding.
  // Every assertion here runs against a REAL ACPProbe: a hand-written double
  // returning `true` proves nothing about `probeFlight`'s lifetime, and a
  // `probeFlight` that never cleared would pin a broken connection on PROBING
  // forever.
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  function makeProbe(factory: () => ACPProcess) {
    return new ACPProbe(
      {
        id: 'opencode',
        name: 'OpenCode',
        command: '/opt/engines/opencode',
        // Configured cwd keeps probeCwd on its synchronous branch.
        cwd: '/tmp/station-acp-3404-inflight',
        enabled: true,
      } as ACPConnectionConfig,
      { warn: vi.fn() },
      '/tmp/project',
      factory,
      1_000,
    );
  }

  /** A process whose `start` is deferred and which announces when it is called. */
  function makeGatedProcess() {
    const start = deferred<any>();
    const started = deferred<void>();
    const proc = {
      start: vi.fn(() => {
        started.resolve();
        return start.promise;
      }),
      newSession: vi.fn(
        async () =>
          ({
            sessionId: 's',
            modes: { availableModes: [] },
            configOptions: [],
          }) as any,
      ),
      destroy: vi.fn(async () => {}),
      forceGroupKill: vi.fn(),
      survivesCleanup: () => false,
      releaseIfConfirmedGone: () => {},
    };
    return { proc, start, started };
  }

  test('true while a run is in flight, false once it succeeds', async () => {
    const { proc, start, started } = makeGatedProcess();
    const probe = makeProbe(() => proc as unknown as ACPProcess);

    expect(probe.isProbeInFlight()).toBe(false);
    const pending = probe.probe('request');
    await started.promise;
    expect(probe.isProbeInFlight()).toBe(true);

    start.resolve({ protocolVersion: 1, agentCapabilities: {} });
    await expect(pending).resolves.toBe(true);
    expect(probe.isProbeInFlight()).toBe(false);
    await probe.dispose();
  });

  test('false once a run fails', async () => {
    const { proc, start, started } = makeGatedProcess();
    const probe = makeProbe(() => proc as unknown as ACPProcess);

    const pending = probe.probe('request');
    await started.promise;
    expect(probe.isProbeInFlight()).toBe(true);

    start.reject(new Error('agent refused the handshake'));
    await expect(pending).resolves.toBe(false);
    expect(probe.isProbeInFlight()).toBe(false);
    await probe.dispose();
  });

  test('false when the process factory itself throws', async () => {
    // The spawn-factory path is the one where a stuck `true` would be worst:
    // it is how an engine that is not installed fails, and the view would
    // then report PROBING forever for a connection that cannot work. It is
    // also the only terminal path that RETHROWS rather than returning false,
    // so it exercises `probe()`'s finally on a rejection.
    const probe = makeProbe(() => {
      throw new Error('spawn ENOENT /opt/engines/opencode');
    });

    await expect(probe.probe('request')).rejects.toThrow('ENOENT');
    expect(probe.isProbeInFlight()).toBe(false);
    await probe.dispose();
  });
});
