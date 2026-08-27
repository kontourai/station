import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SshEnvironmentProfileStore } from '../ssh-environment-profile-store.js';

const homes: string[] = [];

function home(): string {
  const value = mkdtempSync(join(tmpdir(), 'station-ssh-profile-'));
  homes.push(value);
  return value;
}

function profileFile(root: string): string {
  return join(root, 'environments', 'ssh.json');
}

function addInput(remoteProjectPath: string) {
  return { hostAlias: 'brian-media', remoteProjectPath };
}

const verifiedIdentity = {
  environmentId: '11111111-1111-4111-8111-111111111111',
  hostIdentity: 'ssh:fixture',
  remoteHome: '/home/brian',
  verifiedProjectPath: '/home/brian/dev/github/kontourai/station',
  workerProtocolVersion: 1,
};

async function corruptStoredProfile(
  root: string,
  mutate: (profile: Record<string, unknown>) => void,
): Promise<string> {
  const store = new SshEnvironmentProfileStore(root);
  await store.initialize();
  await store.add(addInput('/srv/existing'));
  const file = profileFile(root);
  const document = JSON.parse(readFileSync(file, 'utf8')) as {
    profiles: Array<Record<string, unknown>>;
  };
  mutate(document.profiles[0]!);
  const bytes = `${JSON.stringify(document, null, 2)}\n`;
  writeFileSync(file, bytes, 'utf8');
  return bytes;
}

afterEach(() => {
  vi.useRealTimers();
  for (const value of homes.splice(0)) {
    rmSync(value, { recursive: true, force: true });
  }
});

