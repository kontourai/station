import { createHash } from 'node:crypto';
import type { AgentFrame } from '@kontourai/agent-runtime';
import { z } from 'zod';

export class DurableForegroundChannel<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private wake: (() => void) | undefined;
  private space: (() => void) | undefined;
  private ended = false;
  private detached = false;
  private failure: { error: unknown } | undefined;
  get abandoned() {
    return this.detached;
  }
  async push(value: T): Promise<void> {
    while (this.values.length >= 256 && !this.detached)
      await new Promise<void>((resolve) => {
        this.space = resolve;
      });
    if (this.detached) return;
    this.values.push(value);
    this.wake?.();
    this.wake = undefined;
  }
  finish(error?: unknown): void {
    this.ended = true;
    if (error !== undefined) this.failure = { error };
    this.wake?.();
    this.wake = undefined;
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        while (!this.values.length && !this.ended && !this.detached)
          await new Promise<void>((resolve) => {
            this.wake = resolve;
          });
        if (this.values.length) {
          const value = this.values.shift()!;
          this.space?.();
          this.space = undefined;
          return { done: false, value };
        }
        if (this.failure) throw this.failure.error;
        return { done: true, value: undefined };
      },
      return: async () => {
        this.detached = true;
        this.values.length = 0;
        this.space?.();
        this.space = undefined;
        this.wake?.();
        this.wake = undefined;
        return { done: true, value: undefined };
      },
    };
  }
}

