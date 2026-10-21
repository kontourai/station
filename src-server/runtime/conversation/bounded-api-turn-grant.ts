import { AsyncLocalStorage } from 'node:async_hooks';

// This companion only restricts execution. It cannot grant a paid request.
const boundedApiTurnBrand = Symbol('bounded API required turn');
export type BoundedApiTurnCompanion = Readonly<{
  [boundedApiTurnBrand]: true;
}>;

const requiredTurns = new AsyncLocalStorage<BoundedApiTurnCompanion>();

export class BoundedApiExecutionUnavailableError extends Error {
  readonly code = 'bounded_api_execution_unavailable';

  constructor(readonly surface: string) {
    super(
      `Bounded API execution is unavailable at ${surface}: published durable physical-attempt authority and qualified provider count, cap, tariff, and complete usage contracts are required.`,
    );
    this.name = 'BoundedApiExecutionUnavailableError';
  }
}

/** Enter only after reading the durable group binding; identity alone is insufficient. */
export function runWithRequiredBoundedApiTurn<T>(work: () => T): T {
  // A fresh opaque identity prevents request data from impersonating a companion.
  return requiredTurns.run(
    Object.freeze({ [boundedApiTurnBrand]: true as const }),
    work,
  );
}

export function currentBoundedApiTurnCompanion():
  | BoundedApiTurnCompanion
  | undefined {
  return requiredTurns.getStore();
}

export function assertBoundedApiExecutionAvailable(
  surface: string,
  captured?: BoundedApiTurnCompanion,
): void {
  if (captured || currentBoundedApiTurnCompanion()) {
    throw new BoundedApiExecutionUnavailableError(surface);
  }
}
