import {
  invertPathReadPins,
  scanPathReadPins,
} from './lib/path-read-pin-scan.mjs';

/**
 * E2E contract seams that Vitest import analysis cannot safely infer. Keep
 * this list exact: an ordinary script still receives related-test selection,
 * while a change that controls how the Playwright product contract is built,
 * selected, or configured must request the complete E2E lane.
 */
export const E2E_CONTRACT_BOUNDARIES = Object.freeze([
  'scripts/run-e2e-suite.mjs',
  'scripts/run-e2e-coverage.mjs',
  'scripts/lib/e2e-runner-options.mjs',
  'tests/e2e-manifest.mjs',
  'playwright.config.ts',
]);

export const TAILSCALE_PUBLIC_INGRESS_IMPACT_BOUNDARY = Object.freeze({
  pattern: 'src-server/services/tailscale/public-ingress-origin.ts',
  tests: Object.freeze([
    'src-server/services/tailscale/__tests__/public-ingress-origin.test.ts',
    'src-server/runtime/__tests__/device-pairing-routes.test.ts',
  ]),
});

const SCOPED_INSTRUCTION_EDGES = Object.freeze(
  [
    'src-server',
    'src-ui',
    'scripts',
    'src-desktop',
    'packages/contracts',
    'packages/sdk',
    'tests',
  ].flatMap((directory) => [
    {
      pattern: `${directory}/AGENTS.md`,
      tests: ['scripts/__tests__/agent-instructions-gate.test.ts'],
      reason: 'required routed instruction scope',
    },
    {
      pattern: `${directory}/CLAUDE.md`,
      tests: ['scripts/__tests__/agent-instructions-gate.test.ts'],
      reason: 'required Claude scoped import',
    },
  ]),
);

/** Repository data readers and explicit runtime seams supplementing import analysis. */
export const GOVERNED_REPO_DATA_EDGES = Object.freeze([
  {
    pattern: 'packages/contracts/src/engine-capability-matrix.ts',
    related: true,
    tests: [
      'packages/contracts/src/__tests__/engine-capability-matrix.test.ts',
      'src-server/services/orchestration/__tests__/attached-session-adoption.test.ts',
      'src-server/services/orchestration/__tests__/orchestration-service.test.ts',
    ],
    reason:
      'engine continuation declarations control adoption command admission',
  },
  {
    pattern: 'src-server/services/orchestration/attached-session-adoption.ts',
    related: true,
    tests: [
      'src-server/services/orchestration/__tests__/attached-session-adoption.test.ts',
      'src-server/services/orchestration/__tests__/orchestration-service.test.ts',
    ],
    reason:
      'adoption support, model planning, and adapter readiness must compose',
  },
  {
    pattern: 'src-server/runtime/frameworks/strands-message-sync.ts',
    related: true,
    tests: [
      'scripts/__tests__/proof-repo-guardrails-fail-closed.test.ts',
      'src-server/runtime/frameworks/__tests__/strands-message-sync.test.ts',
      'src-server/runtime/frameworks/__tests__/strands-native-history.test.ts',
    ],
    reason:
      'source-reading helper boundary plus actual native history persistence',
  },
  {
    // Explicit only: nothing imports the proof runner, so offering it to
    // related discovery yields an empty graph, which the changed lane
    // correctly refuses as an infrastructure failure — and did, on every
    // pull request that touched only this file.
    pattern: 'scripts/proof-repo-guardrails.mjs',
    tests: [
      'scripts/__tests__/proof-repo-guardrails-fail-closed.test.ts',
      'scripts/__tests__/repo-guardrail-source.test.ts',
    ],
    reason:
      'the proof runner is executed as a child and read as source, outside ' +
      'Vitest import analysis',
  },
  {
    pattern: 'src-ui/src/index.css',
    related: true,
    tests: ['src-ui/src/__tests__/ChatDockActiveIdentity.overflow.test.tsx'],
    reason:
      'the identity browser fixture reads the complete stylesheet as data',
  },
  {
    pattern: 'packages/sdk/src/client/**',
    related: true,
    tests: ['packages/sdk/src/__tests__/client-entry-portability.test.ts'],
    reason:
      'portable client dependency scan reads source outside the import graph',
  },
  {
    pattern: 'packages/cli/src/commands/session-client.ts',
    related: true,
    tests: [
      'packages/cli/src/__tests__/core.test.ts',
      'packages/cli/src/__tests__/core-http.test.ts',
    ],
    reason:
      'accepted-turn observation must preserve command and HTTP contracts',
  },
  {
    pattern: 'src-ui/src/components/modals/useNewChatSetupReturn.ts',
    tests: [
      'src-ui/src/__tests__/NewChatModalEngineChips.test.tsx',
      'src-ui/src/__tests__/NewChatModalSetupReturn.test.tsx',
    ],
    reason: 'setup changes must preserve repair routing and return behavior',
  },
  {
    pattern: 'docs/conformance/**',
    tests: ['scripts/__tests__/repo-docs-hygiene.test.ts'],
    reason: 'public repository documentation privacy boundary',
  },

  Object.freeze({
    pattern: '.github/ISSUE_TEMPLATE/**',
    tests: Object.freeze([
      'scripts/__tests__/public-contribution-surfaces.test.ts',
      'scripts/__tests__/security-report-link.test.ts',
    ]),
    reason: 'public issue templates are governed contribution data',
  }),
  Object.freeze({
    pattern: '.github/CODEOWNERS',
    tests: Object.freeze([
      'scripts/__tests__/public-contribution-surfaces.test.ts',
    ]),
    reason: 'narrow protected roots are governed contribution data',
  }),
  Object.freeze({
    pattern: '.github/pull_request_template.md',
    tests: Object.freeze([
      'scripts/__tests__/public-contribution-surfaces.test.ts',
    ]),
    reason: 'pull-request evidence contract is governed contribution data',
  }),
  Object.freeze({
    pattern: 'docs/pages/README.md',
    tests: Object.freeze([
      'scripts/__tests__/product-docs-source-links.test.ts',
    ]),
    reason: 'public-documentation topology and verification boundary',
  }),
  Object.freeze({
    pattern: 'CONTRIBUTING.md',
    tests: Object.freeze([
      'scripts/__tests__/public-contribution-surfaces.test.ts',
      'scripts/__tests__/documentation-foundations.test.ts',
      'scripts/__tests__/just-interface.test.ts',
    ]),
    reason: 'contributor routing is governed contribution data',
  }),
  Object.freeze({
    pattern: 'docs/user/contributing.md',
    tests: Object.freeze([
      'scripts/__tests__/public-contribution-surfaces.test.ts',
      'scripts/__tests__/product-docs-source-links.test.ts',
      'scripts/__tests__/public-doc-contract-examples.test.ts',
    ]),
    reason: 'public contribution guide is governed documentation data',
  }),
  Object.freeze({
    pattern: 'docs/pages/public-docs.json',
    tests: Object.freeze([
      'scripts/__tests__/public-contribution-surfaces.test.ts',
      'scripts/__tests__/product-docs-source-links.test.ts',
      'scripts/__tests__/public-doc-contract-examples.test.ts',
    ]),
    reason: 'public documentation admission is governed data',
  }),
  Object.freeze({
    pattern: '.github/workflows/**',
    tests: Object.freeze([
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
    ]),
    reason: 'workflow files are governed as repository data',
  }),
  Object.freeze({
    pattern: '.github/workflows/publish-release.yml',
    tests: Object.freeze([
      'scripts/__tests__/release-availability-driver.test.ts',
      'scripts/__tests__/release-availability.test.ts',
    ]),
    reason:
      'release availability reads the terminal workflow topology directly',
  }),
  Object.freeze({
    pattern: '.github/workflows/codex-pr-review.yml',
    tests: Object.freeze(['scripts/__tests__/codex-review-workflow.test.ts']),
    reason:
      'the review-workflow contract test parses this YAML by path (#1722 red the nightly a day after its dependabot bump)',
  }),
  Object.freeze({
    pattern: '.github/labels.json',
    tests: Object.freeze([
      'scripts/__tests__/label-manifest.test.ts',
      'scripts/__tests__/issue-lifecycle-reducer.test.ts',
    ]),
    reason: 'declared GitHub label contract',
  }),
  Object.freeze({
    pattern: '.veritas/**',
    tests: Object.freeze([
      'scripts/__tests__/evidence-check-execution-gate.test.ts',
      'scripts/__tests__/proof-family-lane-governance.test.ts',
      'scripts/__tests__/veritas-readiness-evidence.test.ts',
      'scripts/__tests__/veritas-repo-map.test.ts',
    ]),
    reason: 'Veritas config is governed as repository data',
  }),
  Object.freeze({
    pattern: 'scripts/evidence-check-execution.json',
    tests: Object.freeze([
      'scripts/__tests__/evidence-check-execution-gate.test.ts',
    ]),
    reason: 'evidence-check mapping is governed as repository data',
  }),
  Object.freeze({
    pattern: 'veritas.claims.json',
    tests: Object.freeze(['scripts/__tests__/veritas-repo-map.test.ts']),
    reason: 'Veritas claims are governed as repository data',
  }),
  Object.freeze({
    pattern: 'scripts/dependency-advisory-exceptions.json',
    tests: Object.freeze([
      'scripts/__tests__/dependency-advisory-policy.test.ts',
    ]),
    reason:
      'the advisory residual ledger is read via readFileSync by the policy ' +
      'script and its test, not imported, so a ledger-only change has no ' +
      'related-file edge and the selector reported an infrastructure error ' +
      'instead of running the policy test (station#1753)',
  }),
  Object.freeze({
    pattern: 'scripts/mobile-css-baseline.json',
    tests: Object.freeze(['scripts/__tests__/mobile-css-ratchet.test.ts']),
    reason:
      'the mobile-css ratchet baseline is read via readFileSync, not ' +
      'imported, so Vitest related-file discovery cannot see the edge to ' +
      'its own test on its own (station#1711)',
  }),
]);

