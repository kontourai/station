import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { inventoryCodeHealthFiles } from '../code-health-inventory.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
test('binds inventory to actual source bytes and distinguishes missing files', () => {
  const root = mkdtempSync(join(tmpdir(), 'code-health-'));
  roots.push(root);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/app.ts'), 'export const value = 1;\n');
  const first = inventoryCodeHealthFiles(root, [
    'src/app.ts',
    'src/missing.rs',
    'src/app.ts',
  ]);
  expect(first.files).toHaveLength(2);
  expect(first.files[0]).toMatchObject({
    status: 'inventoried',
    kind: 'javascript-typescript',
    lines: 1,
  });
  expect(first.files[1]).toMatchObject({ status: 'missing', kind: 'native' });
  writeFileSync(join(root, 'src/app.ts'), 'export const value = 2;\n');
  expect(
    inventoryCodeHealthFiles(root, ['src/app.ts']).files[0].sha256,
  ).not.toBe(first.files[0].sha256);
});
test('refuses paths outside the declared repository', () => {
  expect(() =>
    inventoryCodeHealthFiles('/tmp/project', ['../private.ts']),
  ).toThrow('leaves');
});
