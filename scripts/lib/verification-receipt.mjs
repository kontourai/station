import { createHash } from 'node:crypto';

import { laneManifestDigest, resolveLane } from '../verification-lanes.mjs';

// station#3584: adding terminal.indeterminate is not additively compatible.
// $defs.terminal sets additionalProperties: false, so origin/main's schema
// rejects a receipt carrying the new field, and the new assertReceiptSemantics
// (which requires indeterminate to match its own derivation) rejects a
// pre-fix receipt that never wrote it. Both directions land in
// completedReceipt(), which swallows the mismatch to null -- benign for
// reuse (falls through to real execution) but publishJoinedReceipt then
// throws 'owner finished without a valid canonical receipt', so a joiner
// reading an old receipt sees the coordinator's generic CLI exit 2 rather
// than the exit 1 a real failure would have produced. Bumping the version
// makes that cross-version window an explicit, detectable mismatch instead
// of a silent behavior change under an unchanged version number.
export const VERIFICATION_RECEIPT_SCHEMA_VERSION = 3;

const TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'infrastructure_error',
  'canceled',
  'timed_out',
  // A bounded coordinator queue can decline a request before any phase runs.
  'rejected',
  // A run whose output could not be parsed into trustworthy counts can never
  // be a pass, even if the child exited zero.
  'parser_error',
  // An interim, not-yet-final result is never a pass.
  'provisional',
]);

const DISPOSITIONS = new Set(['executed', 'joined', 'reused', 'forced']);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function requiredDigest(value, name) {
  const digest = requiredString(value, name);
  if (!SHA256_PATTERN.test(digest)) {
    throw new Error(`${name} must be exactly 64 lowercase hex characters`);
  }
  return digest;
}

/**
 * Mirrors the JSON Schema's artifact contract so the runtime rejects a
 * malformed artifact before any pass/acceptance. Schema validation alone is
 * not enough when a consumer invokes the semantic guard directly on a receipt
 * loaded from disk or constructed by hand: a forged artifact path or digest
 * would otherwise ride a syntactically valid receipt into a pass decision.
 *
 * The path must be a safe repo-local `.kontourai/`-rooted relative path — no
 * absolute, Windows-drive, backslash, or `..`-traversal segment — and the
 * digest must be exactly 64 lowercase hex characters.
 */
const ARTIFACT_PATH_PATTERN =
  /^\.kontourai\/(?:[A-Za-z0-9._@+-]+\/)*[A-Za-z0-9._@+-]+$/;
const ARTIFACT_TRAVERSAL_PATTERN = /(?:^|\/)\.\.(?:\/|$)/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ARTIFACT_ALLOWED_KEYS = new Set(['path', 'sha256']);

function assertValidArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new Error('artifact must be a { path, sha256 } object');
  }
  for (const key of Object.keys(artifact)) {
    if (!ARTIFACT_ALLOWED_KEYS.has(key)) {
      throw new Error(`artifact has an unknown property: ${key}`);
    }
  }
  const { path, sha256 } = artifact;
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('artifact path must be a non-empty string');
  }
  if (path.includes('\\')) {
    throw new Error(`artifact path must not contain a backslash: ${path}`);
  }
  if (ARTIFACT_TRAVERSAL_PATTERN.test(path)) {
    throw new Error(
      `artifact path must not traverse outside .kontourai: ${path}`,
    );
  }
  if (!ARTIFACT_PATH_PATTERN.test(path)) {
    throw new Error(
      `artifact path must be a safe .kontourai relative path: ${path}`,
    );
  }
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
    throw new Error(
      `artifact sha256 must be exactly 64 lowercase hex characters: ${sha256}`,
    );
  }
}

/**
 * Validates every artifact equivalently to the JSON Schema. Called by both the
 * producer and the semantic guard so a bad artifact is rejected at construction
 * and again at acceptance, regardless of whether Ajv ever saw the receipt.
 */
function assertArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) {
    throw new Error('receipt artifacts must be an array');
  }
  for (const artifact of artifacts) {
    assertValidArtifact(artifact);
  }
}

