import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  opendirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import receiptSchema from '../../schemas/verification-receipt.schema.json' with {
  type: 'json',
};
import { writeReceiptSecurely } from './test-reliability.mjs';
import {
  releaseVerificationArtifactMutation,
  tryAcquireVerificationArtifactMutation,
} from './verification-artifact-mutation.mjs';
import { assertReceiptSemantics } from './verification-receipt.mjs';
import { redactVerificationOutput } from './verification-redaction.mjs';

// Two streams consume at most 6MiB, leaving the independently bounded 2MiB
// attachment allowance inside MAX_ARTIFACT_TOTAL_BYTES.
export const DEFAULT_OUTPUT_BYTE_CAP = 3 * 1024 * 1024;
export const DEFAULT_SUMMARY_BYTE_CAP = 8 * 1024;
/**
 * Terminal statuses where the command was stopped rather than judged: the
 * deadline expired or a signal arrived, so no step failed and no test verdict
 * exists. `failed` and `infrastructure_error` are deliberately NOT here --
 * those reached a verdict and still attribute a failing step.
 */
export const STOPPED_TERMINAL_STATUSES = Object.freeze(
  new Set(['timed_out', 'canceled', 'cancelled']),
);
export const MAX_ATTACHMENT_BYTES = 512 * 1024;
export const MAX_ATTACHMENT_TOTAL_BYTES = 2 * 1024 * 1024;
export const MAX_REDACTED_ATTACHMENT_BYTES = 320 * 1024;
const REQUEST_KEY = /^[0-9a-f]{64}$/;
const ARTIFACT_REFERENCE =
  /^\.kontourai\/verification-output\/[0-9a-f]{64}\/(?:stdout|stderr|attachment)-([0-9a-f]{64})\.txt$/;
const MAX_ARTIFACTS = 64;
const MAX_ARTIFACT_TOTAL_BYTES = 8 * 1024 * 1024;
const RECEIPT_VALIDATOR = new Ajv2020({ strict: true }).compile(receiptSchema);
const GC_RECORD_DIRECTORIES = [
  '.kontourai/verification-output',
  '.kontourai/verification-phase-records',
];
const GC_RECEIPT_DIRECTORY = '.kontourai/verification-receipts';
export const VERIFICATION_ARTIFACT_RETENTION_POLICY = Object.freeze({
  orphanTtlMs: 24 * 60 * 60_000,
  scanLimit: 256,
  removalLimit: 32,
});
const GC_DEFAULT_MAX_AGE_MS =
  VERIFICATION_ARTIFACT_RETENTION_POLICY.orphanTtlMs;
const GC_DEFAULT_MAX_SCANNED = VERIFICATION_ARTIFACT_RETENTION_POLICY.scanLimit;
const GC_DEFAULT_MAX_REMOVALS =
  VERIFICATION_ARTIFACT_RETENTION_POLICY.removalLimit;

function digest(contents) {
  return createHash('sha256').update(contents).digest('hex');
}
function artifactPath(requestKey, kind, contents) {
  if (!REQUEST_KEY.test(requestKey))
    throw new Error('requestKey must be a lowercase sha256 digest');
  if (!['stdout', 'stderr', 'attachment'].includes(kind))
    throw new Error('unsafe artifact kind');
  return `.kontourai/verification-output/${requestKey}/${kind}-${digest(contents)}.txt`;
}

/** Validates a persisted artifact before reuse or cross-worktree projection. */
export function readVerifiedVerificationArtifact({
  root,
  artifact,
  openFile = openSync,
  statFile = fstatSync,
  readFile = readFileSync,
} = {}) {
  const reference =
    typeof artifact?.path === 'string'
      ? ARTIFACT_REFERENCE.exec(artifact.path)
      : null;
  if (
    !root ||
    !reference ||
    !/^[0-9a-f]{64}$/.test(artifact.sha256 ?? '') ||
    reference[1] !== artifact.sha256
  )
    throw new Error('invalid verification artifact reference');
  const workspaceRoot = resolve(root);
  const target = resolve(workspaceRoot, artifact.path);
  if (!isLexicalDescendant(workspaceRoot, target))
    throw new Error('artifact escapes workspace root');
  assertNoSymlinkAncestry(workspaceRoot, target);
  const descriptor = openFile(
    target,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = statFile(descriptor);
    if (!opened.isFile()) throw new Error('artifact is not a regular file');
    if (process.platform !== 'win32' && (opened.mode & 0o777) !== 0o600)
      throw new Error('artifact is not private');
    if (opened.size > MAX_ARTIFACT_TOTAL_BYTES)
      throw new Error('artifact exceeds byte cap');
    const contents = readFile(descriptor);
    const final = statFile(descriptor);
    if (!sameIdentity(opened, final) || contents.length !== opened.size)
      throw new Error('artifact changed while reading');
    if (digest(contents) !== artifact.sha256)
      throw new Error('artifact digest does not match');
    return contents;
  } finally {
    closeSync(descriptor);
  }
}

export function verifyVerificationArtifacts({ root, artifacts } = {}) {
  if (!Array.isArray(artifacts) || artifacts.length > MAX_ARTIFACTS)
    throw new Error('artifact count exceeds bound');
  let total = 0;
  for (const artifact of artifacts) {
    const contents = readVerifiedVerificationArtifact({ root, artifact });
    total += contents.length;
    if (total > MAX_ARTIFACT_TOTAL_BYTES)
      throw new Error('artifact total exceeds byte cap');
  }
  return true;
}

/** Copies verified bytes under a joiner's own request key, never by reference. */
export function projectVerificationArtifacts({
  sourceRoot,
  targetRoot,
  artifacts,
  requestKey,
} = {}) {
  if (!REQUEST_KEY.test(requestKey ?? ''))
    throw new Error('requestKey must be a lowercase sha256 digest');
  if (!Array.isArray(artifacts) || artifacts.length > MAX_ARTIFACTS)
    throw new Error('artifact count exceeds bound');
  let total = 0;
  return artifacts.map((artifact) => {
    const contents = readVerifiedVerificationArtifact({
      root: sourceRoot,
      artifact,
    });
    total += contents.length;
    if (total > MAX_ARTIFACT_TOTAL_BYTES)
      throw new Error('artifact total exceeds byte cap');
    const path = `.kontourai/verification-output/${requestKey}/${basename(artifact.path)}`;
    writeReceiptSecurely(path, contents, targetRoot);
    return { path, sha256: digest(contents) };
  });
}
function assertNoSymlinkAncestry(root, target) {
  const suffix = relative(root, target);
  if (!isContainedPathSuffix(suffix, { isAbsolute, sep }))
    throw new Error('path escapes root');
  let current = root;
  if (lstatSync(current).isSymbolicLink())
    throw new Error('root is a symbolic link');
  for (const part of suffix.split(sep).filter(Boolean)) {
    current = resolve(current, part);
    if (lstatSync(current).isSymbolicLink())
      throw new Error('path contains a symbolic link');
  }
}

export function isContainedPathSuffix(suffix, pathShape = { isAbsolute, sep }) {
  return (
    suffix !== '..' &&
    !suffix.startsWith(`..${pathShape.sep}`) &&
    !pathShape.isAbsolute(suffix)
  );
}

function isLexicalDescendant(root, target) {
  const suffix = relative(root, target);
  return isContainedPathSuffix(suffix, { isAbsolute, sep });
}

function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function fitsSummary(summary, maxBytes) {
  return Buffer.byteLength(JSON.stringify(summary)) <= maxBytes;
}

function longestTextThatFits(buildCandidate, text, maxBytes) {
  const points = Array.from(text);
  let lower = 1;
  let upper = points.length;
  let result = '';
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const prefix = points.slice(0, middle).join('');
    if (fitsSummary(buildCandidate(prefix), maxBytes)) {
      result = prefix;
      lower = middle + 1;
    } else upper = middle - 1;
  }
  return result;
}

