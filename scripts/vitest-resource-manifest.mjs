import { spawnSync as defaultSpawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import ts from 'typescript';

/**
 * The full Vitest corpus is intentionally partitioned by resource ownership.
 *
 * Most files are isolated by Vitest's per-run homes and can use the root
 * four-worker cap. A deliberately explicit set starts child processes or
 * exercises timing-sensitive global state; independent members use a bounded
 * two-worker pool. Tests that exercise host-global ownership stay in a
 * separate exclusive group. The package publish checks share
 * `packages/cli/dist/`, so they also remain a separate one-worker group.
 * Finally, the dogfood-reconcile corpus retains its historical serial
 * treatment.
 *
 * This is a manifest rather than a collection of excludes: validation below
 * proves that every file Vitest itself discovers belongs to exactly one group.
 * Adding a direct `node:child_process` import therefore cannot silently land
 * in the ordinary parallel group.
 */

export const ORDINARY_MAX_WORKERS = 4;

export const SHARED_OUTPUT_VITEST_FILES = Object.freeze([
  // Packs the CLI once, then verifies both the symlinked offline layout and an
  // independently resolved npm-tarball consumer. It owns packages/cli/dist.
  'packages/cli/src/__tests__/bundle.test.ts',
  'scripts/__tests__/publish-surface.test.ts',
  // Reads exact generated-policy documentation while other corpus members may
  // regenerate it; one serial lane makes that read a stable input.
  'scripts/__tests__/verification-policy-gate.test.ts',
]);

// These tests intentionally exercise host-global leases/load or carry an
// explicit isolation contract for large replay/overflow workloads. Overlap
// changes the system under test or turns their correctness bound into a
// scheduler-contention measurement.
export const PROCESS_EXCLUSIVE_VITEST_FILES = Object.freeze([
  // The complete 1,200-thread seed/read/equivalence case owns its original
  // 10-second product-law bound in a fresh file/process lifecycle.
  'src-server/services/orchestration/__tests__/event-store-batched-projection.large.test.ts',
  // EventStore owns a high-cardinality SQLite fixture whose large replay and
  // backfill assertions are scheduler-sensitive under the two-worker pool.
  'src-server/services/orchestration/__tests__/event-store.test.ts',
  // Owns detached real-process fixtures, scans live sibling instances, and
  // contains synchronous crash-recovery probes that Vitest cannot interrupt
  // while another process-heavy file is consuming the host.
  'packages/cli/src/__tests__/lifecycle.test.ts',
  'scripts/__tests__/test-reliability-machine.test.ts',
  'src-server/routes/orchestration/__tests__/orchestration.routes.test.ts',
  // station#3218: its correctness bound IS an event-loop responsiveness
  // measurement — it compares how much a `PRAGMA quick_check` blocks this
  // process when run in a child versus in-process. Any overlapping vitest
  // worker turns that comparison into a scheduler-contention measurement,
  // which is precisely what this group exists to prevent. Both arms are
  // measured in the same run and the bound is their ratio, so the host's
  // absolute speed is not part of the assertion.
  'src-server/runtime/bootstrap/__tests__/store-integrity-verification.event-loop.test.ts',
  'src-server/services/orchestration/__tests__/attached-session-follow-service.test.ts',
  // Runs the real Play upload wrapper through SIGTERM escalation and asserts
  // exact owned-PID cleanup; overlap would weaken the ownership boundary.
  'scripts/__tests__/play-upload-retry.test.ts',
]);

export const CREDENTIAL_LEDGER_EXCLUSIVE_VITEST_FILES = Object.freeze([
  // station#1309/#1311: coordinates the exact SQLite index drop/create window
  // with multiple real Node children and file barriers. It needs exclusive
  // execution, but not the verification coordinator's remaining phase budget.
  'src-server/services/orchestration/__tests__/credential-application-ledger.test.ts',
]);

export const COORDINATOR_EXCLUSIVE_VITEST_FILES = Object.freeze([
  // station#1354: exercises host-global verification leases, checkpoint
  // recovery, cleanup fencing, and deliberate timeout scenarios for roughly
  // three minutes. Give that authority its own phase budget and receipt.
  'scripts/__tests__/verification-coordinator.test.ts',
]);

// Direct `node:child_process` importers discovered from the root corpus, with
// the reviewed shared-output and dogfood exceptions removed.  The final entry
// is the responsive UI member of TIMING_RELIABILITY_TEST_FILES; it has no
// child_process import, but must remain in the bounded timing-sensitive pool.
//
// ## The constraint on anything you add here (station#1804)
//
// This group runs on **two workers under a thirty-minute execution deadline**
// (`test-full-process-heavy`), and its members' job is to spawn child
// processes. Every file admitted here therefore raises the contention floor
// under every other file in it — including files whose assertions are bounded
// by wall-clock time.
//
// That is not hypothetical. `verification-stress.test.ts` asserted that an
// admitted coordinator runner records a `timed_out` receipt, using a fixed
// 100 ms deadline that also had to cover the coordinator's admission
// handshake. Sweeping that constant on this host measured the handshake budget
// at 25 ms with no other vitest processes and 50 ms with eight — it doubles
// under concurrent vitest, and the run that actually went red during #1686 did
// so at *lower* aggregate CPU load than the run that passed. Concurrent vitest
// and lease contention are the pressure that matters here, not CPU.
//
// So, before adding a file: a wall-clock bound in this group must be derived
// from something the run itself observes (see `timeoutScenarioBudgetMs` in
// `scripts/run-verification-stress.mjs`), not from a constant chosen on a
// quiet host. A constant only relocates the cliff to a contention level nobody
// has measured — and the branch that reds is then whichever one happened to
// add the next spawn, not the design that made the deadline fragile.
export const PROCESS_HEAVY_VITEST_FILES = Object.freeze([
  // Actual authenticated search routes include Task/transcript worker owners.
  'src-server/runtime/routes/__tests__/runtime-routes-device-session-chat-principal.test.ts',
  // Hono routes composed with the real Task and transcript worker owners.
  'src-server/services/search/__tests__/runtime-search.test.ts',
  'src-server/services/orchestration/__tests__/isolated-transcript-search.test.ts',
  // Owns real CPU-blocking worker_threads and canonical TaskGraph file fixtures.
  'src-server/services/search/__tests__/isolated-task-search.test.ts',
  // Type-only child_process import; the macro's spawn boundary is simulated
  // with streams, so this adds no real child launches or timing assertion.
  'scripts/__tests__/run-connected-agent-tests.test.ts',
  // Real peer EventStores share one disposable SQLite home and survive owner death.
  'src-server/services/plugins/__tests__/package-mcp-admission.test.ts',
  // fsync-backed AgentRegistry fixtures compose the runtime bootstrap path;
  // they own durable state but can share the bounded two-worker pool.
  'src-server/runtime/bootstrap/__tests__/runtime-service-bootstrap.test.ts',
  // Builds two tiny real repositories to prove CLI artifact provenance ignores
  // hostile inherited Git routing and sees a staged dirty index.
  'packages/cli/src/__tests__/build-metadata.test.ts',
  // Builds throwaway Git repositories and runs the gate as a child process, so
  // the real exit status is what the assertions read; process ownership is the
  // behavior under test, not a helper.
  'scripts/__tests__/literal-swap-gate.test.ts',
  // Both fixtures repeatedly invoke real Git and create detached worktrees;
  // their process ownership is the behavior under test, not a test helper.
  'src-server/services/evidence/__tests__/git-review-workspace-source.test.ts',
  'src-server/services/evidence/__tests__/review-lens-router.test.ts',
  'src-server/services/evidence/__tests__/repo-map-review-selection.test.ts',
  // Creates two disposable Git roots and invokes the transfer gate's real Git
  // provenance/capture boundary under a hostile hook environment.
  'scripts/__tests__/orchestration-transfer-gate.test.ts',
  // station#4294: owns a real loopback listener, fresh HTTP sockets, a
  // streaming SDK transport, and a temporary SQLite EventStore.  The test's
  // barriers are stream facts, never a wall-clock budget, but the host
  // resources still require the two-worker process-heavy pool.
  'src-server/runtime/__tests__/orchestration-transfer-budget.integration.test.ts',
  // Spawns a copied Node ESM CLI from a path containing spaces to prove the
  // executable entrypoint, not merely its imported helper, emits JSON errors.
  'scripts/__tests__/ios-local-release-preflight.test.ts',
  // Two bounded, short-lived Node probes prove per-process stdio caller
  // separation while sharing one fixture internal credential; no real services.
  'src-server/tools/__tests__/station-control-caller-binding.process.test.ts',
  // station#4457 drives the registry bridge's stdin/stdout entry point through
  // bounded single-shot Node children to prove exact success/refusal protocol
  // envelopes; every child exits after its one requested operation.
  'src-server/tools/__tests__/instance-registry-bridge.test.ts',
  // #2888: binds a real loopback HTTP server and two independently
  // authenticated streaming clients against worker-backed SQLite state. The
  // listener and event streams are owned/closed per test, but must not contend
  // with ordinary isolated tests that do not own sockets or worker databases.
  'src-server/runtime/__tests__/project-task-room-two-context.e2e.test.ts',
  'examples/builder-delivery-viewer/server/__tests__/plugin-server.test.ts',
  // station#1812: the abnormal-exit reaper proof spawns a real detached
  // grandchild in a separate `node` process and SIGTERMs that process to
  // prove the reaper survives, the same resource shape as platform.test.ts.
  'packages/cli/src/__tests__/helpers/longrunning-fixture-child.abnormal-exit.test.ts',
  'packages/cli/src/__tests__/platform.test.ts',
  // station#4458: the stale-profile-lock proof kills a bounded fixture owner
  // and waits for its exit before reclaiming the exact on-disk record. This is
  // a real child ownership boundary, so it belongs in the two-worker pool.
  'packages/cli/src/__tests__/profile.test.ts',
  'packages/cli/src/__tests__/service.integration.test.ts',
  // #2917: proves the reinstall remedy's shell escaping by handing the
  // rendered command to a REAL `sh -c` for word-splitting — simulating the
  // shell in JS would test the simulation. Each spawn is one short-lived
  // printf; classified here because ordinary placement is never implicit for
  // child_process importers, not because it is resource-hungry.
  'packages/cli/src/__tests__/service-remedy.test.ts',
  // station#2923: imports commands/service.ts, whose production command probe
  // uses spawnSync; the direct-import detector cannot see that child seam.
  'packages/cli/src/__tests__/service.test.ts',
  // station#2928: the offline ConfigLoader path writes a real Station home
  // through the mutation-identity boundary, not an in-memory config double.
  'packages/cli/src/__tests__/config.test.ts',
  // Proves the owned deadline survives a standalone child with no other live
  // handles; process-isolate it with the other real-child CLI tests.
  'packages/cli/src/__tests__/station-instance-reconciler.test.ts',
  // station#1985: the registry write path proves cross-process safety with
  // two real child processes racing upsertInstance against the same file,
  // the exact shape lifecycle-events.test.ts's race test already uses.
  // Skill usage counters prove the SAME cross-process property with the same
  // shape: two real children racing `trackRun` against one `.usage.json`
  // through the shared file-mutation lock. Its bound is a count (2N), not a
  // wall-clock constant, so it does not add a contention cliff to this group.
  'src-server/services/agents/__tests__/skill-usage-service.cross-process.test.ts',
  'packages/shared/src/__tests__/instance-registry.test.ts',
  'packages/shared/src/__tests__/lifecycle-events.test.ts',
  // #2012: a real child runtime races the home maintenance ownership fence.
  'packages/shared/src/__tests__/station-home-lifecycle.test.ts',
  'scripts/__tests__/builder-delivery-viewer-import-gate.test.ts',
  // Drives the changed-verification CLI through spawnSync against a real
  // fixture worktree to prove its dependency and selection behavior.
  'scripts/__tests__/changed-verification.test.ts',
  // #3033: runs the pre-push UI-bundle guardrail as a real child process so
  // its exit STATUS is asserted, not just its pure decision functions — a
  // rejection path that has never executed is unproven.
  'scripts/__tests__/prepush-ui-bundle.test.ts',
  // #1459: runs the completion-gate summary reporter as a real child process
  // so its EXIT STATUS and its stdout annotations are what the assertions
  // read. Both are the contract — the reporter must never fail a job it only
  // reports on — and neither is observable from an imported function.
  'scripts/__tests__/verification-gate-summary.test.ts',
  // #3208: same shape one gate over — runs each static gate it lists as a real
  // child process, so the list cannot name a script that no longer resolves.
  'scripts/__tests__/prepush-static-gates.test.ts',
  // station 2026-08-28: same shape again — the commit-subject gate's CLI and
  // its .githooks/commit-msg wrapper run as bounded single-shot children so
  // the refusal path's exit STATUS is proven, not just the pure validator;
  // the corpus check additionally drives one `git log` against origin/main.
  'scripts/__tests__/commit-message-gate.test.ts',
  // station#625: same shape again — the CodeQL SARIF policy gate runs as
  // bounded single-shot node children so its blocked/stale-baseline refusal
  // paths' EXIT STATUS and printed verdicts are proven, not just the pure
  // evaluation functions.
  'scripts/__tests__/codeql-sarif-policy.cli.test.ts',
  // station#1312: same shape again — the issue-lifecycle module graph is
  // loaded in fresh node children, one entry module per case, because only a
  // cold import proves the graph has no evaluation-order cycle; in-process
  // tests inherit whatever order Vitest already resolved.
  'scripts/__tests__/issue-lifecycle-entry.test.ts',
  // station#3749: same shape again — the SDK refusal-message gate is driven as
  // a real child process against throwaway git repositories so its `FAIL:`
  // sentence and its EXIT STATUS are proven, not just its pure decision
  // functions. Bounded single-shot children per case.
  'scripts/__tests__/sdk-error-message-ratchet.test.ts',
  // station#1137: same shape again — the crypto.randomUUID guard is driven as
  // a real child process against throwaway git repositories so its `FAIL:`
  // sentence and its EXIT STATUS are proven, not just its pure decision
  // functions. Bounded single-shot children per case.
  'scripts/__tests__/random-uuid-guard.test.ts',
  // #1130: same shape again — the dialog-surface-class guard is driven as a
  // real child process against throwaway git repositories so its `FAIL:`
  // sentence and its EXIT STATUS are proven, not just its pure decision
  // functions. Bounded single-shot children per case.
  'scripts/__tests__/dialog-surface-class-guard.test.ts',
  'scripts/__tests__/dependency-advisory-policy.test.ts',
  // Bounded Bash children test Linux bootstrap recovery with inert swap commands.
  'scripts/__tests__/gcp-bootstrap.test.ts',
  // Offline Git children validate encrypted workspace transport against real repositories.
  'packages/shared/src/__tests__/workspace-package.test.ts',
  'packages/cli/src/__tests__/cloud.test.ts',
  'packages/cli/src/__tests__/cloud-project-import.test.ts',
  // Bounded disposable npm-shaped children; no registry/network calls.
  'scripts/__tests__/dependency-audit-diagnostics.test.ts',
  // station#1085: builds throwaway git checkouts and drives `git` through
  // `execFileSync` to prove the manifest derives real revision/branch values
  // — same shape as `content-integrity-gate.test.ts` below.
  'scripts/__tests__/desktop-build-manifest.test.ts',
  'scripts/__tests__/docs-reference-gate.test.ts',
  'scripts/__tests__/dogfood-reconcile-scenario-parity.test.ts',
  // One bounded node child proving the cli-doc parity entry point.
  'scripts/__tests__/cli-doc-parity.test.ts',
  // Regenerate-and-diff plus real-entry-point runs: docs-index --check and
  // the repo hygiene gate each spawn one bounded node child.
  'scripts/__tests__/docs-index-reachability.test.ts',
  // Same shape as the prepush gate tests above: proves the gate:for npm entry
  // point as one bounded single-shot node child; everything else in the file
  // exercises pure decision composition.
  'scripts/__tests__/gate-for.test.ts',
  'scripts/__tests__/repo-docs-hygiene.test.ts',
  'scripts/__tests__/e2e-coverage.test.ts',
  'scripts/__tests__/e2e-manifest.test.ts',
  // station#4464: pins the screenshot comparator's scope-integrity behavior
  // (unknown --screens, !ok-as-failure, unscoped-diff-over-partial-gallery
  // refusal, the pathToFileURL direct-run guard) as real process EXIT CODES,
  // not just its pure decision functions — same shape as the prepush/gate-for
  // gates above. Each child is bounded and single-shot against a throwaway
  // temp gallery/baseline.
  'scripts/__tests__/screenshot-diff.test.ts',
  // Executes the Station-local evidence-classification gate against real and
  // mutated fixture repositories so reachability and candidate exit status
  // are proven at the process boundary. Each child is bounded and single-shot.
  'scripts/__tests__/evidence-check-execution-gate.test.ts',
  // station#1559: the scope-honesty invariant drives real `git ls-files`
  // through `execFileSync` on purpose — its oracle has to be what git actually
  // returns for a pathspec, not a fixture that would pin the bug instead.
  'scripts/__tests__/gate-scope.test.ts',
  // station#928: the placement-vocabulary ratchet enumerates its scan scope
  // through one single-shot `git ls-files` for the same reason as
  // gate-scope.test.ts above — the scope must be what git tracks, not a
  // fixture. Fix-forward: landed via #1478 without this classification; the
  // verification-policy gate caught it on the pull request.
  'src-ui/src/__tests__/placement-vocabulary.test.ts',
  // station#3549: drives a single `git grep -l` through `execFileSync` to
  // discover every file that calls `adapter.startSession(` — the same "real
  // git, not a fixture" shape as gate-scope.test.ts above. Fix-forward: this
  // file landed via #3609 without a resource classification, which the
  // manifest gate itself requires for any direct child_process importer.
  'src-server/services/orchestration/__tests__/engine-start-seam.test.ts',
  // station#3615: deliberately mock-free — points the REAL claude/codex CLIs
  // at an empty config home to prove the signed-out exit-1 mapping, because
  // the mocked suite is exactly what let that conflation ship. Bounded
  // single-shot children per case. Fix-forward: landed via #3617 without the
  // resource classification the manifest gate requires for any direct
  // child_process importer.
  'src-server/services/connections/__tests__/credential-enrolment.integration.test.ts',
  // station#2822: shells out to the packaging dry-run and the publish
  // boundary script, so it spawns children like its install-script sibling.
  'scripts/__tests__/ecosystem-manifest.test.ts',
  // station#4389: runs the root shell launcher against isolated PATH stubs to
  // prove lifecycle delegation and launch sequencing at the process boundary.
  'scripts/__tests__/dependency-lifecycle.test.ts',
  // Probes a pinned package-manager executable before selecting an install command.
  'scripts/__tests__/pnpm-lifecycle.test.ts',
  // Real child process proves the fixed installer guard excludes a second owner.
  'scripts/__tests__/dependency-install-retirement.test.ts',
  // Drives the merge driver's executable entry point as a child process so
  // the provisional resolution and decline-without-writing are real exits.
  'scripts/__tests__/ui-bundle-budget.test.ts',
  // #1153: spawns the starved-PR reporter without GITHUB_REPOSITORY to prove
  // its refusal path exits non-zero and names the remedy.
  'scripts/__tests__/starved-pr-report.test.ts',
  // #1120: spawns the backlog gate without GITHUB_REPOSITORY to prove its
  // refusal path exits non-zero and names the remedy.
  'scripts/__tests__/backlog-priority-policy.test.ts',
  'scripts/__tests__/install-script.test.ts',
  'scripts/__tests__/installer-tool-output-parsing.test.ts',
  'scripts/__tests__/local-verification.test.ts',
  'scripts/__tests__/native-release-config.test.ts',
  // CLI round-trip: drives the updater-manifest script as a real child
  // process to prove its output matches the direct function call.
  'scripts/__tests__/tauri-updater-manifest.test.ts',
  // Generates and signs temporary Java archives through keytool/jar/jarsigner
  // to prove strict Android App Bundle signature outcomes, including the
  // combined chain-validation plus unsigned-entry exit bitmask.
  'scripts/__tests__/verify-android-aab-signature.test.ts',
  // Executes the Android nightly shell installer against a hermetic adb/build
  // fixture so launch-readiness retries are proven by its real exit status.
  'scripts/__tests__/nightly-android-install.test.ts',
  'scripts/__tests__/ios-store-signing-config.test.ts',
  // Runs the macOS Nightly build-only installer through a hermetic fixture
  // home and fake toolchain to prove owned staging/lock cleanup on failure.
  'ops/nightly/macos-build-only-cleanup.test.mjs',
  'ops/nightly/macos-build-only-artifact.test.mjs',
  'ops/nightly/macos-embedded-signing.test.mjs',
  // Uses a real short-lived child that ignores SIGTERM so the notarization
  // runner proves its owned timeout escalation without relying on a mock.
  'ops/release/macos-notarized-artifacts.test.mjs',
  'ops/release/macos-signing-readiness.test.mjs',
  // Uses real local Git repositories to prove two owned Nightly source
  // advances never reset, switch, or clean the provenance checkout.
  'ops/nightly/owned-source-checkout.test.mjs',
  // These tests start real children through the owned-process helper rather
  // than importing node:child_process directly.
  'scripts/__tests__/owned-process.test.ts',
  // Executes the Node UTC conversion used by the reusable fleet workflow;
  // retain the process boundary so a host-local offset cannot be mistaken for
  // the canonical portable-release timestamp contract.
  'scripts/__tests__/native-release-promotion.test.ts',
  'scripts/__tests__/package-portable-release.test.ts',
  // station#1686: runs the shadow-record reader as a real child process so
  // its REFUSAL path (`--gate` on a home that has never observed anything)
  // is proven by an actual exit status rather than a returned number.
  'scripts/__tests__/project-resource-shadow-report.test.ts',
  // Executes the release compensation shell transaction in isolated fixture
  // directories to verify its real exit codes and rollback behavior.
  'scripts/__tests__/publish-mobile-feed-transaction.test.ts',
  // station#2299: runs the repo-guardrail proof itself as a real child
  // process against a mutated copy, because the defect was that the proof
  // died before producing any verdict — only a real exit status can prove it
  // now reaches one. No wall-clock assertions; each case is a bounded
  // single-shot spawn.
  'scripts/__tests__/proof-repo-guardrails-fail-closed.test.ts',
  'scripts/__tests__/release-workflow.test.ts',
  // Runs the pinned Cargo producer against the patched native workspace and
  // owns its deterministic output file; never make release:static host-bound.
  'scripts/__tests__/release-cargo-producer.test.ts',
  // station#1555: runs five repo guardrails as real child processes against
  // known-bad fixture trees, so their exit codes and FAIL: output are proven
  // rather than assumed. Builds a throwaway git repo per case for the same
  // reason content-integrity-gate.test.ts does — every one of those guardrails
  // scopes itself with `git ls-files` or `git grep`.
  'scripts/__tests__/guardrail-known-bad-fixtures.test.ts',
  // station#1398 security review, M-5: the content-integrity gate's own test
  // builds throwaway git repos and drives `git grep` through `execFileSync`,
  // because the scan is `git grep` over TRACKED files and a fixture written
  // to a loose directory would prove nothing about what runs in CI.
  'scripts/__tests__/content-integrity-gate.test.ts',
  // station#1792: drives the newly fixed ci:fast static entry against real
  // tracked NUL/clean fixture repositories. The child is single-shot and has
  // no wall-clock assertion, but still belongs in the bounded spawn pool.
  'scripts/__tests__/run-ci-fast.test.ts',
  'scripts/__tests__/run-e2e-suite-ports.test.ts',
  'scripts/__tests__/server-build-portability.test.ts',
  'scripts/__tests__/station-agent-smoke.test.ts',
  // station#4536: proves the station-dev shim's checkout resolution and
  // freshness gate as real process exit codes/stderr from both inside and
  // outside a checkout, plus a real install-to-tempdir-and-run round trip —
  // same bounded, single-shot shape as the other entry-point gates above.
  'scripts/__tests__/station-dev.test.ts',
  // Drives the deploy-ledger commit-back's
  // bounded re-derive-and-retry against real local git repositories — the
  // two-writer convergence proof, the off-main ancestry refusal, retry
  // exhaustion, and the duplicate re-record refusal all assert real git
  // state, so the child processes are the claim.
  'scripts/__tests__/deploy-ledger-commit.test.ts',
  // Proves the published-packages
  // JSON parse's success and refusal exit statuses as a real child process,
  // the same "gate as a real child" shape as the entry-point gates above.
  'scripts/__tests__/deploy-ledger-parse-published.test.ts',
  'scripts/__tests__/station-dogfood-health.test.ts',
  'scripts/__tests__/station-dogfood-launch-path.test.ts',
  'scripts/__tests__/station-dogfood-runtime-recovery.integration.test.ts',
  // Owns real detached candidates from immutable instance snapshots and
  // verifies signal-time reaping in a separate fixture worker.
  'scripts/__tests__/helpers/station-fixture-owner.abnormal-exit.test.ts',
  // station#1812: same abnormal-exit-reaper proof as the packages/cli
  // entry above, against this directory's independent (duplicated)
  // implementation -- spawns a real detached grandchild in a separate
  // `node` process and SIGTERMs that process to prove the reaper survives.
  'scripts/__tests__/helpers/longrunning-fixture-child.abnormal-exit.test.ts',
  // station#3423/#3435: runs the test-import-existence gate as a real child
  // process (positive/negative controls, the entrypoint-guard space-in-path
  // regression, and the real-repository count check) — same "gate as a real
  // child process" shape as builder-delivery-viewer-import-gate.test.ts and
  // prepush-static-gates.test.ts above.
  'scripts/__tests__/test-import-existence-gate.test.ts',
  'scripts/__tests__/trust-reconcile-manifest.test.ts',
  // station#3465 review (second pass): one assertion shells a real `git
  // ls-files` child process as an independent oracle for packages/connect's
  // tracked test-file count, rather than trusting a floor.
  'scripts/__tests__/vitest-resource-manifest.test.ts',
  'scripts/__tests__/verification-receipt.test.ts',
  // station#4109: the CLI end-to-end preflight test builds a throwaway `git
  // init` fixture worktree (git config, add, commit) and runs the public
  // verification CLI against it as a real child, mirroring
  // workspace-dependency-provenance.test.ts's fixture shape below.
  'scripts/__tests__/verification-environment-preflight.test.ts',
  // station#2923: artifact GC acquires a real process-identity-backed mutation
  // claim through its reporter helper, so it must not contend in ordinary.
  'scripts/__tests__/verification-reporter.test.ts',
  // Executes the Station three-state readiness boundary as a real child so
  // its JSON and 0/1/2 process contract cannot be mistaken for a unit mock.
  'scripts/__tests__/veritas-readiness-evidence.test.ts',
  'scripts/__tests__/verification-stress.test.ts',
  'scripts/__tests__/verify-desktop-clean-checkout.test.ts',
  'scripts/__tests__/vite-loopback-default.test.ts',
  'scripts/__tests__/vitest-worktree-exclusion.test.ts',
  'scripts/__tests__/voice-realtime-live-smoke.test.ts',
  // station#3205: builds throwaway `git init` repositories with real linked
  // worktrees and drives the hygiene tool — including its exit statuses, as a
  // real child process — against them. The tool only reads, and so does this
  // file; the fixtures are fresh temp directories removed in `afterEach`, and
  // nothing here addresses this checkout.
  'scripts/__tests__/worktree-hygiene-git.test.ts',
  // Runs workspace-resolution and command provenance checks through
  // execFileSync against real fixture package layouts.
  'scripts/__tests__/workspace-dependency-provenance.test.ts',
  // Filesystem watchers, runtime boot/shutdown, and a 2,050-row SQLite
  // migration are deterministic alone but exceeded their contracts together
  // under the four-worker Linux fleet corpus.
  'src-server/domain/__tests__/config-loader-app-watch.test.ts',
  'src-server/domain/__tests__/config-loader-app.test.ts',
  // Exercises the home-schema gate in a fresh process so module-level
  // initialization cannot mask a cold-start failure.
  'src-server/domain/__tests__/agent-registry.test.ts',
  'src-server/providers/__tests__/codex-adapter.test.ts',
  // station#2802: drives real `git` through execFileSync against throwaway
  // fixture repositories to prove checkpoint capture never touches the
  // user's index/HEAD and stays invisible to branch/tag/log --all — the
  // same child-process shape as content-integrity-gate.test.ts.
  'src-server/services/checkpoints/__tests__/checkpoint-ref-store.test.ts',
  // station#2923: builds and restores real Git fixture repositories through
  // the transitive execGit process helper, not a direct test-file import.
  'src-server/services/checkpoints/__tests__/checkpoint-restore.test.ts',
  'src-server/services/checkpoints/__tests__/checkpoint-read.test.ts',
  'src-server/services/checkpoints/__tests__/checkpoint-retention.test.ts',
  'packages/cli/src/__tests__/checkpoints-command.test.ts',
  // These ACP integration tests do not import child_process directly, but
  // exercise shared discovery/process startup and exceeded their 5s contract
  // under the four-worker ordinary corpus. Keep their feedback deterministic.
  'src-server/providers/__tests__/acp-adapter.test.ts',
  'src-server/providers/__tests__/station-control-mcp-passthrough.integration.test.ts',
  'src-server/providers/auth/__tests__/cli-auth-login-path.test.ts',
  'src-server/routes/plugins/__tests__/plugins.routes.test.ts',
  // One private Node child with exposed GC proves strong lease custody. No
  // shared state or latency assertion; collection is explicitly requested.
  'src-server/services/plugins/__tests__/plugin-composition-custody-gc.test.ts',
  'src-server/runtime/__tests__/runtime-cold-start-custom-agent.test.ts',
  // station#2928: retains the durable ConfigLoader/registry adoption seam;
  // production's default CLI detection reaches child_process transitively.
  'src-server/runtime/bootstrap/__tests__/native-engine-adoption.test.ts',
  // station#3218: builds the store-integrity probe exactly as
  // `esbuild.config.mjs` does and runs that bundle as a REAL child against
  // real corrupt bytes, so its 0/1/2/3 exit contract is proven by an actual
  // exit status rather than a returned number. Each spawn is bounded and
  // single-shot, and nothing here asserts a wall-clock bound.
  'src-server/tools/__tests__/store-integrity-probe.test.ts',
  'src-server/services/evidence/__tests__/veritas-readiness-service.test.ts',
  'src-server/services/__tests__/flow-agents-work-item-provider.process-tree.test.ts',
  // station#2238: starts real Station children against one SQLite claims
  // store to prove construction preserves live ownership.
  'src-server/routes/chat/__tests__/chat-turn-dedup.test.ts',
  // The child process is owned by the hermetic helper rather than imported by
  // the test file; its broken-pipe proof also writes a 4 MiB stdin payload.
  'src-server/services/__tests__/helpers/hermetic-openssh.test.ts',
  'src-server/services/infra/__tests__/process-utils.test.ts',
  // station#1863: spawns REAL detached engine processes, SIGKILLs the owner,
  // and asserts the startup sweep reaps the orphaned group. Same process-tree
  // shape as process-utils.test.ts; must not run under the ordinary pool.
  'src-server/services/infra/__tests__/owned-process-reaping.test.ts',
  // station#1895: spawns a real node child process (through `tsx`) to prove
  // the durable log sink survives an actual uncaught exception, the same
  // resource shape as `agent-registry.test.ts`'s schema-gate child probe.
  'src-server/services/infra/__tests__/server-log-store.crash.test.ts',
  'src-server/services/infra/__tests__/receipt-bus.production-usage.test.ts',
  // station#2253: crashes and contends a real Node process while it owns the
  // knowledge-root journal/lock, proving prepared multi-file recovery and
  // cross-process serialization without sharing an in-memory test double.
  'src-server/knowledge-store/adapters/__tests__/file-transactions.test.ts',
  // The observer's FIFO proof swaps a real pipe exactly at native open and
  // kills only its own child after proving the old flags remain blocked.
  'src-server/knowledge-store/__tests__/knowledge-record-observation.process.test.ts',
  // SchedulerLedger starts a real Node owner, proves an independent SQLite
  // connection cannot claim its occurrence, then SIGKILLs it for exact
  // liveness reconciliation. Keep that process lifecycle out of ordinary.
  'src-server/services/scheduling/__tests__/scheduler-ledger.test.ts',
  // BuiltinScheduler holds a real SQLite writer child across bounded
  // not-invoked recovery and shutdown; it must not contend with ordinary
  // Vitest workers or hide a leaked child behind a timing failure.
  'src-server/services/__tests__/scheduler.test.ts',
  'src-server/services/acp/__tests__/acp-process-spawn-failure.test.ts',
  // Runs npm and the real lockfile gate against an isolated two-workspace
  // fixture. The children are network-free and short-lived, but the actual
  // process boundary is the claim, so it belongs in the bounded spawn pool.
  'scripts/__tests__/version-packages-lock.test.ts',
  // The room runtime intentionally hard-exits a child after durable history
  // commit and before recovery settlement, then reopens the same SQLite file.
  // That crash/reopen lifecycle must not overlap ordinary workers.
  'src-server/services/orchestration/__tests__/project-task-room-runtime.test.ts',
  // station#3215/#3217: builds a hot-WAL store in a child that exits without
  // close(), then proves the integrity-throw path does not reap the WAL. The
  // dead-writer precondition is why it cannot run in an ordinary worker.
  'src-server/services/orchestration/__tests__/event-store-wal-preservation.process.test.ts',
  // station#3661: two real Node peers first-open one rollback-journal SQLite
  // file and race the `journal_mode = WAL` conversion, one holding the write
  // lock while the other retries. The cross-process exclusive-lock refusal is
  // the whole claim, so it cannot run beside ordinary workers.
  'src-server/utils/__tests__/sqlite-wal.process.test.ts',
  // Shells out to `git grep` for the projection source guard.
  'src-server/services/agents/__tests__/agent-binding-projection.test.ts',
  // station#3278: builds the real watchdog bundle and spawns it through
  // symlinked paths to prove the entrypoint guard fires; the esbuild step and
  // child spawns keep it out of ordinary workers.
  'src-server/tools/__tests__/self-update-watchdog-entrypoint.process.test.ts',
  // station#2928: drives deferred compensation through a real SQLite
  // EventStore, with deliberately controlled asynchronous settlement.
  'src-server/services/orchestration/__tests__/credential-recovery-module.test.ts',
  // station#1889: starts a real direct-invocation owner, proves live and
  // unavailable probes fail closed, then SIGKILLs it for possible-effect
  // reconciliation. It has the same SQLite/process lifecycle as recovery.
  'src-server/services/orchestration/__tests__/native-invocation-runs.test.ts',
  // station#1889: starts a real Nova-correlated voice owner, proves a live
  // completion is never stolen, then SIGKILLs it before possible-effect
  // reconciliation. Keep the SQLite child lifecycle out of ordinary workers.
  'src-server/services/orchestration/__tests__/voice-turn-runs.test.ts',
  // station#2863: a real synchronous CLI process owns an integration mutation
  // lock while the server proves its async writer remains event-loop responsive.
  'src-server/domain/__tests__/config-loader-storage.process.test.ts',
  // station#2250: real Node writers exercise both orderings of a nested record
  // mutation racing atomic Project deletion through the shared project fence.
  'src-server/domain/__tests__/project-file-transactions.process.test.ts',
  // station#2254: coordinates two independent Station processes against one
  // durable Kit lifecycle registry and its shared mutation lock.
  'src-server/services/kits/__tests__/kit-observability-registry.process.test.ts',
  // station#2251: launches two independent Station processes against one
  // agent spec to prove the shared identity lock prevents lost edits.
  'src-server/domain/__tests__/config-loader-agents.process.test.ts',
  // station#2562: starts a real Node owner, proves a live birth-fingerprinted
  // claim cannot be reconciled, then SIGKILLs it before reclaiming exactly
  // once. This has the same detached-process lifecycle as event-store.test.
  'src-server/services/orchestration/__tests__/recovery-ledger.test.ts',
  // station#1528: synchronizes four real EventStore processes at one append
  // boundary to prove global ordering and duplicate rejection across SQLite
  // connections. Keep child ownership out of the ordinary worker pool.
  'src-server/services/operational-events/__tests__/operational-event-outbox.test.ts',
  // Two real SQLite writers race against one Project/Task room; this owns
  // child process lifecycle and must not silently land in the ordinary pool.
  'src-server/services/orchestration/__tests__/project-task-room-history.test.ts',
  // station#1528: holds a real delivery owner alive, proves it cannot be
  // stolen, then SIGKILLs it before exact idempotent reclaim.
  'src-server/services/operational-events/__tests__/operational-event-delivery.test.ts',
  'src-server/services/projects/__tests__/task-graph-service.dispatch-claim.test.ts',
  // Task outputs prove the shared-home mutation fence with two real Station
  // processes; a same-process queue cannot establish that storage invariant.
  'src-server/services/projects/__tests__/task-output-module.cross-process.test.ts',
  // Answer-support storage uses the same-home mutation fence; exercise create
  // and CAS replay in independent Station processes.
  'src-server/services/evidence/__tests__/task-answer-support-module.cross-process.test.ts',
  // Persists 100 Task references to verify the hard ownership cap; keep the
  // synchronous filesystem loop out of the four-worker ordinary lane.
  'src-server/services/projects/__tests__/task-graph-service.test.ts',
  // sol review D5 finding 4: runs a REAL `ssh` with a `ProxyCommand=sleep 30`
  // and asserts the whole process GROUP is gone after the probe's timeout.
  // The claim is about how the OS delivers a signal to a descendant, so it
  // owns real child processes and must not run in the ordinary pool. Its
  // waits are `until`-loops on process-table state with generous budgets, not
  // wall-clock bounds chosen on a quiet host.
  'src-server/services/ssh/__tests__/openssh-reachability.process.test.ts',
  'src-server/services/ssh/__tests__/openssh-launch-bootstrap.test.ts',
  'src-server/services/terminal/__tests__/terminal-subprocess-state.test.ts',
  'src-ui/src/contexts/__tests__/ApiBaseContext.test.tsx',
  'src-ui/src/contexts/__tests__/ApiBaseContext.no-duplicate-connection.test.tsx',
  // Builds a production Vite artifact in a disposable directory to prove the
  // development-only pseudo-locale module cannot ship, so it owns one bounded
  // child process and must not contend with ordinary UI tests.
  'src-ui/src/i18n/__tests__/LocaleContext.test.tsx',
  // station#2928: executes vite.config.ts (including its git child probe)
  // and a real Vite middleware server against a per-suite temporary cache.
  'src-ui/src/__tests__/vite-sdk-client-alias.test.ts',
  // station#3453: does not import child_process directly, but launches a
  // real Chromium via `@playwright/test` (`chromium.launch()` spawns the
  // browser process through `playwright-core`) to measure real cascade-
  // resolved layout at a phone viewport — same shape as the ACP integration
  // tests above. A cold browser launch under a full corpus plus a sibling
  // session is exactly the load-dependent case this pool exists to keep out
  // of the ordinary four-worker lane.
  'src-ui/src/components/notifications/__tests__/BannerHost.touch-target.test.tsx',
  // station#3513: same shape as BannerHost.touch-target.test.tsx above —
  // launches a real Chromium via `@playwright/test` to measure real cascade-
  // resolved layout at phone viewports.
  'src-ui/src/components/notifications/__tests__/NotificationContainer.touch-target.test.tsx',
  // station#4470a: same shape again — launches a real Chromium via
  // `@playwright/test` to measure real cascade-resolved geometry (the
  // disclosure toggle vs. the message text's own line rects) at a phone
  // viewport.
  'src-ui/src/components/notifications/__tests__/BannerHost.disclosure-overlap.test.tsx',
  // station#4474: same shape again — launches a real Chromium via
  // `@playwright/test` to measure real cascade-resolved layout (sibling
  // toolbar control x-offsets across connection states).
  'src-ui/src/__tests__/HeaderActions.connection-reflow.test.tsx',
  // station#4474 H1 (review round): same shape again — launches a real
  // Chromium via `@playwright/test` to measure real cascade-resolved
  // layout (a marker's y-offset across the isFetching flip).
  'src-ui/src/components/action-operations/__tests__/ActionOperationsSection.reflow.test.tsx',
  // station#4470 H2 (review round): same shape again — launches a real
  // Chromium via `@playwright/test` to measure real cascade-resolved
  // layout (collapsed-card control geometry and hit-testing).
  'src-ui/src/components/notifications/__tests__/BannerHost.collapsed-controls.test.tsx',
  // station#4475 (review round): same shape again — launches a real
  // Chromium via `@playwright/test` to hit-test connections-flow controls
  // with and without an active banner.
  'src-ui/src/__tests__/ConnectionsSectionFrame.banner-hittest.test.tsx',
  // #1536 E2: same shape again — launches a real Chromium via
  // `@playwright/test` to measure the dock header's cascade-resolved
  // identity/project-context geometry (unclipped overflow and wrapped
  // one-line labels) at a squeezed and a comfortable width.
  'src-ui/src/__tests__/ChatDockHeader.identityGeometry.test.tsx',
  // station#235: launches real Chromium against the actual compact Session
  // inventory markup and cascade-resolved CSS to measure its 390px heading
  // geometry and keyboard order. Browser launch ownership keeps it out of
  // the ordinary four-worker corpus.
  'src-ui/src/components/chat-dock/__tests__/sessionInventoryCompactHost.test.ts',
  // station#235: exercises the actual Connected Session inventory markup in
  // real Chromium so the derived work-item anchor's tab order and native
  // Enter activation are observable rather than inferred from React props.
  'src-ui/src/workspace-panes/__tests__/ConnectedSessionInventory.test.tsx',
  // Same shape
  // again — launches a real Chromium via `@playwright/test` to measure real
  // cascade-resolved row heights (the loading skeleton row vs. the real item
  // row it stands in for).
  'src-ui/src/__tests__/SplitPaneLayout.skeleton-geometry.test.tsx',
  // Exercises the release-cohort CLI through real Node subprocesses so its
  // externally persisted receipt boundary is observable end-to-end.
  'scripts/__tests__/release-cohort.test.ts',
  // Injects a fixed command adapter at the protected provider boundary and
  // asserts exact child-process argv/options without using a real credential.
  'scripts/__tests__/verify-release-cohort.test.ts',
]);

export const DOGFOOD_RECONCILE_PREFIX =
  'scripts/__tests__/station-dogfood-reconcile';

export const VITEST_RESOURCE_MANIFEST = Object.freeze({
  ordinary: Object.freeze({ maxWorkers: ORDINARY_MAX_WORKERS }),
  processHeavy: Object.freeze({ files: PROCESS_HEAVY_VITEST_FILES }),
  processExclusive: Object.freeze({ files: PROCESS_EXCLUSIVE_VITEST_FILES }),
  coordinatorExclusive: Object.freeze({
    files: COORDINATOR_EXCLUSIVE_VITEST_FILES,
  }),
  credentialLedgerExclusive: Object.freeze({
    files: CREDENTIAL_LEDGER_EXCLUSIVE_VITEST_FILES,
  }),
  sharedOutput: Object.freeze({ files: SHARED_OUTPUT_VITEST_FILES }),
  dogfoodReconcile: Object.freeze({ prefix: DOGFOOD_RECONCILE_PREFIX }),
});

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

function normalizedPath(path) {
  return path.split(sep).join('/');
}

function isSafeRelativeFile(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.split('/').includes('..') &&
    TEST_FILE_PATTERN.test(path)
  );
}

