import { AsyncLocalStorage } from 'node:async_hooks';
import {
  assertBoundedApiExecutionAvailable,
  currentBoundedApiTurnCompanion,
} from './bounded-api-turn-grant.js';

const invocationCancellation = new AsyncLocalStorage<AbortSignal>();

/** Local invocation cancellation only; this context grants no model or budget authority. */
export function runWithModelInvocationCancellation<T>(
  signal: AbortSignal,
  work: () => T,
): T {
  return invocationCancellation.run(signal, work);
}

export function currentModelInvocationCancellation(): AbortSignal | undefined {
  return invocationCancellation.getStore();
}

const EFFECT_METHODS = new Set([
  'invoke',
  'doGenerate',
  'doStream',
  'generateText',
  'streamText',
  'generateObject',
  'streamObject',
  'stream',
]);

/** Guards cached models and raw framework agents at invocation, including lazy streams. */
export function guardBoundedApiModel<T extends object>(model: T): T {
  const captured = currentBoundedApiTurnCompanion();
  return new Proxy(model, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (typeof key !== 'string' || !EFFECT_METHODS.has(key)) {
        return value.bind(target);
      }
      return (...args: unknown[]) => {
        currentModelInvocationCancellation()?.throwIfAborted();
        assertBoundedApiExecutionAvailable(`model.${key}`, captured);
        if (key === 'stream') {
          return (async function* () {
            currentModelInvocationCancellation()?.throwIfAborted();
            assertBoundedApiExecutionAvailable(
              'model.stream iteration',
              captured,
            );
            yield* Reflect.apply(value, target, args);
          })();
        }
        return Reflect.apply(value, target, args);
      };
    },
  });
}
