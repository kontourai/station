/**
 * Every gate `verify:static:raw` composes is accounted for by name.
 *
 * ## Why an exact-set assertion and not a grep
 *
 * The classification that motivated `guardrail-process-boundary.test.ts` was
 * a heuristic: "some test names this script inside a spawn call." Heuristics
 * drift in both directions — a loose one counted seven gates as executed that
 * were only ever *imported*, and a tight one dropped five that really are
 * spawned. A number produced that way is not a property anything computes.
 *
 * So this file does not re-run the heuristic. It derives the gate set from
 * the package-script graph and requires an exact partition: every gate is in
 * exactly one bucket, and every bucket entry is a real gate. A gate joining
 * `verify:static:raw` fails here until someone says how it is executed under
 * test — including by saying, with a reason, that it is not.
 *
 * That is the point. The defect this closes was never "a gate is untested";
 * it was that nothing anywhere could tell you which gates were.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** `docs:truth:gate`'s lanes, spawned by the aggregate runner via `npm run`. */
const DOCS_TRUTH_LANES = [
  'contribution:gate',
  'labels:check',
  'docs:issue-lifecycle:check',
  'docs:contributor-commands:check',
  'docs:public:hygiene',
  'docs:hygiene:repo',
  'docs:index:check',
  'docs:cli-parity:check',
  'docs:public:contract-examples',
  'docs:links:check',
];

/**
 * Walk the package-script graph from `verify:static:raw`, collecting every
 * `node`/`tsx scripts/*.mjs` invocation. `npm run <x>` recurses; anything
 * else is a leaf command.
 *
 * `docs:truth:gate` delegates to an aggregate runner that spawns its lanes
 * through `npm run`, so its lane scripts are seeded explicitly — they are
 * composed into this chain and the walk cannot see through the runner.
 */
function derivedGateScripts(): string[] {
  const scripts: Record<string, string> = JSON.parse(
    readFileSync('package.json', 'utf8'),
  ).scripts;
  const gates = new Set<string>();
  const seen = new Set<string>();
  const walk = (entry: string) => {
    if (seen.has(entry) || scripts[entry] === undefined) return;
    seen.add(entry);
    for (const segment of scripts[entry]
      .split(/&&|\|\||;|\n/)
      .map((part) => part.trim())
      .filter(Boolean)) {
      const nested = segment.match(/^npm run ([A-Za-z0-9:._-]+)/);
      if (nested) {
        walk(nested[1]);
        continue;
      }
      for (const match of segment.matchAll(
        /(?:^|\s)(?:node|tsx)\s+scripts\/([A-Za-z0-9._-]+\.(?:mjs|ts))/g,
      )) {
        gates.add(match[1]);
      }
    }
  };
  walk('verify:static:raw');
  for (const lane of DOCS_TRUTH_LANES) walk(lane);
  return [...gates].sort();
}

/**
 * Executed as a child process against a known-bad fixture tree AND a clean
 * control, in `guardrail-known-bad-fixtures.test.ts` (station#1555).
 */
const KNOWN_BAD_FIXTURES_SUITE = [
  'check-dist-freshness.mjs',
  'mobile-css-ratchet.mjs',
  'noun-consistency-gate.mjs',
  'shell-conformance-ratchet.mjs',
  'state-primitives-ratchet.mjs',
];

/** Same, in `guardrail-process-boundary.test.ts`. */
const PROCESS_BOUNDARY_FIXTURES = [
  'a11y-ratchet.mjs',
  'accent-foreground-ratchet.mjs',
  'builder-delivery-viewer-import-gate.mjs',
  'check-markdown-links.mjs',
  'check-mobile-permissions.mjs',
  'claim-fixture-ratchet.mjs',
  'docs-reference-gate.mjs',
  'focus-visible-ratchet.mjs',
  'font-origin-ratchet.mjs',
  'knowledge-kit-import-gate.mjs',
  'responsive-surface-ratchet.mjs',
  'station-vocabulary-gate.mjs',
  'unsaved-guard-gate.mjs',
];

/**
 * Run against this repo by `guardrail-process-boundary.test.ts`, which proves
 * the accept path and (for the silent ones) that the gate reaches its own
 * inputs — not the rejection path. Weaker, and recorded as such.
 */
const PROCESS_BOUNDARY_ACCEPT_RUNS = [
  'agent-plugin-validators-gate.mjs',
  'channel-ports.mjs',
  'coding-composition-inventory-gate.mjs',
  'dependency-lifecycle-workflow-gate.mjs',
  'examples-conformance.mjs',
  'generate-issue-lifecycle-reference.mjs',
  'just-interface.mjs',
  'label-manifest.mjs',
  'motion-contract-ratchet.mjs',
  'native-platform-boundary.mjs',
  'node-runtime-contract.mjs',
  'product-version.mjs',
  'public-contribution-surfaces.mjs',
  'public-doc-contract-examples.mjs',
  'public-docs-hygiene.mjs',
  'release-platform-matrix.mjs',
  'stored-path-expansion-guard.mjs',
];

