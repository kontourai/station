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
 * 2. ADDITIONS ONLY, IN THE SELECTOR'S RETURN VALUE. For every pinned path
 *    the lanes, related paths, and escalation flag are byte-identical and
 *    only the test list grows. This matters because of the #1563/#1613 hazard
 *    in `selectChangedVerification` — an ordinary edge that names `tests`
 *    sets `hasExplicitBoundary`, which SUPPRESSES the generic `related` edge
 *    for the same path and cancels the `ci-fast` escalation an escalation
 *    path is entitled to. A pin edge built that way would trade the whole
 *    related suite for one pinning test: a narrowing dressed as a fix.
 *    `supplemental` is what prevents it.
 *
 *    A larger selection is not automatically a larger RUN, and this file says
 *    so where it can: a scheduled test that Vitest refuses, or that fails the
 *    resource-classification preflight, converts the addition into a receipt
 *    naming a target that never ran, or into a red gate. Both are asserted
 *    below against `packages/cli/src/cli.ts`, the path where it happened.
 *
 * WHAT THIS GATE DOES NOT COVER. The scan is a partial derivation: 143 test
 * files read by path with a module anchor and it reports 80. Both figures are
 * derived and asserted below, so the fraction cannot go stale in prose. A pin
 * reached through a helper parameter (`const read = (p) =>
 * readFileSync(join(UI_SRC, p))`, at least 14 files, hiding
 * `ChatDockHeader.tsx`, `DockShell.tsx` and `ProjectLayoutRenderer.tsx`) or
 * written as a cwd-relative literal is not seen at all. A green run here is
 * evidence about the pins the scanner reports, not about the class;
 * `path-read-pin-scan.mjs` carries the full statement of the gap.
 *
 * A Playwright pin under `tests/` is SEEN and existence-checked but never
 * scheduled — Vitest excludes `tests/**` and the specs are not in the
 * resource manifest. Scheduling them is #1817.
 *
 * The scanner's own rules are exercised against literal sources so that the
 * repository-wide assertions above cannot be the only thing holding them up.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  invertPathReadPins,
  listSuiteFiles,
  readsFileByPath,
  scanPathReadPins,
  scanPathReadPinsInSource,
} from '../lib/path-read-pin-scan.mjs';
import { selectChangedVerification } from '../run-changed-verification.mjs';
import {
  buildTestImpactManifest,
  E2E_CONTRACT_BOUNDARIES,
  PATH_READ_PIN_BOUNDARY_TEST,
  pathReadPinEdges,
  TAILSCALE_PUBLIC_INGRESS_IMPACT_BOUNDARY,
  TEST_IMPACT_MANIFEST,
  validateTestImpactManifest,
} from '../test-impact-manifest.mjs';
import { partitionVitestResourceSubset } from '../vitest-resource-manifest.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const entries = scanPathReadPins({ root: ROOT });
const pins = invertPathReadPins(entries);
const derived = pathReadPinEdges({ root: ROOT });

/**
 * The disclosure fraction, re-measure and update BOTH docblocks when this
 * reds. `PATH_READING_SUITES` counts suites the scanner could in principle
 * resolve a pin in; `REPORTED_SUITES` counts the ones it does.
 */
const PATH_READING_SUITES = 143;
const REPORTED_SUITES = 80;

