/**
 * Canonical Station verification lane catalog.
 *
 * One source of truth for every verification surface: intentional lane IDs,
 * literal commands, resource class, evidence status, owned mutable outputs,
 * and manifest identity. The coordinator (Wave 2), changed-scope selector
 * (Wave 4), policy gate (Wave 6), and the Flow Agents consumer (#1111) all
 * read lane identity from this catalog instead of re-deriving it from
 * `package.json` scripts or `process.cwd()`.
 *
 * `full-regression` is the only canonical completion lane: its literal command
 * `npm run full:regression` is the sole trust-reconcile evidence command.
 * `ci-fast` is deliberately diagnostic, bounded feedback. Every other lane is
 * also diagnostic — its receipt can inform a decision but cannot stand in for
 * the completion floor.
 *
 * Consume — never fork — the existing lane inputs (`prepush-test-manifest.mjs`
 * and `tests/e2e-manifest.mjs`) referenced by the `manifest` field. A lane's
 * `ownedOutputs` is the truthful, conservative set of mutable repository paths
 * that lane creates: empty means the lane is genuinely read-only, not "unknown".
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { e2eManifest } from '../tests/e2e-manifest.mjs';
import { PREPUSH_TEST_GROUPS } from './prepush-test-manifest.mjs';
import { TEST_IMPACT_MANIFEST } from './test-impact-manifest.mjs';

/**
 * The sole canonical completion lane. Its literal command is the only
 * trust-reconcile evidence command and the only receipt that can certify
 * the final exact workspace.
 */
export const CANONICAL_COMPLETION_LANE = 'full-regression';

/**
 * The literal command string for the canonical completion lane. This must
 * remain byte-identical to the `trust-reconcile-manifest` command in
 * `package.json`.
 */
export const CANONICAL_COMPLETION_COMMAND = 'npm run full:regression';

/**
 * Hard execution ceiling for diagnostic per-push feedback. The hosted lane
 * reached 6m55s with 385 selected tests before the seven-minute coordinator
 * deadline canceled it. Twelve minutes retains a finite, non-completion lane
 * while leaving conservative measured headroom for the slower fleet host
 * rather than treating its timeout as a changed-test failure.
 */
export const CI_FAST_TIMEOUT_MS = 12 * 60_000;

/**
 * The full completion claim is phase-attested. The coordinator admits these
 * phases independently, so the full corpus only occupies exclusive capacity
 * for its own phase. Phase records are bound to the parent request and are
 * never public lanes or independently reusable receipts.
 */
export const FULL_REGRESSION_PHASES = Object.freeze([
  Object.freeze({
    id: 'repo-governance',
    command: 'npm run proof:repo-governance',
    privateScript: 'proof:repo-governance',
    weight: 20,
    // This proof is deliberately small; five minutes leaves diagnostic room
    // without letting a blocked tool hold a completion request indefinitely.
    timeoutMs: 5 * 60_000,
  }),
  Object.freeze({
    id: 'sdk-builds',
    command: 'npm run proof:sdk-builds',
    privateScript: 'proof:sdk-builds',
    weight: 50,
    timeoutMs: 10 * 60_000,
  }),
  Object.freeze({
    id: 'verify-static',
    command: 'npm run verify:static:raw',
    privateScript: 'verify:static:raw',
    weight: 60,
    timeoutMs: 15 * 60_000,
  }),
  Object.freeze({
    id: 'test-full-ordinary',
    command: 'npm run test:full:ordinary:raw',
    privateScript: 'test:full:ordinary:raw',
    // Keep one fifth of host coordinator capacity available for the bounded
    // per-push lane while the completion corpus is running.
    weight: 80,
    // The incident behind #1607 exceeded twenty minutes while making no
    // progress. Keep this fence below that known stalled run, while allowing
    // the 80-unit corpus to finish under the explicitly supported overlap
    // with one 20-unit ci:fast reservation (#881).
    timeoutMs: 18 * 60_000,
  }),
  Object.freeze({
    id: 'test-full-process-heavy',
    command: 'npm run test:full:process-heavy:raw',
    privateScript: 'test:full:process-heavy:raw',
    weight: 60,
    // The current two-worker corpus measured 471.99s after 2,410 passing
    // tests; its former 259.24s measurement predated the current handoff and
    // Basis coverage. #881 then reproduced a ten-minute infrastructure
    // timeout with the supported 60+20+20 host-capacity overlap and no failed
    // test identity. Twenty minutes is still an execution fence, not an
    // assertion target or permission to add sleeps.
    timeoutMs: 20 * 60_000,
  }),
  Object.freeze({
    id: 'test-full-process-exclusive',
    command: 'npm run test:full:process-exclusive:raw',
    privateScript: 'test:full:process-exclusive:raw',
    weight: 60,
    timeoutMs: 4 * 60_000,
  }),
  Object.freeze({
    id: 'test-full-shared-output',
    command: 'npm run test:full:shared-output:raw',
    privateScript: 'test:full:shared-output:raw',
    weight: 60,
    timeoutMs: 4 * 60_000,
  }),
  Object.freeze({
    id: 'test-full-dogfood-reconcile',
    command: 'npm run test:full:dogfood-reconcile:raw',
    privateScript: 'test:full:dogfood-reconcile:raw',
    weight: 60,
    timeoutMs: 5 * 60_000,
  }),
  Object.freeze({
    id: 'app-builds',
    command: 'npm run proof:app-builds',
    privateScript: 'proof:app-builds',
    weight: 60,
    timeoutMs: 10 * 60_000,
  }),
]);