/**
 * Longest codepoint-aligned UTF-8 prefix of `text` whose byte length is within
 * `maxBytes`. Splitting only on complete code points keeps the retained prefix
 * valid UTF-8 (no partial surrogate/sequence) so a cap boundary never turns a
 * real prefix into a replacement character or a parser failure.
 */
function longestUtf8Prefix(text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const points = Array.from(text);
  let lower = 0;
  let upper = points.length;
  let result = '';
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const prefix = points.slice(0, middle).join('');
    if (Buffer.byteLength(prefix) <= maxBytes) {
      result = prefix;
      lower = middle + 1;
    } else upper = middle - 1;
  }
  return result;
}

function semanticCandidate(summary, semantic, value) {
  return semantic.key === 'slowItems'
    ? { ...summary, slowItems: [value] }
    : { ...summary, [semantic.key]: value };
}

function assignSemantic(summary, semantic, value) {
  if (semantic.key === 'slowItems') summary.slowItems = [value];
  else summary[semantic.key] = value;
}

function reserveSemantic(summary, semantic, maxBytes) {
  const firstPoint = Array.from(semantic.value)[0];
  if (!firstPoint) return false;
  const candidate = semanticCandidate(summary, semantic, firstPoint);
  if (!fitsSummary(candidate, maxBytes)) return false;
  assignSemantic(summary, semantic, firstPoint);
  return true;
}

function promoteSemantic(summary, semantic, maxBytes) {
  const full = semanticCandidate(summary, semantic, semantic.value);
  if (fitsSummary(full, maxBytes)) {
    assignSemantic(summary, semantic, semantic.value);
    return true;
  }
  // Search complete code points against the complete JSON candidate
  // (including mandatory fields and lower-priority reservations) so a small
  // residual budget keeps the longest truthful prefix without splitting UTF-8.
  const prefix = longestTextThatFits(
    (candidate) => semanticCandidate(summary, semantic, candidate),
    semantic.value,
    maxBytes,
  );
  if (!prefix) return false;
  assignSemantic(summary, semantic, prefix);
  return true;
}

function slowDuration(line) {
  const matches = [...line.matchAll(/(\d+(?:\.\d+)?)s\b/gi)];
  return Math.max(0, ...matches.map((match) => Number(match[1])));
}

// A chained `npm run a && npm run b && ...` command -- exactly how Station's
// own gate chains are composed (`verify:static:raw`, `typecheck`, ...) -- has
// npm print an unambiguous boundary before each nested script:
// `> <pkg>@<version> <script>`. Because `&&` short-circuits, the LAST such
// boundary in a capture names the step that was still running when the
// process exited: every step before it had to finish, and since the chain
// kept going, it had to succeed. Scoping the causal scan to that final
// boundary (never the whole capture) is what stops an earlier, PASSING
// step's diagnostic-shaped output -- a Biome warning line, say -- from
// outranking the real failure a later step emits (station#3189, and the same
// defect reported earlier as station#1871).
const NPM_RUN_STEP_HEADER = /^> \S+@\S+\s+([\w][\w:.,-]*)$/;

function lastNpmRunStepBoundary(lines) {
  let boundary = null;
  for (let index = 0; index < lines.length; index += 1) {
    const match = NPM_RUN_STEP_HEADER.exec(lines[index]);
    if (match) boundary = { index, step: match[1] };
  }
  return boundary;
}

/**
 * Matches an actual failure diagnostic, not an arbitrary test title that
 * happens to describe a "failed save" or another failure-path scenario.
 */
/**
 * Biome prints a diagnostic's severity on the marker line that FOLLOWS its
 * `file:line:col category ━━━` header (`×` error, `!` warning, `i` info), so a
 * header alone cannot be ranked.
 *
 * The `[A-Z]{3,}` group is not decoration. Biome inserts an uppercase tag
 * between the category and the rule for auto-fixable diagnostics --
 * `lint/suspicious/noDoubleEquals  FIXABLE  ━━━` -- and without it the pattern
 * matched no fixable diagnostic at all, which is most lint ERRORS. The effect
 * was that errors were invisible to the matcher and a warning above them still
 * won: station#1871's exact symptom, produced by its own fix. Verified against
 * Biome 2.5.8 on this repo's config, not inferred. The flag is deliberately NOT
 * `i`: the tag is upper-case in Biome's output, and a case-insensitive class
 * would swallow an ordinary lower-case word. Blank lines are already filtered out of
 * `lines`, so the marker is the next entry when one exists. Shapes that carry
 * severity inline (`file:l:c error TS…`, `file:l:c warning`) are read directly.
 * Anything unrecognised is deliberately `unknown` rather than assumed benign:
 * only a diagnostic PROVEN to be a warning is ever deprioritised.
 */
function diagnosticSeverity(lines, index) {
  const line = lines[index];
  if (/^.+:\d+:\d+\s+warning\b/i.test(line)) return 'warning';
  if (/^.+:\d+:\d+\s+error\b/i.test(line)) return 'error';
  if (/^.+\(\d+,\d+\):\s+error\s+TS\d+:/i.test(line)) return 'error';
  if (
    /^.+:\d+:\d+\s+[a-z][\w-]*(?:\/[\w-]+)+(?:\s+[A-Z]{3,})*\s+━/.test(line)
  ) {
    const marker = lines[index + 1];
    if (!marker) return 'unknown';
    if (/^\s*[×✖]\s/u.test(marker)) return 'error';
    if (/^\s*[!⚠]\s/u.test(marker)) return 'warning';
    return 'unknown';
  }
  return 'unknown';
}

/**
 * Returns the most actionable diagnostic, not merely the first one. An error
 * anywhere in scope outranks a warning that happens to appear above it —
 * station#1871, where a `suppressions/unused` warning on line 41 was reported
 * as the cause of a failure a genuine error further down had produced. Falls
 * back to first-match so a capture containing only warnings still reports one.
 *
 * `allowWarningFallback: false` withdraws exactly that fallback, and nothing
 * else. A PASSING run has no cause -- yet a repo whose lint gate tolerates
 * warnings emits warning-shaped diagnostics on every green run, so the
 * fallback that rescues a failed warnings-only capture also stamped a
 * `firstCausalExcerpt` onto passes (station#1459: a green hosted run reported
 * `scripts/literal-swap-gate.mjs:58:11 lint/suspicious/noAssignInExpressions`
 * as its cause). The caller withdraws it only for a run that passed, so the
 * failed-run behaviour every other test pins is byte-identical.
 */
function findCausalDiagnostic(
  lines,
  { preferLast = false, allowWarningFallback = true } = {},
) {
  // `preferLast` is for STDERR, which carries no step markers. The chain
  // short-circuits, so the failing step's output is the tail; scanning from
  // the end is what keeps an earlier PASSING step's diagnostic-shaped noise
  // from being reported as the cause. Stdout is scoped by an npm header
  // instead and keeps first-match, which is the more actionable choice
  // within a single step (station#1871).
  const order = preferLast ? [...lines.keys()].reverse() : [...lines.keys()];
  let fallback;
  for (const i of order) {
    if (!isCausalDiagnostic(lines[i])) continue;
    if (fallback === undefined) fallback = lines[i];
    if (diagnosticSeverity(lines, i) !== 'warning') return lines[i];
  }
  return allowWarningFallback ? fallback : undefined;
}

const FAIL_LINE = /^\s*(?:❯\s*)?FAIL\s+\S+/;

