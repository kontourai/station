// The structured failure manifest qualification jobs write, and the one rule
// that decides whether a job's failure is fully explained by named test
// failures. Producers (the full-regression phase driver, the Vitest corpus
// runner, the e2e suite runner) and the consumer
// (qualification-failure-signal.mjs) share this module so the rule exists
// once. The consumer re-derives `explained` from the data rather than trusting
// the producer's flag.

export const MANIFEST_SCHEMA_VERSION = 1;
export const JOB_MANIFEST_KIND = 'station.qualification-job-manifest';
/** The file name a job writes into its manifest directory. */
export const JOB_MANIFEST_FILE = 'job-manifest.json';
/** Environment variable naming the directory a job's manifest goes to. */
export const MANIFEST_DIR_ENV = 'STATION_QUALIFICATION_MANIFEST_DIR';
/** Environment variable carrying the job's displayed name. */
export const JOB_LABEL_ENV = 'STATION_QUALIFICATION_JOB_LABEL';

export const MANIFEST_BOUNDS = Object.freeze({
  bytes: 4 * 1024 * 1024,
  phases: 32,
  groupsPerPhase: 16,
  failedTestsPerGroup: 500,
  failedFilesPerGroup: 200,
  runnerErrorsPerGroup: 50,
  titlePathDepth: 32,
  text: 2_000,
});

const PRODUCERS = new Set(['full-regression-phases', 'e2e-suite']);
const FAILED_FILE_REASONS = new Set(['load', 'suite']);

/** Clip free text so a runaway message cannot exceed the manifest bound. */
export function clipText(value) {
  const text = String(value ?? '');
  return text.length > MANIFEST_BOUNDS.text
    ? `${text.slice(0, MANIFEST_BOUNDS.text)}…`
    : text;
}

const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

/**
 * Whether one test-runner invocation's non-zero exit is fully explained by
 * the tests it names. Every condition must hold; anything the runner could
 * not account for leaves the group unexplained.
 */
export function groupExplained(group) {
  const failedFiles = new Set(group.failedTests.map((test) => test.file));
  const { reporterFailedTests, reporterFailedFiles, unhandledErrors } =
    group.counts;
  if (
    group.runnerErrors.length > 0 ||
    group.signal !== null ||
    group.failedFiles.some((file) => file.reason === 'load') ||
    !isCount(reporterFailedTests) ||
    !isCount(reporterFailedFiles) ||
    !isCount(unhandledErrors) ||
    unhandledErrors !== 0 ||
    reporterFailedTests !== group.failedTests.length ||
    reporterFailedFiles !== failedFiles.size
  )
    return false;
  if (group.exitStatus === 0) return group.failedTests.length === 0;
  return group.exitStatus === 1 && group.failedTests.length > 0;
}

/**
 * A phase is explained when it ran to its own verdict and that verdict is
 * the verdict of its explained test groups. A phase with no test groups is
 * explained only when it passed: a failed build or static phase names no
 * test, so it can never be a known failure.
 */
export function phaseExplained(phase) {
  if (phase.error !== null) return false;
  if (!phase.corpus) return phase.exitStatus === 0;
  if (phase.groups.length === 0 || !phase.groups.every(groupExplained))
    return false;
  if (phase.exitStatus === 0)
    return phase.groups.every((group) => group.exitStatus === 0);
  return (
    phase.exitStatus === 1 &&
    phase.groups.some((group) => group.exitStatus === 1)
  );
}

/** A job manifest from already-built phases; `explained` is derived here. */
export function buildJobManifest({ producer, identity, complete, phases }) {
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    kind: JOB_MANIFEST_KIND,
    producer,
    jobLabel: clipText(identity.jobLabel ?? ''),
    sourceSha: identity.sourceSha,
    runId: identity.runId,
    runAttempt: identity.runAttempt,
    complete,
    phases: phases.map((phase) => ({
      ...phase,
      explained: phaseExplained(phase),
    })),
    explained: false,
  };
  manifest.explained = jobExplained(manifest);
  return manifest;
}

export function jobExplained(manifest) {
  return (
    manifest.complete === true &&
    manifest.phases.length > 0 &&
    manifest.phases.every(phaseExplained)
  );
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`${label} must have exactly ${expected.join(', ')}`);
}

function boundedArray(value, max, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > max)
    throw new Error(`${label} holds ${value.length} entries; at most ${max}`);
  return value;
}

function text(value, label) {
  if (typeof value !== 'string' || value.length > MANIFEST_BOUNDS.text + 1)
    throw new Error(`${label} must be bounded text`);
}

