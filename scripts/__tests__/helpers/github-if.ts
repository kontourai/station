/**
 * A GitHub `if:` as the runner evaluates it, for the workflow tests that
 * drive parsed job graphs. An expression that calls none
 * of always(), success(), failure() or cancelled() is implicitly ANDed with
 * success(): every need (a job) or every earlier step (a step) succeeded and
 * the run is not cancelled. Without that, a guard that lost its always()
 * reads as if it still had one.
 */
export function evaluateIf(
  condition: string,
  {
    needs = {},
    steps = {},
    priorSuccess,
    cancelled = false,
    inputs = { source_sha: 'a'.repeat(40), build: 'true' },
  }: {
    needs?: Record<
      string,
      { result: string; outputs?: Record<string, string> }
    >;
    steps?: Record<string, { outputs?: Record<string, string> }>;
    priorSuccess?: boolean;
    cancelled?: boolean;
    /** A reusable workflow's `inputs`; by default the source is the event SHA. */
    inputs?: Record<string, string>;
  },
): boolean {
  const inner = condition
    .trim()
    .replace(/^\$\{\{\s*/, '')
    .replace(/\s*\}\}$/, '');
  const succeeded =
    priorSuccess ??
    Object.values(needs).every((need) => need.result === 'success');
  const value = Boolean(
    Function(
      'needs',
      'steps',
      'inputs',
      'github',
      'always',
      'success',
      'failure',
      'cancelled',
      `return (${inner.replace(/needs\.([\w-]+)/g, 'needs["$1"]').replace(/steps\.([\w-]+)/g, 'steps["$1"]')})`,
    )(
      needs,
      steps,
      inputs,
      { ref: 'refs/heads/main', sha: 'a'.repeat(40), event_name: 'schedule' },
      () => true,
      () => succeeded && !cancelled,
      () => !succeeded,
      () => cancelled,
    ),
  );
  return /\b(?:always|success|failure|cancelled)\(\)/.test(inner)
    ? value
    : value && succeeded && !cancelled;
}
