import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  changedDependencies,
  DEPENDENCY_TEST_FANOUT_LIMIT,
  directImporterTests,
} from './lib/dependency-change-scan.mjs';
import {
  invertPathReadPins,
  scanPathReadPins,
} from './lib/path-read-pin-scan.mjs';
import { spawnedScriptDependents } from './lib/spawned-script-scan.mjs';

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

/**
 * station#2301: the SDK's HTTP transport — `http.ts` and the two modules it
 * imports, `bounded-response.ts` and `client-origin.ts` — is imported by every
 * client fetcher, so each of the three has the SAME import graph: ~771 test
 * files, 9,035 tests, nearly the whole UI. That cannot fit ci:fast's
 * affected-test window on a two-core hosted runner (`run-ci-fast.mjs`: the
 * lane budget minus its 220s static reserve; then 720s, 900s since #2577),
 * so fast-checks died with "ci:fast exceeded its 12-minute feedback budget"
 * and zero failures, deterministically, for any change to these files.
 * Whether that graph fits the larger window was not measured; the boundary
 * stays.
 *
 * So each gets an explicit boundary instead of the related graph: the suites
 * that exercise the transport's OWN behaviour — streams, authentication and
 * native transport order, credential wake, timeouts, origin headers, failure
 * mapping, request authority, portability. The transport's CONSUMERS' unit
 * and component suites leave the fast lane — and still run before merge:
 * `mergeQueueRegression: true` puts the path in the fast-checks plan's
 * `mergeQueueRegressionPaths`, and the required `Merge-queue regression`
 * check runs the full-regression corpus on any merge-queue candidate whose
 * plan names one (scripts/merge-queue-regression-decision.mjs). Fast feedback
 * covers the module's own behaviour; the queue covers everything that
 * imports it.
 *
 * Deliberately NOT a `test-full` lane. Any lane switches the whole diff to
 * deferred execution (`executionSelection` in `run-changed-verification.mjs`):
 * it drops the related suites of every OTHER changed file and runs no
 * explicit test at all above 32 — so a transport change would silently stop
 * testing the rest of its own pull request.
 */
const SDK_TRANSPORT_TESTS = Object.freeze([
  'packages/sdk/src/__tests__/authenticated-client-transport.test.ts',
  'packages/sdk/src/__tests__/client-entry-portability.test.ts',
  'packages/sdk/src/__tests__/client-fetchers-failure-paths.test.ts',
  'packages/sdk/src/__tests__/client-origin.test.ts',
  'packages/sdk/src/__tests__/client-request-timeout.test.ts',
  'packages/sdk/src/__tests__/fetch-sse.test.ts',
  'packages/sdk/src/__tests__/request-inspection.test.ts',
  'packages/sdk/src/__tests__/scoped-request-authority.test.ts',
  'packages/sdk/src/__tests__/scoped-request-invocation-boundaries.test.tsx',
  'src-ui/src/__tests__/useServerEvents-authority-stability.test.tsx',
  'src-ui/src/contexts/__tests__/ApiBaseContext.credential-wake.test.tsx',
  'src-ui/src/contexts/__tests__/ApiBaseContext.native-transport-order.test.tsx',
]);
const SDK_TRANSPORT_PATHS = Object.freeze([
  'packages/sdk/src/client/bounded-response.ts',
  'packages/sdk/src/client/client-origin.ts',
  'packages/sdk/src/client/http.ts',
]);
const SDK_TRANSPORT_EDGES = Object.freeze(
  SDK_TRANSPORT_PATHS.map((pattern) =>
    Object.freeze({
      pattern,
      tests: SDK_TRANSPORT_TESTS,
      mergeQueueRegression: true,
      reason:
        'SDK transport: own-behaviour suites; its import graph is too broad ' +
        'for the fast lane, so consumers are covered by the merge-queue ' +
        'full regression (#2301)',
    }),
  ),
);

/**
 * station#2326: the same overflow class, one layer out. Each of these single
 * SDK modules is imported directly by client fetchers or re-exports them, so
 * its related graph approaches the transport's (measured by the repo's own
 * related discovery on 2026-09-23: api-error-message 744 test files,
 * chatHttpError 642, the client barrel 626, against the 771 that overran the
 * fast lane). The package barrel (`packages/sdk/src/index.ts`, 498) is
 * deliberately NOT here: an isolated root-barrel change keeps the conservative
 * related selection the repo already pins, and it is the smallest of the four
 * and unmeasured against the window. Revisit only if a barrel-only change
 * overruns. Each module here gets the same shape as the
 * transport: the suites that exercise the module's own behaviour run in the
 * fast lane, and its consumers run in the required merge-queue full
 * regression. Tests-only edges, never a lane (see SDK_TRANSPORT_EDGES).
 */
const SDK_BROAD_MODULE_EDGES = Object.freeze([
  Object.freeze({
    pattern: 'packages/sdk/src/client/api-error-message.ts',
    mergeQueueRegression: true,
    tests: Object.freeze([
      'packages/sdk/src/__tests__/api-error-message.test.ts',
      'packages/sdk/src/__tests__/client-entry-portability.test.ts',
      'packages/sdk/src/__tests__/client-fetchers-failure-paths.test.ts',
    ]),
    reason:
      'SDK error-message mapping: own-behaviour suites; consumers run in ' +
      'the merge-queue full regression (#2326)',
  }),
  Object.freeze({
    pattern: 'packages/sdk/src/client/chatHttpError.ts',
    mergeQueueRegression: true,
    tests: Object.freeze([
      'packages/sdk/src/__tests__/chatRuntimeStream.test.ts',
      'packages/sdk/src/__tests__/client-entry-portability.test.ts',
      'packages/sdk/src/__tests__/client-execution.test.ts',
      'src-ui/src/hooks/orchestration/__tests__/queueDrain.test.ts',
    ]),
    reason:
      'SDK chat HTTP error: own-behaviour suites; consumers run in the ' +
      'merge-queue full regression (#2326)',
  }),
  // The client barrel has NO suite of its own: nothing asserts which modules
  // it re-exports (publicBarrel.test.ts covers the PACKAGE root barrel, not
  // this one). The portability scan only proves its import syntax stays
  // portable. A dropped re-export is caught by the consumers that import it,
  // which run in the merge-queue full regression — before merge, not here.
  Object.freeze({
    pattern: 'packages/sdk/src/client/index.ts',
    mergeQueueRegression: true,
    tests: Object.freeze([
      'packages/sdk/src/__tests__/client-entry-portability.test.ts',
    ]),
    reason:
      'SDK client barrel: portability scan only (no own export-contract ' +
      'suite exists); consumers run in the merge-queue full regression (#2326)',
  }),
]);