export const FULL_REGRESSION_TIMEOUT_MS = FULL_REGRESSION_PHASES.reduce(
  (total, phase) => total + phase.timeoutMs,
  0,
);

/**
 * Resource / evidence classification for a lane. Determines how the
 * coordinator schedules it, whether its receipt is completion evidence, and
 * how the policy gate describes it.
 */
export const LANE_CLASSES = Object.freeze({
  /** The one canonical completion gate (full-regression only). */
  COMPLETION: 'completion',
  /** A bounded deterministic focused floor (npm test / prepush). */
  FOCUSED: 'focused',
  /** A conservative changed-scope checkpoint (Wave 4, diagnostic only). */
  CHANGED: 'changed',
  /** A full static or local integration gate. */
  INTEGRATION: 'integration',
  /** A Playwright E2E coverage contract. */
  E2E: 'e2e',
  /** A native/mobile compile or nightly lane. */
  NATIVE: 'native',
});

/**
 * Human-readable resource-class labels for the rendered lane table. The closed
 * class vocabulary is the source of truth; this only maps each value to the
 * phrase shown in AGENTS.md so a new class forces a conscious label update.
 */
export const CLASS_LABELS = Object.freeze({
  [LANE_CLASSES.COMPLETION]: 'completion gate',
  [LANE_CLASSES.FOCUSED]: 'focused floor',
  [LANE_CLASSES.CHANGED]: 'changed-scope selector',
  [LANE_CLASSES.INTEGRATION]: 'static / integration',
  [LANE_CLASSES.E2E]: 'full E2E',
  [LANE_CLASSES.NATIVE]: 'native / mobile',
});

/**
 * Manifest identifiers. Each maps to an existing lane-input module whose
 * content participates in the request key. `null` means the lane's command
 * string is its sole manifest identity.
 */
const MANIFEST_PREPUSH = 'prepush-test-groups';
const MANIFEST_E2E = 'e2e-manifest';
const MANIFEST_TEST_IMPACT = 'test-impact-manifest';
const MANIFEST_NONE = null;

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

/**
 * The canonical lane definitions. Every field is intentional: removing or
 * renaming one is a breaking change to the catalog contract.
 *
 * Each lane is explicit about:
 * - trigger: the literal `command` and when it runs;
 * - scope: the `description` of what surface it covers;
 * - evidence: `completion` (the sole trust floor) vs `diagnostic`;
 * - invalidation: the `manifest` whose content participates in the request key
 *   (plus the request's HEAD/workspace/dependency/toolchain fields).
 *
 * @typedef {Object} LaneDefinition
 * @property {string} id - Stable intentional lane identifier.
 * @property {string} command - Literal public command string.
 * @property {string} publicScript - Package script that invokes this public lane.
 * @property {string} class - One of {@link LANE_CLASSES}.
 * @property {boolean} completion - True only for the canonical completion lane.
 * @property {boolean} diagnostic - True when the receipt is diagnostic, not completion evidence.
 * @property {number} timeoutMs - Explicit total coordinator deadline.
 * @property {number} weight - Host-budget weight (0–100, higher = heavier).
 * @property {readonly string[]} ownedOutputs - Mutable repo paths this lane creates (empty = read-only).
 * @property {string|null} manifest - Manifest module identifier or null.
 * @property {string} trigger - When the lane is invoked (short human phrase).
 * @property {string} scope - Expected coverage surface (short human phrase).
 * @property {string} description - Human-readable purpose.
 */
