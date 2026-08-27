import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  JsonFileStore,
  JsonFileStoreCorruptionError,
} from '../../infra/json-store.js';
import {
  applyHostAlias,
  canonicalizeCheckoutRemotes,
  ProjectBindingStoreShapeError,
  ProjectBindingsStore,
  projectBindingStorePath,
} from '../project-binding-store.js';

const tmpRoots: string[] = [];

afterEach(() => {
  while (tmpRoots.length > 0) {
    const dir = tmpRoots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function createHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'station-ppi-bindings-home-'));
  tmpRoots.push(home);
  return home;
}

function writeStoreFile(home: string, value: unknown): void {
  const filePath = projectBindingStorePath(home);
  mkdirSync(join(home, 'config'), { recursive: true });
  writeFileSync(
    filePath,
    typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  );
}

function validStore(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    memberId: 'local',
    hostAliases: {},
    bindings: [],
    credentialBindings: [],
    ...overrides,
  };
}

describe('ProjectBindingsStore — fail-closed reads', () => {
  test('a MISSING file reads as the empty store (absence is not corruption)', () => {
    const store = new ProjectBindingsStore(createHome());
    expect(store.read()).toEqual({
      schemaVersion: 1,
      memberId: 'local',
      hostAliases: {},
      bindings: [],
      credentialBindings: [],
    });
  });

  test('a corrupt file THROWS instead of silently reading as empty', () => {
    const home = createHome();
    writeStoreFile(home, '{ not json');
    expect(() => new ProjectBindingsStore(home).read()).toThrow(
      JsonFileStoreCorruptionError,
    );
  });

  test('a corrupt file is never overwritten by an attempted binding mutation', async () => {
    const home = createHome();
    const corruptBytes = '{ not json';
    writeStoreFile(home, corruptBytes);

    await expect(
      new ProjectBindingsStore(home).upsertProjectBinding({
        projectId: 'prj_1',
        resourceId: 'local:acme',
        kind: 'local-directory',
        path: '/tmp/acme',
        remotes: [],
        verifiedAt: 1,
        state: 'bound',
      }),
    ).rejects.toThrow(JsonFileStoreCorruptionError);
    expect(readFileSync(projectBindingStorePath(home), 'utf-8')).toBe(
      corruptBytes,
    );
  });

  test('an unknown schemaVersion is refused by name', () => {
    const home = createHome();
    writeStoreFile(home, validStore({ schemaVersion: 2 }));
    expect(() => new ProjectBindingsStore(home).read()).toThrow(
      /schemaVersion: unknown or absent \(expected 1, got 2\)/,
    );
  });

  test('one malformed binding fails the whole read — a dropped row is a silent capability loss', () => {
    const home = createHome();
    writeStoreFile(
      home,
      validStore({
        bindings: [
          {
            projectId: 'prj_1',
            resourceId: 'github.com/kontourai/station',
            kind: 'git-checkout',
            path: '~/dev/station',
            remotes: ['github.com/kontourai/station'],
            verifiedAt: 1,
            state: 'bound',
          },
          { projectId: 'prj_1', resourceId: 'other', kind: 'nonsense' },
        ],
      }),
    );
    const store = new ProjectBindingsStore(home);
    expect(() => store.read()).toThrow(ProjectBindingStoreShapeError);
    expect(() => store.read()).toThrow(/bindings\[1\]\.kind/);
    // The valid row is not quietly returned on its own.
    expect(() =>
      store.findBinding('prj_1', 'github.com/kontourai/station'),
    ).toThrow(ProjectBindingStoreShapeError);
  });

  test('`available` must be a real boolean — no truthy coercion', () => {
    const home = createHome();
    writeStoreFile(
      home,
      validStore({
        credentialBindings: [
          {
            projectId: 'prj_1',
            integrationId: 'linear',
            available: 'yes',
            checkedAt: 1,
          },
        ],
      }),
    );
    expect(() => new ProjectBindingsStore(home).read()).toThrow(
      /credentialBindings\[0\]\.available: must be a boolean/,
    );
  });
});