/** Deterministic, reviewable edges the runtime dependency graph cannot see. */
/**
 * Scripts no test imports, whose only coverage runs the script (directly or
 * as a copy of its source) or reads its source from a test Vitest's import
 * graph therefore cannot reach. Before these edges a diff touching one of
 * them produced an empty related selection.
 *
 * An edge is only listed when a change to the script itself could fail the
 * named test. A test that merely pins the script's command TEXT somewhere
 * else -- package.json, a workflow, the pre-push hook, another script's
 * source -- is deliberately NOT an edge: selecting it would report `executed
 * > 0` with no lane and a `completed` receipt for a script nothing exercised,
 * which is worse than the test-full deferral escalateEmptyRelatedSelection
 * leaves behind. Seven such candidates were rejected for exactly that reason.
 *
 * `related` stays true so a future importing test supplements the edge rather
 * than replacing it (selectChangedVerification treats tests + related as a
 * supplement).
 */
const EXECUTED_SCRIPT_EDGE_REASON =
  'script is run by its test rather than imported, so the import graph has ' +
  'no edge to it (#1757)';
const SOURCE_READ_SCRIPT_EDGE_REASON =
  'script source is read and asserted by its test rather than imported, so ' +
  'the import graph has no edge to it (#1757)';

export const SPAWNED_SCRIPT_EDGES = Object.freeze([
  Object.freeze({
    pattern: 'scripts/build-desktop.mjs',
    related: true,
    tests: Object.freeze(['scripts/__tests__/desktop-build-manifest.test.ts']),
    reason: EXECUTED_SCRIPT_EDGE_REASON,
  }),
  Object.freeze({
    pattern: 'scripts/check-dist-freshness.mjs',
    related: true,
    tests: Object.freeze([
      'scripts/__tests__/guardrail-known-bad-fixtures.test.ts',
    ]),
    reason: EXECUTED_SCRIPT_EDGE_REASON,
  }),
  Object.freeze({
    pattern: 'scripts/ecosystem-manifest.mjs',
    related: true,
    tests: Object.freeze(['scripts/__tests__/ecosystem-manifest.test.ts']),
    reason: EXECUTED_SCRIPT_EDGE_REASON,
  }),
  Object.freeze({
    pattern: 'scripts/evidence-check-execution-gate.mjs',
    related: true,
    tests: Object.freeze([
      'scripts/__tests__/evidence-check-execution-gate.test.ts',
    ]),
    reason: EXECUTED_SCRIPT_EDGE_REASON,
  }),
  Object.freeze({
    pattern: 'scripts/literal-swap-gate.mjs',
    related: true,
    tests: Object.freeze(['scripts/__tests__/literal-swap-gate.test.ts']),
    reason: EXECUTED_SCRIPT_EDGE_REASON,
  }),
  Object.freeze({
    pattern: 'scripts/merge-ui-bundle-budget.mjs',
    related: true,
    tests: Object.freeze(['scripts/__tests__/ui-bundle-budget.test.ts']),
    reason: EXECUTED_SCRIPT_EDGE_REASON,
  }),
  Object.freeze({
    pattern: 'scripts/release-cohort-workflow.mjs',
    related: true,
    tests: Object.freeze(['scripts/__tests__/release-cohort.test.ts']),
    reason: EXECUTED_SCRIPT_EDGE_REASON,
  }),
  Object.freeze({
    pattern: 'scripts/voice-realtime-live-smoke.mjs',
    related: true,
    tests: Object.freeze([
      'scripts/__tests__/voice-realtime-live-smoke.test.ts',
    ]),
    reason: EXECUTED_SCRIPT_EDGE_REASON,
  }),
  Object.freeze({
    pattern: 'scripts/write-dist-stamp.mjs',
    related: true,
    tests: Object.freeze([
      'scripts/__tests__/guardrail-known-bad-fixtures.test.ts',
    ]),
    reason: EXECUTED_SCRIPT_EDGE_REASON,
  }),
  Object.freeze({
    pattern: 'scripts/build-desktop-resources.mjs',
    related: true,
    tests: Object.freeze([
      'scripts/__tests__/server-build-portability.test.ts',
    ]),
    reason: SOURCE_READ_SCRIPT_EDGE_REASON,
  }),
  Object.freeze({
    pattern: 'scripts/check-mobile-compile.mjs',
    related: true,
    tests: Object.freeze(['scripts/__tests__/verification-lanes.test.ts']),
    reason: SOURCE_READ_SCRIPT_EDGE_REASON,
  }),
]);

