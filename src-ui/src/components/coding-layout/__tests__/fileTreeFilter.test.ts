import type { CodingFileEntry } from '@kontourai/station-sdk';
import { describe, expect, test } from 'vitest';
import { filterTree } from '../fileTreeFilter';

const tree: CodingFileEntry[] = [
  {
    name: 'src',
    path: 'src',
    type: 'directory',
    children: [
      { name: 'app.ts', path: 'src/app.ts', type: 'file' },
      {
        name: 'components',
        path: 'src/components',
        type: 'directory',
        children: [
          {
            name: 'Button.tsx',
            path: 'src/components/Button.tsx',
            type: 'file',
          },
        ],
      },
    ],
  },
  { name: 'README.md', path: 'README.md', type: 'file' },
];

describe('filterTree', () => {
  test('empty query returns the tree unchanged and no forced expansion', () => {
    const result = filterTree(tree, '');
    expect(result.tree).toBe(tree);
    expect(result.expanded.size).toBe(0);
  });

  test('matches a file by name and keeps its ancestor directories', () => {
    const { tree: out, expanded } = filterTree(tree, 'button');
    // Only the src → components → Button.tsx chain survives.
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe('src');
    expect(out[0].children).toHaveLength(1);
    expect(out[0].children?.[0].path).toBe('src/components');
    expect(out[0].children?.[0].children?.[0].path).toBe(
      'src/components/Button.tsx',
    );
    // Ancestors are flagged for expansion.
    expect(expanded.has('src')).toBe(true);
    expect(expanded.has('src/components')).toBe(true);
  });

  test('a directory that matches by name is kept (with its pruned subtree)', () => {
    const { tree: out, expanded } = filterTree(tree, 'components');
    expect(out[0].children?.some((c) => c.path === 'src/components')).toBe(
      true,
    );
    expect(expanded.has('src/components')).toBe(true);
  });

  test('is case-insensitive', () => {
    expect(filterTree(tree, 'README').tree).toHaveLength(1);
    expect(filterTree(tree, 'readme').tree[0].path).toBe('README.md');
  });

  test('non-matching query yields an empty tree', () => {
    expect(filterTree(tree, 'zzz-nope').tree).toHaveLength(0);
  });
});