describe('SshEnvironmentProfileStore', () => {
  test('persists only credential-free stable profile state with private permissions', async () => {
    const root = home();
    const store = new SshEnvironmentProfileStore(root);
    await store.initialize();
    const first = await store.add({
      hostAlias: 'brian-media',
      remoteProjectPath: '~/dev/github/kontourai/station',
    });
    const duplicate = await store.add({
      hostAlias: 'brian-media',
      remoteProjectPath: '~/dev/github/kontourai/station',
    });
    expect(duplicate.id).toBe(first.id);

    const verified = await store.recordVerified(first.id, {
      environmentId: '11111111-1111-4111-8111-111111111111',
      hostIdentity: 'ssh:fixture',
      remoteHome: '/home/brian',
      verifiedProjectPath: '/home/brian/dev/github/kontourai/station',
      workerProtocolVersion: 1,
    });
    expect(verified.lastConnectedAt).toBeTruthy();
    const file = join(root, 'environments', 'ssh.json');
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toMatch(/credential|privateKey|identityFile|controlPath/i);
    if (process.platform !== 'win32') {
      expect(lstatSync(file).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(root, 'environments')).mode & 0o777).toBe(0o700);
    }
  });

  test('re-reads under the mutation lock so stale verification cannot restore a removed profile', async () => {
    const root = home();
    const original = new SshEnvironmentProfileStore(root);
    await original.initialize();
    const profile = await original.add(addInput('/srv/removed'));
    const remover = new SshEnvironmentProfileStore(root);
    await remover.initialize();
    let lockCalls = 0;
    const stale = new SshEnvironmentProfileStore(root, {
      acquireMutationLock: async () => {
        lockCalls += 1;
        // Completes fully (through the real cross-process lock, uncontended)
        // before `stale`'s own mutation proceeds — still proves the
        // fresh-read-under-lock ordering the test names.
        if (lockCalls === 2)
          expect(await remover.remove(profile.id)).toBe(true);
        return () => {};
      },
    });
    await stale.initialize();

    await expect(
      stale.recordVerified(profile.id, verifiedIdentity),
    ).rejects.toThrow('SSH environment not found');

    const reopened = new SshEnvironmentProfileStore(root);
    await reopened.initialize();
    expect(reopened.list()).toEqual([]);
  });

  test('re-reads under the mutation lock so stale add cannot restore a removed profile', async () => {
    const root = home();
    const original = new SshEnvironmentProfileStore(root);
    await original.initialize();
    const removed = await original.add(addInput('/srv/removed'));
    const remover = new SshEnvironmentProfileStore(root);
    await remover.initialize();
    let lockCalls = 0;
    const stale = new SshEnvironmentProfileStore(root, {
      acquireMutationLock: async () => {
        lockCalls += 1;
        if (lockCalls === 2)
          expect(await remover.remove(removed.id)).toBe(true);
        return () => {};
      },
    });
    await stale.initialize();

    await stale.add(addInput('/srv/new'));

    const reopened = new SshEnvironmentProfileStore(root);
    await reopened.initialize();
    expect(reopened.list().map((profile) => profile.remoteProjectPath)).toEqual(
      ['/srv/new'],
    );
  });

  test('retains distinct profiles when two adds begin from the same earlier document', async () => {
    const root = home();
    const second = new SshEnvironmentProfileStore(root);
    await second.initialize();
    let lockCalls = 0;
    const first = new SshEnvironmentProfileStore(root, {
      acquireMutationLock: async () => {
        lockCalls += 1;
        if (lockCalls === 2) await second.add(addInput('/srv/second'));
        return () => {};
      },
    });
    await first.initialize();

    await first.add(addInput('/srv/first'));

    const reopened = new SshEnvironmentProfileStore(root);
    await reopened.initialize();
    expect(
      reopened
        .list()
        .map((profile) => profile.remoteProjectPath)
        .sort(),
    ).toEqual(['/srv/first', '/srv/second']);
  });

  test('refuses an unavailable mutation lock without changing a profile document', async () => {
    const root = home();
    const existing = new SshEnvironmentProfileStore(root);
    await existing.initialize();
    await existing.add(addInput('/srv/existing'));
    const file = profileFile(root);
    const before = readFileSync(file, 'utf8');
    let lockCalls = 0;
    const locked = new SshEnvironmentProfileStore(root, {
      acquireMutationLock: () => {
        lockCalls += 1;
        if (lockCalls > 1) {
          throw new Error('ssh-environment mutation lock is held');
        }
        return () => {};
      },
    });
    await locked.initialize();

    await expect(locked.add(addInput('/srv/new'))).rejects.toThrow(
      'ssh-environment mutation lock is held',
    );
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  test('rejects corrupt or noncanonical persisted profile values without write-back', async () => {
    const root = home();
    const store = new SshEnvironmentProfileStore(root);
    await store.initialize();
    const bytes = await corruptStoredProfile(root, (profile) => {
      profile.name = ' profile name ';
    });
    const file = profileFile(root);

    const reopened = new SshEnvironmentProfileStore(root);
    await expect(reopened.initialize()).rejects.toThrow(
      'Invalid SSH environment profile schema',
    );
    expect(() => store.list()).toThrow(
      'Invalid SSH environment profile schema',
    );
    await expect(store.add(addInput('/srv/new'))).rejects.toThrow(
      'Invalid SSH environment profile schema',
    );
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    expect(existsSync(`${file}.mutation`)).toBe(false);
  });

  test('refuses unexpected persisted fields instead of dropping them on a later mutation', async () => {
    const root = home();
    const bytes = await corruptStoredProfile(root, (profile) => {
      profile.unknown = 'unsafe';
    });
    const file = profileFile(root);
    const store = new SshEnvironmentProfileStore(root);

    await expect(store.initialize()).rejects.toThrow(
      'Invalid SSH environment profile schema',
    );
    expect(readFileSync(file, 'utf8')).toBe(bytes);
  });

  test.each([
    [
      'padded host alias',
      (profile: Record<string, unknown>) => {
        profile.hostAlias = ' brian-media ';
      },
    ],
    [
      'padded remote project path',
      (profile: Record<string, unknown>) => {
        profile.remoteProjectPath = ' /srv/existing ';
      },
    ],
    [
      'uppercase UUID-v4 profile id',
      (profile: Record<string, unknown>) => {
        profile.id = String(profile.id).toUpperCase();
      },
    ],
    [
      'non-v4 UUID profile id',
      (profile: Record<string, unknown>) => {
        profile.id = '11111111-1111-3111-8111-111111111111';
      },
    ],
    [
      'invalid UUID variant profile id',
      (profile: Record<string, unknown>) => {
        profile.id = '11111111-1111-4111-7111-111111111111';
      },
    ],
    [
      'noncanonical created timestamp',
      (profile: Record<string, unknown>) => {
        profile.createdAt = '2026-08-09T12:00:00.000+00:00';
      },
    ],
  ])(
    'rejects persisted %s without normalizing or rewriting it',
    async (_label, mutate) => {
      const root = home();
      const bytes = await corruptStoredProfile(root, mutate);
      const file = profileFile(root);
      const store = new SshEnvironmentProfileStore(root);

      await expect(store.initialize()).rejects.toThrow();
      expect(readFileSync(file, 'utf8')).toBe(bytes);
    },
  );

  test('preserves a pre-commit write failure and cleans temporary mutation state', async () => {
    const root = home();
    const existing = new SshEnvironmentProfileStore(root);
    await existing.initialize();
    await existing.add(addInput('/srv/existing'));
    const file = profileFile(root);
    const before = readFileSync(file, 'utf8');
    const failing = new SshEnvironmentProfileStore(root, {
      writeOperations: {
        writeFileSync: () => {
          throw new Error('injected write failure');
        },
      },
    });
    await failing.initialize();

    await expect(failing.add(addInput('/srv/new'))).rejects.toThrow(
      'injected write failure',
    );
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(existsSync(`${file}.mutation`)).toBe(false);
    expect(readdirSync(join(root, 'environments'))).not.toContain(
      expect.stringMatching(/\.tmp$/),
    );
  });

  test('returns the committed mutation after a parent-directory sync failure', async () => {
    const root = home();
    const store = new SshEnvironmentProfileStore(root, {
      writeOperations: {
        fsyncDirectorySync: () => {
          throw new Error('injected directory sync failure');
        },
      },
    });
    await store.initialize();

    const profile = await store.add(addInput('/srv/committed'));

    const reopened = new SshEnvironmentProfileStore(root);
    await reopened.initialize();
    expect(reopened.list()).toEqual([profile]);
  });

  test('rejects a symlink profile record', async () => {
    const root = home();
    const store = new SshEnvironmentProfileStore(root);
    await store.initialize();
    const file = join(root, 'environments', 'ssh.json');
    rmSync(file);
    symlinkSync('/tmp', file);
    expect(() => store.list()).toThrow('Invalid SSH environment profile file');
  });

  test('derives a bounded default name without truncating a long remote path', async () => {
    const root = home();
    const store = new SshEnvironmentProfileStore(root);
    await store.initialize();
    const remoteProjectPath = `/home/station/${'nested-workspace/'.repeat(10)}project`;

    const profile = await store.add({
      hostAlias: 'remote-builder-with-a-descriptive-alias',
      remoteProjectPath,
    });

    expect(profile.name.length).toBeLessThanOrEqual(120);
    expect(profile.name).toContain('remote-builder-with-a-descriptive-alias');
    expect(profile.name).toContain('…');
    expect(profile.name).toMatch(/project$/);
    expect(profile.remoteProjectPath).toBe(remoteProjectPath);
  });

  test.each(['launchMode', 'remoteHome'] as const)(
    'rejects a persisted profile missing required %s without write-back',
    async (field) => {
      const root = home();
      const store = new SshEnvironmentProfileStore(root);
      await store.initialize();
      const bytes = await corruptStoredProfile(root, (profile) => {
        delete profile[field];
      });
      const file = profileFile(root);
      const reopened = new SshEnvironmentProfileStore(root);

      await expect(reopened.initialize()).rejects.toThrow();
      expect(() => store.list()).toThrow();
      await expect(store.add(addInput('/srv/new'))).rejects.toThrow();
      expect(readFileSync(file, 'utf8')).toBe(bytes);
      expect(existsSync(`${file}.mutation`)).toBe(false);
    },
  );

  test('records a verification despite a backwards system clock', async () => {
    const root = home();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T12:00:00.000Z'));
    const store = new SshEnvironmentProfileStore(root);
    await store.initialize();
    const profile = await store.add(addInput('/srv/clock-rollback'));

    vi.setSystemTime(new Date('2026-08-09T12:00:00.000Z'));
    const verified = await store.recordVerified(profile.id, verifiedIdentity);

    expect(verified.createdAt).toBe('2026-08-10T12:00:00.000Z');
    expect(verified.updatedAt).toBe('2026-08-09T12:00:00.000Z');
    expect(verified.lastConnectedAt).toBe('2026-08-09T12:00:00.000Z');
  });

  test('rejects a persisted profile whose launchMode is neither attach nor managed', async () => {
    const root = home();
    const store = new SshEnvironmentProfileStore(root);
    await store.initialize();
    const file = join(root, 'environments', 'ssh.json');
    const now = new Date().toISOString();
    const corruptDocument = {
      schemaVersion: 1,
      profiles: [
        {
          schemaVersion: 1,
          id: '11111111-1111-4111-8111-111111111111',
          name: 'Corrupt box',
          hostAlias: 'corrupt-box',
          remoteProjectPath: '/srv/corrupt',
          remotePort: 3141,
          launchMode: 'launch-everything',
          environmentId: null,
          hostIdentity: null,
          verifiedProjectPath: null,
          workerProtocolVersion: null,
          createdAt: now,
          updatedAt: now,
          lastConnectedAt: null,
        },
      ],
    };
    writeFileSync(file, `${JSON.stringify(corruptDocument, null, 2)}\n`, {
      mode: 0o600,
    });

    expect(() => store.list()).toThrow(
      'Invalid SSH environment profile schema',
    );
  });

  test('add() opts a profile into managed launch, defaulting to attach otherwise', async () => {
    const root = home();
    const store = new SshEnvironmentProfileStore(root);
    await store.initialize();

    const managed = await store.add({
      hostAlias: 'brian-media',
      remoteProjectPath: '/srv/managed',
      launchMode: 'managed',
    });
    const attached = await store.add({
      hostAlias: 'brian-media',
      remoteProjectPath: '/srv/attached',
    });

    expect(managed.launchMode).toBe('managed');
    expect(attached.launchMode).toBe('attach');
  });
});