export const TEST_IMPACT_MANIFEST = Object.freeze([
  {
    pattern: 'src-desktop/Cargo.toml',
    tests: ['scripts/__tests__/tauri-webdriver-boundary.test.ts'],
    reason: 'embedded WebDriver dependency boundary',
  },
  {
    pattern: 'src-desktop/tauri.webdriver.conf.json',
    tests: ['scripts/__tests__/tauri-webdriver-boundary.test.ts'],
    reason: 'embedded WebDriver application identity boundary',
  },
  {
    pattern: 'tests/tauri-shell/direct-webdriver.ts',
    tests: ['scripts/__tests__/tauri-webdriver-boundary.test.ts'],
    reason: 'embedded WebDriver test harness boundary',
  },
  {
    pattern: 'src-server/runtime/routes/runtime-routes.ts',
    tests: [
      'src-server/runtime/routes/__tests__/runtime-routes-hosted-mcp-composition.test.ts',
      'src-server/runtime/routes/__tests__/runtime-routes-usage-telemetry-late-binding.test.ts',
    ],
    reason: 'runtime route composition and hosted MCP capability coverage',
  },
  {
    pattern:
      'src-server/services/orchestration/completed-task-dispatch-recovery.ts',
    tests: [
      'src-server/runtime/routes/__tests__/runtime-routes-hosted-mcp-composition.test.ts',
      'src-server/runtime/routes/__tests__/runtime-routes-usage-telemetry-late-binding.test.ts',
      'src-server/services/orchestration/__tests__/completed-task-dispatch-recovery.test.ts',
    ],
    reason: 'boot-time dispatch recovery must compose with runtime routes',
  },
  {
    pattern:
      'src-server/runtime/__tests__/orchestration-transfer-budget.integration.test.ts',
    tests: [
      'src-server/runtime/__tests__/orchestration-transfer-budget.integration.test.ts',
      'src-server/__test-utils__/__tests__/http-transfer-recorder.test.ts',
    ],
    reason: 'real loopback orchestration transfer measurement',
  },
  {
    pattern: 'src-server/__test-utils__/orchestration-transfer-fixture.ts',
    tests: [
      'src-server/runtime/__tests__/orchestration-transfer-budget.integration.test.ts',
    ],
    reason: 'deterministic orchestration transfer fixture',
  },
  {
    pattern: 'src-server/__test-utils__/orchestration-transfer-scenario.ts',
    tests: [
      'src-server/runtime/__tests__/orchestration-transfer-budget.integration.test.ts',
      'scripts/__tests__/orchestration-transfer-budget.test.ts',
    ],
    reason: 'shared external/native transfer measurer',
  },
  {
    pattern: 'src-server/__test-utils__/http-transfer-recorder.ts',
    tests: [
      'src-server/runtime/__tests__/orchestration-transfer-budget.integration.test.ts',
      'src-server/__test-utils__/__tests__/http-transfer-recorder.test.ts',
    ],
    reason: 'HTTP/SSE socket byte recorder',
  },
  {
    pattern: 'scripts/orchestration-transfer-budget.mjs',
    tests: ['scripts/__tests__/orchestration-transfer-budget.test.ts'],
    reason: 'fail-closed orchestration transfer comparator',
  },
  {
    pattern: 'scripts/orchestration-transfer-capture.ts',
    tests: [
      'src-server/runtime/__tests__/orchestration-transfer-budget.integration.test.ts',
      'scripts/__tests__/orchestration-transfer-budget.test.ts',
    ],
    reason: 'exact-root orchestration transfer capture runner',
  },
  {
    pattern: 'scripts/orchestration-transfer-gate.mjs',
    tests: ['scripts/__tests__/orchestration-transfer-gate.test.ts'],
    reason: 'exact-main transfer comparison gate',
  },
  {
    pattern: 'scripts/check-prepush-orchestration-transfer.mjs',
    tests: [
      'scripts/__tests__/orchestration-transfer-budget.test.ts',
      'scripts/__tests__/gate-for.test.ts',
      'scripts/__tests__/prepush-orchestration-transfer.test.ts',
    ],
    reason: 'orchestration transfer pre-push scope decider',
  },
  {
    pattern: 'scripts/fixtures/orchestration-transfer/budget.json',
    tests: ['scripts/__tests__/orchestration-transfer-budget.test.ts'],
    reason: 'orchestration transfer policy',
  },
  ...GOVERNED_REPO_DATA_EDGES,
  {
    pattern: 'AGENTS.md',
    tests: [
      'scripts/__tests__/agent-instructions-gate.test.ts',
      'scripts/__tests__/verification-policy-gate.test.ts',
      'scripts/__tests__/trust-reconcile-manifest.test.ts',
    ],
    reason: 'root instruction routing, completion evidence, and wrapper policy',
  },
  {
    pattern: 'CLAUDE.md',
    tests: ['scripts/__tests__/agent-instructions-gate.test.ts'],
    reason: 'root harness wrapper and governance-byte contract',
  },
  {
    pattern: 'scripts/agent-instructions-manifest.mjs',
    tests: ['scripts/__tests__/agent-instructions-gate.test.ts'],
    reason: 'instruction topology, routing, ownership, and budget authority',
  },
  {
    pattern: 'scripts/agent-instructions-gate.mjs',
    tests: [
      'scripts/__tests__/agent-instructions-gate.test.ts',
      'scripts/__tests__/verification-policy-gate.test.ts',
    ],
    reason:
      'deterministic instruction validation is a ci-fast policy invariant',
  },
  {
    pattern: 'docs/guides/testing.md',
    tests: [
      'scripts/__tests__/agent-instructions-gate.test.ts',
      'scripts/__tests__/verification-policy-gate.test.ts',
    ],
    reason:
      'sole generated verification-policy owner and routed testing authority',
  },
  ...SCOPED_INSTRUCTION_EDGES,
  {
    // station#4177 review MEDIUM: the WSL quarantine's exact-list pin reads
    // the coordinator source via readFileSync, not import — module-graph
    // selection never picks the guard file for coordinator-only edits, so a
    // consistent two-sided quarantine growth would pass ci-fast silently.
    pattern: 'scripts/__tests__/verification-coordinator.test.ts',
    tests: ['scripts/__tests__/wsl-host-class.test.ts'],
    reason:
      'WSL quarantine exact-list pin parses this source outside the module graph',
  },
  {
    pattern: 'package.json',
    tests: ['scripts/__tests__/public-doc-contract-examples.test.ts'],
    reason: 'public npm-command example authority',
  },
  {
    pattern: 'src-server/openapi/spec.ts',
    tests: ['scripts/__tests__/public-doc-contract-examples.test.ts'],
    reason: 'public HTTP example route-inventory producer',
  },
  {
    pattern: 'scripts/generate-openapi.ts',
    tests: ['scripts/__tests__/public-doc-contract-examples.test.ts'],
    reason: 'public HTTP example route-inventory generator',
  },
  {
    pattern: 'docs/reference/openapi.json',
    tests: ['scripts/__tests__/public-doc-contract-examples.test.ts'],
    reason: 'generated public HTTP example route inventory',
  },
  {
    pattern: 'scripts/public-doc-contract-examples.mjs',
    tests: ['scripts/__tests__/public-doc-contract-examples.test.ts'],
    reason: 'public command and HTTP example enforcement',
  },
  {
    pattern: 'docs/user/concepts.md',
    tests: ['scripts/__tests__/public-doc-contract-examples.test.ts'],
    reason: 'admitted public documentation examples',
  },
  {
    pattern: 'docs/guides/keyboard-shortcuts.md',
    tests: ['scripts/__tests__/public-doc-contract-examples.test.ts'],
    reason: 'admitted public documentation examples',
  },
  {
    pattern: 'scripts/release-availability-driver.mjs',
    tests: [
      'scripts/__tests__/release-availability-driver.test.ts',
      'scripts/__tests__/release-availability.test.ts',
    ],
    reason: 'public-release availability provider boundary',
  },
  {
    pattern: 'scripts/codeql-sarif-policy.mjs',
    tests: ['scripts/__tests__/codeql-sarif-policy.test.ts'],
    reason: 'CodeQL SARIF trust boundary',
  },
  {
    pattern: 'scripts/codeql-sarif-normalize.mjs',
    tests: ['scripts/__tests__/codeql-sarif-normalize.test.ts'],
    reason: 'CodeQL SARIF transport admission boundary',
  },
  {
    pattern: 'docs/guides/dependency-security.md',
    tests: ['scripts/__tests__/dependency-security-docs.test.ts'],
    reason: 'dependency-security documentation contract',
  },
  {
    pattern: 'docs/guides/code-quality.md',
    tests: ['scripts/__tests__/dependency-lifecycle-docs.test.ts'],
    reason: 'root dependency lifecycle bootstrap guidance',
  },
  {
    pattern: 'docs/guides/testing.md',
    tests: ['scripts/__tests__/dependency-lifecycle-docs.test.ts'],
    reason: 'root dependency lifecycle bootstrap guidance',
  },
  {
    pattern: 'docs/guides/development.md',
    tests: [
      'scripts/__tests__/documentation-foundations.test.ts',
      'scripts/__tests__/just-interface.test.ts',
    ],
    reason: 'contributor development guidance contract',
  },
  {
    pattern: 'docs/guides/contributing.md',
    tests: [
      'scripts/__tests__/product-docs-source-links.test.ts',
      'scripts/__tests__/public-doc-contract-examples.test.ts',
    ],
    reason: 'public contributor guide admission',
  },
  {
    pattern: 'config/product-laws.json',
    tests: ['scripts/__tests__/product-laws.test.ts'],
    reason: 'executable product-law manifest',
  },
  {
    pattern: 'scripts/lib/product-laws.mjs',
    tests: ['scripts/__tests__/product-laws.test.ts'],
    reason: 'generated product-law reference source',
  },
  {
    pattern: 'scripts/product-law-gate.mjs',
    tests: ['scripts/__tests__/product-laws.test.ts'],
    reason: 'product-law generation gate',
  },
  {
    pattern: 'docs/reference/product-laws.md',
    tests: [
      'scripts/__tests__/product-laws.test.ts',
      'scripts/__tests__/public-doc-contract-examples.test.ts',
    ],
    reason: 'generated product-law projection',
  },
  {
    pattern: 'install.sh',
    tests: ['scripts/__tests__/documentation-foundations.test.ts'],
    reason: 'channel-specific installation documentation source',
  },
  {
    pattern: 'config/channel-ports.json',
    tests: ['scripts/__tests__/documentation-foundations.test.ts'],
    reason: 'channel-specific getting-started documentation source',
  },
  {
    pattern: 'src-server/services/starter-work/starter-registry.ts',
    tests: ['scripts/__tests__/documentation-foundations.test.ts'],
    reason: 'Starter documentation runtime source',
  },
  {
    // An explicit `tests` list REPLACES graph selection for a path
    // (`selectChangedVerification`: `hasExplicitBoundary` suppresses the
    // `src-ui/**` `related` edge), so this entry is the WHOLE selection for
    // the surface registry — a documentation test alone, while every suite
    // that reads the registry as a value went unscheduled. The registry is a
    // data table, not a module with behaviour, so `--related` would not have
    // found most of these anyway: they assert what it DECLARES.
    pattern: 'src-ui/src/app-shell/destination-registry.ts',
    tests: [
      'scripts/__tests__/documentation-foundations.test.ts',
      // Route/label/deep-link declarations read straight off the registry.
      'src-ui/src/__tests__/activity-rename-sweep.test.ts',
      'src-ui/src/__tests__/app-routing.test.ts',
      'src-ui/src/__tests__/notifications-reachable.test.ts',
      'src-ui/src/__tests__/developer-reachable.test.ts',
      // The palette and sidebar are generated FROM the registry, so a
      // definition change is a change to what they advertise.
      'src-ui/src/__tests__/CommandPalette.test.tsx',
      'src-ui/src/__tests__/ProjectSidebarNav.test.tsx',
      // Frame fallback titles are taken from the registry's labels, and the
      // first-run tour derives its anchors and paths from it.
      'src-ui/src/app-shell/__tests__/page-frame-registry.test.ts',
      'src-ui/src/components/first-run/__tests__/tour-steps.test.ts',
      // The placement-vocabulary ratchet (#928). It imports this module so
      // `related` reaches it from region-model.ts, but this entry's explicit
      // list replaces graph selection for the registry, so it is named here.
      'src-ui/src/__tests__/placement-vocabulary.test.ts',
    ],
    reason: 'app destination registry declarations (routes, labels, nav, docs)',
  },
  {
    // The glossary copy ratchet reads every src-ui source file by path, so
    // no import edge ever reaches it: a copy edit ("Connect to Station" in
    // GuidedConnect.tsx) shipped green and Nightly redded a day later.
    // Supplemental: ADDS the ratchet to any src-ui change without replacing
    // the related-graph selection for that path (#1563).
    pattern: 'src-ui/src/**',
    supplemental: true,
    tests: ['src-ui/src/__tests__/station-vocabulary.test.ts'],
    reason: 'glossary copy ratchet scans all src-ui sources by path',
  },
  {
    pattern: 'justfile',
    tests: [
      'scripts/__tests__/just-interface.test.ts',
      'scripts/__tests__/public-doc-contract-examples.test.ts',
    ],
    reason: 'generated contributor command Interface',
  },
  {
    pattern: 'scripts/just-interface.mjs',
    tests: [
      'scripts/__tests__/just-interface.test.ts',
      'scripts/__tests__/public-doc-contract-examples.test.ts',
    ],
    reason: 'generated contributor command reference',
  },
  {
    pattern: 'docs/reference/contributor-commands.md',
    tests: [
      'scripts/__tests__/just-interface.test.ts',
      'scripts/__tests__/public-doc-contract-examples.test.ts',
    ],
    reason: 'generated contributor command projection',
  },
  {
    pattern: 'docs/guides/product-law-authoring.md',
    tests: [
      'scripts/__tests__/documentation-foundations.test.ts',
      'scripts/__tests__/public-doc-contract-examples.test.ts',
    ],
    reason: 'product-law authoring documentation contract',
  },
  {
    pattern: 'docs/user/getting-started.md',
    tests: [
      'scripts/__tests__/documentation-foundations.test.ts',
      'scripts/__tests__/public-doc-contract-examples.test.ts',
    ],
    reason: 'getting-started runtime source contract',
  },
  {
    pattern: 'docs/user/native-recovery.md',
    tests: [
      'scripts/__tests__/native-recovery-docs.test.ts',
      'scripts/__tests__/public-doc-contract-examples.test.ts',
    ],
    reason: 'public native recovery documentation contract',
  },
  {
    pattern: 'docs/guides/native-shell-verification.md',
    tests: ['scripts/__tests__/native-recovery-docs.test.ts'],
    reason: 'native shell verification guidance contract',
  },
  {
    pattern: 'docs/guides/desktop-build.md',
    tests: [
      'scripts/__tests__/dependency-lifecycle-docs.test.ts',
      'scripts/__tests__/native-recovery-docs.test.ts',
    ],
    reason: 'desktop build recovery routing contract',
  },
  {
    pattern: 'docs/guides/desktop-tray.md',
    tests: ['scripts/__tests__/native-recovery-docs.test.ts'],
    reason: 'desktop tray recovery routing contract',
  },
  {
    pattern: 'docs/reference/config.md',
    tests: ['scripts/__tests__/native-recovery-docs.test.ts'],
    reason: 'desktop logging recovery routing contract',
  },
  {
    pattern: 'src-desktop/src/startup_readiness.rs',
    tests: ['scripts/__tests__/native-recovery-docs.test.ts'],
    reason: 'native readiness documentation source seam',
  },
  {
    pattern: 'src-desktop/src/bundled_server_state.rs',
    tests: ['scripts/__tests__/native-recovery-docs.test.ts'],
    reason: 'native sidecar recovery documentation source seam',
  },
  {
    pattern: 'src-desktop/src/lib.rs',
    tests: [
      'scripts/__tests__/native-recovery-docs.test.ts',
      'scripts/__tests__/tauri-webdriver-boundary.test.ts',
    ],
    reason: 'native window, logging, and activation documentation source seam',
  },
  {
    pattern: 'src-desktop/src/tray.rs',
    tests: ['scripts/__tests__/native-recovery-docs.test.ts'],
    reason: 'native tray activation documentation source seam',
  },
  {
    pattern: 'src-desktop/tauri.conf.json',
    tests: ['scripts/__tests__/native-recovery-docs.test.ts'],
    reason: 'native hidden-window documentation source seam',
  },
  {
    pattern: 'src-desktop/tauri.beta.conf.json',
    tests: ['scripts/__tests__/native-recovery-docs.test.ts'],
    reason: 'Beta hidden-window documentation source seam',
  },
  {
    pattern: 'src-desktop/tauri.nightly.conf.json',
    tests: ['scripts/__tests__/native-recovery-docs.test.ts'],
    reason: 'Nightly hidden-window documentation source seam',
  },
  {
    pattern: 'src-ui/src/platform/native/startupReadiness.ts',
    tests: ['scripts/__tests__/native-recovery-docs.test.ts'],
    reason: 'renderer readiness documentation source seam',
  },
  {
    pattern: 'scripts/__tests__/startup-readiness-static.test.ts',
    tests: ['scripts/__tests__/native-recovery-docs.test.ts'],
    reason: 'native startup static verification command contract',
  },
  {
    pattern: 'src-ui/src/platform/native/__tests__/startupReadiness.test.ts',
    tests: ['scripts/__tests__/native-recovery-docs.test.ts'],
    reason: 'renderer startup verification command contract',
  },
  {
    pattern: 'tests/plugin-host-security.spec.ts',
    tests: ['scripts/__tests__/native-recovery-docs.test.ts'],
    reason: 'hostile plugin browser-only evidence boundary',
  },
  {
    pattern: 'packages/cli/src/cli.ts',
    tests: [
      'scripts/__tests__/native-recovery-docs.test.ts',
      'scripts/__tests__/public-doc-contract-examples.test.ts',
    ],
    reason: 'collision-safe lifecycle command documentation source seam',
  },
  {
    pattern: 'packages/cli/src/help.ts',
    tests: [
      'scripts/__tests__/native-recovery-docs.test.ts',
      'scripts/__tests__/public-doc-contract-examples.test.ts',
    ],
    reason: 'targeted lifecycle command help documentation source seam',
  },
  {
    pattern: 'packages/cli/src/commands/lifecycle.ts',
    tests: ['scripts/__tests__/native-recovery-docs.test.ts'],
    reason: 'targeted lifecycle ownership documentation source seam',
  },
  {
    pattern: 'scripts/lib/free-ports.mjs',
    tests: ['scripts/__tests__/native-recovery-docs.test.ts'],
    reason: 'collision-safe port allocator documentation source seam',
  },
  {
    pattern: 'packages/cli/src/commands/lifecycle-doctor.ts',
    tests: ['scripts/__tests__/native-recovery-docs.test.ts'],
    reason: 'doctor recovery command documentation source seam',
  },
  {
    pattern: 'packages/cli/src/commands/service.ts',
    tests: ['scripts/__tests__/native-recovery-docs.test.ts'],
    reason: 'service-status recovery command documentation source seam',
  },
  {
    pattern: 'packages/cli/src/commands/service-launchd.ts',
    tests: ['scripts/__tests__/native-recovery-docs.test.ts'],
    reason: 'macOS service log documentation source seam',
  },
  {
    pattern: 'packages/cli/src/commands/service-systemd.ts',
    tests: ['scripts/__tests__/native-recovery-docs.test.ts'],
    reason: 'Linux service log documentation source seam',
  },
  {
    pattern: 'packages/cli/src/commands/service-windows.ts',
    tests: ['scripts/__tests__/native-recovery-docs.test.ts'],
    reason: 'Windows service log documentation source seam',
  },
  {
    pattern: 'docs/guides/theming.md',
    tests: ['scripts/__tests__/documentation-foundations.test.ts'],
    reason: 'Station UI adopter documentation contract',
  },
  {
    pattern: 'docs/guides/responsive-ui.md',
    tests: ['scripts/__tests__/documentation-foundations.test.ts'],
    reason: 'Station responsive UI adopter contract',
  },
  {
    pattern: 'packages/sdk/src/queries.ts',
    tests: ['packages/sdk/src/__tests__/publicBarrel.test.ts'],
    reason: 'SDK public query barrel contract',
  },
  {
    pattern: 'packages/sdk/src/index.ts',
    whenAll: ['packages/sdk/src/queries.ts'],
    tests: ['packages/sdk/src/__tests__/publicBarrel.test.ts'],
    reason: 'paired SDK root and query barrel contract',
  },
  {
    pattern: 'packages/contracts/src/workspace-file-preview.ts',
    tests: [
      'packages/contracts/src/__tests__/workspace-file-preview.test.ts',
      'packages/sdk/src/__tests__/workspace-file-preview-query.integration.test.tsx',
      'packages/sdk/src/__tests__/workspace-file-preview-browser-bundle.test.ts',
      'packages/sdk/src/__tests__/publicBarrel.test.ts',
    ],
    reason: 'Workspace file preview public contract',
  },
  {
    pattern: 'packages/contracts/src/surface-deep-link.ts',
    tests: [
      'packages/contracts/src/__tests__/surface-deep-link.test.ts',
      // The builder lives here; the round trip from its output back through
      // the src-ui parser is asserted on the consumer side, so a change to
      // the minted URL shape has to schedule both halves.
      'src-ui/src/contexts/__tests__/surface-deep-link.test.ts',
    ],
    reason: 'surface deep-link public contract',
  },
  {
    pattern: 'src-ui/src/contexts/surface-deep-link.ts',
    tests: ['src-ui/src/contexts/__tests__/surface-deep-link.test.ts'],
    reason: 'surface deep-link URL handling',
  },
  {
    pattern: 'packages/contracts/package.json',
    tests: [
      'packages/contracts/src/__tests__/workspace-file-preview.test.ts',
      'packages/sdk/src/__tests__/publicBarrel.test.ts',
      'packages/contracts/src/__tests__/operational-event.test.ts',
    ],
    reason: 'published contracts subpath export',
  },
  {
    pattern: 'packages/contracts/src/operational-event.ts',
    tests: ['packages/contracts/src/__tests__/operational-event.test.ts'],
    reason: 'operational event envelope contract',
  },
  {
    pattern: 'packages/contracts/src/index.ts',
    whenAll: ['packages/contracts/src/operational-event.ts'],
    tests: ['packages/contracts/src/__tests__/operational-event.test.ts'],
    reason: 'operational event root export',
  },
  {
    pattern: 'packages/sdk/package.json',
    tests: [
      'packages/sdk/src/__tests__/workspace-file-preview-browser-bundle.test.ts',
      'packages/sdk/src/__tests__/publicBarrel.test.ts',
    ],
    reason: 'Workspace file preview SDK subpath export',
  },
  {
    pattern: 'packages/sdk/src/workspace-file-preview.ts',
    tests: [
      'packages/sdk/src/__tests__/workspace-file-preview-query.integration.test.tsx',
      'packages/sdk/src/__tests__/workspace-file-preview-browser-bundle.test.ts',
      'packages/sdk/src/__tests__/publicBarrel.test.ts',
    ],
    reason: 'Workspace file preview SDK opt-in subpath',
  },
  {
    pattern: 'src-server/services/projects/workspace-file-preview-service.ts',
    tests: [
      'src-server/services/projects/__tests__/workspace-file-preview-service.test.ts',
    ],
    reason: 'project-bound Workspace file preview service',
  },
  {
    pattern: 'src-server/routes/projects/workspace-pane-previews.ts',
    tests: [
      'src-server/routes/projects/__tests__/workspace-pane-previews.routes.test.ts',
    ],
    reason: 'project-bound Workspace file preview route',
  },
  {
    pattern: 'src-server/security/pairing-route-scopes.ts',
    tests: ['src-server/security/__tests__/pairing-route-scopes.test.ts'],
    reason: 'pairing-scope route leaf declaration',
  },
  {
    ...TAILSCALE_PUBLIC_INGRESS_IMPACT_BOUNDARY,
    reason:
      'public Tailscale ingress resolver and device-pairing route contract',
  },
  {
    pattern: 'packages/contracts/src/workspace-pane.ts',
    tests: [
      'packages/contracts/src/__tests__/workspace-pane.test.ts',
      'packages/contracts/src/__tests__/workspace-pane-layout-adapter.test.ts',
      'packages/sdk/src/__tests__/workspacePaneConformance.test.ts',
      'packages/sdk/src/__tests__/publicBarrel.test.ts',
      'packages/sdk/src/__tests__/workspace-pane-browser-bundle.test.ts',
    ],
    reason: 'Workspace Pane public contract',
  },
  {
    pattern: 'packages/contracts/src/workspace-pane-renderer-selection.ts',
    tests: [
      'packages/contracts/src/__tests__/workspace-pane.test.ts',
      'packages/sdk/src/__tests__/workspacePaneConformance.test.ts',
      'packages/sdk/src/__tests__/workspace-pane-browser-bundle.test.ts',
    ],
    reason: 'Workspace Pane declared renderer selection contract',
  },
  {
    pattern: 'packages/contracts/src/workspace-pane-layout-adapter.ts',
    tests: [
      'packages/contracts/src/__tests__/workspace-pane-layout-adapter.test.ts',
      'packages/sdk/src/__tests__/workspacePaneConformance.test.ts',
    ],
    reason: 'Workspace Pane legacy adapter',
  },
  ...[
    'packages/contracts/src/workspace-pane-layout-adapter-adaptation.ts',
    'packages/contracts/src/workspace-pane-layout-adapter-catalog.ts',
    'packages/contracts/src/workspace-pane-layout-adapter-helpers.ts',
    'packages/contracts/src/workspace-pane-layout-adapter-types.ts',
  ].map((pattern) => ({
    pattern,
    tests: [
      'packages/contracts/src/__tests__/workspace-pane-layout-adapter.test.ts',
      'packages/sdk/src/__tests__/workspacePaneConformance.test.ts',
    ],
    reason: 'Workspace Pane legacy adapter implementation',
  })),
  {
    pattern: 'packages/sdk/src/workspace-pane.ts',
    tests: [
      'packages/sdk/src/__tests__/workspacePaneConformance.test.ts',
      'packages/sdk/src/__tests__/publicBarrel.test.ts',
      'packages/sdk/src/__tests__/workspace-pane-browser-bundle.test.ts',
    ],
    reason: 'Workspace Pane SDK opt-in subpath',
  },
  {
    pattern: 'packages/sdk/src/query-domains/workspaceProjects.ts',
    tests: [
      'packages/sdk/src/__tests__/workspace-project-layouts-query.integration.test.tsx',
      'packages/sdk/src/__tests__/workspace-file-preview-query.integration.test.tsx',
    ],
    reason: 'Workspace Pane React query seam',
  },
  {
    pattern: 'packages/sdk/src/client/projects.ts',
    tests: [
      'packages/sdk/src/__tests__/workspace-project-layouts-query.integration.test.tsx',
      'packages/sdk/src/__tests__/workspace-file-preview-query.integration.test.tsx',
    ],
    reason: 'Workspace Pane SDK project client',
  },
  {
    pattern: 'src-server/services/projects/workspace-pane-catalog.ts',
    tests: [
      'src-server/services/projects/__tests__/workspace-pane-catalog.test.ts',
    ],
    reason: 'current Workspace Pane catalog adapter',
  },
  {
    pattern: 'src-ui/src/workspace-panes/workspacePaneRendererSelection.ts',
    tests: [
      'src-ui/src/workspace-panes/__tests__/resolvedWorkspacePaneCatalog.test.ts',
      'src-ui/src/workspace-panes/__tests__/WorkspacePaneRouteView.test.tsx',
      'src-ui/src/__tests__/layout-renderer-dispatch.test.tsx',
      'src-ui/src/__tests__/MCPToolUIFrame.test.tsx',
    ],
    reason: 'Workspace Pane trusted-plugin and sandboxed-MCP host selection',
  },
  {
    pattern: 'src-ui/src/core/PluginRegistry.ts',
    tests: [
      'src-ui/src/__tests__/PluginRegistry.auth.test.ts',
      'src-ui/src/workspace-panes/__tests__/resolvedWorkspacePaneCatalog.test.ts',
      'src-ui/src/workspace-panes/__tests__/WorkspacePaneRouteView.test.tsx',
    ],
    reason: 'Workspace Pane trusted-plugin registry ownership binding',
  },
  {
    pattern: 'src-ui/src/layouts/index.tsx',
    tests: [
      'src-ui/src/__tests__/layout-renderer-dispatch.test.tsx',
      'src-ui/src/workspace-panes/__tests__/WorkspacePaneRouteView.test.tsx',
    ],
    reason: 'Workspace Pane authorized trusted-plugin dispatch',
  },
  {
    pattern: 'src-ui/src/workspace-panes/resolvedWorkspacePaneCatalog.ts',
    tests: [
      'src-ui/src/workspace-panes/__tests__/resolvedWorkspacePaneCatalog.test.ts',
      'src-ui/src/workspace-panes/__tests__/WorkspacePaneRouteView.test.tsx',
    ],
    reason: 'Workspace Pane resolved catalog host projection',
  },
  {
    pattern: 'src-ui/src/workspace-panes/WorkspacePaneRouteView.tsx',
    tests: [
      'src-ui/src/workspace-panes/__tests__/WorkspacePaneRouteView.test.tsx',
    ],
    reason: 'Workspace Pane direct route renderer host',
  },
  {
    pattern: 'src-server/services/plugins/distribution-profile-service.ts',
    tests: [
      'src-server/services/plugins/__tests__/distribution-profile-service.test.ts',
      'src-server/services/projects/__tests__/workspace-pane-catalog.test.ts',
    ],
    reason: 'read-only layout catalog descriptor resolver',
  },
  {
    pattern: 'src-server/routes/projects/projects.ts',
    tests: [
      'src-server/routes/projects/__tests__/projects.routes.test.ts',
      'src-server/routes/projects/__tests__/workspace-pane-previews.routes.test.ts',
    ],
    reason: 'Workspace Pane catalog and preview route boundary',
  },
  {
    pattern: 'src-server/**',
    related: true,
    reason: 'server boundary',
  },
  {
    pattern: 'src-ui/**',
    related: true,
    reason: 'UI boundary',
  },
  {
    pattern: 'packages/**',
    related: true,
    reason: 'package boundary',
  },
  {
    pattern: 'scripts/**',
    related: true,
    reason: 'script boundary',
  },
  ...SPAWNED_SCRIPT_EDGES,
  {
    pattern: 'scripts/prepush-test-manifest.mjs',
    tests: [
      'scripts/__tests__/prepush-tier.test.ts',
      'scripts/__tests__/verification-lanes.test.ts',
    ],
    reason: 'pre-push convention manifest',
  },
  ...E2E_CONTRACT_BOUNDARIES.map((pattern) => ({
    pattern,
    lanes: ['verify-e2e-full'],
    ...(pattern === 'playwright.config.ts'
      ? { tests: ['scripts/__tests__/native-recovery-docs.test.ts'] }
      : {}),
    reason: 'E2E product-contract control boundary',
  })),
  {
    pattern: 'scripts/__tests__/fixtures/**',
    lanes: ['prepush'],
    reason: 'test fixture bounded gate',
  },
  {
    pattern: 'tests/**',
    lanes: ['verify-e2e-full'],
    reason: 'E2E manifest/spec boundary',
  },
  {
    pattern: 'docs/**',
    lanes: ['prepush'],
    reason: 'documentation bounded gate',
  },
  {
    pattern: 'src-desktop/**',
    lanes: ['verify-local'],
    reason: 'native boundary',
  },
  {
    pattern: 'ops/nightly/**',
    lanes: ['verify-local'],
    reason: 'nightly boundary',
  },
]);