/**
 * Builds the exact identity that decides whether a receipt can be reused.
 * Callers must capture this before and after execution; a changed identity is
 * never eligible for a pass regardless of the child exit code.
 *
 * Only stable identity fields participate: repository, worktree, HEAD, the
 * working tree, the lane/command/manifest, the dependency lockfile, the Node
 * runtime, the package-manager toolchain, and platform/arch. Volatile machine
 * telemetry (load average, memory) is deliberately excluded so a saturated box
 * cannot make a stable run look drifted, and a passing run cannot be rounded up
 * by ignoring a real identity change.
 */
export function createVerificationRequest(laneId, provenance) {
  const lane = resolveLane(laneId);
  const request = {
    repositoryId: requiredString(provenance.repositoryId, 'repositoryId'),
    worktree: requiredString(provenance.worktree, 'worktree'),
    headSha: requiredString(provenance.headSha, 'headSha'),
    workspaceDigest: requiredString(
      provenance.workspaceDigest,
      'workspaceDigest',
    ),
    environmentDigest: requiredDigest(
      provenance.environmentDigest,
      'environmentDigest',
    ),
    laneId: lane.id,
    command: lane.command,
    manifestDigest: laneManifestDigest(lane.id),
    dependencyDigest: requiredString(
      provenance.dependencyDigest,
      'dependencyDigest',
    ),
    nodeVersion: requiredString(provenance.nodeVersion, 'nodeVersion'),
    toolchain: requiredString(provenance.toolchain, 'toolchain'),
    toolchainIdentity: requiredDigest(
      provenance.toolchainIdentity?.digest,
      'toolchainIdentity.digest',
    ),
    platform: requiredString(provenance.platform, 'platform'),
    arch: requiredString(provenance.arch, 'arch'),
  };
  return {
    ...request,
    key: createHash('sha256').update(stableJson(request)).digest('hex'),
  };
}

/**
 * Recomputes only the request key from a provenance object. Used to bind the
 * recorded before/after provenance to the request identity — a receipt whose
 * before does not re-derive to its request key claims to be about a different
 * workspace than it actually ran.
 */
export function verificationRequestKey(laneId, provenance) {
  return createVerificationRequest(laneId, provenance).key;
}

/**
 * The request fields recomputed from the lane identity and provenance. The
 * request key alone cannot certify these: an attacker who retains the original
 * key but rewrites `request.command` (or `manifestDigest`, `dependencyDigest`,
 * `toolchain`, …) passes a key-only check, because the key is re-derived from
 * the unchanged provenance and still equals the stored key — while a consumer
 * reading `request.command` directly trusts the forged value. Recomputing and
 * comparing the full projection binds every recorded request field to the lane
 * catalog and the provenance it claims to describe.
 */
const REQUEST_PROJECTION_FIELDS = [
  'repositoryId',
  'worktree',
  'headSha',
  'workspaceDigest',
  'environmentDigest',
  'laneId',
  'command',
  'manifestDigest',
  'dependencyDigest',
  'nodeVersion',
  'toolchain',
  'toolchainIdentity',
  'platform',
  'arch',
  'key',
];

function assertRequestBoundToProvenance(request, provenance) {
  const canonical = createVerificationRequest(request.laneId, provenance);
  for (const field of REQUEST_PROJECTION_FIELDS) {
    if (request[field] !== canonical[field]) {
      throw new Error(
        `receipt request.${field} is not the canonical projection of its lane and provenance`,
      );
    }
  }
}

function isPassingCounts(counts) {
  // Records carry no `skipped` field, so a complete pass requires every
  // executed test to have passed: passed === executed. Without this, counts
  // like { executed: 2, passed: 1, failed: 0, infrastructureErrors: 0 } leave
  // one test unaccounted for yet would otherwise read as a clean pass.
  return (
    counts != null &&
    Number.isInteger(counts.executed) &&
    counts.executed > 0 &&
    Number.isInteger(counts.passed) &&
    counts.passed > 0 &&
    counts.passed === counts.executed &&
    Number.isInteger(counts.failed) &&
    counts.failed === 0 &&
    Number.isInteger(counts.infrastructureErrors) &&
    counts.infrastructureErrors === 0
  );
}

