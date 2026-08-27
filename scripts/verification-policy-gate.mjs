import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateE2EManifest } from '../tests/e2e-manifest.mjs';
import { instructionGateErrors } from './agent-instructions-gate.mjs';
import { FAST_STATIC_COMMANDS } from './run-ci-fast.mjs';
import {
  LANES,
  renderFullRegressionPhaseSchedule,
  renderLaneCatalogTable,
} from './verification-lanes.mjs';
import { discoverVitestResourceGroups } from './vitest-resource-manifest.mjs';

const root = resolve(import.meta.dirname, '..');
// Exported so it can serve as an independent oracle for other test-file
// predicates in this repo (station#3435 review MEDIUM-1): a predicate
// checked only against its own re-derivation cannot catch itself narrowing.
export const VITEST_TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const VITEST_RESOURCE_GROUP_NAMES = Object.freeze([
  'ordinary',
  'processHeavy',
  'processExclusive',
  'sharedOutput',
  'dogfoodReconcile',
]);
// This deliberately mirrors the root `vitest.config.ts` test exclusions. The
// corpus comes from Git rather than Vitest's own list command, so the resource
// manifest cannot silently define both sides of its partition. Keep the
// exclusions explicit here and covered by the policy test below: scope drift is
// a gate failure, not an opportunity to shrink the discovered corpus.
export const ROOT_VITEST_TRACKED_EXCLUSIONS = Object.freeze([
  'tests/**',
  '**/node_modules/**',
  'vendor/**',
  '.claude/**',
  '.station/**',
  '**/station-worktrees/**',
]);
const packageJson = JSON.parse(
  readFileSync(resolve(root, 'package.json'), 'utf8'),
);
const guidance = [
  'docs/guides/testing.md',
  'docs/guides/development.md',
  'docs/reference/verification-receipts.md',
  'docs/strategy/local-merge-readiness.md',
].map((file) => ({ file, text: readFileSync(resolve(root, file), 'utf8') }));
export const DIRECT_OPT_IN = Object.freeze({
  'test:load-reliability':
    'host-local pressure experiment; no completion receipt',
  'test:timing-reliability':
    'host-local timing experiment; no completion receipt',
  'test:prepush:repeat':
    'bounded reliability measurement; no completion receipt',
});
export const CI_FAST_STATIC_COMMANDS = Object.freeze([
  Object.freeze([
    process.execPath,
    Object.freeze(['scripts/node-runtime-contract.mjs']),
  ]),
  Object.freeze(['npm', Object.freeze(['run', 'lockfile-sync:gate'])]),
  Object.freeze(['npm', Object.freeze(['run', 'channel-ports:check'])]),
  Object.freeze(['npm', Object.freeze(['run', 'gate:workflows'])]),
  Object.freeze(['npm', Object.freeze(['run', 'content:integrity'])]),
  Object.freeze(['npm', Object.freeze(['run', 'verification:policy:gate'])]),
  // station#4273: the typecheck invariant and its stated precondition. This
  // allowlist is the CANONICAL declaration — `run-ci-fast.mjs` must match it
  // exactly, which is what keeps "what the gate says it runs" and "what the
  // gate runs" from drifting apart.
  Object.freeze(['npm', Object.freeze(['run', 'build:connect'])]),
  Object.freeze([
    process.execPath,
    Object.freeze(['scripts/typecheck-aggregate.mjs']),
  ]),
]);
export const CI_FAST_RESERVED_WEIGHT = 20;
export const FULL_REGRESSION_TEST_WEIGHT = 80;
export const FULL_REGRESSION_TEST_PHASE_IDS = Object.freeze([
  'test-full-ordinary',
  'test-full-process-heavy',
  'test-full-process-exclusive',
  'test-full-shared-output',
  'test-full-dogfood-reconcile',
]);
export const E2E_POLICY_MARKERS = Object.freeze([
  'real browser',
  'API-only',
  'diagnostic-only specs',
  'move down with replacement',
]);
export const TEST_RESOURCE_POLICY_MARKERS = Object.freeze([
  'resource-profiled',
  'process-heavy',
  'shared-output',
  'one Playwright worker',
]);
/**
 * Distinctive phrases that must appear in AGENTS.md so a red lane is treated
 * as a signal to investigate, not a request to rerun until green. Each phrase
 * is intentionally specific so it cannot match by accident.
 */