export const ESCALATION_PATHS = Object.freeze([
  'patches/',
  '.npmrc',
  'package-lock.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package.json',
  'tsconfig.json',
  'tsconfig.tests.json',
  'scripts/test-impact-manifest.mjs',
  'scripts/run-changed-verification.mjs',
  'scripts/verification-lanes.mjs',
  'packages/contracts/',
  'packages/shared/',
  '.github/workflows/',
]);

/**
 * Reason recorded on every derived path-read pin edge.
 *
 * A test that reads a source file's TEXT
 * (`readFileSync(join(__dirname, ...))`) asserts something about that file
 * while having no import edge to it, so neither `vitest related` nor this
 * manifest's graph fallback can schedule it. #1785 moved
 * `useOutboundQueueSnapshot(...)` out of `ChatDock.tsx` and left its pin red
 * on `main`.
 */
const PATH_READ_PIN_REASON =
  'source is read as text by a test, outside the import graph (#1807)';

/**
 * The gate that re-derives the scan and fails when a pinned path no longer
 * exists. Every derived edge selects it, so a rename of a pinned file reds a
 * test that names the pin and the path rather than waiting for a broad
 * selection on somebody else's pull request.
 */
export const PATH_READ_PIN_BOUNDARY_TEST =
  'scripts/__tests__/path-read-pin-boundary.test.ts';