/**
 * ANSI SGR/CSI sequences, which sit BEFORE the first visible character of a
 * coloured line and therefore defeat every `^`-anchored matcher here.
 *
 * station#1471: vitest colours its failure banner
 * (`ESC[41m ESC[1m FAIL ESC[22m ESC[49m <file> > <test>`) whenever it
 * writes to a terminal, and GitHub Actions is one. A hosted nightly's failing
 * shard therefore produced a perfectly well-formed `FAIL` line that
 * `FAIL_LINE` could not see, so the run reported an ambient log line from a
 * PASSING test as its cause and the annotation rail said no causal excerpt
 * existed at all. The bytes are kept as captured -- the excerpt stays
 * byte-faithful to the artifact beside it -- and only the MATCH is taken
 * against the stripped text.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the terminal escape byte is exactly the job.
const ANSI_SEQUENCE = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;

function withoutAnsi(line) {
  return String(line).replace(ANSI_SEQUENCE, '');
}

function isFailLine(line) {
  return FAIL_LINE.test(withoutAnsi(line));
}

/**
 * Every line in `lines` that names a failing check (a vitest `FAIL <file>`
 * line, or -- station#4249 -- the same-shaped `FAIL <lane>` marker the
 * completion-mode typecheck/docs aggregate runners print per failing
 * sub-lane), in document order, deduplicated by exact text. The plural
 * counterpart of `failLineIn`'s single `.find`: it exists so a run that
 * genuinely observed N distinct failing checks can report N excerpts instead
 * of only the first one found.
 */
function allFailLines(lines) {
  const seen = new Set();
  const matches = [];
  for (const line of lines) {
    if (!isFailLine(line) || seen.has(line)) continue;
    seen.add(line);
    matches.push(line);
  }
  return matches;
}

/** A vitest/playwright test file, never a `FAIL <lane>` aggregate marker. */
const FAIL_LINE_TEST_FILE =
  /^\s*(?:❯\s*)?FAIL\s+(\S*\/\S*\.(?:test|spec)\.[cm]?[jt]sx?)\b/;

/**
 * The test FILES named by the `FAIL <file> > <test>` lines in a captured
 * stream, in document order, deduplicated.
 *
 * Exported because `run-verification.mjs` needs the same extraction against
 * the persisted stdout/stderr artifacts: a completion-phase parent's receipt
 * carries phase records, not the per-execution diagnostics attachment that
 * `failedCheckTestFiles` is otherwise derived from, so without this the one
 * field that says WHERE to look was empty on exactly the runs that most
 * needed it (station#1471).
 *
 * Deliberately no per-file count: a capture is a bounded prefix and a
 * persisted stream can be a tail, so a count derived from it would be a
 * number nothing guarantees. The names are what end the investigation.
 */
export function failedTestFilesFromCapture(text) {
  const seen = new Set();
  const files = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = FAIL_LINE_TEST_FILE.exec(withoutAnsi(line));
    if (!match || seen.has(match[1])) continue;
    seen.add(match[1]);
    files.push(match[1]);
  }
  return files;
}

/**
 * The plural counterpart of `findCausalDiagnostic`: every diagnostic sharing
 * the SAME winning tier `findCausalDiagnostic` would have picked from
 * (non-warning severity outranks warning, exactly as the singular function
 * ranks them), in document order, with the singular winner moved to index 0
 * so a caller building `causalExcerpts` from this list gets the same head
 * element `firstCausalExcerpt` would report. Delegates the winner selection
 * itself to `findCausalDiagnostic` rather than reimplementing it, so the two
 * can never disagree about which excerpt is "first".
 */
function findAllCausalDiagnostics(
  lines,
  { preferLast = false, allowWarningFallback = true } = {},
) {
  const winner = findCausalDiagnostic(lines, {
    preferLast,
    allowWarningFallback,
  });
  // Withdrawing the warning fallback above is enough for this function too:
  // with no winner there is no tier, and when a winner exists under
  // `allowWarningFallback: false` it is non-warning by construction, so
  // `hasNonWarning` is true and the tier below excludes warnings anyway.
  if (winner === undefined) return [];
  const hasNonWarning = lines.some(
    (line, index) =>
      isCausalDiagnostic(line) &&
      diagnosticSeverity(lines, index) !== 'warning',
  );
  const tier = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!isCausalDiagnostic(lines[index])) continue;
    const severity = diagnosticSeverity(lines, index);
    const inTier = hasNonWarning
      ? severity !== 'warning'
      : severity === 'warning';
    if (inTier) tier.push(lines[index]);
  }
  const seen = new Set();
  const ordered = [];
  for (const line of [winner, ...tier]) {
    if (seen.has(line)) continue;
    seen.add(line);
    ordered.push(line);
  }
  return ordered;
}

/**
 * The plural counterpart of `firstCausalExcerpt`'s own resolution chain in
 * `summarizeVerificationOutput`: mirrors the SAME priority order (attributable
 * scoped-stdout evidence before unattributable stderr evidence, a FAIL line
 * before a generic diagnostic) and, at whichever tier wins, returns every
 * excerpt that tier observed rather than only the first. Because each branch
 * here calls the exact singular helper the caller also calls, branch
 * selection can never diverge from `firstCausalExcerpt`'s own -- the two are
 * derived from the same evidence, so `causalExcerpts[0]` and
 * `firstCausalExcerpt` describe the same excerpt whenever both exist.
 *
 * Deliberately returns only what this one execution's captured output
 * actually contains. It cannot see -- and does not guess at -- a check that
 * never ran because an earlier tier short-circuited; that check is absent
 * from this list, not falsely reported as passing or failing.
 */
function allCausalExcerpts({
  scopedStdout,
  stderrLines,
  failureSection,
  terminal,
  lines,
  allowWarningFallback = true,
}) {
  const scopedFailLines = allFailLines(scopedStdout);
  if (scopedFailLines.length) return scopedFailLines;
  // Mirrors the singular chain's station#1471 ordering: a runner's own FAIL
  // lines, on whichever stream carried them, before any generic diagnostic.
  const stderrFailLines = allFailLines(stderrLines);
  if (stderrFailLines.length) return stderrFailLines;
  if (failureSection >= 0) {
    const scoped = findAllCausalDiagnostics(
      scopedStdout.slice(failureSection + 1),
      { allowWarningFallback },
    );
    if (scoped.length) return scoped;
  }
  const unscoped = findAllCausalDiagnostics(scopedStdout, {
    allowWarningFallback,
  });
  if (unscoped.length) return unscoped;
  const stderrDiagnostics = findAllCausalDiagnostics(stderrLines, {
    preferLast: true,
    allowWarningFallback,
  });
  if (stderrDiagnostics.length) return stderrDiagnostics;
  if (lines.length === 1 && /parser/i.test(terminal.status)) return [lines[0]];
  return [];
}

function isCausalDiagnostic(line) {
  return (
    /\b(?:AssertionError|TypeError|ReferenceError|SyntaxError|RangeError|TimeoutError)\b/.test(
      line,
    ) ||
    /^\s*Error:\s/.test(line) ||
    /^.+\(\d+,\d+\):\s+error\s+TS\d+:/i.test(line) ||
    /^.+:\d+:\d+\s+(?:error|warning)\b/i.test(line) ||
    /^.+:\d+:\d+\s+[a-z][\w-]*(?:\/[\w-]+)+(?:\s+[A-Z]{3,})*\s+━/.test(line) ||
    // Biome's FORMAT diagnostics carry no line:col at all -- the header is
    // `<path> format ━━━`. This gate found that out the hard way: a format
    // error in this very file was invisible to the matcher, so the run
    // reported a `noUselessFragments` WARNING from an untouched file as the
    // cause. Same defect as the FIXABLE blind spot, a different header shape.
    /^\S+\s+format\s+━/.test(line) ||
    /^\s*(?:FAIL\b|Process\b.*\bSIGTERM\b|cleanup failed\b|No test files\b)/i.test(
      line,
    ) ||
    /^\s*\d+\)\s+\[[^\]]+\]\s+›\s+\S+\.spec\.[jt]s\b/.test(line)
  );
}