export const FAILURE_DIAGNOSIS_MARKERS = Object.freeze([
  'diagnose the failure rather than rerun-to-green',
  'signal to diagnose, not a request to rerun until green',
]);
/**
 * Distinctive phrases that must appear in AGENTS.md directing operators to
 * join or reuse an in-flight heavy lane instead of starting a redundant
 * same-digest run against the shared host-wide lease.
 */
export const LANE_REUSE_MARKERS = Object.freeze([
  'redundant same-digest run',
  'join or reuse the existing lease',
]);
/**
 * Submission is a detached handoff rather than completion evidence. These
 * phrases keep every contributor-facing guide aligned with that boundary and
 * prevent shell-managed relaunch loops from returning as advice.
 */
export const SUBMISSION_HANDOFF_GUIDANCE_DOCS = Object.freeze([
  'docs/guides/testing.md',
  'docs/guides/development.md',
]);
export const SUBMISSION_HANDOFF_GUIDANCE_MARKERS = Object.freeze([
  'freeze the worktree',
  '`npm run full:regression:submit`',
  'Never use shell',
  'background, or relaunch loops.',
  'Do not edit or remove a worktree',
  'live handoff;',
  '`node scripts/run-verification.mjs submit-status <request-key>`',
  'Synchronous\n`npm run full:regression` remains the sole evidence command and final consumer',
]);
/** The single document that carries the rendered lane catalog table. */
export const LANE_TABLE_DOC = 'docs/guides/testing.md';

/**
 * The scheduling guidance is rendered from the same lane catalog that drives
 * the coordinator. It deliberately lives outside the general prose policy so
 * documentation cannot retain a former phase weight or broaden ci:fast by
 * accident. Both contributor-facing documents must carry this exact section.
 */
export const VERIFICATION_SCHEDULING_SECTION_START =
  '<!-- station:verification-scheduling:start -->';
export const VERIFICATION_SCHEDULING_SECTION_END =
  '<!-- station:verification-scheduling:end -->';
export const VERIFICATION_SCHEDULING_DOCS = Object.freeze([
  'docs/guides/testing.md',
]);
export const E2E_LATEST_GUIDANCE_MARKERS = Object.freeze([
  'ignored latest E2E projection',
  '.kontourai/e2e-latest/index.html',
  '.kontourai/e2e-latest/manifest.json',
  'npm run sync:e2e:latest',
]);

export function renderVerificationSchedulingSection(lanes = LANES) {
  const ciFast = lanes.find((lane) => lane.id === 'ci-fast');
  const full = lanes.find((lane) => lane.id === 'full-regression');
  const ordinary = full?.phases?.find(
    (phase) => phase.id === 'test-full-ordinary',
  );
  return [
    VERIFICATION_SCHEDULING_SECTION_START,
    'This scheduling contract is rendered from `scripts/verification-lanes.mjs`; do not hand-maintain lane scope, phase weights, or commands here.',
    '',
    renderLaneCatalogTable(lanes),
    '',
    `\`ci:fast\` is diagnostic bounded feedback: it runs the base-pinned affected Vitest selection followed only by fixed runtime, lockfile, workflow, verification-policy, and **typecheck** invariants—not the global static/build chain or the full corpus. The typecheck invariant runs every \`typecheck:*\` lane through \`scripts/typecheck-aggregate.mjs\` (station#4273), preceded by \`build:connect\` because \`typecheck:ui\` resolves \`@kontourai/station-connect\` through its \`dist\`. It was added because the lane was previously uncovered per-PR: a red \`main\` displayed green on every contributor's checks, twice in 24 hours. Its ${ciFast?.weight ?? 'unknown'}-unit reservation overlaps the ${ordinary?.weight ?? 'unknown'}-unit \`${ordinary?.id ?? 'full-test'}\` phase so feedback can admit while completion work runs.`,
    '',
    '`full-regression` admits these cataloged phases independently; the outer receipt is completion evidence only after every phase succeeds:',
    renderFullRegressionPhaseSchedule(lanes),
    '',
    'Checkpoint resume is deliberately narrow: rerun the same unchanged `npm run full:regression` request and retain `.kontourai/verification-phase-records/<request-key>/`. The coordinator reuses only a parseable request-and-phase-bound checkpoint with a completed zero-exit pass, explicit non-truncated/non-invalid-UTF-8 output, and successful or not-required cleanup with zero surviving owned children. Failed, timed-out, truncated, invalid-UTF-8, malformed, mismatched, or cleanup-bad checkpoints rerun; a changed request never resumes them.',
    '',
    '`verification:policy:gate` remains a deterministic default readiness check, not required `repo-governance` evidence: it is already a bounded `ci:fast` invariant, while changing required-evidence routing is a separate human-governed `.veritas` decision. The existing repo-map contract test enforces that boundary.',
    VERIFICATION_SCHEDULING_SECTION_END,
  ].join('\n');
}
export const VERIFICATION_SCHEDULING_SECTION =
  renderVerificationSchedulingSection();

