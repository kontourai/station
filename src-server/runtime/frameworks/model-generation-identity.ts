import { createHash } from 'node:crypto';
import { currentAuthorizedTurnCorrelation } from '../conversation/authorized-turn-correlation.js';
import type { InvocationContext } from '../types.js';

interface Binding {
  connectionId: string;
  modelId: string;
  providerType: string;
  configurationDigest?: string;
}
export const modelConnectionConfigurationDigest = (connection: object) =>
  createHash('sha256').update(JSON.stringify(connection)).digest('hex');
interface RawIdentity {
  id?: string;
  modelId?: string;
}
const bindings = new WeakMap<
  object,
  { binding: Binding; calls: Map<string, RawIdentity> }
>();
const coordinate = (account: string, session: string, turn: string) =>
  JSON.stringify([account, session, turn]);
const text = (value: unknown) =>
  typeof value === 'string' && value.length > 0 && value.length <= 512
    ? value
    : undefined;

/** Preserve raw provider-adapter response identity before AI SDK can fill model/id defaults. */
export function observeDirectModelIdentity<T extends object>(
  model: T,
  binding: Binding,
): T {
  const calls = new Map<string, RawIdentity>();
  const begin = () => {
    const current = currentAuthorizedTurnCorrelation();
    if (!current) return undefined;
    const key = coordinate(
        current.accountId,
        current.sessionId,
        current.turnId,
      ),
      identity: RawIdentity = {};
    calls.delete(key);
    calls.set(key, identity);
    if (calls.size > 128) calls.delete(calls.keys().next().value!);
    return { key, identity };
  };
  const record = (call: ReturnType<typeof begin>, value: unknown) => {
    if (
      !call ||
      calls.get(call.key) !== call.identity ||
      !value ||
      typeof value !== 'object'
    )
      return;
    const response = value as { id?: unknown; modelId?: unknown };
    call.identity.id = text(response.id);
    call.identity.modelId = text(response.modelId);
  };
  const proxy = new Proxy(model, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === 'doGenerate' && typeof value === 'function')
        return async (...args: unknown[]) => {
          const call = begin();
          const result = await value.apply(target, args);
          record(call, result.response);
          return result;
        };
      if (key === 'doStream' && typeof value === 'function')
        return async (...args: unknown[]) => {
          const call = begin(),
            result = await value.apply(target, args);
          if (!result.stream?.pipeThrough) return result;
          return {
            ...result,
            stream: result.stream.pipeThrough(
              new TransformStream({
                transform(chunk, controller) {
                  if (chunk?.type === 'response-metadata') record(call, chunk);
                  controller.enqueue(chunk);
                },
              }),
            ),
          };
        };
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  bindings.set(proxy, { binding, calls });
  return proxy;
}
export function modelGenerationIdentity(
  model: unknown,
  invocation: InvocationContext,
  response: unknown,
): {
  modelIdentitySource: 'provider-response' | 'runtime-model';
  connectionId?: string;
  connectionConfigurationDigest?: string;
} {
  const unknown = { modelIdentitySource: 'runtime-model' as const };
  if (
    !model ||
    typeof model !== 'object' ||
    !invocation.principalId ||
    !invocation.sessionId ||
    !invocation.turnId ||
    !response ||
    typeof response !== 'object'
  )
    return unknown;
  const observed = bindings.get(model);
  if (!observed || observed.binding.providerType === 'bedrock') return unknown;
  const raw = observed.calls.get(
    coordinate(invocation.principalId, invocation.sessionId, invocation.turnId),
  );
  const completed = response as { id?: unknown; modelId?: unknown };
  if (
    !raw?.id ||
    !raw.modelId ||
    raw.id !== completed.id ||
    raw.modelId !== completed.modelId
  )
    return unknown;
  return {
    modelIdentitySource: 'provider-response',
    ...(observed.binding.modelId === raw.modelId &&
    observed.binding.configurationDigest
      ? {
          connectionId: observed.binding.connectionId,
          connectionConfigurationDigest: observed.binding.configurationDigest,
        }
      : {}),
  };
}