describe('ProjectBindingsStore — writes (§3.5 path verbatim, remotes canonicalized)', () => {
  test('`path` is stored EXACTLY as given, tilde preserved; `remotes` are canonicalized', async () => {
    const home = createHome();
    const store = new ProjectBindingsStore(home);
    const binding = await store.upsertProjectBinding({
      projectId: 'prj_1',
      resourceId: 'github.com/kontourai/station',
      kind: 'git-checkout',
      path: '~/dev/github/kontourai/station',
      remotes: [
        'git@github.com:KontourAI/Station.git',
        'https://user:token@github.com/brian/station/',
      ],
      verifiedAt: 1_754_000_000_000,
      state: 'bound',
    });

    expect(binding.path).toBe('~/dev/github/kontourai/station');
    expect(binding.remotes).toEqual([
      'github.com/kontourai/station',
      'github.com/brian/station',
    ]);
    // …and on disk, so a later reader sees the same two properties.
    const raw = readFileSync(projectBindingStorePath(home), 'utf-8');
    expect(raw).toContain('"~/dev/github/kontourai/station"');
    expect(raw).not.toContain('KontourAI');
    expect(raw).not.toContain('token@');
  });

  test('host aliases are applied to the checkout side before canonicalization', async () => {
    const home = createHome();
    writeStoreFile(
      home,
      validStore({ hostAliases: { 'github-work': 'github.com' } }),
    );
    const store = new ProjectBindingsStore(home);
    const binding = await store.upsertProjectBinding({
      projectId: 'prj_1',
      resourceId: 'github.com/kontourai/station',
      kind: 'git-checkout',
      path: '/tmp/station',
      remotes: ['git@github-work:kontourai/station.git'],
      verifiedAt: 5,
      state: 'bound',
    });
    expect(binding.remotes).toEqual(['github.com/kontourai/station']);
  });

  test('`verifiedAt` and `state` are recorded exactly as the caller observed them', async () => {
    const home = createHome();
    const store = new ProjectBindingsStore(home);
    await store.upsertProjectBinding({
      projectId: 'prj_1',
      resourceId: 'local:acme',
      kind: 'local-directory',
      path: '/tmp/acme',
      remotes: [],
      verifiedAt: 42,
      state: 'stale',
    });
    const persisted = new ProjectBindingsStore(home).findBinding(
      'prj_1',
      'local:acme',
    );
    expect(persisted?.verifiedAt).toBe(42);
    expect(persisted?.state).toBe('stale');
  });

  test('upsert replaces the same (projectId, resourceId) and survives a restart', async () => {
    const home = createHome();
    const store = new ProjectBindingsStore(home);
    await store.upsertProjectBinding({
      projectId: 'prj_1',
      resourceId: 'github.com/kontourai/station',
      kind: 'git-checkout',
      path: '/tmp/one',
      remotes: [],
      verifiedAt: 1,
      state: 'bound',
    });
    await store.upsertProjectBinding({
      projectId: 'prj_1',
      resourceId: 'local:acme',
      kind: 'local-directory',
      path: '/tmp/two',
      remotes: [],
      verifiedAt: 2,
      state: 'bound',
    });
    await store.upsertProjectBinding({
      projectId: 'prj_1',
      resourceId: 'github.com/kontourai/station',
      kind: 'git-checkout',
      path: '/tmp/one-moved',
      remotes: [],
      verifiedAt: 3,
      state: 'bound',
    });

    const restarted = new ProjectBindingsStore(home).read();
    expect(restarted.bindings).toHaveLength(2);
    expect(restarted.bindings[0].path).toBe('/tmp/one-moved');
    expect(restarted.bindings[1].path).toBe('/tmp/two');
  });

  test('re-reads under the mutation lock so two instances retain distinct bindings', async () => {
    const home = createHome();
    const second = new ProjectBindingsStore(home);
    let secondMutationStarted = false;
    const first = new ProjectBindingsStore(home, {
      acquireMutationLock: async () => {
        if (!secondMutationStarted) {
          secondMutationStarted = true;
          // Second instance's mutation completes fully (through the real
          // cross-process lock, uncontended) before first proceeds — this
          // still proves the fresh-read-under-lock ordering the test names.
          await second.upsertProjectBinding({
            projectId: 'prj_1',
            resourceId: 'local:second',
            kind: 'local-directory',
            path: '/tmp/second',
            remotes: [],
            verifiedAt: 2,
            state: 'bound',
          });
        }
        return () => {};
      },
    });

    await first.upsertProjectBinding({
      projectId: 'prj_1',
      resourceId: 'local:first',
      kind: 'local-directory',
      path: '/tmp/first',
      remotes: [],
      verifiedAt: 1,
      state: 'bound',
    });

    expect(new ProjectBindingsStore(home).read().bindings).toEqual([
      expect.objectContaining({ resourceId: 'local:second' }),
      expect.objectContaining({ resourceId: 'local:first' }),
    ]);
  });

  test('the mutation that commits last replaces the same logical binding key', async () => {
    const home = createHome();
    const second = new ProjectBindingsStore(home);
    let secondMutationStarted = false;
    const first = new ProjectBindingsStore(home, {
      acquireMutationLock: async () => {
        if (!secondMutationStarted) {
          secondMutationStarted = true;
          // Second instance's mutation completes fully before first
          // proceeds — still proves "last commit wins" ordering.
          await second.upsertProjectBinding({
            projectId: 'prj_1',
            resourceId: 'local:acme',
            kind: 'local-directory',
            path: '/tmp/second',
            remotes: [],
            verifiedAt: 2,
            state: 'bound',
          });
        }
        return () => {};
      },
    });

    await first.upsertProjectBinding({
      projectId: 'prj_1',
      resourceId: 'local:acme',
      kind: 'local-directory',
      path: '/tmp/first',
      remotes: [],
      verifiedAt: 1,
      state: 'bound',
    });

    expect(new ProjectBindingsStore(home).read().bindings).toEqual([
      expect.objectContaining({
        resourceId: 'local:acme',
        path: '/tmp/first',
        verifiedAt: 1,
      }),
    ]);
  });

  test('releases the real mutation lock when the durable write fails', async () => {
    const home = createHome();
    const write = vi
      .spyOn(JsonFileStore.prototype, 'write')
      .mockImplementationOnce(() => {
        throw new Error('simulated durable write failure');
      });

    try {
      await expect(
        new ProjectBindingsStore(home).upsertProjectBinding({
          projectId: 'prj_1',
          resourceId: 'local:acme',
          kind: 'local-directory',
          path: '/tmp/acme',
          remotes: [],
          verifiedAt: 1,
          state: 'bound',
        }),
      ).rejects.toThrow('simulated durable write failure');
    } finally {
      write.mockRestore();
    }

    expect(existsSync(`${projectBindingStorePath(home)}.mutation`)).toBe(false);
  });

  test('refuses a binding mutation when lock acquisition fails without creating a store', async () => {
    const home = createHome();
    const store = new ProjectBindingsStore(home, {
      acquireMutationLock: () => {
        throw new Error('project binding mutation lock is held');
      },
    });

    await expect(
      store.upsertProjectBinding({
        projectId: 'prj_1',
        resourceId: 'local:acme',
        kind: 'local-directory',
        path: '/tmp/acme',
        remotes: [],
        verifiedAt: 1,
        state: 'bound',
      }),
    ).rejects.toThrow('project binding mutation lock is held');
    expect(existsSync(projectBindingStorePath(home))).toBe(false);
  });

  test('an empty path is refused rather than written', async () => {
    const store = new ProjectBindingsStore(createHome());
    await expect(
      store.upsertProjectBinding({
        projectId: 'prj_1',
        resourceId: 'local:acme',
        kind: 'local-directory',
        path: '',
        remotes: [],
        verifiedAt: 1,
        state: 'bound',
      }),
    ).rejects.toThrow(/non-empty path/);
  });
});

