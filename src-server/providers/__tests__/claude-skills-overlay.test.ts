import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  removeSkillOverlayDir,
  skillOverlayDirFor,
  skillOverlaysRootDir,
  sweepStaleSkillOverlays,
} from '../adapters/claude-skills-overlay.js';

let scratch: string;

beforeEach(() => {
  scratch = join(
    tmpdir(),
    `station-skills-overlay-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(scratch, { recursive: true });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('skillOverlaysRootDir / skillOverlayDirFor', () => {
  test('roots the overlay under <homeDir>/claude-skill-overlays', () => {
    expect(skillOverlaysRootDir(scratch)).toBe(
      join(scratch, 'claude-skill-overlays'),
    );
    expect(skillOverlayDirFor('thread-1', scratch)).toBe(
      join(scratch, 'claude-skill-overlays', 'thread-1'),
    );
  });

  test('rejects an unsafe session id (path separator)', () => {
    expect(() => skillOverlayDirFor('../escape', scratch)).toThrow(
      /not filesystem-safe/,
    );
  });

  test('rejects an unsafe session id (empty string)', () => {
    expect(() => skillOverlayDirFor('', scratch)).toThrow(
      /not filesystem-safe/,
    );
  });
});

describe('removeSkillOverlayDir', () => {
  test('recursively removes a session overlay directory', async () => {
    const dir = skillOverlayDirFor('thread-remove', scratch);
    mkdirSync(join(dir, '.claude', 'skills', 'writing'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', 'skills', 'writing', 'SKILL.md'),
      '# Writing\n',
    );
    expect(existsSync(dir)).toBe(true);

    await removeSkillOverlayDir('thread-remove', { homeDir: scratch });

    expect(existsSync(dir)).toBe(false);
  });

  test('a missing overlay directory is a silent no-op', async () => {
    await expect(
      removeSkillOverlayDir('thread-never-existed', { homeDir: scratch }),
    ).resolves.toBeUndefined();
  });

  test('an unsafe session id removes nothing and never throws', async () => {
    await expect(
      removeSkillOverlayDir('../escape', { homeDir: scratch }),
    ).resolves.toBeUndefined();
  });
});

describe('sweepStaleSkillOverlays', () => {
  test('removes a non-live overlay directory once past the grace window', async () => {
    const dir = skillOverlayDirFor('crashed-session', scratch);
    mkdirSync(join(dir, '.claude', 'skills', 'writing'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', 'skills', 'writing', 'SKILL.md'),
      '# Writing\n',
    );

    const result = await sweepStaleSkillOverlays({
      isLiveSessionId: () => false,
      staleAfterMs: 0,
      homeDir: scratch,
      // A real staleAfterMs:0 comparison against the real clock is exactly
      // the flakiest possible window on a loaded host (filesystem mtime
      // granularity/skew can occasionally read a hair ahead of a
      // back-to-back Date.now() read) -- push `now` comfortably ahead so
      // the staleness verdict never depends on real-time precision.
      now: () => Date.now() + 60_000,
    });

    expect(result.swept).toEqual(['crashed-session']);
    expect(existsSync(dir)).toBe(false);
  });

  test('never touches a live session, even if it looks stale by age', async () => {
    const dir = skillOverlayDirFor('live-session', scratch);
    mkdirSync(join(dir, '.claude', 'skills'), { recursive: true });

    const result = await sweepStaleSkillOverlays({
      isLiveSessionId: (id) => id === 'live-session',
      staleAfterMs: 0,
      homeDir: scratch,
    });

    expect(result.swept).toEqual([]);
    expect(result.skippedLive).toEqual(['live-session']);
    expect(existsSync(dir)).toBe(true);
  });

  test('leaves a very recent overlay directory alone within the default grace window', async () => {
    const dir = skillOverlayDirFor('racing-session', scratch);
    mkdirSync(join(dir, '.claude', 'skills'), { recursive: true });

    const result = await sweepStaleSkillOverlays({
      isLiveSessionId: () => false, // not yet registered -- still racing to start
      homeDir: scratch,
    });

    expect(result.swept).toEqual([]);
    expect(result.skippedRecent).toEqual(['racing-session']);
    expect(existsSync(dir)).toBe(true);
  });

  test('an absent overlay root is a true no-op', async () => {
    const result = await sweepStaleSkillOverlays({
      isLiveSessionId: () => false,
      staleAfterMs: 0,
      homeDir: join(scratch, 'never-created'),
    });
    expect(result).toEqual({ swept: [], skippedLive: [], skippedRecent: [] });
  });
});
