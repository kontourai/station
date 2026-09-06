import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import {
  changedPaths,
  escalateUnavailableExplicitTests,
  renderChangedVerificationSummary,
  runChangedVerification,
  runRepresentativeNarrowDiffFixture,
  selectChangedVerification,
  validateChangedVerificationReceipt,
} from '../run-changed-verification.mjs';
import {
  E2E_CONTRACT_BOUNDARIES,
  TAILSCALE_PUBLIC_INGRESS_IMPACT_BOUNDARY,
  TEST_IMPACT_MANIFEST,
  validateTestImpactManifest,
} from '../test-impact-manifest.mjs';
import { FIXTURE_TOOLCHAIN_IDENTITY } from './fixtures/verification-toolchain.mjs';

const scenarios = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        './fixtures/changed-verification/scenarios.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
);
const passingReport = readFileSync(
  fileURLToPath(
    new URL(
      './fixtures/changed-verification/vitest-passing-report.json',
      import.meta.url,
    ),
  ),
  'utf8',
);
const zeroTestReport = readFileSync(
  fileURLToPath(
    new URL(
      './fixtures/changed-verification/vitest-zero-test-report.json',
      import.meta.url,
    ),
  ),
  'utf8',
);
const failingReport = readFileSync(
  fileURLToPath(
    new URL(
      './fixtures/changed-verification/vitest-failing-report.json',
      import.meta.url,
    ),
  ),
  'utf8',
);
// Captured verbatim from Vitest 3.2.6's own JSON reporter running one passing
// test, a two-test `describe.skipIf(true)` block, and one `test.todo`.
const skippedReport = readFileSync(
  fileURLToPath(
    new URL(
      './fixtures/changed-verification/vitest-skipped-report.json',
      import.meta.url,
    ),
  ),
  'utf8',
);

// Independently authored from the direct repository reads in each test. Do
// not derive this from TEST_IMPACT_MANIFEST: it is the completeness oracle for
// the production mapping, not another projection of that mapping.
const EXPECTED_GOVERNED_READERS = {
  '.github/workflows/**': [
    'scripts/__tests__/backlog-priority-policy.test.ts',
    'scripts/__tests__/ci-workflow-contract.test.ts',
    'scripts/__tests__/ci-workflow-governance.test.ts',
    'scripts/__tests__/container-release.test.ts',
    'scripts/__tests__/e2e-manifest.test.ts',
    'scripts/__tests__/issue-lifecycle-workflow.test.ts',
    'scripts/__tests__/nightly-build-identity.test.ts',
    'scripts/__tests__/node-runtime-contract.test.ts',
    'scripts/__tests__/publish-oidc-exchange-status.test.ts',
    'scripts/__tests__/release-cargo-producer.test.ts',
    'scripts/__tests__/release-ring-workflow.test.ts',
    'scripts/__tests__/release-workflow.test.ts',
    'scripts/__tests__/security-analysis-workflow.test.ts',
    'scripts/__tests__/server-build-portability.test.ts',
    'scripts/__tests__/trust-reconcile-manifest.test.ts',
    'scripts/__tests__/verification-lanes.test.ts',
  ],
  '.github/workflows/publish-release.yml': [
    'scripts/__tests__/release-availability-driver.test.ts',
    'scripts/__tests__/release-availability.test.ts',
  ],
  '.veritas/**': [
    'scripts/__tests__/evidence-check-execution-gate.test.ts',
    'scripts/__tests__/proof-family-lane-governance.test.ts',
    'scripts/__tests__/veritas-readiness-evidence.test.ts',
    'scripts/__tests__/veritas-repo-map.test.ts',
  ],
} as const;

function provenance(workspaceDigest = 'b'.repeat(64)) {
  if (typeof workspaceDigest !== 'string') workspaceDigest = 'b'.repeat(64);
  return {
    repositoryId: 'd'.repeat(64),
    worktree: process.cwd(),
    headSha: 'a'.repeat(40),
    workspaceDigest,
    environmentDigest: 'e'.repeat(64),
    dependencyDigest: 'c'.repeat(64),
    nodeVersion: process.version,
    toolchain: 'npm@fixture',
    toolchainIdentity: FIXTURE_TOOLCHAIN_IDENTITY,
    platform: process.platform,
    arch: process.arch,
  };
}

function reportedRun({ status = 0, report = passingReport, result = {} } = {}) {
  return vi.fn((_command, args) => {
    const outputFile = args.find((arg) => arg.startsWith('--outputFile='));
    if (report && outputFile)
      writeFileSync(outputFile.slice('--outputFile='.length), report);
    return { status, ...result };
  });
}

