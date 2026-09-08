/**
 * The path-read pin boundary (#1807).
 *
 * A test that reads a source file's TEXT
 * (`readFileSync(join(__dirname, ...))`) has no import edge to that file, so
 * `vitest related` cannot see it and the changed-verification selector fell
 * through to a boundary that never named the pin. #1785 moved
 * `useOutboundQueueSnapshot(...)` out of `ChatDock.tsx`; the pin went red on
 * `main` and nobody's pull request selected it.
 *
 * Two properties are proved here.
 *
 * 1. EXISTENCE. Every pin the scanner finds names a file that is on disk.
 *    A rename or delete of a pinned file reds this test, naming the pinning
 *    test and the path it can no longer read — instead of surfacing as a
 *    broad selection on somebody else's pull request days later.
 * 2. ADDITIONS ONLY. The derived edges never shrink what selection already
 *    produced: for every pinned path the lanes, related paths, and escalation
 *    flag are byte-identical and only the test list grows. This matters
 *    because of the #1563/#1613 hazard in `selectChangedVerification` — an
 *    ordinary edge that names `tests` sets `hasExplicitBoundary`, which
 *    SUPPRESSES the generic `related` edge for the same path and cancels the
 *    `ci-fast` escalation an escalation path is entitled to. A pin edge built
 *    that way would trade the whole related suite for one pinning test: a
 *    narrowing dressed as a fix. `supplemental` is what prevents it.
 *
 * The scanner's own rules are exercised against literal sources so that the
 * repository-wide assertions above cannot be the only thing holding them up.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  invertPathReadPins,
  scanPathReadPins,
  scanPathReadPinsInSource,
} from '../lib/path-read-pin-scan.mjs';
import { selectChangedVerification } from '../run-changed-verification.mjs';
import {
  buildTestImpactManifest,
  PATH_READ_PIN_BOUNDARY_TEST,
  pathReadPinEdges,
  TEST_IMPACT_MANIFEST,
} from '../test-impact-manifest.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const entries = scanPathReadPins({ root: ROOT });
const pins = invertPathReadPins(entries);
const derived = pathReadPinEdges({ root: ROOT });

function selectedTests(paths: string[], manifest?: unknown): string[] {
  return selectChangedVerification(paths, manifest as never)
    .tests.map(({ path }: { path: string }) => path)
    .sort();
}

describe('path-read pins are discovered', () => {
  it('finds pins across the repository', () => {
    // A near-empty result means the scanner stopped resolving, not that the
    // repository stopped pinning. The floor is far below today's count so it
    // does not become a number people raise.
    expect(pins.length).toBeGreaterThan(40);
    expect(entries.length).toBeGreaterThan(20);
  });

  it('finds the pin whose silent break motivated this gate', () => {
    const dockPin = pins.find(
      ({ pin }) => pin === 'src-ui/src/components/chat-dock/ChatDock.tsx',
    );
    expect(dockPin?.tests).toContain(
      'src-ui/src/__tests__/useOutboundQueueSnapshot.test.tsx',
    );
  });

  it('finds a pin the read call site alone cannot resolve', () => {
    // `conversationContextBoundaryStatusCache.test.tsx` reads
    // `[join(...), join(...)].map((path) => readFileSync(path))`, so the
    // argument at the read is a callback parameter and names nothing.
    const dialogsPin = pins.find(
      ({ pin }) =>
        pin ===
        'src-ui/src/components/chat-dock/useConversationBoundaryDialogs.ts',
    );
    expect(dialogsPin?.tests).toContain(
      'src-ui/src/__tests__/conversationContextBoundaryStatusCache.test.tsx',
    );
  });
});

describe('every pinned path still exists', () => {
  it('names the pinning test and the path when a pin is broken', () => {
    const broken = pins
      .filter(({ pin }) => !existsSync(join(ROOT, pin)))
      .map(({ pin, tests }) => `${pin} — pinned by ${tests.join(', ')}`);
    expect(
      broken,
      'A test reads these paths as text and they are not on disk. Either the ' +
        'file moved and the pin must follow it, or the pin is stale and must ' +
        'be deleted. Do not silence this by loosening the scanner.',
    ).toEqual([]);
  });
});

describe('derived pin edges only add to selection', () => {
  const built = buildTestImpactManifest({ root: ROOT });

  it('supplements the committed manifest rather than replacing it', () => {
    expect(built.slice(0, TEST_IMPACT_MANIFEST.length)).toEqual(
      TEST_IMPACT_MANIFEST,
    );
    expect(built.length).toBe(TEST_IMPACT_MANIFEST.length + derived.length);
    expect(derived.length).toBeGreaterThan(40);
  });

  it('declares every derived edge supplemental and tests-only', () => {
    // `supplemental` is the whole reason these edges cannot narrow anything:
    // `selectChangedVerification` excludes them from the boundary,
    // escalation, and related decisions. An edge carrying `lanes` or
    // `related` would re-enter those decisions.
    for (const edge of derived) {
      expect(edge.supplemental, edge.pattern).toBe(true);
      expect(edge.related, edge.pattern).toBeUndefined();
      expect(edge.lanes, edge.pattern).toBeUndefined();
      expect(edge.tests.length, edge.pattern).toBeGreaterThan(0);
      expect(edge.tests, edge.pattern).toContain(PATH_READ_PIN_BOUNDARY_TEST);
    }
  });

  it('leaves lanes, related paths, and escalation exactly as they were', () => {
    for (const { pattern } of derived) {
      const before = selectChangedVerification([pattern]);
      const after = selectChangedVerification([pattern], built as never);
      expect(after.lanes, pattern).toEqual(before.lanes);
      expect(after.relatedPaths, pattern).toEqual(before.relatedPaths);
      expect(after.escalated, pattern).toBe(before.escalated);
      expect(
        before.tests
          .map(({ path }: { path: string }) => path)
          .filter(
            (test: string) =>
              !after.tests.some(({ path }: { path: string }) => path === test),
          ),
        `selection for ${pattern} lost tests`,
      ).toEqual([]);
    }
  });

  it('adds the pinning test for every pin', () => {
    for (const { pin, tests } of pins) {
      const selected = selectedTests([pin], built);
      for (const test of tests) expect(selected, pin).toContain(test);
    }
  });

  it('selects the pinning test and this gate for a pinned path', () => {
    const dock = 'src-ui/src/components/chat-dock/ChatDock.tsx';
    const after = selectedTests([dock], built);
    expect(after).toContain(
      'src-ui/src/__tests__/useOutboundQueueSnapshot.test.tsx',
    );
    expect(after).toContain(PATH_READ_PIN_BOUNDARY_TEST);
    expect(selectedTests([dock])).not.toContain(
      'src-ui/src/__tests__/useOutboundQueueSnapshot.test.tsx',
    );
  });

  it('keeps a supplemental edge from cancelling an escalation', () => {
    // `vitest.global-setup.ts` escalates (it matches `isEscalationPath` and
    // no committed edge names it) and a test also pins it. Without the
    // supplemental exclusion its pin edge would set `hasExplicitBoundary` and
    // trade `ci-fast` for one focused test.
    const path = 'vitest.global-setup.ts';
    expect(pins.map(({ pin }) => pin)).toContain(path);
    expect(selectChangedVerification([path]).escalated).toBe(true);
    const selection = selectChangedVerification([path], built as never);
    expect(selection.escalated).toBe(true);
    expect(selection.lanes.map(({ id }: { id: string }) => id)).toContain(
      'ci-fast',
    );
    // ...and the pin is still named, on top of the escalation.
    expect(
      selection.tests.map(({ path: test }: { path: string }) => test),
    ).toContain('scripts/__tests__/vitest-teardown-race.test.ts');
  });
});

describe('the scanner resolves only what it can justify', () => {
  const scan = (source: string, repoPath = 'src-ui/src/__tests__/x.test.ts') =>
    scanPathReadPinsInSource(source, { repoPath, root: ROOT });

  it('resolves a module-anchored read', () => {
    expect(
      scan(
        "import { readFileSync } from 'node:fs';\n" +
          "readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8');\n",
      ),
    ).toEqual(['src-ui/src/App.tsx']);
  });

  it('resolves through a const and a file URL', () => {
    expect(
      scan(
        'const ROOT = dirname(fileURLToPath(import.meta.url));\n' +
          "const target = join(ROOT, '..', 'main.tsx');\n" +
          'readFileSync(target);\n',
      ),
    ).toEqual(['src-ui/src/main.tsx']);
  });

  it('resolves a path written inside a template interpolation', () => {
    expect(
      scan(
        'readFileSync(__filename);\n' +
          "const entry = `export * from ${JSON.stringify(join(__dirname, '..', 'App.tsx'))};`;\n",
      ),
    ).toEqual(['src-ui/src/App.tsx']);
  });

  it('refuses a path that is not anchored to the module', () => {
    // `resolve('src-ui/src/App.tsx')` is relative to the process cwd, which
    // is not a repository fact.
    expect(
      scan(
        "readFileSync(resolve('src-ui/src/App.tsx'));\n" +
          "readFileSync(join(tmpdir(), 'App.tsx'));\n",
      ),
    ).toEqual([]);
  });

  it('refuses an expression it cannot fully resolve', () => {
    expect(
      scan(
        "readFileSync(join(__dirname, computeName()), 'utf8');\n" +
          'readFileSync(somethingElse);\n',
      ),
    ).toEqual([]);
  });

  it('does not pin a file the test itself creates', () => {
    // False-positive control: a planted negative control resolves exactly
    // like a pin but is the test's own output.
    expect(
      scan(
        "const planted = join(__dirname, '..', '__planted__.ts');\n" +
          "readFileSync(planted, 'utf8');\n" +
          "writeFileSync(planted, 'x');\n",
      ),
    ).toEqual([]);
  });

  it('still pins the source of a symlink it creates', () => {
    expect(
      scan(
        'readFileSync(__filename);\n' +
          "symlinkSync(join(__dirname, '..', 'App.tsx'), join(__dirname, 'link.ts'));\n",
      ),
    ).toEqual(['src-ui/src/App.tsx']);
  });

  it('does not pin a synthesized extensionless location', () => {
    // False-positive control: an extensionless path that is not on disk is a
    // location handed to a resolver, not a file that could have been renamed.
    expect(
      scan(
        'readFileSync(__filename);\n' +
          "const nested = join(__dirname, '..', '..', '..', 'examples', 'no-such-plugin');\n" +
          'hostWorkspaceRootFor(nested);\n',
      ),
    ).toEqual([]);
  });

  it('pins an extensionless file that does exist', () => {
    expect(
      scan(
        'readFileSync(__filename);\n' +
          "const hook = join(__dirname, '..', '..', '..', '.githooks', 'commit-msg');\n" +
          'readFileSync(hook);\n',
      ),
    ).toEqual(['.githooks/commit-msg']);
  });

  it('ignores a file that never reads by path', () => {
    expect(
      scanPathReadPins({
        root: ROOT,
        testFiles: ['src-ui/src/__tests__/x.test.ts'],
        readSource: () => "import App from '../App';\nrender(<App />);\n",
      }),
    ).toEqual([]);
  });

  it('does not pin a fixture or the pinning file itself', () => {
    expect(
      scan(
        "readFileSync(join(__dirname, 'fixtures', 'sample.ts'), 'utf8');\n" +
          'readFileSync(__filename);\n',
      ),
    ).toEqual([]);
  });
});