describe('applyHostAlias (§3.3(a))', () => {
  const aliases = { 'github-work': 'github.com' };

  test.each([
    [
      'git@github-work:kontourai/station.git',
      'git@github.com:kontourai/station.git',
    ],
    [
      'ssh://git@github-work/kontourai/station.git',
      'ssh://git@github.com/kontourai/station.git',
    ],
    [
      'https://github-work/kontourai/station',
      'https://github.com/kontourai/station',
    ],
    [
      'https://GitHub-Work/kontourai/station',
      'https://github.com/kontourai/station',
    ],
  ])('rewrites the host in %s', (input, expected) => {
    expect(applyHostAlias(input, aliases)).toBe(expected);
  });

  test.each([
    ['git@github.com:kontourai/station.git'],
    ['/Users/brian/dev/station'],
    ['../sibling-checkout'],
  ])('leaves %s untouched when no alias matches', (input) => {
    expect(applyHostAlias(input, aliases)).toBe(input);
  });

  test('canonicalizeCheckoutRemotes drops empties and collapses duplicates in order', () => {
    expect(
      canonicalizeCheckoutRemotes(
        [
          'git@github.com:kontourai/station.git',
          'https://github.com/kontourai/station',
          '   ',
          'git@github-work:kontourai/other.git',
        ],
        aliases,
      ),
    ).toEqual(['github.com/kontourai/station', 'github.com/kontourai/other']);
  });
});
