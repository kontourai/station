import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

export const PRODUCT_LAW_SCHEMA_VERSION = 1;
export const PRODUCT_LAW_FAMILIES = Object.freeze([
  'queue-dispatch',
  'lifecycle-completion',
  'approvals',
  'home-role-recovery',
  'release-stage-truth',
  'mobile-context',
]);
export const MAX_PRODUCT_LAWS = 6;
export const MAX_PRODUCT_LAW_FILES = 6;
export const PRODUCT_LAW_OBSERVATION_TIMEOUT_MS = 30_000;
export const PRODUCT_LAW_OBSERVATION_TIMEOUT_ENV =
  'PRODUCT_LAW_OBSERVATION_TIMEOUT_MS';
export const MAX_PRODUCT_LAW_RUNTIME_MS = 150_000;
export const PRODUCT_LAW_TIMEOUT_EXIT_CODE = 80;

const PRODUCT_LAW_ID =
  /^station\.[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/;

/**
 * @typedef {{
 *   lawId: string;
 *   phase: 'behavior' | 'fault-injection';
 *   kind: 'vitest-file';
 *   testFile: string;
 *   selector: string;
 * }} ProductLawObservation
 */

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function productLawObservationTimeoutMs(env = process.env) {
  const configured = Number(env?.[PRODUCT_LAW_OBSERVATION_TIMEOUT_ENV]);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : PRODUCT_LAW_OBSERVATION_TIMEOUT_MS;
}

function pathInsideRoot(rootDir, file) {
  if (!nonEmptyString(file)) return false;
  const candidate = resolve(rootDir, file);
  const path = relative(rootDir, candidate);
  return (
    path !== '' &&
    path !== '..' &&
    !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  );
}

function observationErrors(law, label, name, rootDir, exists, readFile) {
  const errors = [];
  const observation = law?.[name];
  if (observation?.kind !== 'vitest-file') {
    errors.push(
      `product law ${label} has no executable ${name} vitest-file observation`,
    );
    return errors;
  }
  if (!pathInsideRoot(rootDir, observation.testFile)) {
    errors.push(`product law ${label} has an invalid ${name} testFile`);
    return errors;
  }
  const testPath = resolve(rootDir, observation.testFile);
  if (!exists(testPath)) {
    errors.push(
      `product law ${label} ${name} testFile does not exist: ${observation.testFile}`,
    );
    return errors;
  }
  if (!nonEmptyString(observation.selector)) {
    errors.push(`product law ${label} has an empty ${name} selector`);
    return errors;
  }
  if (!readFile(testPath, 'utf8').includes(observation.selector))
    errors.push(
      `product law ${label} ${name} selector is absent from ${observation.testFile}`,
    );
  return errors;
}

function affectedPathErrors(law, label, rootDir, exists) {
  if (!Array.isArray(law?.affectedPaths) || law.affectedPaths.length === 0)
    return [`product law ${label} is missing affectedPaths`];
  return law.affectedPaths.flatMap((path) => {
    if (!pathInsideRoot(rootDir, path))
      return [
        `product law ${label} has an invalid affected path: ${String(path)}`,
      ];
    if (!exists(resolve(rootDir, path)))
      return [`product law ${label} affected path does not exist: ${path}`];
    return [];
  });
}

export function loadProductLawManifest({
  rootDir = process.cwd(),
  manifestFile = 'config/product-laws.json',
  readFile = readFileSync,
} = {}) {
  return JSON.parse(readFile(resolve(rootDir, manifestFile), 'utf8'));
}

/**
 * The manifest is intentionally small and evidence-bound. A selector does not
 * prove a law by itself: it only defines the exact named test the observation
 * runner must later select and inspect from structured Vitest results.
 */
export function validateProductLawManifest(
  manifest,
  {
    rootDir = process.cwd(),
    exists = existsSync,
    readFile = readFileSync,
  } = {},
) {
  const errors = [];
  if (manifest?.schemaVersion !== PRODUCT_LAW_SCHEMA_VERSION)
    errors.push(
      `product-law manifest schemaVersion must be ${PRODUCT_LAW_SCHEMA_VERSION}`,
    );
  if (!Array.isArray(manifest?.laws) || manifest.laws.length === 0) {
    errors.push('product-law manifest must declare at least one law');
    return errors;
  }
  if (manifest.laws.length > MAX_PRODUCT_LAWS)
    errors.push(
      `product-law manifest exceeds the ${MAX_PRODUCT_LAWS}-law verification budget`,
    );

  const ids = new Set();
  const families = new Set();
  const files = new Set();
  for (const law of manifest.laws) {
    const label = nonEmptyString(law?.id) ? law.id : '<missing id>';
    if (!nonEmptyString(law?.id) || !PRODUCT_LAW_ID.test(law.id))
      errors.push(`product law ${label} has an invalid stable id`);
    else if (ids.has(law.id))
      errors.push(`product law ${law.id} is duplicated`);
    else ids.add(law.id);

    if (!PRODUCT_LAW_FAMILIES.includes(law?.family))
      errors.push(`product law ${label} has an unknown family`);
    else families.add(law.family);
    for (const field of [
      'invariant',
      'module',
      'interface',
      'remediationOwner',
    ]) {
      if (!nonEmptyString(law?.[field]))
        errors.push(`product law ${label} is missing ${field}`);
    }
    for (const name of ['observation', 'faultInjection']) {
      errors.push(
        ...observationErrors(law, label, name, rootDir, exists, readFile),
      );
      if (nonEmptyString(law?.[name]?.testFile)) files.add(law[name].testFile);
    }
    errors.push(...affectedPathErrors(law, label, rootDir, exists));
  }
  if (files.size > MAX_PRODUCT_LAW_FILES)
    errors.push(
      `product-law manifest exceeds the ${MAX_PRODUCT_LAW_FILES}-file verification budget`,
    );
  for (const family of PRODUCT_LAW_FAMILIES) {
    if (!families.has(family))
      errors.push(`product-law manifest is missing initial family ${family}`);
  }
  return errors;
}

/** Maps changed owned paths to law IDs so selection and review can name the
 * exact observations that disposition a behavior/work-area change. */
export function productLawDispositions(manifest, changedPaths) {
  return (manifest.laws ?? [])
    .filter((law) =>
      (law.affectedPaths ?? []).some((ownedPath) =>
        changedPaths.some(
          (changedPath) =>
            changedPath === ownedPath ||
            changedPath.startsWith(`${ownedPath}/`),
        ),
      ),
    )
    .map((law) => law.id);
}

export function renderProductLawSection(manifest) {
  const rows = manifest.laws.map((law) => {
    return [
      `\`${law.id}\``,
      law.invariant,
      `\`${law.module}\``,
      `\`${law.interface}\``,
      `\`${law.observation.selector}\``,
      `\`${law.faultInjection.selector}\``,
      law.remediationOwner,
    ].join(' | ');
  });
  return [
    '<!-- station:product-laws:start -->',
    '# Executable product laws',
    '',
    `This file is generated from the product-law manifest. The manifest is the authority; this Markdown is a readable projection. Each law has exact behavior and fault observations evaluated through structured test results. A PASS means both named observations passed, a FAIL means either failed, and NOT_VERIFIED means the runner could not produce a trustworthy structured observation. The manifest is bounded to ${MAX_PRODUCT_LAWS} laws, ${MAX_PRODUCT_LAW_FILES} test files, and ${MAX_PRODUCT_LAW_RUNTIME_MS / 1_000}s total runtime. None of these results create a second completion lane.`,
    '',
    '| Law ID | Observable invariant | Owning Module | Affected Interface | Behavior observation | Fault observation | Remediation owner |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((row) => `| ${row} |`),
    '',
    'The contributor workflow regenerates this projection after intentional manifest changes. The gate rejects hand-edited projection drift, duplicate IDs, empty owners or selectors, nonexistent tests, a missing fault observation, and selectors absent from the exact structured test observation.',
    '<!-- station:product-laws:end -->',
    '',
  ].join('\n');
}

/**
 * @param {unknown} manifest
 * @param {{ observeLawTest?: (observation: ProductLawObservation) => Promise<{ status: string }> }} options
 */
export async function evaluateProductLawManifest(
  manifest,
  { observeLawTest } = {},
) {
  if (typeof observeLawTest !== 'function')
    throw new Error('product-law runner needs observeLawTest');
  const observations = [];
  for (const law of manifest.laws ?? []) {
    const behavior = await observeLawTest({
      lawId: law.id,
      phase: 'behavior',
      ...law.observation,
    });
    const faultInjection = await observeLawTest({
      lawId: law.id,
      phase: 'fault-injection',
      ...law.faultInjection,
    });
    const statuses = [behavior.status, faultInjection.status];
    observations.push({
      id: law.id,
      status: statuses.includes('FAIL')
        ? 'FAIL'
        : statuses.includes('INFRASTRUCTURE_ERROR')
          ? 'INFRASTRUCTURE_ERROR'
          : statuses.includes('NOT_VERIFIED')
            ? 'NOT_VERIFIED'
            : 'PASS',
      behavior,
      faultInjection,
    });
  }
  const statuses = observations.map((observation) => observation.status);
  return {
    status: statuses.includes('FAIL')
      ? 'FAIL'
      : statuses.includes('INFRASTRUCTURE_ERROR')
        ? 'INFRASTRUCTURE_ERROR'
        : statuses.includes('NOT_VERIFIED')
          ? 'NOT_VERIFIED'
          : 'PASS',
    observations,
  };
}

export function formatProductLawReport(report) {
  const lines = ['[product-laws] executable observations'];
  for (const observation of report.observations)
    lines.push(
      `[product-laws] ${observation.status} ${observation.id} behavior=${observation.behavior.status} fault-injection=${observation.faultInjection.status}${observation.behavior.reason ? ` behavior-reason=${observation.behavior.reason}` : ''}${observation.faultInjection.reason ? ` fault-injection-reason=${observation.faultInjection.reason}` : ''}`,
    );
  const counts = { failed: 0, infrastructureErrors: 0 };
  for (const observation of report.observations) {
    counts.failed += Number(observation.status === 'FAIL');
    counts.infrastructureErrors += Number(
      observation.status === 'INFRASTRUCTURE_ERROR',
    );
  }
  lines.push(
    `[product-laws] overall=${report.status} failed=${counts.failed} infrastructureErrors=${counts.infrastructureErrors}`,
  );
  return `${lines.join('\n')}\n`;
}
