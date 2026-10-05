import { execFileSync, spawnSync } from 'node:child_process';
import { basename } from 'node:path';

/**
 * Synchronous child-process capture with an explicit bound (#2787).
 *
 * `spawnSync` and `execFileSync` buffer the child's whole output and default
 * `maxBuffer` to 1 MiB. Output that scales with the repository (`git
 * ls-files`, `tsc --listFiles`, a diff, a test listing) grows towards that
 * default with every file added and with the length of the checkout path, and
 * crossing it kills the child with a bare `spawnSync <command> ENOBUFS`.
 *
 * The bound here is generous rather than absent: a runaway child must still be
 * refused, and the refusal names the command, the bound and the remedy. The
 * partial output Node hands back on overflow is never returned as a result.
 */
export const CAPTURE_MAX_BYTES = 64 * 1024 * 1024;

const DESCRIBED_ARGS = 6;

function describeCommand(command, args) {
  const shown = (args ?? []).slice(0, DESCRIBED_ARGS).map(String);
  const more = (args ?? []).length > shown.length ? ' …' : '';
  return [basename(String(command)), ...shown].join(' ') + more;
}

export class CaptureOverflowError extends Error {
  constructor(command, args, maxBuffer, cause) {
    super(
      `${describeCommand(command, args)} wrote more than ${maxBuffer} bytes to stdout or stderr, ` +
        'the capture bound for this call (ENOBUFS). The child was killed and its partial output discarded. ' +
        'Raise maxBuffer at the call site or stream the output; see scripts/lib/bounded-capture.mjs.',
      { cause },
    );
    this.name = 'CaptureOverflowError';
    this.code = 'ENOBUFS';
    this.maxBuffer = maxBuffer;
  }
}

function boundedOptions(options) {
  return {
    windowsHide: true,
    ...options,
    // `??`, after the spread, on purpose: Node treats an explicit
    // `maxBuffer: undefined` as unbounded, not as its 1 MiB default. A
    // `{ maxBuffer: CAPTURE_MAX_BYTES, ...options }` refactor would let a
    // caller's `undefined` silently remove the bound.
    maxBuffer: options?.maxBuffer ?? CAPTURE_MAX_BYTES,
  };
}

/**
 * `spawnSync` with the capture bound. On overflow `result.error` is a
 * {@link CaptureOverflowError} and `stdout`/`stderr` are emptied, so a caller
 * that forgets to check `error` cannot parse a truncated listing as complete.
 *
 * @template {import('node:child_process').SpawnSyncOptions} O
 * @param {string} command
 * @param {readonly string[]} [args]
 * @param {O} [options]
 * @param {{ run?: Function }} [seam] test seam for the underlying spawn
 * @returns {import('node:child_process').SpawnSyncReturns<O extends { encoding: BufferEncoding } ? string : Buffer>}
 */
export function spawnSyncBounded(
  command,
  args = [],
  options = /** @type {O} */ ({}),
  { run = spawnSync } = {},
) {
  const bounded = boundedOptions(options);
  const result = run(command, args, bounded);
  if (result?.error?.code !== 'ENOBUFS') return result;
  const empty =
    bounded.encoding && bounded.encoding !== 'buffer' ? '' : Buffer.alloc(0);
  return {
    ...result,
    stdout: empty,
    stderr: empty,
    output: [null, empty, empty],
    error: new CaptureOverflowError(
      command,
      args,
      bounded.maxBuffer,
      result.error,
    ),
  };
}

/**
 * `execFileSync` with the capture bound. Overflow throws a
 * {@link CaptureOverflowError}; every other failure is rethrown untouched.
 *
 * @template {import('node:child_process').ExecFileSyncOptions} O
 * @param {string} command
 * @param {readonly string[]} [args]
 * @param {O} [options]
 * @param {{ run?: Function }} [seam] test seam for the underlying exec
 * @returns {O extends { encoding: BufferEncoding } ? string : Buffer}
 */
export function execFileSyncBounded(
  command,
  args = [],
  options = /** @type {O} */ ({}),
  { run = execFileSync } = {},
) {
  const bounded = boundedOptions(options);
  try {
    return run(command, args, bounded);
  } catch (error) {
    if (error?.code !== 'ENOBUFS') throw error;
    throw new CaptureOverflowError(command, args, bounded.maxBuffer, error);
  }
}