function isChildProcessSpecifier(node) {
  return Boolean(
    ts.isStringLiteralLike(node) &&
      ['node:child_process', 'child_process'].includes(node.text),
  );
}

export function hasDirectChildProcessImport(source, filename = 'test.ts') {
  const file = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      isChildProcessSpecifier(node.moduleSpecifier)
    ) {
      found = true;
      return;
    }
    if (ts.isCallExpression(node)) {
      const argument = node.arguments[0];
      if (
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === 'require')) &&
        argument &&
        isChildProcessSpecifier(argument)
      ) {
        found = true;
        return;
      }
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      isChildProcessSpecifier(node.moduleReference.expression)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

export function isDogfoodReconcileFile(path) {
  return (
    path === `${DOGFOOD_RECONCILE_PREFIX}.test.ts` ||
    path.startsWith(`${DOGFOOD_RECONCILE_PREFIX}.`) ||
    path.startsWith(`${DOGFOOD_RECONCILE_PREFIX}/`)
  );
}

/** Vitest's own list command is the sole discovery authority. */
export function discoverVitestFiles({
  root = process.cwd(),
  spawnSync = defaultSpawnSync,
  excludes = [],
} = {}) {
  const vitest = resolve(root, 'node_modules/vitest/vitest.mjs');
  if (
    !Array.isArray(excludes) ||
    excludes.some(
      (pattern) =>
        typeof pattern !== 'string' ||
        pattern.length === 0 ||
        /[\r\n]/.test(pattern),
    )
  ) {
    throw new Error(
      'Vitest discovery excludes must be non-empty one-line strings',
    );
  }
  const result = spawnSync(
    process.execPath,
    [
      vitest,
      'list',
      '--filesOnly',
      ...excludes.map((pattern) => `--exclude=${pattern}`),
    ],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Vitest discovery failed with status ${result.status ?? 'unknown'}: ${String(result.stderr ?? '').trim()}`,
    );
  }
  const files = String(result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => TEST_FILE_PATTERN.test(line))
    .map(normalizedPath)
    .sort();
  if (files.length === 0) throw new Error('Vitest discovery returned no files');
  return files;
}

function explicitFiles(manifest) {
  return [
    ...manifest.processHeavy.files,
    ...manifest.processExclusive.files,
    ...manifest.coordinatorExclusive.files,
    ...manifest.credentialLedgerExclusive.files,
    ...manifest.sharedOutput.files,
  ];
}

/**
 * Compact exclusion projection for the ordinary group.  Keeping the compact
 * argv below the Windows 32,767 character limit matters, but it is never
 * trusted on its own: `discoverVitestResourceGroups` lists its effective set
 * and compares it to the exact manifest partition before a run can start.
 */
export function ordinaryVitestExcludes(manifest = VITEST_RESOURCE_MANIFEST) {
  return Object.freeze([
    ...manifest.processHeavy.files,
    ...manifest.processExclusive.files,
    ...manifest.coordinatorExclusive.files,
    ...manifest.credentialLedgerExclusive.files,
    ...manifest.sharedOutput.files,
    `${manifest.dogfoodReconcile.prefix}*.test.ts`,
    `${manifest.dogfoodReconcile.prefix}/**`,
  ]);
}

export function assertOrdinaryVitestSelection(
  groups,
  {
    root = process.cwd(),
    spawnSync = defaultSpawnSync,
    manifest = VITEST_RESOURCE_MANIFEST,
  } = {},
) {
  const selected = discoverVitestFiles({
    root,
    spawnSync,
    excludes: ordinaryVitestExcludes(manifest),
  });
  if (
    selected.length !== groups.ordinary.length ||
    selected.some((file, index) => file !== groups.ordinary[index])
  ) {
    throw new Error(
      'compact ordinary Vitest selection does not exactly equal the manifest partition',
    );
  }
  return selected;
}

/**
 * Validate and partition a discovered corpus.  Throws rather than returning a
 * partial selection: a false-green test command is worse than a slow one.
 */
export function buildVitestResourceGroups(
  discovered,
  { root = process.cwd(), manifest = VITEST_RESOURCE_MANIFEST } = {},
) {
  if (!Array.isArray(discovered) || discovered.length === 0) {
    throw new Error('Vitest resource manifest requires a non-empty discovery');
  }
  const normalizedDiscovered = discovered.map(normalizedPath).sort();
  const discoveredSet = new Set(normalizedDiscovered);
  if (discoveredSet.size !== normalizedDiscovered.length) {
    throw new Error('Vitest discovery contains duplicate test paths');
  }

  const explicit = explicitFiles(manifest);
  const explicitSet = new Set(explicit);
  if (explicitSet.size !== explicit.length) {
    throw new Error('Vitest resource groups must be disjoint');
  }
  for (const file of explicit) {
    if (!isSafeRelativeFile(file)) {
      throw new Error(`unsafe Vitest resource manifest path: ${String(file)}`);
    }
    if (isDogfoodReconcileFile(file)) {
      throw new Error(
        `dogfood-reconcile file must not be explicitly reclassified: ${file}`,
      );
    }
    if (!discoveredSet.has(file)) {
      throw new Error(
        `Vitest resource manifest path is not discovered: ${file}`,
      );
    }
    if (!existsSync(resolve(root, file))) {
      throw new Error(`Vitest resource manifest path does not exist: ${file}`);
    }
  }

  const groups = {
    ordinary: [],
    processHeavy: [],
    processExclusive: [],
    coordinatorExclusive: [],
    credentialLedgerExclusive: [],
    sharedOutput: [],
    dogfoodReconcile: [],
  };
  for (const file of normalizedDiscovered) {
    if (isDogfoodReconcileFile(file)) groups.dogfoodReconcile.push(file);
    else if (manifest.sharedOutput.files.includes(file))
      groups.sharedOutput.push(file);
    else if (manifest.processExclusive.files.includes(file))
      groups.processExclusive.push(file);
    else if (manifest.coordinatorExclusive.files.includes(file))
      groups.coordinatorExclusive.push(file);
    else if (manifest.credentialLedgerExclusive.files.includes(file))
      groups.credentialLedgerExclusive.push(file);
    else if (manifest.processHeavy.files.includes(file))
      groups.processHeavy.push(file);
    else groups.ordinary.push(file);
  }
  if (groups.dogfoodReconcile.length === 0) {
    throw new Error(
      'Vitest resource manifest discovered no dogfood-reconcile files',
    );
  }

  // New process-tree tests are deliberately noisy until a reviewer chooses a
  // resource group.  Shared-output and dogfood placement are valid reviewed
  // exceptions; ordinary placement is never implicit for these imports.
  for (const file of normalizedDiscovered) {
    const source = readFileSync(resolve(root, file), 'utf8');
    if (
      hasDirectChildProcessImport(source, file) &&
      groups.ordinary.includes(file)
    ) {
      throw new Error(
        `direct node:child_process importer needs an explicit resource classification: ${file}`,
      );
    }
  }

  const classified = Object.values(groups).flat();
  if (
    classified.length !== normalizedDiscovered.length ||
    new Set(classified).size !== normalizedDiscovered.length
  ) {
    throw new Error('Vitest resource groups do not exactly cover discovery');
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(groups).map(([name, files]) => [
        name,
        Object.freeze(files),
      ]),
    ),
  );
}

export function discoverVitestResourceGroups(options = {}) {
  const groups = buildVitestResourceGroups(
    discoverVitestFiles(options),
    options,
  );
  assertOrdinaryVitestSelection(groups, options);
  return groups;
}