/**
 * Whether every non-provenance input to `passed` is already clean: `status
 * === 'completed'`, `exitCode === 0`, cleanup is `passed`/`not_required`
 * with no surviving owned child, and the counts alone would satisfy
 * `isPassingCounts`. This function does not look at `provenanceStable` or
 * `passed` itself — on its own it only says "nothing outside provenance
 * disagrees"; it is the caller's `!passed &&` conjunction that turns this
 * into "the only reason `passed` is false is provenance instability".
 *
 * Cleanup and child-reaping are deliberately part of this "must be clean"
 * set, not exempted alongside provenance (station#3584 review correction):
 * a child that exits zero but leaves something un-reapable is a genuine
 * defect — this repo has a documented history of orphaned processes wedging
 * a host — and "re-run rather than diagnose" is exactly the wrong advice for
 * that shape; re-running only compounds the leak. Only a provenance
 * mismatch means "missing information about a tree that already moved on",
 * so only provenance instability is eligible for `indeterminate` below.
 */
function isCleanExceptForProvenance({
  status,
  exitCode,
  cleanupStatus,
  survivingOwnedChildren,
  counts,
}) {
  return (
    status === 'completed' &&
    exitCode === 0 &&
    (cleanupStatus === 'passed' || cleanupStatus === 'not_required') &&
    survivingOwnedChildren === 0 &&
    isPassingCounts(counts)
  );
}

/**
 * Fail-closed terminal classification. Only a settled, stable, clean,
 * zero-exit result with complete passing counts is a pass. Every non-completed
 * status (failed, infrastructure_error, canceled, timed_out, rejected, parser_error,
 * provisional) never passes, and skipped-only or partial counts never pass.
 *
 * A `false` verdict is additionally marked `indeterminate: true` when
 * `provenanceStable` is the *only* thing that disagrees — status, exit code,
 * cleanup, and counts are all clean. `request.key` is derived once from the
 * `before` provenance captured at coordinator entry; `provenanceStable` is
 * whether an `after` snapshot, captured later, still re-derives that same
 * key. For a directly-executed run "later" is just its own runtime, so
 * instability there means the tracked-file tree moved out from under this
 * run while it executed — a real ambiguity, not a defect the run itself
 * reported. (A joiner facing this same ambiguity after waiting on another
 * owner does not reach this label at all: it re-checks its own provenance
 * after the wait and retries as a fresh, real execution instead of adopting
 * a stale projection — see `publishJoinedReceipt` in
 * verification-coordinator.mjs. `indeterminate` is the residual case that
 * retry cannot resolve, not the common join outcome.) `passed` itself stays
 * `false` either way — fail-closed, unchanged shape for a genuine failure;
 * `indeterminate` is the additive signal telling a caller to re-run rather
 * than diagnose.
 */
export function classifyTerminal({
  status,
  exitCode,
  provenanceStable,
  cleanupStatus,
  survivingOwnedChildren = 0,
  counts,
}) {
  if (!TERMINAL_STATUSES.has(status)) {
    throw new Error(`unknown verification terminal status: ${status}`);
  }
  const normalizedExitCode = Number.isInteger(exitCode) ? exitCode : null;
  const passed =
    status === 'completed' &&
    normalizedExitCode === 0 &&
    provenanceStable === true &&
    (cleanupStatus === 'passed' || cleanupStatus === 'not_required') &&
    survivingOwnedChildren === 0 &&
    isPassingCounts(counts);
  const indeterminate =
    !passed &&
    provenanceStable !== true &&
    isCleanExceptForProvenance({
      status,
      exitCode: normalizedExitCode,
      cleanupStatus,
      survivingOwnedChildren,
      counts,
    });
  return {
    status,
    exitCode: normalizedExitCode,
    passed,
    ...(indeterminate ? { indeterminate: true } : {}),
  };
}

/**
 * Produces an immutable-shape receipt whose stability is bound to the request
 * identity. The recorded `provenance.stable` is not a free claim: it is the
 * re-derived request key of the after provenance matching the request (and the
 * before provenance must already bind to the request), so a receipt cannot
 * pair request A with provenance B.
 */
