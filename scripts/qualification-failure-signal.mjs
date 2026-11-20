// Classifies a red main qualification run as "red only on known failures" or
// "a new failure", from the failure manifests the runners wrote, never from
// job logs. It changes no run's verdict and skips no test: a known failure
// still fails its run and still blocks release. Anything a manifest does not
// explicitly explain is a new failure.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  JOB_MANIFEST_FILE,
  jobExplained,
  MANIFEST_BOUNDS,
  parseJobManifest,
} from './lib/qualification-failure-manifest.mjs';
import { github } from './qualification-evidence.mjs';

export const KNOWN_FAILURES_PATH = 'config/qualification-known-failures.json';
const MAX_ENTRIES = 20;
const MAX_LIST_BYTES = 256 * 1024;
const MAX_MANIFESTS = 64;
const GATE_SUFFIX = 'Full source qualification';
/**
 * The steps that run the phases a manifest describes, by name in
 * full-regression.yml. A failed job is explained only when its one failed
 * step is one of these: a later setup, upload or post step that also failed
 * is invisible to the manifest.
 */
export const MANIFEST_PHASE_STEPS = Object.freeze([
  'Run full-regression phases',
  'Run Android viewport tests',
]);
const JOB_PREFIX = 'qualification / ';

/** `report` (the default) observes; only `enforce` changes tracker decisions. */
export function signalMode(value) {
  const mode = String(value ?? '');
  // Exact: a stray space or capital letter must not switch enforcement on.
  if (mode === 'enforce') return 'enforce';
  if (mode !== '' && mode !== 'report')
    process.stderr.write(
      `Unknown STATION_QUALIFICATION_SIGNAL "${mode.slice(0, 40)}"; reporting only.\n`,
    );
  return 'report';
}

const isTitle = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 2_000;

/**
 * The committed list of standing failures. Each entry is exactly one test
 * identity (`file`, full `titlePath`, optional `project`) and the `issue`
 * that owns it. No file, pattern, phase or job entries exist, so nothing
 * broader than one exact test can ever be excused.
 */
export function parseKnownFailures(text) {
  if (Buffer.byteLength(text) > MAX_LIST_BYTES)
    throw new Error(`${KNOWN_FAILURES_PATH} exceeds ${MAX_LIST_BYTES} bytes`);
  const document = JSON.parse(text);
  const keys = Object.keys(document ?? {}).sort();
  if (
    document?.schemaVersion !== 1 ||
    !Array.isArray(document.entries) ||
    keys.some((key) => !['$comment', 'entries', 'schemaVersion'].includes(key))
  )
    throw new Error(
      `${KNOWN_FAILURES_PATH} must be { schemaVersion: 1, entries }`,
    );
  if (document.entries.length > MAX_ENTRIES)
    throw new Error(
      `${KNOWN_FAILURES_PATH} holds more than ${MAX_ENTRIES} entries`,
    );
  const seen = new Set();
  return document.entries.map((entry, index) => {
    const label = `${KNOWN_FAILURES_PATH} entry ${index}`;
    const fields = Object.keys(entry ?? {}).sort();
    const allowed = Object.hasOwn(entry ?? {}, 'project')
      ? ['file', 'issue', 'project', 'titlePath']
      : ['file', 'issue', 'titlePath'];
    if (
      JSON.stringify(fields) !== JSON.stringify(allowed) ||
      !Number.isSafeInteger(entry.issue) ||
      entry.issue <= 0 ||
      !/^\S+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.file ?? '') ||
      !Array.isArray(entry.titlePath) ||
      entry.titlePath.length === 0 ||
      entry.titlePath.length > MANIFEST_BOUNDS.titlePathDepth ||
      !entry.titlePath.every(isTitle) ||
      (entry.project !== undefined && !isTitle(entry.project))
    )
      throw new Error(
        `${label} must be exactly { file, titlePath, issue } (project optional)`,
      );
    const key = JSON.stringify([entry.file, entry.titlePath, entry.project]);
    if (seen.has(key)) throw new Error(`${label} duplicates an earlier entry`);
    seen.add(key);
    return Object.freeze({
      issue: entry.issue,
      file: entry.file,
      titlePath: Object.freeze([...entry.titlePath]),
      ...(entry.project === undefined ? {} : { project: entry.project }),
    });
  });
}

export function loadKnownFailures(root = process.cwd()) {
  return parseKnownFailures(
    readFileSync(resolve(root, KNOWN_FAILURES_PATH), 'utf8'),
  );
}

/** Exact identity: file, every title, and project when either names one. */
function sameTest(entry, test) {
  return (
    entry.file === test.file &&
    entry.titlePath.length === test.titlePath.length &&
    entry.titlePath.every((title, index) => title === test.titlePath[index]) &&
    entry.project === test.project
  );
}

