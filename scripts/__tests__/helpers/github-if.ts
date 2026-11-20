type Need = { result: string; outputs?: Record<string, string> };

/** Every string in `value`, lowercased: GitHub compares strings case-insensitively. */
function lowerStrings<T>(value: T): T {
  if (typeof value === 'string') return value.toLowerCase() as T;
  if (Array.isArray(value)) return value.map(lowerStrings) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, lowerStrings(entry)]),
    ) as T;
  return value;
}

/**
 * A GitHub `if:` as the runner evaluates it, for the workflow tests that
 * drive parsed job graphs. An expression that calls none of always(),
 * success(), failure() or cancelled() is implicitly ANDed with success().
 * Without that, a guard that lost its always() reads as if it still had one.
 *
 * Modelled as GitHub documents it:
 * - `==`/`!=` on strings ignore case (literals and context values are both
 *   lowercased; nothing here compares anything but strings).
 * - For a job, success() is true when every ancestor job (pass `ancestors`;
 *   the direct `needs` otherwise) succeeded and the run is not cancelled; a
 *   skipped or cancelled ancestor is not success. failure() is true when any
 *   ancestor's result is `failure`; a skipped one is not a failure. For a
 *   step, `priorSuccess` says whether every earlier step succeeded.
 *
 * Not modelled: expression functions (contains, startsWith, format,
 * fromJSON, hashFiles, …), GitHub's loose type coercion between numbers,
 * booleans, null and strings, `!` applied to a string, and any context other
 * than needs, steps, inputs and a fixed `github` (main, schedule, the event
 * SHA). An expression using them throws or evaluates as JavaScript would.
 */
export function evaluateIf(
  condition: string,
  {
    needs = {},
    ancestors,
    steps = {},
    priorSuccess,
    cancelled = false,
    inputs = { source_sha: 'a'.repeat(40), build: 'true' },
  }: {
    needs?: Record<string, Need>;
    /** Every ancestor job's result; defaults to the direct `needs`. */
    ancestors?: Record<string, Need>;
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
    .replace(/\s*\}\}$/, '')
    .replace(/'((?:[^']|'')*)'/g, (literal) => literal.toLowerCase());
  const prior = Object.values(ancestors ?? needs);
  const succeeded =
    priorSuccess ?? prior.every((need) => need.result === 'success');
  const failed =
    priorSuccess === undefined
      ? prior.some((need) => need.result === 'failure')
      : !priorSuccess;
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
      lowerStrings(needs),
      lowerStrings(steps),
      lowerStrings(inputs),
      { ref: 'refs/heads/main', sha: 'a'.repeat(40), event_name: 'schedule' },
      () => true,
      () => succeeded && !cancelled,
      () => failed,
      () => cancelled,
    ),
  );
  return /\b(?:always|success|failure|cancelled)\(\)/.test(inner)
    ? value
    : value && succeeded && !cancelled;
}