/**
 * Patterns `validateTestImpactManifest` requires EXACTLY ONE edge for. A
 * derived edge carries a bare repository path as its pattern, so a pin on one
 * of these would be a second edge and the validator would throw — failing the
 * whole selector and blaming the E2E contract edge for a new test's read
 * call.
 *
 * Skipping is the only way to keep the manifest valid, and it is a real
 * coverage hole, not a free one: the pin edge is dropped, so the PINNING TEST
 * IS NOT SCHEDULED either. What the path keeps is its committed boundary — an
 * e2e lane, or that edge's fixed test list — which does not include the suite
 * that reads the file's text. The existence check is what survives: the scan
 * still reports the pin, so a move of the file still reds the boundary gate.
 * The same applies forward: adding a path that has a derived edge today to
 * `E2E_CONTRACT_BOUNDARIES` silently removes its pin edge.
 */
const UNIQUE_IMPACT_PATTERNS = Object.freeze(
  new Set([
    ...E2E_CONTRACT_BOUNDARIES,
    TAILSCALE_PUBLIC_INGRESS_IMPACT_BOUNDARY.pattern,
  ]),
);

/**
 * A pinning test the selector cannot schedule. `selection.tests` is handed to
 * Vitest, and `vitest.config.ts` excludes `tests/**` — so a Playwright spec
 * placed here is either dropped in silence (a receipt naming a target that
 * never ran) or, when the spec imports `node:child_process`, a fatal
 * resource-classification error on an ordinary source change. The repo
 * schedules `tests/` through the `verify-e2e-full` lane instead, which a
 * supplemental edge may not carry. `PIN_SCAN_ROOTS` deliberately DOES include
 * `tests`, so those pins are still existence-checked; this filter is what
 * keeps them out of the argv. Scheduling them properly is #1817.
 */
