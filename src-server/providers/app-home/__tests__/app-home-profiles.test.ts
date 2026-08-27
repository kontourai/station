import {
  existsSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  mkdir as mkdirP,
  mkdtemp as mkdtempP,
  open as openP,
  readdir as readdirP,
  readFile as readFileP,
  rename as renameP,
  rm as rmP,
  symlink,
  writeFile as writeFileP,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  APP_HOME_IMPORT_MAX_FILE_BYTES,
  APP_HOME_USAGE_MAX_ENTRIES,
  type AppHomeDirEntry,
  type AppHomeFsPort,
  appHomeProfileDir,
  appHomesRootDir,
  claudeAppHomeEnv,
  clearAppHomeProfile,
  codexAppHomeEnv,
  ensureAppHomeProfile,
  importClaudeGlobalSnapshot,
  importCodexGlobalSnapshot,
  markAppHomeProfileImported,
  readAppHomeProfileStatus,
  readAppHomeProfileUsage,
} from '../app-home-profiles.js';

/**
 * A real-fs-backed `AppHomeFsPort` for tests that need to inject a
 * TOCTOU-race simulation at one or two specific paths while every other
 * call still hits real disk — the module's own `defaultFsPort` is not
 * exported (deliberately: it's an implementation detail), so tests that
 * need "real fs, except for this one override" build their own thin
 * wrapper over `node:fs/promises` rather than re-mocking the whole port.
 */
function realFsPortForTest(
  overrides: Partial<AppHomeFsPort> = {},
): AppHomeFsPort {
  const base: AppHomeFsPort = {
    lstat: async (path) => {
      try {
        const stat = lstatSync(path);
        return {
          isSymbolicLink: stat.isSymbolicLink(),
          isFile: stat.isFile(),
          isDirectory: stat.isDirectory(),
          size: stat.size,
          dev: stat.dev,
          ino: stat.ino,
        };
      } catch {
        return null;
      }
    },
    realpath: async (path) => {
      try {
        return realpathSync(path);
      } catch {
        return null;
      }
    },
    mkdirRecursive: async (path) => {
      await mkdirP(path, { recursive: true });
    },
    mkdtemp: (prefix) => mkdtempP(prefix),
    readdir: async (path) =>
      (await readdirP(path, {
        withFileTypes: true,
      })) as unknown as AppHomeDirEntry[],
    readFile: (path) => readFileP(path),
    openForRead: async (path, expectedIdentity) => {
      let handle: Awaited<ReturnType<typeof openP>>;
      try {
        handle = await openP(
          path,
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT' || code === 'ELOOP') return null;
        throw error;
      }
      const stat = await handle.stat();
      if (
        expectedIdentity &&
        (stat.dev !== expectedIdentity.dev || stat.ino !== expectedIdentity.ino)
      ) {
        await handle.close();
        return null;
      }
      return {
        isFile: stat.isFile(),
        size: stat.size,
        read: () => handle.readFile() as Promise<Buffer>,
        close: () => handle.close(),
      };
    },
    writeFile: (path, data) => writeFileP(path, data),
    writeFileExclusive: async (path, data) => {
      try {
        await writeFileP(path, data, { flag: 'wx' });
        return 'created';
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
          return 'exists';
        }
        throw error;
      }
    },
    rename: (from, to) => renameP(from, to),
    rmRecursive: async (path) => {
      await rmP(path, { recursive: true, force: true });
    },
  };
  return { ...base, ...overrides };
}

/** A minimal `AppHomeDirEntry` for tests that need to force a deterministic `readdir` order. */
function fileEntry(name: string): AppHomeDirEntry {
  return {
    name,
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
  };
}

/** Directory counterpart to {@link fileEntry}. */
function dirEntry(name: string): AppHomeDirEntry {
  return {
    name,
    isFile: () => false,
    isDirectory: () => true,
    isSymbolicLink: () => false,
  };
}

let scratch: string;
let homeDir: string;

