import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { INDEXED_DIRECTORIES } from '../docs-index.mjs';

// docs/README.md indexed roughly half the docs tree when this was written —
// 17 ADRs and eight whole directories were unreachable from the map that calls
// itself the map. Directory-level reachability is enforced here (the README
// stays curated prose); file-level completeness for the two drift-prone
// directories is enforced by the generated docs-index blocks.

function tracked(args: string[]): string[] {
  return execFileSync('git', ['ls-files', '--', ...args], {
    encoding: 'utf8',
    windowsHide: true,
  })
    .split('\n')
    .filter(Boolean);
}

describe('docs index reachability', () => {
  const index = readFileSync('docs/README.md', 'utf8');

  it('mentions every top-level docs/ directory', () => {
    const directories = new Set(
      tracked(['docs'])
        .map((path) => path.split('/'))
        .filter((parts) => parts.length > 2)
        .map((parts) => parts[1]),
    );
    expect(directories.size).toBeGreaterThan(10);
    for (const directory of directories) {
      expect(index, `docs/README.md never mentions docs/${directory}/`).toMatch(
        new RegExp(`\\(${directory}/`),
      );
    }
  });

  it('links every root-level docs/*.md', () => {
    const roots = tracked(['docs/*.md'])
      .filter((path) => path.split('/').length === 2)
      .map((path) => path.slice('docs/'.length))
      .filter((name) => name !== 'README.md');
    expect(roots.length).toBeGreaterThan(3);
    for (const name of roots) {
      expect(index, `docs/README.md never links docs/${name}`).toContain(
        `(${name})`,
      );
    }
  });

  it('the generated per-directory indexes match their tracked files', () => {
    // Regenerate-and-diff, as a real child process so the npm entry point and
    // its non-zero drift exit are proven, not just the pure functions.
    const result = execFileSync('node', ['scripts/docs-index.mjs', '--check'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(result).toBe('');
  });

  it('both indexed READMEs still carry their marker blocks', () => {
    for (const directory of INDEXED_DIRECTORIES) {
      const body = readFileSync(`${directory}/README.md`, 'utf8');
      expect(
        body,
        `${directory}/README.md lost its docs-index block`,
      ).toContain('docs-index:start');
    }
  });
});
