import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectStationHomeRecovery } from '../station-home-recovery-preflight.js';
import {
  ensureStationHomeSchemaSync,
  STATION_HOME_SCHEMA_FILE,
} from '../station-home-schema.js';

const roots: string[] = [];
function put(home: string, path: string, value: unknown) {
  const file = join(home, path);
  fs.mkdirSync(dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}
function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(join(tmpdir(), 'station-recovery-plan-')),
  );
  roots.push(root);
  const home = join(root, 'home');
  fs.mkdirSync(home);
  put(home, STATION_HOME_SCHEMA_FILE, { version: 1 });
  return home;
}
function registry(
  home: string,
  connections = [{ id: 'codex', runtimeConnectionId: 'codex-runtime' }],
) {
  put(home, 'config/agent-registry.json', {
    version: 1,
    revision: 0,
    engineConnections: connections,
    defaultAgents: [
      { id: 'station', kind: 'station' },
      ...connections.map(({ id }) => ({
        id,
        kind: 'engine-connection',
        engineConnectionId: id,
      })),
    ],
  });
}
function forbidEffects() {
  const spies = [
    ...(
      [
        'writeFileSync',
        'appendFileSync',
        'mkdirSync',
        'mkdtempSync',
        'renameSync',
        'rmSync',
        'unlinkSync',
        'copyFileSync',
        'cpSync',
        'linkSync',
        'symlinkSync',
        'chmodSync',
        'writeSync',
        'truncateSync',
      ] as const
    ).map((name) =>
      vi.spyOn(fs, name).mockImplementation(() => {
        throw new Error(`unexpected write: ${name}`);
      }),
    ),
    ...(
      [
        'spawn',
        'spawnSync',
        'exec',
        'execSync',
        'execFile',
        'execFileSync',
        'fork',
      ] as const
    ).map((name) =>
      vi.spyOn(childProcess, name).mockImplementation(() => {
        throw new Error(`unexpected process: ${name}`);
      }),
    ),
  ];
  syncBuiltinESMExports();
  return () => {
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe('read-only home recovery preflight', () => {
  it('observes v1 without bootstrapping a missing registry or relaxing startup', () => {
    const home = fixture();
    const assertNoEffects = forbidEffects();
    const plan = inspectStationHomeRecovery({ homeDir: home });
    expect(plan).toMatchObject({
      sourceSchemaVersion: 1,
      inspection: 'partial',
      applyAllowed: false,
      migration: 'not-implemented',
    });
    expect(plan.codes).toContain('missing-registry');
    assertNoEffects();
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    expect(fs.existsSync(join(home, 'config'))).toBe(false);
    expect(() => ensureStationHomeSchemaSync(home)).toThrow(
      'STATION_HOME_RESET_REQUIRED',
    );
    expect(
      JSON.parse(fs.readFileSync(join(home, STATION_HOME_SCHEMA_FILE), 'utf8')),
    ).toEqual({ version: 1 });
  });

  it('keeps identity mappings exact, history separate, and known opaque payloads unopened', () => {
    const home = fixture();
    registry(home);
    put(home, 'config/app.json', {
      agentConnections: { codex: { config: { secret: 'synthetic-private' } } },
      builtinAgentEngineConnectionId: 'codex-runtime',
    });
    put(home, 'agents/custom/agent.json', {
      execution: {
        agentConnectionId: 'codex',
        credentialProfileRef: 'synthetic-ref',
      },
    });
    const opaque = [
      'app-homes/private/credentials.json',
      'security/tool-server-credentials.json',
      'config/host-credentials.json',
      'config/providers.json',
      'projects/p/conversations.json',
      'data/orchestration.sqlite',
      'scheduler/scheduler.sqlite',
      'plugin-grants.json',
      'quarantine/legacy-service-manifest/committed.json',
      'plugins/private/index.js',
    ];
    for (const path of opaque)
      put(home, path, { secret: 'synthetic-unopened' });
    const opened: string[] = [];
    const original = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
      opened.push(String(args[0]));
      expect(opaque.map((path) => join(home, path))).not.toContain(
        String(args[0]),
      );
      expect(args[1]).toBe(
        fs.constants.O_RDONLY |
          (fs.constants.O_NOFOLLOW ?? 0) |
          (fs.constants.O_NONBLOCK ?? 0),
      );
      return original(...args);
    });
    const assertNoEffects = forbidEffects();
    const plan = inspectStationHomeRecovery({ homeDir: home });
    expect(plan.identities).toEqual({
      builtinSelection: 'explicit-engine',
      connections: 1,
      exactReferences: 3,
      unresolvedReferences: 1,
      differingRuntimeSelectors: 1,
      agentCredentialReferences: 1,
    });
    expect(plan.codes).toEqual(
      expect.arrayContaining([
        'unresolved-binding',
        'owner-mapping-required',
        'payload-not-inspected',
      ]),
    );
    expect(opened).toHaveLength(4);
    expect(JSON.stringify(plan)).not.toMatch(
      /synthetic-|codex|credentials.json|station-recovery-plan-/,
    );
    expect(plan.stores.find((row) => row.store === 'history')).toMatchObject({
      entries: 2,
      inspectedRecords: 0,
      disposition: 'history-not-resume-authority',
    });
    assertNoEffects();
  });

  it('does not alias two registry identities through the same runtime selector', () => {
    const home = fixture();
    registry(home, [
      { id: 'one', runtimeConnectionId: 'same' },
      { id: 'two', runtimeConnectionId: 'same' },
    ]);
    const plan = inspectStationHomeRecovery({ homeDir: home });
    expect(plan.codes).toContain('identity-conflict');
    expect(plan.applyAllowed).toBe(false);
  });
  it('detects a runtime selector colliding with another exact connection id', () => {
    const home = fixture();
    registry(home, [
      { id: 'one', runtimeConnectionId: 'two' },
      { id: 'two', runtimeConnectionId: 'two' },
    ]);
    expect(inspectStationHomeRecovery({ homeDir: home }).codes).toContain(
      'identity-conflict',
    );
  });
  it('detects duplicate connections and default Agents', () => {
    const home = fixture();
    registry(home, [
      { id: 'one', runtimeConnectionId: 'one' },
      { id: 'one', runtimeConnectionId: 'one' },
    ]);
    expect(inspectStationHomeRecovery({ homeDir: home }).codes).toContain(
      'identity-conflict',
    );
  });
  it('uses the canonical identity parser to reject UUID-shaped identities', () => {
    const home = fixture();
    registry(home, [
      {
        id: 'abcd1234-abcd-4123-8123-abcdef123456',
        runtimeConnectionId: 'codex',
      },
    ]);
    expect(inspectStationHomeRecovery({ homeDir: home }).codes).toContain(
      'invalid-shape',
    );
  });
  it('reports a mixed home-marker/registry schema instead of accepting a partial cutover', () => {
    const home = fixture();
    registry(home);
    put(home, STATION_HOME_SCHEMA_FILE, { version: 2 });
    expect(inspectStationHomeRecovery({ homeDir: home }).codes).toContain(
      'store-schema-conflict',
    );
  });
  it.each([
    { version: 1, revision: -1, engineConnections: [], defaultAgents: [] },
    {
      version: 1,
      revision: 0,
      engineConnections: [{ id: 'bad_id' }],
      defaultAgents: [],
    },
    {
      version: 2,
      revision: 0,
      engineConnections: [
        { id: 'codex', runtimeConnectionId: 'codex-runtime' },
      ],
      defaultAgents: [],
    },
  ])('refuses malformed registry selected fields: %j', (value) => {
    const home = fixture();
    put(home, 'config/agent-registry.json', value);
    expect(inspectStationHomeRecovery({ homeDir: home })).toMatchObject({
      inspection: 'refused',
      codes: expect.arrayContaining(['invalid-shape']),
    });
  });
  it('does not fabricate an explicit external binding from an absent or null selection', () => {
    const home = fixture();
    registry(home, []);
    put(home, 'config/app.json', { builtinAgentEngineConnectionId: null });
    put(home, 'agents/station/agent.json', { execution: {} });
    expect(
      inspectStationHomeRecovery({ homeDir: home }).identities
        .unresolvedReferences,
    ).toBe(0);
    expect(
      inspectStationHomeRecovery({ homeDir: home }).identities.builtinSelection,
    ).toBe('explicit-station');
    put(home, 'config/app.json', {});
    expect(
      inspectStationHomeRecovery({ homeDir: home }).identities
        .unresolvedReferences,
    ).toBe(0);
    expect(
      inspectStationHomeRecovery({ homeDir: home }).identities.builtinSelection,
    ).toBe('not-recorded');
  });

  it('refuses a missing home without creating any path', () => {
    const home = fixture();
    const missing = join(home, 'missing', 'nested');
    const assertNoEffects = forbidEffects();
    expect(inspectStationHomeRecovery({ homeDir: missing })).toMatchObject({
      inspection: 'refused',
      codes: ['missing-home'],
    });
    assertNoEffects();
    expect(fs.existsSync(missing)).toBe(false);
  });
  it('reports a missing marker independently of missing registry', () => {
    const home = fixture();
    fs.unlinkSync(join(home, STATION_HOME_SCHEMA_FILE));
    expect(inspectStationHomeRecovery({ homeDir: home }).codes).toEqual([
      'missing-registry',
      'missing-schema',
    ]);
  });
  it.each([0, 3, 99])('does not admit unsupported schema %s', (version) => {
    const home = fixture();
    put(home, STATION_HOME_SCHEMA_FILE, { version });
    expect(inspectStationHomeRecovery({ homeDir: home }).codes).toContain(
      'unsupported-schema',
    );
  });
  it.each([null, [], { version: '1' }, { version: 1, extra: true }])(
    'refuses malformed schema without raw error output: %j',
    (value) => {
      const home = fixture();
      put(home, STATION_HOME_SCHEMA_FILE, value);
      expect(inspectStationHomeRecovery({ homeDir: home })).toMatchObject({
        inspection: 'refused',
        codes: ['invalid-shape'],
      });
    },
  );
  it('refuses corrupt selected JSON and never prints its content', () => {
    const home = fixture();
    fs.mkdirSync(join(home, 'config'));
    fs.writeFileSync(
      join(home, 'config/app.json'),
      '{private-transcript-bidi-\u202e',
    );
    const plan = inspectStationHomeRecovery({ homeDir: home });
    expect(plan.codes).toContain('invalid-json');
    expect(JSON.stringify(plan)).not.toContain('private');
  });
  it('reports unknown stores without reading their bytes or enumerating unknown subtrees', () => {
    const home = fixture();
    put(home, 'private-name/nested/unrecognized.json', {});
    const plan = inspectStationHomeRecovery({ homeDir: home });
    expect(plan.codes).toContain('unknown-store');
    expect(plan.stores.find((row) => row.store === 'unknown')).toMatchObject({
      entries: 1,
      inspectedRecords: 0,
    });
    expect(JSON.stringify(plan)).not.toContain('private-name');
  });
  it.each(['fileBytes', 'totalReadBytes', 'entries', 'depth'] as const)(
    'enforces %s bounds',
    (key) => {
      const home = fixture();
      registry(home);
      const plan = inspectStationHomeRecovery({
        homeDir: home,
        limits: { [key]: 1 },
      });
      expect(plan).toMatchObject({
        inspection: 'refused',
        codes: expect.arrayContaining(['limit-exceeded']),
      });
    },
  );
  it('bounds cumulative bytes across individually small selected files', () => {
    const home = fixture();
    put(home, 'config/app.json', {});
    const markerBytes = fs.statSync(join(home, STATION_HOME_SCHEMA_FILE)).size;
    const plan = inspectStationHomeRecovery({
      homeDir: home,
      limits: { totalReadBytes: markerBytes + 1 },
    });
    expect(plan.sourceSchemaVersion).toBe(1);
    expect(plan.codes).toContain('limit-exceeded');
  });
  it('refuses oversized sparse selected metadata before opening its descriptor', () => {
    const home = fixture();
    fs.truncateSync(join(home, STATION_HOME_SCHEMA_FILE), 1024 * 1024);
    const beforeRead = vi.fn();
    expect(
      inspectStationHomeRecovery({ homeDir: home, hooks: { beforeRead } })
        .codes,
    ).toEqual(['limit-exceeded']);
    expect(beforeRead).not.toHaveBeenCalled();
  });
  it.each([0, -1, NaN, Infinity, 2 ** 32])(
    'rejects invalid/raised bounds %s',
    (entries) => {
      expect(
        inspectStationHomeRecovery({ homeDir: fixture(), limits: { entries } })
          .codes,
      ).toEqual(['limit-exceeded']);
    },
  );
  it('refuses symlinked roots and ancestors', () => {
    const home = fixture();
    const alias = join(dirname(home), 'alias');
    fs.symlinkSync(home, alias, 'dir');
    expect(inspectStationHomeRecovery({ homeDir: alias }).codes).toEqual([
      'unsafe-path',
    ]);
    expect(
      inspectStationHomeRecovery({ homeDir: join(alias, 'nested') }).codes,
    ).toEqual(['unsafe-path']);
  });
  it('refuses a symlinked selected file before opening it', () => {
    const home = fixture();
    const marker = join(home, STATION_HOME_SCHEMA_FILE);
    const outside = join(dirname(home), 'outside');
    fs.renameSync(marker, outside);
    fs.symlinkSync(outside, marker);
    const hook = vi.fn();
    expect(
      inspectStationHomeRecovery({ homeDir: home, hooks: { beforeRead: hook } })
        .codes,
    ).toEqual(['unsafe-path']);
    expect(hook).not.toHaveBeenCalled();
  });
  it('refuses a hard-linked selected file before reading it', () => {
    const home = fixture();
    fs.linkSync(
      join(home, STATION_HOME_SCHEMA_FILE),
      join(dirname(home), 'linked'),
    );
    expect(inspectStationHomeRecovery({ homeDir: home }).codes).toEqual([
      'unsafe-path',
    ]);
  });
  it('refuses an identical-byte inode replacement at the real open boundary', () => {
    const home = fixture();
    const plan = inspectStationHomeRecovery({
      homeDir: home,
      hooks: {
        beforeRead: (path) => {
          fs.renameSync(join(home, path), join(dirname(home), 'old-marker'));
          put(home, path, { version: 1 });
        },
      },
    });
    expect(plan).toMatchObject({
      inspection: 'refused',
      codes: ['changed-during-inspection'],
    });
  });

  // POSIX FIFO behaviour is not a Windows proof. Both children are bounded
  // after an IPC receipt proves that module startup and pathname checks ended.
  it.skipIf(process.platform === 'win32')(
    'refuses a real FIFO substituted at openSync; the old blocking flags hang at that same boundary',
    async () => {
      async function probe(stripNonblock: boolean) {
        const home = fixture();
        const fifo = join(dirname(home), 'prepared-fifo');
        childProcess.execFileSync('mkfifo', [fifo], {
          windowsHide: true,
          timeout: 10_000,
        });
        const marker = join(home, STATION_HOME_SCHEMA_FILE);
        const source = `
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        const { inspectStationHomeRecovery } = await import(${JSON.stringify(new URL('../station-home-recovery-preflight.ts', import.meta.url).href)});
        const original = fs.openSync;
        const marker = ${JSON.stringify(marker)};
        fs.openSync = function(path, flags, ...rest) {
          if (path === marker) {
            // The spy runs INSIDE the actual open call, after every pre-open
            // pathname check. Fixture setup supplied this real FIFO earlier.
            fs.renameSync(${JSON.stringify(fifo)}, marker);
            const effectiveFlags = ${stripNonblock} ? flags & ~fs.constants.O_NONBLOCK : flags;
            process.send({ kind: 'opening-fifo', passedFlags: flags, effectiveFlags, fifo: fs.lstatSync(marker).isFIFO() });
            return original.call(fs, path, effectiveFlags, ...rest);
          }
          return original.call(fs, path, flags, ...rest);
        };
        syncBuiltinESMExports();
        const result = inspectStationHomeRecovery({ homeDir: ${JSON.stringify(home)} });
        process.send({ kind: 'result', result }, () => process.disconnect());
      `;
        const child = childProcess.spawn(
          process.execPath,
          ['--import', 'tsx', '--input-type=module', '-e', source],
          {
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
            env: {
              ...process.env,
              STATION_ROOT: join(dirname(home), 'isolated-station-root'),
            },
          },
        );
        return await new Promise<{
          boundary?: {
            passedFlags: number;
            effectiveFlags: number;
            fifo: boolean;
          };
          result?: ReturnType<typeof inspectStationHomeRecovery>;
          timedOut: 'startup' | 'open' | null;
          code: number | null;
          stderr: string;
        }>((resolve, reject) => {
          let boundary:
            | { passedFlags: number; effectiveFlags: number; fifo: boolean }
            | undefined;
          let result: ReturnType<typeof inspectStationHomeRecovery> | undefined;
          let timedOut: 'startup' | 'open' | null = null;
          let stderr = '';
          let timer = setTimeout(() => {
            timedOut = 'startup';
            child.kill('SIGKILL');
          }, 10_000);
          child.stderr?.on('data', (chunk) => {
            stderr = (stderr + String(chunk)).slice(-2048);
          });
          child.on('message', (message) => {
            const value = message as {
              kind: string;
              passedFlags: number;
              effectiveFlags: number;
              fifo: boolean;
              result: ReturnType<typeof inspectStationHomeRecovery>;
            };
            if (value.kind === 'opening-fifo') {
              boundary = value;
              clearTimeout(timer);
              // The legacy child has no writer and must remain blocked until
              // killed; the fixed child may return immediately. This is a
              // deadlock guard, not a latency/performance acceptance threshold.
              timer = setTimeout(
                () => {
                  timedOut = 'open';
                  child.kill('SIGKILL');
                },
                stripNonblock ? 150 : 10_000,
              );
            } else if (value.kind === 'result') result = value.result;
          });
          child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once('close', (code) => {
            clearTimeout(timer);
            resolve({ boundary, result, timedOut, code, stderr });
          });
        });
      }
      const fixed = await probe(false);
      expect(fixed.stderr).toBe('');
      expect(fixed.boundary?.fifo).toBe(true);
      expect(
        (fixed.boundary?.passedFlags ?? 0) & fs.constants.O_NONBLOCK,
      ).not.toBe(0);
      expect(fixed).toMatchObject({
        code: 0,
        timedOut: null,
        result: {
          inspection: 'refused',
          applyAllowed: false,
          codes: ['changed-during-inspection'],
        },
      });
      const legacy = await probe(true);
      expect(legacy.boundary?.fifo).toBe(true);
      expect(
        (legacy.boundary?.effectiveFlags ?? -1) & fs.constants.O_NONBLOCK,
      ).toBe(0);
      expect(legacy.timedOut).toBe('open');
      expect(legacy.result).toBeUndefined();
    },
    45_000,
  );
  it('refuses a parent swap before any payload can be opened under the new parent', () => {
    const home = fixture();
    registry(home);
    const plan = inspectStationHomeRecovery({
      homeDir: home,
      hooks: {
        beforeRead: (path) => {
          if (path !== 'config/agent-registry.json') return;
          fs.renameSync(
            join(home, 'config'),
            join(dirname(home), 'old-config'),
          );
          registry(home);
        },
      },
    });
    expect(plan.codes).toContain('changed-during-inspection');
    expect(plan.inspection).toBe('refused');
  });
  it('invalidates observations changed after inventory', () => {
    const home = fixture();
    const plan = inspectStationHomeRecovery({
      homeDir: home,
      hooks: {
        afterInventory: () =>
          put(home, STATION_HOME_SCHEMA_FILE, { version: 2 }),
      },
    });
    expect(plan.inspection).toBe('refused');
    expect(plan.codes).toContain('changed-during-inspection');
  });
  it('reports live PID presence but never proves exact ownership or legacy exclusion', () => {
    const home = fixture();
    put(home, 'instances.json', {
      version: 1,
      instances: {
        private: {
          port: 9999,
          type: 'service',
          pid: process.pid,
          birth: 'unverified',
          env: { SECRET: 'synthetic-private' },
        },
        unknown: { port: 9998, type: 'inline' },
      },
    });
    const assertNoEffects = forbidEffects();
    const plan = inspectStationHomeRecovery({ homeDir: home });
    expect(plan.owners).toMatchObject({
      recordedInstances: 2,
      pidPresent: 1,
      unknown: 1,
      exclusion: 'not-proven',
      modernLeases: 'not-inspected',
      legacyProfiles: 'not-inspected',
    });
    expect(JSON.stringify(plan)).not.toContain('synthetic-private');
    assertNoEffects();
  });
  it.each(['EPERM', 'ESRCH'])(
    'reports %s as an observation, not mutation authority',
    (code) => {
      const home = fixture();
      put(home, 'instances.json', {
        version: 1,
        instances: { owner: { port: 9999, type: 'sidecar', pid: 12 } },
      });
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('private'), { code });
      });
      const plan = inspectStationHomeRecovery({ homeDir: home });
      expect(kill).toHaveBeenCalledWith(12, 0);
      expect(plan.owners[code === 'EPERM' ? 'unknown' : 'pidAbsent']).toBe(1);
      expect(plan.owners.exclusion).toBe('not-proven');
      expect(plan.applyAllowed).toBe(false);
    },
  );
  it('is deterministic and redacted across homes and file creation order', () => {
    const first = fixture();
    registry(first);
    put(first, 'config/app.json', {});
    const second = fixture();
    put(second, 'config/app.json', {});
    registry(second);
    expect(inspectStationHomeRecovery({ homeDir: first })).toEqual(
      inspectStationHomeRecovery({ homeDir: second }),
    );
  });
});