/**
 * #2610: the same overflow class on the server side. The orchestration event
 * store is imported by most runtime, route and provider suites (its related
 * graph: ~160 test files; transcript-search-queries.ts reaches the same set
 * through it). A small store change plus one real-wiring route test ran
 * fast-checks past its 12-minute budget twice with every selected test
 * passing (#2550). Each module gets the suites that exercise its OWN
 * behaviour: the store's persistence, attachment, quarantine and read paths,
 * its session work-item, revision-evidence, credential-application and
 * recovery ledgers, the transcript search queries, and the attachment route
 * through the real runtime wiring. Its consumers run in the required
 * merge-queue full regression, as do these store suites, which leave the
 * fast lane: the resource-heavy event-store-batched-projection.large and
 * event-store-wal-preservation.process (either would take most of the lane),
 * and the adoption-ledger, turn-deduplicator and session-attachment-barrier
 * suites, which exercise modules the store hosts but are reached through
 * their own files. Tests-only edges, never a lane (see SDK_TRANSPORT_EDGES).
 */
const ORCHESTRATION_STORE_EDGES = Object.freeze([
  Object.freeze({
    pattern: 'src-server/services/orchestration/event-store.ts',
    mergeQueueRegression: true,
    tests: Object.freeze([
      'src-server/routes/orchestration/__tests__/attachments.routes.test.ts',
      'src-server/runtime/routes/__tests__/runtime-routes-device-session-chat-principal.test.ts',
      'src-server/services/orchestration/__tests__/event-store-corruption-watch.test.ts',
      'src-server/services/orchestration/__tests__/event-store-quarantine.test.ts',
      'src-server/services/orchestration/__tests__/event-store-tool-images.test.ts',
      'src-server/services/orchestration/__tests__/event-store-turn-attachments.test.ts',
      'src-server/services/orchestration/__tests__/event-store.test.ts',
      'src-server/services/orchestration/__tests__/isolated-transcript-search.test.ts',
      'src-server/services/orchestration/__tests__/session-event-reads.test.ts',
      'src-server/services/orchestration/__tests__/session-work-item-event-store.test.ts',
      'src-server/services/orchestration/__tests__/revision-evidence-persistence.test.ts',
      'src-server/services/orchestration/__tests__/credential-application-ledger.test.ts',
      'src-server/services/orchestration/__tests__/recovery-ledger.test.ts',
    ]),
    reason:
      'orchestration event store: own-behaviour suites; its import graph is ' +
      'too broad for the fast lane, so consumers run in the merge-queue full ' +
      'regression (#2610)',
  }),
  Object.freeze({
    pattern: 'src-server/services/orchestration/transcript-search-queries.ts',
    mergeQueueRegression: true,
    tests: Object.freeze([
      'src-server/services/orchestration/__tests__/event-store.test.ts',
      'src-server/services/orchestration/__tests__/isolated-transcript-search.test.ts',
      'src-server/services/orchestration/__tests__/session-transcript-reads-usage.test.ts',
    ]),
    reason:
      'transcript search queries: own-behaviour suites; reached through the ' +
      'event store, so consumers run in the merge-queue full regression (#2610)',
  }),
]);

/** Repository data readers and explicit runtime seams supplementing import analysis. */
/**
 * Every file under fallow-baselines/, enumerated rather than globbed: the
 * three baselines code-health-gate.mjs passes to fallow. A new file there is
 * an unknown path until it is added here with its own evidence.
 */
export const FALLOW_BASELINE_FILES = Object.freeze([
  'fallow-baselines/dead-code.json',
  'fallow-baselines/dupes.json',
  'fallow-baselines/health.json',
]);

