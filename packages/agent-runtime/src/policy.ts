import { canonical } from './encoding.js';
export interface ModelPolicy {
  readonly writerFormat: 'runtime-model/1';
  readonly maxOpenRuns: number;
  readonly maxCallsPerRun: number;
  readonly maxBlobBytes: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly maxPartialBytesPerAttempt: number;
  readonly settledRetentionMs: number;
  readonly tombstoneRetentionMs: number;
}
export const DEFAULT_MODEL_POLICY: ModelPolicy = Object.freeze({
  writerFormat: 'runtime-model/1',
  maxOpenRuns: 128,
  maxCallsPerRun: 1024,
  maxBlobBytes: 32 * 1024 * 1024,
  maxRequestBytes: 32 * 1024 * 1024,
  maxResponseBytes: 32 * 1024 * 1024,
  maxPartialBytesPerAttempt: 16 * 1024 * 1024,
  settledRetentionMs: 7 * 86400000,
  tombstoneRetentionMs: 30 * 86400000,
});
export function fixedPolicy(value: ModelPolicy): ModelPolicy {
  canonical(value);
  if (
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !==
      Object.keys(DEFAULT_MODEL_POLICY).length ||
    value.writerFormat !== 'runtime-model/1'
  )
    throw new Error('Unsupported runtime policy');
  for (const key of Object.keys(
    DEFAULT_MODEL_POLICY,
  ) as (keyof ModelPolicy)[]) {
    if (!Object.hasOwn(value, key)) throw new Error('Inherited runtime policy');
    if (
      key !== 'writerFormat' &&
      (!Number.isSafeInteger(value[key]) ||
        value[key] < 1 ||
        value[key] > DEFAULT_MODEL_POLICY[key])
    )
      throw new Error(`Unsupported runtime bound: ${key}`);
  }
  if (value.settledRetentionMs > value.tombstoneRetentionMs)
    throw new Error('Invalid runtime retention');
  return Object.freeze({ ...value });
}