/**
 * Retains an exact codepoint-safe bounded prefix of the joined chunks and
 * records explicit per-stream truncation metadata. The prefix is never replaced
 * by an omission marker: a bounded capture keeps its real bytes (and therefore
 * its real digest) so a reader can always see what was retained and that it was
 * not the whole stream.
 */
export function captureBoundedOutput(
  chunks,
  { maxBytes = DEFAULT_OUTPUT_BYTE_CAP } = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new Error('maxBytes must be a positive safe integer');
  const text = chunks.map((chunk) => String(chunk)).join('');
  const sourceBytes = Buffer.byteLength(text);
  const truncated = sourceBytes > maxBytes;
  const retained = truncated ? longestUtf8Prefix(text, maxBytes) : text;
  const persistedBytes = Buffer.byteLength(retained);
  return {
    text: retained,
    sourceBytes,
    capturedBytes: persistedBytes,
    persistedBytes,
    truncated,
    omitted: false,
  };
}

/**
 * @param {{
 *   stdout?: string,
 *   stderr?: string,
 *   terminal: { status: string, exitCode?: number | null, truncated?: boolean },
 *   counts: Record<string, number>,
 *   cleanup: { status: string, survivingOwnedChildren?: number },
 *   maxBytes?: number,
 * }} options
 *   `terminal`, `counts` and `cleanup` are required at runtime (the function
 *   throws without each of them). This annotation exists for the same reason
 *   `persistVerificationOutput`'s does: tsconfig.scripts.json runs with
 *   checkJs:false, where tsc otherwise infers the parameter type from
 *   initialized properties only, so a .ts importer sees a shape missing every
 *   required field (TS2353 on every correct call site).
 */
