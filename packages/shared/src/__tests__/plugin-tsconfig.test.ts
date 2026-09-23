import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { parseJsonc, pluginTsconfig } from '../plugin-tsconfig.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe('parseJsonc', () => {
  test('removes comments and trailing commas outside strings only', () => {
    expect(
      parseJsonc(
        '{\n  // a comment\n  "a": "h,}", /* block */ "b": ["x,]", "//not a comment",],\n  "c": { "d": 1, },\n}',
      ),
    ).toEqual({ a: 'h,}', b: ['x,]', '//not a comment'], c: { d: 1 } });
  });

  test('keeps escaped quotes inside strings', () => {
    expect(parseJsonc('{"a": "say \\"hi,}\\"",}')).toEqual({
      a: 'say "hi,}"',
    });
  });
});

describe('pluginTsconfig', () => {
  test('reports every extends it did not follow', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'station-tsc-')));
    roots.push(root);
    mkdirSync(join(root, 'plugin'));
    writeFileSync(join(root, 'outside.json'), '{"compilerOptions":{}}');
    writeFileSync(
      join(root, 'plugin', 'tsconfig.json'),
      JSON.stringify({
        extends: ['../outside.json', '@tsconfig/hoisted', './missing.json'],
        compilerOptions: { jsx: 'react-jsx' },
      }),
    );
    const result = pluginTsconfig(join(root, 'plugin'));
    expect(result.droppedExtends).toEqual([
      '../outside.json',
      '@tsconfig/hoisted',
      './missing.json',
    ]);
    expect(result.tsconfigRaw.compilerOptions).toEqual({ jsx: 'react-jsx' });
  });

  test('drops paths targets that leave the plugin root and keeps the rest', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'station-tsc-')));
    roots.push(root);
    mkdirSync(join(root, 'plugin'));
    writeFileSync(
      join(root, 'plugin', 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@x/*': ['../outside/*', 'src/*'], '@y/*': ['../only/*'] },
        },
      }),
    );
    const { compilerOptions } = pluginTsconfig(
      join(root, 'plugin'),
    ).tsconfigRaw;
    expect(compilerOptions.paths).toEqual({ '@x/*': ['src/*'] });
    expect(compilerOptions.baseUrl).toBe(join(root, 'plugin'));
  });
});
