/** The immutable history tip a verification request's corpus must inspect. */
export const STATION_VERIFICATION_HISTORY_REF =
  'STATION_VERIFICATION_HISTORY_REF';

const COMMIT_SHA = /^[0-9a-f]{40}$/;

function exactCommitSha(value, source) {
  if (typeof value !== 'string' || !COMMIT_SHA.test(value)) {
    throw new Error(
      `${source} must be an exact lowercase 40-character hexadecimal commit SHA`,
    );
  }
  return value;
}

/**
 * Binds child-process environment to the request's immutable history tip.
 * The request is the producer authority, so it always overwrites inheritance.
 */
export function bindVerificationRequestEnvironment(env = {}, request) {
  if (!env || typeof env !== 'object')
    throw new Error('verification execution environment must be an object');
  return {
    ...env,
    [STATION_VERIFICATION_HISTORY_REF]: exactCommitSha(
      request?.headSha,
      'verification request headSha',
    ),
  };
}

/**
 * Resolves the history corpus tip for consumers outside a request, retaining
 * `origin/main` only as the deliberate local/default behavior.
 */
export function resolveVerificationHistoryRef(env = process.env) {
  if (!env || typeof env !== 'object')
    throw new Error('verification execution environment must be an object');
  const value = env[STATION_VERIFICATION_HISTORY_REF];
  return value === undefined
    ? 'origin/main'
    : exactCommitSha(value, STATION_VERIFICATION_HISTORY_REF);
}