export function summarizeVerificationOutput({
  stdout = '',
  stderr = '',
  terminal,
  counts,
  cleanup,
  maxBytes = DEFAULT_SUMMARY_BYTE_CAP,
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 64)
    throw new Error('summary maxBytes is too small');
  if (!terminal || typeof terminal.status !== 'string')
    throw new Error('summary requires measured terminal status');
  if (!counts || typeof counts !== 'object' || Array.isArray(counts))
    throw new Error('summary requires measured counts');
  if (!cleanup || typeof cleanup !== 'object' || Array.isArray(cleanup))
    throw new Error('summary requires measured cleanup');
  // The two streams are kept APART, and that is the whole fix for
  // station#1871's remaining half. npm writes its `> pkg@ver script` headers
  // to STDOUT only -- verified directly against npm 11.17, running a real
  // `a && b` chain and capturing the streams to separate files -- while the
  // tools that produce diagnostics (biome, tsc) write to STDERR. Concatenating
  // them and scoping the result by an npm header therefore scoped nothing:
  // every step's stderr, passing or not, stayed eligible, so an ambient
  // TypeError logged by a PASSING test could be reported as the cause of a
  // failure in a later step while `failingStep` correctly named that later
  // step. Two fields contradicting each other, with nothing to reconcile them.
  const stdoutLines = redactVerificationOutput(String(stdout))
    .split(/\r?\n/)
    .filter(Boolean);
  const stderrLines = redactVerificationOutput(String(stderr))
    .split(/\r?\n/)
    .filter(Boolean);
  const lines = [...stdoutLines, ...stderrLines];
  const stepBoundary = lastNpmRunStepBoundary(stdoutLines);
  // STDOUT can be attributed: everything after the last header was produced by
  // the step that was still running at exit.
  const scopedStdout = stepBoundary
    ? stdoutLines.slice(stepBoundary.index)
    : stdoutLines;
  // STDERR cannot be attributed the same way -- it carries no step markers at
  // all. What IS structurally true is the ORDER: the chain short-circuits on
  // `&&`, so the failing step's stderr is the TAIL. Among equally-ranked
  // candidates the last one is therefore the one most likely to belong to the
  // step that failed, which is why stderr is searched from the end.
  const failureSection = scopedStdout.findLastIndex((line) =>
    /(?:Failed Tests|Test Failures|Failures\s+\d+)/i.test(line),
  );
  // A vitest FAIL line names the failing FILE — always the most actionable
  // excerpt when present. Ambient stderr (app logs) previously matched the
  // generic diagnostic pattern first and masked the real failure
  // (station#2591).
  const failLineIn = (candidates) => candidates.find(isFailLine);
  // Hoisted above the causal scan (it also gates `failingStep` further down,
  // where it was originally computed) because a PASSING run must not report a
  // cause at all. It is one conjunct of `observedClean` below; `failingStep`
  // reads it alone. The two fields can therefore disagree, by design, in
  // exactly the under-approximated cases: a run that `completed` with exit 0
  // but failed cleanup or counts names no failing step yet still reports its
  // causal excerpt.
  const exitedNonZero =
    typeof terminal.exitCode === 'number' && terminal.exitCode !== 0;
  // station#1459: the fallback that rescues a FAILED warnings-only capture is
  // withdrawn on a pass, and only there. Station's lint gate tolerates
  // warnings, so a green hosted run emits warning-shaped diagnostics every
  // time; the fallback turned one of them into `firstCausalExcerpt` on runs
  // that had no cause to report. An ERROR-tier diagnostic is still reported
  // if one is somehow present on a pass -- that is a genuine contradiction
  // worth surfacing, not noise to suppress.
  //
  // What follows is NOT the receipt's verdict and must not be read as one.
  // `classifyTerminal` (verification-receipt.mjs) additionally requires stable
  // provenance and the full counts identity (`executed > 0`, `passed ===
  // executed`), neither of which this function is given. It is deliberately a
  // conservative UNDER-approximation of that pass predicate: every input it
  // can see must be clean before the fallback is withdrawn, so anything it
  // cannot see can only leave the fallback in place. A run this thinks is
  // clean but the receipt fails therefore still reports its warning; a run
  // with a failed count, a failed cleanup, or a surviving owned child keeps
  // its cause even though the status says `completed`.
  const cleanupStatus =
    typeof cleanup.status === 'string' ? cleanup.status : null;
  const observedClean =
    terminal.status === 'completed' &&
    !exitedNonZero &&
    counts.failed === 0 &&
    counts.infrastructureErrors === 0 &&
    (cleanupStatus === 'passed' || cleanupStatus === 'not_required') &&
    (cleanup.survivingOwnedChildren ?? 0) === 0;
  const allowWarningFallback = !observedClean;
  // Attributable evidence outranks unattributable evidence. A candidate from
  // the scoped stdout provably came from the failing step; a stderr candidate
  // only probably did.
  //
  // station#1471 moves the STDERR fail-line probe up here, directly behind
  // stdout's, ahead of every generic diagnostic. A `FAIL <file> > <test>`
  // line is not unattributable evidence that merely correlates with the
  // failure: it IS the failure, named by the runner that observed it. Leaving
  // it below `findCausalDiagnostic(scopedStdout)` meant a hosted shard whose
  // FAIL block goes to stderr (vitest writes its failure banner there)
  // reported an ambient `SyntaxError` log line emitted by a PASSING test in
  // the same shard as the cause. Attributability still orders everything
  // else; it does not outrank a runner's own verdict.
  const causalCandidate =
    failLineIn(scopedStdout) ??
    failLineIn(stderrLines) ??
    (failureSection >= 0
      ? findCausalDiagnostic(scopedStdout.slice(failureSection + 1), {
          allowWarningFallback,
        })
      : null) ??
    findCausalDiagnostic(scopedStdout, { allowWarningFallback }) ??
    findCausalDiagnostic(stderrLines, {
      preferLast: true,
      allowWarningFallback,
    }) ??
    (lines.length === 1 && /parser/i.test(terminal.status) ? lines[0] : null);
  // station#1471: the EXCERPT is rendered for a reader, so the terminal colour
  // bytes come off here — after selection (which needs the captured line) and
  // after `causeStream` below (which identifies the source stream by looking
  // the captured line up in `scopedStdout`). Leaving them in spent summary
  // budget on escape sequences and put an unprintable prefix in front of the
  // file name in the one field that says what broke. The artifact beside it
  // still holds the bytes exactly as captured.
  const normalizeExcerpt = (value) =>
    typeof value === 'string' ? withoutAnsi(value) : value;
  const firstCausalExcerpt = normalizeExcerpt(causalCandidate);
  // station#4249: the plural companion, derived from the SAME branch that won
  // above (see `allCausalExcerpts`'s doc comment for why the two can never
  // disagree about their head element). Computed unconditionally -- it is
  // cheap pure text scanning -- but only ever rendered into the summary when
  // `firstCausalExcerpt` itself made the byte budget (below), so its presence
  // never outruns the field it extends.
  const causalExcerptsObserved = [
    ...new Set(
      allCausalExcerpts({
        scopedStdout,
        stderrLines,
        failureSection,
        terminal,
        lines,
        allowWarningFallback,
      }).map(normalizeExcerpt),
    ),
  ];
  // Emitted ONLY when the excerpt came from stderr, which is the case a reader
  // needs warning about: stderr carries no step markers, so that excerpt was
  // chosen by severity and position rather than attributed to the failing
  // step. Absence therefore means the stronger thing -- the excerpt was scoped
  // to the step that failed.
  //
  // Only-when-interesting is deliberate, and the same discipline `failingStep`
  // follows. It also keeps the field out of the byte budget on a tight cap,
  // where carrying it cost the run its `finalTally`: a caveat that displaces
  // measured truth is a bad trade.
  const causeStream =
    causalCandidate && !scopedStdout.includes(causalCandidate)
      ? 'stderr'
      : null;
  // What this computes, stated as narrowly as it is true: the last npm step
  // header present in the capture is the step that was still RUNNING when the
  // process exited. For a chain of `&&` (every script in this repo is one --
  // checked for `;`, `||`, background `&`, concurrently and --if-present) a
  // non-zero exit means that step is also the one that failed. Under
  // `canceled` or `timed_out` nothing failed at all; the field still names the
  // step that was in flight, which is the useful thing to know, but a reader
  // must not read it as blame.
  //
  // Two cases where it would be a false claim, both suppressed rather than
  // qualified (review of station#1871):
  //
  //  - TRUNCATED captures. On overflow the retained text is the first 3 MiB
  //    PREFIX and the child keeps running, so the last header in that prefix
  //    belongs to a step that completed fine -- it is simply where the tape
  //    ran out. Naming it would accuse a passing step.
  //  - A terminal status of `completed` carrying a non-zero exit code. That
  //    is a real non-pass, and testing `status !== 'completed'` alone would
  //    stay silent on exactly the run a reader needs the field for.
  //
  // `exitedNonZero` is computed once, above the causal scan, where
  // station#1459 folds it into the strictly stronger `observedClean`; this is
  // its second reader, not a second definition.
  // The step is reported under a name that matches what the status actually
  // claims. Under `timed_out` or `canceled` nothing failed -- the note above
  // says as much, and asked the reader not to read `failingStep` as blame.
  // A field named `failingStep` cannot carry that instruction: the name IS the
  // claim, and readers acted on it. It is now `inFlightStep` for those
  // statuses, which says the true and still-useful thing (this is the step
  // that was running when the clock ran out) without accusing it.
  //
  // The carve-out is exactly the two statuses that mean the run was STOPPED.
  // `failed` and `infrastructure_error` are non-passing terminal states that
  // did reach a verdict, so they keep naming a failing step as before; only a
  // clock or a signal produces a step that was merely in flight.
  const attributableStep =
    stepBoundary && !terminal.truncated ? stepBoundary.step : null;
  const stopped = STOPPED_TERMINAL_STATUSES.has(terminal.status);
  const failingStep =
    attributableStep &&
    !stopped &&
    (terminal.status !== 'completed' || exitedNonZero)
      ? attributableStep
      : null;
  const inFlightStep = attributableStep && stopped ? attributableStep : null;
  // "Final" is scoped the same way as the cause, and to the same stream: a
  // tally is something a runner PRINTS, so it belongs to stdout, and taking it
  // from the failing step's own region keeps an earlier step's tally-shaped
  // line out (the same station#3189 leak in a different field). slowItems
  // stays unscoped below — it is a cross-run performance diagnostic, not a
  // causality claim, and an early step's slow test is still worth surfacing on
  // an otherwise-passing run.
  const finalTally =
    [...scopedStdout]
      .reverse()
      .find((line) => /tests?|passed|failed|error/i.test(line)) ?? null;
  const slowItems = lines
    .filter((line) => /slow|\b\d+(?:\.\d+)?s\b/i.test(line))
    .map((line, index) => ({ line, index, seconds: slowDuration(line) }))
    .sort(
      (left, right) => right.seconds - left.seconds || left.index - right.index,
    )
    .map(({ line }) => line);
  const summary = {
    terminal: terminal.status,
    counts,
    cleanup,
  };
  if (!fitsSummary(summary, maxBytes))
    throw new Error('summary maxBytes cannot represent terminal truth');
  // failingStep is an identifier, not prose: a codepoint-truncated script
  // name (e.g. "typecheck:s") reads as a different, wrong step, which is
  // worse than omitting it. It gets the first claim on the byte budget
  // (ahead of the causal excerpt below) precisely so it is never the thing
  // that gets cut — but only ever whole, never partial.
  if (failingStep) {
    const candidate = { ...summary, failingStep };
    if (fitsSummary(candidate, maxBytes)) summary.failingStep = failingStep;
  }
  // inFlightStep earns the same whole-or-omitted budget claim as failingStep:
  // it is an identifier for the same reason, and on a timeout it is the single
  // most useful field in the summary -- the one that says which phase to give
  // more budget or to shard further.
  if (inFlightStep) {
    const candidate = { ...summary, inFlightStep };
    if (fitsSummary(candidate, maxBytes)) summary.inFlightStep = inFlightStep;
  }
  // causeStream is an enum, and it gets the same whole-or-omitted treatment
  // for a sharper reason than failingStep's. Truncating `'stderr'` to `'s'`
  // yields a value outside the vocabulary, which a reader cannot interpret at
  // all -- and it was doing exactly that while it sat in the prose-truncating
  // semantic classes below.
  //
  // It also takes its claim on the budget BEFORE the excerpt it qualifies.
  // Absence of this field means "the excerpt was scoped to the failing step",
  // so a budget cut that dropped it would not lose information -- it would
  // manufacture a stronger claim than the run can support. A caveat that
  // vanishes under pressure is worse than one that never existed.
  if (causeStream) {
    const candidate = { ...summary, causeStream };
    if (fitsSummary(candidate, maxBytes)) summary.causeStream = causeStream;
  }
  const semanticClasses = [
    { key: 'firstCausalExcerpt', value: firstCausalExcerpt },
    { key: 'finalTally', value: finalTally },
    { key: 'slowItems', value: slowItems[0] ?? null },
  ].filter(({ value }) => value);
  // First reserve one complete code point for every available class in
  // priority order. A huge cause must never consume the final tally and slow
  // diagnostic fields that make a short result actionable.
  for (const semantic of semanticClasses) {
    if (!reserveSemantic(summary, semantic, maxBytes)) break;
  }
  const cause = semanticClasses.find(({ key }) => key === 'firstCausalExcerpt');
  const tally = semanticClasses.find(({ key }) => key === 'finalTally');
  const firstSlow = semanticClasses.find(({ key }) => key === 'slowItems');
  // Complete the lower-priority diagnostic classes while the high-priority
  // cause is still just its reservation, then spend all remaining space on
  // the cause. This deterministic allocation preserves full tally/slow text
  // whenever the cap permits it and gives the remaining bytes back to cause.
  if (tally) promoteSemantic(summary, tally, maxBytes);
  if (firstSlow) promoteSemantic(summary, firstSlow, maxBytes);
  if (cause) promoteSemantic(summary, cause, maxBytes);
  for (const slowItem of slowItems.slice(1)) {
    const candidate = {
      ...summary,
      slowItems: [...(summary.slowItems ?? []), slowItem],
    };
    if (!fitsSummary(candidate, maxBytes)) break;
    summary.slowItems = candidate.slowItems;
  }
  // station#4249: `causalExcerpts` is additive and strictly lower-priority
  // than every field above -- it is appended last and never displaces an
  // existing field's budget, which is what keeps `firstCausalExcerpt` (and
  // every other field) byte-identical to its pre-existing behaviour.
  //
  // Its head element is deliberately `summary.firstCausalExcerpt` -- the
  // ALREADY-TRUNCATED field value, not the raw excerpt -- so a reader who
  // only reads index 0 sees exactly the same text `firstCausalExcerpt`
  // reports, and the field is only ever added when `firstCausalExcerpt` itself
  // survived the budget above (never a case where causalExcerpts exists but
  // firstCausalExcerpt does not).
  //
  // Remaining excerpts are appended WHOLE, never partially truncated (the same
  // policy `slowItems` overflow uses above): a codepoint-truncated diagnostic
  // reads as a different, wrong one, which is worse than omitting it.
  if (summary.firstCausalExcerpt) {
    let excerpts = [summary.firstCausalExcerpt];
    if (fitsSummary({ ...summary, causalExcerpts: excerpts }, maxBytes)) {
      for (const excerpt of causalExcerptsObserved) {
        if (excerpt === firstCausalExcerpt) continue;
        const candidate = [...excerpts, excerpt];
        if (!fitsSummary({ ...summary, causalExcerpts: candidate }, maxBytes))
          break;
        excerpts = candidate;
      }
      summary.causalExcerpts = excerpts;
    }
  }
  return summary;
}

