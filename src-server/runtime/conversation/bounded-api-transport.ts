import {
  assertBoundedApiExecutionAvailable,
  currentBoundedApiTurnCompanion,
} from './bounded-api-turn-grant.js';

/** Must be the last wrapper after body defaults and any SDK authentication awaits. */
export function boundedApiTransport(): typeof fetch {
  const captured = currentBoundedApiTurnCompanion();
  return (input, init) => {
    assertBoundedApiExecutionAvailable('provider fetch', captured);
    return fetch(input, init);
  };
}