/**
 * Marker-bounded canonical policy section in AGENTS.md. Unlike the loose
 * `includes` marker checks above, the full block (start marker + body + end
 * marker) must appear byte-exactly and exactly once. This means deleting,
 * truncating, or reordering any meaningful sentence portion fails the gate even
 * when a marker fragment survives — the weakness of `includes`-only enforcement
 * is that a hand-edit can drop a clause while retaining enough of a marker
 * phrase to pass. The body enumerates every request/reuse identity field so the
 * invalidation summary stays truthful (it cannot silently drop a field).
 */
export const VERIFICATION_POLICY_SECTION_START =
  '<!-- station:verification-policy:start -->';
export const VERIFICATION_POLICY_SECTION_END =
  '<!-- station:verification-policy:end -->';
const VERIFICATION_POLICY_SECTION_LINES = [
  'The "Invalidated by" column names only the lane-specific `manifestDigest`',
  'content; every other field participates in reuse identity for every lane and',
  'invalidates its receipt when any one changes. The full identity',
  'set (defined in `scripts/lib/verification-receipt.mjs`): receipt',
  '`schemaVersion`; and the request projection — `repositoryId`, `worktree`,',
  '`headSha`, `workspaceDigest`, `environmentDigest`, `laneId`, `command`,',
  '`manifestDigest`, `dependencyDigest`, `nodeVersion`, `toolchain`, `platform`,',
  '`arch` (whose SHA-256 over their stable JSON is the derived request `key`).',
  'See `docs/reference/verification-receipts.md` for the field-by-field table.',
  '',
  '`ci:fast` is bounded diagnostic feedback, not completion evidence: it has a',
  'five-minute coordinator deadline, uses `STATION_CI_FAST_BASE` (default',
  '`origin/main`) in its request identity, runs the affected selection before a',
  'fixed bounded static invariant set. A selector exit 3 is reported as a',
  'diagnostic defer after those invariants, never completion evidence; the',
  'separately phase-attested `full-regression` gate remains required. Its',
  '20-unit scheduler reservation overlaps the 80-unit full test phase, so',
  'completion work yields admission headroom for fast feedback. Broad static',
  'verification and the full Vitest corpus must remain composed only by',
  '`full-regression`, never by `ci:fast`.',
  '',
  'When a lane fails, diagnose the failure rather than rerun-to-green: read the',
  'redacted output under `.kontourai/verification-output/<request-key>/`, isolate',
  'the failing test or gate, and fix the cause. A red lane is a',
  'signal to diagnose, not a request to rerun until green; a flaky failure is',
  'reproduced or triaged against an `origin/main` baseline and disclosed, never',
  'hidden by repetition.',
  '',
  'Heavy coordinated lanes share one host-wide weighted lease, so do not start a',
  'redundant same-digest run of a lane already in flight: inspect',
  '`node scripts/run-verification.mjs status` and join or reuse the existing lease',
  'instead. The coordinator returns exit 0 for an executed, joined, or reused',
  'lane, so reuse is the expected path, not a workaround.',
];
export const VERIFICATION_POLICY_SECTION = [
  VERIFICATION_POLICY_SECTION_START,
  ...VERIFICATION_POLICY_SECTION_LINES,
  VERIFICATION_POLICY_SECTION_END,
].join('\n');

function countOccurrences(text, substring) {
  if (substring.length === 0) return 0;
  let count = 0;
  let index = text.indexOf(substring);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(substring, index + substring.length);
  }
  return count;
}

