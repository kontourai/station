import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  cleanupMaterializedSkills,
  defaultClaudeGlobalConfigDirs,
  materializeSkills,
  sweepStaleManifests,
} from '../adapters/claude-skills-materialization.js';

let scratch: string;

beforeEach(() => {
  scratch = join(
    tmpdir(),
    `station-skills-materialization-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(scratch, { recursive: true });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function writeSkillSource(
  root: string,
  id: string,
  files: Record<string, string>,
): string {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = join(dir, relativePath);
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, content);
  }
  return dir;
}

function skillsDir(cwd: string): string {
  return join(cwd, '.claude', 'skills');
}

function manifestPath(cwd: string, sessionId: string): string {
  return join(skillsDir(cwd), `.station-materialized.${sessionId}.json`);
}

describe('materializeSkills', () => {
  test('opt-in off: undefined skillIds is a true no-op (no .claude dir created)', async () => {
    const resolveSkillDir = vi.fn();
    const result = await materializeSkills({
      skillIds: undefined,
      cwd: scratch,
      sessionId: 'session-a',
      resolveSkillDir,
    });
    expect(result).toEqual({ materialized: [], skipped: [] });
    expect(resolveSkillDir).not.toHaveBeenCalled();
    expect(existsSync(join(scratch, '.claude'))).toBe(false);
  });

  test('opt-in off: empty skillIds array is a true no-op', async () => {
    const resolveSkillDir = vi.fn();
    const result = await materializeSkills({
      skillIds: [],
      cwd: scratch,
      sessionId: 'session-a',
      resolveSkillDir,
    });
    expect(result).toEqual({ materialized: [], skipped: [] });
    expect(resolveSkillDir).not.toHaveBeenCalled();
    expect(existsSync(join(scratch, '.claude'))).toBe(false);
  });

  test('refuses to materialize with an unsafe session id, never touching disk', async () => {
    const resolveSkillDir = vi.fn();
    const result = await materializeSkills({
      skillIds: ['pizza-skill'],
      cwd: scratch,
      sessionId: '../escape',
      resolveSkillDir,
    });
    expect(result.materialized).toEqual([]);
    expect(result.skipped).toEqual([
      { id: 'pizza-skill', reason: 'unsafe-session-id' },
    ]);
    expect(resolveSkillDir).not.toHaveBeenCalled();
    expect(existsSync(join(scratch, '.claude'))).toBe(false);
  });

  test('copies a skill directory tree and records a manifest with content hashes and tracked dirs', async () => {
    const sourceRoot = join(scratch, 'source');
    const sourceDir = writeSkillSource(sourceRoot, 'pizza-skill', {
      'SKILL.md': '# Pizza\n',
      'scripts/build.sh': '#!/bin/sh\necho pizza\n',
    });

    const result = await materializeSkills({
      skillIds: ['pizza-skill'],
      cwd: scratch,
      sessionId: 'session-a',
      resolveSkillDir: async (id) => (id === 'pizza-skill' ? sourceDir : null),
    });

    expect(result.materialized).toEqual(['pizza-skill']);
    expect(result.skipped).toEqual([]);
    const target = join(skillsDir(scratch), 'pizza-skill');
    expect(existsSync(join(target, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(target, 'scripts', 'build.sh'))).toBe(true);

    const manifest = JSON.parse(
      readFileSync(manifestPath(scratch, 'session-a'), 'utf-8'),
    );
    expect(manifest.version).toBe(2);
    expect(manifest.sessionId).toBe('session-a');
    expect(manifest.skills['pizza-skill'].files).toHaveLength(2);
    expect(manifest.skills['pizza-skill'].dirs.sort()).toEqual(
      ['', 'scripts'].sort(),
    );
    for (const file of manifest.skills['pizza-skill'].files) {
      expect(typeof file.sha256).toBe('string');
      expect(file.sha256).toHaveLength(64);
    }
  });

  test('refuses to overwrite a target directory Station did not write', async () => {
    const sourceDir = writeSkillSource(join(scratch, 'source'), 'pizza-skill', {
      'SKILL.md': '# Pizza\n',
    });
    // Pre-existing, user-owned directory at the exact target path.
    mkdirSync(join(skillsDir(scratch), 'pizza-skill'), { recursive: true });
    writeFileSync(
      join(skillsDir(scratch), 'pizza-skill', 'not-ours.txt'),
      'user content',
    );

    const result = await materializeSkills({
      skillIds: ['pizza-skill'],
      cwd: scratch,
      sessionId: 'session-a',
      resolveSkillDir: async () => sourceDir,
    });

    expect(result.materialized).toEqual([]);
    expect(result.skipped).toEqual([
      { id: 'pizza-skill', reason: 'target-exists-not-ours' },
    ]);
    // The user's file must be untouched.
    expect(
      readFileSync(
        join(skillsDir(scratch), 'pizza-skill', 'not-ours.txt'),
        'utf-8',
      ),
    ).toBe('user content');
    expect(existsSync(manifestPath(scratch, 'session-a'))).toBe(false);
  });

  test('rejects unsafe/path-traversal skill ids without ever calling resolveSkillDir', async () => {
    const resolveSkillDir = vi.fn();
    const result = await materializeSkills({
      skillIds: ['..', '.', '', 'nested/path', 'back\\slash'],
      cwd: scratch,
      sessionId: 'session-a',
      resolveSkillDir,
    });
    expect(result.materialized).toEqual([]);
    expect(result.skipped.every((s) => s.reason === 'unsafe-id')).toBe(true);
    expect(resolveSkillDir).not.toHaveBeenCalled();
  });

  test('skips (with a logged reason) a skill id that does not resolve to an installed directory, and cleans up its own empty claim', async () => {
    const warn = vi.fn();
    const result = await materializeSkills({
      skillIds: ['unknown-skill'],
      cwd: scratch,
      sessionId: 'session-a',
      resolveSkillDir: async () => null,
      logger: { warn },
    });
    expect(result.materialized).toEqual([]);
    expect(result.skipped).toEqual([
      { id: 'unknown-skill', reason: 'not-found' },
    ]);
    expect(warn).toHaveBeenCalled();
    expect(existsSync(join(skillsDir(scratch), 'unknown-skill'))).toBe(false);
  });

  test('no symlinks: a symlink inside the skill source aborts materialization for that skill and leaves no partial copy', async () => {
    const sourceDir = writeSkillSource(
      join(scratch, 'source'),
      'linked-skill',
      {
        'SKILL.md': '# Linked\n',
      },
    );
    const outsideTarget = join(scratch, 'outside-secret.txt');
    writeFileSync(outsideTarget, 'do not copy me');
    await symlink(outsideTarget, join(sourceDir, 'escape-link'));

    const result = await materializeSkills({
      skillIds: ['linked-skill'],
      cwd: scratch,
      sessionId: 'session-a',
      resolveSkillDir: async () => sourceDir,
    });

    expect(result.materialized).toEqual([]);
    expect(result.skipped[0]?.reason).toBe('symlink-in-source');
    expect(existsSync(join(skillsDir(scratch), 'linked-skill'))).toBe(false);
  });

  test('HIGH-3: a symlinked .claude ancestor is refused rather than followed', async () => {
    const realElsewhere = join(scratch, 'elsewhere-claude');
    mkdirSync(realElsewhere, { recursive: true });
    await symlink(realElsewhere, join(scratch, '.claude'));
    const sourceDir = writeSkillSource(join(scratch, 'source'), 'pizza-skill', {
      'SKILL.md': '# Pizza\n',
    });

    const result = await materializeSkills({
      skillIds: ['pizza-skill'],
      cwd: scratch,
      sessionId: 'session-a',
      resolveSkillDir: async () => sourceDir,
    });

    expect(result.materialized).toEqual([]);
    expect(result.skipped).toEqual([
      { id: 'pizza-skill', reason: 'containment-violation' },
    ]);
    // The symlinked ancestor itself must be left completely alone.
    expect(existsSync(join(realElsewhere, 'pizza-skill'))).toBe(false);
  });

  test('HIGH-3: concurrent claim race — a directory that appears between check and claim is never removed by the loser', async () => {
    const sourceDir = writeSkillSource(join(scratch, 'source'), 'pizza-skill', {
      'SKILL.md': '# Pizza\n',
    });
    // Simulate a genuinely concurrent second session claiming the directory
    // first (the atomic mkdir is the real race-closer; this reproduces the
    // "lost the race" branch directly).
    mkdirSync(join(skillsDir(scratch), 'pizza-skill'), { recursive: true });
    writeFileSync(
      join(skillsDir(scratch), 'pizza-skill', 'winner-session-file.txt'),
      'owned by the session that won the race',
    );

    const result = await materializeSkills({
      skillIds: ['pizza-skill'],
      cwd: scratch,
      sessionId: 'loser-session',
      resolveSkillDir: async () => sourceDir,
    });

    expect(result.skipped).toEqual([
      { id: 'pizza-skill', reason: 'target-exists-not-ours' },
    ]);
    // The winner's file must still be exactly as it was.
    expect(
      readFileSync(
        join(skillsDir(scratch), 'pizza-skill', 'winner-session-file.txt'),
        'utf-8',
      ),
    ).toBe('owned by the session that won the race');
  });
});

describe('cleanupMaterializedSkills', () => {
  test('no manifest present is a true no-op', async () => {
    const result = await cleanupMaterializedSkills({
      cwd: scratch,
      sessionId: 'session-a',
    });
    expect(result).toEqual({ removedSkillIds: [], retainedSkillIds: [] });
  });

  test('refuses to clean with an unsafe session id', async () => {
    const result = await cleanupMaterializedSkills({
      cwd: scratch,
      sessionId: '../escape',
    });
    expect(result).toEqual({ removedSkillIds: [], retainedSkillIds: [] });
  });

  test('removes only files whose content still matches the manifest, keeping user-modified files', async () => {
    const sourceDir = writeSkillSource(join(scratch, 'source'), 'pizza-skill', {
      'SKILL.md': '# Pizza\n',
      'scripts/build.sh': 'echo pizza\n',
    });
    await materializeSkills({
      skillIds: ['pizza-skill'],
      cwd: scratch,
      sessionId: 'session-a',
      resolveSkillDir: async () => sourceDir,
    });

    const target = join(skillsDir(scratch), 'pizza-skill');
    // Simulate the user editing one materialized file after the fact.
    writeFileSync(join(target, 'SKILL.md'), '# Pizza (edited by user)\n');

    const result = await cleanupMaterializedSkills({
      cwd: scratch,
      sessionId: 'session-a',
    });
    expect(result.removedSkillIds).toEqual([]);
    expect(result.retainedSkillIds).toEqual(['pizza-skill']);
    // The user-edited file survives; the unmodified file is gone.
    expect(existsSync(join(target, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(target, 'scripts', 'build.sh'))).toBe(false);
    // Manifest still exists (retried on tracked, still-differing content).
    expect(existsSync(manifestPath(scratch, 'session-a'))).toBe(true);
  });

  test('fully removes an unmodified materialized skill, pruning tracked empty directories and the manifest', async () => {
    const sourceDir = writeSkillSource(join(scratch, 'source'), 'pizza-skill', {
      'SKILL.md': '# Pizza\n',
      'scripts/build.sh': 'echo pizza\n',
    });
    await materializeSkills({
      skillIds: ['pizza-skill'],
      cwd: scratch,
      sessionId: 'session-a',
      resolveSkillDir: async () => sourceDir,
    });

    const result = await cleanupMaterializedSkills({
      cwd: scratch,
      sessionId: 'session-a',
    });
    expect(result.removedSkillIds).toEqual(['pizza-skill']);
    expect(result.retainedSkillIds).toEqual([]);
    expect(existsSync(join(skillsDir(scratch), 'pizza-skill'))).toBe(false);
    expect(existsSync(manifestPath(scratch, 'session-a'))).toBe(false);
    // The whole `.claude/skills` dir is pruned once empty.
    expect(existsSync(skillsDir(scratch))).toBe(false);
  });

  test('MED: a user-created empty directory inside the skill dir is never pruned', async () => {
    const sourceDir = writeSkillSource(join(scratch, 'source'), 'pizza-skill', {
      'SKILL.md': '# Pizza\n',
    });
    await materializeSkills({
      skillIds: ['pizza-skill'],
      cwd: scratch,
      sessionId: 'session-a',
      resolveSkillDir: async () => sourceDir,
    });
    const target = join(skillsDir(scratch), 'pizza-skill');
    // A directory the user created after materialization, never tracked in
    // the manifest.
    mkdirSync(join(target, 'user-notes'), { recursive: true });

    await cleanupMaterializedSkills({
      cwd: scratch,
      sessionId: 'session-a',
    });
    // The tracked file was removed, but the skill dir itself can't be
    // pruned because a non-tracked directory still lives inside it — that
    // is exactly the intended "never touch what we didn't create" outcome,
    // even though it means this skill isn't reported as cleanly removed.
    expect(existsSync(join(target, 'user-notes'))).toBe(true);
    expect(existsSync(join(target, 'SKILL.md'))).toBe(false);
  });

  test('HIGH-1: a manifest with a path-traversal relativePath is quarantined, not acted on', async () => {
    mkdirSync(skillsDir(scratch), { recursive: true });
    const path = manifestPath(scratch, 'session-a');
    // A file outside .claude/skills that a traversal would target, so we
    // can prove it survives untouched.
    const outsideVictim = join(scratch, 'victim.txt');
    writeFileSync(outsideVictim, 'must never be deleted');
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        sessionId: 'session-a',
        skills: {
          'evil-skill': {
            files: [
              { relativePath: '../../victim.txt', sha256: 'a'.repeat(64) },
            ],
            dirs: [''],
            materializedAt: new Date().toISOString(),
          },
        },
      }),
    );

    const result = await cleanupMaterializedSkills({
      cwd: scratch,
      sessionId: 'session-a',
    });
    expect(result).toEqual({ removedSkillIds: [], retainedSkillIds: [] });
    expect(existsSync(outsideVictim)).toBe(true);
    expect(readFileSync(outsideVictim, 'utf-8')).toBe('must never be deleted');
    expect(existsSync(path)).toBe(false); // renamed away, not left as-is
    const quarantined = readdirSync(skillsDir(scratch)).filter((name) =>
      name.includes('.invalid-'),
    );
    expect(quarantined.length).toBe(1);
  });

  test('HIGH-1: a manifest with an unsafe skill id is quarantined wholesale, including its otherwise-valid sibling entries', async () => {
    const sourceDir = writeSkillSource(join(scratch, 'source'), 'pizza-skill', {
      'SKILL.md': '# Pizza\n',
    });
    await materializeSkills({
      skillIds: ['pizza-skill'],
      cwd: scratch,
      sessionId: 'session-a',
      resolveSkillDir: async () => sourceDir,
    });
    const path = manifestPath(scratch, 'session-a');
    const manifest = JSON.parse(readFileSync(path, 'utf-8'));
    manifest.skills['../escape'] = {
      files: [],
      dirs: [''],
      materializedAt: new Date().toISOString(),
    };
    writeFileSync(path, JSON.stringify(manifest));

    const result = await cleanupMaterializedSkills({
      cwd: scratch,
      sessionId: 'session-a',
    });
    expect(result).toEqual({ removedSkillIds: [], retainedSkillIds: [] });
    // pizza-skill's real content is untouched because the WHOLE manifest
    // was quarantined rather than only the bad entry being dropped.
    expect(
      existsSync(join(skillsDir(scratch), 'pizza-skill', 'SKILL.md')),
    ).toBe(true);
  });

  test('HIGH-2: a regular file swapped for a different regular file (identical bytes, different identity) between verification and deletion is refused via the dev/ino check', async () => {
    const sourceDir = writeSkillSource(join(scratch, 'source'), 'pizza-skill', {
      'SKILL.md': '# Pizza\n',
    });
    await materializeSkills({
      skillIds: ['pizza-skill'],
      cwd: scratch,
      sessionId: 'session-a',
      resolveSkillDir: async () => sourceDir,
    });
    // The module resolves every manifest-derived path from
    // `realpath(.claude/skills)`, which on macOS differs from the literal
    // `os.tmpdir()`-based path (`/var/...` is itself a symlink to
    // `/private/var/...`) — match that exactly so the interception below
    // actually intercepts the SAME string the module operates on.
    const realSkillsDir = realpathSync(skillsDir(scratch));
    const filePath = join(realSkillsDir, 'pizza-skill', 'SKILL.md');

    // White-box race simulation via the injectable fs port: the FIRST lstat
    // call for this exact path (the tight pre-unlink recheck) reports a
    // different dev/ino than what the earlier `openForRead` fd actually
    // saw — modeling "the file at this path was deleted and replaced with
    // byte-identical content" in the window between hash and unlink. Every
    // other path/behavior defers to the real fs.
    const realNodeFs = await import('node:fs/promises');
    const realNodeFsSync = await import('node:fs');
    let lstatCallsForFile = 0;
    const fsPort = {
      lstat: async (p: string) => {
        if (p === filePath) {
          lstatCallsForFile += 1;
          // The first `lstat(filePath)` call is the containment-resolution
          // walk (before the file is even opened); the SECOND is the tight
          // recheck immediately before unlink — that is the one this test
          // targets, reporting a swapped identity there specifically.
          if (lstatCallsForFile === 2) {
            return {
              isSymbolicLink: false,
              isFile: true,
              isDirectory: false,
              dev: 999999,
              ino: 999999,
            };
          }
        }
        try {
          const stat = realNodeFsSync.lstatSync(p);
          return {
            isSymbolicLink: stat.isSymbolicLink(),
            isFile: stat.isFile(),
            isDirectory: stat.isDirectory(),
            dev: stat.dev,
            ino: stat.ino,
          };
        } catch {
          return null;
        }
      },
      realpath: async (p: string) => {
        try {
          return realNodeFsSync.realpathSync(p);
        } catch {
          return null;
        }
      },
      mkdirRecursive: async (p: string) => {
        await realNodeFs.mkdir(p, { recursive: true });
      },
      mkdirExclusive: async (p: string) => {
        try {
          await realNodeFs.mkdir(p);
          return 'created' as const;
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
            return 'exists' as const;
          }
          throw error;
        }
      },
      readdir: (p: string) => realNodeFs.readdir(p, { withFileTypes: true }),
      openForRead: async (p: string) => {
        let handle: Awaited<ReturnType<typeof realNodeFs.open>>;
        try {
          handle = await realNodeFs.open(p, 'r');
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
          throw error;
        }
        const stat = await handle.stat();
        return {
          isFile: stat.isFile(),
          dev: stat.dev,
          ino: stat.ino,
          read: () => handle.readFile() as Promise<Buffer>,
          close: () => handle.close(),
        };
      },
      writeExclusive: async (p: string, data: Buffer) => {
        await realNodeFs.writeFile(p, data, { flag: 'wx' });
      },
      writeFile: (p: string, data: Buffer) => realNodeFs.writeFile(p, data),
      unlink: (p: string) => realNodeFs.unlink(p),
      rename: (from: string, to: string) => realNodeFs.rename(from, to),
      rmdirIfEmpty: async (p: string) => {
        try {
          await realNodeFs.rmdir(p);
          return true;
        } catch {
          return false;
        }
      },
      rmRecursive: async (p: string) => {
        await realNodeFs.rm(p, { recursive: true, force: true });
      },
    };

    const result = await cleanupMaterializedSkills({
      cwd: scratch,
      sessionId: 'session-a',
      fs: fsPort,
    });
    expect(result.retainedSkillIds).toEqual(['pizza-skill']);
    // The file must survive — the identity mismatch refused the unlink.
    expect(existsSync(filePath)).toBe(true);
  });

  test('HIGH-2: a file swapped for a symlink between verification and deletion is never unlinked', async () => {
    const sourceDir = writeSkillSource(join(scratch, 'source'), 'pizza-skill', {
      'SKILL.md': '# Pizza\n',
    });
    await materializeSkills({
      skillIds: ['pizza-skill'],
      cwd: scratch,
      sessionId: 'session-a',
      resolveSkillDir: async () => sourceDir,
    });
    const filePath = join(skillsDir(scratch), 'pizza-skill', 'SKILL.md');
    const outsideVictim = join(scratch, 'victim2.txt');
    writeFileSync(outsideVictim, 'must never be deleted');

    // Fake the manifest's recorded hash to look like it matches a symlink
    // swap by directly exercising the identity check: replace the real
    // file with a symlink to the victim, keeping the manifest untouched
    // (its recorded hash still matches the ORIGINAL content, which the
    // symlink no longer serves — but the discriminating check here is the
    // fresh lstat identity/symlink guard, not content).
    rmSync(filePath);
    await symlink(outsideVictim, filePath);

    const result = await cleanupMaterializedSkills({
      cwd: scratch,
      sessionId: 'session-a',
    });
    expect(result.retainedSkillIds).toEqual(['pizza-skill']);
    expect(existsSync(outsideVictim)).toBe(true);
    expect(readFileSync(outsideVictim, 'utf-8')).toBe('must never be deleted');
  });

  test('crash-safety: sweepStaleManifests reconciles a manifest left by a session with no live record, once past the grace window', async () => {
    const sourceDir = writeSkillSource(join(scratch, 'source'), 'pizza-skill', {
      'SKILL.md': '# Pizza\n',
    });
    await materializeSkills({
      skillIds: ['pizza-skill'],
      cwd: scratch,
      sessionId: 'crashed-session',
      resolveSkillDir: async () => sourceDir,
    });
    expect(existsSync(manifestPath(scratch, 'crashed-session'))).toBe(true);

    const result = await sweepStaleManifests({
      cwd: scratch,
      isLiveSessionId: () => false,
      staleAfterMs: 0,
    });
    expect(result.swept).toEqual([
      {
        sessionId: 'crashed-session',
        result: { removedSkillIds: ['pizza-skill'], retainedSkillIds: [] },
      },
    ]);
    expect(existsSync(manifestPath(scratch, 'crashed-session'))).toBe(false);
  });

  test('HIGH-4: sweepStaleManifests never touches a live session, even if it looks stale by age', async () => {
    const sourceDir = writeSkillSource(join(scratch, 'source'), 'pizza-skill', {
      'SKILL.md': '# Pizza\n',
    });
    await materializeSkills({
      skillIds: ['pizza-skill'],
      cwd: scratch,
      sessionId: 'live-session',
      resolveSkillDir: async () => sourceDir,
    });

    const result = await sweepStaleManifests({
      cwd: scratch,
      isLiveSessionId: (id) => id === 'live-session',
      staleAfterMs: 0,
    });
    expect(result.swept).toEqual([]);
    expect(result.skippedLive).toEqual(['live-session']);
    expect(
      existsSync(join(skillsDir(scratch), 'pizza-skill', 'SKILL.md')),
    ).toBe(true);
  });

  test('HIGH-4: sweepStaleManifests leaves a very recent manifest alone within the grace window', async () => {
    const sourceDir = writeSkillSource(join(scratch, 'source'), 'pizza-skill', {
      'SKILL.md': '# Pizza\n',
    });
    await materializeSkills({
      skillIds: ['pizza-skill'],
      cwd: scratch,
      sessionId: 'racing-session',
      resolveSkillDir: async () => sourceDir,
    });

    const result = await sweepStaleManifests({
      cwd: scratch,
      isLiveSessionId: () => false, // not yet registered — still racing to start
      staleAfterMs: 5 * 60 * 1000,
    });
    expect(result.swept).toEqual([]);
    expect(result.skippedRecent).toEqual(['racing-session']);
    expect(
      existsSync(join(skillsDir(scratch), 'pizza-skill', 'SKILL.md')),
    ).toBe(true);
  });

  test('HIGH-4: two overlapping sessions in the same cwd never delete each other — full lifecycle interleave', async () => {
    const sourceA = writeSkillSource(join(scratch, 'source'), 'skill-a', {
      'SKILL.md': '# A\n',
    });
    const sourceB = writeSkillSource(join(scratch, 'source'), 'skill-b', {
      'SKILL.md': '# B\n',
    });
    const live = new Set<string>();

    // Session A starts.
    live.add('session-a');
    await sweepStaleManifests({
      cwd: scratch,
      isLiveSessionId: (id) => live.has(id),
    });
    await materializeSkills({
      skillIds: ['skill-a'],
      cwd: scratch,
      sessionId: 'session-a',
      resolveSkillDir: async (id) => (id === 'skill-a' ? sourceA : null),
    });

    // Session B starts while A is still live.
    live.add('session-b');
    await sweepStaleManifests({
      cwd: scratch,
      isLiveSessionId: (id) => live.has(id),
    });
    await materializeSkills({
      skillIds: ['skill-b'],
      cwd: scratch,
      sessionId: 'session-b',
      resolveSkillDir: async (id) => (id === 'skill-b' ? sourceB : null),
    });

    // Both skills present, from both sessions' own manifests.
    expect(existsSync(join(skillsDir(scratch), 'skill-a', 'SKILL.md'))).toBe(
      true,
    );
    expect(existsSync(join(skillsDir(scratch), 'skill-b', 'SKILL.md'))).toBe(
      true,
    );

    // Session A stops — only A's manifest/files are touched.
    live.delete('session-a');
    const stopA = await cleanupMaterializedSkills({
      cwd: scratch,
      sessionId: 'session-a',
    });
    expect(stopA.removedSkillIds).toEqual(['skill-a']);
    expect(existsSync(join(skillsDir(scratch), 'skill-a'))).toBe(false);
    expect(existsSync(join(skillsDir(scratch), 'skill-b', 'SKILL.md'))).toBe(
      true,
    );
    expect(existsSync(manifestPath(scratch, 'session-b'))).toBe(true);

    // Session B stops — cleans only its own.
    live.delete('session-b');
    const stopB = await cleanupMaterializedSkills({
      cwd: scratch,
      sessionId: 'session-b',
    });
    expect(stopB.removedSkillIds).toEqual(['skill-b']);
    expect(existsSync(skillsDir(scratch))).toBe(false);
  });

  test('re-materializing the same skill in a later session reclaims its own unmodified prior copy', async () => {
    const sourceDir = writeSkillSource(join(scratch, 'source'), 'pizza-skill', {
      'SKILL.md': '# Pizza v1\n',
    });
    const first = await materializeSkills({
      skillIds: ['pizza-skill'],
      cwd: scratch,
      sessionId: 'session-a',
      resolveSkillDir: async () => sourceDir,
    });
    expect(first.materialized).toEqual(['pizza-skill']);

    writeFileSync(join(sourceDir, 'SKILL.md'), '# Pizza v2\n');
    const second = await materializeSkills({
      skillIds: ['pizza-skill'],
      cwd: scratch,
      sessionId: 'session-a',
      resolveSkillDir: async () => sourceDir,
    });
    expect(second.materialized).toEqual(['pizza-skill']);
    expect(second.skipped).toEqual([]);
    expect(
      readFileSync(
        join(skillsDir(scratch), 'pizza-skill', 'SKILL.md'),
        'utf-8',
      ),
    ).toBe('# Pizza v2\n');
  });

  test('does not reclaim (refuses to overwrite) when the prior materialized copy was user-modified', async () => {
    const sourceDir = writeSkillSource(join(scratch, 'source'), 'pizza-skill', {
      'SKILL.md': '# Pizza v1\n',
    });
    await materializeSkills({
      skillIds: ['pizza-skill'],
      cwd: scratch,
      sessionId: 'session-a',
      resolveSkillDir: async () => sourceDir,
    });
    const target = join(skillsDir(scratch), 'pizza-skill');
    writeFileSync(join(target, 'SKILL.md'), '# Pizza (user edited)\n');

    const result = await materializeSkills({
      skillIds: ['pizza-skill'],
      cwd: scratch,
      sessionId: 'session-a',
      resolveSkillDir: async () => sourceDir,
    });
    expect(result.materialized).toEqual([]);
    expect(result.skipped).toEqual([
      { id: 'pizza-skill', reason: 'target-exists-not-ours' },
    ]);
    expect(readFileSync(join(target, 'SKILL.md'), 'utf-8')).toBe(
      '# Pizza (user edited)\n',
    );
  });
});

describe('global-config refusal guard (#896, agent-engine-unification.md §6.1)', () => {
  test('refuses when the session cwd resolves the skills root into the user global claude config', async () => {
    const fakeHome = join(scratch, 'fake-home');
    mkdirSync(fakeHome, { recursive: true });
    const resolveSkillDir = vi.fn();

    const result = await materializeSkills({
      skillIds: ['pizza-skill'],
      cwd: fakeHome,
      sessionId: 'session-a',
      resolveSkillDir,
      globalConfigDirs: [join(fakeHome, '.claude')],
    });

    expect(result.materialized).toEqual([]);
    expect(result.skipped).toEqual([
      { id: 'pizza-skill', reason: 'global-config-target' },
    ]);
    expect(resolveSkillDir).not.toHaveBeenCalled();
    // Zero filesystem writes: the global `.claude` dir must not even exist.
    expect(existsSync(join(fakeHome, '.claude'))).toBe(false);
  });

  test('refuses when CLAUDE_CONFIG_DIR points the global config at the session cwd .claude', async () => {
    const cwd = join(scratch, 'workspace');
    mkdirSync(cwd, { recursive: true });
    const env = {
      CLAUDE_CONFIG_DIR: join(cwd, '.claude'),
    } as NodeJS.ProcessEnv;
    const globalConfigDirs = defaultClaudeGlobalConfigDirs(
      env,
      join(scratch, 'unused-home'),
    );
    const resolveSkillDir = vi.fn();

    const result = await materializeSkills({
      skillIds: ['pizza-skill'],
      cwd,
      sessionId: 'session-a',
      resolveSkillDir,
      globalConfigDirs,
    });

    expect(result.materialized).toEqual([]);
    expect(result.skipped).toEqual([
      { id: 'pizza-skill', reason: 'global-config-target' },
    ]);
    expect(resolveSkillDir).not.toHaveBeenCalled();
    expect(existsSync(join(cwd, '.claude'))).toBe(false);
  });

  test('a symlinked cwd cannot dodge the guard', async () => {
    const fakeHome = join(scratch, 'fake-home');
    const globalClaudeDir = join(fakeHome, '.claude');
    mkdirSync(globalClaudeDir, { recursive: true });
    const symlinkedCwd = join(scratch, 'symlinked-cwd');
    await symlink(fakeHome, symlinkedCwd, 'dir');
    const resolveSkillDir = vi.fn();

    const result = await materializeSkills({
      skillIds: ['pizza-skill'],
      cwd: symlinkedCwd,
      sessionId: 'session-a',
      resolveSkillDir,
      globalConfigDirs: [globalClaudeDir],
    });

    expect(result.materialized).toEqual([]);
    expect(result.skipped).toEqual([
      { id: 'pizza-skill', reason: 'global-config-target' },
    ]);
    expect(resolveSkillDir).not.toHaveBeenCalled();
    expect(existsSync(join(globalClaudeDir, 'skills'))).toBe(false);
  });

  test('an ordinary repo cwd is unaffected', async () => {
    const fakeHome = join(scratch, 'fake-home');
    mkdirSync(fakeHome, { recursive: true });
    const repoCwd = join(scratch, 'repo');
    const sourceDir = writeSkillSource(join(scratch, 'source'), 'pizza-skill', {
      'SKILL.md': '# Pizza\n',
    });

    const result = await materializeSkills({
      skillIds: ['pizza-skill'],
      cwd: repoCwd,
      sessionId: 'session-a',
      resolveSkillDir: async () => sourceDir,
      globalConfigDirs: [join(fakeHome, '.claude')],
    });

    expect(result.materialized).toEqual(['pizza-skill']);
    expect(result.skipped).toEqual([]);
    expect(
      existsSync(join(skillsDir(repoCwd), 'pizza-skill', 'SKILL.md')),
    ).toBe(true);
  });

  test('defaultClaudeGlobalConfigDirs prefers CLAUDE_CONFIG_DIR and falls back to ~/.claude', () => {
    expect(
      defaultClaudeGlobalConfigDirs(
        { CLAUDE_CONFIG_DIR: '/custom/claude-home' } as NodeJS.ProcessEnv,
        '/home/user',
      ),
    ).toEqual(['/custom/claude-home', join('/home/user', '.claude')]);
    expect(
      defaultClaudeGlobalConfigDirs({} as NodeJS.ProcessEnv, '/home/user'),
    ).toEqual([join('/home/user', '.claude')]);
    expect(
      defaultClaudeGlobalConfigDirs(
        { CLAUDE_CONFIG_DIR: '  ' } as NodeJS.ProcessEnv,
        '/home/user',
      ),
    ).toEqual([join('/home/user', '.claude')]);
  });

  test('the guard is symmetric in cleanupMaterializedSkills — never reads/deletes out of a global config dir', async () => {
    const fakeHome = join(scratch, 'fake-home');
    mkdirSync(fakeHome, { recursive: true });
    // A manifest-shaped file sitting directly in the "global" skills dir —
    // if the guard were skipped here, cleanup would happily read/quarantine
    // it. It must never even be looked at.
    mkdirSync(join(fakeHome, '.claude', 'skills'), { recursive: true });
    writeFileSync(
      join(
        fakeHome,
        '.claude',
        'skills',
        '.station-materialized.session-a.json',
      ),
      '{ not valid json but must never be touched',
    );

    const result = await cleanupMaterializedSkills({
      cwd: fakeHome,
      sessionId: 'session-a',
      globalConfigDirs: [join(fakeHome, '.claude')],
    });

    expect(result).toEqual({ removedSkillIds: [], retainedSkillIds: [] });
    expect(
      existsSync(
        join(
          fakeHome,
          '.claude',
          'skills',
          '.station-materialized.session-a.json',
        ),
      ),
    ).toBe(true);
  });

  test('the guard is symmetric in sweepStaleManifests — never sweeps a global config dir', async () => {
    const fakeHome = join(scratch, 'fake-home');
    mkdirSync(join(fakeHome, '.claude', 'skills'), { recursive: true });
    writeFileSync(
      join(
        fakeHome,
        '.claude',
        'skills',
        '.station-materialized.crashed-session.json',
      ),
      JSON.stringify({
        version: 2,
        sessionId: 'crashed-session',
        skills: {},
      }),
    );

    const result = await sweepStaleManifests({
      cwd: fakeHome,
      isLiveSessionId: () => false,
      staleAfterMs: 0,
      globalConfigDirs: [join(fakeHome, '.claude')],
    });

    expect(result).toEqual({ swept: [], skippedLive: [], skippedRecent: [] });
    expect(
      existsSync(
        join(
          fakeHome,
          '.claude',
          'skills',
          '.station-materialized.crashed-session.json',
        ),
      ),
    ).toBe(true);
  });

  test('a relative CLAUDE_CONFIG_DIR is resolved against the session cwd', async () => {
    // MED-1a (security review): a relative CLAUDE_CONFIG_DIR must resolve
    // against the SESSION cwd — the directory the spawned Claude Code
    // child actually runs in, and therefore the directory a relative env
    // var value is interpreted against in practice — never against
    // Station's own (unrelated) server process cwd.
    const cwd = join(scratch, 'workspace');
    mkdirSync(cwd, { recursive: true });
    const env = { CLAUDE_CONFIG_DIR: '.claude' } as NodeJS.ProcessEnv;

    const globalConfigDirs = defaultClaudeGlobalConfigDirs(
      env,
      join(scratch, 'unused-home'),
      cwd,
    );
    expect(globalConfigDirs[0]).toBe(join(cwd, '.claude'));

    // Resolved against the WRONG base (Station's own server cwd, i.e. the
    // pre-fix default) would never collide with the session's own
    // `.claude` — proving the fix requires exercising the guard
    // end-to-end, not just the helper in isolation.
    const resolveSkillDir = vi.fn();
    const result = await materializeSkills({
      skillIds: ['pizza-skill'],
      cwd,
      sessionId: 'session-a',
      resolveSkillDir,
      globalConfigDirs,
    });

    expect(result.skipped).toEqual([
      { id: 'pizza-skill', reason: 'global-config-target' },
    ]);
    expect(resolveSkillDir).not.toHaveBeenCalled();
  });

  test('an absolute CLAUDE_CONFIG_DIR is used as-is, never re-based on the session cwd', () => {
    const cwd = join(scratch, 'workspace');
    const env = {
      CLAUDE_CONFIG_DIR: join(scratch, 'absolute-claude-home'),
    } as NodeJS.ProcessEnv;

    const globalConfigDirs = defaultClaudeGlobalConfigDirs(
      env,
      join(scratch, 'unused-home'),
      cwd,
    );
    expect(globalConfigDirs[0]).toBe(join(scratch, 'absolute-claude-home'));
  });

  test('a case-aliased global dir cannot dodge the guard on case-insensitive platforms', async () => {
    // MED-1b (security review): `realpath`'s OS-level case canonicalization
    // only applies to path components that already exist on disk — the
    // `.claude` target here deliberately does NOT exist yet (this guard
    // runs BEFORE anything is created), so the comparison falls through to
    // string-level containment. On a case-insensitive filesystem (APFS,
    // NTFS), a case-aliased path is the SAME underlying directory and must
    // not be able to dodge the guard via a bare case-sensitive compare.
    // `process.platform` is forced to 'darwin' for the duration of this
    // test (restored in `finally`) so the property is pinned regardless of
    // the actual host filesystem's case sensitivity.
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
    });
    try {
      const fakeHome = join(scratch, 'fake-home');
      mkdirSync(fakeHome, { recursive: true });
      const resolveSkillDir = vi.fn();

      const result = await materializeSkills({
        skillIds: ['pizza-skill'],
        cwd: fakeHome,
        sessionId: 'session-a',
        resolveSkillDir,
        // Case-aliased relative to the `.claude` this guard actually
        // compares against (CLAUDE_DIRNAME is always lowercase) — on a
        // real case-insensitive filesystem this is the SAME directory.
        globalConfigDirs: [join(fakeHome, '.CLAUDE')],
      });

      expect(result.skipped).toEqual([
        { id: 'pizza-skill', reason: 'global-config-target' },
      ]);
      expect(resolveSkillDir).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  test('case differences are NOT collapsed on a case-sensitive platform (linux)', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    });
    try {
      const fakeHome = join(scratch, 'fake-home');
      mkdirSync(fakeHome, { recursive: true });
      const sourceDir = writeSkillSource(
        join(scratch, 'source'),
        'pizza-skill',
        { 'SKILL.md': '# Pizza\n' },
      );

      const result = await materializeSkills({
        skillIds: ['pizza-skill'],
        cwd: fakeHome,
        sessionId: 'session-a',
        resolveSkillDir: async () => sourceDir,
        globalConfigDirs: [join(fakeHome, '.CLAUDE')],
      });

      // A differently-cased global dir string is a DIFFERENT directory on
      // a genuinely case-sensitive filesystem — must not be refused.
      expect(result.materialized).toEqual(['pizza-skill']);
      expect(result.skipped).toEqual([]);
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  });
});