function validateGroup(group, label) {
  exactKeys(
    group,
    [
      'group',
      'exitStatus',
      'signal',
      'failedTests',
      'failedFiles',
      'runnerErrors',
      'counts',
      'explained',
    ],
    label,
  );
  text(group.group, `${label}.group`);
  if (group.exitStatus !== null && !Number.isSafeInteger(group.exitStatus))
    throw new Error(`${label}.exitStatus must be an integer or null`);
  if (group.signal !== null) text(group.signal, `${label}.signal`);
  boundedArray(
    group.failedTests,
    MANIFEST_BOUNDS.failedTestsPerGroup,
    `${label}.failedTests`,
  ).forEach((test, index) => {
    exactKeys(
      test,
      Object.hasOwn(test ?? {}, 'project')
        ? ['file', 'titlePath', 'project']
        : ['file', 'titlePath'],
      `${label}.failedTests[${index}]`,
    );
    text(test.file, `${label}.failedTests[${index}].file`);
    if (test.project !== undefined)
      text(test.project, `${label}.failedTests[${index}].project`);
    boundedArray(
      test.titlePath,
      MANIFEST_BOUNDS.titlePathDepth,
      `${label}.failedTests[${index}].titlePath`,
    ).forEach((title) =>
      text(title, `${label}.failedTests[${index}].titlePath`),
    );
    if (test.titlePath.length === 0)
      throw new Error(`${label}.failedTests[${index}].titlePath is empty`);
  });
  boundedArray(
    group.failedFiles,
    MANIFEST_BOUNDS.failedFilesPerGroup,
    `${label}.failedFiles`,
  ).forEach((file, index) => {
    exactKeys(file, ['file', 'reason'], `${label}.failedFiles[${index}]`);
    text(file.file, `${label}.failedFiles[${index}].file`);
    if (!FAILED_FILE_REASONS.has(file.reason))
      throw new Error(`${label}.failedFiles[${index}].reason is unknown`);
  });
  boundedArray(
    group.runnerErrors,
    MANIFEST_BOUNDS.runnerErrorsPerGroup,
    `${label}.runnerErrors`,
  ).forEach((error, index) => {
    exactKeys(error, ['kind', 'message'], `${label}.runnerErrors[${index}]`);
    text(error.kind, `${label}.runnerErrors[${index}].kind`);
    text(error.message, `${label}.runnerErrors[${index}].message`);
  });
  exactKeys(
    group.counts,
    ['reporterFailedTests', 'reporterFailedFiles', 'unhandledErrors'],
    `${label}.counts`,
  );
  for (const [key, value] of Object.entries(group.counts))
    if (value !== null && !isCount(value))
      throw new Error(`${label}.counts.${key} must be a count or null`);
  if (typeof group.explained !== 'boolean')
    throw new Error(`${label}.explained must be a boolean`);
}

/**
 * Parse and strictly validate one job manifest. Throws on anything that is
 * not exactly the schema, including a size over the bound.
 */
export function parseJobManifest(source) {
  if (Buffer.byteLength(source) > MANIFEST_BOUNDS.bytes)
    throw new Error(`manifest exceeds ${MANIFEST_BOUNDS.bytes} bytes`);
  const manifest = JSON.parse(source);
  exactKeys(
    manifest,
    [
      'schemaVersion',
      'kind',
      'producer',
      'jobLabel',
      'sourceSha',
      'runId',
      'runAttempt',
      'complete',
      'phases',
      'explained',
    ],
    'manifest',
  );
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION)
    throw new Error('manifest schemaVersion is unsupported');
  if (manifest.kind !== JOB_MANIFEST_KIND)
    throw new Error('manifest kind is not a qualification job manifest');
  if (!PRODUCERS.has(manifest.producer))
    throw new Error('manifest producer is unknown');
  text(manifest.jobLabel, 'manifest.jobLabel');
  if (!/^[0-9a-f]{40}$/.test(manifest.sourceSha ?? ''))
    throw new Error('manifest sourceSha must be a full commit SHA');
  if (!/^[1-9][0-9]*$/.test(manifest.runId ?? ''))
    throw new Error('manifest runId must be a run id');
  if (!/^[1-9][0-9]*$/.test(manifest.runAttempt ?? ''))
    throw new Error('manifest runAttempt must be an attempt number');
  if (typeof manifest.complete !== 'boolean')
    throw new Error('manifest complete must be a boolean');
  if (typeof manifest.explained !== 'boolean')
    throw new Error('manifest explained must be a boolean');
  boundedArray(
    manifest.phases,
    MANIFEST_BOUNDS.phases,
    'manifest.phases',
  ).forEach((phase, index) => {
    const label = `manifest.phases[${index}]`;
    exactKeys(
      phase,
      ['phase', 'exitStatus', 'error', 'corpus', 'groups', 'explained'],
      label,
    );
    text(phase.phase, `${label}.phase`);
    if (phase.exitStatus !== null && !Number.isSafeInteger(phase.exitStatus))
      throw new Error(`${label}.exitStatus must be an integer or null`);
    if (phase.error !== null) text(phase.error, `${label}.error`);
    if (typeof phase.corpus !== 'boolean')
      throw new Error(`${label}.corpus must be a boolean`);
    if (typeof phase.explained !== 'boolean')
      throw new Error(`${label}.explained must be a boolean`);
    boundedArray(
      phase.groups,
      MANIFEST_BOUNDS.groupsPerPhase,
      `${label}.groups`,
    ).forEach((group, groupIndex) =>
      validateGroup(group, `${label}.groups[${groupIndex}]`),
    );
  });
  return manifest;
}
