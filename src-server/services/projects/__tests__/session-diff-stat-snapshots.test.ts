import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { execGitSync } from '../../../utils/git-exec.js';
import { SessionDiffStatSnapshots } from '../session-diff-stat-snapshots.js';

const tempDir = trackTempDirs();

it('drops idle workspace observations before refreshing them again', async () => {
  const root = realpathSync(tempDir('session-diff-'));
  execGitSync(['init', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, 'README.md'), 'Original\n');
  execGitSync(['add', 'README.md'], { cwd: root });
  execGitSync(
    [
      '-c',
      'user.name=Station',
      '-c',
      'user.email=station@example.test',
      'commit',
      '-m',
      'Base',
    ],
    { cwd: root },
  );
  const workspace = { projectRoot: root, cwd: root };
  const snapshots = new SessionDiffStatSnapshots();
  const now = Date.parse('2026-11-26T10:00:00Z');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    expect(snapshots.get('chat', workspace)).toBeUndefined();
    await snapshots.refresh(now, () => true);
    expect(snapshots.get('chat', workspace)).toEqual({ branch: 'main' });

    const later = now + 15 * 60_000;
    clock.mockReturnValue(later);
    await snapshots.refresh(later, () => true);
    expect(snapshots.get('chat', workspace)).toBeUndefined();
    await snapshots.refresh(later, () => true);
    expect(snapshots.get('chat', workspace)).toEqual({ branch: 'main' });
  } finally {
    clock.mockRestore();
  }
});
