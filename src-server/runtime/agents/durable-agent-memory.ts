import { createHash } from 'node:crypto';
import {
  type AgentTurnLease,
  currentAgentTurn,
} from '@kontourai/agent-runtime';

const authored = new WeakMap<
  AgentTurnLease,
  {
    id: string;
    text: string;
    userId: string;
    conversationId: string;
    modelInputs: Set<string>;
  }
>();
export function noteDurableModelInput(lease: AgentTurnLease, input: string) {
  authored.get(lease)?.modelInputs.add(input);
}
export async function persistDurableAuthoredMessage(
  lease: AgentTurnLease,
  storage: object,
  text: string,
  userId: string,
): Promise<void> {
  const read = Reflect.get(storage, 'getConversation');
  const write = Reflect.get(storage, 'addMessage');
  if (typeof read !== 'function' || typeof write !== 'function')
    throw new Error('The durable conversation store is unavailable.');
  const conversation = await Reflect.apply(read, storage, [
    lease.key.conversationId,
  ]);
  if (
    !conversation ||
    typeof conversation !== 'object' ||
    !('userId' in conversation) ||
    conversation.userId !== userId
  )
    throw new Error('The durable conversation owner changed.');
  const id = await lease.entry(
    'authored-message-id',
    `agent-runtime-user:${createHash('sha256').update(JSON.stringify(lease.key)).digest('hex')}`,
  );
  if (typeof id !== 'string')
    throw new Error('The durable authored message is damaged.');
  authored.set(lease, {
    id,
    text,
    userId,
    conversationId: lease.key.conversationId,
    modelInputs: new Set([text]),
  });
  await Reflect.apply(write, storage, [
    { id, role: 'user', parts: [{ type: 'text', text }] },
    userId,
    lease.key.conversationId,
  ]);
}

interface PendingWrite {
  readonly sequence: number;
  readonly apply: () => Promise<unknown>;
}
const writes = new WeakMap<
  AgentTurnLease,
  {
    readonly ids: Map<string, Promise<string>>;
    readonly pending: Map<string, PendingWrite>;
    sequence: number;
    nextIdentity: number;
  }
>();
function state(lease: AgentTurnLease) {
  let value = writes.get(lease);
  if (!value) {
    value = {
      ids: new Map(),
      pending: new Map(),
      sequence: 0,
      nextIdentity: 0,
    };
    writes.set(lease, value);
  }
  return value;
}

/** Stage framework memory writes until its owned invocation has a known result. */
export function durableAgentMemory<T extends object>(storage: T): T {
  const stage = async (
    original: (...args: unknown[]) => unknown,
    args: unknown[],
  ) => {
    const lease = currentAgentTurn();
    if (!lease) return Reflect.apply(original, storage, args);
    const message = args[0];
    if (
      !message ||
      typeof message !== 'object' ||
      !('id' in message) ||
      typeof message.id !== 'string'
    )
      throw new Error('Durable memory requires a message identity');
    const current = state(lease);
    const input = authored.get(lease);
    if (!input || args[1] !== input.userId || args[2] !== input.conversationId)
      throw new Error('The durable memory write is outside its conversation.');
    const parts =
      'parts' in message && Array.isArray(message.parts) ? message.parts : [];
    const userText =
      'role' in message &&
      message.role === 'user' &&
      parts.length > 0 &&
      parts.every(
        (part) => part?.type === 'text' && typeof part.text === 'string',
      )
        ? parts.map((part) => part.text).join('')
        : undefined;
    const isAuthored =
      userText !== undefined && input.modelInputs.has(userText);
    const sequence = ++current.sequence;
    let identity = current.ids.get(message.id);
    if (!identity) {
      const ordinal = current.nextIdentity;
      if (!isAuthored) current.nextIdentity++;
      identity = isAuthored
        ? Promise.resolve(input.id)
        : lease.entry(`memory-id:${ordinal}`, message.id).then((id) => {
            if (typeof id !== 'string')
              throw new Error('Durable memory identity is damaged');
            return id;
          });
      current.ids.set(message.id, identity);
    }
    const id = await identity;
    const captured = [
      structuredClone({
        ...message,
        id,
        ...(isAuthored ? { parts: [{ type: 'text', text: input.text }] } : {}),
      }),
      ...args.slice(1),
    ];
    const previous = current.pending.get(id);
    if (!previous || previous.sequence <= sequence)
      current.pending.set(id, {
        sequence,
        apply: async () => Reflect.apply(original, storage, captured),
      });
  };
  return new Proxy(storage, {
    get(target, property) {
      const original = Reflect.get(target, property, target);
      if (
        (property !== 'addMessage' && property !== 'addMessages') ||
        typeof original !== 'function'
      )
        return typeof original === 'function'
          ? original.bind(target)
          : original;
      return async (...args: unknown[]) => {
        const lease = currentAgentTurn();
        if (!lease) return Reflect.apply(original, target, args);
        if (property === 'addMessage')
          return stage(
            (...values) => Reflect.apply(original, target, values),
            args,
          );
        if (!Array.isArray(args[0]))
          throw new Error('Durable memory batch is damaged');
        const single = Reflect.get(target, 'addMessage', target);
        if (typeof single !== 'function')
          throw new Error(
            'Durable memory requires an identified message writer',
          );
        for (const message of args[0])
          await stage(
            (...values) => Reflect.apply(single, target, values),
            [message, ...args.slice(1)],
          );
      };
    },
  });
}

export async function flushDurableAgentMemory(
  lease: AgentTurnLease,
): Promise<void> {
  const current = writes.get(lease);
  if (!current) return;
  for (const write of [...current.pending.values()].sort(
    (a, b) => a.sequence - b.sequence,
  )) {
    await lease.assertCurrent();
    await write.apply();
  }
  writes.delete(lease);
}