export const LANES = Object.freeze([
  Object.freeze({
    id: CANONICAL_COMPLETION_LANE,
    command: CANONICAL_COMPLETION_COMMAND,
    publicScript: 'full:regression',
    class: LANE_CLASSES.COMPLETION,
    completion: true,
    diagnostic: false,
    // This is only the outer single-flight/receipt coordinator. Individual
    // full-regression phases hold their declared weight while they execute.
    weight: 1,
    // The sum of the independently bounded phase budgets. This remains an
    // outer fence for admission and terminal publication.
    timeoutMs: FULL_REGRESSION_TIMEOUT_MS,
    phases: FULL_REGRESSION_PHASES,
    ownedOutputs: Object.freeze([
      'dist-server/',
      'dist-ui/',
      'packages/sdk/dist',
      'packages/connect/dist',
      'packages/cli/dist/',
      '.kontourai/veritas/evidence/proof-families/',
    ]),
    manifest: MANIFEST_NONE,
    trigger: 'pre-merge / final completion',
    scope:
      'repo-governance + sdk/app builds + static gates + full Vitest corpus',
    description:
      'Canonical full-regression gate (trigger: pre-merge/final). Scope: proof:repo-governance, proof:sdk-builds, verify:static, test:full, proof:app-builds. Evidence: the sole trust-reconcile completion receipt. The full Vitest corpus is resource-profiled into independently safe groups by its runner. Invalidation: command-only (no consumed manifest); the workspace/HEAD/dependency/toolchain request fields still apply.',
  }),
  Object.freeze({
    id: 'ci-fast',
    command: 'npm run ci:fast',
    publicScript: 'ci:fast',
    class: LANE_CLASSES.INTEGRATION,
    completion: false,
    diagnostic: true,
    // A hard coordinator deadline keeps feedback from silently becoming the
    // full corpus. The child runner passes the remaining budget to each gate.
    timeoutMs: CI_FAST_TIMEOUT_MS,
    // Reserve overlap with the full-regression test-full phase (80 + 20).
    // Fast feedback must be able to admit while completion work is in flight.
    weight: 20,
    ownedOutputs: Object.freeze([
      'packages/connect/dist',
      '.kontourai/test-impact/',
    ]),
    manifest: MANIFEST_TEST_IMPACT,
    trigger: 'per-push / bounded feedback',
    scope: 'base-pinned affected Vitest tests + fixed static invariants (≤12m)',
    description:
      'Bounded fast feedback (trigger: per-push). Scope: the affected Vitest selection against STATION_CI_FAST_BASE (origin/main by default) followed by fixed runtime, lockfile, workflow, and verification-policy invariants. Its 20-unit weight is reserved alongside the 80-unit full-regression test phase, so completion work yields admission headroom for feedback. Full static gates and the full Vitest corpus belong only to full-regression. Evidence: diagnostic only; a deferred selector intentionally requires the full-regression completion gate. Invalidation: test-impact manifest plus the request workspace/HEAD/dependency/toolchain and STATION_CI_FAST_BASE environment identity.',
  }),
  Object.freeze({
    id: 'test-changed',
    command: 'npm run test:changed',
    publicScript: 'test:changed',
    class: LANE_CLASSES.CHANGED,
    completion: false,
    diagnostic: true,
    weight: 20,
    timeoutMs: 5 * 60_000,
    ownedOutputs: Object.freeze(['.kontourai/test-impact/']),
    manifest: MANIFEST_TEST_IMPACT,
    trigger: 'per-edit local feedback',
    scope: 'Vitest related imports + dynamic-boundary edges',
    description:
      'Diagnostic changed-scope selector (trigger: local feedback). Scope: Vitest related imports plus explicit dynamic-boundary edges. Evidence: explicitly non-completion; cannot replace full-regression. Its receipt identity includes the exact test-impact manifest. Unknown, selector, lockfile, shared-contract, high-fanout, and empty selections escalate to named deferred lanes.',
  }),
  Object.freeze({
    id: 'prepush',
    command: 'npm run test:prepush',
    publicScript: 'test:prepush',
    class: LANE_CLASSES.FOCUSED,
    completion: false,
    diagnostic: true,
    weight: 40,
    timeoutMs: 10 * 60_000,
    ownedOutputs: Object.freeze([
      'packages/connect/dist',
      'packages/cli/dist/',
      '.kontourai/test-reliability/prepush-latest.json',
      '.kontourai/test-reliability/prepush-repeat-latest.json',
    ]),
    manifest: MANIFEST_PREPUSH,
    trigger: 'pre-push / focused floor',
    scope: 'prepare:verify-static + prepush test tier',
    description:
      'Bounded deterministic pre-push floor (trigger: pre-push/focused). Scope: prepare:verify-static (rebuilds packages/connect/dist and packages/cli/dist) then run-prepush-tier. Evidence: diagnostic. Invalidation: the prepush test-group manifest content.',
  }),
  Object.freeze({
    id: 'test-full',
    command: 'npm run test:full',
    publicScript: 'test:full',
    class: LANE_CLASSES.INTEGRATION,
    completion: false,
    diagnostic: true,
    weight: 80,
    timeoutMs: 20 * 60_000,
    ownedOutputs: Object.freeze(['packages/cli/dist/']),
    manifest: MANIFEST_NONE,
    trigger: 'diagnostic full corpus',
    scope: 'resource-profiled Vitest corpus + dogfood-reconcile',
    description:
      'Full static Vitest pass (trigger: diagnostic). Scope: the resource-profiled Vitest corpus plus the serialized dogfood-reconcile corpus. The package bundle group mutates packages/cli/dist/. Evidence: diagnostic. Invalidation: command-only.',
  }),
  Object.freeze({
    id: 'test-coverage',
    command: 'npm run test:coverage',
    publicScript: 'test:coverage',
    class: LANE_CLASSES.INTEGRATION,
    completion: false,
    diagnostic: true,
    weight: 90,
    timeoutMs: 25 * 60_000,
    ownedOutputs: Object.freeze(['coverage/', 'packages/cli/dist/']),
    manifest: MANIFEST_NONE,
    trigger: 'explicit coverage / risk',
    scope: 'serialized coverage corpus + dogfood-reconcile',
    description:
      'Coverage diagnostic (trigger: explicit coverage/risk). Scope: the serialized Vitest coverage corpus plus dogfood-reconcile. Evidence: diagnostic. Invalidation: command-only; owns coverage/ and packages/cli/dist/ from the package bundle test.',
  }),
  Object.freeze({
    id: 'verify-static',
    command: 'npm run verify:static',
    publicScript: 'verify:static',
    class: LANE_CLASSES.INTEGRATION,
    completion: false,
    diagnostic: true,
    weight: 90,
    timeoutMs: 15 * 60_000,
    ownedOutputs: Object.freeze([
      'packages/connect/dist',
      'packages/cli/dist/',
    ]),
    manifest: MANIFEST_NONE,
    trigger: 'diagnostic static gate',
    scope:
      'node-runtime, naming, UI-contract, platform, workflow ratchets, lint, typecheck',
    description:
      'Static gate chain (trigger: diagnostic). Scope: the private verify:static:raw adapter runs verify:static:bootstrap (which rebuilds packages/connect/dist and packages/cli/dist) before node-runtime, naming, UI-contract ratchets, platform, workflows, lint, and typecheck. The full Vitest corpus is composed separately by full-regression. The public preverify:static hook is a no-op to avoid coordinator lifecycle recursion. Evidence: diagnostic. Invalidation: command-only; it owns the connect and cli rebuilds.',
  }),
  Object.freeze({
    id: 'verify-local',
    command: 'npm run verify:local',
    publicScript: 'verify:local',
    class: LANE_CLASSES.INTEGRATION,
    completion: false,
    diagnostic: true,
    weight: 100,
    timeoutMs: 30 * 60_000,
    ownedOutputs: Object.freeze([
      'dist-server/',
      'dist-desktop-runtime/',
      'packages/connect/dist',
      'packages/cli/dist/',
      'src-desktop/target/',
    ]),
    manifest: MANIFEST_NONE,
    trigger: 'diagnostic native / local',
    scope: 'verify:static + desktop Rust + mobile Cargo compile',
    description:
      'Local/native escalation (trigger: diagnostic/local). Scope: the private verify:local:raw adapter explicitly invokes verify:static:raw, then verify:desktop-rust and mobile Cargo checks under src-desktop (creating dist-server/, dist-desktop-runtime/, packages/cli/dist/, and src-desktop/target/). Evidence: diagnostic. Invalidation: command-only.',
  }),
  Object.freeze({
    id: 'verify-e2e-full',
    command: 'npm run verify:e2e:full',
    publicScript: 'verify:e2e:full',
    class: LANE_CLASSES.E2E,
    completion: false,
    diagnostic: true,
    weight: 100,
    timeoutMs: 45 * 60_000,
    ownedOutputs: Object.freeze([
      'dist-server-e2e-*/',
      'dist-ui-e2e-*/',
      'test-results/',
      'playwright-report/',
      'gallery/',
      '.kontourai/e2e-latest/',
      '.kontourai/e2e-runs/',
    ]),
    reusableOutputs: Object.freeze(['.kontourai/e2e-latest/']),
    manifest: MANIFEST_E2E,
    trigger: 'diagnostic full E2E',
    scope:
      'product, first-run, starter-clean-install, smoke-live, extended, screenshot, Android buckets',
    description:
      'Full Playwright coverage contract (trigger: diagnostic/E2E). Scope: product, first-run, starter-clean-install, smoke-live, extended, screenshot, and Android buckets; each run also builds instance-named dist-server-e2e-* / dist-ui-e2e-* dirs. Evidence: diagnostic. Invalidation: the consumed tests/e2e-manifest.mjs spec→bucket assignment.',
  }),
]);