export function createVerificationReceipt({
  request,
  disposition = 'executed',
  status,
  exitCode,
  counts,
  artifacts = [],
  cleanup,
  before,
  after,
  reusableOutputs,
  recoveredFailures,
  reconcileNote,
}) {
  if (!DISPOSITIONS.has(disposition)) {
    throw new Error(`unknown receipt disposition: ${disposition}`);
  }
  if (!isFiniteCountsShape(counts)) {
    throw new Error('a verification receipt requires integer result counts');
  }
  // The request identity binds before and after provenance. The before must
  // re-derive to the request key (it is the workspace the request describes);
  // stability is then whether the after provenance still matches that same key.
  // Machine telemetry is not part of the request, so it cannot flip stability.
  const beforeKey = verificationRequestKey(request.laneId, before);
  if (beforeKey !== request.key) {
    throw new Error(
      'receipt request does not bind the before provenance identity',
    );
  }
  // The key binding above is necessary but not sufficient: a tampered request
  // field (command, manifestDigest, dependencyDigest, …) survives it whenever
  // the original key is retained. Recompute the full projection and compare
  // every field so the recorded request is exactly what the lane + provenance
  // would produce.
  assertRequestBoundToProvenance(request, before);
  // Validate artifacts at construction so a producer can never emit a receipt
  // carrying a forged path or digest, mirroring the schema contract.
  assertArtifacts(artifacts);
  const stable = verificationRequestKey(request.laneId, after) === request.key;
  const terminal = classifyTerminal({
    status,
    exitCode,
    provenanceStable: stable,
    cleanupStatus: cleanup?.status,
    survivingOwnedChildren: cleanup?.survivingOwnedChildren,
    counts,
  });
  // Additive recovered-evidence fields (sol review of #2654): persisted so
  // a receipt reader sees WHAT failed and WHY ordinary reporting broke —
  // never counts alone. Validated shapes only; absent otherwise.
  const boundedRecovered = Array.isArray(recoveredFailures)
    ? recoveredFailures
        .filter(
          (failure) =>
            typeof failure?.file === 'string' &&
            typeof failure?.name === 'string',
        )
        .slice(0, 32)
        .map(({ file, name }) => ({
          file: file.slice(0, 512),
          name: name.slice(0, 512),
        }))
    : [];
  if (boundedRecovered.length) terminal.recoveredFailures = boundedRecovered;
  if (typeof reconcileNote === 'string' && reconcileNote.length)
    terminal.reconcileNote = reconcileNote.slice(0, 1024);
  const requiredReusableOutputs =
    resolveLane(request.laneId).reusableOutputs ?? [];
  if (
    terminal.passed &&
    requiredReusableOutputs.length > 0 &&
    (!Array.isArray(reusableOutputs) ||
      reusableOutputs.length !== requiredReusableOutputs.length)
  )
    throw new Error(
      'a passing reusable lane receipt requires exact output bindings',
    );
  if (terminal.passed && requiredReusableOutputs.length > 0)
    assertReusableOutputBindings(reusableOutputs, requiredReusableOutputs);
  return {
    schemaVersion: VERIFICATION_RECEIPT_SCHEMA_VERSION,
    request,
    disposition,
    terminal,
    counts,
    artifacts,
    cleanup,
    provenance: { stable, before, after },
    ...(reusableOutputs?.length ? { reusableOutputs } : {}),
  };
}

function assertReusableOutputBindings(bindings, expectedOutputs) {
  if (!Array.isArray(bindings) || bindings.length !== expectedOutputs.length)
    throw new Error('reusable output binding count does not match the lane');
  const seen = new Set();
  for (const binding of bindings) {
    const keys = Object.keys(binding ?? {}).sort();
    if (
      JSON.stringify(keys) !==
        JSON.stringify(
          ['manifestDigest', 'path', 'payloadDigest', 'runId'].sort(),
        ) ||
      !expectedOutputs.includes(binding?.path) ||
      seen.has(binding.path) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(binding?.runId ?? '') ||
      !/^[0-9a-f]{64}$/.test(binding?.manifestDigest ?? '') ||
      !/^[0-9a-f]{64}$/.test(binding?.payloadDigest ?? '')
    )
      throw new Error('reusable output binding has an invalid identity');
    seen.add(binding.path);
  }
}