const VITEST_INELIGIBLE_TEST = /^tests\//;

// Keyed by root and never invalidated within a process: the scan is a
// snapshot of the working tree at first call. Correct for the one-shot CLI,
// wrong for any long-lived caller that expects to see later edits.
const pathReadPinEdgeCache = new Map();

/**
 * Impact edges derived from the repository's path-read pins.
 *
 * Every edge is `supplemental`, which in `selectChangedVerification` means it
 * contributes tests and nothing else: it does not set `hasExplicitBoundary`,
 * does not satisfy the unknown-path check, and does not add a related path.
 * That is what makes the SELECTION a strict addition. Naming `tests` on an
 * ordinary edge would suppress the generic `related` edge for the same path —
 * the way an explicit list silently DROPS the related suites (#1563, #1613) —
 * and would also cancel the `ci-fast` escalation an escalation path is
 * entitled to.
 *
 * `supplemental` is a claim about the selector's return value and nothing
 * further. What is scheduled must still be runnable: a test named here that
 * Vitest refuses (a `tests/` spec) or that fails the resource-classification
 * preflight turns an addition into a broken gate, which is why the tests are
 * filtered before the edge is built rather than trusted from the scan.
 *
 * Derived at gate time rather than hand-listed, because a hand-listed pin
 * goes stale the moment somebody adds one. It deliberately does not feed
 * `laneManifestDigest`, which must stay a pure function of the committed
 * manifest rather than of the working tree.
 *
 * @param {{
 *   root?: string,
 *   entries?: readonly { test: string, pins: readonly string[] }[],
 * }} [options] `entries` substitutes a scan result, for tests.
 * @returns {readonly ImpactEdge[]}
 */