function testLabel(test) {
  return `${test.project ? `[${test.project}] ` : ''}${test.file} > ${test.titlePath.join(' > ')}`;
}

/**
 * Every job manifest under a download directory: actions/download-artifact
 * extracts a single match into the download root and multiple matches into
 * artifact subdirectories. Unreadable or invalid manifests still alert.
 */
export function readJobManifests(directory) {
  const found = [];
  if (!directory) return found;
  let names;
  try {
    names = readdirSync(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of names) {
    const isRootManifest = entry.name === JOB_MANIFEST_FILE && entry.isFile();
    if (!isRootManifest && !entry.isDirectory()) continue;
    if (found.length >= MAX_MANIFESTS) {
      found.push({ artifact: entry.name, error: 'too many manifests' });
      break;
    }
    const file = resolve(
      directory,
      isRootManifest ? '' : entry.name,
      JOB_MANIFEST_FILE,
    );
    try {
      found.push({
        artifact: entry.name,
        manifest: parseJobManifest(readFileSync(file, 'utf8')),
      });
    } catch (error) {
      found.push({
        artifact: entry.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return found;
}

const isQualificationJob = (job) =>
  job.name.startsWith(JOB_PREFIX) &&
  job.name !== `${JOB_PREFIX}resolve` &&
  !job.name.endsWith(GATE_SUFFIX);

function unexplainedReason(manifest) {
  const kinds = new Set();
  if (!manifest.complete) kinds.add('incomplete');
  for (const phase of manifest.phases) {
    if (phase.error)
      kinds.add(`phase ${phase.phase}: ${phase.error}`.slice(0, 200));
    else if (!phase.corpus && phase.exitStatus !== 0)
      kinds.add(`phase ${phase.phase} failed without test identities`);
    for (const group of phase.groups) {
      for (const error of group.runnerErrors) kinds.add(error.kind);
      for (const file of group.failedFiles)
        kinds.add(
          `${file.file} failed outside a named test (${file.reason === 'load' ? 'did not load' : 'a hook or suite failed'})`.slice(
            0,
            200,
          ),
        );
      const identities = new Set(
        group.failedTests.map((test) =>
          JSON.stringify([test.file, test.titlePath, test.project ?? null]),
        ),
      );
      if (identities.size !== group.failedTests.length)
        kinds.add('a failed test identity is reported more than once');
      if (group.counts.unhandledErrors)
        kinds.add(`${group.counts.unhandledErrors} unhandled error(s)`);
    }
  }
  return kinds.size
    ? `unexplained (${[...kinds].join('; ')})`
    : 'unexplained (counts do not reconcile)';
}

/**
 * Classify one completed run. `manifests` is readJobManifests' output for
 * this run's artifacts, `issueStates` maps each listed issue to `open`,
 * `closed` or `unavailable`. A failed job is explained only by a valid
 * manifest for this exact run and attempt whose failures are fully
 * explained; every other case is a new failure.
 */
export function classifyRun({ run, jobs, manifests, entries, issueStates }) {
  const fresh = [];
  const known = [];
  const matched = new Set();
  const failedJobs = jobs.filter(
    (job) =>
      isQualificationJob(job) &&
      !(
        job.status === 'completed' &&
        ['success', 'skipped'].includes(job.conclusion)
      ),
  );
  const invalid = manifests.filter((item) => item.error);
  for (const job of failedJobs) {
    const label = job.name.slice(JOB_PREFIX.length);
    const newFailure = (reason) =>
      fresh.push({ job: job.name, failure: label, reason });
    if (job.status !== 'completed' || job.conclusion !== 'failure') {
      newFailure(`job ${job.conclusion ?? job.status}`);
      continue;
    }
    if (!Array.isArray(job.steps)) {
      newFailure('job steps unavailable');
      continue;
    }
    const failedSteps = job.steps.filter(
      (step) => !['success', 'skipped'].includes(step.conclusion),
    );
    if (
      failedSteps.length !== 1 ||
      !MANIFEST_PHASE_STEPS.includes(failedSteps[0].name) ||
      // The phase step must have failed, not been cancelled, timed out or
      // left without a conclusion.
      failedSteps[0].conclusion !== 'failure'
    ) {
      newFailure(
        `failed in step(s) ${failedSteps.map((step) => `"${step.name}" (${step.conclusion})`).join(', ') || 'none'}, not only in its test phase`,
      );
      continue;
    }
    const own = manifests.filter((item) => item.manifest?.jobLabel === label);
    if (own.length === 0) {
      newFailure(
        invalid.length
          ? `no valid failure manifest (${invalid
              .map((item) => item.error)
              .join('; ')
              .slice(0, 300)})`
          : 'no failure manifest',
      );
      continue;
    }
    const current = own.filter(
      ({ manifest }) =>
        manifest.sourceSha === run.head_sha &&
        manifest.runId === String(run.id) &&
        manifest.runAttempt === String(run.run_attempt),
    );
    if (current.length !== 1) {
      newFailure(
        current.length === 0
          ? 'failure manifest belongs to another run, attempt or source'
          : 'more than one failure manifest for this job',
      );
      continue;
    }
    const { manifest } = current[0];
    if (manifest.explained !== true || !jobExplained(manifest)) {
      newFailure(unexplainedReason(manifest));
      continue;
    }
    const tests = manifest.phases.flatMap((phase) =>
      phase.groups.flatMap((group) => group.failedTests),
    );
    if (tests.length === 0) newFailure('failed with no failed test listed');
    for (const test of tests) {
      const entry = entries.find((candidate) => sameTest(candidate, test));
      const failure = testLabel(test);
      if (!entry) {
        fresh.push({
          job: job.name,
          failure,
          reason: 'no known-failure entry',
        });
        continue;
      }
      matched.add(entry);
      const state = issueStates.get(entry.issue) ?? 'unavailable';
      if (state === 'open')
        known.push({ job: job.name, failure, issue: entry.issue });
      else
        fresh.push({
          job: job.name,
          failure,
          reason:
            state === 'closed'
              ? `issue #${entry.issue} is closed`
              : `issue #${entry.issue} could not be read as an open issue`,
        });
    }
  }
  if (failedJobs.length === 0 && run.conclusion !== 'success')
    fresh.push({
      job: run.html_url ?? String(run.id),
      failure: 'qualification',
      reason: 'the run failed without a failed qualification job',
    });
  const removable = entries
    .filter(
      (entry) =>
        !matched.has(entry) || issueStates.get(entry.issue) === 'closed',
    )
    .map((entry) => ({
      ...entry,
      reason:
        issueStates.get(entry.issue) === 'closed'
          ? `issue #${entry.issue} is closed`
          : 'did not fail in this run',
    }));
  return {
    known,
    fresh,
    removable,
    knownOnly: fresh.length === 0 && known.length > 0,
  };
}

async function issueState(number, env) {
  try {
    const issue = await github(`issues/${number}`, { env });
    if (issue?.number !== number || issue.pull_request) return 'unavailable';
    if (issue.state === 'open') return 'open';
    return issue.state === 'closed' ? 'closed' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/**
 * The signal for one run. Every failure to read the list, a manifest or an
 * issue becomes a new failure, so an outage raises the alert.
 */
export async function qualificationFailureSignal(
  run,
  jobs,
  {
    env = process.env,
    root = process.cwd(),
    manifestDirectory = env.QUALIFICATION_MANIFEST_DIR,
    readIssue = issueState,
  } = {},
) {
  let entries = [];
  let listError = null;
  try {
    entries = loadKnownFailures(root);
  } catch (error) {
    listError = error instanceof Error ? error.message : String(error);
  }
  const issueStates = new Map();
  for (const issue of new Set(entries.map((entry) => entry.issue)))
    issueStates.set(issue, await readIssue(issue, env));
  const signal = classifyRun({
    run,
    jobs,
    manifests: readJobManifests(manifestDirectory),
    entries,
    issueStates,
  });
  if (listError) {
    signal.fresh.unshift({
      job: KNOWN_FAILURES_PATH,
      failure: 'known-failure list unreadable',
      reason: listError,
    });
    signal.knownOnly = false;
  }
  return signal;
}

/** Markdown lines for tracker bodies and step summaries. */
export function describeSignal(signal, { mode = 'report' } = {}) {
  const owners = [...new Set(signal.known.map((item) => item.issue))]
    .sort((a, b) => a - b)
    .map((issue) => `#${issue}`);
  const lines = [
    `Failure classification (${mode === 'enforce' ? 'enforced' : 'report only; tracker decisions unchanged'}):`,
  ];
  if (signal.knownOnly)
    lines.push(
      `Main qualification is still red, only on known failures owned by open issues ${owners.join(', ')}. Release qualification stays blocked until a run is green.`,
    );
  if (signal.fresh.length) {
    lines.push('New failures (not explained by an open known-failure entry):');
    for (const item of signal.fresh.slice(0, 30))
      lines.push(`- ${item.failure} — ${item.reason} (${item.job})`);
    if (signal.fresh.length > 30)
      lines.push(`- and ${signal.fresh.length - 30} more`);
  }
  if (signal.known.length) {
    lines.push(`Known failures, owned by ${owners.join(', ')}:`);
    for (const item of signal.known.slice(0, 30))
      lines.push(`- ${item.failure} (#${item.issue})`);
  }
  if (signal.removable.length) {
    lines.push(
      `Entries to review for removal from \`${KNOWN_FAILURES_PATH}\`:`,
    );
    for (const entry of signal.removable)
      lines.push(`- ${testLabel(entry)} (#${entry.issue}): ${entry.reason}`);
  }
  return lines;
}
