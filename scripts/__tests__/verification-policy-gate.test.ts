import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { VERIFICATION_BEHAVIOR_ENVIRONMENT } from '../lib/test-reliability.mjs';
import { PREPUSH_TEST_FILES } from '../prepush-test-manifest.mjs';
import { FAST_STATIC_COMMANDS } from '../run-ci-fast.mjs';
import {
  CI_FAST_TIMEOUT_MS,
  LANES,
  renderFullRegressionPhaseSchedule,
  renderLaneCatalogTable,
} from '../verification-lanes.mjs';
import {
  CI_FAST_DEADLINE_GUIDANCE,
  CI_FAST_RESERVED_WEIGHT,
  CI_FAST_STATIC_COMMANDS,
  DIRECT_OPT_IN,
  discoverTrackedVitestTestFiles,
  E2E_LATEST_GUIDANCE_MARKERS,
  E2E_POLICY_MARKERS,
  executableVerificationPolicyErrors,
  FAILURE_DIAGNOSIS_MARKERS,
  FULL_REGRESSION_TEST_WEIGHT,
  LANE_REUSE_MARKERS,
  LANE_TABLE_DOC,
  ROOT_VITEST_TRACKED_EXCLUSIONS,
  SUBMISSION_HANDOFF_GUIDANCE_DOCS,
  SUBMISSION_HANDOFF_GUIDANCE_MARKERS,
  TEST_RESOURCE_POLICY_MARKERS,
  VERIFICATION_POLICY_SECTION,
  VERIFICATION_POLICY_SECTION_END,
  VERIFICATION_POLICY_SECTION_START,
  VERIFICATION_SCHEDULING_DOCS,
  VERIFICATION_SCHEDULING_SECTION,
  verificationPolicyErrors,
  vitestResourceCorpusErrors,
} from '../verification-policy-gate.mjs';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const TESTING_GUIDE_FILE = 'docs/guides/testing.md';
// Capture the policy reader's generated-document input once at collection.
// The absolute, module-anchored path remains correct regardless of test cwd.
const TESTING_GUIDE_TEXT = readFileSync(
  resolve(import.meta.dirname, '../../docs/guides/testing.md'),
  'utf8',
);

function guideText(file: string) {
  return file === TESTING_GUIDE_FILE
    ? TESTING_GUIDE_TEXT
    : readFileSync(file, 'utf8');
}

const trackedVitestFixture = Object.freeze([
  'scripts/__tests__/ordinary.test.ts',
  'scripts/__tests__/ordinary-second.test.ts',
  'scripts/__tests__/process-heavy.test.ts',
  'scripts/__tests__/process-exclusive.test.ts',
  'scripts/__tests__/shared-output.test.ts',
  'scripts/__tests__/dogfood-reconcile.test.ts',
]);

function completeVitestGroups() {
  return {
    ordinary: [trackedVitestFixture[0], trackedVitestFixture[1]],
    processHeavy: [trackedVitestFixture[2]],
    processExclusive: [trackedVitestFixture[3]],
    sharedOutput: [trackedVitestFixture[4]],
    dogfoodReconcile: [trackedVitestFixture[5]],
  };
}