/**
 * Asserts the canonical verification-policy section is present byte-exactly and
 * exactly once. Returns human-readable errors for drift, duplication, or stray
 * markers — any of which means a meaningful policy clause was edited without
 * updating the canonical source in this gate.
 */
export const VERIFICATION_POLICY_DOC = 'docs/guides/testing.md';
function verificationPolicySectionErrors(text, file = VERIFICATION_POLICY_DOC) {
  return exactSectionErrors({
    text,
    file,
    start: VERIFICATION_POLICY_SECTION_START,
    end: VERIFICATION_POLICY_SECTION_END,
    expected: VERIFICATION_POLICY_SECTION,
    label: 'verification-policy',
  });
}

function exactSectionErrors({ text, file, start, end, expected, label }) {
  const errors = [];
  const startMatches = countOccurrences(text, start);
  const endMatches = countOccurrences(text, end);
  if (startMatches !== 1)
    errors.push(
      `${file} must contain exactly one ${label} start marker (found ${startMatches})`,
    );
  if (endMatches !== 1)
    errors.push(
      `${file} must contain exactly one ${label} end marker (found ${endMatches})`,
    );
  const first = text.indexOf(expected);
  if (first === -1) {
    errors.push(
      `${file} ${label} section drifted from the canonical text in scripts/verification-policy-gate.mjs`,
    );
  } else if (text.indexOf(expected, first + 1) !== -1) {
    errors.push(
      `${file} must contain exactly one ${label} section (found a duplicate)`,
    );
  }
  return errors;
}
const STALE_TEST_GUIDANCE = Object.freeze([
  Object.freeze({
    pattern: /If you add a user-facing flow, it gets a .*Playwright/i,
    label: 'blanket Playwright requirement for every user-facing flow',
  }),
  Object.freeze({
    pattern: /New UI component\/hook\s*\|\s*Playwright e2e/i,
    label: 'blanket Playwright requirement for every UI component or hook',
  }),
  Object.freeze({
    pattern:
      /SSE streaming, WebSocket, AWS SDK calls, and UI flows are tested via Playwright/i,
    label: 'browser interception prescribed for server integration contracts',
  }),
  Object.freeze({
    pattern: /UI hook unit tests.*require vitest 2\.x/i,
    label: 'stale Vitest 2 hook limitation',
  }),
]);

const MAX_NPM_LINE_LENGTH = 4_096;
const MAX_NPM_TOKENS = 64;
const FLAGS_WITH_VALUES = new Set([
  '--workspace',
  '-w',
  '--prefix',
  '-C',
  '--userconfig',
  '--cache',
  '--loglevel',
]);

function normalizedTokens(line) {
  if (line.length > MAX_NPM_LINE_LENGTH) return [];
  return (line.match(/\S+/g) ?? [])
    .slice(0, MAX_NPM_TOKENS)
    .map((token) => token.replace(/^[`'"([{]+|[`'",.;)\]}]+$/g, ''));
}

function skipNpmFlags(tokens, start) {
  let index = start;
  while (index < tokens.length && tokens[index].startsWith('-')) {
    const flag = tokens[index];
    index += 1;
    if (FLAGS_WITH_VALUES.has(flag) && !flag.includes('=')) index += 1;
  }
  return index;
}

/**
 * Finds a script invoked by a common `npm [flags] run [flags] <script>` form.
 * This deliberately handles documentation, not a shell grammar: token and
 * line bounds make the policy check predictable while still covering the npm
 * flag positions contributors commonly use.
 */
function rawNpmScriptInvocation(text) {
  for (const line of text.split(/\r?\n/)) {
    const tokens = normalizedTokens(line);
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index] !== 'npm') continue;
      let cursor = skipNpmFlags(tokens, index + 1);
      if (tokens[cursor] !== 'run') continue;
      cursor = skipNpmFlags(tokens, cursor + 1);
      const script = tokens[cursor];
      if (script?.endsWith(':raw')) return script;
    }
  }
  return null;
}