/**
 * @param {{ root: string, requestKey: string, stdout?: string, stderr?: string, maxBytes?: number }} options
 *   `root` and `requestKey` are required at runtime (the function throws
 *   without them); this annotation exists because tsconfig.scripts.json runs
 *   with checkJs:false, where tsc otherwise infers the parameter type from
 *   initialized properties only and .ts importers get a shape missing both
 *   required fields (TS2353 on every correct call site).
 */
export function persistVerificationOutput({
  root,
  requestKey,
  stdout = '',
  stderr = '',
  maxBytes = DEFAULT_OUTPUT_BYTE_CAP,
} = {}) {
  if (!root || !requestKey) throw new Error('root and requestKey are required');
  const prepareStream = (value) => {
    const source = String(value);
    // Redact the complete bounded source before choosing the persisted prefix.
    // Truncating first can shorten a secret below the redactor's recognition
    // length and leak its prefix at the boundary.
    const redacted = redactVerificationOutput(source);
    const capture = captureBoundedOutput([redacted], { maxBytes });
    capture.sourceBytes = Buffer.byteLength(source);
    capture.truncated ||= capture.sourceBytes > maxBytes;
    return capture;
  };
  const streams = {
    stdout: prepareStream(stdout),
    stderr: prepareStream(stderr),
  };
  const artifacts = [];
  for (const [kind, capture] of Object.entries(streams)) {
    // Redact the retained prefix, then re-bound at a codepoint boundary if
    // redaction expanded it past the cap. The persisted content is always the
    // real (redacted) retained prefix — never an omission marker — so its
    // digest describes exactly what is on disk and truncation metadata stays
    // machine-readable on the stream record.
    let contents = capture.text;
    if (Buffer.byteLength(contents) > maxBytes) {
      contents = longestUtf8Prefix(contents, maxBytes);
      capture.truncated = true;
    }
    capture.persistedBytes = Buffer.byteLength(contents);
    const path = artifactPath(requestKey, kind, contents);
    writeReceiptSecurely(path, contents, root);
    artifacts.push({ path, sha256: digest(contents) });
  }
  return {
    artifacts,
    streams,
    truncated: streams.stdout.truncated || streams.stderr.truncated,
  };
}

