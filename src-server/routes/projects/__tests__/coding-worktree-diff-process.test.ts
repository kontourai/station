import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  codingDiffFixture,
  THREE_NEW_FILES,
} from './fixtures/coding-worktree-diff.js';

const makeTempDir = trackTempDirs();
const stationRoot = resolve(import.meta.dirname, '../../../..');
const runner = resolve(
  import.meta.dirname,
  'fixtures/coding-worktree-diff-process.mjs',
);
const run = (input: string) =>
  spawnSync(process.execPath, ['--import', 'tsx', runner], {
    cwd: stationRoot,
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 45_000,
    maxBuffer: 12 * 1024 * 1024,
  });

test('the Node bridge returns the exact real public route body without changing index or status', async () => {
  const fixture = codingDiffFixture(makeTempDir('station-diff-process-'));
  for (const [name, content] of Object.entries(THREE_NEW_FILES))
    fixture.put(name, content);
  const before = fixture.state();
  const expected = await fixture.request();
  const expectedBody: unknown = await expected.json();
  const result = run(JSON.stringify({ root: fixture.root }));
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    status: expected.status,
    body: expectedBody,
  });
  expect(fixture.state()).toEqual(before);
});

test.each(['invalid JSON', 'x'.repeat(16 * 1024 + 1)])(
  'invalid bridge input exits nonzero without a successful response',
  (input) => {
    const result = run(input);
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
  },
);
