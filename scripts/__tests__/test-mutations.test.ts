import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  mutationCaught,
  removeEmptyRender,
  withMutation,
} from '../run-test-mutations.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test('a surviving mutation, a loader failure, and a failure in another test are never catch evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'mutation-verdict-'));
  roots.push(root);
  const output = ` RUN v4 ${root}\n FAIL suite.test.ts > target assertion\n Tests 1 failed`;
  expect(mutationCaught({ status: 1, output }, root, 'target assertion')).toBe(
    true,
  );
  expect(mutationCaught({ status: 0, output }, root, 'target assertion')).toBe(
    false,
  );
  expect(
    mutationCaught(
      { status: 1, output: ` RUN v4 ${root}\n Failed to load module` },
      root,
      'target assertion',
    ),
  ).toBe(false);
  expect(mutationCaught({ status: 1, output }, root, 'another assertion')).toBe(
    false,
  );
  expect(
    mutationCaught(
      { status: 1, output, truncated: true },
      root,
      'target assertion',
    ),
  ).toBe(false);
});

test('restores injected bytes even when test execution throws', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mutation-restore-'));
  roots.push(root);
  const logs = join(root, 'logs');
  mkdirSync(logs);
  const path = join(root, 'subject.ts');
  writeFileSync(path, 'original');
  await expect(
    withMutation(
      root,
      { files: [{ path: 'subject.ts', change: () => 'injected' }] },
      logs,
      async () => {
        expect(readFileSync(path, 'utf8')).toBe('injected');
        throw new Error('process failed');
      },
    ),
  ).rejects.toThrow('process failed');
  expect(readFileSync(path, 'utf8')).toBe('original');
});

test('preserves intervening edits while restoring other owned files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mutation-intervening-'));
  roots.push(root);
  const logs = join(root, 'logs');
  mkdirSync(logs);
  for (const name of ['a.ts', 'b.ts'])
    writeFileSync(join(root, name), 'original');
  const mutation = {
    files: ['a.ts', 'b.ts'].map((path) => ({ path, change: () => 'injected' })),
  };
  await expect(
    withMutation(root, mutation, logs, async () => {
      writeFileSync(join(root, 'a.ts'), 'user edit');
    }),
  ).rejects.toThrow('intervening edit');
  expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('user edit');
  expect(readFileSync(join(root, 'b.ts'), 'utf8')).toBe('original');
});

test('empty-render injection changes the JSX branch and refuses missing or ambiguous targets', () => {
  expect(
    removeEmptyRender('const x = items.length === 0 ? <Empty/> : <Rows/>;'),
  ).toContain('? null :');
  expect(() => removeEmptyRender('const x = <Empty/>;')).toThrow(
    'Expected one',
  );
});
