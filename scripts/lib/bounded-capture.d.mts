// Declarations for bounded-capture.mjs, mirroring its JSDoc, for TypeScript
// projects that do not type-check JavaScript.
import type {
  ExecFileSyncOptions,
  SpawnSyncOptions,
  SpawnSyncReturns,
} from 'node:child_process';

/** Test seam replacing the underlying child-process call. */
type CaptureSeam = { run?: (...args: never[]) => unknown };

export declare const CAPTURE_MAX_BYTES: number;

export declare class CaptureOverflowError extends Error {
  constructor(
    command: string,
    args: readonly string[],
    maxBuffer: number,
    cause?: unknown,
  );
  readonly code: 'ENOBUFS';
  readonly maxBuffer: number;
}

export declare function spawnSyncBounded<O extends SpawnSyncOptions>(
  command: string,
  args?: readonly string[],
  options?: O,
  seam?: CaptureSeam,
): SpawnSyncReturns<O extends { encoding: BufferEncoding } ? string : Buffer>;

export declare function execFileSyncBounded<O extends ExecFileSyncOptions>(
  command: string,
  args?: readonly string[],
  options?: O,
  seam?: CaptureSeam,
): O extends { encoding: BufferEncoding } ? string : Buffer;
