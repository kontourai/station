import { createHash } from 'node:crypto';
import {
  agentWire,
  currentAgentTurn,
  readAgentWire,
} from '@kontourai/agent-runtime';
import type { IStreamResult } from '../types.js';
import { stationAgentRuntimeOwner } from './durable-agent-owner.js';

interface Registration {
  readonly home: string;
  readonly slug: string;
  readonly definition: string;
  readonly memory?: object;
}
const registrations = new WeakMap<object, Registration>();
export function durableAgentDefinition(value: unknown): string {
  return createHash('sha256').update(agentWire(value)).digest('hex');
}

/** Preserve the actual framework instance and its method surface. */
export function bindDurableAgent<T extends object>(
  agent: T,
  options: Registration,
): T {
  if (registrations.has(agent)) return agent;
  const stream = Reflect.get(agent, 'streamText', agent);
  if (typeof stream !== 'function')
    throw new Error('Durable agent has no stream entry');
  registrations.set(agent, options);
  const owner = stationAgentRuntimeOwner(options.home);
  const original = (
    input: string,
    invokeOptions?: Record<string, unknown>,
  ): Promise<IStreamResult> =>
    Reflect.apply(stream, agent, [input, invokeOptions]);
  const invoke = (input: string, invokeOptions?: Record<string, unknown>) => {
    const current = currentAgentTurn();
    const captured = current && readAgentWire(current.input);
    if (
      current &&
      captured &&
      typeof captured === 'object' &&
      'slug' in captured &&
      captured.slug === options.slug &&
      'definition' in captured &&
      captured.definition === options.definition &&
      invokeOptions?.conversationId === current.key.conversationId
    )
      return original(input, {
        ...invokeOptions,
        abortSignal: current.signal,
        signal: current.signal,
      });
    return owner.foreground({
      agent,
      slug: options.slug,
      definition: options.definition,
      input,
      options: invokeOptions ?? {},
      invoke: (lease) =>
        original(
          input,
          lease
            ? {
                ...invokeOptions,
                abortSignal: lease.signal,
                signal: lease.signal,
              }
            : invokeOptions,
        ),
    });
  };
  Reflect.set(agent, 'streamText', invoke, agent);
  owner.registerAgent(
    options.slug,
    options.definition,
    async (input, invokeOptions) => original(input, invokeOptions),
    options.memory,
  );
  return agent;
}