/**
 * Gates a test outside these two suites already runs as a child process. The
 * named file is checked below for the script name and a child-process call —
 * a text check, which is why it is a pin on this declaration rather than the
 * proof itself. The proof is the named test.
 */
const EXECUTED_BY_OWN_TEST: ReadonlyArray<readonly [string, string]> = [
  ['cli-doc-parity.mjs', 'scripts/__tests__/cli-doc-parity.test.ts'],
  [
    'dependency-lifecycle.mjs',
    'scripts/__tests__/version-packages-lock.test.ts',
  ],
  [
    'dialog-surface-class-guard.mjs',
    'scripts/__tests__/dialog-surface-class-guard.test.ts',
  ],
  ['docs-index.mjs', 'scripts/__tests__/docs-index-reachability.test.ts'],
  [
    'evidence-check-execution-gate.mjs',
    'scripts/__tests__/evidence-check-execution-gate.test.ts',
  ],
  [
    'lazy-boundary-ratchet.mjs',
    'scripts/__tests__/prepush-static-gates.test.ts',
  ],
  ['lockfile-sync-gate.mjs', 'scripts/__tests__/version-packages-lock.test.ts'],
  ['random-uuid-guard.mjs', 'scripts/__tests__/random-uuid-guard.test.ts'],
  ['repo-docs-hygiene.mjs', 'scripts/__tests__/repo-docs-hygiene.test.ts'],
  [
    'sdk-error-message-ratchet.mjs',
    'scripts/__tests__/sdk-error-message-ratchet.test.ts',
  ],
  [
    'test-import-existence-gate.mjs',
    'scripts/__tests__/test-import-existence-gate.test.ts',
  ],
  [
    'ui-glyph-coverage-ratchet.mjs',
    'scripts/__tests__/ui-glyph-coverage-gate.cli.test.ts',
  ],
];

/**
 * Gates no test executes, each with the reason. This list is the honest gap,
 * not a backlog marker: every entry names a cost or a dependency that made a
 * process-boundary case worth less than it cost. Shrinking it is welcome;
 * growing it silently is what the exact-set assertion prevents.
 */
const NOT_EXECUTED: ReadonlyArray<readonly [string, string]> = [
  [
    'actionlint-gate.mjs',
    'shells out to the external `actionlint` binary, which is not a repository dependency; a run without it proves the shim, not the gate',
  ],
  [
    'check-kontour-dependency-drift.ts',
    'a TypeScript entry point invoked through tsx, so a `node scripts/...` child would not reach it',
  ],
  [
    'docs-truth-gate-aggregate.mjs',
    'spawns twelve `npm run` lanes; executing it under test would run most of this table again as grandchildren',
  ],
  [
    'generate-runtime-conformance.mjs',
    'invoked through tsx and writes generated conformance output; --check still resolves the generator, not a gate decision',
  ],
  [
    'prepare-verify-static.mjs',
    'a mutating preparation step that rebuilds packages/connect/dist and packages/cli/dist, not a gate with a verdict',
  ],
  [
    'typecheck-aggregate.mjs',
    'runs twelve tsc lanes (~25s here); run-ci-fast.test.ts pins its command, and the lanes are covered by typecheck:scripts',
  ],
];

describe('every gate verify:static:raw composes is accounted for', () => {
  const derived = derivedGateScripts();

  it('derives a non-trivial gate set from the package-script graph', () => {
    // A walk that stopped early would make every assertion below vacuous —
    // an empty partition trivially equals an empty derived set.
    expect(derived.length).toBeGreaterThan(40);
    expect(derived).toContain('a11y-ratchet.mjs');
    expect(derived).toContain('typecheck-aggregate.mjs');
  });

  it('partitions that set exactly — no gate unclassified, no entry invented', () => {
    const classified = [
      ...KNOWN_BAD_FIXTURES_SUITE,
      ...PROCESS_BOUNDARY_FIXTURES,
      ...PROCESS_BOUNDARY_ACCEPT_RUNS,
      ...EXECUTED_BY_OWN_TEST.map(([script]) => script),
      ...NOT_EXECUTED.map(([script]) => script),
    ].sort();
    // Both directions in one assertion: a new gate in the chain shows up as a
    // missing entry, and a renamed or deleted gate shows up as an extra one.
    expect(classified).toEqual(derived);
    // And the buckets are disjoint, so a gate cannot be counted twice into
    // an accidental match.
    expect(new Set(classified).size).toBe(classified.length);
  });

  it('every gate delegated to its own test names that gate in a child-process call', () => {
    for (const [script, testFile] of EXECUTED_BY_OWN_TEST) {
      const source = readFileSync(testFile, 'utf8');
      expect(source, `${testFile} does not name ${script}`).toContain(script);
      expect(source, `${testFile} starts no child process`).toMatch(
        /spawnSync|execFileSync|execFile\(|spawn\(/,
      );
    }
  });

  it('every recorded gap carries a reason', () => {
    for (const [script, reason] of NOT_EXECUTED) {
      expect(script).toMatch(/\.(mjs|ts)$/);
      expect(reason.length, `${script} has a token reason`).toBeGreaterThan(40);
    }
  });
});
