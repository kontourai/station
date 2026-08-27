import type {
  NativeInvocationKind,
  NativeInvocationStarter,
} from '../../services/orchestration/native-invocation-runs.js';

/** A provider call may have started; clients must observe `runId`, not retry. */
export class NativeInvocationIndeterminateError extends Error {
  readonly code = 'native_invocation_indeterminate';
  readonly outcome = 'indeterminate';

  constructor(readonly runId: string) {
    super(
      'The provider invocation may have started. Observe the run before retrying.',
    );
    this.name = 'NativeInvocationIndeterminateError';
  }
}

/**
 * A multi-stage invoke completed its primary provider effect but cannot
 * truthfully report a complete structured result. The primary run remains
 * observable; a second run exists only when its provider boundary was crossed.
 */
export class NativeInvocationPartialError extends Error {
  readonly code = 'native_invocation_partial';
  readonly outcome = 'indeterminate';

  constructor(
    readonly runId: string,
    readonly relatedRunIds: string[],
    readonly structureOutcome: 'not_started' | 'indeterminate',
  ) {
    super(
      'The primary invocation completed, but structured formatting did not complete. Observe the run before retrying.',
    );
    this.name = 'NativeInvocationPartialError';
  }
}

/** No provider call began because Station could not reserve its durable run. */
export class NativeInvocationStorageUnavailableError extends Error {
  readonly code = 'native_invocation_storage_unavailable';

  constructor() {
    super('The invocation record is temporarily unavailable.');
    this.name = 'NativeInvocationStorageUnavailableError';
  }
}

/**
 * Establishes the durable invocation boundary immediately before the provider
 * call. A returned value is not reported as success until its terminal run is
 * durably recorded (or read back as the same fact).
 */
export async function executeNativeInvocation<T>(
  runs: NativeInvocationStarter,
  input: { kind: NativeInvocationKind; sourceId?: string },
  operation: () => Promise<T>,
): Promise<{ value: T; runId: string }> {
  const begun = runs.begin({ ...input, now: new Date().toISOString() });
  if (begun.kind !== 'owner')
    throw new NativeInvocationStorageUnavailableError();

  const invocation = begun.claim.beginInvocation(new Date().toISOString());
  if (invocation.kind !== 'applied') {
    throw new NativeInvocationStorageUnavailableError();
  }

  try {
    const value = await operation();
    const completed = begun.claim.completed(new Date().toISOString());
    if (completed.kind !== 'applied') {
      throw new NativeInvocationIndeterminateError(begun.runId);
    }
    return { value, runId: begun.runId };
  } catch (error) {
    if (error instanceof NativeInvocationIndeterminateError) throw error;
    // The external call boundary has already been crossed. Even a local
    // validation error after a provider return cannot prove no effect.
    begun.claim.indeterminate(
      new Date().toISOString(),
      'The provider invocation did not return a durable terminal result.',
    );
    throw new NativeInvocationIndeterminateError(begun.runId);
  }
}
