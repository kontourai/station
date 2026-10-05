import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * #3399: the iOS app supports iOS 14 (`src-desktop/tauri.ios.conf.json`),
 * and WebKit rejects regex lookbehind before 16.4. A lookbehind in code the
 * WebView loads is a SyntaxError there, and one built at module load takes
 * the whole module down. No bundler step catches it: esbuild rewrites an
 * unsupported literal to `new RegExp(...)` instead of refusing it.
 *
 * A source sweep on purpose: the failure is the syntax itself, on an engine
 * the test runner is not.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..');

/** Sources the WebView can load: the UI and the client packages. */
const SCANNED = [
  'src-ui/src',
  ...readdirSync(join(ROOT, 'packages'))
    // The CLI runs in Node, never in the WebView.
    .filter((name) => name !== 'cli')
    .map((name) => `packages/${name}/src`),
];

/** `(?<=` and `(?<!`, but not a named group `(?<name>`. */
const LOOKBEHIND = /\(\?<[=!]/;

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* sourceFiles(full);
      continue;
    }
    if (
      (entry.endsWith('.ts') || entry.endsWith('.tsx')) &&
      !entry.includes('.test.')
    )
      yield full;
  }
}

describe('client sources use no regex lookbehind (#3399)', () => {
  test('the detector finds a lookbehind and ignores a named group', () => {
    expect(LOOKBEHIND.test(String.raw`(?<![\w/])(x)`)).toBe(true);
    expect(LOOKBEHIND.test(String.raw`(?<=a)b`)).toBe(true);
    expect(LOOKBEHIND.test(String.raw`(?<name>x)`)).toBe(false);
  });

  test('no scanned source contains one', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const dir of SCANNED) {
      let exists = true;
      try {
        statSync(join(ROOT, dir));
      } catch {
        exists = false;
      }
      if (!exists) continue;
      for (const file of sourceFiles(join(ROOT, dir))) {
        scanned += 1;
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, index) => {
            if (LOOKBEHIND.test(line))
              offenders.push(`${relative(ROOT, file)}:${index + 1}`);
          });
      }
    }
    // The sweep must have reached the UI and the SDK, or it proves nothing.
    expect(scanned).toBeGreaterThan(500);
    expect(offenders).toEqual([]);
  });
});
