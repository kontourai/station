/**
 * The environment a GitHub Actions job gets from the EVENT that started it
 * (#2922).
 *
 * A pull request's fast-checks run under `pull_request_target` and a merge
 * queue candidate under `merge_group`; the same test ran under both. A test
 * that let production code read the event -- `GITHUB_EVENT_NAME` deciding a
 * documentation-freshness mode, a base SHA read from `STATION_CI_FAST_BASE`
 * -- passed on the pull request and failed in the queue, which is the most
 * expensive place to learn it (PR #2934 nearly shipped one).
 *
 * `vitest.setup.ts` removes these variables from every test worker, so a
 * test sees the same environment in a pull request, in the merge queue and
 * on a laptop. A test that needs an event sets it explicitly (an `env`
 * argument or `vi.stubEnv`), which is the only way its assertion can say
 * which event it is about. Child processes a test starts inherit the scrubbed
 * environment.
 *
 * Deliberately kept: `GITHUB_ACTIONS` and `CI`. They are identical in every
 * workflow job, so they cannot differ between a pull request and the queue,
 * and code legitimately keys CI-only behaviour on them (for example
 * `scripts/lib/account-requirement.mjs`).
 */

/**
 * Station variables whose workflow value is derived from the triggering
 * event. `ci-event-environment.test.ts` derives the same set from
 * `.github/workflows/*.yml` and fails when a workflow adds one this list
 * does not name.
 */
export const EVENT_SCOPED_STATION_VARIABLES = Object.freeze([
  'STATION_CI_FAST_BASE',
  'STATION_RELEASE_CREATED_AT',
  'STATION_RELEASE_SHA',
  'STATION_REQUIRED_SOURCE_SHA',
  'STATION_REVIEW_BASE',
  'STATION_UI_BUNDLE_DELTA_BASE',
]);

const KEPT_GITHUB_VARIABLES = new Set(['GITHUB_ACTIONS']);
const STATION_SET = new Set(EVENT_SCOPED_STATION_VARIABLES);

/** Whether `name` carries event-specific context a test must not inherit. */
export function isEventScopedVariable(name) {
  return (
    (name.startsWith('GITHUB_') && !KEPT_GITHUB_VARIABLES.has(name)) ||
    STATION_SET.has(name)
  );
}

/**
 * Delete every event-scoped variable from `env` in place.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]} the names removed, sorted
 */
export function scrubEventScopedEnvironment(env = process.env) {
  const removed = Object.keys(env).filter(isEventScopedVariable).sort();
  for (const name of removed) delete env[name];
  return removed;
}

const JOB_EVENT_ENVIRONMENT = Symbol.for('station.ci.jobEventEnvironment');

/**
 * Keep the job's event-scoped variables, frozen, before the scrub removes
 * them, for the few tests that deliberately check the real repository in the
 * job's own mode: the real-ledger documentation freshness checks are the only
 * CI enforcement of freshness, so they must see `pull_request_target` as a
 * pull request, not as an unknown Actions event (advisory). Held on the
 * process object, not in the environment, so no child process inherits it,
 * and captured once, because a pooled worker reruns the setup file for every
 * test file after the first scrub.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function preserveJobEventEnvironment(env = process.env) {
  if (process[JOB_EVENT_ENVIRONMENT]) return process[JOB_EVENT_ENVIRONMENT];
  process[JOB_EVENT_ENVIRONMENT] = Object.freeze(
    Object.fromEntries(
      Object.entries(env).filter(([name]) => isEventScopedVariable(name)),
    ),
  );
  return process[JOB_EVENT_ENVIRONMENT];
}

/** The variables `preserveJobEventEnvironment` kept, or none. */
export function jobEventEnvironment() {
  return process[JOB_EVENT_ENVIRONMENT] ?? Object.freeze({});
}
