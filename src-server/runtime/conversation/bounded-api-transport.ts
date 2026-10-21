import { currentModelInvocationCancellation } from './bounded-api-model.js';
import {
  assertBoundedApiExecutionAvailable,
  currentBoundedApiTurnCompanion,
} from './bounded-api-turn-grant.js';

/** Must be the last wrapper after body defaults and any SDK authentication awaits. */
export function boundedApiTransport(): typeof fetch {
  const captured = currentBoundedApiTurnCompanion();
  return (input, init) => {
    assertBoundedApiExecutionAvailable('provider fetch', captured);
    const cancellation = currentModelInvocationCancellation();
    if (!cancellation) return fetch(input, init);
    const upstreamSignal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = upstreamSignal
      ? AbortSignal.any([upstreamSignal, cancellation])
      : cancellation;
    signal.throwIfAborted();
    return fetch(input, { ...init, signal });
  };
}