export function pathReadPinEdges({ root = process.cwd(), entries } = {}) {
  const cacheable = entries === undefined;
  const cached = cacheable ? pathReadPinEdgeCache.get(root) : undefined;
  if (cached) return cached;
  const scanned = entries ?? scanPathReadPins({ root });
  const edges = Object.freeze(
    invertPathReadPins(scanned).flatMap(({ pin, tests }) => {
      if (UNIQUE_IMPACT_PATTERNS.has(pin)) return [];
      const schedulable = tests.filter(
        (test) => !VITEST_INELIGIBLE_TEST.test(test),
      );
      if (!schedulable.length) return [];
      return [
        Object.freeze({
          pattern: pin,
          supplemental: true,
          tests: Object.freeze(
            [...new Set([...schedulable, PATH_READ_PIN_BOUNDARY_TEST])].sort(),
          ),
          reason: PATH_READ_PIN_REASON,
        }),
      ];
    }),
  );
  if (cacheable) pathReadPinEdgeCache.set(root, edges);
  return edges;
}

/**
 * The committed manifest plus the pin edges derived from the working tree.
 * `runChangedVerification` selects against this; the exported constant stays
 * static for the consumers that need a stable, tree-independent value.
 *
 * @param {Parameters<typeof pathReadPinEdges>[0]} [options]
 * @returns {readonly ImpactEdge[]}
 */
