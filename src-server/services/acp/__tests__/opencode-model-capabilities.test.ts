import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { acpRuntimeCatalogStatus } from '../../connections/connection-service-helpers.js';
import {
  addACPManagerConnection,
  reconnectACPManagerConnection,
  removeACPManagerConnection,
} from '../acp-manager-orchestration.js';
import { ACPProbe } from '../acp-probe.js';
import {
  invalidateOpenCodeModelCapabilities,
  type OpenCodeListingResult,
  openCodeModelImageInput,
  parseOpenCodeModelListing,
  refreshOpenCodeModelCapabilities,
  resetOpenCodeModelCapabilities,
  runOpenCodeModelListing,
} from '../opencode-model-capabilities.js';

// Captured from `opencode models --verbose` (OpenCode 1.18.18), trimmed to
// three models: image input false, true (with variants), and false for a
// provider-prefixed id that itself contains a slash.
const FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/opencode-models-verbose.txt', import.meta.url),
);
const FIXTURE = readFileSync(FIXTURE_PATH, 'utf8');

const OPENCODE: ACPConnectionConfig = {
  id: 'opencode',
  name: 'OpenCode',
  command: 'opencode',
  args: ['acp'],
  enabled: true,
};

const makeTempDir = trackTempDirs();

beforeEach(() => resetOpenCodeModelCapabilities());