beforeEach(() => {
  scratch = join(
    tmpdir(),
    `station-app-home-profiles-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  homeDir = join(scratch, 'station-home');
  mkdirSync(homeDir, { recursive: true });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('appHomesRootDir / appHomeProfileDir', () => {
  test('appHomesRootDir joins app-homes onto the given home dir', () => {
    expect(appHomesRootDir(homeDir)).toBe(join(homeDir, 'app-homes'));
  });

  test('appHomeProfileDir joins the engine id onto the app-homes root', () => {
    expect(appHomeProfileDir('claude-runtime', homeDir)).toBe(
      join(homeDir, 'app-homes', 'claude-runtime'),
    );
  });

  test('rejects an unsafe engine id', () => {
    expect(() => appHomeProfileDir('../escape', homeDir)).toThrow();
    expect(() => appHomeProfileDir('', homeDir)).toThrow();
    expect(() => appHomeProfileDir('a/b', homeDir)).toThrow();
  });
});

describe('claudeAppHomeEnv / codexAppHomeEnv', () => {
  test('claudeAppHomeEnv points CLAUDE_CONFIG_DIR at the profile dir', () => {
    expect(claudeAppHomeEnv('/x/y')).toEqual({ CLAUDE_CONFIG_DIR: '/x/y' });
  });

  test('codexAppHomeEnv points CODEX_HOME at the profile dir (wave-2 seam, unwired)', () => {
    expect(codexAppHomeEnv('/x/y')).toEqual({ CODEX_HOME: '/x/y' });
  });
});

describe('ensureAppHomeProfile', () => {
  test('creates the profile dir with a marker', async () => {
    const result = await ensureAppHomeProfile('claude-runtime', { homeDir });
    expect(result.created).toBe(true);
    expect(result.dir).toBe(join(homeDir, 'app-homes', 'claude-runtime'));
    expect(existsSync(result.dir)).toBe(true);
    const marker = JSON.parse(
      readFileSync(join(result.dir, 'profile.json'), 'utf-8'),
    );
    expect(marker).toMatchObject({
      version: 1,
      engineId: 'claude-runtime',
      seededFrom: 'empty',
    });
    expect(typeof marker.createdAt).toBe('string');
  });

  test('is idempotent', async () => {
    const first = await ensureAppHomeProfile('claude-runtime', { homeDir });
    expect(first.created).toBe(true);
    const markerPath = join(first.dir, 'profile.json');
    const before = readFileSync(markerPath, 'utf-8');

    const second = await ensureAppHomeProfile('claude-runtime', { homeDir });
    expect(second.created).toBe(false);
    expect(second.dir).toBe(first.dir);
    expect(readFileSync(markerPath, 'utf-8')).toBe(before);
  });

  test('rejects an unsafe engine id without creating anything', async () => {
    await expect(
      ensureAppHomeProfile('../escape', { homeDir }),
    ).rejects.toThrow();
    expect(existsSync(join(homeDir, 'app-homes'))).toBe(false);
  });

  test('a symlinked profile marker is refused and its target never written', async () => {
    // HIGH (security review): a pre-existing marker must be identity-
    // checked (lstat, never follows), not treated as a benign race winner
    // just because SOMETHING already exists at that path.
    const dir = join(homeDir, 'app-homes', 'claude-runtime');
    mkdirSync(dir, { recursive: true });
    const sentinelTarget = join(scratch, 'sentinel.json');
    writeFileSync(sentinelTarget, 'do not touch');
    await symlink(sentinelTarget, join(dir, 'profile.json'));

    await expect(
      ensureAppHomeProfile('claude-runtime', { homeDir }),
    ).rejects.toThrow(/not a regular file/);

    // Refused BEFORE any write — the symlink target is completely
    // untouched, and the symlink itself was never replaced either.
    expect(readFileSync(sentinelTarget, 'utf-8')).toBe('do not touch');
  });

  test('a symlink installed between the absent-check and the exclusive write is refused, not adopted', async () => {
    // Item 1 (security review round 2): the ORIGINAL initial-`lstat` fix
    // (HIGH, round 1) only ever re-checked identity on the branch where
    // something ALREADY existed at the first look. This pins the OTHER
    // branch: nothing existed at the first look, but the exclusive
    // `O_CREAT|O_EXCL` write then reports `'exists'` — simulating
    // something racing into place in that exact gap. The re-check after
    // EEXIST must refuse a non-regular winner exactly the same way.
    const dir = join(homeDir, 'app-homes', 'claude-runtime');
    const markerPath = join(dir, 'profile.json');
    const base = realFsPortForTest();
    let lstatCallCount = 0;
    const fs: AppHomeFsPort = {
      ...base,
      lstat: async (path) => {
        if (path === markerPath) {
          lstatCallCount += 1;
          if (lstatCallCount === 1) {
            // The initial absent-check: nothing there yet.
            return null;
          }
          // The post-EEXIST re-check: a symlink raced into place.
          return {
            isSymbolicLink: true,
            isFile: false,
            isDirectory: false,
            size: 0,
            dev: 0,
            ino: 0,
          };
        }
        return base.lstat(path);
      },
      writeFileExclusive: async (path, data) => {
        if (path === markerPath) {
          // Simulates losing the race: something now exists there.
          return 'exists';
        }
        return base.writeFileExclusive(path, data);
      },
    };

    await expect(
      ensureAppHomeProfile('claude-runtime', { homeDir, fs }),
    ).rejects.toThrow(/not a regular file/);
    expect(lstatCallCount).toBe(2);
  });
});

describe('readAppHomeProfileStatus', () => {
  test('reports exists: false when no profile has been created', async () => {
    const status = await readAppHomeProfileStatus('claude-runtime', {
      homeDir,
    });
    expect(status.exists).toBe(false);
  });

  test('reports the marker contents once a profile exists', async () => {
    await ensureAppHomeProfile('claude-runtime', { homeDir });
    const status = await readAppHomeProfileStatus('claude-runtime', {
      homeDir,
    });
    expect(status.exists).toBe(true);
    expect(status.seededFrom).toBe('empty');
  });

  test('status reading refuses a symlinked marker', async () => {
    // Item 2b (security review round 3): the status read now goes through
    // `openForRead` (O_NOFOLLOW + descriptor `fstat`), same as every other
    // marker touch in this module, instead of a path-based `lstat`+
    // `readFile` pair that could be swapped between the two calls. A
    // symlinked marker is refused/reported as absent, never read through
    // — proven here by a symlink pointing at a sentinel file whose content
    // must never leak into the reported status.
    const { dir } = await ensureAppHomeProfile('claude-runtime', { homeDir });
    const sentinelTarget = join(scratch, 'status-sentinel.json');
    writeFileSync(
      sentinelTarget,
      JSON.stringify({
        version: 1,
        engineId: 'claude-runtime',
        createdAt: '2020-01-01T00:00:00.000Z',
        seededFrom: 'global-import',
        importedAt: '2020-01-01T00:00:00.000Z',
      }),
    );
    rmSync(join(dir, 'profile.json'));
    await symlink(sentinelTarget, join(dir, 'profile.json'));

    const status = await readAppHomeProfileStatus('claude-runtime', {
      homeDir,
    });

    // Refused, not read through — the symlink's (attacker-shaped)
    // `seededFrom: 'global-import'` content must never surface here.
    expect(status.exists).toBe(false);
    expect(status.seededFrom).toBeUndefined();
  });

  test('status reading refuses a directory at the marker path', async () => {
    const { dir } = await ensureAppHomeProfile('claude-runtime', { homeDir });
    rmSync(join(dir, 'profile.json'));
    mkdirSync(join(dir, 'profile.json'));

    const status = await readAppHomeProfileStatus('claude-runtime', {
      homeDir,
    });

    expect(status.exists).toBe(false);
  });

  test('status reading refuses a Windows-style post-open identity mismatch (dev/ino cross-check)', async () => {
    // Item 4 (security review round 4): the status read now threads its
    // own dispatch `lstat`'s dev/ino through to `openForRead` as
    // `expectedIdentity` — the same mechanism `readSourceFileGuarded`
    // already uses for import source reads — so on a platform without
    // `O_NOFOLLOW` (Windows), a final-component swap between the
    // dispatch `lstat` and the open is still refused via the descriptor
    // identity cross-check, not silently read through.
    const { dir } = await ensureAppHomeProfile('claude-runtime', { homeDir });
    const markerPath = join(dir, 'profile.json');
    const base = realFsPortForTest();
    const fs = realFsPortForTest({
      openForRead: async (path, expectedIdentity) => {
        if (path === markerPath && expectedIdentity) {
          // Simulates the descriptor's real fstat NOT matching the
          // dispatch lstat's identity — exactly what a final-component
          // swap between the two looks like.
          return null;
        }
        return base.openForRead(path, expectedIdentity);
      },
    });

    const status = await readAppHomeProfileStatus('claude-runtime', {
      homeDir,
      fs,
    });

    expect(status.exists).toBe(false);
  });
});

describe('importClaudeGlobalSnapshot', () => {
  function writeGlobalDir(files: Record<string, string>): string {
    const globalDir = join(scratch, 'global-claude');
    mkdirSync(globalDir, { recursive: true });
    for (const [relPath, content] of Object.entries(files)) {
      const filePath = join(globalDir, relPath);
      mkdirSync(join(filePath, '..'), { recursive: true });
      writeFileSync(filePath, content);
    }
    return globalDir;
  }

  test('copies only the allowlist', async () => {
    const globalDir = writeGlobalDir({
      'settings.json': '{"theme":"dark"}',
      'CLAUDE.md': '# notes',
      'skills/pizza/SKILL.md': '# pizza',
      'agents/writer/agent.json': '{}',
      'commands/deploy.md': '# deploy',
      'random-file.txt': 'not allowlisted',
    });
    const { dir: profileDir } = await ensureAppHomeProfile('claude-runtime', {
      homeDir,
    });

    const result = await importClaudeGlobalSnapshot({
      globalDir,
      profileDir,
      homeDir,
    });

    expect(result.copied.sort()).toEqual(
      ['CLAUDE.md', 'agents', 'commands', 'settings.json', 'skills'].sort(),
    );
    expect(result.skipped).toEqual([
      { path: 'random-file.txt', reason: 'not-on-allowlist' },
    ]);
    expect(readFileSync(join(profileDir, 'settings.json'), 'utf-8')).toBe(
      '{"theme":"dark"}',
    );
    expect(existsSync(join(profileDir, 'skills', 'pizza', 'SKILL.md'))).toBe(
      true,
    );
    expect(existsSync(join(profileDir, 'random-file.txt'))).toBe(false);
  });

  test('never copies projects or todos', async () => {
    const globalDir = writeGlobalDir({
      'projects/some-project/session.jsonl': 'transcript',
      'todos/session-todo.json': '[]',
      'statsig/cache.json': '{}',
      'shell-snapshots/snap.sh': '#!/bin/sh',
    });
    const { dir: profileDir } = await ensureAppHomeProfile('claude-runtime', {
      homeDir,
    });

    const result = await importClaudeGlobalSnapshot({
      globalDir,
      profileDir,
      homeDir,
    });

    expect(result.copied).toEqual([]);
    expect(result.skipped.map((s) => s.path).sort()).toEqual(
      ['projects', 'shell-snapshots', 'statsig', 'todos'].sort(),
    );
    expect(result.skipped.every((s) => s.reason === 'not-on-allowlist')).toBe(
      true,
    );
    expect(existsSync(join(profileDir, 'projects'))).toBe(false);
    expect(existsSync(join(profileDir, 'todos'))).toBe(false);
  });

  test('copies credentials only when explicitly included', async () => {
    const globalDir = writeGlobalDir({
      '.credentials.json': '{"claudeAiOauth":{"accessToken":"secret"}}',
    });
    const { dir: profileDir } = await ensureAppHomeProfile('claude-runtime', {
      homeDir,
    });

    const withoutCredentials = await importClaudeGlobalSnapshot({
      globalDir,
      profileDir,
      homeDir,
    });
    expect(withoutCredentials.copied).toEqual([]);
    expect(withoutCredentials.skipped).toEqual([
      { path: '.credentials.json', reason: 'credentials-excluded' },
    ]);
    expect(existsSync(join(profileDir, '.credentials.json'))).toBe(false);

    const withCredentials = await importClaudeGlobalSnapshot({
      globalDir,
      profileDir,
      includeCredentials: true,
      homeDir,
    });
    expect(withCredentials.copied).toEqual(['.credentials.json']);
    expect(withCredentials.skipped).toEqual([]);
    expect(existsSync(join(profileDir, '.credentials.json'))).toBe(true);
  });

  test('refuses symlinked entries', async () => {
    const globalDir = writeGlobalDir({});
    const outsideTarget = join(scratch, 'outside-secret.txt');
    writeFileSync(outsideTarget, 'must never be copied');
    await symlink(outsideTarget, join(globalDir, 'settings.json'));
    mkdirSync(join(globalDir, 'skills', 'pizza'), { recursive: true });
    writeFileSync(join(globalDir, 'skills', 'pizza', 'SKILL.md'), '# pizza');
    await symlink(
      outsideTarget,
      join(globalDir, 'skills', 'pizza', 'evil-link'),
    );

    const { dir: profileDir } = await ensureAppHomeProfile('claude-runtime', {
      homeDir,
    });
    const result = await importClaudeGlobalSnapshot({
      globalDir,
      profileDir,
      homeDir,
    });

    expect(result.copied).toEqual([]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { path: 'settings.json', reason: 'symlink-in-source' },
        { path: 'skills', reason: 'symlink-in-source' },
      ]),
    );
    expect(existsSync(join(profileDir, 'settings.json'))).toBe(false);
    expect(existsSync(join(profileDir, 'skills'))).toBe(false);
  });

  test('never writes outside the profile dir', async () => {
    const globalDir = writeGlobalDir({
      'settings.json': '{}',
      'skills/pizza/SKILL.md': '# pizza',
    });
    const { dir: profileDir } = await ensureAppHomeProfile('claude-runtime', {
      homeDir,
    });

    await importClaudeGlobalSnapshot({ globalDir, profileDir, homeDir });

    // Nothing landed anywhere but inside the profile dir, and the global
    // dir (read-only source) is untouched.
    expect(existsSync(join(homeDir, 'app-homes', 'settings.json'))).toBe(false);
    expect(existsSync(join(globalDir, '.station-imported'))).toBe(false);
    expect(readFileSync(join(globalDir, 'settings.json'), 'utf-8')).toBe('{}');
  });

  test('refuses a profile dir resolving into global config', async () => {
    const globalDir = writeGlobalDir({ 'settings.json': '{}' });
    // A profileDir that does NOT resolve inside appHomesRootDir() — e.g. a
    // caller-supplied path shaped like the user's own global config dir.
    const outsideProfileDir = join(scratch, 'fake-global-claude');
    mkdirSync(outsideProfileDir, { recursive: true });

    const result = await importClaudeGlobalSnapshot({
      globalDir,
      profileDir: outsideProfileDir,
    });

    expect(result.copied).toEqual([]);
    expect(result.skipped).toEqual([
      { path: '.', reason: 'profile-dir-outside-app-homes-root' },
    ]);
    expect(existsSync(join(outsideProfileDir, 'settings.json'))).toBe(false);
  });

  test('a re-import overwrites a prior imported copy rather than merging', async () => {
    const globalDir = writeGlobalDir({
      'skills/pizza/SKILL.md': '# pizza v1',
    });
    const { dir: profileDir } = await ensureAppHomeProfile('claude-runtime', {
      homeDir,
    });
    await importClaudeGlobalSnapshot({ globalDir, profileDir, homeDir });
    expect(existsSync(join(profileDir, 'skills', 'pizza', 'SKILL.md'))).toBe(
      true,
    );

    // The global dir's skill is replaced entirely (pizza removed, taco
    // added) — the profile copy must mirror that, not accumulate both.
    rmSync(join(globalDir, 'skills', 'pizza'), { recursive: true });
    mkdirSync(join(globalDir, 'skills', 'taco'), { recursive: true });
    writeFileSync(join(globalDir, 'skills', 'taco', 'SKILL.md'), '# taco');

    const result = await importClaudeGlobalSnapshot({
      globalDir,
      profileDir,
      homeDir,
    });
    expect(result.copied).toEqual(['skills']);
    expect(existsSync(join(profileDir, 'skills', 'pizza', 'SKILL.md'))).toBe(
      false,
    );
    expect(existsSync(join(profileDir, 'skills', 'taco', 'SKILL.md'))).toBe(
      true,
    );
  });

  test('source swapped to a symlink between listing and read is refused', async () => {
    // MED-2 (security review): the copy loop's `lstat` only ever decided
    // DISPATCH (file vs. dir vs. symlink) — the actual read used to trust
    // that same `lstat`'s identity by re-opening the path with a plain
    // `readFile`. Now the read itself is independently TOCTOU-guarded via
    // `openForRead` (O_NOFOLLOW + fstat), so a source swapped to a symlink
    // in the gap between the dispatch `lstat` and the read is refused, not
    // silently followed.
    const globalDir = writeGlobalDir({ 'settings.json': '{}' });
    const { dir: profileDir } = await ensureAppHomeProfile('claude-runtime', {
      homeDir,
    });
    const sourcePath = join(globalDir, 'settings.json');
    const base = realFsPortForTest();
    const fs = realFsPortForTest({
      openForRead: async (path) => {
        // Simulates O_NOFOLLOW hitting a symlink that got swapped in after
        // the dispatch `lstat` already reported a genuine regular file.
        if (path === sourcePath) return null;
        return base.openForRead(path);
      },
    });

    const result = await importClaudeGlobalSnapshot({
      globalDir,
      profileDir,
      homeDir,
      fs,
    });

    expect(result.outcome).toBe('completed');
    expect(result.copied).toEqual([]);
    expect(result.skipped).toEqual([
      { path: 'settings.json', reason: 'symlink-in-source' },
    ]);
    expect(existsSync(join(profileDir, 'settings.json'))).toBe(false);
  });

  test('a nested source file swapped to a symlink between listing and read is refused (recursive dir entries)', async () => {
    const globalDir = writeGlobalDir({
      'skills/pizza/SKILL.md': '# pizza',
    });
    const { dir: profileDir } = await ensureAppHomeProfile('claude-runtime', {
      homeDir,
    });
    const nestedSourcePath = join(globalDir, 'skills', 'pizza', 'SKILL.md');
    const base = realFsPortForTest();
    const fs = realFsPortForTest({
      openForRead: async (path) => {
        if (path === nestedSourcePath) return null;
        return base.openForRead(path);
      },
    });

    const result = await importClaudeGlobalSnapshot({
      globalDir,
      profileDir,
      homeDir,
      fs,
    });

    expect(result.copied).toEqual([]);
    expect(result.skipped).toEqual([
      { path: 'skills', reason: 'symlink-in-source' },
    ]);
    expect(existsSync(join(profileDir, 'skills'))).toBe(false);
  });

  test('a file growing past the cap after lstat is still refused by the descriptor-side check', async () => {
    // MED-2: the pre-fix cap check trusted the dispatch `lstat`'s `size` —
    // a file that grows past the cap between that `lstat` and the actual
    // read would sail through. The cap is now enforced from the OPENED
    // descriptor's own `fstat`, not the earlier `lstat`.
    const globalDir = writeGlobalDir({ 'settings.json': '{}' }); // tiny per lstat
    const { dir: profileDir } = await ensureAppHomeProfile('claude-runtime', {
      homeDir,
    });
    const sourcePath = join(globalDir, 'settings.json');
    const base = realFsPortForTest();
    const fs = realFsPortForTest({
      openForRead: async (path) => {
        if (path === sourcePath) {
          return {
            isFile: true,
            size: APP_HOME_IMPORT_MAX_FILE_BYTES + 1,
            read: async () => Buffer.alloc(0),
            close: async () => {},
          };
        }
        return base.openForRead(path);
      },
    });

    const result = await importClaudeGlobalSnapshot({
      globalDir,
      profileDir,
      homeDir,
      fs,
    });

    expect(result.copied).toEqual([]);
    expect(result.skipped).toEqual([
      { path: 'settings.json', reason: 'file-too-large' },
    ]);
    expect(existsSync(join(profileDir, 'settings.json'))).toBe(false);
  });

  test('a missing global config dir fails the import and leaves provenance untouched', async () => {
    // MED-3 (security review): an absent/unreadable global config dir used
    // to fall through to a bare zero-copy result every caller treated as
    // an ordinary (if empty) success — the route then unconditionally
    // stamped `seededFrom: 'global-import'`. Now an explicit `'failed'`
    // outcome, and the caller (the route) is contractually required to
    // never advance provenance on it.
    const missingGlobalDir = join(scratch, 'does-not-exist-at-all');
    const { dir: profileDir } = await ensureAppHomeProfile('claude-runtime', {
      homeDir,
    });

    const result = await importClaudeGlobalSnapshot({
      globalDir: missingGlobalDir,
      profileDir,
      homeDir,
    });

    expect(result.outcome).toBe('failed');
    expect(result.reason).toBe('global-config-dir-missing');
    expect(result.copied).toEqual([]);

    const marker = JSON.parse(
      readFileSync(join(profileDir, 'profile.json'), 'utf-8'),
    );
    expect(marker.seededFrom).toBe('empty');
  });

  test('an existing but empty global config dir completes with zero copies', async () => {
    const globalDir = writeGlobalDir({});
    const { dir: profileDir } = await ensureAppHomeProfile('claude-runtime', {
      homeDir,
    });

    const result = await importClaudeGlobalSnapshot({
      globalDir,
      profileDir,
      homeDir,
    });

    expect(result.outcome).toBe('completed');
    expect(result.copied).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  test('a Windows-style post-open identity mismatch is refused (dev/ino cross-check)', async () => {
    // Item 2 (security review round 2): on a platform without `O_NOFOLLOW`
    // (Windows), the final path component could be swapped between the
    // dispatch `lstat` and the actual open. `openForRead` closes that
    // window by cross-checking the opened descriptor's own `fstat`
    // dev/ino against the identity the caller's dispatch `lstat` reported.
    // This pins that the call site actually threads that expected
    // identity through, and that `openForRead` refusing on a mismatch
    // (simulated here) is honored as a refusal end to end, not read.
    const globalDir = writeGlobalDir({ 'settings.json': '{}' });
    const { dir: profileDir } = await ensureAppHomeProfile('claude-runtime', {
      homeDir,
    });
    const sourcePath = join(globalDir, 'settings.json');
    const base = realFsPortForTest();
    const fs = realFsPortForTest({
      openForRead: async (path, expectedIdentity) => {
        if (path === sourcePath && expectedIdentity) {
          // Simulates the descriptor's real fstat NOT matching the
          // dispatch lstat's identity — exactly what a final-component
          // swap between the two looks like.
          return null;
        }
        return base.openForRead(path, expectedIdentity);
      },
    });

    const result = await importClaudeGlobalSnapshot({
      globalDir,
      profileDir,
      homeDir,
      fs,
    });

    expect(result.copied).toEqual([]);
    expect(result.skipped).toEqual([
      { path: 'settings.json', reason: 'symlink-in-source' },
    ]);
    expect(existsSync(join(profileDir, 'settings.json'))).toBe(false);
  });

  test('the win32 identity check does not false-positive on an unraced read', async () => {
    // Positive control for item 2: forces `process.platform` to 'win32'
    // (so `defaultFsPort`'s real `openForRead` takes its no-O_NOFOLLOW
    // branch and performs the dev/ino cross-check) and uses the REAL
    // default fs port (no injected override) against a genuine,
    // never-swapped file — the new check must not refuse a legitimate,
    // unraced read just because it's running on the Windows code path.
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    try {
      const globalDir = writeGlobalDir({ 'settings.json': '{"theme":"dark"}' });
      const { dir: profileDir } = await ensureAppHomeProfile('claude-runtime', {
        homeDir,
      });

      const result = await importClaudeGlobalSnapshot({
        globalDir,
        profileDir,
        homeDir,
      });

      expect(result.copied).toEqual(['settings.json']);
      expect(result.skipped).toEqual([]);
      expect(readFileSync(join(profileDir, 'settings.json'), 'utf-8')).toBe(
        '{"theme":"dark"}',
      );
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  test('an exception mid-import (copy phase) removes only the stage, leaving the profile untouched', async () => {
    // Item 4 (security review round 2), updated for item 1's stage-then-
    // commit redesign (round 3): a THROWN exception during the COPY
    // PHASE — writing into the stage, never the profile directly — must
    // leave the profile exactly as it was; there is nothing to "clean up"
    // in the profile itself because nothing there was ever touched.
    const globalDir = writeGlobalDir({
      'CLAUDE.md': '# notes',
      'settings.json': '{}',
    });
    const { dir: profileDir } = await ensureAppHomeProfile('claude-runtime', {
      homeDir,
    });
    const base = realFsPortForTest();
    const fs = realFsPortForTest({
      writeFile: async (path, data) => {
        if (path.includes('.import-stage-') && path.endsWith('settings.json')) {
          throw new Error('simulated disk failure mid-import');
        }
        return base.writeFile(path, data);
      },
    });

    await expect(
      importClaudeGlobalSnapshot({ globalDir, profileDir, homeDir, fs }),
    ).rejects.toThrow('simulated disk failure mid-import');

    // Nothing was ever committed to the profile — including an entry
    // that finished staging before the LATER entry's stage write threw —
    // and no stage residue is left behind either.
    expect(existsSync(join(profileDir, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(profileDir, 'settings.json'))).toBe(false);
    const residue = readdirSync(profileDir).filter((name) =>
      name.startsWith('.import-'),
    );
    expect(residue).toEqual([]);
  });

  test('an exception mid-directory-copy (copy phase) leaves no partial directory tree in the profile', async () => {
    const globalDir = writeGlobalDir({
      'skills/pizza/SKILL.md': '# pizza',
      'skills/pizza/notes.md': '# notes',
    });
    const { dir: profileDir } = await ensureAppHomeProfile('claude-runtime', {
      homeDir,
    });
    const base = realFsPortForTest();
    const fs = realFsPortForTest({
      writeFile: async (path, data) => {
        if (path.includes('.import-stage-') && path.endsWith('notes.md')) {
          throw new Error('simulated disk failure mid-directory-copy');
        }
        return base.writeFile(path, data);
      },
    });

    await expect(
      importClaudeGlobalSnapshot({ globalDir, profileDir, homeDir, fs }),
    ).rejects.toThrow('simulated disk failure mid-directory-copy');

    expect(existsSync(join(profileDir, 'skills'))).toBe(false);
    const residue = readdirSync(profileDir).filter((name) =>
      name.startsWith('.import-'),
    );
    expect(residue).toEqual([]);
  });

  test('a copy-phase failure leaves previously imported profile content byte-identical', async () => {
    // Item 1 (security review round 3): the round-2 tests all started from
    // an EMPTY profile, so a failed import destroying "what was there"
    // was invisible — there was nothing there. This seeds a REAL prior
    // import first, then forces the SECOND import's copy phase to throw,
    // and proves the first import's content survives byte-identical.
    const { dir: profileDir } = await ensureAppHomeProfile('claude-runtime', {
      homeDir,
    });
    const seedGlobalDir = writeGlobalDir({
      'settings.json': '{"v":1}',
      'CLAUDE.md': '# v1 claude',
      'skills/pizza/SKILL.md': '# pizza v1',
    });
    const seeded = await importClaudeGlobalSnapshot({
      globalDir: seedGlobalDir,
      profileDir,
      homeDir,
    });
    expect(seeded.outcome).toBe('completed');
    expect(seeded.copied.sort()).toEqual([
      'CLAUDE.md',
      'settings.json',
      'skills',
    ]);

    const settingsBefore = readFileSync(
      join(profileDir, 'settings.json'),
      'utf-8',
    );
    const claudeBefore = readFileSync(join(profileDir, 'CLAUDE.md'), 'utf-8');
    const skillBefore = readFileSync(
      join(profileDir, 'skills', 'pizza', 'SKILL.md'),
      'utf-8',
    );

    // A second, DIFFERENT global snapshot — but the copy phase itself
    // throws (an unexpected exception, not a structured per-entry skip)
    // while staging 'CLAUDE.md'.
    const globalDir = writeGlobalDir({
      'settings.json': '{"v":2}',
      'CLAUDE.md': '# v2 claude',
      'skills/pizza/SKILL.md': '# pizza v2',
    });
    const base = realFsPortForTest();
    const fs = realFsPortForTest({
      writeFile: async (path, data) => {
        if (path.includes('.import-stage-') && path.endsWith('CLAUDE.md')) {
          throw new Error('simulated disk failure during the copy phase');
        }
        return base.writeFile(path, data);
      },
    });

    await expect(
      importClaudeGlobalSnapshot({ globalDir, profileDir, homeDir, fs }),
    ).rejects.toThrow('simulated disk failure during the copy phase');

    // Previously imported content is untouched — byte-identical to before
    // the failed second import; nothing outside the (now-removed) stage
    // was ever written to during the copy phase.
    expect(readFileSync(join(profileDir, 'settings.json'), 'utf-8')).toBe(
      settingsBefore,
    );
    expect(readFileSync(join(profileDir, 'CLAUDE.md'), 'utf-8')).toBe(
      claudeBefore,
    );
    expect(
      readFileSync(join(profileDir, 'skills', 'pizza', 'SKILL.md'), 'utf-8'),
    ).toBe(skillBefore);

    const residue = readdirSync(profileDir).filter((name) =>
      name.startsWith('.import-'),
    );
    expect(residue).toEqual([]);
  });

  test('a mid-commit rename failure restores the already-swapped entries from backups', async () => {
    const { dir: profileDir } = await ensureAppHomeProfile('claude-runtime', {
      homeDir,
    });
    const seedGlobalDir = writeGlobalDir({
      'CLAUDE.md': '# v1 claude',
      'settings.json': '{"v":1}',
    });
    const seeded = await importClaudeGlobalSnapshot({
      globalDir: seedGlobalDir,
      profileDir,
      homeDir,
    });
    expect(seeded.outcome).toBe('completed');
    expect(seeded.copied.sort()).toEqual(['CLAUDE.md', 'settings.json']);

    // A second import with updated content for BOTH entries. `readdir` is
    // forced to a known order (CLAUDE.md, then settings.json) so
    // CLAUDE.md's commit fully succeeds BEFORE settings.json's own
    // stage-in rename is made to fail — proving the rollback restores an
    // entry that already fully swapped, not just the one that failed.
    const globalDir = writeGlobalDir({
      'CLAUDE.md': '# v2 claude',
      'settings.json': '{"v":2}',
    });
    const base = realFsPortForTest();
    const fs = realFsPortForTest({
      readdir: async (path) => {
        if (path === globalDir) {
          return [fileEntry('CLAUDE.md'), fileEntry('settings.json')];
        }
        return base.readdir(path);
      },
      rename: async (from, to) => {
        // Only the ORIGINAL stage-in commit rename throws — a later
        // restore-from-backup rename to this SAME destination (from the
        // backup dir, not the stage) must be allowed to succeed, or the
        // rollback itself could never recover.
        if (
          to === join(profileDir, 'settings.json') &&
          from.includes('.import-stage-')
        ) {
          throw new Error('simulated rename failure mid-commit');
        }
        return base.rename(from, to);
      },
    });

    const result = await importClaudeGlobalSnapshot({
      globalDir,
      profileDir,
      homeDir,
      fs,
    });

    expect(result.outcome).toBe('failed');
    expect(result.reason).toBe('commit-restore');

    // Both entries — the one whose rename failed AND the one that already
    // fully swapped before it — are restored to their PRE-second-import
    // content, not left as a mix of old and new.
    expect(readFileSync(join(profileDir, 'CLAUDE.md'), 'utf-8')).toBe(
      '# v1 claude',
    );
    expect(readFileSync(join(profileDir, 'settings.json'), 'utf-8')).toBe(
      '{"v":1}',
    );

    const residue = readdirSync(profileDir).filter((name) =>
      name.startsWith('.import-'),
    );
    expect(residue).toEqual([]);
  });

  test('success leaves no stage or backup residue', async () => {
    const { dir: profileDir } = await ensureAppHomeProfile('claude-runtime', {
      homeDir,
    });
    const globalDir = writeGlobalDir({
      'settings.json': '{}',
      'CLAUDE.md': '# notes',
    });

    const result = await importClaudeGlobalSnapshot({
      globalDir,
      profileDir,
      homeDir,
    });

    expect(result.outcome).toBe('completed');
    expect(result.copied.sort()).toEqual(['CLAUDE.md', 'settings.json']);
    const residue = readdirSync(profileDir).filter((name) =>
      name.startsWith('.import-'),
    );
    expect(residue).toEqual([]);
  });

  test('stage and backup directories are created exclusively', async () => {
    // Item 1 (security review round 4): the stage/backup dirs are now
    // claimed via `fs.mkdtemp` — OS-random, atomic, exclusive creation
    // that NEVER adopts a pre-existing directory — rather than a
    // predictable `Date.now()+Math.random()` name handed to a
    // non-exclusive `mkdirRecursive` (which would silently ADOPT
    // whatever an attacker pre-planted at that guessable path).
    const { dir: profileDir } = await ensureAppHomeProfile('claude-runtime', {
      homeDir,
    });
    const globalDir = writeGlobalDir({ 'settings.json': '{}' });
    const base = realFsPortForTest();
    const mkdtempCalls: string[] = [];
    const fs = realFsPortForTest({
      mkdtemp: async (prefix) => {
        mkdtempCalls.push(prefix);
        return base.mkdtemp(prefix);
      },
    });

    const result = await importClaudeGlobalSnapshot({
      globalDir,
      profileDir,
      homeDir,
      fs,
    });

    expect(result.outcome).toBe('completed');
    expect(mkdtempCalls).toEqual([
      join(profileDir, '.import-stage-'),
      join(profileDir, '.import-backup-'),
    ]);
  });

  test('rollback restores a backed-up directory over a committed non-empty directory', async () => {
    // Item 2 (security review round 4): `rename()` can never replace a
    // non-empty directory — the rollback must `rmRecursive` a newly
    // committed non-empty directory BEFORE renaming its backup back into
    // place, or the restore itself fails.
    const { dir: profileDir } = await ensureAppHomeProfile('claude-runtime', {
      homeDir,
    });
    const seedGlobalDir = writeGlobalDir({
      'skills/pizza/SKILL.md': '# pizza v1',
      'settings.json': '{"v":1}',
    });
    const seeded = await importClaudeGlobalSnapshot({
      globalDir: seedGlobalDir,
      profileDir,
      homeDir,
    });
    expect(seeded.outcome).toBe('completed');
    expect(seeded.copied.sort()).toEqual(['settings.json', 'skills']);

    // Second import: 'skills' gets NEW (still non-empty, two-file)
    // content and is processed (and fully committed) BEFORE
    // 'settings.json's stage-in rename is made to fail — forcing the
    // rollback to restore a backed-up DIRECTORY over the freshly
    // committed non-empty directory.
    const globalDir = writeGlobalDir({
      'skills/pizza/SKILL.md': '# pizza v2',
      'skills/taco/SKILL.md': '# taco v2',
      'settings.json': '{"v":2}',
    });
    const base = realFsPortForTest();
    const fs = realFsPortForTest({
      readdir: async (path) => {
        if (path === globalDir) {
          return [dirEntry('skills'), fileEntry('settings.json')];
        }
        return base.readdir(path);
      },
      rename: async (from, to) => {
        if (
          to === join(profileDir, 'settings.json') &&
          from.includes('.import-stage-')
        ) {
          throw new Error('simulated rename failure mid-commit');
        }
        return base.rename(from, to);
      },
    });

    const result = await importClaudeGlobalSnapshot({
      globalDir,
      profileDir,
      homeDir,
      fs,
    });

    expect(result.outcome).toBe('failed');
    expect(result.reason).toBe('commit-restore');

    // 'skills' — already fully committed to its NEW (non-empty) content
    // before the rollback — is restored to its PRE-second-import
    // content, not stuck half-swapped because rename() refused to
    // replace a non-empty directory.
    expect(
      readFileSync(join(profileDir, 'skills', 'pizza', 'SKILL.md'), 'utf-8'),
    ).toBe('# pizza v1');
    expect(existsSync(join(profileDir, 'skills', 'taco'))).toBe(false);
    expect(readFileSync(join(profileDir, 'settings.json'), 'utf-8')).toBe(
      '{"v":1}',
    );

    const residue = readdirSync(profileDir).filter((name) =>
      name.startsWith('.import-'),
    );
    expect(residue).toEqual([]);
  });

  test('a failed restore preserves the backup and names its path', async () => {
    // Item 3 (security review round 4): when a restore itself fails, its
    // backup must NOT be deleted — it is the only remaining copy of the
    // user's pre-import content — and its path must be named in the
    // failure result, not just logged and lost.
    const { dir: profileDir } = await ensureAppHomeProfile('claude-runtime', {
      homeDir,
    });
    const seedGlobalDir = writeGlobalDir({ 'settings.json': '{"v":1}' });
    const seeded = await importClaudeGlobalSnapshot({
      globalDir: seedGlobalDir,
      profileDir,
      homeDir,
    });
    expect(seeded.outcome).toBe('completed');

    const globalDir = writeGlobalDir({ 'settings.json': '{"v":2}' });
    const base = realFsPortForTest();
    const fs = realFsPortForTest({
      rename: async (from, to) => {
        if (to === join(profileDir, 'settings.json')) {
          // BOTH the original stage-in commit AND the subsequent
          // restore-from-backup attempt fail — a restore that cannot
          // complete at all.
          throw new Error('simulated total rename failure');
        }
        return base.rename(from, to);
      },
    });

    const result = await importClaudeGlobalSnapshot({
      globalDir,
      profileDir,
      homeDir,
      fs,
    });

    expect(result.outcome).toBe('failed');
    expect(result.reason).toBe('commit-restore');
    expect(result.detail).toContain('settings.json');

    // The backup dir is PRESERVED — never deleted alongside the rest of
    // the (in this case empty) rollback cleanup.
    const backupDirs = readdirSync(profileDir).filter((name) =>
      name.startsWith('.import-backup-'),
    );
    expect(backupDirs).toHaveLength(1);
    const backupPath = join(profileDir, backupDirs[0], 'settings.json');
    expect(result.detail).toContain(backupPath);
    expect(readFileSync(backupPath, 'utf-8')).toBe('{"v":1}');

    // The stage IS cleaned up — its content was either committed
    // elsewhere or is no longer needed.
    const stageDirs = readdirSync(profileDir).filter((name) =>
      name.startsWith('.import-stage-'),
    );
    expect(stageDirs).toEqual([]);
  });
});

// #896 wave 2: codex counterpart of `importClaudeGlobalSnapshot` — the
// shared transactional/security machinery is proven by the claude suite
// above (unchanged by the refactor, run untouched as the regression proof);
// these tests only pin the codex-specific allowlist.
describe('importCodexGlobalSnapshot', () => {
  function writeGlobalDir(files: Record<string, string>): string {
    const globalDir = join(scratch, 'global-codex');
    mkdirSync(globalDir, { recursive: true });
    for (const [relPath, content] of Object.entries(files)) {
      const filePath = join(globalDir, relPath);
      mkdirSync(join(filePath, '..'), { recursive: true });
      writeFileSync(filePath, content);
    }
    return globalDir;
  }

  test('copies only the codex allowlist', async () => {
    const globalDir = writeGlobalDir({
      'config.toml': '[projects]\n',
      'AGENTS.md': '# notes',
      'prompts/greeting.md': '# hi',
      'skills/pizza/SKILL.md': '# pizza',
      'sessions/session.jsonl': 'transcript',
      'history.jsonl': '{}',
      'log/codex.log': 'log line',
    });
    const { dir: profileDir } = await ensureAppHomeProfile('codex-runtime', {
      homeDir,
    });

    const result = await importCodexGlobalSnapshot({
      globalDir,
      profileDir,
      homeDir,
    });

    expect(result.copied.sort()).toEqual(
      ['AGENTS.md', 'config.toml', 'prompts', 'skills'].sort(),
    );
    expect(result.skipped.map((s) => s.path).sort()).toEqual(
      ['history.jsonl', 'log', 'sessions'].sort(),
    );
    expect(result.skipped.every((s) => s.reason === 'not-on-allowlist')).toBe(
      true,
    );
    expect(readFileSync(join(profileDir, 'config.toml'), 'utf-8')).toBe(
      '[projects]\n',
    );
    expect(existsSync(join(profileDir, 'sessions'))).toBe(false);
  });

  test('copies auth.json only with includeCredentials', async () => {
    const globalDir = writeGlobalDir({
      'auth.json': '{"tokens":{"access_token":"secret"}}',
    });
    const { dir: profileDir } = await ensureAppHomeProfile('codex-runtime', {
      homeDir,
    });

    const withoutCredentials = await importCodexGlobalSnapshot({
      globalDir,
      profileDir,
      homeDir,
    });
    expect(withoutCredentials.copied).toEqual([]);
    expect(withoutCredentials.skipped).toEqual([
      { path: 'auth.json', reason: 'credentials-excluded' },
    ]);
    expect(existsSync(join(profileDir, 'auth.json'))).toBe(false);

    const withCredentials = await importCodexGlobalSnapshot({
      globalDir,
      profileDir,
      includeCredentials: true,
      homeDir,
    });
    expect(withCredentials.copied).toEqual(['auth.json']);
    expect(withCredentials.skipped).toEqual([]);
    expect(existsSync(join(profileDir, 'auth.json'))).toBe(true);
  });

  test('refuses symlinked and oversized sources', async () => {
    const globalDir = writeGlobalDir({
      'AGENTS.md': '# notes',
    });
    const outsideTarget = join(scratch, 'outside-codex-secret.txt');
    writeFileSync(outsideTarget, 'must never be copied');
    await symlink(outsideTarget, join(globalDir, 'config.toml'));
    writeFileSync(
      join(globalDir, 'AGENTS.md'),
      Buffer.alloc(APP_HOME_IMPORT_MAX_FILE_BYTES + 1, 'a'),
    );
    const { dir: profileDir } = await ensureAppHomeProfile('codex-runtime', {
      homeDir,
    });

    const result = await importCodexGlobalSnapshot({
      globalDir,
      profileDir,
      homeDir,
    });

    expect(result.copied).toEqual([]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { path: 'config.toml', reason: 'symlink-in-source' },
        { path: 'AGENTS.md', reason: 'file-too-large' },
      ]),
    );
    expect(existsSync(join(profileDir, 'config.toml'))).toBe(false);
    expect(existsSync(join(profileDir, 'AGENTS.md'))).toBe(false);
  });
});

describe('markAppHomeProfileImported', () => {
  test('records seededFrom global-import and importedAt, preserving createdAt', async () => {
    const { dir } = await ensureAppHomeProfile('claude-runtime', { homeDir });
    const before = JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf-8'));

    const result = await markAppHomeProfileImported('claude-runtime', dir, {
      now: () => '2026-07-26T00:00:00.000Z',
    });

    expect(result).toEqual({ ok: true });
    const after = JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf-8'));
    expect(after).toEqual({
      version: 1,
      engineId: 'claude-runtime',
      createdAt: before.createdAt,
      seededFrom: 'global-import',
      importedAt: '2026-07-26T00:00:00.000Z',
    });
  });

  test('a non-regular marker blocks import provenance updates', async () => {
    // HIGH (security review): the ORIGINAL bug — a plain `writeFile` to the
    // marker path follows a symlink there like any normal open, letting a
    // planted symlink turn "record this import" into an arbitrary-file
    // overwrite. Refused outright now, nothing written anywhere.
    const { dir } = await ensureAppHomeProfile('claude-runtime', { homeDir });
    const sentinelTarget = join(scratch, 'sentinel-marker-target.json');
    writeFileSync(sentinelTarget, 'do not touch');
    rmSync(join(dir, 'profile.json'));
    await symlink(sentinelTarget, join(dir, 'profile.json'));

    const result = await markAppHomeProfileImported('claude-runtime', dir);

    expect(result).toEqual({ ok: false, reason: 'marker-not-regular-file' });
    expect(readFileSync(sentinelTarget, 'utf-8')).toBe('do not touch');
    // No stray O_EXCL temp file left behind either — the refusal happens
    // before any write is attempted.
    expect(
      readdirSync(dir).filter((name) => name.startsWith('profile.json.tmp-')),
    ).toEqual([]);
  });

  test('a directory sitting at the marker path also blocks import provenance updates', async () => {
    const { dir } = await ensureAppHomeProfile('claude-runtime', { homeDir });
    rmSync(join(dir, 'profile.json'));
    mkdirSync(join(dir, 'profile.json'));

    const result = await markAppHomeProfileImported('claude-runtime', dir);

    expect(result).toEqual({ ok: false, reason: 'marker-not-regular-file' });
    expect(existsSync(join(dir, 'profile.json'))).toBe(true);
    expect(readdirSync(join(dir, 'profile.json'))).toEqual([]);
  });

  test('commits via a temp file + atomic rename — no leftover temp files after a clean update', async () => {
    const { dir } = await ensureAppHomeProfile('claude-runtime', { homeDir });

    const result = await markAppHomeProfileImported('claude-runtime', dir);

    expect(result).toEqual({ ok: true });
    const entries = readdirSync(dir);
    expect(entries).toEqual(['profile.json']);
  });
});

describe('symlink dodge on the profile dir itself', () => {
  test('a symlinked profile dir path still refuses import outside the real app-homes root', async () => {
    const globalDir = join(scratch, 'global-claude');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, 'settings.json'), '{}');

    const elsewhere = join(scratch, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    const symlinkedProfileDir = join(scratch, 'symlinked-profile-dir');
    await symlink(elsewhere, symlinkedProfileDir, 'dir');

    const result = await importClaudeGlobalSnapshot({
      globalDir,
      profileDir: symlinkedProfileDir,
    });

    expect(result.copied).toEqual([]);
    expect(result.skipped).toEqual([
      { path: '.', reason: 'profile-dir-outside-app-homes-root' },
    ]);
    expect(existsSync(join(elsewhere, 'settings.json'))).toBe(false);
  });
});

// #896 wave 2: bounded, on-request profile GC — usage report + explicit
// clear (no daemons/watchers/timers).
describe('readAppHomeProfileUsage', () => {
  test('reports null when the profile does not exist', async () => {
    const usage = await readAppHomeProfileUsage('claude-runtime', {
      homeDir,
    });
    expect(usage).toBeNull();
  });

  test('reports bounded usage across nested files', async () => {
    const { dir: profileDir } = await ensureAppHomeProfile('claude-runtime', {
      homeDir,
    });
    mkdirSync(join(profileDir, 'skills', 'pizza'), { recursive: true });
    writeFileSync(join(profileDir, 'settings.json'), '{"theme":"dark"}'); // 16 bytes
    writeFileSync(join(profileDir, 'skills', 'pizza', 'SKILL.md'), '# pizza'); // 7 bytes

    const usage = await readAppHomeProfileUsage('claude-runtime', {
      homeDir,
    });

    expect(usage).not.toBeNull();
    expect(usage?.truncated).toBe(false);
    // profile.json (marker) + settings.json + skills (dir) + pizza (dir) + SKILL.md
    expect(usage?.entryCount).toBe(5);
    expect(usage?.sizeBytes).toBeGreaterThanOrEqual(16 + 7);
  });

  test('never follows symlinks: a symlinked entry counts once at size 0 and is not recursed into', async () => {
    const { dir: profileDir } = await ensureAppHomeProfile('claude-runtime', {
      homeDir,
    });
    const outsideDir = join(scratch, 'usage-outside');
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, 'big.txt'), 'x'.repeat(1000));
    await symlink(outsideDir, join(profileDir, 'linked'), 'dir');

    const usage = await readAppHomeProfileUsage('claude-runtime', {
      homeDir,
    });

    expect(usage).not.toBeNull();
    // profile.json (marker) + the symlink itself — never the linked
    // target's contents. The symlink itself contributes 0 bytes to
    // `sizeBytes` (real `lstat` reports a symlink's own size as the byte
    // length of its target PATH text, not 0 — this assertion pins that
    // Station's own accounting deliberately never adds it, matching the
    // "symlinks count as one entry, size 0" contract) — so the total stays
    // far below the 1000-byte linked-target file it must never be
    // attributed to.
    expect(usage?.entryCount).toBe(2);
    expect(usage?.sizeBytes).toBeLessThan(200);
  });

  test('reports bounded usage and flags truncation at the cap', async () => {
    // A fully synthetic fs port (never touches real disk) — the cap is
    // 10,000 entries, far too many to materialize as real files in a test.
    const syntheticEntries = Array.from(
      { length: APP_HOME_USAGE_MAX_ENTRIES + 5 },
      (_, index) => ({
        name: `file-${index}`,
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
      }),
    );
    const fs: AppHomeFsPort = {
      lstat: async (path) => {
        if (path === profileDirFor('claude-runtime')) {
          return {
            isSymbolicLink: false,
            isFile: false,
            isDirectory: true,
            size: 0,
            dev: 1,
            ino: 1,
          };
        }
        return {
          isSymbolicLink: false,
          isFile: true,
          isDirectory: false,
          size: 1,
          dev: 1,
          ino: 2,
        };
      },
      realpath: async (path) => path,
      mkdirRecursive: async () => {
        throw new Error('not used in this test');
      },
      mkdtemp: async () => {
        throw new Error('not used in this test');
      },
      readdir: async (path) =>
        path === profileDirFor('claude-runtime') ? syntheticEntries : [],
      readFile: async () => {
        throw new Error('not used in this test');
      },
      openForRead: async () => {
        throw new Error('not used in this test');
      },
      writeFile: async () => {
        throw new Error('not used in this test');
      },
      writeFileExclusive: async () => {
        throw new Error('not used in this test');
      },
      rename: async () => {
        throw new Error('not used in this test');
      },
      rmRecursive: async () => {
        throw new Error('not used in this test');
      },
    };
    function profileDirFor(engineId: string): string {
      return appHomeProfileDir(engineId, homeDir);
    }

    const usage = await readAppHomeProfileUsage('claude-runtime', {
      homeDir,
      fs,
    });

    expect(usage).not.toBeNull();
    expect(usage?.truncated).toBe(true);
    expect(usage?.entryCount).toBe(APP_HOME_USAGE_MAX_ENTRIES);
  });
});

describe('clearAppHomeProfile', () => {
  test('refuses a profile dir resolving outside the app-homes root', async () => {
    const elsewhere = join(scratch, 'usage-clear-elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, 'sentinel.txt'), 'must never be removed');
    const symlinkedProfileDir = join(
      appHomesRootDir(homeDir),
      'claude-runtime',
    );
    mkdirSync(appHomesRootDir(homeDir), { recursive: true });
    await symlink(elsewhere, symlinkedProfileDir, 'dir');

    const result = await clearAppHomeProfile('claude-runtime', { homeDir });

    expect(result).toEqual({
      ok: false,
      reason: 'profile-dir-outside-app-homes-root',
    });
    expect(existsSync(join(elsewhere, 'sentinel.txt'))).toBe(true);
  });

  // HIGH (security review 1a028fde): the containment check above compares
  // RESOLVED paths only — when the app-homes ROOT itself is a symlink, both
  // `realRoot` and `realDir` resolve through it consistently and
  // containment still reports true, but a naive `rm` on the UNRESOLVED
  // profile dir would still be followed by the OS through that symlink,
  // deleting whatever it actually points at.
  test('a symlinked app-homes root cannot redirect the clear', async () => {
    const outsideRoot = join(scratch, 'usage-clear-root-elsewhere');
    const outsideProfileDir = join(outsideRoot, 'claude-runtime');
    mkdirSync(outsideProfileDir, { recursive: true });
    writeFileSync(
      join(outsideProfileDir, 'sentinel.txt'),
      'must never be removed',
    );
    // The ROOT (`app-homes`), not just the profile dir, is symlinked.
    await symlink(outsideRoot, appHomesRootDir(homeDir), 'dir');

    const result = await clearAppHomeProfile('claude-runtime', { homeDir });

    expect(result).toEqual({
      ok: false,
      reason: 'app-homes-ancestor-is-symlink',
    });
    expect(existsSync(join(outsideProfileDir, 'sentinel.txt'))).toBe(true);
  });

  test('removes only the contained profile dir', async () => {
    const { dir: profileDir } = await ensureAppHomeProfile('claude-runtime', {
      homeDir,
    });
    writeFileSync(join(profileDir, 'settings.json'), '{}');
    const { dir: codexProfileDir } = await ensureAppHomeProfile(
      'codex-runtime',
      { homeDir },
    );

    const result = await clearAppHomeProfile('claude-runtime', { homeDir });

    expect(result).toEqual({ ok: true, cleared: true });
    expect(existsSync(profileDir)).toBe(false);
    // A sibling profile is untouched.
    expect(existsSync(codexProfileDir)).toBe(true);
  });

  test('reports cleared: false when nothing existed', async () => {
    const result = await clearAppHomeProfile('claude-runtime', { homeDir });
    expect(result).toEqual({ ok: true, cleared: false });
  });
});