export const LANE_IDS = Object.freeze(LANES.map((lane) => lane.id));

const LANE_BY_ID = new Map(LANES.map((lane) => [lane.id, lane]));

/**
 * Returns the lane definition for the given ID. Throws if the ID is not in
 * the canonical catalog — an unknown lane is a programming error, not a
 * fallback to `unsafe`.
 *
 * @param {string} laneId
 * @returns {Readonly<LaneDefinition>}
 */
export function resolveLane(laneId) {
  const lane = LANE_BY_ID.get(laneId);
  if (!lane) {
    throw new Error(`unknown verification lane: ${laneId}`);
  }
  return lane;
}

/**
 * The stable, scope-determining projection of the E2E manifest: the spec →
 * bucket assignment. A rationale or comment edit does not change what runs, so
 * only the assignment participates in the manifest digest.
 */
function e2eAssignmentIdentity() {
  return e2eManifest
    .map((entry) => ({ path: entry.path, bucket: entry.bucket }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function sha256Value(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Computes a stable digest of the lane's manifest content. For lanes with a
 * manifest module this is a digest of the manifest's scope-determining content
 * (the prepush test-file groups, or the E2E spec→bucket assignment). For
 * command-only lanes it is a digest of the literal command string. A
 * manifest-content change invalidates any receipt whose request key
 * incorporated the prior digest.
 *
 * @param {string} laneId
 * @returns {string} hex digest
 */
export function laneManifestDigest(laneId) {
  const lane = resolveLane(laneId);
  switch (lane.manifest) {
    case MANIFEST_PREPUSH:
      return sha256Value(JSON.stringify(PREPUSH_TEST_GROUPS));
    case MANIFEST_E2E:
      return sha256Value(JSON.stringify(e2eAssignmentIdentity()));
    case MANIFEST_TEST_IMPACT:
      return sha256Value(JSON.stringify(TEST_IMPACT_MANIFEST));
    case MANIFEST_NONE:
      return sha256Value(lane.command);
    default:
      throw new Error(
        `lane '${laneId}' references unknown manifest '${lane.manifest}'`,
      );
  }
}

/**
 * Short human phrase naming the manifest content that invalidates a lane's
 * receipt, derived from its manifest identifier. The shared request fields
 * (workspace, HEAD, dependency lockfile, Node runtime, toolchain, platform)
 * invalidate every lane and are stated once in the rendered table's caption,
 * not repeated per row.
 */
export function invalidationRule(manifest) {
  switch (manifest) {
    case MANIFEST_PREPUSH:
      return 'prepush test-group manifest';
    case MANIFEST_E2E:
      return 'E2E spec→bucket assignment';
    case MANIFEST_TEST_IMPACT:
      return 'test-impact manifest';
    case MANIFEST_NONE:
      return 'command only';
    default:
      return 'command only';
  }
}

/**
 * Escapes a value for safe interpolation into a GitHub-flavored Markdown table
 * cell. A literal pipe forges an extra column and a line break forges an extra
 * row, so the backslash is escaped first (to avoid double-escaping a later
 * pipe), the pipe is backslash-escaped, and any line break is collapsed to a
 * single space (GFM table cells cannot span lines). Applied to every rendered
 * cell, this makes the table structurally invariant to its input: no field
 * value can add a column or a row regardless of catalog content.
 */
function escapeMarkdownTableCell(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r\n|\r|\n/g, ' ');
}

/**
 * Renders the canonical lane catalog as a deterministic markdown table for
 * AGENTS.md. This is the single rendered view of `LANES`: every column is
 * derived from a catalog field, so the table cannot carry a stale command,
 * class, evidence status, or invalidation rule. Every cell is Markdown-escaped
 * so a field containing a pipe or line break can never forge an extra column or
 * row. The policy gate asserts that AGENTS.md contains this exact string, so a
 * catalog change that is not re-rendered into the doc fails the gate.
 *
 * @param {readonly LaneDefinition[]} lanes
 * @returns {string}
 */
export function renderLaneCatalogTable(lanes = LANES) {
  const headerCells = [
    'Lane',
    'Command',
    'Trigger',
    'Expected scope',
    'Resource class',
    'Evidence',
    'Invalidated by',
  ];
  const row = (cells) =>
    `| ${cells.map(escapeMarkdownTableCell).join(' | ')} |`;
  const lines = [row(headerCells), row(headerCells.map(() => '---'))];
  for (const lane of lanes) {
    lines.push(
      row([
        `\`${lane.id}\``,
        `\`${lane.command}\``,
        lane.trigger,
        lane.scope,
        CLASS_LABELS[lane.class] ?? String(lane.class),
        lane.completion ? 'completion (trust floor)' : 'diagnostic',
        invalidationRule(lane.manifest),
      ]),
    );
  }
  return lines.join('\n');
}

/**
 * Render the independently admitted canonical completion phases for human
 * guidance. Keep this next to the lane table renderer: the catalog owns both
 * the execution schedule and every rendered statement about its weights.
 */
export function renderFullRegressionPhaseSchedule(lanes = LANES) {
  const completion = lanes.find(
    (lane) => lane.id === CANONICAL_COMPLETION_LANE,
  );
  if (!completion?.phases) return '';
  return completion.phases
    .map(
      (phase) =>
        `- \`${phase.id}\` — ${phase.weight}-unit host reservation; ${Math.round(phase.timeoutMs / 60_000)}-minute execution deadline.`,
    )
    .join('\n');
}

/**
 * Strictly validates the canonical lane catalog and its alignment with the
 * repository's public contracts. Returns a list of human-readable errors;
 * an empty list means the catalog is well-formed.
 *
 * Checks: unique IDs, unique commands, exactly one completion lane, the
 * canonical command matches the trust-reconcile manifest, every lane has a
 * known class, weights are bounded positive integers, no `/unsafe`
 * classification, manifest modules resolve, owned outputs are safe
 * repo-local relative paths, and every lane carries a trigger/scope phrase
 * for the rendered lane table.
 *
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateLanePhases(lane, errors) {
  if (lane.id !== CANONICAL_COMPLETION_LANE) return;
  if (!Array.isArray(lane.phases) || lane.phases.length === 0) {
    errors.push(`canonical lane '${lane.id}' must declare execution phases`);
    return;
  }
  const phaseIds = new Set();
  for (const phase of lane.phases) {
    if (!/^[a-z0-9-]+$/.test(phase?.id ?? ''))
      errors.push(`canonical lane '${lane.id}' has an invalid phase id`);
    if (phaseIds.has(phase?.id))
      errors.push(
        `canonical lane '${lane.id}' has duplicate phase '${phase?.id}'`,
      );
    phaseIds.add(phase?.id);
    if (typeof phase?.command !== 'string' || !phase.command)
      errors.push(
        `canonical lane '${lane.id}' phase '${phase?.id}' is missing a command`,
      );
    if (!/^[a-z0-9][a-z0-9:-]*$/.test(phase?.privateScript ?? ''))
      errors.push(
        `canonical lane '${lane.id}' phase '${phase?.id}' has an invalid private script`,
      );
    else if (phase.command !== `npm run ${phase.privateScript}`)
      errors.push(
        `canonical lane '${lane.id}' phase '${phase?.id}' command must exactly equal npm run ${phase.privateScript}`,
      );
    if (
      !Number.isInteger(phase?.weight) ||
      phase.weight < 1 ||
      phase.weight > 100
    )
      errors.push(
        `canonical lane '${lane.id}' phase '${phase?.id}' has invalid weight ${phase?.weight}`,
      );
    if (!Number.isInteger(phase?.timeoutMs) || phase.timeoutMs < 1)
      errors.push(
        `canonical lane '${lane.id}' phase '${phase?.id}' has invalid timeoutMs ${phase?.timeoutMs}`,
      );
  }
}

function validateLaneIdentity(lane, errors, seenIds, seenCommands) {
  if (!/^[a-z0-9-]+$/.test(lane.id ?? ''))
    errors.push(`lane has invalid id '${lane.id}'`);
  if (typeof lane.command !== 'string' || lane.command.length === 0)
    errors.push(`lane '${lane.id}' is missing a literal command`);
  if (!/^[a-z0-9][a-z0-9:-]*$/.test(lane.publicScript ?? ''))
    errors.push(
      `lane '${lane.id}' has invalid public script '${lane.publicScript}'`,
    );
  if (seenIds.has(lane.id)) errors.push(`duplicate lane id: ${lane.id}`);
  seenIds.add(lane.id);
  if (seenCommands.has(lane.command))
    errors.push(
      `duplicate lane command '${lane.command}' shared by '${lane.id}' and '${seenCommands.get(lane.command)}'`,
    );
  seenCommands.set(lane.command, lane.id);
}

function validateLaneDefinition(lane, errors, seenIds, seenCommands) {
  if (!lane || typeof lane !== 'object') {
    errors.push('lane definition must be an object');
    return;
  }
  validateLaneIdentity(lane, errors, seenIds, seenCommands);
  if (!Object.values(LANE_CLASSES).includes(lane.class))
    errors.push(`lane '${lane.id}' has unknown class '${lane.class}'`);
  if (!Number.isInteger(lane.weight) || lane.weight < 1 || lane.weight > 100)
    errors.push(
      `lane '${lane.id}' has invalid weight ${lane.weight} (must be integer 1–100)`,
    );
  if (!Number.isInteger(lane.timeoutMs) || lane.timeoutMs < 1)
    errors.push(`lane '${lane.id}' has invalid timeoutMs ${lane.timeoutMs}`);
  validateLanePhases(lane, errors);
  if (/unsafe/i.test(lane.class) || /unsafe/i.test(lane.id))
    errors.push(`lane '${lane.id}' has an unsafe classification`);
  if (typeof lane.description !== 'string' || lane.description.length === 0)
    errors.push(`lane '${lane.id}' is missing a description`);
  if (typeof lane.trigger !== 'string' || lane.trigger.length === 0)
    errors.push(`lane '${lane.id}' is missing a trigger phrase`);
  if (typeof lane.scope !== 'string' || lane.scope.length === 0)
    errors.push(`lane '${lane.id}' is missing an expected-scope phrase`);
  validateLaneOutputsAndEvidence(lane, errors);
}

function validateLaneOutputsAndEvidence(lane, errors) {
  // A line break in a rendered table cell forges an extra row, so trigger and
  // scope must each be a single line. The renderer collapses such breaks to a
  // space as defense-in-depth, but the catalog source should not carry them.
  if (typeof lane.trigger === 'string' && /[\r\n]/.test(lane.trigger))
    errors.push(`lane '${lane.id}' trigger must be a single line`);
  if (typeof lane.scope === 'string' && /[\r\n]/.test(lane.scope))
    errors.push(`lane '${lane.id}' scope must be a single line`);
  if (
    !Array.isArray(lane.ownedOutputs) ||
    lane.ownedOutputs.some(
      (path) => typeof path !== 'string' || path.length === 0,
    )
  ) {
    errors.push(`lane '${lane.id}' has invalid owned outputs`);
    return;
  }
  for (const output of lane.ownedOutputs) {
    const outputError = validateOwnedOutput(output, lane.id);
    if (outputError) errors.push(outputError);
  }
  if (lane.completion === lane.diagnostic)
    errors.push(`lane '${lane.id}' must be either completion or diagnostic`);
}

function validateCompletionLanes(lanes, errors) {
  const completionLanes = lanes.filter((lane) => lane?.completion);
  if (completionLanes.length !== 1) {
    errors.push(
      `expected exactly one completion lane, found ${completionLanes.length}: ${completionLanes.map((l) => l.id).join(', ') || 'none'}`,
    );
  }

  const canonical = lanes.find(
    (lane) => lane?.id === CANONICAL_COMPLETION_LANE,
  );
  if (!canonical) {
    errors.push(
      `canonical completion lane '${CANONICAL_COMPLETION_LANE}' is missing from the catalog`,
    );
  } else if (canonical.command !== CANONICAL_COMPLETION_COMMAND) {
    errors.push(
      `canonical lane command is '${canonical.command}', expected '${CANONICAL_COMPLETION_COMMAND}'`,
    );
  }

  if (canonical && !canonical.completion) {
    errors.push(
      `canonical lane '${CANONICAL_COMPLETION_LANE}' must have completion: true`,
    );
  }

  for (const lane of lanes.filter((l) => l?.completion)) {
    if (lane.id !== CANONICAL_COMPLETION_LANE) {
      errors.push(
        `lane '${lane.id}' is marked completion but is not the canonical lane`,
      );
    }
  }
}

export function validateLaneCatalog(lanes = LANES) {
  const errors = [];
  const seenIds = new Set();
  const seenCommands = new Map();
  for (const lane of lanes)
    validateLaneDefinition(lane, errors, seenIds, seenCommands);
  validateCompletionLanes(lanes, errors);

  const trustErrors = validateTrustReconcileAlignment();
  errors.push(...trustErrors);

  return { valid: errors.length === 0, errors };
}

/**
 * Owned outputs must be safe repo-local relative paths: never absolute and
 * never traversing outside the repository. This mirrors the artifact-path
 * contract so a lane cannot declare it mutates a sibling's or system path.
 */
function validateOwnedOutput(output, laneId) {
  if (output.startsWith('/') || output.startsWith('\\')) {
    return `lane '${laneId}' owned output must be relative: ${output}`;
  }
  if (/^[A-Za-z]:[\\/]/.test(output)) {
    return `lane '${laneId}' owned output must not be an absolute drive path: ${output}`;
  }
  if (/(?:^|[/\\])\.\.(?:[/\\]|$)/.test(output)) {
    return `lane '${laneId}' owned output must not traverse outside the repo: ${output}`;
  }
  return null;
}

function validateTrustReconcileAlignment() {
  const errors = [];
  const packagePath = resolve(REPO_ROOT, 'package.json');
  if (!existsSync(packagePath)) {
    errors.push(
      'package.json not found; cannot verify trust-reconcile alignment',
    );
    return errors;
  }

  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  } catch (error) {
    errors.push(`cannot parse package.json: ${error.message}`);
    return errors;
  }

  const trustManifest = packageJson['trust-reconcile-manifest'];
  if (!Array.isArray(trustManifest)) {
    errors.push('package.json trust-reconcile-manifest is not an array');
    return errors;
  }

  const trustCommands = trustManifest
    .map((entry) => entry?.command)
    .filter(Boolean);
  if (!trustCommands.includes(CANONICAL_COMPLETION_COMMAND)) {
    errors.push(
      `trust-reconcile-manifest does not contain the canonical command '${CANONICAL_COMPLETION_COMMAND}'`,
    );
  }

  const ciFastScript = packageJson.scripts?.['ci:fast'];
  if (typeof ciFastScript !== 'string' || ciFastScript.length === 0) {
    errors.push('package.json scripts.ci:fast is missing or empty');
  }

  return errors;
}
