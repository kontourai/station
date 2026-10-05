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
 * the test runner is not. It covers Station's own sources only. Bundled
 * dependencies still carry lookbehinds (mdast-util-gfm-autolink-literal 2.0.1,
 * @kontourai/ui 1.18 tones, @pierre/diffs 1.4 constants), so this keeps
 * Station from adding to them; it does not make iOS 14-16.3 work (#3399).
 */

const ROOT = join(import.meta.dirname, '..', '..', '..');

/** Sources the WebView can load: the UI, shared code and client packages. */
const SCANNED = [
  'src-ui/src',
  // Imported by the UI through the `@shared` alias and relative paths.
  'src-shared',
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
    if (/\.(ts|tsx|js|mjs)$/.test(entry) && !entry.includes('.test.'))
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
    const counts: Record<string, number> = {};
    for (const dir of SCANNED) {
      // A listed root that disappeared must fail, not shrink the sweep.
      counts[dir] = 0;
      for (const file of sourceFiles(join(ROOT, dir))) {
        counts[dir] += 1;
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, index) => {
            if (LOOKBEHIND.test(line))
              offenders.push(`${relative(ROOT, file)}:${index + 1}`);
          });
      }
    }
    // Every root contributed sources, so the sweep reached each of them.
    expect(Object.entries(counts).filter(([, count]) => count === 0)).toEqual(
      [],
    );
    expect(offenders).toEqual([]);
  });
});