export function buildTestImpactManifest(options) {
  return Object.freeze([...TEST_IMPACT_MANIFEST, ...pathReadPinEdges(options)]);
}

export function matches(pattern, path) {
  if (pattern.endsWith('/**')) return path.startsWith(pattern.slice(0, -2));
  return path === pattern;
}

export function isEscalationPath(path) {
  return (
    ESCALATION_PATHS.some((entry) =>
      entry.endsWith('/') ? path.startsWith(entry) : path === entry,
    ) ||
    /^(?:vitest|vite)[^/]*\.ts$/.test(path) ||
    /^tsconfig[^/]*\.json$/.test(path) ||
    /^biome\.jsonc?$/.test(path)
  );
}

/**
 * @typedef {{
 *   pattern?: string,
 *   tests?: readonly string[],
 *   lanes?: readonly string[],
 *   related?: boolean,
 *   supplemental?: boolean,
 *   whenAll?: readonly string[],
 *   reason?: string,
 * }} ImpactEdge
 */

/**
 * @param {readonly ImpactEdge[]} [manifest]
 * @returns {string[]}
 */
export function validateTestImpactManifest(manifest = TEST_IMPACT_MANIFEST) {
  const errors = [];
  for (const edge of manifest) {
    if (
      !edge?.pattern ||
      (!edge.related && !edge.tests?.length && !edge.lanes?.length)
    )
      errors.push(`invalid impact edge: ${JSON.stringify(edge)}`);
    // A supplemental edge is excluded from the boundary, escalation, and
    // related decisions, so `lanes` or `related` on one would be silently
    // ignored — and a reader would believe the lane was scheduled.
    if (edge?.supplemental && (edge.lanes?.length || edge.related))
      errors.push(
        `supplemental impact edge may only add tests: ${edge.pattern}`,
      );
  }
  // These dynamic seams cannot be inferred from Vitest imports. Deleting one
  // is an unsafe silent narrowing, so validation is intentionally explicit.
  for (const required of [
    'tests/**',
    'src-desktop/**',
    'ops/nightly/**',
    ...E2E_CONTRACT_BOUNDARIES,
    ...GOVERNED_REPO_DATA_EDGES.map(({ pattern }) => pattern),
  ]) {
    if (!manifest.some((edge) => edge.pattern === required))
      errors.push(`required impact edge missing: ${required}`);
  }
  // Each E2E control seam is a direct contract boundary, not a hint combined
  // with the generic scripts/tests edges. Requiring one exact edge prevents a
  // later edit from silently substituting a smaller lane or adding a second
  // lane that changes the checkpoint's semantics.
  for (const pattern of E2E_CONTRACT_BOUNDARIES) {
    const edges = manifest.filter((edge) => edge.pattern === pattern);
    if (edges.length !== 1) {
      errors.push(
        `required E2E contract edge must be unique: ${pattern} (found ${edges.length})`,
      );
      continue;
    }
    const [edge] = edges;
    if (
      edge.related ||
      edge.lanes?.length !== 1 ||
      edge.lanes[0] !== 'verify-e2e-full'
    )
      errors.push(
        `required E2E contract edge must be exactly verify-e2e-full: ${pattern}`,
      );
  }
  const tailscaleEdges = manifest.filter(
    (edge) => edge.pattern === TAILSCALE_PUBLIC_INGRESS_IMPACT_BOUNDARY.pattern,
  );
  if (tailscaleEdges.length !== 1) {
    errors.push(
      `required Tailscale ingress impact edge must be unique: ${TAILSCALE_PUBLIC_INGRESS_IMPACT_BOUNDARY.pattern} (found ${tailscaleEdges.length})`,
    );
  } else {
    const [edge] = tailscaleEdges;
    const expected = [...TAILSCALE_PUBLIC_INGRESS_IMPACT_BOUNDARY.tests].sort();
    const actual = Array.isArray(edge.tests) ? [...edge.tests].sort() : [];
    if (
      edge.related ||
      (edge.lanes?.length ?? 0) !== 0 ||
      JSON.stringify(actual) !== JSON.stringify(expected)
    )
      errors.push(
        `required Tailscale ingress impact edge must select exactly resolver and device-pairing route tests: ${TAILSCALE_PUBLIC_INGRESS_IMPACT_BOUNDARY.pattern}`,
      );
  }
  return errors;
}
