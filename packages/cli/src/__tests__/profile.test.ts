import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { lookupProcessBirthFingerprint } from '@kontourai/station-shared/process-identity';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { runStationsCommand } from '../commands/profile-command.js';
import {
  ensureProfileStoreGenesis,
  findProfile,
  profilesPath,
  readProfileStore,
  removeProfile,
  resolveDefaultProfile,
  setDefaultProfile,
  upsertProfile,
  writeProfileStore,
} from '../commands/profile-store.js';

let home: string;
let previousHome: string | undefined;
let previousRoot: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'station-profile-'));
  previousHome = process.env.STATION_HOME;
  previousRoot = process.env.STATION_ROOT;
  process.env.STATION_HOME = home;
  process.env.STATION_ROOT = home;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.STATION_HOME;
  else process.env.STATION_HOME = previousHome;
  if (previousRoot === undefined) delete process.env.STATION_ROOT;
  else process.env.STATION_ROOT = previousRoot;
  rmSync(home, { recursive: true, force: true });
});

describe('shared saved Station store', () => {
  test('is secret-free, versioned, and writes atomically', () => {
    upsertProfile({
      name: 'kontour',
      endpoint: 'http://127.0.0.1:3141',
      makeDefault: true,
      now: 1,
    });
    expect(JSON.parse(readFileSync(profilesPath(), 'utf8'))).toEqual({
      schemaVersion: 1,
      revision: 1,
      defaultProfile: 'kontour',
      projectProfiles: {},
      profiles: [
        {
          schemaVersion: 1,
          name: 'kontour',
          endpoint: 'http://127.0.0.1:3141',
          setupSource: 'manual',
          configurationState: 'unconfigured',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    expect(readFileSync(profilesPath(), 'utf8')).not.toContain('credential');
  });

  test('does not select a default unless setup or use explicitly asks', () => {
    upsertProfile({ name: 'kontour', endpoint: 'http://127.0.0.1:3141' });
    expect(resolveDefaultProfile()).toBeUndefined();
    setDefaultProfile('kontour');
    expect(resolveDefaultProfile()?.name).toBe('kontour');
  });

  test('removal clears only a selected default', () => {
    upsertProfile({
      name: 'kontour',
      endpoint: 'http://127.0.0.1:3141',
      makeDefault: true,
    });
    expect(removeProfile('kontour').wasDefault).toBe(true);
    expect(readProfileStore()).toEqual({
      schemaVersion: 1,
      revision: 2,
      defaultProfile: null,
      projectProfiles: {},
      profiles: [],
    });
  });

  test('refuses a corrupt store instead of overwriting it', () => {
    upsertProfile({ name: 'kontour', endpoint: 'http://127.0.0.1:3141' });
    writeFileSync(profilesPath(), '{broken');
    expect(() => readProfileStore()).toThrow(/corrupt/);
  });

  test('never recreates a marker-backed shared store after profiles.json disappears', () => {
    upsertProfile({
      name: 'stable-local',
      endpoint: 'http://127.0.0.1:18141',
      makeDefault: true,
    });
    unlinkSync(profilesPath());
    expect(() =>
      upsertProfile({
        name: 'beta-local',
        endpoint: 'http://127.0.0.1:28141',
      }),
    ).toThrow(/missing from an initialized or in-progress shared root/);
  });

  test('refuses a revision-zero store moved after genesis and before the locked CAS', () => {
    ensureProfileStoreGenesis();
    const revisionZero = readProfileStore();
    expect(revisionZero.revision).toBe(0);

    expect(() =>
      writeProfileStore(revisionZero, home, 0, {
        afterGenesisAdmission: () => unlinkSync(profilesPath()),
      }),
    ).toThrow(/metadata disappeared during a write/);
    expect(() => readFileSync(profilesPath(), 'utf8')).toThrow();
  });

  test('refuses a genesis marker symlink before it can redirect a missing-store read', () => {
    const external = join(home, 'marker-target');
    writeFileSync(external, 'station-profile-store-v1\n', { mode: 0o600 });
    symlinkSync(external, join(home, '.station-profile-store-v1'));

    expect(() =>
      upsertProfile({
        name: 'stable-local',
        endpoint: 'http://127.0.0.1:18141',
      }),
    ).toThrow(/genesis marker is invalid/);
    expect(() => readFileSync(profilesPath(), 'utf8')).toThrow();
  });

  test('refuses missing metadata beside a prior channel runtime without minting a replacement', () => {
    mkdirSync(join(home, 'instances', 'stable'), {
      recursive: true,
      mode: 0o700,
    });
    expect(() =>
      upsertProfile({
        name: 'beta-local',
        endpoint: 'http://127.0.0.1:28141',
      }),
    ).toThrow(/missing from an initialized or in-progress shared root/);
    expect(() => readFileSync(profilesPath(), 'utf8')).toThrow();
  });

  test('publishes first-install metadata beneath a lexical macOS /tmp root', () => {
    const temporaryHome = mkdtempSync('/tmp/station-profile-genesis-');
    try {
      upsertProfile(
        {
          name: 'stable-local',
          endpoint: 'http://127.0.0.1:18141',
        },
        temporaryHome,
      );
      expect(readProfileStore(temporaryHome)).toMatchObject({
        revision: 1,
        profiles: [expect.objectContaining({ name: 'stable-local' })],
      });
    } finally {
      rmSync(temporaryHome, { recursive: true, force: true });
    }
  });

  test('does not let a stale ordinary profile lock authorize a missing shared store', () => {
    mkdirSync(join(home, 'instances', 'stable', 'data'), {
      recursive: true,
      mode: 0o700,
    });
    const staleLock = `${profilesPath()}.lock`;
    mkdirSync(dirname(staleLock), { recursive: true, mode: 0o700 });
    writeFileSync(
      staleLock,
      JSON.stringify({
        schemaVersion: 2,
        pid: process.pid,
        birth: `stale-${lookupProcessBirthFingerprint(process.pid)}`,
        createdAt: 0,
      }),
      { mode: 0o600 },
    );
    chmodSync(staleLock, 0o600);

    expect(() =>
      upsertProfile({
        name: 'beta-local',
        endpoint: 'http://127.0.0.1:28141',
      }),
    ).toThrow(/missing from an initialized or in-progress shared root/);
    expect(() => readFileSync(profilesPath(), 'utf8')).toThrow();
  });

  test('reclaims a conclusively stale shared genesis lock before first publication', () => {
    const genesisLock = join(
      dirname(home),
      `.${basename(home)}.station-profile-store-genesis.json.lock`,
    );
    const birth = lookupProcessBirthFingerprint(process.pid);
    expect(birth).not.toBeNull();
    writeFileSync(
      genesisLock,
      JSON.stringify({
        schemaVersion: 2,
        pid: process.pid,
        birth: `stale-${birth}`,
        createdAt: 0,
      }),
      { mode: 0o600 },
    );
    chmodSync(genesisLock, 0o600);

    upsertProfile({
      name: 'stable-local',
      endpoint: 'http://127.0.0.1:18141',
    });
    expect(readProfileStore().profiles.map((profile) => profile.name)).toEqual([
      'stable-local',
    ]);
  });

  test('three independent channel bootstraps converge on one shared revision chain', async () => {
    const moduleUrl = new URL('../commands/profile-store.ts', import.meta.url);
    const workers = [
      ['stable-local', '18141'],
      ['beta-local', '28141'],
      ['nightly-local', '38141'],
    ].map(([name, port]) => {
      const source = `
        import { upsertProfile } from ${JSON.stringify(moduleUrl.href)};
        const [name, port] = process.env.STATION_PROFILE_WORKER.split(':');
        let last;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          try {
            upsertProfile({ name, endpoint: 'http://127.0.0.1:' + port, setupSource: 'local', configurationState: 'configured', localService: { instanceId: 'desktop-sidecar-' + name, baseDir: process.env.STATION_HOME + '/instances/' + name.replace('-local', ''), serverPort: Number(port), uiPort: Number(port) - 141 } });
            process.exit(0);
          } catch (error) {
            last = error;
            if (!String(error).includes('changed concurrently') && !String(error).includes('store is busy')) throw error;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        }
        throw last;
      `;
      return spawn(
        process.execPath,
        ['--import', 'tsx/esm', '--input-type=module', '--eval', source],
        {
          env: {
            ...process.env,
            STATION_HOME: home,
            STATION_ROOT: home,
            STATION_PROFILE_WORKER: `${name}:${port}`,
          },
          stdio: 'ignore',
          windowsHide: true,
        },
      );
    });
    const statuses = await Promise.all(
      workers.map(
        (worker) =>
          new Promise<number | null>((resolve, reject) => {
            worker.once('error', reject);
            worker.once('exit', resolve);
          }),
      ),
    );
    expect(statuses).toEqual([0, 0, 0]);
    const store = readProfileStore();
    expect(store.revision).toBe(3);
    expect(store.profiles.map((profile) => profile.name).sort()).toEqual([
      'beta-local',
      'nightly-local',
      'stable-local',
    ]);
    expect(JSON.stringify(store)).not.toContain('credentialRef');
  });

  test.skipIf(process.platform === 'win32')(
    'rejects saved Station metadata that is symlinked or not owner-only',
    () => {
      mkdirSync(join(home, 'config'), { recursive: true, mode: 0o700 });
      const external = join(home, 'external.json');
      writeFileSync(external, JSON.stringify(readProfileStore()), {
        mode: 0o600,
      });
      symlinkSync(external, profilesPath());
      expect(() => readProfileStore()).toThrow(/not owner-controlled/);
      unlinkSync(profilesPath());
      writeFileSync(profilesPath(), JSON.stringify(readProfileStore()), {
        mode: 0o644,
      });
      expect(() => readProfileStore()).toThrow(/not owner-controlled/);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'rejects a saved Station metadata directory writable by another principal',
    () => {
      mkdirSync(join(home, 'config'), { recursive: true, mode: 0o700 });
      writeFileSync(profilesPath(), JSON.stringify(readProfileStore()), {
        mode: 0o600,
      });
      chmodSync(join(home, 'config'), 0o755);
      expect(() => readProfileStore()).toThrow(
        /directory is not owner-controlled/,
      );
    },
  );

  test('clears stale credentials and configuration when an endpoint changes', () => {
    upsertProfile({
      name: 'work',
      endpoint: 'https://one.example.test',
      credentialRef: { kind: 'station-bearer', id: 'env-one' },
      environmentId: 'env-one',
      configurationState: 'configured',
      localService: {
        instanceId: 'one',
        baseDir: '/tmp/one',
        serverPort: 3141,
        uiPort: 3000,
      },
      force: true,
    });
    const updated = upsertProfile({
      name: 'work',
      endpoint: 'https://two.example.test',
      force: true,
    }).profile;
    expect(updated).toMatchObject({
      endpoint: 'https://two.example.test',
      configurationState: 'unconfigured',
    });
    expect(updated.credentialRef).toBeUndefined();
    expect(updated.environmentId).toBeUndefined();
    expect(updated.localService).toBeUndefined();
  });

  test('allows an uncredentialed HTTP profile but rejects a bearer bound to it', () => {
    upsertProfile({ name: 'plain-http', endpoint: 'http://host.example.test' });
    expect(() =>
      upsertProfile({
        name: 'plain-http',
        endpoint: 'http://host.example.test',
        credentialRef: { kind: 'station-bearer', id: 'unsafe' },
        force: true,
      }),
    ).toThrow(/bearer credentials require HTTPS/);
  });

  test('rejects a stale profile-store write instead of losing a concurrent update', () => {
    const stale = readProfileStore();
    upsertProfile({ name: 'work', endpoint: 'https://work.example.test' });
    expect(() => writeProfileStore(stale)).toThrow(/changed concurrently/);
  });

  test('reclaims an old lock only after its recorded owner is dead', () => {
    upsertProfile({ name: 'seed', endpoint: 'https://seed.example.test' });
    const path = `${profilesPath()}.lock`;
    mkdirSync(join(home, 'config'), { recursive: true, mode: 0o700 });
    writeFileSync(
      path,
      `${JSON.stringify({
        schemaVersion: 1,
        pid: 999_999_999,
        createdAt: Date.now() - 5 * 60 * 1_000,
      })}\n`,
      { mode: 0o600 },
    );
    upsertProfile({
      name: 'recovered',
      endpoint: 'https://recovered.example.test',
    });
    expect(findProfile('recovered')?.endpoint).toBe(
      'https://recovered.example.test',
    );
  });

  test('reclaims a v2 lock immediately when its exact owner is gone', () => {
    upsertProfile({ name: 'seed', endpoint: 'https://seed.example.test' });
    const path = `${profilesPath()}.lock`;
    mkdirSync(join(home, 'config'), { recursive: true, mode: 0o700 });
    writeFileSync(
      path,
      `${JSON.stringify({
        schemaVersion: 2,
        pid: 999_999_999,
        birth: 'dead-owner-birth',
        createdAt: Date.now(),
      })}\n`,
      { mode: 0o600 },
    );
    upsertProfile({
      name: 'v2-recovered',
      endpoint: 'https://recovered.example.test',
    });
    expect(findProfile('v2-recovered')).toBeDefined();
  });

  test('retains a v2 lock held by the exact live owner', () => {
    upsertProfile({ name: 'seed', endpoint: 'https://seed.example.test' });
    const birth = lookupProcessBirthFingerprint(process.pid);
    expect(birth).toBeTruthy();
    const path = `${profilesPath()}.lock`;
    mkdirSync(join(home, 'config'), { recursive: true, mode: 0o700 });
    writeFileSync(
      path,
      `${JSON.stringify({
        schemaVersion: 2,
        pid: process.pid,
        birth,
        createdAt: Date.now(),
      })}\n`,
      { mode: 0o600 },
    );
    expect(() =>
      upsertProfile({
        name: 'live-owner',
        endpoint: 'https://live.example.test',
      }),
    ).toThrow(/store is busy/);
  });

  test('reclaims a v2 PID-reuse record without waiting five minutes', () => {
    upsertProfile({ name: 'seed', endpoint: 'https://seed.example.test' });
    const birth = lookupProcessBirthFingerprint(process.pid);
    expect(birth).toBeTruthy();
    const path = `${profilesPath()}.lock`;
    mkdirSync(join(home, 'config'), { recursive: true, mode: 0o700 });
    writeFileSync(
      path,
      `${JSON.stringify({
        schemaVersion: 2,
        pid: process.pid,
        birth: `${birth}-reused`,
        createdAt: Date.now(),
      })}\n`,
      { mode: 0o600 },
    );
    upsertProfile({ name: 'reused', endpoint: 'https://reused.example.test' });
    expect(findProfile('reused')).toBeDefined();
  });

  test.skipIf(process.platform === 'win32')(
    'immediately reclaims a real process lock after its owner is killed',
    async () => {
      upsertProfile({ name: 'seed', endpoint: 'https://seed.example.test' });
      const moduleUrl = new URL(
        '../commands/profile-store.ts',
        import.meta.url,
      );
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx/esm',
          '--input-type=module',
          '--eval',
          `import { withProfileStoreLock } from ${JSON.stringify(moduleUrl.href)}; withProfileStoreLock(() => { process.stdout.write('locked\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000); }, process.env.STATION_LOCK_HOME);`,
        ],
        {
          env: { ...process.env, STATION_LOCK_HOME: home },
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        },
      );
      await once(child.stdout!, 'data');
      child.kill('SIGKILL');
      await once(child, 'exit');

      upsertProfile({
        name: 'killed-owner',
        endpoint: 'https://recovered.example.test',
      });
      expect(findProfile('killed-owner')).toBeDefined();
    },
  );

  test('reclaims an owner-only partial lock only after its filesystem age expires', () => {
    upsertProfile({ name: 'seed', endpoint: 'https://seed.example.test' });
    const path = `${profilesPath()}.lock`;
    mkdirSync(join(home, 'config'), { recursive: true, mode: 0o700 });
    writeFileSync(path, '{"schemaVersion":', { mode: 0o600 });
    const stale = new Date(Date.now() - 5 * 60 * 1_000);
    utimesSync(path, stale, stale);
    upsertProfile({
      name: 'partial',
      endpoint: 'https://partial.example.test',
    });
    expect(findProfile('partial')?.endpoint).toBe(
      'https://partial.example.test',
    );
  });

  test('reclaims an owner-only zero-byte lock only after its filesystem age expires', () => {
    upsertProfile({ name: 'seed', endpoint: 'https://seed.example.test' });
    const path = `${profilesPath()}.lock`;
    mkdirSync(join(home, 'config'), { recursive: true, mode: 0o700 });
    writeFileSync(path, '', { mode: 0o600 });
    const stale = new Date(Date.now() - 5 * 60 * 1_000);
    utimesSync(path, stale, stale);
    upsertProfile({ name: 'zero', endpoint: 'https://zero.example.test' });
    expect(findProfile('zero')?.endpoint).toBe('https://zero.example.test');
  });

  test('does not reclaim a fresh partial lock', () => {
    upsertProfile({ name: 'seed', endpoint: 'https://seed.example.test' });
    const path = `${profilesPath()}.lock`;
    mkdirSync(join(home, 'config'), { recursive: true, mode: 0o700 });
    writeFileSync(path, '{', { mode: 0o600 });
    expect(() =>
      upsertProfile({ name: 'fresh', endpoint: 'https://fresh.example.test' }),
    ).toThrow(/store is busy/);
  });

  test('does not let a second reclaimer remove a lock while the reclaim guard is held', () => {
    upsertProfile({ name: 'seed', endpoint: 'https://seed.example.test' });
    const path = `${profilesPath()}.lock`;
    const guard = `${path}.reclaim`;
    mkdirSync(join(home, 'config'), { recursive: true, mode: 0o700 });
    writeFileSync(
      path,
      `${JSON.stringify({
        schemaVersion: 1,
        pid: 999_999_999,
        createdAt: Date.now() - 5 * 60 * 1_000,
      })}\n`,
      { mode: 0o600 },
    );
    // This represents another process that won the exclusive reclaimer slot.
    writeFileSync(
      guard,
      `${JSON.stringify({ schemaVersion: 1, pid: process.pid, createdAt: Date.now() })}\n`,
      { mode: 0o600 },
    );
    expect(() =>
      upsertProfile({
        name: 'blocked',
        endpoint: 'https://blocked.example.test',
      }),
    ).toThrow(/store is busy/);
    expect(readFileSync(path, 'utf8')).toContain('999999999');
    unlinkSync(guard);
    upsertProfile({
      name: 'reclaimed',
      endpoint: 'https://reclaimed.example.test',
    });
    expect(findProfile('reclaimed')?.endpoint).toBe(
      'https://reclaimed.example.test',
    );
  });

  test('recovers a stale reclaim guard left by a dead process', () => {
    upsertProfile({ name: 'seed', endpoint: 'https://seed.example.test' });
    const path = `${profilesPath()}.lock`;
    const guard = `${path}.reclaim`;
    mkdirSync(join(home, 'config'), { recursive: true, mode: 0o700 });
    for (const candidate of [path, guard]) {
      writeFileSync(
        candidate,
        `${JSON.stringify({
          schemaVersion: 1,
          pid: 999_999_999,
          createdAt: Date.now() - 5 * 60 * 1_000,
        })}\n`,
        { mode: 0o600 },
      );
    }
    upsertProfile({
      name: 'guard-recovered',
      endpoint: 'https://guard-recovered.example.test',
    });
    expect(findProfile('guard-recovered')).toBeDefined();
  });
});

describe('station stations command', () => {
  test('routes add/edit --pair and pair through the shared async pairing transaction', async () => {
    const paired: Array<{
      name?: string;
      endpoint: string;
      makeDefault?: boolean;
    }> = [];
    const pair = async (input: {
      name?: string;
      endpoint: string;
      makeDefault?: boolean;
    }) => {
      paired.push(input);
      const result = upsertProfile({
        name: input.name!,
        endpoint: input.endpoint,
        environmentId: 'env-paired',
        credentialRef: { kind: 'station-bearer', id: `ref-${paired.length}` },
        configurationState: 'configured',
        makeDefault: input.makeDefault,
        force: true,
        verifiedBinding: true,
      });
      return { profile: result.profile, alreadyPaired: false };
    };

    await runStationsCommand(
      ['add', 'media', 'https://media.example.test', '--pair', '--default'],
      { pair },
    );
    await runStationsCommand(['pair', 'media', '--force'], { pair });
    await runStationsCommand(
      ['edit', 'media', 'https://other.example.test', '--pair'],
      { pair },
    );

    expect(paired).toEqual([
      expect.objectContaining({
        name: 'media',
        endpoint: 'https://media.example.test',
        makeDefault: true,
        allowEndpointReplacement: false,
      }),
      expect.objectContaining({
        name: 'media',
        endpoint: 'https://media.example.test',
      }),
      expect.objectContaining({
        name: 'media',
        endpoint: 'https://other.example.test',
        allowEndpointReplacement: true,
      }),
    ]);
  });

  test('leaves metadata-only entries explicitly unauthenticated', async () => {
    const output: string[] = [];
    await runStationsCommand(['add', 'remote', 'https://remote.example.test'], {
      stdout: (line) => output.push(line),
    });
    expect(findProfile('remote')?.credentialRef).toBeUndefined();
    expect(output.join('\n')).toContain('Credential not configured');
    expect(output.join('\n')).toContain('station stations pair remote');
  });

  test('parses false boolean values, rejects duplicates, and refuses pairing-only flags without pairing', async () => {
    const pair = vi.fn();
    await runStationsCommand(
      [
        'add',
        'remote',
        'https://remote.example.test',
        '--pair=false',
        '--force=false',
        '--default=false',
      ],
      { pair },
    );
    expect(pair).not.toHaveBeenCalled();
    expect(readProfileStore().defaultProfile).toBeNull();
    expect(findProfile('remote')).toBeDefined();

    await expect(
      runStationsCommand(
        [
          'add',
          'duplicate',
          'https://duplicate.example.test',
          '--pair',
          '--pair=false',
        ],
        { pair },
      ),
    ).rejects.toThrow(/Duplicate option --pair/);
    await expect(
      runStationsCommand(
        [
          'add',
          'unpaired',
          'https://unpaired.example.test',
          '--device-name=device',
        ],
        { pair },
      ),
    ).rejects.toThrow(/require --pair/);
    expect(pair).not.toHaveBeenCalled();
    expect(findProfile('duplicate')).toBeUndefined();
    expect(findProfile('unpaired')).toBeUndefined();
  });

  test('rejects empty pairing values before invoking the actual Stations pairing action', async () => {
    const pair = vi.fn();
    upsertProfile({
      name: 'first',
      endpoint: 'https://first.example.test',
      makeDefault: true,
      force: true,
    });
    await expect(
      runStationsCommand(
        [
          'add',
          'media',
          'https://media.example.test',
          '--pair',
          '--default',
          '--timeout=',
        ],
        { pair },
      ),
    ).rejects.toThrow('--timeout requires a value');
    await expect(
      runStationsCommand(
        [
          'add',
          'media',
          'https://media.example.test',
          '--pair',
          '--device-name=',
        ],
        { pair },
      ),
    ).rejects.toThrow('--device-name requires a value');
    expect(pair).not.toHaveBeenCalled();
    expect(readProfileStore().defaultProfile).toBe('first');
    expect(findProfile('media')).toBeUndefined();
  });

  test('keeps an old default binding when a Stations pairing is denied', async () => {
    const oldRef = { kind: 'station-bearer' as const, id: 'old-ref' };
    upsertProfile({
      name: 'media',
      endpoint: 'https://media.example.test',
      credentialRef: oldRef,
      environmentId: 'old-environment',
      configurationState: 'configured',
      makeDefault: true,
      force: true,
    });
    await expect(
      runStationsCommand(['pair', 'media', '--force'], {
        pair: async () => {
          throw new Error('pairing denied');
        },
      }),
    ).rejects.toThrow('pairing denied');
    expect(readProfileStore().defaultProfile).toBe('media');
    expect(findProfile('media')?.credentialRef).toEqual(oldRef);
  });

  test('cleans only unreferenced keyring entries after profile mutations', async () => {
    const deleted: string[] = [];
    const credentialStore = {
      get: () => undefined,
      set: () => undefined,
      delete: (ref: { id: string }) => deleted.push(ref.id),
      status: () => 'available' as const,
    };
    const sharedRef = { kind: 'station-bearer' as const, id: 'shared-ref' };
    upsertProfile({
      name: 'first',
      endpoint: 'https://one.example.test',
      credentialRef: sharedRef,
    });
    upsertProfile({
      name: 'second',
      endpoint: 'https://two.example.test',
      credentialRef: sharedRef,
    });
    await runStationsCommand(['forget', 'first'], { credentialStore });
    expect(deleted).toEqual([]);
    await runStationsCommand(['edit', 'second', 'https://three.example.test'], {
      credentialStore,
    });
    expect(deleted).toEqual(['shared-ref']);
  });

  test('adds, lists, shows, uses, exports, and removes profiles without credentials', async () => {
    const output: string[] = [];
    const deps = { stdout: (value: string) => output.push(value) };
    await runStationsCommand(
      ['add', 'kontour', 'http://127.0.0.1:3141', '--default'],
      deps,
    );
    await runStationsCommand(['show', 'kontour'], deps);
    await runStationsCommand(['export'], deps);
    await runStationsCommand(['forget', 'kontour'], deps);
    expect(output.join('\n')).toContain('Added Station "kontour"');
    expect(output.join('\n')).toContain('"endpoint": "http://127.0.0.1:3141"');
    expect(output.join('\n')).not.toContain('bearer-token');
    expect(findProfile('kontour')).toBeUndefined();
  });

  test('stores project selection only in the shared owner-controlled saved Station store', async () => {
    const project = mkdtempSync(join(tmpdir(), 'station-profile-project-'));
    const previousCwd = process.env.STATION_INVOKED_CWD;
    try {
      const output: string[] = [];
      await runStationsCommand([
        'add',
        'remote',
        'https://remote.example.test',
      ]);
      process.env.STATION_INVOKED_CWD = project;
      await runStationsCommand(['project', 'use', 'remote'], {
        stdout: (value) => output.push(value),
      });
      await runStationsCommand(['project', 'show'], {
        stdout: (value) => output.push(value),
      });
      expect(readProfileStore().projectProfiles).toEqual({
        [realpathSync(project)]: 'remote',
      });
      expect(output.join('\n')).toContain('for this directory is "remote"');
      await runStationsCommand(['project', 'clear']);
      expect(readProfileStore().projectProfiles).toEqual({});
    } finally {
      if (previousCwd === undefined) delete process.env.STATION_INVOKED_CWD;
      else process.env.STATION_INVOKED_CWD = previousCwd;
      rmSync(project, { recursive: true, force: true });
    }
  });
});