export function verificationPolicyErrors({
  manifest = packageJson,
  docs = guidance,
  lanes = LANES,
  ciFastStaticCommands = FAST_STATIC_COMMANDS,
} = {}) {
  const errors = [];
  errors.push(...instructionGateErrors());
  for (const lane of lanes.filter((lane) => lane.id !== 'test-changed')) {
    const expected = `node scripts/run-verification.mjs request ${lane.id}`;
    if (manifest.scripts?.[lane.publicScript] !== expected)
      errors.push(
        `public heavy script ${lane.publicScript} must exactly equal ${expected}`,
      );
  }
  if (
    manifest.scripts?.['ci:fast'] !==
    'node scripts/run-verification.mjs request ci-fast'
  )
    errors.push(
      'ci:fast must remain the exact coordinated bounded-feedback command',
    );
  if (manifest.scripts?.['ci:fast:raw'] !== 'node scripts/run-ci-fast.mjs')
    errors.push('ci:fast:raw must use the bounded affected-test runner');
  if (
    JSON.stringify(ciFastStaticCommands) !==
    JSON.stringify(CI_FAST_STATIC_COMMANDS)
  )
    errors.push(
      'ci:fast must run only its fixed bounded static invariant allowlist',
    );
  const ciFast = lanes.find((lane) => lane.id === 'ci-fast');
  const fullTests =
    lanes.find((lane) => lane.id === 'full-regression')?.phases ?? [];
  const ordinaryFullTest = fullTests.find(
    (phase) => phase.id === 'test-full-ordinary',
  );
  if (ciFast?.weight !== CI_FAST_RESERVED_WEIGHT)
    errors.push(
      `ci:fast must reserve exactly ${CI_FAST_RESERVED_WEIGHT} coordinator weight`,
    );
  if (ciFast?.completion || ciFast?.diagnostic !== true)
    errors.push(
      'ci:fast selector deferrals must remain diagnostic and never completion evidence',
    );
  if (
    FULL_REGRESSION_TEST_PHASE_IDS.some(
      (id) => !fullTests.some((phase) => phase.id === id),
    )
  )
    errors.push(
      `full-regression must checkpoint all ${FULL_REGRESSION_TEST_PHASE_IDS.length} resource-profiled Vitest groups`,
    );
  if (ordinaryFullTest?.weight !== FULL_REGRESSION_TEST_WEIGHT)
    errors.push(
      `full-regression test-full-ordinary phase must use exactly ${FULL_REGRESSION_TEST_WEIGHT} coordinator weight`,
    );
  if (
    !Number.isInteger(ciFast?.weight) ||
    !Number.isInteger(ordinaryFullTest?.weight) ||
    ciFast.weight + ordinaryFullTest.weight > 100
  )
    errors.push(
      'ci:fast and full-regression test-full-ordinary must fit within the 100-unit host capacity',
    );
  if (manifest.scripts?.['verify:static:raw']?.includes('test:full:raw'))
    errors.push('verify:static:raw must not embed the full Vitest corpus');
  if (
    manifest.scripts?.['full:regression:raw'] !==
    'npm run proof:repo-governance && npm run proof:sdk-builds && npm run verify:static:raw && npm run test:full:raw && npm run proof:app-builds'
  )
    errors.push(
      'full:regression:raw must compose the complete static and full Vitest floor',
    );
  if (
    JSON.stringify(manifest['trust-reconcile-manifest']) !==
    JSON.stringify([
      { id: 'full-regression', command: 'npm run full:regression' },
    ])
  )
    errors.push(
      'trust-reconcile manifest must contain exact npm run full:regression',
    );
  for (const [script, reason] of Object.entries(DIRECT_OPT_IN)) {
    if (typeof manifest.scripts?.[script] !== 'string')
      errors.push(`direct opt-in script ${script} is missing`);
    if (typeof reason !== 'string' || reason.trim().length === 0)
      errors.push(`direct opt-in script ${script} needs a reason`);
  }
  for (const script of Object.keys(manifest.scripts ?? {})) {
    if (
      /^test:.*reliability$|^test:prepush:repeat$/.test(script) &&
      !(script in DIRECT_OPT_IN)
    )
      errors.push(
        `direct reliability script ${script} is not explicitly allowlisted`,
      );
  }
  for (const { file, text } of docs) {
    if (
      !/npm\s+run\s+test:changed\s+--\s+--base=origin\/main\s+--explain/.test(
        text,
      )
    )
      errors.push(`${file} is missing changed-scope guidance`);
    if (rawNpmScriptInvocation(text))
      errors.push(`${file} exposes a private raw verification command`);
    if (
      /Never skip these gates|Before pushing, run the full local CI pipeline|all gates before complete|all of it, per merge|everything else holds|mandatory all broad/i.test(
        text,
      )
    )
      errors.push(`${file} contains stale broad-gate guidance`);
    for (const stale of STALE_TEST_GUIDANCE) {
      if (stale.pattern.test(text))
        errors.push(`${file} contains stale test guidance: ${stale.label}`);
    }
  }
  for (const file of ['docs/guides/testing.md']) {
    const text = docs.find((entry) => entry.file === file)?.text;
    if (text === undefined) {
      errors.push(`${file} is required verification-policy guidance`);
      continue;
    }
    for (const marker of E2E_POLICY_MARKERS) {
      if (!text.includes(marker))
        errors.push(`${file} is missing E2E policy marker '${marker}'`);
    }
    for (const marker of TEST_RESOURCE_POLICY_MARKERS) {
      if (!text.includes(marker))
        errors.push(
          `${file} is missing test resource policy marker '${marker}'`,
        );
    }
  }
  for (const file of SUBMISSION_HANDOFF_GUIDANCE_DOCS) {
    const text = docs.find((entry) => entry.file === file)?.text;
    if (text === undefined) continue;
    for (const marker of SUBMISSION_HANDOFF_GUIDANCE_MARKERS) {
      if (!text.includes(marker))
        errors.push(`${file} is missing submission-handoff marker '${marker}'`);
    }
  }
  // The rendered lane table is the single human-readable view of the catalog.
  // It is generated from the catalog, so it can never carry a stale command or
  // class; the gate fails if the doc table drifts from the catalog in either
  // direction (catalog changed without re-render, or doc hand-edited).
  const laneTableDoc = docs.find((entry) => entry.file === LANE_TABLE_DOC);
  if (laneTableDoc === undefined) {
    errors.push(`${LANE_TABLE_DOC} is required to own the lane table`);
  } else {
    const rendered = renderLaneCatalogTable(lanes);
    if (!laneTableDoc.text.includes(rendered))
      errors.push(
        `${LANE_TABLE_DOC} lane table drifted from scripts/verification-lanes.mjs (regenerate via renderLaneCatalogTable)`,
      );
  }
  const schedulingSection = renderVerificationSchedulingSection(lanes);
  for (const file of VERIFICATION_SCHEDULING_DOCS) {
    const text = docs.find((entry) => entry.file === file)?.text;
    if (text === undefined) {
      errors.push(`${file} is required to own verification scheduling`);
      continue;
    }
    errors.push(
      ...exactSectionErrors({
        text,
        file,
        start: VERIFICATION_SCHEDULING_SECTION_START,
        end: VERIFICATION_SCHEDULING_SECTION_END,
        expected: schedulingSection,
        label: 'verification-scheduling',
      }),
    );
  }
  const policyText = docs.find(
    (entry) => entry.file === VERIFICATION_POLICY_DOC,
  )?.text;
  if (policyText === undefined) {
    errors.push(
      `${VERIFICATION_POLICY_DOC} is required to own verification policy`,
    );
  } else {
    for (const marker of FAILURE_DIAGNOSIS_MARKERS) {
      if (!policyText.includes(marker))
        errors.push(
          `${VERIFICATION_POLICY_DOC} is missing failure-diagnosis marker '${marker}'`,
        );
    }
    for (const marker of LANE_REUSE_MARKERS) {
      if (!policyText.includes(marker))
        errors.push(
          `${VERIFICATION_POLICY_DOC} is missing lane-reuse marker '${marker}'`,
        );
    }
    // The byte-exact canonical section check subsumes the loose `includes`
    // marker checks above: deleting a clause while retaining a marker fragment
    // now fails because the section body no longer matches byte-for-byte.
    errors.push(
      ...verificationPolicySectionErrors(policyText, VERIFICATION_POLICY_DOC),
    );
    for (const marker of E2E_LATEST_GUIDANCE_MARKERS) {
      if (!policyText.includes(marker))
        errors.push(
          `${VERIFICATION_POLICY_DOC} is missing latest-E2E guidance marker '${marker}'`,
        );
    }
  }
  return errors;
}

