/**
 * The line `ci:fast` prints before each step it runs, and the one place its
 * shape is spelled (#2922 review).
 *
 * The verification reporter names a failing step from the LAST step boundary
 * in the capture. npm prints `> pkg@ver script` before an `npm run` step, but
 * a direct `node scripts/...` step prints nothing, so a failing
 * `code-health-gate.mjs` was reported as the npm step before it
 * (`lockfile-sync:gate`). `run-ci-fast.mjs` now marks every step, and
 * `verification-reporter.mjs` reads the marker as a boundary. An npm step's
 * own header still follows its marker and names the same script.
 */
export const CI_FAST_STEP_MARKER_PATTERN = /^\[ci:fast\] step (\S+)$/;

/** `npm run x` -> `x`; `node scripts/x.mjs --flag` -> `scripts/x.mjs`. */
function ciFastStepId(command, args) {
  if (command === 'npm' && args[0] === 'run' && args[1]) return args[1];
  return args.find((arg) => /\.[cm]?[jt]s$/.test(arg)) ?? command;
}

export function ciFastStepMarker(command, args) {
  return `[ci:fast] step ${ciFastStepId(command, args)}\n`;
}
