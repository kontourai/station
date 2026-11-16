/**
 * Native files named by a literal path in a scripts test (#4891).
 *
 * `src-desktop/**` matches a boundary edge that only names the deferred
 * `verify-local` lane, so a pull request that changes `lib.rs` ran no test
 * for it, while many `scripts/__tests__` suites assert on the TEXT of native
 * files (Rust, Kotlin, Swift, plists, manifests, Tauri config) through a
 * cwd-relative literal such as `readFileSync('src-desktop/src/lib.rs')`. The
 * path-read scan refuses a cwd-relative literal by design, so those pins were
 * unscheduled and a rename reached `main` before the pinning suite ran.
 *
 * `nativeLiteralPinEdges` derives supplemental edges from those literals.
 * This file proves four things: the rule on a small fixture tree, the
 * selection through the real selector and manifest, that the edges only ADD
 * (lanes, escalation and related paths unchanged), and, independently of the
 * derivation, that no scripts test naming a native file by literal is left
 * unselected for it.
 *
 * NOT covered, deliberately: paths built from several segments, template
 * literals with substitutions, and tests outside `scripts/__tests__`.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  listSuiteFiles,
  NATIVE_LITERAL_ROOTS,
  scanNativeLiteralPins,
} from '../lib/path-read-pin-scan.mjs';
import { selectChangedVerification } from '../run-changed-verification.mjs';
import {
  buildTestImpactManifest,
  E2E_CONTRACT_BOUNDARIES,
  nativeLiteralPinEdges,
  TEST_IMPACT_MANIFEST,
  validateTestImpactManifest,
} from '../test-impact-manifest.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const native = nativeLiteralPinEdges({ root: ROOT });
const built = buildTestImpactManifest({ root: ROOT });
// The same manifest without the native edges, to prove they only add.
const withoutNative = built.filter((edge) => !native.includes(edge));

function selectedTests(paths: string[], manifest: unknown = built): string[] {
  return selectChangedVerification(paths, manifest as never)
    .tests.map(({ path }: { path: string }) => path)
    .sort();
}

const makeTempDir = trackTempDirs();

function fixtureTree(files: Record<string, string>): string {
  const dir = makeTempDir('native-literal-pin-');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe('the literal rule, on a fixture tree', () => {
  const makeRoot = () =>
    fixtureTree({
      'src-desktop/src/lib.rs': '',
      'src-desktop/app.ts': '',
      'src-desktop/gen/schemas/desktop-schema.json': '{}',
      'tests/ios-runtime-smoke/Smoke.swift': '',
      'scripts/templates/ios/Launch.storyboard': '',
      'docs/readme.md': '',
      'scripts/__tests__/pins.test.ts': [
        "const named = 'src-desktop/src/lib.rs';",
        'const swift = `tests/ios-runtime-smoke/Smoke.swift`;',
        "const template = 'scripts/templates/ios/Launch.storyboard';",
        "const missing = 'src-desktop/src/missing.rs';",
        "const module = 'src-desktop/app.ts';",
        "const outside = 'docs/readme.md';",
        "const generated = 'src-desktop/gen/schemas/desktop-schema.json';",
        'const substituted = `src-desktop/${platform}/lib.rs`;',
        "const joined = join('src-desktop', 'src', 'lib.rs');",
        "const sentence = 'reads src-desktop/src/lib.rs now';",
        "// 'src-desktop/commented.rs'",
      ].join('\n'),
    });

  it('reports a literal that names an existing native file under a root', () => {
    const root = makeRoot();
    expect(scanNativeLiteralPins({ root })).toEqual([
      {
        test: 'scripts/__tests__/pins.test.ts',
        pins: [
          'scripts/templates/ios/Launch.storyboard',
          'src-desktop/src/lib.rs',
          'tests/ios-runtime-smoke/Smoke.swift',
        ],
      },
    ]);
  });

  it('reports nothing for a missing path', () => {
    const root = makeRoot();
    expect(
      scanNativeLiteralPins({ root }).flatMap(({ pins }) => pins),
    ).not.toContain('src-desktop/src/missing.rs');
  });

  it('reports nothing for a JS or TS module', () => {
    const root = makeRoot();
    expect(
      scanNativeLiteralPins({ root }).flatMap(({ pins }) => pins),
    ).not.toContain('src-desktop/app.ts');
  });

  it('reports nothing for a path outside the pinned roots or in a generated tree', () => {
    const root = makeRoot();
    const pins = scanNativeLiteralPins({ root }).flatMap(({ pins: p }) => p);
    expect(pins).not.toContain('docs/readme.md');
    expect(pins).not.toContain('src-desktop/gen/schemas/desktop-schema.json');
  });

  it('reports nothing for a substituted template, a joined path, a sentence, or a comment', () => {
    const root = makeRoot();
    // Each of these would name `lib.rs` or a missing file if it were read as
    // a path, so the only pins are the three whole-value literals above.
    const [entry] = scanNativeLiteralPins({ root });
    expect(entry.pins).toHaveLength(3);
  });

  it('turns each root into an edge that is supplemental and tests-only', () => {
    const root = makeRoot();
    const edges = nativeLiteralPinEdges({
      root,
      nativeEntries: scanNativeLiteralPins({ root }),
    });
    expect(edges.map(({ pattern }) => pattern)).toEqual([
      'scripts/templates/ios/Launch.storyboard',
      'src-desktop/src/lib.rs',
      'tests/ios-runtime-smoke/Smoke.swift',
    ]);
    for (const edge of edges) {
      expect(edge.supplemental, edge.pattern).toBe(true);
      expect(edge.tests, edge.pattern).toEqual([
        'scripts/__tests__/pins.test.ts',
      ]);
      expect(edge.related).toBeUndefined();
      expect(edge.lanes).toBeUndefined();
    }
    expect(NATIVE_LITERAL_ROOTS).toEqual([
      'src-desktop/',
      'tests/ios-runtime-smoke/',
      'scripts/templates/',
      'Dockerfile',
      'docker-compose',
      'deployment/',
    ]);
  });
});

describe('selection through the real selector and manifest', () => {
  it.each([
    [
      'src-desktop/src/lib.rs',
      'scripts/__tests__/native-client-origin-header-contract.test.ts',
    ],
    [
      'src-desktop/tauri.conf.json',
      'scripts/__tests__/native-platform-boundary.test.ts',
    ],
    [
      'src-desktop/Info.nightly.plist',
      'scripts/__tests__/nightly-macos-install.test.ts',
    ],
    [
      'src-desktop/gen/android/app/src/main/AndroidManifest.xml',
      'scripts/__tests__/android-pairing-scheme.test.ts',
    ],
    [
      'tests/ios-runtime-smoke/StationRuntimeSmokeTests.swift',
      'scripts/__tests__/classify-ci-change.test.ts',
    ],
    [
      'scripts/templates/ios/LaunchScreen.storyboard',
      'scripts/__tests__/ios-launch-screen.test.ts',
    ],
  ])('a change to %s selects the test that names it', (path, named) => {
    const edge = native.find(({ pattern }) => pattern === path);
    expect(edge, `no derived edge for ${path}`).toBeDefined();
    expect(edge?.tests).toContain(named);
    expect(selectedTests([path])).toContain(named);
    expect(selectedTests([path], withoutNative)).not.toContain(named);
    // Every test the derivation names is selected, not just the pinned one.
    for (const test of edge?.tests ?? [])
      expect(selectedTests([path]), `${path} -> ${test}`).toContain(test);
  });

  it('still reports the verify-local deferral and changes nothing else', () => {
    for (const edge of native) {
      const before = selectChangedVerification(
        [edge.pattern],
        withoutNative as never,
      );
      const after = selectChangedVerification([edge.pattern], built as never);
      expect(after.lanes, edge.pattern).toEqual(before.lanes);
      expect(after.relatedPaths, edge.pattern).toEqual(before.relatedPaths);
      expect(after.escalated, edge.pattern).toBe(before.escalated);
      const kept = new Set(
        after.tests.map(({ path }: { path: string }) => path),
      );
      for (const { path } of before.tests)
        expect(kept.has(path), `${edge.pattern} lost ${path}`).toBe(true);
    }
    const lanes = selectChangedVerification(
      ['src-desktop/src/lib.rs'],
      built as never,
    ).lanes.map(({ id }: { id: string }) => id);
    expect(lanes).toContain('verify-local');
  });

  it('selects nothing extra for a native path no test names', () => {
    // Built from segments: a whole-value literal here would name it itself.
    const unnamed = [
      'src-desktop',
      'capabilities',
      'android-discovery.json',
    ].join('/');
    expect(statSync(join(ROOT, unnamed)).isFile()).toBe(true);
    expect(native.some(({ pattern }) => pattern === unnamed)).toBe(false);
    expect(selectedTests([unnamed])).toEqual(
      selectedTests([unnamed], withoutNative),
    );
  });
});

describe('composition with the manifest', () => {
  it('keeps the manifest valid and appends the derived edges', () => {
    expect(validateTestImpactManifest(built as never)).toEqual([]);
    expect(built.slice(0, TEST_IMPACT_MANIFEST.length)).toEqual(
      TEST_IMPACT_MANIFEST,
    );
    for (const edge of native) {
      expect(edge.supplemental, edge.pattern).toBe(true);
      expect(edge.tests?.length, edge.pattern).toBeGreaterThan(0);
      expect(edge.lanes, edge.pattern).toBeUndefined();
      expect(edge.related, edge.pattern).toBeUndefined();
    }
  });

  it('derives no edge for a pattern the validator requires to be unique', () => {
    for (const pattern of E2E_CONTRACT_BOUNDARIES)
      expect(
        nativeLiteralPinEdges({
          root: ROOT,
          nativeEntries: [
            {
              test: 'scripts/__tests__/verification-lanes.test.ts',
              pins: [pattern],
            },
          ],
        }),
        pattern,
      ).toEqual([]);
  });

  it('stays bounded: generated trees cannot explode the edge count', () => {
    // Today 60 edges, 38 tests, largest fan-out 16. The ceilings leave room to
    // grow and fail on a runaway such as a scan that swallows a generated tree.
    expect(native.length).toBeGreaterThan(20);
    expect(native.length).toBeLessThan(200);
    expect(
      new Set(native.flatMap(({ tests }) => tests ?? [])).size,
    ).toBeLessThan(120);
    for (const edge of native)
      expect(edge.tests?.length, edge.pattern).toBeLessThan(40);
    for (const edge of native)
      expect(edge.pattern, 'generated tree').not.toMatch(
        /\/(?:target|node_modules|binaries)\/|gen\/schemas\//,
      );
  });
});

describe('completeness, discovered independently of the derivation', () => {
  /** Whole-value quoted literals in test text, with comment lines dropped. */
  function literalsIn(source: string): string[] {
    const text = source
      .split('\n')
      .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
      .join('\n');
    // A quote inside a longer literal (`hashFiles('src-desktop/Cargo.lock')`)
    // is not a whole-value literal: skip a match with an odd count of the
    // other quote kinds before it on its line.
    return [...text.matchAll(/(['"`])([^'"`\n$\\]+)\1/g)]
      .filter((m) => {
        const before = text.slice(text.lastIndexOf('\n', m.index) + 1, m.index);
        return ['"', "'", '`'].every(
          (quote) => quote === m[1] || before.split(quote).length % 2 === 1,
        );
      })
      .map((m) => m[2]);
  }
  const roots = [
    'src-desktop/',
    'tests/ios-runtime-smoke/',
    'scripts/templates/',
    'Dockerfile',
    'docker-compose',
    'deployment/',
  ];
  const generated =
    /(^|\/)(target|node_modules|binaries)\/|^src-desktop\/gen\/schemas\//;
  const isFile = (path: string) => {
    try {
      return statSync(join(ROOT, path)).isFile();
    } catch {
      return false;
    }
  };

  it('selects every test that names a native file for that file', () => {
    const pairs: [string, string][] = [];
    // `tests/` suites cannot run in a pull-request shard, so no edge names them.
    for (const test of listSuiteFiles(ROOT, [
      'packages',
      'scripts',
      'src-server',
      'src-ui',
    ]))
      for (const literal of new Set(
        literalsIn(readFileSync(join(ROOT, test), 'utf8')),
      ))
        if (
          roots.some((root) => literal.startsWith(root)) &&
          !/\.[cm]?[jt]sx?$/.test(literal) &&
          !generated.test(literal) &&
          isFile(literal)
        )
          pairs.push([test, literal]);
    // The scan is doing real work: an empty discovery would pass vacuously.
    expect(pairs.length).toBeGreaterThan(40);
    const missing = pairs
      .filter(([test, path]) => !selectedTests([path]).includes(test))
      .map(([test, path]) => `${path} is named by ${test} but not selected`);
    expect(missing).toEqual([]);
  });
});