/**
 * Discover the tracked Vitest corpus independently from Vitest's own list
 * command and the resource-group builder. A group partition that is internally
 * consistent can still hide a deleted ordinary test; Git's tracked source set
 * is the separate oracle that makes that shrinkage visible.
 */
export function discoverTrackedVitestTestFiles({
  rootDir = root,
  execFile = execFileSync,
} = {}) {
  const output = execFile('git', ['ls-files', '-z'], {
    cwd: rootDir,
    encoding: 'utf8',
    windowsHide: true,
  });
  const files = String(output)
    .split('\0')
    .filter(Boolean)
    .filter(
      (file) =>
        VITEST_TEST_FILE_PATTERN.test(file) &&
        !file.startsWith('node_modules/') &&
        !file.startsWith('tests/') &&
        !file.includes('/node_modules/') &&
        !file.startsWith('vendor/') &&
        !file.startsWith('.claude/') &&
        !file.startsWith('.station/') &&
        !file.includes('station-worktrees/'),
    )
    .sort();
  if (files.length === 0) {
    throw new Error('tracked Vitest discovery returned no test files');
  }
  if (new Set(files).size !== files.length) {
    throw new Error('tracked Vitest discovery returned duplicate test paths');
  }
  return files;
}

export function vitestResourceCorpusErrors(groups, trackedFiles) {
  const errors = [];
  if (!Array.isArray(trackedFiles) || trackedFiles.length === 0) {
    return ['Vitest resource corpus discovery returned no test files'];
  }
  const tracked = new Set();
  for (const file of trackedFiles) {
    if (typeof file !== 'string' || !VITEST_TEST_FILE_PATTERN.test(file)) {
      errors.push(
        `Vitest resource corpus has invalid tracked test path: ${String(file)}`,
      );
      continue;
    }
    if (tracked.has(file)) {
      errors.push(
        `Vitest resource corpus has duplicate tracked test path: ${file}`,
      );
      continue;
    }
    tracked.add(file);
  }

  const assignments = new Map();
  for (const name of VITEST_RESOURCE_GROUP_NAMES) {
    const files = groups?.[name];
    if (!Array.isArray(files)) {
      errors.push(`Vitest resource group '${name}' is missing`);
      continue;
    }
    for (const file of files) {
      if (typeof file !== 'string' || !VITEST_TEST_FILE_PATTERN.test(file)) {
        errors.push(
          `Vitest resource group '${name}' has invalid test path: ${String(file)}`,
        );
        continue;
      }
      assignments.set(file, [...(assignments.get(file) ?? []), name]);
    }
  }

  for (const file of tracked) {
    const assigned = assignments.get(file) ?? [];
    if (assigned.length === 0) {
      errors.push(`Vitest resource groups miss tracked test file: ${file}`);
    } else if (assigned.length > 1) {
      errors.push(
        `Vitest resource groups assign tracked test file more than once: ${file} (${assigned.join(', ')})`,
      );
    }
  }
  for (const [file, assigned] of assignments) {
    if (!tracked.has(file)) {
      errors.push(
        `Vitest resource groups include non-tracked test file: ${file} (${assigned.join(', ')})`,
      );
    }
  }
  return errors;
}

/** Executable invariants. These, not guidance markers, carry enforcement. */
export function executableVerificationPolicyErrors({
  rootDir = root,
  discoverVitest = discoverVitestResourceGroups,
  discoverTrackedVitest = discoverTrackedVitestTestFiles,
  readFile = (filePath) => readFileSync(filePath, 'utf8'),
} = {}) {
  const errors = [];
  const e2e = validateE2EManifest({ rootDir, readFile });
  errors.push(...e2e.errors.map((error) => `E2E manifest: ${error}`));
  let groups;
  try {
    groups = discoverVitest({ root: rootDir });
  } catch (error) {
    errors.push(
      `Vitest resource groups: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let tracked;
  try {
    tracked = discoverTrackedVitest({ rootDir });
  } catch (error) {
    errors.push(
      `Tracked Vitest corpus discovery: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (groups !== undefined && tracked !== undefined) {
    errors.push(...vitestResourceCorpusErrors(groups, tracked));
  }
  return errors;
}

export function main() {
  const errors = [
    ...verificationPolicyErrors(),
    ...executableVerificationPolicyErrors(),
  ];
  if (errors.length) {
    process.stderr.write(`${errors.join('\n')}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href)
  main();