describe('parseOpenCodeModelListing', () => {
  test('reads capabilities.input.image from the real listing shape', () => {
    const models = parseOpenCodeModelListing(FIXTURE);
    // output.image is false for every fixture model; only input counts.
    expect(models.get('opencode/big-pickle')).toBe(false);
    expect(models.get('opencode/fledge-alpha-free')).toBe(true);
    expect(models.get('openrouter/aion-labs/aion-2.0')).toBe(false);
  });

  test('a model with variants also answers for its variant option values', () => {
    const models = parseOpenCodeModelListing(FIXTURE);
    expect(models.get('opencode/fledge-alpha-free/high')).toBe(true);
    expect(models.get('opencode/fledge-alpha-free/low')).toBe(true);
    expect(models.has('opencode/fledge-alpha-free/nonexistent')).toBe(false);
  });

  test.each([
    ['empty output', ''],
    ['prose', 'Usage: opencode models [provider]\nunknown flag --verbose\n'],
    ['a JSON array', '[1,2,3]\n'],
    ['headers without bodies', 'opencode/a\nopencode/b\n'],
  ])('%s is unknown, not an error', (_name, stdout) => {
    expect(parseOpenCodeModelListing(stdout).size).toBe(0);
  });

  test('one malformed block or non-boolean flag omits only that model', () => {
    const broken = [
      'p/broken',
      '{',
      '  "id": "broken",',
      '}',
      'p/stringy',
      '{',
      '  "capabilities": { "input": { "image": "true" } }',
      '}',
      'p/good',
      '{',
      '  "capabilities": { "input": { "image": true } }',
      '}',
    ].join('\n');
    const models = parseOpenCodeModelListing(broken);
    expect([...models.entries()]).toEqual([['p/good', true]]);
  });

  test('tolerates CRLF line endings', () => {
    const models = parseOpenCodeModelListing(FIXTURE.replace(/\n/g, '\r\n'));
    expect(models.get('opencode/fledge-alpha-free')).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')(
  'runOpenCodeModelListing (real child process)',
  () => {
    let dir: string;
    beforeEach(() => {
      dir = makeTempDir('station-opencode-listing-');
    });

    const options = (script: string, extra = {}) => {
      const file = join(dir, 'fake.cjs');
      writeFileSync(file, script);
      return {
        argvPrefix: [file],
        resolveCommand: async (command: string) => command,
        env: async () => process.env,
        ...extra,
      };
    };

    test('spawns `models --verbose` with an argv array and returns stdout', async () => {
      const result = await runOpenCodeModelListing(
        process.execPath,
        options(
          `if (process.argv.slice(2).join(' ') !== 'models --verbose') process.exit(9);
process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(
            FIXTURE_PATH,
          )}, 'utf8'));`,
        ),
      );
      expect(result).toEqual({ ok: true, stdout: FIXTURE });
    });

    test('output of exactly the cap is accepted, one byte more is refused', async () => {
      const emit = (n: number) => `process.stdout.write('x'.repeat(${n}));`;
      await expect(
        runOpenCodeModelListing(
          process.execPath,
          options(emit(1000), { maxBytes: 1000 }),
        ),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        runOpenCodeModelListing(
          process.execPath,
          options(emit(1001), { maxBytes: 1000 }),
        ),
      ).resolves.toEqual({ ok: false, reason: 'oversized' });
    });

    test('an engine that never answers is killed at the timeout', async () => {
      const startedAt = Date.now();
      const result = await runOpenCodeModelListing(
        process.execPath,
        options('setInterval(() => {}, 1000);', { timeoutMs: 200 }),
      );
      expect(result).toEqual({ ok: false, reason: 'timeout' });
      expect(Date.now() - startedAt).toBeLessThan(5000);
    });

    // POSIX only: process groups are what the owned-child kill signals;
    // Windows uses taskkill and is not exercised here.
    test('a timeout kills the whole process group, including a grandchild', async () => {
      const pidFile = join(dir, 'grandchild.pid');
      const result = await runOpenCodeModelListing(
        process.execPath,
        options(
          `const { spawn } = require('node:child_process');
const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
setInterval(() => {}, 1000);`,
          { timeoutMs: 1000 },
        ),
      );
      expect(result).toEqual({ ok: false, reason: 'timeout' });
      const grandchild = Number(readFileSync(pidFile, 'utf8'));
      const alive = () => {
        try {
          process.kill(grandchild, 0);
          return true;
        } catch {
          return false;
        }
      };
      await vi.waitFor(() => expect(alive()).toBe(false), { timeout: 5000 });
    });

    test('a non-zero exit is a failure even when it printed a listing', async () => {
      const result = await runOpenCodeModelListing(
        process.execPath,
        options(`process.stdout.write('p/m\\n{}\\n'); process.exit(3);`),
      );
      expect(result).toEqual({ ok: false, reason: 'exit' });
    });

    test('a missing binary is reported as not installed', async () => {
      const result = await runOpenCodeModelListing('opencode', {
        resolveCommand: async () => null,
        env: async () => process.env,
      });
      expect(result).toEqual({ ok: false, reason: 'not-installed' });
    });

    test('a binary that cannot be launched is a failure, not a throw', async () => {
      const result = await runOpenCodeModelListing(join(dir, 'absent'), {
        resolveCommand: async (command) => command,
        env: async () => process.env,
      });
      expect(result).toEqual({ ok: false, reason: 'spawn-failed' });
    });
  },
);

describe('refreshOpenCodeModelCapabilities', () => {
  const okListing: OpenCodeListingResult = { ok: true, stdout: FIXTURE };

  test('fills the cache that the catalog reads', async () => {
    const run = vi.fn().mockResolvedValue(okListing);
    await refreshOpenCodeModelCapabilities(OPENCODE, { run });
    expect(openCodeModelImageInput('opencode', 'opencode/big-pickle')).toBe(
      false,
    );
    expect(
      openCodeModelImageInput('opencode', 'opencode/fledge-alpha-free'),
    ).toBe(true);
    expect(openCodeModelImageInput('opencode', 'unlisted/model')).toBe(
      undefined,
    );
    expect(openCodeModelImageInput('other', 'opencode/big-pickle')).toBe(
      undefined,
    );
  });

  test('a connection whose command is not OpenCode never runs the listing', async () => {
    const run = vi.fn().mockResolvedValue(okListing);
    await refreshOpenCodeModelCapabilities(
      { ...OPENCODE, id: 'kiro', command: '/usr/local/bin/kiro-cli' },
      { run },
    );
    expect(run).not.toHaveBeenCalled();
  });

  test.each([['/opt/bin/opencode'], ['C:\\Users\\a\\opencode.exe']])(
    'recognises the OpenCode binary by name: %s',
    async (command) => {
      const run = vi.fn().mockResolvedValue(okListing);
      await refreshOpenCodeModelCapabilities({ ...OPENCODE, command }, { run });
      expect(run).toHaveBeenCalledWith(command);
    },
  );

  test.each<[string, OpenCodeListingResult]>([
    ['not installed', { ok: false, reason: 'not-installed' }],
    ['timeout', { ok: false, reason: 'timeout' }],
    ['oversized', { ok: false, reason: 'oversized' }],
    ['unrecognised output', { ok: true, stdout: 'Usage: opencode\n' }],
  ])(
    '%s leaves every model unknown and logs one reason-only line',
    async (_name, listing) => {
      const logger = { warn: vi.fn() };
      await refreshOpenCodeModelCapabilities(OPENCODE, {
        run: async () => listing,
        logger,
      });
      expect(openCodeModelImageInput('opencode', 'opencode/big-pickle')).toBe(
        undefined,
      );
      expect(logger.warn).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(logger.warn.mock.calls[0]);
      expect(logged).not.toContain('big-pickle');
      expect(
        Object.keys(logger.warn.mock.calls[0][1] as object).sort(),
      ).toEqual(['id', 'reason']);
    },
  );

  test('a throwing runner is absorbed', async () => {
    const logger = { warn: vi.fn() };
    await expect(
      refreshOpenCodeModelCapabilities(OPENCODE, {
        run: async () => {
          throw new Error('boom');
        },
        logger,
      }),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test('does not re-run while fresh; re-runs after the TTL, a config change, or invalidation', async () => {
    let clock = 1_000;
    const run = vi.fn().mockResolvedValue(okListing);
    const deps = { run, now: () => clock };
    await refreshOpenCodeModelCapabilities(OPENCODE, deps);
    await refreshOpenCodeModelCapabilities(OPENCODE, deps);
    expect(run).toHaveBeenCalledTimes(1);

    await refreshOpenCodeModelCapabilities(
      { ...OPENCODE, command: '/other/opencode' },
      deps,
    );
    expect(run).toHaveBeenCalledTimes(2);

    invalidateOpenCodeModelCapabilities('opencode');
    expect(openCodeModelImageInput('opencode', 'opencode/big-pickle')).toBe(
      undefined,
    );
    await refreshOpenCodeModelCapabilities(OPENCODE, deps);
    expect(run).toHaveBeenCalledTimes(3);

    clock += 61 * 60_000;
    await refreshOpenCodeModelCapabilities(OPENCODE, deps);
    expect(run).toHaveBeenCalledTimes(4);
  });

  test('a failed refresh keeps the last good answers; a never-good connection stays unknown', async () => {
    let clock = 0;
    const deps = (run: () => Promise<OpenCodeListingResult>) => ({
      run,
      now: () => clock,
    });
    await refreshOpenCodeModelCapabilities(
      OPENCODE,
      deps(async () => okListing),
    );
    clock += 61 * 60_000;
    const logger = { warn: vi.fn() };
    await refreshOpenCodeModelCapabilities(OPENCODE, {
      ...deps(async () => ({ ok: false, reason: 'timeout' })),
      logger,
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(openCodeModelImageInput('opencode', 'opencode/big-pickle')).toBe(
      false,
    );
    expect(
      openCodeModelImageInput('opencode', 'opencode/fledge-alpha-free'),
    ).toBe(true);

    // The failure still sets the shorter retry cadence.
    const run = vi.fn().mockResolvedValue(okListing);
    clock += 16 * 60_000;
    await refreshOpenCodeModelCapabilities(OPENCODE, deps(run));
    expect(run).toHaveBeenCalledTimes(1);

    resetOpenCodeModelCapabilities();
    await refreshOpenCodeModelCapabilities(
      OPENCODE,
      deps(async () => ({ ok: false, reason: 'exit' })),
    );
    expect(openCodeModelImageInput('opencode', 'opencode/big-pickle')).toBe(
      undefined,
    );
  });

  test('answers cached for other launch settings are unknown for the current ones', async () => {
    await refreshOpenCodeModelCapabilities(OPENCODE, {
      run: async () => okListing,
    });
    const id = 'opencode/big-pickle';
    expect(openCodeModelImageInput('opencode', id, OPENCODE)).toBe(false);
    expect(
      openCodeModelImageInput('opencode', id, {
        ...OPENCODE,
        command: '/elsewhere/other-engine',
      }),
    ).toBe(undefined);
    expect(
      openCodeModelImageInput('opencode', id, { ...OPENCODE, args: ['x'] }),
    ).toBe(undefined);
  });

  test('concurrent handshakes share one listing', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(async () => {
      await gate;
      return okListing;
    });
    const first = refreshOpenCodeModelCapabilities(OPENCODE, { run });
    const second = refreshOpenCodeModelCapabilities(OPENCODE, { run });
    release();
    await Promise.all([first, second]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('a listing that was running when the connection was invalidated is discarded', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stale = refreshOpenCodeModelCapabilities(OPENCODE, {
      run: async () => {
        await gate;
        return okListing;
      },
    });
    invalidateOpenCodeModelCapabilities('opencode');
    release();
    await stale;
    expect(openCodeModelImageInput('opencode', 'opencode/big-pickle')).toBe(
      undefined,
    );
  });
});

describe('catalog fill', () => {
  const liveStatus = (id: string) =>
    ({
      id,
      status: 'available',
      handshakeObservedAt: '2026-10-01T00:00:00.000Z',
      configOptions: [
        {
          category: 'model',
          options: [
            { value: 'opencode/big-pickle', name: 'Big Pickle' },
            { value: 'opencode/fledge-alpha-free', name: 'Fledge' },
            { value: 'opencode/fledge-alpha-free/high', name: 'Fledge high' },
            { value: 'openrouter/aion-labs/aion-2.0', name: 'Aion' },
            { value: 'unlisted/model', name: 'Unlisted' },
          ],
        },
      ],
    }) as never;

  test('fills imageInput per OpenCode model, variants included, and leaves unlisted models absent', async () => {
    await refreshOpenCodeModelCapabilities(OPENCODE, {
      run: async () => ({ ok: true, stdout: FIXTURE }),
    });
    const models = acpRuntimeCatalogStatus(liveStatus('opencode')).models;
    expect(
      Object.fromEntries(
        models.map((model) => [model.id, model.capabilities?.imageInput]),
      ),
    ).toEqual({
      'opencode/big-pickle': false,
      'opencode/fledge-alpha-free': true,
      'opencode/fledge-alpha-free/high': true,
      'openrouter/aion-labs/aion-2.0': false,
      'unlisted/model': undefined,
    });
    // Absent means no `capabilities` key at all, not `imageInput: undefined`.
    expect(models.find((m) => m.id === 'unlisted/model')).not.toHaveProperty(
      'capabilities',
    );
  });

  test('an edited connection reads unknown until it is re-listed', async () => {
    await refreshOpenCodeModelCapabilities(OPENCODE, {
      run: async () => ({ ok: true, stdout: FIXTURE }),
    });
    const edited = { ...OPENCODE, command: '/elsewhere/other-engine' };
    const models = acpRuntimeCatalogStatus(
      liveStatus('opencode'),
      edited,
    ).models;
    expect(models.every((model) => !('capabilities' in model))).toBe(true);
    const same = acpRuntimeCatalogStatus(
      liveStatus('opencode'),
      OPENCODE,
    ).models;
    expect(same[0]?.capabilities?.imageInput).toBe(false);
  });

  test('another engine with the same model ids is untouched', async () => {
    await refreshOpenCodeModelCapabilities(OPENCODE, {
      run: async () => ({ ok: true, stdout: FIXTURE }),
    });
    const models = acpRuntimeCatalogStatus(liveStatus('kiro')).models;
    expect(models.every((model) => !('capabilities' in model))).toBe(true);
  });
});

describe('ACPProbe handshake hook', () => {
  const handshakeProcess = () => ({
    start: vi.fn().mockResolvedValue({
      protocolVersion: 1,
      agentCapabilities: { promptCapabilities: { image: true } },
    }),
    newSession: vi
      .fn()
      .mockResolvedValue({ sessionId: 's', configOptions: [] }),
    destroy: vi.fn().mockResolvedValue(undefined),
    survivesCleanup: vi.fn().mockResolvedValue(false),
    releaseIfConfirmedGone: vi.fn(),
  });

  test('is called once a handshake succeeds, and a throwing hook does not fail it', async () => {
    const hook = vi.fn((_config: ACPConnectionConfig) => {
      throw new Error('hook failed');
    });
    const probe = new ACPProbe(
      { ...OPENCODE, cwd: tmpdir() },
      { warn: vi.fn() },
      tmpdir(),
      () => handshakeProcess() as never,
      undefined,
      undefined,
      hook,
    );
    await expect(probe.probe('request')).resolves.toBe(true);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0]?.[0]).toMatchObject({ id: 'opencode' });
  });

  test('is not called when the handshake fails', async () => {
    const hook = vi.fn((_config: ACPConnectionConfig) => {});
    const failing = handshakeProcess();
    failing.start.mockRejectedValue(new Error('no engine'));
    const probe = new ACPProbe(
      { ...OPENCODE, cwd: tmpdir() },
      { warn: vi.fn() },
      tmpdir(),
      () => failing as never,
      undefined,
      undefined,
      hook,
    );
    await probe.probe('request');
    expect(hook).not.toHaveBeenCalled();
  });
});

describe('manager wiring', () => {
  test('removing and reconnecting a connection invalidates its cached answer', async () => {
    const seed = () =>
      refreshOpenCodeModelCapabilities(OPENCODE, {
        run: async () => ({ ok: true, stdout: FIXTURE }),
      });
    await seed();
    await removeACPManagerConnection({
      id: 'opencode',
      probes: new Map(),
      configs: new Map(),
    });
    expect(openCodeModelImageInput('opencode', 'opencode/big-pickle')).toBe(
      undefined,
    );

    await seed();
    await reconnectACPManagerConnection({
      id: 'opencode',
      probes: new Map([['opencode', { probe: async () => true }]]),
    });
    expect(openCodeModelImageInput('opencode', 'opencode/big-pickle')).toBe(
      undefined,
    );
  });

  describe.skipIf(process.platform === 'win32')(
    'with a real OpenCode-named engine',
    () => {
      let dir: string;
      beforeEach(() => {
        dir = makeTempDir('station-opencode-e2e-');
      });

      test('a manager handshake fills the cache the catalog then reports', async () => {
        const binary = join(dir, 'opencode');
        writeFileSync(
          binary,
          `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === 'models') {
  process.stdout.write(fs.readFileSync(${JSON.stringify(
    FIXTURE_PATH,
  )}, 'utf8'));
  process.exit(0);
}
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
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
    if (request.method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } });
    else if (request.method === 'session/new') reply({ sessionId: 's1', configOptions: [{ category: 'model', options: [{ value: 'opencode/big-pickle', name: 'Big Pickle' }] }] });
  }
});
`,
        );
        chmodSync(binary, 0o755);
        const probes = new Map<string, never>();
        const config: ACPConnectionConfig = {
          id: 'opencode',
          name: 'OpenCode',
          command: binary,
          args: ['acp'],
          cwd: dir,
          enabled: true,
        };
        try {
          await expect(
            addACPManagerConnection({
              config,
              probes: probes as never,
              configs: new Map(),
              logger: { warn: vi.fn(), debug: vi.fn() },
              managedWorkspaceHomeDir: dir,
              removeConnection: async () => undefined,
            }),
          ).resolves.toBe(true);
          await vi.waitFor(
            () =>
              expect(
                openCodeModelImageInput('opencode', 'opencode/big-pickle'),
              ).toBe(false),
            { timeout: 15_000 },
          );
        } finally {
          for (const probe of probes.values()) {
            await (probe as { dispose?: () => Promise<void> }).dispose?.();
          }
        }
      }, 30_000);
    },
  );
});