export const GOVERNED_REPO_DATA_EDGES = Object.freeze([
  {
    // #2458: the same overflow class as SDK_TRANSPORT_EDGES (#2301). The
    // matrix is imported by `contracts/agent.ts`, `config.ts` and `tool.ts`,
    // so its related graph is most of the UI and server corpus, and a
    // matrix-only change ran fast-checks past its 12-minute budget with zero
    // failures. The suites that exercise the matrix's own declarations run
    // here; its consumers run in the required merge-queue full regression.
    pattern: 'packages/contracts/src/engine-capability-matrix.ts',
    mergeQueueRegression: true,
    tests: [
      'packages/contracts/src/__tests__/engine-capability-matrix.test.ts',
      'packages/contracts/src/__tests__/agent-capability-profile.test.ts',
      'src-server/providers/__tests__/child-work-conformance.test.ts',
      'src-server/providers/__tests__/engine-image-input-declaration.test.ts',
      'src-server/providers/__tests__/tool-policy-delivery-tripwire.test.ts',
      'src-server/services/orchestration/__tests__/attached-session-adoption.test.ts',
      'src-server/services/orchestration/__tests__/engine-capability-basis-vocabulary.test.ts',
      'src-server/services/orchestration/__tests__/orchestration-service.test.ts',
      'src-ui/src/components/acp-connections/__tests__/EngineCapabilitySummary.test.tsx',
    ],
    reason:
      'engine capability declarations: own-behaviour suites; the import ' +
      'graph is too broad for the fast lane, so consumers run in the ' +
      'merge-queue full regression (#2458)',
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
    // The transport and broad-graph modules have their own edges: see
    // SDK_TRANSPORT_EDGES and SDK_BROAD_MODULE_EDGES.
    except: [
      ...SDK_TRANSPORT_PATHS,
      'packages/sdk/src/client/api-error-message.ts',
      'packages/sdk/src/client/chatHttpError.ts',
      'packages/sdk/src/client/index.ts',
    ],
    related: true,
    tests: ['packages/sdk/src/__tests__/client-entry-portability.test.ts'],
    reason:
      'portable client dependency scan reads source outside the import graph',
  },
  ...SDK_TRANSPORT_EDGES,
  ...SDK_BROAD_MODULE_EDGES,
  ...ORCHESTRATION_STORE_EDGES,
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
    // The repo-wide privacy sweep: `repo-docs-hygiene.mjs` scans every
    // tracked markdown/.jsonl under docs/, so ANY docs file can grow a
    // finding. The nightly's docs:truth:gate caught `docs/reference/api.md`
    // shipping `/home/...` example paths only because nothing in PR CI
    // selected the sweep for a reference-doc change — the entry used to
    // name docs/conformance/** alone.
    //
    // #2803: this is also every doc path's evidence, so a docs change no
    // longer defers the rest of the diff (the `prepush` lane it routed to ran
    // no doc gate, and in ci:fast a lane only deferred). Each suite exercises
    // the real docs tree: the privacy sweep, the live-docs reference check
    // (docs:reference:gate's own logic), index reachability, compile-checked
    // guide blocks, and the public-docs sources and vocabulary. The link
    // check and the reference gate also run as ci:fast statics
    // (run-ci-fast.mjs), so a code change that breaks a doc is caught too.
    pattern: 'docs/**',
    tests: [
      'scripts/__tests__/repo-docs-hygiene.test.ts',
      'scripts/__tests__/docs-reference-gate.test.ts',
      'scripts/__tests__/docs-index-reachability.test.ts',
      'scripts/__tests__/docs-snippets.test.ts',
      'scripts/__tests__/product-docs-source-links.test.ts',
    ],
    reason:
      'documentation: evidence is the live-docs suites here plus the ' +
      'docs:reference:gate and docs:links:check ci:fast statics (#2803)',
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
      // These three read workflows through a templated URL or a directory
      // listing the path-read scan cannot resolve, so they had no edge (#2176).
      'scripts/__tests__/android-channel-release-generation.test.ts',
      'scripts/__tests__/android-firebase-workflow-env.test.ts',
      'scripts/__tests__/android-network-policy.test.ts',
      'scripts/__tests__/backlog-priority-policy.test.ts',
      // Derives the event-scoped env scrub list from the workflows (#2922).
      'scripts/__tests__/ci-event-environment.test.ts',
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
    pattern: 'scripts/publish-mobile-feed-transaction.sh',
    tests: Object.freeze([
      'scripts/__tests__/publish-mobile-feed-transaction.test.ts',
      'scripts/__tests__/release-workflow.test.ts',
    ]),
    reason:
      'the feed transaction test runs this script; the release workflow test reads it',
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
  // #2781: release metadata and code-health baselines are known paths. Each
  // is gated by a ci:fast static (FAST_STATIC_COMMANDS in run-ci-fast.mjs,
  // which fast-checks-statics runs) and selects only the suite that runs the
  // same gate over the repository's real files. As unknown paths they
  // deferred the whole diff, so a published-package pull request ran none of
  // its related suites in fast-checks.
  Object.freeze({
    pattern: '.changeset/**',
    tests: Object.freeze(['scripts/__tests__/check-changesets.repo.test.ts']),
    reason:
      'changeset: evidence is check-changesets (ci:fast static); its suite ' +
      'plans the repository changesets with the same planner (#2781)',
  }),
  ...FALLOW_BASELINE_FILES.map((path) =>
    Object.freeze({
      pattern: path,
      tests: Object.freeze(['scripts/__tests__/code-health-gate.test.ts']),
      reason:
        'fallow baseline: evidence is code-health-gate (ci:fast static; it ' +
        'reads the base revision baselines, so a candidate cannot rebaseline ' +
        'itself); its suite runs the gate over fixtures copied from these ' +
        'files (#2781)',
    }),
  ),
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

/**
 * #2176: suites whose subject reaches them by a path the module graph does
 * not model, so neither `vitest related` nor a generic boundary edge ever
 * schedules them. Before these edges a new settings row first failed
 * `gen-settings-registry.test.ts` in the merge queue's full-corpus
 * regression (#2511, #2593), costing a queue candidate and a rebuild of
 * everything behind it.
 *
 * Every edge is `supplemental`: it only ADDS the suite and leaves the path's
 * related selection, escalation, and lanes as they were (an ordinary edge
 * naming `tests` would set `hasExplicitBoundary` and drop the related graph;
 * #1563, #1613). The suite asserts through `selectChangedVerification` that
 * each generator input still selects it, so a new input without an edge reds
 * on the pull request that adds it.
 *
 * NOT here, deliberately: whole-tree source scans such as
 * `orchestration-source-invariants.test.ts` (#2553). Their honest edge is
 * every file under several roots, which would add them to nearly every
 * selection and reshape every exact selection this manifest's tests pin. They
 * run as their own pull-request job instead: `REPO_SCAN_SUITES` below.
 */
const GENERATED_SETTINGS_REGISTRY_TEST =
  'scripts/__tests__/gen-settings-registry.test.ts';
export const UNMODELLED_INPUT_EDGES = Object.freeze([
  // The signer CLI imports these shared modules, and ecosystem-manifest.test.ts
  // reaches them only through that CLI as a child process, which the import
  // graph cannot see. (The vectors test imports them directly.)
  ...[
    'packages/shared/src/release-manifest.mjs',
    'packages/shared/src/portable-server-targets.mjs',
    'packages/shared/src/release-rings.generated.mjs',
  ].map((pattern) =>
    Object.freeze({
      pattern,
      supplemental: true,
      tests: Object.freeze(['scripts/__tests__/ecosystem-manifest.test.ts']),
      reason:
        'the release-manifest signer CLI imports this module; its tests ' +
        'reach it only through the CLI child process (#2675)',
    }),
  ),
  // The generator loads its sources through a computed specifier (so the
  // scripts typecheck never follows it into `.tsx`), and `--check` reads the
  // checked-in artifact by path. `REGISTRY_SOURCE_PATHS` in the generator is
  // the list these mirror. The generator itself needs no edge: the suite
  // imports it.
  ...[
    'src-ui/src/views/settings/settings-catalog.ts',
    'src-ui/src/views/settings/settings-deep-link.ts',
    'packages/contracts/src/settings-registry.ts',
    'packages/contracts/src/device-settings.ts',
    'src-server/generated/settings-registry.json',
  ].map((pattern) =>
    Object.freeze({
      pattern,
      supplemental: true,
      tests: Object.freeze([GENERATED_SETTINGS_REGISTRY_TEST]),
      reason:
        'settings registry artifact is generated from this input outside ' +
        'the import graph (#2176)',
    }),
  ),
  // The rest read one named file each, by a path the scan cannot resolve (a
  // `test.each` parameter, a cwd-relative literal, a directory copied into a
  // temp plugin), and import nothing that reaches it.
  ...[
    // Generation must run where its readers run: `build:basis-pane` and the
    // ci:fast static list are asserted by text.
    ['package.json', 'scripts/__tests__/basis-mcp-apps.test.ts'],
    ['scripts/run-ci-fast.mjs', 'scripts/__tests__/basis-mcp-apps.test.ts'],
    // Its SHELL_FILES, scanned for hand-rolled chrome alert markup.
    [
      'src-ui/src/App.tsx',
      'src-ui/src/__tests__/shell-chrome-notice-primitive.test.ts',
    ],
    [
      'src-ui/src/main.tsx',
      'src-ui/src/__tests__/shell-chrome-notice-primitive.test.ts',
    ],
    // Installs the example plugin's files and exercises them.
    [
      'examples/smart-routing/**',
      'src-server/routes/__tests__/smart-routing-plugin.test.ts',
    ],
  ].map(([pattern, test]) =>
    Object.freeze({
      pattern,
      supplemental: true,
      tests: Object.freeze([test]),
      reason: 'suite reads this file by path, outside the import graph (#2176)',
    }),
  ),
]);

/**
 * #3149: suites that compose a module through a production entry point, so a
 * change to it can break them while the diff's own selection never runs them.
 * Every edge is `supplemental`: it adds the suite and leaves the path's related
 * selection, escalation and lanes as they were. That is the point — these
 * paths sit in diffs that escalate (`packages/shared/` is an escalation path),
 * and an escalated diff drops related discovery and keeps only explicit tests
 * (`executionSelection` in run-changed-verification.mjs).
 *
 * Exact paths, not the import graph: the entry-point suite reaches each of
 * these through `runCli` or the runtime HTTP composition, and the graph of any
 * one of them is far larger than the suite that proves the composition.
 */
const CLI_SERVICE_ENTRY_POINT_TEST =
  'packages/cli/src/__tests__/service-dev-home-entry-points.test.ts';
const RUNTIME_SECURITY_COMPOSITION_TEST =
  'src-server/routes/system/__tests__/authority-observation.routes.test.ts';
const COMPOSITION_EDGES = Object.freeze([
  // #3251 changed the host-owner claim these entry points install a service
  // through; the suite drives every source-checkout entry point via `runCli`.
  ...[
    'packages/shared/src/instance-registry.ts',
    'packages/cli/src/commands/lifecycle.ts',
    'packages/cli/src/commands/service.ts',
    'packages/cli/src/commands/service-liveness.ts',
    'packages/cli/src/commands/service-run.ts',
  ].map((pattern) =>
    Object.freeze({
      pattern,
      supplemental: true,
      tests: Object.freeze([CLI_SERVICE_ENTRY_POINT_TEST]),
      reason:
        'the CLI service entry points compose this module through runCli; ' +
        'kept explicit so an escalated diff still runs them (#3149)',
    }),
  ),
  // #3114 widened the account-bound device gate; the suite runs the REAL
  // configureRuntimeHttp transport, device gate and principal owner. Every
  // `src-server/runtime/bootstrap/*gate*` module is listed here, which
  // test-impact-incidents.test.ts pins against the directory.
  ...[
    'src-server/security/**',
    'src-server/runtime/bootstrap/account-bound-device-gate.ts',
    'src-server/runtime/bootstrap/agent-audience-gate.ts',
  ].map((pattern) =>
    Object.freeze({
      pattern,
      supplemental: true,
      tests: Object.freeze([RUNTIME_SECURITY_COMPOSITION_TEST]),
      reason:
        'request security is composed by the production HTTP chain this ' +
        'suite runs; kept explicit so an escalated diff still runs it (#3149)',
    }),
  ),
  Object.freeze({
    pattern: 'src-server/runtime/bootstrap/agent-audience-gate.ts',
    supplemental: true,
    tests: Object.freeze([
      'src-server/runtime/routes/__tests__/runtime-routes-agent-audience.test.ts',
    ]),
    reason:
      'Agent audience enforcement through the production route composition; ' +
      'kept explicit so an escalated diff still runs its caller suite (#3149)',
  }),
]);

/**
 * #2176: suites whose subject is a whole source tree, read by walking it.
 * No impact edge can honestly select them — the edge would be every file
 * under the tree, and a supplemental test on every path is noise in the
 * selection — so they run as their own pull-request job instead
 * (`npm run test:repo-scans`, the `repo-scans` job in ci.yml). Before that
 * they ran only in the merge queue's full corpus, where a violation cost a
 * queue candidate (#2553).
 *
 * The ONE list: the runner, the CI job and the classification pin in
 * `path-read-pin-boundary.test.ts` all read it. That pin requires every suite
 * with a directory walk whose target does not look temporary to be here or
 * classified with a reason; its docblock states what that text heuristic
 * cannot see.
 */
export const REPO_SCAN_SUITES = Object.freeze([
  'packages/basis-pane/src/__tests__/package-boundary.test.ts',
  'packages/board-pane/src/__tests__/package-boundary.test.ts',
  'packages/sdk/src/__tests__/body-read-deadline.scan.test.ts',
  // Walks packages/sdk/src/client. Its packages/sdk/src/client/** edge selects
  // it, but a diff that escalates with more than 32 explicit tests runs none
  // of them: #3170 broke it that way and it first failed in qualification.
  'packages/sdk/src/__tests__/client-entry-portability.test.ts',
  'packages/sdk/src/__tests__/publicBarrel.test.ts',
  // Scans src-server, packages/shared/src and packages/cli/src for Station
  // home-root literals the store registry must list (#2675 D1).
  'packages/shared/src/__tests__/station-home-store-registry.test.ts',
  'packages/shared/src/__tests__/turn-provenance-ref-slot-producers.test.ts',
  'scripts/__tests__/builder-delivery-viewer-import-gate.test.ts',
  'scripts/__tests__/classify-ci-change.scan.test.ts',
  'scripts/__tests__/content-integrity-gate.scan.test.ts',
  'scripts/__tests__/dialog-surface-class-guard.test.ts',
  'scripts/__tests__/docs-index-reachability.test.ts',
  'scripts/__tests__/docs-reference-gate.test.ts',
  'scripts/__tests__/docs-snippets.test.ts',
  'scripts/__tests__/dogfood-evidence-retention.test.ts',
  'scripts/__tests__/gate-scope.test.ts',
  'scripts/__tests__/ios-agent-activity-assets.test.ts',
  'scripts/__tests__/learning-media.test.ts',
  'scripts/__tests__/module-entry.scan.test.ts',
  'scripts/__tests__/product-docs-source-links.test.ts',
  // Copies the whole tracked tree and runs the repo-governance lane CLI on it.
  'scripts/__tests__/proof-family-route-error-egress.test.ts',
  'scripts/__tests__/publish-surface.test.ts',
  'scripts/__tests__/random-uuid-guard.test.ts',
  // Discovers server-owned history roots so e2e isolation covers new engines.
  'scripts/__tests__/run-e2e-suite-ports.test.ts',
  'scripts/__tests__/sdk-barrel-selection.repo.test.ts',
  'scripts/__tests__/sdk-error-message-ratchet.test.ts',
  'scripts/__tests__/test-import-existence-gate.scan.test.ts',
  'scripts/__tests__/test-temp-dir-ratchet.scan.test.ts',
  // Walks src-server/knowledge-store and src-server/services/knowledge for raw
  // fs mutations that bypass the file-transaction seam.
  'src-server/knowledge-store/adapters/__tests__/file-transactions.test.ts',
  'src-server/providers/__tests__/child-work-conformance.test.ts',
  'src-server/providers/__tests__/turn-started-attachment-projection.test.ts',
  'src-server/routes/__tests__/sse-response-tripwire.test.ts',
  // Walks src-server/routes/plugins for grant- or content-mutating route
  // registrations that must reach a command-effect withdrawal (#1419), the
  // same tree reserved-plugin-identities.test.ts walks.
  'src-server/routes/plugins/__tests__/plugin-command-effect-withdrawal-sites.test.ts',
  'src-server/runtime/conversation/__tests__/ui-block-provenance-writer-inventory.test.ts',
  'src-server/security/__tests__/svg-response-tripwire.test.ts',
  'src-server/services/__tests__/store-async-lock-cutover.scan.test.ts',
  'src-server/services/devices/__tests__/device-host-resolver.test.ts',
  'src-server/services/infra/__tests__/resource-posture.test.ts',
  'src-server/services/notifications/__tests__/notification-service.scan.test.ts',
  'src-server/services/orchestration/__tests__/orchestration-service.scan.test.ts',
  'src-server/services/orchestration/__tests__/orchestration-source-invariants.test.ts',
  'src-server/services/plugins/__tests__/reserved-plugin-identities.test.ts',
  'src-ui/src/__tests__/activity-surface-single-mounter.test.ts',
  'src-ui/src/__tests__/board-surface-single-mounter.test.ts',
  'src-ui/src/__tests__/connection-host-copy.test.ts',
  'src-ui/src/__tests__/copy-affordance-cascade.test.ts',
  'src-ui/src/__tests__/dock-bottom-clearance.test.ts',
  'src-ui/src/__tests__/home-surface-single-mounter.test.ts',
  'src-ui/src/__tests__/keepPreviousDataConsumers.test.ts',
  'src-ui/src/__tests__/package-css-fork.test.ts',
  'src-ui/src/__tests__/placement-vocabulary.test.ts',
  'src-ui/src/__tests__/plain-language-policy.test.ts',
  'src-ui/src/__tests__/project-query-scope-tripwire.test.ts',
  'src-ui/src/__tests__/raw-local-storage-policy.test.ts',
  'src-ui/src/__tests__/region-surface-boundary.test.ts',
  'src-ui/src/__tests__/responsive-dialog-close-adoption.test.ts',
  'src-ui/src/__tests__/sessionStatusWordCallers.test.ts',
  'src-ui/src/__tests__/settings-row-literal-coverage.test.ts',
  'src-ui/src/__tests__/single-main-landmark.test.ts',
  'src-ui/src/__tests__/undefined-css-custom-properties.test.ts',
  'src-ui/src/app-shell/__tests__/RoutePendingSkeleton.test.tsx',
  'src-ui/src/components/__tests__/PageCallout.test.tsx',
]);

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
    tests: Object.freeze([
      'scripts/__tests__/ecosystem-manifest.test.ts',
      'scripts/__tests__/release-manifest-vectors.test.ts',
    ]),
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
    pattern: 'scripts/test-realtime-wait-gate.mjs',
    related: true,
    tests: Object.freeze(['scripts/__tests__/test-realtime-wait-gate.test.ts']),
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
    pattern: 'scripts/lib/transfer-capture-barrier.ts',
    tests: [
      'scripts/__tests__/transfer-capture-barrier.test.ts',
      'scripts/__tests__/orchestration-transfer-gate.test.ts',
      'src-server/runtime/__tests__/orchestration-transfer-budget.integration.test.ts',
    ],
    reason: 'capture barrier deadline derived from the configured bound',
  },
  {
    pattern: 'scripts/lib/liveness-scale.mjs',
    tests: [
      'scripts/__tests__/liveness-scale.test.ts',
      'scripts/__tests__/prepush-orchestration-transfer.test.ts',
    ],
    reason: 'host-pressure liveness scale consumers and transfer scope',
  },
  {
    pattern: 'scripts/lib/liveness-scale-resolve.mjs',
    tests: ['scripts/__tests__/liveness-scale.test.ts'],
    reason:
      'host-pressure liveness scale resolution and the pre-push resolver CLI',
  },
  {
    pattern: 'scripts/lib/transfer-capture-progress.ts',
    tests: [
      'scripts/__tests__/transfer-capture-progress.test.ts',
      'scripts/__tests__/prepush-orchestration-transfer.test.ts',
      'scripts/__tests__/orchestration-transfer-gate.test.ts',
      'src-server/runtime/__tests__/orchestration-transfer-budget.integration.test.ts',
    ],
    reason: 'bounded exact-source capture phase diagnostic writer',
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
    tests: [
      'scripts/__tests__/orchestration-transfer-gate.test.ts',
      'scripts/__tests__/transfer-baselines.test.ts',
    ],
    reason: 'exact-main transfer comparison gate',
  },
  {
    pattern: 'scripts/lib/transfer-baselines.mjs',
    tests: [
      'scripts/__tests__/transfer-baselines.test.ts',
      'scripts/__tests__/orchestration-transfer-gate.test.ts',
      'scripts/__tests__/worktree-hygiene.test.ts',
    ],
    reason: 'transfer baseline naming, reuse, and pruning',
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
    ],
    reason: 'root instruction routing and wrapper policy',
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
    // SUPPLEMENTAL (#2176). As an ordinary edge its one test set
    // `hasExplicitBoundary`, which cancelled the `ci-fast` escalation
    // `package.json` is listed for in ESCALATION_PATHS: a scripts or
    // dependency edit completed green on a documentation check. The doc
    // suite still runs; the root manifest still escalates. A dependency bump
    // escalates through the lockfile regardless, so this adds no lane to one.
    pattern: 'package.json',
    supplemental: true,
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
    // install.sh is executed by these suites, never imported, and its channel
    // and signing-key blocks are generated from the two config files (#2675).
    // Supplemental: they ADD to each path's own selection.
    pattern: 'install.sh',
    supplemental: true,
    tests: [
      'scripts/__tests__/install-script-generated.test.ts',
      'scripts/__tests__/install-script.test.ts',
      'scripts/__tests__/ecosystem-manifest.test.ts',
    ],
    reason: 'installer is run by its tests, not imported',
  },
  {
    // install.ps1 embeds the installer core as a generated bundle and is run,
    // or read through the generator's exported path, by these suites (#2675
    // W1). None imports it, so the scanner cannot pin the dependency.
    pattern: 'install.ps1',
    supplemental: true,
    tests: [
      'scripts/__tests__/install-ps1.test.ts',
      'scripts/__tests__/install-ps1-full.test.ts',
      'scripts/__tests__/install-script-generated.test.ts',
      'scripts/__tests__/release-manifest-vectors.test.ts',
    ],
    reason: 'Windows installer is run and read by its tests, not imported',
  },
  {
    pattern: 'config/channel-ports.json',
    supplemental: true,
    tests: ['scripts/__tests__/install-script-generated.test.ts'],
    reason: 'install.sh channel constants are generated from this config',
  },
  {
    pattern: 'config/release-manifest-keys.json',
    supplemental: true,
    tests: ['scripts/__tests__/install-script-generated.test.ts'],
    reason: 'install.sh pinned signing keys are generated from this config',
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
  // The one-vocabulary scan reads the work surfaces' sources by path, so no
  // import edge reaches a retired word written in a new file there. Its
  // edges are exactly the roots it walks (`SURFACE_ROOTS` in the suite), not
  // all of src-ui, so it is added only where it can find something.
  // Supplemental, like the copy ratchet above.
  ...[
    'src-ui/src/components/home/**',
    'src-ui/src/components/inbox-row/**',
    'src-ui/src/components/chat-dock/**',
    'src-ui/src/components/project-sidebar/**',
    'src-ui/src/components/session-detail/**',
    'src-ui/src/components/status/**',
    'src-ui/src/views/home/**',
    'src-ui/src/views/activity/**',
    'src-ui/src/views/sessions/**',
    'src-ui/src/views/project-page/**',
    'src-ui/src/views/SessionsView.tsx',
    'src-ui/src/views/HomeView.tsx',
    'src-ui/src/components/flow/WorkflowPlanPanel.tsx',
    'src-ui/src/components/chat/PendingApprovalStrip.tsx',
    'src-ui/src/components/chat/TurnActivityProgress.tsx',
    'src-ui/src/components/chat/ChatEmptyState.tsx',
  ].map((pattern) => ({
    pattern,
    supplemental: true,
    tests: ['src-ui/src/__tests__/session-state-word-consistency.test.ts'],
    reason: 'status vocabulary scan reads the work-surface sources by path',
  })),
  {
    // #2401: the example-manifest field check reads every examples/*/plugin.json
    // by path, so no import edge reaches it. Supplemental: it ADDS the check to
    // an examples change without replacing that change's own selection, which
    // today escalates as an unmapped path.
    pattern: 'examples/**',
    supplemental: true,
    tests: [
      'src-server/services/plugins/__tests__/example-manifest-fields.test.ts',
    ],
    reason: 'example manifests are read by path, outside the import graph',
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
    // Spawned as child processes, outside the import graph (#2923, #2924).
    pattern: 'scripts/check-documentation-freshness.mjs',
    tests: [
      'scripts/__tests__/documentation-freshness.test.ts',
      'scripts/__tests__/documentation-review-notes.test.ts',
      'scripts/__tests__/review-ledger-guards.test.ts',
    ],
    reason: 'scoped documentation freshness CLI and its exit status',
  },
  {
    pattern: 'scripts/record-documentation-review.mjs',
    tests: [
      'scripts/__tests__/documentation-freshness.test.ts',
      'scripts/__tests__/documentation-review-notes.test.ts',
      'scripts/__tests__/review-ledger-guards.test.ts',
    ],
    reason: 'review-ledger record command and its refusals',
  },
  {
    pattern: 'scripts/migrate-review-ledger.mjs',
    tests: [
      'scripts/__tests__/documentation-freshness.test.ts',
      'scripts/__tests__/documentation-review-notes.test.ts',
    ],
    reason: 'single-file review ledger migration and branch fold (#2936)',
  },
  {
    pattern: '.github/workflows/docs-freshness-sweep.yml',
    tests: ['scripts/__tests__/documentation-freshness.test.ts'],
    reason: 'Nightly freshness sweep schedule and permissions',
  },
  {
    pattern: 'scripts/lib/learning-media.mjs',
    tests: ['scripts/__tests__/learning-media.test.ts'],
    reason:
      'captured UI media provenance, immutable bytes and source freshness',
  },
  {
    pattern: 'scripts/documentation-impact.mjs',
    tests: [
      'scripts/__tests__/documentation-impact.test.ts',
      'scripts/__tests__/documentation-freshness.test.ts',
      'scripts/__tests__/gate-for.test.ts',
    ],
    reason: 'source-to-document guidance and incremental catch-up',
  },
  {
    pattern: 'scripts/gate-for.mjs',
    tests: [
      'scripts/__tests__/gate-for.test.ts',
      'scripts/__tests__/documentation-impact.test.ts',
    ],
    reason:
      'pre-edit guidance includes current and recorded documentation dependencies',
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
    pattern: 'scripts/__tests__/startup-readiness-static.test.ts',
    tests: ['scripts/__tests__/native-recovery-docs.test.ts'],
    reason: 'native startup static verification command contract',
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
    // Supplemental (#3149): a tests-only edge here suppressed the path's
    // related selection, so a service.ts change ran this documentation check
    // and none of the 22 suites that import it.
    pattern: 'packages/cli/src/commands/service.ts',
    supplemental: true,
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
      'packages/sdk/src/__tests__/browser-entry-bundles.test.ts',
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
      'packages/sdk/src/__tests__/browser-entry-bundles.test.ts',
      'packages/sdk/src/__tests__/publicBarrel.test.ts',
    ],
    reason: 'Workspace file preview SDK subpath export',
  },
  {
    pattern: 'packages/sdk/src/workspace-file-preview.ts',
    tests: [
      'packages/sdk/src/__tests__/workspace-file-preview-query.integration.test.tsx',
      'packages/sdk/src/__tests__/browser-entry-bundles.test.ts',
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
      'packages/sdk/src/__tests__/browser-entry-bundles.test.ts',
    ],
    reason: 'Workspace Pane public contract',
  },
  {
    pattern: 'packages/contracts/src/workspace-pane-renderer-selection.ts',
    tests: [
      'packages/contracts/src/__tests__/workspace-pane.test.ts',
      'packages/sdk/src/__tests__/workspacePaneConformance.test.ts',
      'packages/sdk/src/__tests__/browser-entry-bundles.test.ts',
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
      'packages/sdk/src/__tests__/browser-entry-bundles.test.ts',
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
    // #2065: `BUILTIN_PROJECT_LAYOUTS` lives here and the catalog resolver
    // maps it, so adding a builtin starter changes what that resolver returns
    // without touching its own file. Adding the fourth one reddened the
    // policy test in distribution-profile-service.test.ts, which no edge
    // named — that path escalates the whole `ci-fast` lane
    // (`packages/contracts/` is in ESCALATION_PATHS), so the suite WAS
    // reachable, just not named in the receipt.
    //
    // SUPPLEMENTAL for exactly that reason. An ordinary edge naming `tests`
    // sets `hasExplicitBoundary`, which suppresses the escalation — so the
    // edge meant to widen the receipt would have replaced a whole lane with
    // one server test and reported `escalated: false`, a complete-looking
    // green (the trap run-changed-verification.mjs documents from #1563 and
    // #1613). Supplemental edges are excluded from `boundaryEdges`, so the
    // ci-fast escalation still fires AND this test is named. This file's own
    // A/B: ordinary → {tests:[1], lanes:[], escalated:false}; supplemental →
    // {tests:[1], lanes:['ci-fast'], escalated:true}.
    //
    // `related: true` would NOT have worked: it is still a boundary edge, so
    // it sets `hasExplicitBoundary` and drops the escalation just the same.
    pattern: 'packages/contracts/src/layout.ts',
    supplemental: true,
    tests: [
      'src-server/services/plugins/__tests__/distribution-profile-service.test.ts',
    ],
    reason: 'builtin project layout starters the layout catalog enumerates',
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
  ...UNMODELLED_INPUT_EDGES,
  ...COMPOSITION_EDGES,
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
 * Reason recorded on every derived spawned-script edge (#2922).
 */
const SPAWNED_SCRIPT_DEPENDENCY_REASON =
  'a test spawns a script that imports this file, directly or ' +
  'transitively, outside the import graph Vitest sees (#2922)';

const spawnedScriptEdgeCache = new Map();

/**
 * Above this many spawning tests, a derived edge defers its tests to the
 * `test-full` lane instead of running them inline (#2922 review). A shared
 * entry shim such as `scripts/lib/module-entry.mjs` is imported by most
 * spawned scripts: a one-line edit selected 75 files and took `test:changed`
 * past ci:fast's 900 s budget (#2621). The deferral keeps the coverage (the
 * merge queue's full regression runs them) without the inline cost.
 */
export const SPAWNED_SCRIPT_FANOUT_LIMIT = 16;
const SPAWNED_SCRIPT_DEFERRAL_REASON =
  `more than ${SPAWNED_SCRIPT_FANOUT_LIMIT} tests spawn scripts that import ` +
  'this file, so they run in test-full rather than inline (#2922)';

/**
 * Impact edges derived from the tests that run `scripts/*.mjs` as a child
 * process (`scripts/lib/spawned-script-scan.mjs`).
 *
 * A test that spawns a script has no import edge to it, and so none to the
 * modules the script imports either: `vitest related` cannot schedule it for
 * a change to either. `SPAWNED_SCRIPT_EDGES` above hand-lists a few of those
 * scripts and nothing they import, which is how a change to
 * `scripts/lib/learning-markdown.mjs` left `guardrail-process-boundary.test.ts`
 * (it spawns `check-markdown-links.mjs`, which imports that module) to fail
 * first in the merge queue (#2886). These edges follow the script's own
 * relative imports, so every file the spawned script reaches selects the
 * spawning test.
 *
 * Same contract as `pathReadPinEdges`: every edge is `supplemental`, so it
 * only ADDS tests and never changes a path's boundary, escalation or related
 * selection; tests Vitest cannot run (`tests/`) are filtered; a path that
 * must own exactly one edge is skipped. Derived at gate time and kept out of
 * `laneManifestDigest` for the same reason.
 *
 * @param {{
 *   root?: string,
 *   entries?: readonly { test: string, scripts: readonly string[] }[],
 * }} [options] `entries` substitutes a spawn scan, for tests.
 * @returns {readonly ImpactEdge[]}
 */
export function spawnedScriptEdges({ root = process.cwd(), entries } = {}) {
  const cacheable = entries === undefined;
  const cached = cacheable ? spawnedScriptEdgeCache.get(root) : undefined;
  if (cached) return cached;
  const edges = Object.freeze(
    spawnedScriptDependents({ root, entries }).flatMap(({ path, tests }) => {
      if (UNIQUE_IMPACT_PATTERNS.has(path)) return [];
      const schedulable = tests.filter(
        (test) => !VITEST_INELIGIBLE_TEST.test(test),
      );
      if (!schedulable.length) return [];
      if (schedulable.length > SPAWNED_SCRIPT_FANOUT_LIMIT)
        return [
          Object.freeze({
            pattern: path,
            supplemental: true,
            deferredLanes: Object.freeze(['test-full']),
            reason: SPAWNED_SCRIPT_DEFERRAL_REASON,
          }),
        ];
      return [
        Object.freeze({
          pattern: path,
          supplemental: true,
          tests: Object.freeze(schedulable),
          reason: SPAWNED_SCRIPT_DEPENDENCY_REASON,
        }),
      ];
    }),
  );
  if (cacheable) spawnedScriptEdgeCache.set(root, edges);
  return edges;
}

const DEPENDENCY_DEFERRAL_REASON =
  `more than ${DEPENDENCY_TEST_FANOUT_LIMIT} suites import this changed ` +
  'dependency, so they run in test-full rather than inline (#3149)';

/**
 * Impact edges for the sibling Kontour packages a diff's dependency files
 * changed (#3149; `scripts/lib/dependency-change-scan.mjs` says why and which).
 * Each edge is attached to the changed `package.json` or `pnpm-lock.yaml`
 * that shows the change and selects the suites importing that package.
 *
 * Same contract as `spawnedScriptEdges`: every edge is `supplemental`, so it
 * only adds tests (or, above the fan-out limit, a deferred `test-full` lane)
 * and never changes the path's escalation. It needs the diff's BASE content,
 * which the path list does not carry, so it is built per selection by
 * `prepareChangedSelection` rather than in `buildTestImpactManifest`.
 *
 * @param {{
 *   root?: string,
 *   paths: readonly string[],
 *   readBase: (path: string) => string | null,
 *   readHead?: (path: string) => string | null,
 *   testFiles?: readonly string[],
 * }} options
 * @returns {readonly ImpactEdge[]}
 */
export function dependencyChangeEdges({
  root = process.cwd(),
  paths,
  readBase,
  readHead = (path) => {
    const absolute = join(root, path);
    return existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
  },
  testFiles,
}) {
  const changes = changedDependencies({ root, paths, readBase, readHead });
  if (!changes.size) return Object.freeze([]);
  const importers = directImporterTests({
    root,
    names: changes.keys(),
    ...(testFiles ? { testFiles } : {}),
  });
  return Object.freeze(
    [...changes].flatMap(([name, sources]) => {
      const tests = importers.get(name) ?? [];
      if (!tests.length) return [];
      return [...sources].sort().map((pattern) =>
        tests.length > DEPENDENCY_TEST_FANOUT_LIMIT
          ? Object.freeze({
              pattern,
              supplemental: true,
              deferredLanes: Object.freeze(['test-full']),
              reason: `${DEPENDENCY_DEFERRAL_REASON}: ${name}`,
            })
          : Object.freeze({
              pattern,
              supplemental: true,
              tests: Object.freeze(tests),
              reason:
                `dependency ${name} changed and this suite imports it ` +
                'directly; a version bump changes no source file the import ' +
                'graph could follow (#3149)',
            }),
      );
    }),
  );
}

/**
 * The committed manifest plus the pin and spawned-script edges derived from
 * the working tree. `runChangedVerification` selects against this; the exported constant stays
 * static for the consumers that need a stable, tree-independent value.
 *
 * @param {Parameters<typeof pathReadPinEdges>[0]} [options]
 * @returns {readonly ImpactEdge[]}
 */
export function buildTestImpactManifest(options) {
  return Object.freeze([
    ...TEST_IMPACT_MANIFEST,
    ...pathReadPinEdges(options),
    ...spawnedScriptEdges({ root: options?.root }),
  ]);
}

/**
 * Changed paths whose consumers the fast lane deliberately leaves to the
 * merge queue: a path an unconditional `mergeQueueRegression` edge owns. The
 * fast-checks plan records them, and a merge-queue candidate that names any
 * runs the full regression (scripts/merge-queue-regression-decision.mjs).
 *
 * @param {readonly string[]} paths
 * @param {readonly ImpactEdge[]} [manifest]
 * @returns {string[]}
 */
export function mergeQueueRegressionPaths(
  paths,
  manifest = TEST_IMPACT_MANIFEST,
) {
  const owned = manifest.filter((edge) => edge.mergeQueueRegression === true);
  return [...new Set(paths)]
    .filter((path) =>
      owned.some(
        (edge) => matches(edge.pattern, path) && !edge.except?.includes(path),
      ),
    )
    .sort();
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
 *   deferredLanes?: readonly string[],
 *   whenAll?: readonly string[],
 *   except?: readonly string[],
 *   mergeQueueRegression?: boolean,
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
      (!edge.related &&
        !edge.tests?.length &&
        !edge.lanes?.length &&
        !edge.deferredLanes?.length)
    )
      errors.push(`invalid impact edge: ${JSON.stringify(edge)}`);
    // `deferredLanes` is how a supplemental edge adds a lane: it only adds,
    // like the supplemental tests, and never touches the boundary decisions.
    // A merge-queue regression owner must be a boundary edge naming its own
    // suites: a supplemental or conditional edge would claim the queue covers
    // a path whose boundary it does not decide.
    if (
      edge?.mergeQueueRegression !== undefined &&
      (edge.mergeQueueRegression !== true ||
        edge.supplemental ||
        edge.whenAll ||
        !edge.tests?.length)
    )
      errors.push(
        `a merge-queue regression edge must be an unconditional boundary edge with tests: ${edge.pattern}`,
      );
    if (edge?.deferredLanes?.length && !edge.supplemental)
      errors.push(
        `only a supplemental impact edge may defer to a lane: ${edge.pattern}`,
      );
    // A supplemental edge is excluded from the boundary, escalation, and
    // related decisions, so `lanes` or `related` on one would be silently
    // ignored — and a reader would believe the lane was scheduled.
    if (edge?.supplemental && (edge.lanes?.length || edge.related))
      errors.push(
        `supplemental impact edge may only add tests: ${edge.pattern}`,
      );
    // `except` is an exact-path list. A glob-shaped entry, one its pattern
    // cannot match, or one on a supplemental edge (whose boundary role it
    // cannot change) would each leave the path on the broad edge silently —
    // exactly the typo class this field exists to stop.
    if (edge?.except?.length && edge.supplemental)
      errors.push(
        `supplemental impact edge may not declare exceptions: ${edge.pattern}`,
      );
    for (const excepted of edge?.except ?? []) {
      if (excepted.includes('*'))
        errors.push(
          `impact edge exception must be an exact path: ${edge.pattern} except ${excepted}`,
        );
      else if (!matches(edge.pattern, excepted))
        errors.push(
          `impact edge exception outside its pattern: ${edge.pattern} except ${excepted}`,
        );
      // An excepted path must still have an EXPLICIT owner, or it falls back
      // to whatever broader edge is left — usually a `related` one, which
      // re-selects the very graph the exception exists to keep out. The owner
      // must be unconditional (`whenAll` can leave the path unowned), carry
      // tests, and add neither `related` (re-adds the graph) nor a lane (any
      // lane defers execution of the whole diff).
      else if (
        !manifest.some(
          (other) =>
            other !== edge &&
            !other.supplemental &&
            !other.whenAll &&
            !other.related &&
            !other.lanes?.length &&
            !other.except?.includes(excepted) &&
            matches(other.pattern, excepted) &&
            other.tests?.length,
        )
      )
        errors.push(
          `impact edge exception has no explicit owner: ${edge.pattern} except ${excepted}`,
        );
    }
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