/** The two Playwright pins: seen and existence-checked, never scheduled. */
const E2E_PINS = Object.freeze([
  {
    pin: 'packages/cli/src/cli.ts',
    spec: 'tests/plugin-dev-hot-reload.spec.ts',
  },
  {
    pin: 'src-ui/src/app-shell/destination-registry.ts',
    spec: 'tests/mobile-surface-sweep.spec.ts',
  },
]);

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
    // The whole story in one fixture. #1785 moved the outbound-queue call
    // out of `ChatDock.tsx` into `useConversationBoundaryDialogs.ts`; this
    // test's pin still read `ChatDock.tsx`, went red on `main`, and nobody's
    // pull request selected it because a path read has no import edge. #1808
    // fixed it forward by repointing the pin at the hook — which is where it
    // reads today, and why this fixture names that file rather than the dock.
    // Had this gate existed, the move would have scheduled the pin at
    // fast-checks instead.
    const outboundQueuePin = pins.find(
      ({ pin }) =>
        pin ===
        'src-ui/src/components/chat-dock/useConversationBoundaryDialogs.ts',
    );
    expect(outboundQueuePin?.tests).toContain(
      'src-ui/src/__tests__/useOutboundQueueSnapshot.test.tsx',
    );
  });

  it('states the coverage fraction it actually has', () => {
    // A count-ratchet reason string goes stale silently; this one cannot.
    // Both docblocks quote these figures and both are checked against the
    // live derivation.
    const reading = listSuiteFiles(ROOT).filter((file) =>
      readsFileByPath(readFileSync(join(ROOT, file), 'utf8')),
    );
    expect(
      reading.length,
      'suites that read by path moved: re-measure and update the WHAT THIS ' +
        'DOES NOT SEE paragraph in path-read-pin-scan.mjs and this file',
    ).toBe(PATH_READING_SUITES);
    expect(
      entries.length,
      'reported pinning suites moved: same paragraphs',
    ).toBe(REPORTED_SUITES);
    const disclosure = readFileSync(
      join(ROOT, 'scripts/lib/path-read-pin-scan.mjs'),
      'utf8',
    );
    expect(disclosure).toContain(
      `${PATH_READING_SUITES} test files read by path`,
    );
    expect(disclosure).toContain(`this reports ${REPORTED_SUITES}`);
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(self).toContain(
      `${PATH_READING_SUITES} test\n * files read by path`,
    );
    expect(self).toContain(`it reports ${REPORTED_SUITES}`);
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
      expect(edge.tests?.length ?? 0, edge.pattern).toBeGreaterThan(0);
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

  it('adds every schedulable pinning test for every pin', () => {
    for (const { pin, tests } of pins) {
      const selected = selectedTests([pin], built);
      for (const test of tests) {
        // A `tests/` spec is deliberately omitted (#1817); everything Vitest
        // can run must be there.
        if (test.startsWith('tests/')) {
          expect(selected, `${pin} -> ${test}`).not.toContain(test);
          continue;
        }
        expect(selected, pin).toContain(test);
      }
    }
  });

  it('selects the pinning test and this gate for a pinned path', () => {
    // Touching the hook #1785 moved the call into must schedule the pin that
    // reads it (#1808 repointed that pin), and must not have done so before.
    const hook =
      'src-ui/src/components/chat-dock/useConversationBoundaryDialogs.ts';
    const after = selectedTests([hook], built);
    expect(after).toContain(
      'src-ui/src/__tests__/useOutboundQueueSnapshot.test.tsx',
    );
    expect(after).toContain(PATH_READ_PIN_BOUNDARY_TEST);
    expect(selectedTests([hook])).not.toContain(
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

describe('a scheduled pin has to be runnable', () => {
  const built = buildTestImpactManifest({ root: ROOT });

  it('never schedules a Playwright spec', () => {
    // `selection.tests` is handed to Vitest, which excludes `tests/**`, so a
    // spec here is a target the receipt names and nothing runs.
    for (const edge of derived)
      for (const test of edge.tests ?? [])
        expect(test.startsWith('tests/'), `${edge.pattern} -> ${test}`).toBe(
          false,
        );
  });

  it('still existence-checks the pins only a Playwright spec makes', () => {
    // Not scheduling them is the trade; not SEEING them would give up the
    // property #1807 exists for. If `cli.ts` or `destination-registry.ts`
    // moves, the boundary gate reds at fast-checks instead of the spec
    // breaking at e2e time.
    for (const { pin, spec } of E2E_PINS) {
      const found = pins.find((entry: { pin: string }) => entry.pin === pin);
      expect(found?.tests, pin).toContain(spec);
      expect(
        entries.some(({ test }: { test: string }) => test === spec),
        spec,
      ).toBe(true);
    }
  });

  it('drops a Playwright pin rather than scheduling it', () => {
    // Known-bad: hand the derivation a scan entry naming a spec. The pin has
    // one pinning test and it is ineligible, so no edge is produced at all.
    const edges = pathReadPinEdges({
      root: ROOT,
      entries: [
        {
          test: 'tests/plugin-dev-hot-reload.spec.ts',
          pins: ['packages/cli/src/cli.ts'],
        },
        {
          test: 'src-ui/src/__tests__/useOutboundQueueSnapshot.test.tsx',
          pins: ['packages/cli/src/cli.ts'],
        },
      ],
    });
    expect(edges).toHaveLength(1);
    expect(edges[0].tests).toEqual([
      PATH_READ_PIN_BOUNDARY_TEST,
      'src-ui/src/__tests__/useOutboundQueueSnapshot.test.tsx',
    ]);
    expect(
      pathReadPinEdges({
        root: ROOT,
        entries: [
          {
            test: 'tests/plugin-dev-hot-reload.spec.ts',
            pins: ['packages/cli/src/cli.ts'],
          },
        ],
      }),
    ).toEqual([]);
  });

  it('leaves packages/cli/src/cli.ts selecting a runnable set', () => {
    // The live break: `tests/plugin-dev-hot-reload.spec.ts` imports
    // `node:child_process` and no Playwright spec is in the Vitest resource
    // manifest, so the resource plan raised an infrastructure error and
    // `run-ci-fast` (which tolerates only exit 3) went red for every pull
    // request touching this file.
    const selected = selectedTests(['packages/cli/src/cli.ts'], built);
    expect(selected.length).toBeGreaterThan(0);
    expect(() =>
      partitionVitestResourceSubset(selected, { root: ROOT }),
    ).not.toThrow();
  });

  it('keeps every scheduled pin inside the Vitest resource plan', () => {
    const scheduled = [
      ...new Set(derived.flatMap((edge) => [...(edge.tests ?? [])])),
    ].sort();
    expect(() =>
      partitionVitestResourceSubset(scheduled, { root: ROOT }),
    ).not.toThrow();
  });

  it('pins the boundary test path itself', () => {
    // Every derived edge names this constant. Existence alone is too weak: a
    // rename that repoints it at any other existing test passes while all 108
    // pins schedule the wrong file. If it points nowhere,
    // `escalateUnavailableExplicitTests` escalates every pinned path to
    // `test-full`, which nobody reads as a defect.
    expect(
      PATH_READ_PIN_BOUNDARY_TEST,
      'PATH_READ_PIN_BOUNDARY_TEST in scripts/test-impact-manifest.mjs must ' +
        'name this file; every derived pin edge schedules it',
    ).toBe(
      fileURLToPath(import.meta.url)
        .slice(ROOT.length)
        .replace(/\\/g, '/')
        .replace(/^\//, ''),
    );
    expect(existsSync(join(ROOT, PATH_READ_PIN_BOUNDARY_TEST))).toBe(true);
  });
});

describe('the derivation cannot produce an invalid manifest', () => {
  const uniquePatterns = [
    ...E2E_CONTRACT_BOUNDARIES,
    TAILSCALE_PUBLIC_INGRESS_IMPACT_BOUNDARY.pattern,
  ];

  it('derives no edge for a pattern the validator requires to be unique', () => {
    for (const pattern of uniquePatterns) {
      const entries = [
        {
          test: 'scripts/__tests__/verification-lanes.test.ts',
          pins: [pattern],
        },
      ];
      expect(pathReadPinEdges({ root: ROOT, entries }), pattern).toEqual([]);
      expect(
        validateTestImpactManifest(
          buildTestImpactManifest({ root: ROOT, entries }),
        ),
        pattern,
      ).toEqual([]);
    }
  });

  it('known-bad: the naive edge for those patterns is rejected', () => {
    // Proves the skip is load-bearing. Without it the validator throws inside
    // `selectChangedVerification`, failing the whole gate and naming the E2E
    // contract edge rather than the test that added the read call.
    for (const pattern of uniquePatterns) {
      const naive = [
        ...TEST_IMPACT_MANIFEST,
        { pattern, supplemental: true, tests: ['scripts/__tests__/x.test.ts'] },
      ] as never;
      expect(validateTestImpactManifest(naive).join(' '), pattern).toContain(
        pattern,
      );
      expect(() => selectChangedVerification([pattern], naive)).toThrow(
        /impact manifest invalid/,
      );
    }
  });

  it('skips every committed pattern a uniqueness rule protects', () => {
    // The skip set and the validator's uniqueness rules are two hand-written
    // lists; iterating the same two constants the skip set is built from
    // cannot notice a NEW uniqueness rule keyed on some other pattern, which
    // would reintroduce the throw in full. Derive the property instead: add a
    // supplemental duplicate for every committed pattern and see which ones
    // the validator refuses.
    const patterns = [
      ...new Set(
        TEST_IMPACT_MANIFEST.map(({ pattern }: { pattern: string }) => pattern),
      ),
    ].sort();
    const refused = patterns.filter(
      (pattern) =>
        validateTestImpactManifest([
          ...TEST_IMPACT_MANIFEST,
          {
            pattern,
            supplemental: true,
            tests: ['scripts/__tests__/x.test.ts'],
          },
        ] as never).length > 0,
    );
    expect(refused.sort()).toEqual([...uniquePatterns].sort());
    for (const pattern of refused)
      expect(
        pathReadPinEdges({
          root: ROOT,
          entries: [
            {
              test: 'scripts/__tests__/verification-lanes.test.ts',
              pins: [pattern],
            },
          ],
        }),
        `${pattern} is refused by the validator but not skipped`,
      ).toEqual([]);
  });

  it('validates the live derived manifest', () => {
    expect(
      validateTestImpactManifest(buildTestImpactManifest({ root: ROOT })),
    ).toEqual([]);
  });

  it('known-bad: a supplemental edge carrying lanes or related is rejected', () => {
    // scripts/AGENTS.md: new policy needs a known-bad catch test and a
    // false-positive control. Both shapes would be silently ignored by
    // `selectChangedVerification`, so a reader would believe a lane was
    // scheduled that never was.
    const base = {
      pattern: 'src-ui/src/App.tsx',
      supplemental: true,
      tests: ['scripts/__tests__/x.test.ts'],
    };
    const withEdge = (edge: unknown) =>
      validateTestImpactManifest([...TEST_IMPACT_MANIFEST, edge] as never);
    const rejection =
      'supplemental impact edge may only add tests: src-ui/src/App.tsx';
    expect(withEdge({ ...base, lanes: ['ci-fast'] })).toEqual([rejection]);
    expect(withEdge({ ...base, related: true })).toEqual([rejection]);
    // False-positive controls: the tests-only supplemental edge, and an
    // ORDINARY edge carrying exactly those fields, are both accepted.
    expect(withEdge(base)).toEqual([]);
    expect(
      withEdge({
        pattern: base.pattern,
        related: true,
        lanes: ['ci-fast'],
        tests: base.tests,
      }),
    ).toEqual([]);
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

  it('does not pin a generated or gitignored path', () => {
    // A pin is reported whether or not its target exists, so a resolved path
    // under a generated root would pass for whoever built it and red the
    // existence gate on a clean checkout — with a message telling the reader
    // to chase a rename that never happened.
    const generated = [
      "readFileSync(join(__dirname, '..', '..', '..', 'dist-ui', 'index.html'));",
      "readFileSync(join(__dirname, '..', '..', '..', 'dist-server-nightly', 'x.mjs'));",
      "readFileSync(join(__dirname, '..', '..', '..', 'src-desktop', 'gen', 'schemas', 'd.json'));",
      "readFileSync(join(__dirname, '..', '..', '..', '.kontourai', 'verification-output', 'x.json'));",
      "readFileSync(join(__dirname, '..', '..', '..', 'playwright-report', 'index.html'));",
      "readFileSync(join(__dirname, '..', '..', '..', 'packages', 'basis-pane', 'src', 'app.generated.ts'));",
      "readFileSync(join(__dirname, '..', '..', '..', '.station-dependency-install', 'x.json'));",
    ];
    for (const source of generated) expect(scan(source), source).toEqual([]);
    // False-positive controls. `.gitignore` generates only
    // `packages/basis-pane/src/*.generated.ts` and only `src-desktop/gen/
    // schemas/`; widening either drops TRACKED files, and a dropped pin loses
    // its edge and its existence check together, silently.
    expect(scan("readFileSync(join(__dirname, '..', 'App.tsx'));")).toEqual([
      'src-ui/src/App.tsx',
    ]);
    expect(
      scan(
        "readFileSync(join(__dirname, '..', '..', '..', 'packages', 'shared', 'src', 'channel-ports.generated.ts'));",
      ),
    ).toEqual(['packages/shared/src/channel-ports.generated.ts']);
    expect(
      scan(
        "readFileSync(join(__dirname, '..', '..', '..', 'src-desktop', 'gen', 'android', 'app', 'build.gradle.kts'));",
      ),
    ).toEqual(['src-desktop/gen/android/app/build.gradle.kts']);
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