export function persistPlaywrightAttachments({
  root,
  requestKey,
  attachmentRoot,
  attachments = [],
  readFile = readFileSync,
  redact = redactVerificationOutput,
} = {}) {
  if (!root || !attachmentRoot)
    throw new Error('root and attachmentRoot are required');
  if (!REQUEST_KEY.test(requestKey ?? ''))
    throw new Error('requestKey must be a lowercase sha256 digest');
  const workspaceRoot = resolve(root);
  realpathSync(workspaceRoot);
  const lexicalAttachmentRoot = resolve(attachmentRoot);
  if (!isLexicalDescendant(workspaceRoot, lexicalAttachmentRoot))
    throw new Error('attachment root escapes workspace root');
  assertNoSymlinkAncestry(workspaceRoot, lexicalAttachmentRoot);
  if (attachments.length > 32) throw new Error('too many attachments');
  let totalBytes = 0;
  const validated = [];
  for (const attachment of attachments) {
    const source = resolve(attachment.path);
    if (!isLexicalDescendant(lexicalAttachmentRoot, source))
      throw new Error(`attachment escapes root: ${source}`);
    if (!/\.(?:txt|json|xml|html?)$/i.test(source))
      throw new Error(`unsupported binary attachment: ${source}`);
    assertNoSymlinkAncestry(lexicalAttachmentRoot, source);
    const stat = lstatSync(source);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error(`unsafe attachment: ${source}`);
    totalBytes += stat.size;
    if (
      stat.size > MAX_ATTACHMENT_BYTES ||
      totalBytes > MAX_ATTACHMENT_TOTAL_BYTES
    )
      throw new Error('attachment byte cap exceeded');
    validated.push({ source, stat });
  }

  const artifacts = [];
  let redactedTotalBytes = 0;
  for (const { source, stat } of validated) {
    const descriptor = openSync(
      source,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    let contents;
    try {
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || !sameIdentity(opened, stat))
        throw new Error('attachment changed while opening');
      const bytes = readFile(descriptor);
      const final = fstatSync(descriptor);
      if (!sameIdentity(final, opened))
        throw new Error('attachment changed while reading');
      if (!Buffer.isBuffer(bytes) || bytes.length !== opened.size)
        throw new Error('attachment bytes changed while reading');
      try {
        contents = new TextDecoder('utf-8', {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
      } catch {
        throw new Error('attachment is not valid UTF-8');
      }
      if (!Buffer.from(contents, 'utf8').equals(bytes))
        throw new Error('attachment is not valid UTF-8');
    } finally {
      closeSync(descriptor);
    }
    const redacted = redact(contents);
    const redactedBytes = Buffer.byteLength(redacted);
    redactedTotalBytes += redactedBytes;
    if (redactedBytes > MAX_REDACTED_ATTACHMENT_BYTES)
      throw new Error('attachment redaction exceeds byte cap');
    if (redactedTotalBytes > MAX_ATTACHMENT_TOTAL_BYTES)
      throw new Error('attachment redaction exceeds total byte cap');
    const path = artifactPath(requestKey, 'attachment', redacted);
    writeReceiptSecurely(path, redacted, root);
    artifacts.push({ path, sha256: digest(redacted) });
  }
  return artifacts;
}

/** GC only removes expired request directories that are not actively leased. */
export function gcVerificationArtifacts({
  root,
  activityResolver,
  withMutationClaim,
  now = Date.now(),
  maxAgeMs = 24 * 60 * 60_000,
  maxScanned = 256,
  maxRemovals = 32,
  openDirectory = opendirSync,
} = {}) {
  if (typeof activityResolver !== 'function')
    throw new Error('GC requires lease-derived activity proof');
  if (typeof withMutationClaim !== 'function')
    throw new Error('GC requires a mutation claim');
  if (
    !Number.isSafeInteger(maxAgeMs) ||
    maxAgeMs < 1 ||
    !Number.isSafeInteger(maxScanned) ||
    maxScanned < 1 ||
    !Number.isSafeInteger(maxRemovals) ||
    maxRemovals < 1
  )
    throw new Error('invalid GC bounds');
  const workspaceRoot = resolve(root);
  realpathSync(workspaceRoot);
  const directory = resolve(workspaceRoot, '.kontourai/verification-output');
  let removed = 0;
  try {
    // Resolve the workspace first, then inspect every lexical segment from
    // that real root. A symlinked `.kontourai` must never redirect GC outside
    // the checkout even when its resolved destination appears otherwise safe.
    assertNoSymlinkAncestry(workspaceRoot, directory);
    // Do not materialize or sort an attacker-controlled directory. Every GC
    // pass opens one directory stream and examines at most maxScanned entries.
    // Callers that need fair long-running sweeps should retain their own cursor
    // over request-key shards; this primitive deliberately chooses bounded work
    // over a full scan that lets junk entries consume unbounded CPU or context.
    const entries = openDirectory(directory);
    try {
      let scanned = 0;
      while (scanned < maxScanned) {
        const entry = entries.readSync();
        if (!entry) break;
        scanned += 1;
        const name = entry.name;
        if (!REQUEST_KEY.test(name) || removed >= maxRemovals) continue;
        if (activityResolver(name) !== 'inactive') continue;
        const target = resolve(directory, name);
        if (!isLexicalDescendant(directory, target)) continue;
        let observed;
        try {
          assertNoSymlinkAncestry(directory, target);
          observed = lstatSync(target);
        } catch (error) {
          if (error?.code === 'ENOENT' || /symbolic link/.test(error?.message))
            continue;
          throw error;
        }
        if (!observed.isDirectory() || now - observed.mtimeMs <= maxAgeMs)
          continue;
        withMutationClaim(name, () => {
          // Claim ownership does not prove the lease stayed inactive while we
          // waited. Re-resolve under the claim, then bind the quarantine rename
          // to the exact directory identity observed at that instant.
          if (activityResolver(name) !== 'inactive') return;
          let current;
          try {
            assertNoSymlinkAncestry(directory, target);
            current = lstatSync(target);
          } catch (error) {
            if (
              error?.code === 'ENOENT' ||
              /symbolic link/.test(error?.message)
            )
              return;
            throw error;
          }
          if (
            !current.isDirectory() ||
            now - current.mtimeMs <= maxAgeMs ||
            current.dev !== observed.dev ||
            current.ino !== observed.ino
          )
            return;
          const quarantine = resolve(directory, `.${name}.gc-${randomUUID()}`);
          if (!isLexicalDescendant(directory, quarantine))
            throw new Error('unsafe artifact quarantine path');
          try {
            renameSync(target, quarantine);
            const renamed = lstatSync(quarantine);
            if (
              !renamed.isDirectory() ||
              renamed.dev !== current.dev ||
              renamed.ino !== current.ino
            )
              throw new Error('artifact changed while quarantining');
            rmSync(quarantine, { recursive: true, force: true });
            removed += 1;
          } catch (error) {
            // A collision/replacement owns the canonical name. The quarantined
            // path is intentionally retained for inspection rather than risking
            // a recursive delete of an identity we did not verify.
            if (error?.code === 'ENOENT' || error?.code === 'EEXIST') return;
            throw error;
          }
        });
      }
    } finally {
      entries.closeSync();
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return removed;
}

function readJsonOrNull(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function requestKeyFromGcReceiptName(name) {
  const match =
    /^([0-9a-f]{64})\.(?:pending-[A-Za-z0-9._-]+\.json(?:\.(?:uncommitted|failed)-[A-Za-z0-9._-]+)?|canonical\.json(?:\.commit\.json)?\.(?:uncommitted|failed)-[A-Za-z0-9._-]+)$/.exec(
      name,
    );
  return match?.[1] ?? null;
}

function gcRecordKey(directory, name) {
  if (GC_RECORD_DIRECTORIES.includes(directory))
    return REQUEST_KEY.test(name) ? name : null;
  return requestKeyFromGcReceiptName(name);
}

function inspectGcDirectory({ workspaceRoot, directory, scan }) {
  const path = resolve(workspaceRoot, directory);
  try {
    assertNoSymlinkAncestry(workspaceRoot, path);
    const entries = opendirSync(path);
    try {
      const records = [];
      while (scan.scanned < scan.limit) {
        const entry = entries.readSync();
        if (!entry) return records;
        scan.scanned += 1;
        const key = gcRecordKey(directory, entry.name);
        if (!key) continue;
        const target = resolve(path, entry.name);
        try {
          assertNoSymlinkAncestry(path, target);
          const stat = lstatSync(target);
          if (
            (GC_RECORD_DIRECTORIES.includes(directory) &&
              !stat.isDirectory()) ||
            (directory === GC_RECEIPT_DIRECTORY && !stat.isFile())
          ) {
            scan.ambiguous = true;
            continue;
          }
          records.push({ key, path: target, stat, directory });
        } catch {
          scan.ambiguous = true;
        }
      }
      // Conservatively call an exact-bound scan truncated: this avoids a
      // potentially unbounded probe just to distinguish exactly N entries
      // from N+1 entries, and never turns an incomplete view into deletion.
      scan.truncated = true;
      return records;
    } finally {
      entries.closeSync();
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    scan.ambiguous = true;
    return [];
  }
}

function committedCanonicalReceipt(workspaceRoot, key) {
  const receiptPath = resolve(
    workspaceRoot,
    GC_RECEIPT_DIRECTORY,
    `${key}.canonical.json`,
  );
  const commitPath = `${receiptPath}.commit.json`;
  const receiptExists = existsSync(receiptPath);
  const commitExists = existsSync(commitPath);
  if (!receiptExists && !commitExists) return { protected: false };
  if (!receiptExists || !commitExists)
    return { protected: true, ambiguous: true };
  try {
    assertNoSymlinkAncestry(workspaceRoot, receiptPath);
    assertNoSymlinkAncestry(workspaceRoot, commitPath);
    const contents = readFileSync(receiptPath, 'utf8');
    const receipt = JSON.parse(contents);
    const commit = readJsonOrNull(commitPath);
    if (
      commit?.committed !== true ||
      commit.requestKey !== key ||
      commit.receiptDigest !== digest(contents) ||
      receipt?.request?.key !== key ||
      !RECEIPT_VALIDATOR(receipt)
    )
      return { protected: true, ambiguous: true };
    assertReceiptSemantics(receipt);
    return { protected: true, receipt };
  } catch {
    // A malformed canonical/commit pair is not evidence we may discard.
    return { protected: true, ambiguous: true };
  }
}

function validLease(lease) {
  return (
    lease &&
    typeof lease === 'object' &&
    lease.owner &&
    typeof lease.owner === 'object' &&
    typeof lease.owner.nonce === 'string' &&
    lease.owner.nonce.length > 0 &&
    typeof lease.state === 'string'
  );
}

function inspectHostProtection({ coordinatorRoot, key }) {
  if (!coordinatorRoot) return { protected: false };
  const root = resolve(coordinatorRoot);
  try {
    for (const lockName of [
      'full-regression.lock',
      'full-regression.queue.lock',
    ]) {
      const lock = resolve(root, lockName, 'lease.json');
      if (!existsSync(lock)) continue;
      assertNoSymlinkAncestry(root, lock);
      const lease = readJsonOrNull(lock);
      if (!validLease(lease)) return { protected: true, ambiguous: true };
      if (lease.requestKey === key || lease.request?.key === key)
        return { protected: true };
    }
    for (const name of ['requests', 'outputs']) {
      const directory = resolve(root, name);
      if (!existsSync(directory)) continue;
      assertNoSymlinkAncestry(root, directory);
      const entries = opendirSync(directory);
      try {
        let scanned = 0;
        while (scanned < GC_DEFAULT_MAX_SCANNED) {
          const entry = entries.readSync();
          if (!entry) break;
          scanned += 1;
          if (!entry.isDirectory()) return { protected: true, ambiguous: true };
          const leasePath = join(directory, entry.name, 'lease.json');
          assertNoSymlinkAncestry(directory, leasePath);
          const lease = readJsonOrNull(leasePath);
          if (!validLease(lease)) return { protected: true, ambiguous: true };
          if (lease.request?.key === key || lease.requestKey === key)
            return { protected: true };
        }
        if (scanned === GC_DEFAULT_MAX_SCANNED)
          return { protected: true, ambiguous: true };
      } finally {
        entries.closeSync();
      }
    }
    return { protected: false };
  } catch {
    return { protected: true, ambiguous: true };
  }
}

function inspectSubmissionProtection({ coordinatorRoot, key }) {
  if (!coordinatorRoot) return { protected: false };
  const path = resolve(coordinatorRoot, 'submissions', key, 'handoff.json');
  if (!existsSync(path)) return { protected: false };
  try {
    assertNoSymlinkAncestry(resolve(coordinatorRoot), path);
  } catch {
    return { protected: true, ambiguous: true };
  }
  const handoff = readJsonOrNull(path);
  if (
    !handoff ||
    handoff.request?.key !== key ||
    typeof handoff.state !== 'string'
  )
    return { protected: true, ambiguous: true };
  return {
    protected: ![
      'failed_to_start',
      'stale_before_execution',
      'settled',
    ].includes(handoff.state),
  };
}

function protectionForKey({ workspaceRoot, coordinatorRoot, key }) {
  const canonical = committedCanonicalReceipt(workspaceRoot, key);
  if (canonical.protected) return canonical;
  const host = inspectHostProtection({ coordinatorRoot, key });
  if (host.protected) return host;
  return inspectSubmissionProtection({ coordinatorRoot, key });
}

function oldGcRecord(record, now, maxAgeMs) {
  return now - record.stat.mtimeMs > maxAgeMs;
}

function quarantineGcRecord(record) {
  const quarantine = resolve(
    record.path,
    '..',
    `.${basename(record.path)}.gc-${randomUUID()}`,
  );
  try {
    renameSync(record.path, quarantine);
    const moved = lstatSync(quarantine);
    if (
      moved.dev !== record.stat.dev ||
      moved.ino !== record.stat.ino ||
      (record.directory === GC_RECEIPT_DIRECTORY
        ? !moved.isFile()
        : !moved.isDirectory())
    )
      return null;
    return { ...record, quarantine, stat: moved };
  } catch {
    return null;
  }
}

function restoreGcRecord(record) {
  try {
    if (!existsSync(record.path)) renameSync(record.quarantine, record.path);
  } catch {
    // If a successor owns the canonical name, retain the quarantine for a
    // later explicit inspection rather than deleting an unverified record.
  }
}

/**
 * Explicitly sweep old *orphaned* verification records. This is deliberately
 * not called by status or normal verification: canonical evidence and any
 * uncertain coordination state retain data. The shared per-request artifact
 * mutation fence keeps a concurrent coordinator from publishing matching
 * output or phase records until the exact quarantined identities are checked.
 */
export function sweepVerificationArtifactOrphans({
  root,
  coordinatorRoot,
  now = Date.now(),
  maxAgeMs = GC_DEFAULT_MAX_AGE_MS,
  maxScanned = GC_DEFAULT_MAX_SCANNED,
  maxRemovals = GC_DEFAULT_MAX_REMOVALS,
  dryRun = false,
  gcHooks,
} = {}) {
  if (!root)
    throw new Error('verification artifact GC requires a workspace root');
  if (
    !Number.isSafeInteger(maxAgeMs) ||
    maxAgeMs < 1 ||
    !Number.isSafeInteger(maxScanned) ||
    maxScanned < 1 ||
    !Number.isSafeInteger(maxRemovals) ||
    maxRemovals < 1
  )
    throw new Error('invalid verification artifact GC bounds');
  const workspaceRoot = resolve(root);
  realpathSync(workspaceRoot);
  const scan = {
    scanned: 0,
    limit: maxScanned,
    truncated: false,
    ambiguous: false,
  };
  const records = [
    ...GC_RECORD_DIRECTORIES.flatMap((directory) =>
      inspectGcDirectory({ workspaceRoot, directory, scan }),
    ),
    ...inspectGcDirectory({
      workspaceRoot,
      directory: GC_RECEIPT_DIRECTORY,
      scan,
    }),
  ];
  const summary = {
    mode: dryRun ? 'dry-run' : 'delete',
    scanned: scan.scanned,
    removed: 0,
    wouldRemove: 0,
    retained: 0,
    truncated: scan.truncated,
    ambiguous: scan.ambiguous,
    candidates: [],
  };
  if (scan.ambiguous) {
    summary.retained = records.length;
    return summary;
  }
  for (const record of records) {
    if ((dryRun ? summary.wouldRemove : summary.removed) >= maxRemovals) {
      summary.truncated = true;
      summary.retained += 1;
      continue;
    }
    if (!oldGcRecord(record, now, maxAgeMs)) {
      summary.retained += 1;
      continue;
    }
    const protection = protectionForKey({
      workspaceRoot,
      coordinatorRoot,
      key: record.key,
    });
    if (protection.protected) {
      summary.retained += 1;
      continue;
    }
    if (dryRun) {
      summary.wouldRemove += 1;
      summary.retained += 1;
      summary.candidates.push({
        path: relative(workspaceRoot, record.path).split(sep).join('/'),
        reason:
          'expired orphan with no committed receipt or live lease/handoff',
      });
      continue;
    }
    const claim = coordinatorRoot
      ? tryAcquireVerificationArtifactMutation({
          root: coordinatorRoot,
          requestKey: record.key,
          now,
        })
      : null;
    if (coordinatorRoot && !claim) {
      summary.retained += 1;
      continue;
    }
    try {
      if (
        protectionForKey({
          workspaceRoot,
          coordinatorRoot,
          key: record.key,
        }).protected
      ) {
        summary.retained += 1;
        continue;
      }
      gcHooks?.beforeQuarantine?.({ record });
      const quarantined = quarantineGcRecord(record);
      if (!quarantined) {
        summary.retained += 1;
        continue;
      }
      gcHooks?.afterQuarantine?.({ record: quarantined });
      const protectedAfterQuarantine = protectionForKey({
        workspaceRoot,
        coordinatorRoot,
        key: record.key,
      });
      const unchanged = (() => {
        try {
          const current = lstatSync(quarantined.quarantine);
          return (
            sameIdentity(current, quarantined.stat) &&
            oldGcRecord({ ...quarantined, stat: current }, now, maxAgeMs)
          );
        } catch {
          return false;
        }
      })();
      if (protectedAfterQuarantine.protected || !unchanged) {
        restoreGcRecord(quarantined);
        summary.retained += 1;
        continue;
      }
      gcHooks?.beforeDelete?.({ record: quarantined });
      // Revalidate the exact quarantined inode and all retention fences after
      // hooks have had a chance to model a successor publication.
      const protectedBeforeDelete = protectionForKey({
        workspaceRoot,
        coordinatorRoot,
        key: record.key,
      });
      if (protectedBeforeDelete.protected) {
        restoreGcRecord(quarantined);
        summary.retained += 1;
        continue;
      }
      const current = lstatSync(quarantined.quarantine);
      if (!sameIdentity(current, quarantined.stat)) {
        restoreGcRecord(quarantined);
        summary.retained += 1;
        continue;
      }
      rmSync(quarantined.quarantine, { recursive: true, force: true });
      summary.removed += 1;
    } finally {
      releaseVerificationArtifactMutation(claim);
    }
  }
  return summary;
}
