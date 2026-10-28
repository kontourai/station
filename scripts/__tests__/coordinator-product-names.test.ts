/**
 * #3628: the coordinator's product names are pending a trademark check, so a
 * rename must stay a one-line change. They live in one copy source,
 * `src-ui/src/lib/productNames.ts`; every other source, including what Station
 * hands agents (the generated docs bundle, wake text) and server code, says
 * "coordinator" or reads the constant. This guard takes the names from that
 * file, so it follows a rename, and fails on any other literal use.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const COPY_SOURCE = 'src-ui/src/lib/productNames.ts';
const SCANNED = [
  'src-server',
  'src-ui/src',
  'src-shared',
  'packages',
  'scripts',
];
const SKIPPED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.turbo',
]);
const EXTENSIONS = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|json|css|html)$/;

function productNames(): string[] {
  const text = readFileSync(join(ROOT, COPY_SOURCE), 'utf8');
  return [...text.matchAll(/export const \w+_PRODUCT_NAME = '([^']+)';/g)].map(
    (match) => match[1]!,
  );
}

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (EXTENSIONS.test(name)) yield path;
  }
}

describe('coordinator product names stay in their copy source', () => {
  test('the copy source declares both names', () => {
    expect(productNames()).toHaveLength(2);
  });

  test('no other source file spells them', () => {
    const names = productNames();
    const offenders: string[] = [];
    for (const top of SCANNED)
      for (const path of files(join(ROOT, top))) {
        const rel = relative(ROOT, path);
        if (rel === COPY_SOURCE) continue;
        const text = readFileSync(path, 'utf8');
        for (const name of names)
          if (text.includes(name)) offenders.push(`${rel}: ${name}`);
      }
    expect(offenders).toEqual([]);
  });
});
