import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';

const repoRoot = resolve(__dirname, '..', '..');

// Import ONE module first in a fresh Node process, the way the Issue lifecycle
// workflow's github-script step does. The in-process reducer test imports the
// backlog policy before the reducer, which happens to enter the module graph at
// a point where every binding initializes before it is read; it stayed green
// through #1312 while every production run threw "Cannot access
// 'NEEDS_MAINTAINER' before initialization". Only a cold entry proves the
// graph loads regardless of who imports first.
function loadFirst(relativePath: string, expression: string) {
  const url = pathToFileURL(resolve(repoRoot, relativePath)).href;
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const m = await import(${JSON.stringify(url)}); process.stdout.write(String(${expression}));`,
    ],
    { cwd: repoRoot, encoding: 'utf8', windowsHide: true },
  );
}

describe('issue lifecycle module graph', () => {
  test('loads when the reducer is the first module imported, as the workflow does', () => {
    const result = loadFirst(
      'scripts/issue-lifecycle-reducer.mjs',
      'typeof m.reduceIssueLifecycle + " " + m.NEEDS_MAINTAINER + " " + m.NEEDS_REPORTER',
    );
    expect(result.stderr, result.stderr).not.toMatch(
      /before initialization|ReferenceError/,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('function needs:maintainer needs:reporter');
  });

  test('loads when the label manifest is the first module imported', () => {
    const result = loadFirst(
      'scripts/label-manifest.mjs',
      'm.EXPECTED_LABEL_NAMES.includes("needs:maintainer") && m.EXPECTED_LABEL_NAMES.includes("needs:reporter")',
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('true');
  });

  test('loads when the backlog policy is the first module imported', () => {
    const result = loadFirst(
      'scripts/backlog-priority-policy.mjs',
      'typeof m.BACKLOG_POLICY',
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('object');
  });
});