const markerSchema = z
  .object({
    version: z.literal(1),
    turnId: z.string().min(1).max(4096),
    id: z.string().min(1).max(4096),
    createdAt: z.iso.datetime(),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
export type DurableFrameMarker = z.infer<typeof markerSchema>;
export function encodeDurableAgentFrame(
  turnId: string,
  frame: AgentFrame,
): string {
  const marker: DurableFrameMarker = {
    version: 1,
    turnId,
    id: frame.id,
    createdAt: frame.createdAt,
    digest: frame.digest,
  };
  return `id: agent-runtime-v1:${Buffer.from(JSON.stringify(marker)).toString('base64url')}\n${frame.wire}`;
}
export function decodeDurableAgentFrame(
  line: string,
): DurableFrameMarker | undefined {
  const prefix = 'id: agent-runtime-v1:';
  if (!line.startsWith(prefix)) return undefined;
  try {
    const encoded = line.slice(prefix.length);
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) return undefined;
    return markerSchema.parse(JSON.parse(bytes.toString('utf8')));
  } catch {
    return undefined;
  }
}

const nativeTypes = new Set([
  'start',
  'start-step',
  'finish-step',
  'finish',
  'text-start',
  'text-delta',
  'text-end',
  'reasoning-start',
  'reasoning-delta',
  'reasoning-end',
  'tool-input-start',
  'tool-input-delta',
  'tool-input-end',
  'tool-input-available',
  'tool-call',
  'tool-result',
  'tool-output-available',
  'tool-error',
  'error',
]);
export function createDurableFrameKeys() {
  const counts = new Map<string, number>();
  return (wire: string) => {
    const encoded = wire.startsWith('data: ') ? wire.slice(6).trimEnd() : wire;
    let group = encoded;
    if (encoded === '[DONE]') group = 'done';
    else {
      const event = JSON.parse(encoded);
      if (
        event &&
        typeof event === 'object' &&
        typeof event.type === 'string' &&
        nativeTypes.has(event.type)
      )
        group = JSON.stringify([
          event.type,
          event.toolCallId ?? event.approvalId ?? '',
          event.status ?? event.outcome ?? '',
        ]);
    }
    const hash = createHash('sha256').update(group).digest('hex');
    const ordinal = counts.get(hash) ?? 0;
    counts.set(hash, ordinal + 1);
    return `${hash}:${ordinal}`;
  };
}

export interface DurableForegroundState {
  readonly invocationId: string;
  readonly completion: Promise<void>;
  readonly finished: () => boolean;
  readonly cancelled: () => boolean;
  readonly attachTransport: () => void;
  readonly allowSettlement: () => void;
  readonly frame: (id: string, wire: string) => Promise<AgentFrame>;
  readonly onDetach?: () => Promise<void>;
  readonly onWire?: (wire: string) => void | Promise<void>;
  readonly failed: (error: unknown) => void;
}
interface Transport {
  readonly matches: (
    conversation: string,
    state: DurableForegroundState,
  ) => boolean;
  readonly bind: (state: DurableForegroundState) => void;
}
const foregrounds = new WeakMap<object, Map<string, DurableForegroundState>>();
const transports = new WeakMap<object, Set<Transport>>();
const writerOwners = new WeakMap<
  object,
  { state: () => DurableForegroundState | undefined; dispose: () => void }
>();
export function registerDurableForeground(
  agent: object,
  conversationId: string,
  state: DurableForegroundState,
): void {
  let conversations = foregrounds.get(agent);
  if (!conversations) {
    conversations = new Map();
    foregrounds.set(agent, conversations);
  }
  if (conversations.has(conversationId))
    throw new Error('Durable foreground already owned');
  conversations.set(conversationId, state);
  for (const transport of transports.get(agent) ?? [])
    if (transport.matches(conversationId, state)) transport.bind(state);
  void state.completion.then(
    () => conversations.delete(conversationId),
    () => conversations.delete(conversationId),
  );
}

/** Bind delivery before invocation; disconnect transfers cleanup to the owner. */
export function prepareDurableForegroundHandoff(input: {
  agent: object;
  conversationId: () => string | undefined;
  invocationId: () => string | undefined;
  writer: { write(value: string | Uint8Array): Promise<unknown> };
  signal: AbortSignal;
  abort: () => void;
}): () => void {
  let bound: DurableForegroundState | undefined;
  let detached = false;
  let disposed = false;
  let detach!: () => void;
  const disconnected = new Promise<void>((resolve) => {
    detach = resolve;
  });
  const originalWrite = input.writer.write.bind(input.writer);
  const frameKey = createDurableFrameKeys();
  const bind = (state: DurableForegroundState) => {
    if (disposed) return;
    bound = state;
    state.attachTransport();
    transports.get(input.agent)?.delete(transport);
  };
  const transport: Transport = {
    matches: (conversation, state) =>
      conversation === input.conversationId() &&
      state.invocationId === input.invocationId(),
    bind,
  };
  let candidates = transports.get(input.agent);
  if (!candidates) {
    candidates = new Set();
    transports.set(input.agent, candidates);
  }
  candidates.add(transport);
  const find = () => {
    if (disposed) return undefined;
    if (bound) return bound;
    const conversation = input.conversationId();
    const state =
      conversation && foregrounds.get(input.agent)?.get(conversation);
    if (state && transport.matches(conversation!, state)) bind(state);
    return bound;
  };
  const disconnect = () => {
    const state = find();
    if (!state || state.cancelled()) {
      input.abort();
      return;
    }
    input.signal.removeEventListener('abort', disconnect);
    if (!detached) {
      detached = true;
      detach();
      void state.onDetach?.().catch(state.failed);
    }
  };
  input.writer.write = async (wire) => {
    const state = find();
    if (!state || typeof wire !== 'string' || !wire.startsWith('data: '))
      return originalWrite(wire);
    const payload = wire.slice(6).trimEnd();
    const terminal =
      payload === '[DONE]' || JSON.parse(payload)?.type === 'finish';
    if (terminal) {
      state.allowSettlement();
      await state.completion;
    }
    const frame = await state.frame(frameKey(wire), wire);
    const retained = encodeDurableAgentFrame(state.invocationId, frame);
    if (!detached) await Promise.race([originalWrite(retained), disconnected]);
    if (detached) await state.onWire?.(retained);
    return input.writer;
  };
  writerOwners.set(input.writer, {
    state: find,
    dispose: () => {
      disposed = true;
      bound = undefined;
      candidates.delete(transport);
      input.signal.removeEventListener('abort', disconnect);
      writerOwners.delete(input.writer);
    },
  });
  return disconnect;
}

/** Finalizers follow the foreground operation, never a detached HTTP reader. */
export function releaseDurableForeground(
  writer: object,
  cleanup: () => void,
): void {
  const transport = writerOwners.get(writer);
  const state = transport?.state();
  state?.allowSettlement();
  if (state && !state.finished())
    void state.completion
      .then(cleanup, cleanup)
      .finally(() => transport?.dispose())
      .catch(state.failed);
  else {
    transport?.dispose();
    cleanup();
  }
}