describe('changed verification selection', () => {
  test.each([
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'patches/dependency.patch',
  ])('does not silently narrow shared dependency changes: %s', (path) => {
    expect(selectChangedVerification([path])).toMatchObject({
      escalated: true,
    });
  });
  test.each([
    [scenarios.sourceEdges.server, 'server boundary'],
    [scenarios.sourceEdges.ui, 'UI boundary'],
    [scenarios.sourceEdges.package, 'package boundary'],
    [scenarios.sourceEdges.script, 'script boundary'],
  ])('selects related %s edge', (path, reason) => {
    const selection = selectChangedVerification([path]);
    expect(selection.relatedPaths).toEqual([path]);
    expect(selection.tests).toEqual([]);
    expect(selection.lanes).toEqual([]);
    expect(selection.escalated, reason).toBe(false);
  });
  test('recognizes .test.ts, .test.tsx, and .spec.ts through related selection', () => {
    for (const path of Object.values(scenarios.testFiles)) {
      const selection = selectChangedVerification([path]);
      expect(selection.relatedPaths).toEqual([]);
      expect(selection.tests).toEqual([
        {
          path,
          reasons: [`changed test file: ${path}`],
        },
      ]);
    }
  });
  test.each([
    'examples/demo/feature.test.ts',
    'packages/contracts/src/new-contract.test.ts',
  ])(
    'runs changed test %s exactly even outside a narrow source boundary',
    (path) => {
      const selection = selectChangedVerification([path]);
      expect(selection).toMatchObject({
        escalated: false,
        lanes: [],
        relatedPaths: [],
      });
      expect(selection.tests.map((entry) => entry.path)).toContain(path);
    },
  );
  test('selects every governed workflow reader that import analysis cannot see', () => {
    const workflow = '.github/workflows/ci.yml';
    const selection = selectChangedVerification([workflow]);
    expect(selection.escalated).toBe(false);
    expect(selection.lanes).toEqual([]);
    expect(selection.tests.map(({ path }) => path)).toEqual(
      EXPECTED_GOVERNED_READERS['.github/workflows/**'],
    );
    expect(selection.tests.map(({ path }) => path)).toContain(
      'scripts/__tests__/ci-workflow-contract.test.ts',
    );
  });
  test('selects the release-availability readers when their workflow changes', () => {
    const selected = selectChangedVerification([
      '.github/workflows/publish-release.yml',
    ]).tests.map((entry) => entry.path);
    expect(selected).toContain(
      'scripts/__tests__/release-availability-driver.test.ts',
    );
    expect(selected).toContain(
      'scripts/__tests__/release-availability.test.ts',
    );
  });
  test('manifest covers the independently inventoried direct governed-data readers', () => {
    for (const [pattern, readers] of Object.entries(
      EXPECTED_GOVERNED_READERS,
    )) {
      const edge = TEST_IMPACT_MANIFEST.find(
        (candidate) => candidate.pattern === pattern,
      );
      expect(edge?.tests, pattern).toEqual(readers);
    }
  });
  test('fails closed when an explicit governed-data target is missing', () => {
    const selection = selectChangedVerification(['.github/workflows/ci.yml']);
    const escalated = escalateUnavailableExplicitTests(selection, {
      root: '/repo',
      pathExists: (path) => !path.endsWith('ci-workflow-contract.test.ts'),
    });
    expect(escalated.escalated).toBe(true);
    expect(escalated.lanes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'test-full',
          reasons: [
            'unavailable explicit test: scripts/__tests__/ci-workflow-contract.test.ts',
          ],
        }),
      ]),
    );
  });
  test('executes a newly added red test directly and propagates its failure', () => {
    const added = 'scripts/__tests__/new-red.test.ts';
    const run = reportedRun({ status: 1, report: failingReport });
    const result = runChangedVerification(['--base=origin/main'], {
      root: process.cwd(),
      run,
      changedPathsFn: () => ({ mergeBase: 'base-sha', paths: [added] }),
      pathExists: () => true,
      collectProvenance: provenance,
      writeReceipt: vi.fn(),
    });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['run', added]),
    );
    expect(result.exitCode).toBe(1);
    expect(result.receipt.terminal).toMatchObject({
      status: 'failed',
      passed: false,
    });
  });
  test('routes E2E and native/nightly boundaries to named deferred lanes', () => {
    expect(
      selectChangedVerification([scenarios.deferredEdges.e2e]).lanes,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'verify-e2e-full' }),
      ]),
    );
    expect(
      selectChangedVerification([scenarios.deferredEdges.native]).lanes,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'verify-local' })]),
    );
    expect(
      selectChangedVerification([scenarios.deferredEdges.nightly]).lanes,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'verify-local' })]),
    );
  });
  test('routes every explicit E2E product-contract boundary to the full E2E lane', () => {
    expect(Object.values(scenarios.e2eContract)).toEqual(
      expect.arrayContaining(E2E_CONTRACT_BOUNDARIES),
    );
    for (const path of E2E_CONTRACT_BOUNDARIES) {
      const selection = selectChangedVerification([path]);
      expect(selection.relatedPaths).toEqual([]);
      expect(selection.lanes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'verify-e2e-full',
            reasons: expect.arrayContaining([
              `E2E product-contract control boundary: ${path}`,
            ]),
          }),
        ]),
      );
    }
  });
  test('keeps a nearby ordinary script on narrow related selection', () => {
    const selection = selectChangedVerification([
      scenarios.e2eContract.ordinaryScript,
    ]);
    expect(selection.relatedPaths).toEqual([
      scenarios.e2eContract.ordinaryScript,
    ]);
    expect(selection.lanes).toEqual([]);
  });
  test('uses a bounded named gate for docs and fails closed for risky selection', () => {
    expect(
      selectChangedVerification([scenarios.deferredEdges.docs]).lanes,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'prepush' })]),
    );
    for (const paths of [
      [scenarios.escalations.rootConfig],
      [scenarios.escalations.vitestConfig],
      [scenarios.escalations.viteConfig],
      [scenarios.escalations.biomeConfig],
      [scenarios.escalations.tsconfig],
      [scenarios.escalations.selector],
      [scenarios.escalations.highFanout],
      [scenarios.escalations.unknown],
      [],
    ])
      expect(selectChangedVerification(paths).lanes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: expect.any(String) }),
        ]),
      );
  });
  test('uses focused tests for an explicitly mapped high-fanout Pane contract', () => {
    const selection = selectChangedVerification([
      'packages/contracts/src/workspace-pane.ts',
    ]);
    expect(selection.escalated).toBe(false);
    expect(selection.lanes).toEqual([]);
    expect(selection.tests.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([
        'packages/contracts/src/__tests__/workspace-pane.test.ts',
        'packages/sdk/src/__tests__/workspacePaneConformance.test.ts',
        'packages/sdk/src/__tests__/workspace-pane-browser-bundle.test.ts',
      ]),
    );
  });
  test('selects portable client source scans and accepted-turn CLI consumers', () => {
    for (const path of [
      'packages/sdk/src/client/http.ts',
      'packages/sdk/src/client/bounded-response.ts',
      'packages/sdk/src/client/future-client.ts',
    ]) {
      expect(
        selectChangedVerification([path]).tests.map((entry) => entry.path),
      ).toContain(
        'packages/sdk/src/__tests__/client-entry-portability.test.ts',
      );
      expect(selectChangedVerification([path]).relatedPaths).toContain(path);
    }
    expect(
      selectChangedVerification([
        'packages/cli/src/commands/session-client.ts',
      ]).tests.map((entry) => entry.path),
    ).toEqual(
      expect.arrayContaining([
        'packages/cli/src/__tests__/core.test.ts',
        'packages/cli/src/__tests__/core-http.test.ts',
      ]),
    );
    expect(
      selectChangedVerification(['packages/cli/src/commands/session-client.ts'])
        .relatedPaths,
    ).toContain('packages/cli/src/commands/session-client.ts');
  });
  test('uses focused tests for the project-bound file preview contract', () => {
    const selection = selectChangedVerification([
      'packages/contracts/src/workspace-file-preview.ts',
    ]);
    expect(selection.escalated).toBe(false);
    expect(selection.lanes).toEqual([]);
    expect(selection.tests.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([
        'packages/contracts/src/__tests__/workspace-file-preview.test.ts',
        'packages/sdk/src/__tests__/workspace-file-preview-query.integration.test.tsx',
        'packages/sdk/src/__tests__/workspace-file-preview-browser-bundle.test.ts',
      ]),
    );
  });
  test('pairs the project file-preview pairing declaration with its leaf-scope guard', () => {
    const selection = selectChangedVerification([
      'src-server/security/pairing-route-scopes.ts',
    ]);
    expect(selection.escalated).toBe(false);
    expect(selection.lanes).toEqual([]);
    expect(selection.tests.map((entry) => entry.path)).toContain(
      'src-server/security/__tests__/pairing-route-scopes.test.ts',
    );
  });
  test('bounds the Tailscale public-ingress resolver to its parser and device-pairing route contracts', () => {
    const selection = selectChangedVerification([
      'src-server/services/tailscale/public-ingress-origin.ts',
    ]);
    expect(selection).toMatchObject({ escalated: false, lanes: [] });
    expect(selection.relatedPaths).toEqual([]);
    expect(selection.tests.map((entry) => entry.path)).toEqual([
      'src-server/runtime/__tests__/device-pairing-routes.test.ts',
      'src-server/services/tailscale/__tests__/public-ingress-origin.test.ts',
    ]);
  });
  test('bounds the acknowledgement repair to the SDK barrel and pairing guards', () => {
    const paths = [
      'packages/sdk/src/index.ts',
      'packages/sdk/src/queries.ts',
      'src-server/security/__tests__/pairing-route-scopes.test.ts',
      'src-server/security/pairing-route-scopes.ts',
    ];
    const selection = selectChangedVerification(paths);
    expect(selection).toMatchObject({ escalated: false, lanes: [] });
    expect(selection.relatedPaths).toEqual([]);
    expect(selection.tests.map(({ path }) => path)).toEqual([
      'packages/sdk/src/__tests__/publicBarrel.test.ts',
      'src-server/security/__tests__/pairing-route-scopes.test.ts',
    ]);

    const run = reportedRun();
    const result = runChangedVerification(['--base=origin/main'], {
      root: process.cwd(),
      run,
      changedPathsFn: () => ({ mergeBase: 'base-sha', paths }),
      collectProvenance: provenance,
      writeReceipt: vi.fn(),
    });
    expect(result.diagnostic).toBe(true);
    expect(result.completion).toBe(false);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        'run',
        'packages/sdk/src/__tests__/publicBarrel.test.ts',
        'src-server/security/__tests__/pairing-route-scopes.test.ts',
      ]),
    );
  });
  test('keeps an isolated SDK root-barrel change on conservative related selection', () => {
    const selection = selectChangedVerification(['packages/sdk/src/index.ts']);
    expect(selection.tests).toEqual([]);
    expect(selection.lanes).toEqual([]);
    expect(selection.relatedPaths).toEqual(['packages/sdk/src/index.ts']);
  });
  test('selects the browser bundle guard for both portable Pane entrypoints', () => {
    for (const path of [
      'packages/contracts/src/workspace-pane.ts',
      'packages/sdk/src/workspace-pane.ts',
    ]) {
      const selection = selectChangedVerification([path]);
      expect(selection.tests.map((entry) => entry.path)).toContain(
        'packages/sdk/src/__tests__/workspace-pane-browser-bundle.test.ts',
      );
    }
  });
  test('still escalates an unmapped high-fanout contract path', () => {
    const selection = selectChangedVerification([
      'packages/contracts/src/new-unmapped-contract.ts',
    ]);
    expect(selection.escalated).toBe(true);
    expect(selection.tests).toEqual([]);
    expect(selection.lanes).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'ci-fast' })]),
    );
  });
  test('does not match a specific dynamic seam by prefix', () => {
    const path = `${scenarios.sourceEdges.dynamicScript}.bak`;
    const selection = selectChangedVerification([path]);
    expect(selection.relatedPaths).toEqual([path]);
    expect(selection.tests).toEqual([]);
  });
  test('routes non-code fixture files to a bounded lane instead of related', () => {
    const selection = selectChangedVerification([
      scenarios.sourceEdges.fixtureReadme,
    ]);
    expect(selection.relatedPaths).toEqual([]);
    expect(selection.lanes).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'prepush' })]),
    );
  });
  test('accumulates stable reasons independently of changed-path order', () => {
    const paths = [
      scenarios.sourceEdges.dynamicScript,
      scenarios.deferredEdges.docs,
    ];
    expect(selectChangedVerification(paths)).toEqual(
      selectChangedVerification([...paths].reverse()),
    );
  });
  test('retains every sorted reason for a shared named lane', () => {
    const selection = selectChangedVerification([
      'docs/z-last.md',
      'docs/a-first.md',
    ]);
    expect(selection.lanes).toEqual([
      {
        id: 'prepush',
        reasons: [
          'documentation bounded gate: docs/a-first.md',
          'documentation bounded gate: docs/z-last.md',
        ],
      },
    ]);
  });
  test('captures committed, staged, unstaged, deleted, renamed, and untracked paths', () => {
    const responses = new Map([
      ['merge-base origin/main HEAD', 'base-sha\n'],
      [
        'diff --name-status -z base-sha..HEAD',
        `D\0${scenarios.gitChanges.deleted}\0`,
      ],
      [
        'diff --cached --name-status -z',
        `M\0${scenarios.gitChanges.staged}\0R100\0${scenarios.gitChanges.renamedFrom}\0${scenarios.gitChanges.renamedTo}\0`,
      ],
      ['diff --name-status -z', ''],
      [
        'ls-files --others --exclude-standard -z',
        `${scenarios.gitChanges.untracked}\0`,
      ],
    ]);
    const result = changedPaths({
      root: '/repo',
      base: 'origin/main',
      gitCommand: (_root, args) => responses.get(args.join(' ')) ?? '',
    });
    expect(result).toEqual({
      mergeBase: 'base-sha',
      paths: [
        scenarios.gitChanges.deleted,
        scenarios.gitChanges.renamedFrom,
        scenarios.gitChanges.renamedTo,
        scenarios.gitChanges.staged,
        scenarios.gitChanges.untracked,
      ].sort(),
    });
  });
  test('runs related source selection without broad surface globs', () => {
    const run = reportedRun();
    const writeReceipt = vi.fn();
    const result = runChangedVerification(['--base=origin/main'], {
      root: process.cwd(),
      run,
      changedPathsFn: () => ({
        mergeBase: 'base-sha',
        paths: [scenarios.sourceEdges.server],
      }),
      collectProvenance: provenance,
      writeReceipt,
    });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        'related',
        '--run',
        scenarios.sourceEdges.server,
      ]),
    );
    expect(result.executed.map((entry) => entry.kind)).toEqual(['related']);
    expect(run.mock.calls.flatMap(([, args]) => args)).not.toEqual(
      expect.arrayContaining([
        'test-full',
        'src-server/**/*.{test,spec}.{ts,tsx}',
      ]),
    );
    expect(result.receipt.terminal).toMatchObject({
      status: 'completed',
      passed: true,
    });
    expect(result.receipt.counts).toMatchObject({
      executed: 3,
      passed: 3,
      failed: 0,
      infrastructureErrors: 0,
    });
    expect(writeReceipt).toHaveBeenCalledTimes(3);
    expect(result.receipt.artifacts.map(({ path }) => path)).toEqual([
      '.kontourai/test-impact/changed-selection.json',
      '.kontourai/test-impact/changed-diagnostics.json',
    ]);
  });
  test('records an integer exit and infrastructure error when the explicit Vitest child has no status', () => {
    const result = runChangedVerification(['--base=origin/main'], {
      root: process.cwd(),
      run: reportedRun({
        status: null,
        report: null,
        result: { signal: 'SIGTERM' },
      }),
      changedPathsFn: () => ({
        mergeBase: 'base-sha',
        paths: [scenarios.sourceEdges.dynamicScript],
      }),
      collectProvenance: provenance,
      writeReceipt: vi.fn(),
    });

    expect(result.executed).toEqual([
      expect.objectContaining({
        kind: 'explicit',
        exitCode: 1,
        infrastructureError: true,
      }),
    ]);
  });
  test('persists stable diagnostics before removing the temporary Vitest report', () => {
    let temporaryReport = '';
    let existedAtStableWrite = false;
    const run = vi.fn((_command, args) => {
      temporaryReport = args
        .find((arg) => arg.startsWith('--outputFile='))
        .slice('--outputFile='.length);
      writeFileSync(temporaryReport, passingReport);
      return { status: 0 };
    });
    runChangedVerification(['--base=origin/main'], {
      root: process.cwd(),
      run,
      changedPathsFn: () => ({
        mergeBase: 'base-sha',
        paths: [scenarios.sourceEdges.server],
      }),
      collectProvenance: provenance,
      writeReceipt(path) {
        if (path === '.kontourai/test-impact/changed-diagnostics.json')
          existedAtStableWrite = existsSync(temporaryReport);
      },
    });
    expect(existedAtStableWrite).toBe(true);
    expect(existsSync(temporaryReport)).toBe(false);
  });
  test('runs a specific dynamic target without duplicating it through related', () => {
    const run = reportedRun();
    const result = runChangedVerification(['--base=origin/main'], {
      root: process.cwd(),
      run,
      changedPathsFn: () => ({
        mergeBase: 'base-sha',
        paths: [scenarios.sourceEdges.dynamicScript],
      }),
      collectProvenance: provenance,
      writeReceipt: vi.fn(),
    });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        'run',
        'scripts/__tests__/prepush-tier.test.ts',
        'scripts/__tests__/verification-lanes.test.ts',
      ]),
    );
    expect(result.executed.map((entry) => entry.kind)).toEqual(['explicit']);
  });
  test('keeps broad related-test expansion deferred', () => {
    const run = vi.fn();
    const result = runChangedVerification(['--base=origin/main'], {
      root: process.cwd(),
      run,
      changedPathsFn: () => ({
        mergeBase: 'base-sha',
        paths: [scenarios.sourceEdges.server, scenarios.deferredEdges.e2e],
      }),
      collectProvenance: provenance,
      writeReceipt: vi.fn(),
    });
    expect(run).not.toHaveBeenCalled();
    expect(result.executed).toEqual([]);
    expect(result.exitCode).toBe(3);
    expect(result.nextCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'verify-e2e-full',
          command: 'npm run verify:e2e:full',
        }),
      ]),
    );
    expect(result.receipt.terminal).toMatchObject({
      status: 'provisional',
      passed: false,
    });
  });
  test.each([false, true])(
    'runs known tests beside deferred obligations and propagates failures=%s',
    (fails) => {
      const run = reportedRun({
        status: fails ? 1 : 0,
        report: fails ? failingReport : passingReport,
      });
      const result = runChangedVerification(['--base=origin/main'], {
        root: process.cwd(),
        run,
        changedPathsFn: () => ({
          mergeBase: 'base-sha',
          paths: [
            'src-ui/src/components/modals/useNewChatSetupReturn.ts',
            scenarios.deferredEdges.e2e,
          ],
        }),
        collectProvenance: provenance,
        writeReceipt: vi.fn(),
      });
      expect(run).toHaveBeenCalledOnce();
      expect(run.mock.calls[0][1]).toEqual(
        expect.arrayContaining([
          'run',
          'src-ui/src/__tests__/NewChatModalEngineChips.test.tsx',
          'src-ui/src/__tests__/NewChatModalSetupReturn.test.tsx',
        ]),
      );
      expect(result.exitCode).toBe(fails ? 1 : 3);
      expect(result.receipt.terminal).toMatchObject({
        status: fails ? 'failed' : 'provisional',
        passed: false,
      });
      expect(result.nextCommands.length).toBeGreaterThan(0);
    },
  );

  test('explains without execution but never records a pass', () => {
    const result = runChangedVerification(['--base=origin/main', '--explain'], {
      root: process.cwd(),
      changedPathsFn: () => ({
        mergeBase: 'base-sha',
        paths: [scenarios.sourceEdges.server],
      }),
      collectProvenance: provenance,
      writeReceipt: vi.fn(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.receipt.terminal).toMatchObject({
      status: 'provisional',
      passed: false,
    });
  });
  test('derives affected product-law routing from the manifest and names the law ID', () => {
    const result = runChangedVerification(['--base=origin/main', '--explain'], {
      root: process.cwd(),
      changedPathsFn: () => ({
        mergeBase: 'base-sha',
        paths: ['src-ui/src/hooks/orchestration/queueDrain.ts'],
      }),
      collectProvenance: provenance,
      writeReceipt: vi.fn(),
    });
    expect(result.productLaws).toEqual([
      'station.queue-dispatch.ordered-drain',
    ]);
    expect(result.selection.lanes).toContainEqual({
      id: 'ci-fast',
      reasons: [
        'product-law disposition: station.queue-dispatch.ordered-drain',
      ],
    });
    expect(renderChangedVerificationSummary(result)).toContain(
      'product laws: station.queue-dispatch.ordered-drain',
    );
  });
  test('renders a bounded terminal handoff while retaining full selection only in the artifact', () => {
    const output = renderChangedVerificationSummary({
      paths: Array.from({ length: 20 }, (_, index) => `src/${index}.ts`),
      selection: {
        relatedPaths: Array.from(
          { length: 12 },
          (_, index) => `src/related-${index}.ts`,
        ),
        tests: Array.from({ length: 12 }, (_, index) => ({
          path: `scripts/__tests__/target-${index}.test.ts`,
          reasons: ['fixture'],
        })),
        lanes: Array.from({ length: 8 }, (_, index) => ({
          id: `lane-${index}`,
          reasons: ['fixture'],
        })),
      },
      receipt: { terminal: { status: 'provisional' } },
    });
    expect(output).toContain(
      '20 changed path(s); 24 focused target(s), 8 deferred lane(s)',
    );
    expect(output).toContain('scripts/__tests__/target-0.test.ts');
    expect(output).toContain('lane-0');
    expect(output).toContain('.kontourai/test-impact/changed-selection.json');
    expect(output).toContain('truncated');
    expect(output).not.toContain('src/related-9.ts');
    expect(Buffer.byteLength(output)).toBeLessThan(3_000);
  });
  test('counts an ordinary Vitest exit as a test failure, not infrastructure', () => {
    const writeReceipt = vi.fn();
    const result = runChangedVerification(['--base=origin/main'], {
      root: process.cwd(),
      run: reportedRun({
        status: 1,
        report: failingReport,
      }),
      changedPathsFn: () => ({
        mergeBase: 'base-sha',
        paths: [scenarios.sourceEdges.server],
      }),
      collectProvenance: provenance,
      writeReceipt,
    });
    expect(result.receipt).toMatchObject({
      terminal: { status: 'failed', passed: false },
      counts: { executed: 3, passed: 2, failed: 1, infrastructureErrors: 0 },
    });
    const diagnostics = JSON.parse(
      writeReceipt.mock.calls.find(
        ([path]) => path === '.kontourai/test-impact/changed-diagnostics.json',
      )?.[1],
    );
    expect(diagnostics).toMatchObject({
      complete: true,
      counts: { executed: 3, passed: 2, failed: 1 },
      executions: [
        {
          failureIdentitiesComplete: true,
          failedTests: [
            {
              file: 'example.test.ts',
              name: 'example contract preserves the failed identity',
              excerpt: expect.stringContaining('[REDACTED]'),
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(diagnostics)).not.toContain(
      'fixture-super-secret-token',
    );
  });
  test('marks aggregate failures without assertion identities incomplete', () => {
    const writeReceipt = vi.fn();
    runChangedVerification(['--base=origin/main'], {
      root: process.cwd(),
      run: reportedRun({
        status: 1,
        report: JSON.stringify({
          numTotalTestSuites: 1,
          numTotalTests: 3,
          numPassedTests: 2,
          numFailedTests: 1,
        }),
      }),
      changedPathsFn: () => ({
        mergeBase: 'base-sha',
        paths: [scenarios.sourceEdges.server],
      }),
      collectProvenance: provenance,
      writeReceipt,
    });
    const diagnostics = JSON.parse(
      writeReceipt.mock.calls.find(
        ([path]) => path === '.kontourai/test-impact/changed-diagnostics.json',
      )?.[1],
    );
    expect(diagnostics.complete).toBe(false);
    expect(diagnostics.executions[0]).toMatchObject({
      failureIdentitiesComplete: false,
      failureIdentityCount: 0,
      failedTests: [],
    });
  });
  test('does not trust green JSON when the Vitest child exits nonzero', () => {
    const writeReceipt = vi.fn();
    const result = runChangedVerification(['--base=origin/main'], {
      root: process.cwd(),
      run: reportedRun({ status: 1 }),
      changedPathsFn: () => ({
        mergeBase: 'base-sha',
        paths: [scenarios.sourceEdges.server],
      }),
      collectProvenance: provenance,
      writeReceipt,
    });
    expect(result.exitCode).toBe(1);
    expect(result.receipt).toMatchObject({
      terminal: { status: 'failed', exitCode: 1, passed: false },
      counts: { executed: 3, passed: 3, failed: 0, infrastructureErrors: 0 },
    });
    const diagnostics = JSON.parse(
      writeReceipt.mock.calls.find(
        ([path]) => path === '.kontourai/test-impact/changed-diagnostics.json',
      )?.[1],
    );
    expect(diagnostics).toMatchObject({
      complete: false,
      incompleteReasons: [
        'related: Vitest exited 1 without reporting a failed test',
      ],
    });
  });
  test('does not record an unstarted explicit plan as an execution after a related failure', () => {
    const run = reportedRun({ status: 1, report: passingReport });
    const writeReceipt = vi.fn();
    const result = runChangedVerification(['--base=origin/main'], {
      root: process.cwd(),
      run,
      changedPathsFn: () => ({
        mergeBase: 'base-sha',
        paths: [
          scenarios.sourceEdges.server,
          scenarios.sourceEdges.dynamicScript,
        ],
      }),
      collectProvenance: provenance,
      writeReceipt,
    });
    expect(run).toHaveBeenCalledOnce();
    expect(result.executed.map((entry) => entry.kind)).toEqual(['related']);
    const diagnostics = JSON.parse(
      writeReceipt.mock.calls.find(
        ([path]) => path === '.kontourai/test-impact/changed-diagnostics.json',
      )?.[1],
    );
    expect(diagnostics.executions.map(({ kind }) => kind)).toEqual(['related']);
    expect(diagnostics.incompleteReasons).toEqual([
      'related: Vitest exited 1 without reporting a failed test',
    ]);
  });
  test('records spawn failures as infrastructure errors', () => {
    const result = runChangedVerification(['--base=origin/main'], {
      root: process.cwd(),
      run: reportedRun({
        result: { status: null, error: new Error('ENOENT') },
      }),
      changedPathsFn: () => ({
        mergeBase: 'base-sha',
        paths: [scenarios.sourceEdges.server],
      }),
      collectProvenance: provenance,
      writeReceipt: vi.fn(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.receipt).toMatchObject({
      terminal: { status: 'infrastructure_error', passed: false },
      counts: { executed: 0, passed: 0, failed: 0, infrastructureErrors: 1 },
    });
  });
  test('captures provenance before spawning and rejects a drifted result', () => {
    const events: string[] = [];
    const run = reportedRun();
    const orderedRun = vi.fn((...args: Parameters<typeof run>) => {
      events.push('spawn');
      return run(...args);
    });
    let calls = 0;
    const result = runChangedVerification(['--base=origin/main'], {
      root: process.cwd(),
      run: orderedRun,
      changedPathsFn: () => ({
        mergeBase: 'base-sha',
        paths: [scenarios.sourceEdges.server],
      }),
      collectProvenance: () => {
        calls += 1;
        events.push(calls === 1 ? 'before' : 'after');
        return provenance(calls === 1 ? 'b'.repeat(64) : 'e'.repeat(64));
      },
      writeReceipt: vi.fn(),
    });
    expect(events).toEqual(['before', 'spawn', 'after']);
    expect(result.receipt).toMatchObject({
      terminal: { status: 'completed', passed: false },
      provenance: { stable: false },
    });
    expect(result.exitCode).toBe(1);
  });
  test('turns a valid zero-test report into a named provisional escalation', () => {
    const result = runChangedVerification(['--base=origin/main'], {
      root: process.cwd(),
      run: reportedRun({ report: zeroTestReport }),
      changedPathsFn: () => ({
        mergeBase: 'base-sha',
        paths: [scenarios.sourceEdges.server],
      }),
      collectProvenance: provenance,
      writeReceipt: vi.fn(),
    });
    expect(result.exitCode).toBe(3);
    expect(result.nextCommands).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'test-full' })]),
    );
    expect(result.receipt.terminal).toMatchObject({
      status: 'provisional',
      passed: false,
    });
  });
  test('reports a deliberate skip as skipped, not failed (#1737)', () => {
    const writeReceipt = vi.fn();
    const result = runChangedVerification(['--base=origin/main'], {
      root: process.cwd(),
      run: reportedRun({ status: 0, report: skippedReport }),
      changedPathsFn: () => ({
        mergeBase: 'base-sha',
        paths: [scenarios.sourceEdges.server],
      }),
      collectProvenance: provenance,
      writeReceipt,
    });
    expect(result.exitCode).toBe(0);
    expect(result.receipt).toMatchObject({
      terminal: { status: 'completed', passed: true, exitCode: 0 },
      // Four tests were reported; one ran. `executed` counts what ran, so the
      // receipt's `passed === executed` pass invariant still holds honestly.
      counts: { executed: 1, passed: 1, failed: 0, infrastructureErrors: 0 },
    });
    const diagnostics = JSON.parse(
      writeReceipt.mock.calls.find(
        ([path]) => path === '.kontourai/test-impact/changed-diagnostics.json',
      )?.[1],
    );
    expect(diagnostics.complete).toBe(true);
    expect(diagnostics.incompleteReasons).toEqual([]);
    expect(diagnostics.counts).toMatchObject({
      executed: 1,
      passed: 1,
      failed: 0,
      skipped: 2,
      todo: 1,
    });
    expect(diagnostics.executions[0]).toMatchObject({
      failureIdentitiesComplete: true,
      failedTests: [],
      counts: { failed: 0, skipped: 2, todo: 1 },
    });
  });
  test('fails closed when a report leaves an outcome unaccounted for', () => {
    const result = runChangedVerification(['--base=origin/main'], {
      root: process.cwd(),
      run: reportedRun({
        report: JSON.stringify({
          numTotalTestSuites: 1,
          numTotalTests: 5,
          numPassedTests: 2,
          numFailedTests: 1,
          numPendingTests: 1,
          numTodoTests: 0,
        }),
      }),
      changedPathsFn: () => ({
        mergeBase: 'base-sha',
        paths: [scenarios.sourceEdges.server],
      }),
      collectProvenance: provenance,
      writeReceipt: vi.fn(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.receipt.terminal).toMatchObject({
      status: 'parser_error',
      passed: false,
    });
    expect(result.executed[0].error).toBe(
      'Vitest JSON report left 1 test outcome(s) unaccounted for',
    );
  });
  test('fails closed when a report double-counts an outcome', () => {
    const result = runChangedVerification(['--base=origin/main'], {
      root: process.cwd(),
      run: reportedRun({
        report: JSON.stringify({
          numTotalTestSuites: 1,
          numTotalTests: 2,
          numPassedTests: 1,
          numFailedTests: 0,
          numPendingTests: 1,
          numTodoTests: 1,
        }),
      }),
      changedPathsFn: () => ({
        mergeBase: 'base-sha',
        paths: [scenarios.sourceEdges.server],
      }),
      collectProvenance: provenance,
      writeReceipt: vi.fn(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.executed[0].error).toBe(
      'Vitest JSON report counted overlapping test outcomes',
    );
  });
  test('fails closed when a test never finished rather than calling it skipped', () => {
    const result = runChangedVerification(['--base=origin/main'], {
      root: process.cwd(),
      run: reportedRun({
        report: JSON.stringify({
          numTotalTestSuites: 1,
          numTotalTests: 2,
          numPassedTests: 1,
          numFailedTests: 0,
          numPendingTests: 1,
          numTodoTests: 0,
          testResults: [
            {
              name: 'example.test.ts',
              assertionResults: [
                { fullName: 'ran', status: 'passed', failureMessages: [] },
                {
                  fullName: 'never settled',
                  // Vitest maps a still-running or queued test to `pending`.
                  status: 'pending',
                  failureMessages: [],
                },
              ],
            },
          ],
        }),
      }),
      changedPathsFn: () => ({
        mergeBase: 'base-sha',
        paths: [scenarios.sourceEdges.server],
      }),
      collectProvenance: provenance,
      writeReceipt: vi.fn(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.receipt.terminal).toMatchObject({ status: 'parser_error' });
    expect(result.executed[0].error).toBe(
      'Vitest JSON report contains 1 test(s) that never finished',
    );
  });
  test('escalates a selection in which every test declined to run', () => {
    const writeReceipt = vi.fn();
    const result = runChangedVerification(['--base=origin/main'], {
      root: process.cwd(),
      run: reportedRun({
        report: JSON.stringify({
          numTotalTestSuites: 1,
          numTotalTests: 3,
          numPassedTests: 0,
          numFailedTests: 0,
          numPendingTests: 3,
          numTodoTests: 0,
        }),
      }),
      changedPathsFn: () => ({
        mergeBase: 'base-sha',
        paths: [scenarios.sourceEdges.server],
      }),
      collectProvenance: provenance,
      writeReceipt,
    });
    expect(result.exitCode).toBe(3);
    expect(result.receipt.terminal).toMatchObject({
      status: 'provisional',
      passed: false,
    });
    expect(
      result.selection.lanes.find((lane) => lane.id === 'test-full')?.reasons,
    ).toEqual([
      'Vitest executed zero of 3 selected test(s) (3 skipped, 0 todo) for related verification',
    ]);
    const diagnostics = JSON.parse(
      writeReceipt.mock.calls.find(
        ([path]) => path === '.kontourai/test-impact/changed-diagnostics.json',
      )?.[1],
    );
    expect(diagnostics.complete).toBe(false);
    expect(diagnostics.incompleteReasons).toEqual([
      'related: Vitest executed zero of 3 selected test(s) (3 skipped, 0 todo)',
    ]);
  });
  test('names the identity shortfall when failures outrun the identity bound', () => {
    const writeReceipt = vi.fn();
    runChangedVerification(['--base=origin/main'], {
      root: process.cwd(),
      run: reportedRun({
        status: 1,
        report: JSON.stringify({
          numTotalTestSuites: 1,
          numTotalTests: 25,
          numPassedTests: 0,
          numFailedTests: 25,
          numPendingTests: 0,
          numTodoTests: 0,
          testResults: [
            {
              name: 'example.test.ts',
              assertionResults: Array.from({ length: 25 }, (_, index) => ({
                fullName: `failure ${index}`,
                status: 'failed',
                failureMessages: ['boom'],
              })),
            },
          ],
        }),
      }),
      changedPathsFn: () => ({
        mergeBase: 'base-sha',
        paths: [scenarios.sourceEdges.server],
      }),
      collectProvenance: provenance,
      writeReceipt,
    });
    const diagnostics = JSON.parse(
      writeReceipt.mock.calls.find(
        ([path]) => path === '.kontourai/test-impact/changed-diagnostics.json',
      )?.[1],
    );
    expect(diagnostics.complete).toBe(false);
    expect(diagnostics.incompleteReasons).toEqual([
      'related: 25 failing test(s), 25 identified, 5 omitted',
    ]);
  });
  test('fails closed when Vitest does not produce a valid JSON report', () => {
    const result = runChangedVerification(['--base=origin/main'], {
      root: process.cwd(),
      run: reportedRun({ report: '{not json' }),
      changedPathsFn: () => ({
        mergeBase: 'base-sha',
        paths: [scenarios.sourceEdges.server],
      }),
      collectProvenance: provenance,
      writeReceipt: vi.fn(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.receipt.terminal).toMatchObject({
      status: 'parser_error',
      passed: false,
    });
  });
  test('escalates a deleted related path to test-full without spawning', () => {
    const run = vi.fn();
    const result = runChangedVerification(['--base=origin/main'], {
      root: process.cwd(),
      run,
      changedPathsFn: () => ({
        mergeBase: 'base-sha',
        paths: [scenarios.gitChanges.deleted],
      }),
      collectProvenance: provenance,
      writeReceipt: vi.fn(),
    });
    expect(run).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(3);
    expect(result.nextCommands).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'test-full' })]),
    );
    expect(result.selection.lanes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'test-full',
          reasons: [
            `unavailable related path: ${scenarios.gitChanges.deleted}`,
          ],
        }),
      ]),
    );
  });
  test('rejects a malformed receipt and an incorrect lane', () => {
    expect(
      validateChangedVerificationReceipt({
        request: { laneId: 'ci-fast' },
      }),
    ).toEqual(
      expect.arrayContaining([
        'changed verification receipt must use the test-changed lane',
        expect.stringContaining('schema validation failed'),
      ]),
    );
  });
  test('makes deletion of a required dynamic edge a validation failure', () => {
    const withoutNative = TEST_IMPACT_MANIFEST.filter(
      (edge) => edge.pattern !== 'src-desktop/**',
    );
    expect(validateTestImpactManifest(withoutNative)).toContain(
      'required impact edge missing: src-desktop/**',
    );
  });
  test.each(E2E_CONTRACT_BOUNDARIES)(
    'makes deletion of E2E control boundary %s a validation failure',
    (boundary) => {
      const withoutBoundary = TEST_IMPACT_MANIFEST.filter(
        (edge) => edge.pattern !== boundary,
      );
      expect(validateTestImpactManifest(withoutBoundary)).toContain(
        `required impact edge missing: ${boundary}`,
      );
    },
  );
  test.each([
    [
      'removal',
      TEST_IMPACT_MANIFEST.filter(
        (edge) =>
          edge.pattern !== TAILSCALE_PUBLIC_INGRESS_IMPACT_BOUNDARY.pattern,
      ),
      `required Tailscale ingress impact edge must be unique: ${TAILSCALE_PUBLIC_INGRESS_IMPACT_BOUNDARY.pattern} (found 0)`,
    ],
    [
      'narrowing',
      TEST_IMPACT_MANIFEST.map((edge) =>
        edge.pattern === TAILSCALE_PUBLIC_INGRESS_IMPACT_BOUNDARY.pattern
          ? {
              ...edge,
              tests: [TAILSCALE_PUBLIC_INGRESS_IMPACT_BOUNDARY.tests[0]],
            }
          : edge,
      ),
      `required Tailscale ingress impact edge must select exactly resolver and device-pairing route tests: ${TAILSCALE_PUBLIC_INGRESS_IMPACT_BOUNDARY.pattern}`,
    ],
    [
      'related-only',
      TEST_IMPACT_MANIFEST.map((edge) =>
        edge.pattern === TAILSCALE_PUBLIC_INGRESS_IMPACT_BOUNDARY.pattern
          ? { ...edge, tests: undefined, related: true }
          : edge,
      ),
      `required Tailscale ingress impact edge must select exactly resolver and device-pairing route tests: ${TAILSCALE_PUBLIC_INGRESS_IMPACT_BOUNDARY.pattern}`,
    ],
    [
      'conflicting duplicate',
      [
        ...TEST_IMPACT_MANIFEST,
        {
          pattern: TAILSCALE_PUBLIC_INGRESS_IMPACT_BOUNDARY.pattern,
          tests: ['scripts/__tests__/changed-verification.test.ts'],
          reason: 'conflicting duplicate',
        },
      ],
      `required Tailscale ingress impact edge must be unique: ${TAILSCALE_PUBLIC_INGRESS_IMPACT_BOUNDARY.pattern} (found 2)`,
    ],
  ] as const)(
    'rejects Tailscale ingress boundary %s',
    (_name, manifest, expected) => {
      expect(validateTestImpactManifest(manifest)).toContain(expected);
    },
  );
  test.each(E2E_CONTRACT_BOUNDARIES)(
    'rejects prepush substitution for E2E control boundary %s',
    (boundary) => {
      const substituted = TEST_IMPACT_MANIFEST.map((edge) =>
        edge.pattern === boundary
          ? {
              pattern: boundary,
              lanes: ['prepush'],
              reason: edge.reason,
            }
          : edge,
      );
      expect(validateTestImpactManifest(substituted)).toContain(
        `required E2E contract edge must be exactly verify-e2e-full: ${boundary}`,
      );
    },
  );
  test.each(E2E_CONTRACT_BOUNDARIES)(
    'rejects related-only E2E control boundary %s',
    (boundary) => {
      const relatedOnly = TEST_IMPACT_MANIFEST.map((edge) =>
        edge.pattern === boundary
          ? { pattern: boundary, related: true, reason: edge.reason }
          : edge,
      );
      expect(validateTestImpactManifest(relatedOnly)).toContain(
        `required E2E contract edge must be exactly verify-e2e-full: ${boundary}`,
      );
    },
  );
  test.each(E2E_CONTRACT_BOUNDARIES)(
    'rejects a missing E2E lane for control boundary %s',
    (boundary) => {
      const missingLanes = TEST_IMPACT_MANIFEST.map((edge) =>
        edge.pattern === boundary
          ? { pattern: boundary, reason: edge.reason }
          : edge,
      );
      expect(validateTestImpactManifest(missingLanes)).toContain(
        `required E2E contract edge must be exactly verify-e2e-full: ${boundary}`,
      );
    },
  );
  test.each(E2E_CONTRACT_BOUNDARIES)(
    'rejects a conflicting duplicate E2E control boundary %s',
    (boundary) => {
      const duplicate = [
        ...TEST_IMPACT_MANIFEST,
        {
          pattern: boundary,
          lanes: ['prepush'],
          reason: 'conflicting test duplicate',
        },
      ];
      expect(validateTestImpactManifest(duplicate)).toContain(
        `required E2E contract edge must be unique: ${boundary} (found 2)`,
      );
    },
  );
  test('runs the representative narrow diff through non-explain selection and reports timing/counts', () => {
    const worktreeCommand = vi.fn();
    const runChanged = vi.fn(() => ({
      selection: {
        relatedPaths: ['src-server/routes/chat/__tests__/chat-context.test.ts'],
      },
      receipt: { counts: { executed: 12, passed: 12, failed: 0 } },
      exitCode: 0,
    }));
    const now = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(145);
    // Stub Git worktree creation so this unit test does not touch the real
    // repository, while leaving the production helper's real selector call
    // and isolation lifecycle observable.
    worktreeCommand.mockImplementation((args: string[]) => {
      if (args[1] === 'add') {
        const fixtureRoot = args[3];
        mkdirSync(fixtureRoot, { recursive: true });
        writeFileSync(
          join(fixtureRoot, 'package.json'),
          readFileSync(join(process.cwd(), 'package.json')),
        );
        writeFileSync(
          join(fixtureRoot, 'pnpm-workspace.yaml'),
          readFileSync(join(process.cwd(), 'pnpm-workspace.yaml')),
        );
        // Materialize every workspace the copied root manifest declares — a
        // hardcoded list here silently diverges when a package is added to
        // the real manifest (station#4200's board-pane ENOENTed the
        // provenance walk until this derived).
        const declaredWorkspaces = JSON.parse(
          readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
        ).workspaces as string[];
        for (const workspace of declaredWorkspaces) {
          mkdirSync(join(fixtureRoot, workspace), { recursive: true });
          writeFileSync(
            join(fixtureRoot, workspace, 'package.json'),
            readFileSync(join(process.cwd(), workspace, 'package.json')),
          );
        }
        const target = `${fixtureRoot}/src-server/routes/chat/__tests__/chat-context.test.ts`;
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, 'export {}\n');
      }
    });
    expect(
      runRepresentativeNarrowDiffFixture({
        root: process.cwd(),
        runChanged,
        now,
        worktreeCommand,
      }),
    ).toEqual({
      fixture: 'src-server/routes/chat/__tests__/chat-context.test.ts',
      elapsedMs: 45,
      counts: { executed: 12, passed: 12, failed: 0 },
      selection: {
        relatedPaths: ['src-server/routes/chat/__tests__/chat-context.test.ts'],
      },
      exitCode: 0,
    });
    expect(runChanged).toHaveBeenCalledWith(['--base=HEAD'], {
      root: expect.stringContaining('station-test-changed-fixture-'),
      vitestPath: expect.stringContaining('node_modules/vitest/vitest.mjs'),
    });
    expect(worktreeCommand).toHaveBeenNthCalledWith(
      1,
      ['worktree', 'add', '--detach', expect.any(String), 'HEAD'],
      process.cwd(),
    );
    expect(worktreeCommand).toHaveBeenNthCalledWith(
      2,
      ['worktree', 'remove', '--force', expect.any(String)],
      process.cwd(),
    );
  });

  test('runs the representative narrow diff through the real CLI and fixture-local dependencies', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/run-changed-verification.mjs', '--representative-narrow-diff'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain(
      'workspace dependency provenance rejected',
    );
    expect(result.stdout).toContain('[test:changed] 0 changed path(s)');
    expect(result.stdout).toContain(
      'src-server/routes/chat/__tests__/chat-context.test.ts',
    );
  }, 35_000);
});
