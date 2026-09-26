/**
 * The real-tree half of `classify-ci-change.test.ts`, moved here unchanged
 * (#2176) so the `repo-scans` pull-request job can run it: it reads the
 * desktop crate's own sources, which no import edge connects to this test.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { classifyDesktopRustChangedPaths } from '../classify-ci-change.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');

describe('desktop Rust relevance for the Windows PR floor', () => {
  // The input list is hand-maintained, so it is checked against what the
  // crate actually reads: every file it pulls in from outside src-desktop
  // must classify as relevant, or a change to it would skip the only Windows
  // compile. A new include_str!, path dependency, build.rs read or bundled
  // resource that the list does not cover fails here instead.
  test('covers every input the crate reads from outside src-desktop', () => {
    const crate = join(repoRoot, 'src-desktop');
    const outside = new Set<string>();
    const note = (absolute: string) => {
      const path = relative(repoRoot, absolute).split('\\').join('/');
      // Build outputs the workflow creates empty; nothing in Git to change.
      if (path.startsWith('dist-')) return;
      if (!path.startsWith('src-desktop/')) outside.add(path);
    };
    const sources = readdirSync(join(crate, 'src'), {
      recursive: true,
    }) as string[];
    for (const file of sources.filter((name) => name.endsWith('.rs'))) {
      const absolute = join(crate, 'src', file);
      for (const match of readFileSync(absolute, 'utf8').matchAll(
        /include_(?:str|bytes)!\("([^"]+)"\)/g,
      ))
        note(resolve(dirname(absolute), match[1]));
    }
    for (const match of readFileSync(
      join(crate, 'Cargo.toml'),
      'utf8',
    ).matchAll(/path\s*=\s*"([^"]+)"/g))
      note(join(resolve(crate, match[1]), 'Cargo.toml'));
    for (const match of readFileSync(join(crate, 'build.rs'), 'utf8').matchAll(
      /"(\.\.\/[^"]+)"/g,
    ))
      note(resolve(crate, match[1]));
    for (const config of readdirSync(crate).filter((name) =>
      /^tauri(\..+)?\.conf\.json$/.test(name),
    )) {
      const resources = JSON.parse(readFileSync(join(crate, config), 'utf8'))
        ?.bundle?.resources;
      const sourcesOf = Array.isArray(resources)
        ? resources
        : Object.keys(resources ?? {});
      for (const source of sourcesOf)
        if (String(source).startsWith('../'))
          note(join(resolve(crate, source), 'resource'));
    }

    // Pin the discovery itself, so a regex that stops matching cannot turn
    // this into a loop over nothing.
    expect([...outside].sort()).toEqual([
      'package.json',
      'packages/cli/src/commands/profile-store.ts',
      'patches/android-native-keyring-store/Cargo.toml',
      'schemas/resource',
    ]);
    for (const path of outside) {
      expect(
        existsSync(join(repoRoot, path)) || path.endsWith('/resource'),
      ).toBe(true);
      expect(
        classifyDesktopRustChangedPaths([path]).relevant,
        `${path} is read by the desktop crate`,
      ).toBe(true);
    }
  });
});
