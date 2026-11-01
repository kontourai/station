import {
  agentWire,
  currentAgentTurn,
  nextProviderCallId,
  readAgentWire,
  runWithProviderParent,
} from '@kontourai/agent-runtime';
import {
  isModelStreamEvent,
  type Model,
  type ModelStreamEvent,
} from '@strands-agents/sdk';

function retainedEvents(value: unknown): ModelStreamEvent[] {
  if (!Array.isArray(value))
    throw new Error('Durable Strands model tape is damaged');
  return value.map((item) => {
    if (
      !item ||
      typeof item !== 'object' ||
      !('type' in item) ||
      typeof item.type !== 'string' ||
      !isModelStreamEvent(item)
    )
      throw new Error('Durable Strands model event is damaged');
    return item;
  });
}
function eventData(event: ModelStreamEvent): ModelStreamEvent {
  const fields = Object.getOwnPropertyDescriptors(event);
  if (
    Object.values(fields).some(
      (field) => !field.enumerable || !('value' in field),
    )
  )
    throw new Error('Durable Strands model event is unsupported');
  const data = {
    ...Object.fromEntries(
      Object.entries(fields).map(([key, field]) => [key, field.value]),
    ),
    type: event.type,
  };
  if (!isModelStreamEvent(data))
    throw new Error('Durable Strands model event is unsupported');
  return data;
}

/** The public Model.stream seam covers Bedrock and Vercel without replacing the loop. */
export function durableStrandsModel<T extends Model>(
  model: T,
  binding: string,
  configuration: {
    readonly layer?: 'provider';
    readonly dispatch?: Model['stream'];
  } = {},
): T {
  const ordinals = new WeakMap<object, number>();
  const stream = model.stream.bind(model);
  return new Proxy(model, {
    get(target, property, receiver) {
      if (property !== 'stream') {
        const value = Reflect.get(target, property, target);
        return typeof value === 'function'
          ? value.bind(property === 'streamAggregated' ? receiver : target)
          : value;
      }
      return async function* (
        messages: Parameters<Model['stream']>[0],
        options?: Parameters<Model['stream']>[1],
      ): AsyncIterable<ModelStreamEvent> {
        const lease = currentAgentTurn();
        if (!lease) {
          yield* stream(messages, options);
          return;
        }
        const ordinal = ordinals.get(lease) ?? 0;
        ordinals.set(lease, ordinal + 1);
        const id =
          configuration.layer === 'provider'
            ? nextProviderCallId(lease)
            : `model:${ordinal}`;
        const {
          cancelSignal: _signal,
          modelState,
          ...inputOptions
        } = options ?? {};
        const planned = await lease.effect({
          type: 'effectPlan',
          intent: {
            id,
            kind: configuration.layer === 'provider' ? 'provider' : 'model',
            replay: 'unsafe',
            codec: 'strands-native/1',
            input: agentWire({
              binding,
              providerSessionId: lease.providerSessionId,
              messages: messages.map((message) => {
                // Strands mints tracing IDs while entering its loop; providers do not consume them.
                const { trackingId: _tracking, ...content } = message.toJSON();
                return content;
              }),
              options: inputOptions,
              modelState: modelState?.getAll() ?? {},
            }),
          },
        });
        if (planned.effect.state === 'completed') {
          const tape = readAgentWire(planned.effect.attempts.at(-1)!.output!);
          if (
            !tape ||
            typeof tape !== 'object' ||
            !('events' in tape) ||
            !('modelState' in tape) ||
            !tape.modelState ||
            typeof tape.modelState !== 'object' ||
            Array.isArray(tape.modelState)
          )
            throw new Error('Durable Strands model tape is damaged');
          if (modelState) {
            modelState.clear();
            for (const [key, value] of Object.entries(tape.modelState))
              modelState.set(key, value);
          }
          yield* retainedEvents(tape.events);
          return;
        }
        const begun = await lease.effect({ type: 'effectBegin', id });
        if (!begun.execute)
          throw new Error('DURABLE_AGENT_MODEL_INDETERMINATE');
        await lease.assertCurrent();
        const events: ModelStreamEvent[] = [];
        const held: ModelStreamEvent[] = [];
        let suffix = false;
        const source = (configuration.dispatch ?? stream)(messages, {
          ...options,
          cancelSignal: lease.signal,
        });
        const iterator = source[Symbol.asyncIterator]();
        let closed = false;
        try {
          for (;;) {
            const next = await (configuration.layer === 'provider'
              ? iterator.next()
              : runWithProviderParent(id, () => iterator.next()));
            if (next.done) {
              closed = true;
              break;
            }
            const event = eventData(next.value);
            events.push(event);
            if (
              (event.type === 'modelContentBlockStartEvent' &&
                event.start?.type === 'toolUseStart') ||
              event.type === 'modelMessageStopEvent' ||
              event.type === 'modelRedactionEvent'
            )
              suffix = true;
            if (suffix) held.push(event);
            else {
              await lease.effect({
                type: 'effectPartial',
                id,
                part: agentWire(event),
              });
              yield event;
            }
          }
        } finally {
          if (!closed) await iterator.return?.();
        }
        if (!events.some((event) => event.type === 'modelMessageStopEvent'))
          throw new Error('Durable Strands model stream did not complete');
        await lease.effect({
          type: 'effectComplete',
          id,
          output: agentWire({ events, modelState: modelState?.getAll() ?? {} }),
        });
        yield* held;
      };
    },
  });
}