describe('verification policy gate', () => {
  test('keeps public heavy lanes coordinated and guidance progressive', () => {
    expect(verificationPolicyErrors()).toEqual([]);
    expect(packageJson.scripts['verification:policy:gate']).toBe(
      'node scripts/verification-policy-gate.mjs && node scripts/product-law-gate.mjs',
    );
    expect(PREPUSH_TEST_FILES).toContain(
      'scripts/__tests__/verification-policy-gate.test.ts',
    );
  });

  test('executes exact E2E and Vitest resource invariants', () => {
    expect(executableVerificationPolicyErrors()).toEqual([]);
  }, 70_000);

  test('discovers the root Vitest corpus from tracked source with the declared root exclusions', () => {
    const config = readFileSync('vitest.config.ts', 'utf8');
    for (const exclusion of ROOT_VITEST_TRACKED_EXCLUSIONS)
      expect(config).toContain(`'${exclusion}'`);

    const files = discoverTrackedVitestTestFiles({
      execFile: (command, args) => {
        expect(command).toBe('git');
        expect(args).toEqual(['ls-files', '-z']);
        return [
          ...trackedVitestFixture,
          'scripts/__tests__/café round-trip.test.ts',
          'scripts/__tests__/legal "quote" path.test.ts',
          'scripts/__tests__/newly-tracked.test.ts',
          'tests/browser-flow.spec.ts',
          'node_modules/example/index.test.ts',
          'vendor/dependency.test.ts',
          '.claude/scratch.test.ts',
          '.station/scratch.test.ts',
          'station-worktrees/other/scripts/__tests__/nested.test.ts',
          // station#3423 fixed this suite; station#3435 review MEDIUM-2
          // removed the name-specific exclusion that used to keep it out of
          // every gated lane even after the fix — it is tracked, ordinary,
          // no-longer-excluded coverage now, same as any other test file.
          'packages/connect/src/__tests__/qr-round-trip.test.ts',
          'README.md',
        ].join('\0');
      },
    });
    expect(files).toEqual(
      [
        ...trackedVitestFixture,
        'scripts/__tests__/café round-trip.test.ts',
        'scripts/__tests__/legal "quote" path.test.ts',
        'scripts/__tests__/newly-tracked.test.ts',
        'packages/connect/src/__tests__/qr-round-trip.test.ts',
      ].sort(),
    );
  });

  test('requires resource groups to partition every independently tracked Vitest test exactly once', () => {
    expect(
      vitestResourceCorpusErrors(completeVitestGroups(), trackedVitestFixture),
    ).toEqual([]);

    const missing = completeVitestGroups();
    // Keep the ordinary group nonempty: this models deleting or omitting one
    // normal test while an old nonempty-floor check would still pass.
    missing.ordinary.pop();
    expect(vitestResourceCorpusErrors(missing, trackedVitestFixture)).toContain(
      'Vitest resource groups miss tracked test file: scripts/__tests__/ordinary-second.test.ts',
    );

    const newlyTracked = 'scripts/__tests__/newly-tracked.test.ts';
    expect(
      vitestResourceCorpusErrors(completeVitestGroups(), [
        ...trackedVitestFixture,
        newlyTracked,
      ]),
    ).toContain(
      `Vitest resource groups miss tracked test file: ${newlyTracked}`,
    );

    const duplicate = completeVitestGroups();
    duplicate.processHeavy.push(trackedVitestFixture[0]);
    expect(
      vitestResourceCorpusErrors(duplicate, trackedVitestFixture),
    ).toContain(
      'Vitest resource groups assign tracked test file more than once: scripts/__tests__/ordinary.test.ts (ordinary, processHeavy)',
    );

    const extra = completeVitestGroups();
    extra.ordinary.push('scripts/__tests__/untracked.test.ts');
    expect(vitestResourceCorpusErrors(extra, trackedVitestFixture)).toContain(
      'Vitest resource groups include non-tracked test file: scripts/__tests__/untracked.test.ts (ordinary)',
    );

    expect(
      vitestResourceCorpusErrors(completeVitestGroups(), [
        ...trackedVitestFixture,
        trackedVitestFixture[0],
      ]),
    ).toContain(
      'Vitest resource corpus has duplicate tracked test path: scripts/__tests__/ordinary.test.ts',
    );

    const renamed = 'scripts/__tests__/ordinary-renamed.test.ts';
    const renamedCorpus = trackedVitestFixture.map((file) =>
      file === trackedVitestFixture[0] ? renamed : file,
    );
    const renamedGroups = completeVitestGroups();
    renamedGroups.ordinary[0] = renamed;
    expect(vitestResourceCorpusErrors(renamedGroups, renamedCorpus)).toEqual(
      [],
    );
    const staleRenameErrors = vitestResourceCorpusErrors(
      completeVitestGroups(),
      renamedCorpus,
    );
    expect(staleRenameErrors).toContain(
      `Vitest resource groups miss tracked test file: ${renamed}`,
    );
    expect(staleRenameErrors).toContain(
      'Vitest resource groups include non-tracked test file: scripts/__tests__/ordinary.test.ts (ordinary)',
    );
  });

  test('fails closed when independently tracked Vitest discovery cannot run', () => {
    const errors = executableVerificationPolicyErrors({
      discoverVitest: () => completeVitestGroups(),
      discoverTrackedVitest: () => {
        throw new Error('git ls-files unavailable');
      },
    });
    expect(errors).toContain(
      'Tracked Vitest corpus discovery: git ls-files unavailable',
    );
  });

  test('keeps source-of-truth guidance selector-first and preserves the Claude wrapper', () => {
    const guidance = readFileSync('AGENTS.md', 'utf8');
    expect(guidance).toContain(
      '`npm run test:changed -- --base=origin/main --explain` selects a diagnostic lane',
    );
    expect(guidance).toContain(
      'Builder `tests-evidence` uses that exact-SHA promotion receipt',
    );
    expect(guidance).not.toContain('Broad verification: `npm run verify`.');
    expect(readFileSync('CLAUDE.md', 'utf8').startsWith('@AGENTS.md\n\n')).toBe(
      true,
    );
  });

  test('documents every behavior-changing environment input in receipt guidance', () => {
    const reference = readFileSync(
      'docs/reference/verification-receipts.md',
      'utf8',
    );
    for (const name of VERIFICATION_BEHAVIOR_ENVIRONMENT)
      expect(reference).toContain(`\`${name}\``);
  });

  test('rejects wrong lanes, appended bypasses, and trust command drift', () => {
    const bypass = structuredClone(packageJson);
    bypass.scripts['test:full'] =
      'node scripts/run-verification.mjs request verify-static';
    expect(verificationPolicyErrors({ manifest: bypass })).toContain(
      'public heavy script test:full must exactly equal node scripts/run-verification.mjs request test-full',
    );
    bypass.scripts['test:full'] =
      'node scripts/run-verification.mjs request test-full && vitest run';
    expect(verificationPolicyErrors({ manifest: bypass })).toContain(
      'public heavy script test:full must exactly equal node scripts/run-verification.mjs request test-full',
    );
    const trust = structuredClone(packageJson);
    trust['trust-reconcile-manifest'] = [
      { id: 'full-regression', command: 'npm run ci:extended' },
    ];
    expect(verificationPolicyErrors({ manifest: trust })).toContain(
      'trust-reconcile manifest must contain exact npm run full:regression',
    );
  });

  test('rejects broad static and full-Vitest creep into ci:fast', () => {
    expect(CI_FAST_STATIC_COMMANDS).toEqual(FAST_STATIC_COMMANDS);
    expect(
      verificationPolicyErrors({
        ciFastStaticCommands: [
          ...FAST_STATIC_COMMANDS,
          ['npm', ['run', 'verify:static:raw']],
        ],
      }),
    ).toContain(
      'ci:fast must run only its fixed bounded static invariant allowlist',
    );
    expect(
      verificationPolicyErrors({
        ciFastStaticCommands: [
          ...FAST_STATIC_COMMANDS,
          ['npm', ['run', 'test:full:raw']],
        ],
      }),
    ).toContain(
      'ci:fast must run only its fixed bounded static invariant allowlist',
    );
  });

  test('pins admission headroom for ci:fast beside the full test phase', () => {
    expect(CI_FAST_RESERVED_WEIGHT).toBe(20);
    expect(CI_FAST_TIMEOUT_MS).toBe(12 * 60_000);
    expect(FULL_REGRESSION_TEST_WEIGHT).toBe(80);
    const crowded = LANES.map((lane) =>
      lane.id === 'full-regression'
        ? {
            ...lane,
            phases: lane.phases.map((phase) =>
              phase.id === 'test-full-ordinary'
                ? { ...phase, weight: 81 }
                : phase,
            ),
          }
        : lane,
    );
    expect(verificationPolicyErrors({ lanes: crowded })).toContain(
      'full-regression test-full-ordinary phase must use exactly 80 coordinator weight',
    );
  });

  test('rejects a ci:fast deadline that drifts from the bounded runner budget', () => {
    const drifted = LANES.map((lane) =>
      lane.id === 'ci-fast' ? { ...lane, timeoutMs: 7 * 60_000 } : lane,
    );
    expect(verificationPolicyErrors({ lanes: drifted })).toContain(
      'ci:fast must use the exact 12-minute bounded-feedback deadline',
    );
  });

  test('pins the twelve-minute deadline in every contributor-facing ci:fast guide', () => {
    const stale = CI_FAST_DEADLINE_GUIDANCE.map((entry) => ({
      ...entry,
      text: entry.marker.includes('twelve-minute')
        ? 'bounded seven-minute feedback lane'
        : '',
    }));
    expect(
      verificationPolicyErrors({ ciFastDeadlineGuidance: stale }),
    ).toContain(
      "docs/guides/code-quality.md must state 'bounded twelve-minute feedback'",
    );
  });

  test('rejects making a selector deferral completion evidence', () => {
    const completionFast = LANES.map((lane) =>
      lane.id === 'ci-fast'
        ? { ...lane, completion: true, diagnostic: false }
        : lane,
    );
    expect(verificationPolicyErrors({ lanes: completionFast })).toContain(
      'ci:fast selector deferrals must remain diagnostic and never completion evidence',
    );
  });

  test('tokenizes npm flags before rejecting every private raw invocation form', () => {
    const selector = 'npm run test:changed -- --base=origin/main --explain';
    const rawForms = [
      'npm run test:full:raw',
      'npm --silent run test:full:raw',
      'npm -s run test:full:raw',
      'npm run -s test:full:raw',
      'npm run --workspace packages/connect test:full:raw',
      'npm --workspace=packages/connect run test:full:raw',
      'npm -s --workspace packages/connect run --silent test:full:raw',
    ];
    for (const command of rawForms) {
      expect(
        verificationPolicyErrors({
          docs: [{ file: 'fixture.md', text: `${command}\n${selector}` }],
        }),
      ).toContain('fixture.md exposes a private raw verification command');
    }
  });

  test('accepts selector whitespace and non-raw npm commands', () => {
    expect(
      verificationPolicyErrors({
        docs: [
          {
            file: TESTING_GUIDE_FILE,
            text: TESTING_GUIDE_TEXT,
          },
          {
            file: 'whitespace.md',
            text: 'npm run   test:changed\t-- --base=origin/main   --explain\nnpm --silent run test:full\nnpm run --workspace packages/connect test:full',
          },
        ],
      }),
    ).toEqual([]);
  });

  test('keeps every direct reliability command explicitly reasoned', () => {
    for (const [script, reason] of Object.entries(DIRECT_OPT_IN)) {
      expect(packageJson.scripts[script]).toBeTypeOf('string');
      expect(reason).not.toEqual('');
    }
    const manifest = structuredClone(packageJson);
    manifest.scripts['test:future-reliability'] = 'node scripts/future.mjs';
    expect(verificationPolicyErrors({ manifest })).toContain(
      'direct reliability script test:future-reliability is not explicitly allowlisted',
    );
  });

  test('requires browser-test admission and pruning policy in canonical guidance', () => {
    for (const marker of E2E_POLICY_MARKERS)
      expect(TESTING_GUIDE_TEXT).toContain(marker);
    for (const marker of TEST_RESOURCE_POLICY_MARKERS)
      expect(TESTING_GUIDE_TEXT).toContain(marker);

    const docs = [
      {
        file: 'docs/guides/testing.md',
        text: 'npm run test:changed -- --base=origin/main --explain',
      },
    ];
    expect(verificationPolicyErrors({ docs })).toContain(
      "docs/guides/testing.md is missing E2E policy marker 'real browser'",
    );
  });

  test('rejects the stale steering prescriptions that created browser-suite growth', () => {
    const selector = 'npm run test:changed -- --base=origin/main --explain';
    for (const stale of [
      'If you add a user-facing flow, it gets a tests/feature.spec.ts Playwright test.',
      '| New UI component/hook | Playwright e2e test for the user flow |',
      'SSE streaming, WebSocket, AWS SDK calls, and UI flows are tested via Playwright.',
      'UI hook unit tests require vitest 2.x for proper jsdom localStorage support.',
    ]) {
      const errors = verificationPolicyErrors({
        docs: [{ file: 'stale.md', text: `${selector}\n${stale}` }],
      });
      expect(
        errors.some((error) => error.includes('stale test guidance')),
      ).toBe(true);
    }
  });

  test('pins the rendered lane catalog table in docs/guides/testing.md', () => {
    // The real docs/guides/testing.md must carry the exact catalog render (no drift either
    // way); the baseline assertion is the top-of-file `toEqual([])` check.
    const agentsText = TESTING_GUIDE_TEXT;
    expect(agentsText).toContain(renderLaneCatalogTable());
  });

  test('pins catalog-derived scheduling and checkpoint resume guidance in every contributor document', () => {
    for (const file of VERIFICATION_SCHEDULING_DOCS) {
      const text = guideText(file);
      expect(text).toContain(VERIFICATION_SCHEDULING_SECTION);
      expect(text).toContain(renderFullRegressionPhaseSchedule());
      expect(text).toContain(
        '.kontourai/verification-phase-records/<request-key>/',
      );
      expect(text).toContain('invalid-UTF-8');
      expect(text).toContain('cleanup-bad checkpoints rerun');
    }
  });

  test('rejects a stale phase weight or weakened checkpoint resume clause in either document', () => {
    const docs = VERIFICATION_SCHEDULING_DOCS.map((file) => ({
      file,
      text: guideText(file),
    }));
    const staleWeight = docs.map((doc) =>
      doc.file === 'docs/guides/testing.md'
        ? {
            ...doc,
            text: doc.text.replace(
              '`test-full-ordinary` — 80-unit',
              '`test-full-ordinary` — 100-unit',
            ),
          }
        : doc,
    );
    expect(verificationPolicyErrors({ docs: staleWeight })).toContain(
      'docs/guides/testing.md verification-scheduling section drifted from the canonical text in scripts/verification-policy-gate.mjs',
    );

    const weakenedResume = docs.map((doc) =>
      doc.file === 'docs/guides/testing.md'
        ? {
            ...doc,
            text: doc.text.replace(
              'Failed, timed-out, truncated, invalid-UTF-8, malformed, mismatched, or cleanup-bad checkpoints rerun;',
              'Failed checkpoints rerun;',
            ),
          }
        : doc,
    );
    expect(verificationPolicyErrors({ docs: weakenedResume })).toContain(
      'docs/guides/testing.md verification-scheduling section drifted from the canonical text in scripts/verification-policy-gate.mjs',
    );
  });

  test('keeps the ignored latest-E2E gallery pointer in docs/guides/testing.md', () => {
    const agentsText = TESTING_GUIDE_TEXT;
    for (const marker of E2E_LATEST_GUIDANCE_MARKERS)
      expect(agentsText).toContain(marker);
    const missingSync = agentsText.replaceAll(
      'npm run sync:e2e:latest',
      'npm run sync:e2e:missing',
    );
    expect(
      verificationPolicyErrors({
        docs: [{ file: 'docs/guides/testing.md', text: missingSync }],
      }),
    ).toContain(
      "docs/guides/testing.md is missing latest-E2E guidance marker 'npm run sync:e2e:latest'",
    );
  });

  test('fails when a catalog command drifts and the table is not re-rendered', () => {
    // A mutated command renders a table docs/guides/testing.md no longer contains, so the
    // gate must report drift rather than silently accepting a stale table.
    const driftedCommand = LANES.map((lane) =>
      lane.id === 'ci-fast'
        ? { ...lane, command: 'npm run ci:fast-drifted' }
        : lane,
    );
    expect(verificationPolicyErrors({ lanes: driftedCommand })).toContain(
      `${LANE_TABLE_DOC} lane table drifted from scripts/verification-lanes.mjs (regenerate via renderLaneCatalogTable)`,
    );
  });

  test('fails when a catalog scope phrase drifts and the table is not re-rendered', () => {
    const driftedScope = LANES.map((lane) =>
      lane.id === 'prepush'
        ? { ...lane, scope: 'changed scope wording' }
        : lane,
    );
    expect(verificationPolicyErrors({ lanes: driftedScope })).toContain(
      `${LANE_TABLE_DOC} lane table drifted from scripts/verification-lanes.mjs (regenerate via renderLaneCatalogTable)`,
    );
  });

  test('fails when the doc table is hand-trimmed', () => {
    const table = renderLaneCatalogTable();
    const trimmed = table.split('\n').slice(0, -1).join('\n');
    const agentsText = TESTING_GUIDE_TEXT.replace(table, trimmed);
    expect(
      verificationPolicyErrors({
        docs: [{ file: 'docs/guides/testing.md', text: agentsText }],
      }),
    ).toContain(
      `${LANE_TABLE_DOC} lane table drifted from scripts/verification-lanes.mjs (regenerate via renderLaneCatalogTable)`,
    );
  });

  test('requires the failure-diagnosis and lane-reuse clauses in docs/guides/testing.md', () => {
    const agentsText = TESTING_GUIDE_TEXT;
    // Sanity: the real docs/guides/testing.md carries every clause.
    for (const marker of [...FAILURE_DIAGNOSIS_MARKERS, ...LANE_REUSE_MARKERS])
      expect(agentsText).toContain(marker);
    // Removing any one clause must fail the gate.
    for (const marker of FAILURE_DIAGNOSIS_MARKERS) {
      const scrubbed = agentsText.replace(marker, 'X'.repeat(marker.length));
      expect(
        verificationPolicyErrors({
          docs: [{ file: 'docs/guides/testing.md', text: scrubbed }],
        }),
      ).toContain(
        `docs/guides/testing.md is missing failure-diagnosis marker '${marker}'`,
      );
    }
    for (const marker of LANE_REUSE_MARKERS) {
      const scrubbed = agentsText.replace(marker, 'X'.repeat(marker.length));
      expect(
        verificationPolicyErrors({
          docs: [{ file: 'docs/guides/testing.md', text: scrubbed }],
        }),
      ).toContain(
        `docs/guides/testing.md is missing lane-reuse marker '${marker}'`,
      );
    }
  });

  test('requires hosted promotion guidance in every contributor guide', () => {
    const docs = SUBMISSION_HANDOFF_GUIDANCE_DOCS.map((file) => ({
      file,
      text: guideText(file),
    }));
    for (const { text } of docs) {
      for (const marker of SUBMISSION_HANDOFF_GUIDANCE_MARKERS)
        expect(text).toContain(marker);
    }
    for (const marker of SUBMISSION_HANDOFF_GUIDANCE_MARKERS) {
      const drifted = docs.map((doc) =>
        doc.file === 'docs/guides/testing.md'
          ? {
              ...doc,
              text: doc.text.replace(marker, 'X'.repeat(marker.length)),
            }
          : doc,
      );
      expect(verificationPolicyErrors({ docs: drifted })).toContain(
        `docs/guides/testing.md is missing submission-handoff marker '${marker}'`,
      );
    }
  });

  // The byte-exact canonical section check is the strong enforcement: a
  // hand-edit that deletes, truncates, or reorders a meaningful sentence
  // portion fails the gate even when a marker fragment survives — the weakness
  // of `includes`-only enforcement. These tests mutate real docs/guides/testing.md text in
  // ways that retain every marker phrase yet must still fail.

  test('rejects deletion of the flaky-triage clause while retaining markers', () => {
    const agentsText = TESTING_GUIDE_TEXT;
    // Drop "and disclosed, never hidden by repetition." but keep both
    // failure-diagnosis marker phrases intact above it.
    const mutated = agentsText.replace(
      'baseline and disclosed, never\nhidden by repetition.',
      'baseline.',
    );
    expect(mutated).not.toBe(agentsText);
    // Sanity: the loose marker fragments survived the edit.
    for (const marker of FAILURE_DIAGNOSIS_MARKERS)
      expect(mutated).toContain(marker);
    expect(
      verificationPolicyErrors({
        docs: [{ file: 'docs/guides/testing.md', text: mutated }],
      }),
    ).toContain(
      'docs/guides/testing.md verification-policy section drifted from the canonical text in scripts/verification-policy-gate.mjs',
    );
  });

  test('rejects deletion of the do-not-start clause while retaining markers', () => {
    const agentsText = TESTING_GUIDE_TEXT;
    // Drop "so do not start a" but keep the "redundant same-digest run" and
    // "join or reuse the existing lease" marker phrases.
    const mutated = agentsText.replace(
      'weighted lease, so do not start a\nredundant same-digest run',
      'weighted lease.\nredundant same-digest run',
    );
    expect(mutated).not.toBe(agentsText);
    for (const marker of LANE_REUSE_MARKERS) expect(mutated).toContain(marker);
    expect(
      verificationPolicyErrors({
        docs: [{ file: 'docs/guides/testing.md', text: mutated }],
      }),
    ).toContain(
      'docs/guides/testing.md verification-policy section drifted from the canonical text in scripts/verification-policy-gate.mjs',
    );
  });

  test('rejects a dropped identity field in the invalidation caption', () => {
    const agentsText = TESTING_GUIDE_TEXT;
    // Remove `arch` from the enumerated identity set, leaving the rest intact.
    const mutated = agentsText.replace(
      '`toolchain`, `platform`,\n`arch` (whose SHA-256',
      '`toolchain`, `platform`\n(whose SHA-256',
    );
    expect(mutated).not.toBe(agentsText);
    expect(
      verificationPolicyErrors({
        docs: [{ file: 'docs/guides/testing.md', text: mutated }],
      }),
    ).toContain(
      'docs/guides/testing.md verification-policy section drifted from the canonical text in scripts/verification-policy-gate.mjs',
    );
  });

  test('rejects truncated invalidation caption prose (sentence portion removed)', () => {
    const agentsText = TESTING_GUIDE_TEXT;
    // Truncate the caption mid-sentence by removing its final clause.
    const mutated = agentsText.replace(
      '\nSee `docs/reference/verification-receipts.md` for the field-by-field table.',
      '',
    );
    expect(mutated).not.toBe(agentsText);
    expect(
      verificationPolicyErrors({
        docs: [{ file: 'docs/guides/testing.md', text: mutated }],
      }),
    ).toContain(
      'docs/guides/testing.md verification-policy section drifted from the canonical text in scripts/verification-policy-gate.mjs',
    );
  });

  test('rejects reordered paragraphs while every marker fragment survives', () => {
    const agentsText = TESTING_GUIDE_TEXT;
    // Reverse the four paragraph blocks inside the section. Every marker
    // phrase still appears, so `includes` checks pass — only the byte-exact
    // section check catches the reorder.
    const afterStart = VERIFICATION_POLICY_SECTION.slice(
      VERIFICATION_POLICY_SECTION_START.length + 1,
    );
    const inner = afterStart.slice(
      0,
      afterStart.length - VERIFICATION_POLICY_SECTION_END.length - 1,
    );
    const blocks = inner.split('\n\n');
    expect(blocks).toHaveLength(4);
    const reordered = [
      VERIFICATION_POLICY_SECTION_START,
      blocks[3],
      blocks[2],
      blocks[1],
      blocks[0],
      VERIFICATION_POLICY_SECTION_END,
    ].join('\n');
    const mutated = agentsText.replace(VERIFICATION_POLICY_SECTION, reordered);
    expect(mutated).not.toBe(agentsText);
    for (const marker of [...FAILURE_DIAGNOSIS_MARKERS, ...LANE_REUSE_MARKERS])
      expect(mutated).toContain(marker);
    expect(
      verificationPolicyErrors({
        docs: [{ file: 'docs/guides/testing.md', text: mutated }],
      }),
    ).toContain(
      'docs/guides/testing.md verification-policy section drifted from the canonical text in scripts/verification-policy-gate.mjs',
    );
  });

  test('rejects a duplicated verification-policy section', () => {
    const agentsText = TESTING_GUIDE_TEXT;
    const mutated = agentsText.replace(
      VERIFICATION_POLICY_SECTION,
      `${VERIFICATION_POLICY_SECTION}\n\n${VERIFICATION_POLICY_SECTION}`,
    );
    expect(
      verificationPolicyErrors({
        docs: [{ file: 'docs/guides/testing.md', text: mutated }],
      }),
    ).toContain(
      'docs/guides/testing.md must contain exactly one verification-policy section (found a duplicate)',
    );
  });

  test('rejects a stray duplicate section start marker', () => {
    const agentsText = TESTING_GUIDE_TEXT;
    const mutated = agentsText.replace(
      VERIFICATION_POLICY_SECTION_END,
      `${VERIFICATION_POLICY_SECTION_END}\n${VERIFICATION_POLICY_SECTION_START}`,
    );
    expect(
      verificationPolicyErrors({
        docs: [{ file: 'docs/guides/testing.md', text: mutated }],
      }),
    ).toContain(
      'docs/guides/testing.md must contain exactly one verification-policy start marker (found 2)',
    );
  });
});