function isFiniteCountsShape(counts) {
  return (
    counts != null &&
    Number.isInteger(counts.executed) &&
    counts.executed >= 0 &&
    Number.isInteger(counts.passed) &&
    counts.passed >= 0 &&
    Number.isInteger(counts.failed) &&
    counts.failed >= 0 &&
    Number.isInteger(counts.infrastructureErrors) &&
    counts.infrastructureErrors >= 0
  );
}

/**
 * Semantic guard that enforces the same fail-closed truth table as the JSON
 * Schema, plus the request/before/after identity binding a schema cannot
 * compute (it cannot hash provenance). A receipt is honest only when its
 * recorded `provenance.stable` equals the re-derived after identity, and a
 * passing receipt must satisfy every pass condition with no rounding up.
 */
export function assertReceiptSemantics(receipt) {
  if (receipt?.schemaVersion !== VERIFICATION_RECEIPT_SCHEMA_VERSION) {
    throw new Error('unsupported verification receipt schema version');
  }
  const { request, terminal, counts, cleanup, provenance } = receipt;
  if (!request?.laneId) {
    throw new Error('receipt is missing a request lane identity');
  }
  // Reject a request paired with provenance it does not describe.
  const beforeKey = verificationRequestKey(request.laneId, provenance.before);
  if (beforeKey !== request.key) {
    throw new Error(
      'receipt request does not bind the before provenance identity',
    );
  }
  // The key check catches a swapped before; the projection check catches a
  // tampered request field (command, manifestDigest, dependencyDigest, …)
  // that retained the original key. Both must hold before any acceptance.
  assertRequestBoundToProvenance(request, provenance.before);
  // Validate every artifact equivalently to the schema before any pass
  // decision, so a receipt loaded from disk or forged by hand cannot carry a
  // path or digest the schema would reject.
  assertArtifacts(receipt.artifacts);
  const reusableOutputs = resolveLane(request.laneId).reusableOutputs ?? [];
  if (terminal?.passed && reusableOutputs.length) {
    assertReusableOutputBindings(receipt.reusableOutputs, reusableOutputs);
  }
  const afterBound = verificationRequestKey(request.laneId, provenance.after);
  const derivedStable = afterBound === request.key;
  if (provenance.stable !== derivedStable) {
    throw new Error(
      'provenance.stable does not match the recorded before/after identity',
    );
  }
  if (terminal?.passed) {
    if (!derivedStable) {
      throw new Error('a drifted verification receipt cannot pass');
    }
    if (terminal.status !== 'completed' || terminal.exitCode !== 0) {
      throw new Error('only a completed zero-exit result can pass');
    }
    if (!isPassingCounts(counts)) {
      throw new Error(
        'a verification receipt cannot pass without complete passing counts',
      );
    }
    if (cleanup?.status !== 'passed' && cleanup?.status !== 'not_required') {
      throw new Error(
        'a verification receipt cannot pass without successful cleanup',
      );
    }
    if (cleanup?.survivingOwnedChildren !== 0) {
      throw new Error('a receipt with surviving owned children cannot pass');
    }
  }
  // `indeterminate` must be exactly the re-derived signal, in both
  // directions: a forged receipt must not launder a genuine failure (e.g. a
  // failed cleanup or a surviving owned child, both real defects) into
  // "re-run, don't diagnose" by claiming indeterminate, nor hide a real
  // provenance-only indeterminate verdict as a diagnosable failure by
  // omitting it. Reuses the same `isCleanExceptForProvenance` predicate
  // classifyTerminal derives from -- with the SAME `survivingOwnedChildren`
  // default classifyTerminal applies via its own parameter default
  // (missing -> 0), so a receipt whose cleanup omits that field (schema-
  // invalid; every real producer supplies it) is classified identically by
  // both rather than silently diverging.
  const derivedIndeterminate =
    !terminal?.passed &&
    !derivedStable &&
    isCleanExceptForProvenance({
      status: terminal?.status,
      exitCode: terminal?.exitCode,
      cleanupStatus: cleanup?.status,
      survivingOwnedChildren: cleanup?.survivingOwnedChildren ?? 0,
      counts,
    });
  if (Boolean(terminal?.indeterminate) !== derivedIndeterminate) {
    throw new Error(
      'receipt terminal.indeterminate does not match its own status/exitCode/counts',
    );
  }
  return receipt;
}
