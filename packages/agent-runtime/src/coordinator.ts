import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider';
import {
  entryData,
  heldPart,
  normalizePart,
  ownFields,
  prefixDigest,
  readTape,
  requestBytes,
  requestSchema,
  type StrandsEntry,
  tapeBytes,
  type VoltEntry,
  validateParts,
  type WirePart,
} from './codecs.js';
import { commandDigest, same } from './decisions.js';
import {
  bindingSchema,
  digestBytes,
  encode,
  hash,
  RuntimeError,
} from './encoding.js';
import type {
  Attempt,
  BodyRef,
  Fence,
  ModelPin,
  ModelRuntime,
  ModelRuntimeOptions,
  RestoredEntry,
  StreamControl,
} from './types.js';

interface Session {
  entry: RestoredEntry;
  fence: Fence;
  pins: ModelPin[];
  ordinal: number;
  control?: StreamControl;
  running: boolean;
  consumed: boolean;
  fatal: Error | null;
  pumping: Promise<void> | null;
  abort: AbortController;
  reader?: ReadableStreamDefaultReader<LanguageModelV3StreamPart>;
  cancelling: boolean;
  complete: boolean;
  attempt?: Attempt;
  promise?: Promise<LanguageModelV3StreamResult>;
  wakePull?: () => void;
  cancelOutput?: () => void;
  operationDone?: Promise<void>;
  cancellation?: Promise<void>;
  writerGeneration: string;
  retainedBytes: Uint8Array;
}
interface Internals {
  options: ModelRuntimeOptions;
  sessions: WeakMap<RestoredEntry, Session>;
}
const runtimes = new WeakMap<ModelRuntime, Internals>();
const scope = new AsyncLocalStorage<Session>();
function known(
  runtime: ModelRuntime,
  entry: RestoredEntry,
): [Internals, Session] {
  const internals = runtimes.get(runtime);
  const session = internals?.sessions.get(entry);
  if (!internals || !session)
    throw new RuntimeError('DURABLE_BINDING_REQUIRED');
  return [internals, session];
}
function checkedAdmission(
  options: ModelRuntimeOptions,
  session: Session,
  operation: 'execute' | 'recover' | 'read' | 'cancel' | 'project',
) {
  const current = options.admission(session.entry.key, operation);
  bindingSchema.parse(current.binding);
  const data = entryData(session.entry.entry.body.codec, session.retainedBytes);
  if (!same(current.binding, data.binding))
    throw new RuntimeError('DURABLE_IMPLEMENTATION_CHANGED');
  return current;
}
function writeOperation<const T extends object>(
  fields: T,
): T & { operationId: string; digest: ReturnType<typeof hash> } {
  const command = { ...fields, operationId: randomUUID() };
  return { ...command, digest: commandDigest(command) };
}
async function ownedWrite(
  internals: Internals,
  session: Session,
  fields:
    | { type: 'pin'; pin: ModelPin }
    | { type: 'partial'; attempt: Attempt; sequence: number; body: BodyRef }
    | {
        type: 'complete';
        attempt: Attempt;
        tape: BodyRef;
        lastPartialSequence: number;
      }
    | {
        type: 'abandon';
        attempt: Attempt;
        reason: 'consumer-cancel' | 'provider-error' | 'durability-error';
      }
    | { type: 'finish'; status: 'completed' | 'blocked' }
    | { type: 'cancel' },
) {
  const command = writeOperation({
    ...fields,
    key: session.entry.key,
    expected: session.fence,
  });
  const execute = () =>
    internals.options.storage.execute(command, {
      liveness: internals.options.liveness,
    });
  let answer: Awaited<ReturnType<typeof execute>>;
  try {
    answer = await execute();
  } catch {
    answer = await execute();
  }
  if (answer.kind === 'refused')
    throw new RuntimeError(`DURABLE_${answer.reason.toUpperCase()}`);
  session.fence = answer.fence;
}
function freezeIdentity<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeIdentity(child);
    Object.freeze(value);
  }
  return value;
}
export function createModelRuntime(options: ModelRuntimeOptions): ModelRuntime {
  const internals: Internals = { options, sessions: new WeakMap() };
  const readEntryBytes = async (ref: BodyRef): Promise<Uint8Array> => {
    const expected = structuredClone(ref);
    const raw = await options.bodies.read(structuredClone(expected));
    if (!(raw instanceof Uint8Array))
      throw new RuntimeError('DURABLE_BODY_DAMAGED');
    const bytes = new Uint8Array(raw);
    if (
      bytes.byteLength !== expected.byteLength ||
      digestBytes(bytes) !== expected.digest
    )
      throw new RuntimeError('DURABLE_BODY_DAMAGED');
    return bytes;
  };
  const mint = (
    input: Omit<RestoredEntry, 'entryBytes'>,
    bytes: Uint8Array,
    writerGeneration: string,
  ): RestoredEntry => {
    const result = Object.freeze({
      ...freezeIdentity(structuredClone(input)),
      entryBytes: new Uint8Array(bytes),
    });
    internals.sessions.set(result, {
      entry: result,
      writerGeneration,
      fence: input.fence,
      pins: [...input.pins],
      ordinal: 0,
      running: false,
      consumed: false,
      fatal: null,
      retainedBytes: new Uint8Array(bytes),
      pumping: null,
      abort: new AbortController(),
      cancelling: false,
      complete: false,
    });
    return result;
  };
  const runtime: ModelRuntime = {
    async start(input) {
      const admission = options.admission(input.key, 'execute');
      if (!same(admission, input.admission))
        throw new RuntimeError('DURABLE_AUTH_CHANGED');
      const captured = structuredClone(await input.capture());
      const bytes = await readEntryBytes(captured.entry.body);
      if (
        !same([...bytes], [...captured.entryBytes]) ||
        digestBytes(bytes) !== captured.entry.body.digest
      )
        throw new RuntimeError('DURABLE_BODY_DAMAGED');
      const data = entryData(captured.entry.body.codec, bytes);
      if (
        !same(data.binding, admission.binding) ||
        prefixDigest(data) !== captured.entry.effectivePrefixDigest
      )
        throw new RuntimeError('DURABLE_ENTRY_CHANGED');
      const answer = await options.storage.execute(
        writeOperation({
          type: 'open',
          spec: {
            key: input.key,
            binding: admission.binding,
            entry: captured.entry,
          },
          owner: input.owner,
        }),
        { liveness: options.liveness },
      );
      if (answer.kind !== 'opened')
        throw new RuntimeError('DURABLE_RESTORE_REQUIRED');
      return mint(
        {
          key: input.key,
          fence: answer.snapshot.fence,
          entry: captured.entry,
          pins: [],
          mode: 'capture',
        },
        bytes,
        admission.writerGeneration,
      );
    },
    async restore(input) {
      if (!same(options.admission(input.key, 'recover'), input.admission))
        throw new RuntimeError('DURABLE_AUTH_CHANGED');
      const answer = await options.storage.execute(
        writeOperation({
          type: 'takeOver',
          key: input.key,
          expected: input.observed,
          owner: input.owner,
        }),
        { liveness: options.liveness },
      );
      if (answer.kind !== 'restored')
        throw new RuntimeError(
          `DURABLE_${answer.kind === 'refused' ? answer.reason.toUpperCase() : 'UNAVAILABLE'}`,
        );
      const read = await options.storage.execute(
        { type: 'read', key: input.key },
        { liveness: options.liveness },
      );
      if (read.kind !== 'found') throw new RuntimeError('DURABLE_UNAVAILABLE');
      const bytes = await readEntryBytes(answer.entry.body);
      return mint(
        {
          key: input.key,
          fence: answer.snapshot.fence,
          entry: answer.entry,
          pins: read.pins,
          mode: 'restore',
        },
        bytes,
        input.admission.writerGeneration,
      );
    },
    bind(entry) {
      const [, session] = known(runtime, entry);
      if (session.control) return session.control;
      session.control = {
        key: entry.key,
        async run(operation) {
          if (scope.getStore() || session.running || session.consumed)
            throw new RuntimeError('DURABLE_DUPLICATE_CONSUMER');
          checkedAdmission(options, session, 'execute');
          session.running = true;
          session.consumed = true;
          let settle!: () => void;
          session.operationDone = new Promise<void>((resolve) => {
            settle = resolve;
          });
          try {
            return await scope.run(session, operation);
          } catch (error) {
            session.fatal =
              error instanceof Error
                ? error
                : new RuntimeError('DURABLE_CONSUMER_ERROR');
            throw error;
          } finally {
            session.running = false;
            settle();
          }
        },
        async finish(status) {
          if (session.pumping) await session.pumping;
          if (
            session.cancelling ||
            (status === 'completed' &&
              (session.fatal || !session.complete || session.running))
          )
            throw new RuntimeError('DURABLE_RUN_BLOCKED');
          await ownedWrite(internals, session, {
            type: 'finish',
            status: session.fatal ? 'blocked' : status,
          });
        },
        async cancel() {
          if (session.cancellation) return session.cancellation;
          session.cancellation = (async () => {
            checkedAdmission(options, session, 'cancel');
            session.cancelling = true;
            session.abort.abort();
            session.wakePull?.();
            session.cancelOutput?.();
            if (session.promise) await session.promise.catch(() => {});
            if (session.reader) await session.reader.cancel();
            if (session.pumping) await session.pumping.catch(() => {});
            if (scope.getStore() !== session && session.operationDone)
              await session.operationDone;
            await ownedWrite(internals, session, { type: 'cancel' });
          })();
          return session.cancellation;
        },
      };
      return session.control;
    },
  };
  runtimes.set(runtime, internals);
  return runtime;
}
export function assertNativeEntry(
  runtime: ModelRuntime,
  entry: RestoredEntry,
): void {
  const [, session] = known(runtime, entry);
  if (scope.getStore() !== session || session.cancelling || session.fatal)
    throw new RuntimeError('DURABLE_BINDING_REQUIRED');
}
export function denyNativeTool(
  runtime: ModelRuntime,
  entry: RestoredEntry,
): never {
  const [, session] = known(runtime, entry);
  assertNativeEntry(runtime, entry);
  session.fatal = new RuntimeError('DURABLE_TOOLS_UNSUPPORTED');
  throw session.fatal;
}
export function retainedEntry(runtime: ModelRuntime, entry: RestoredEntry) {
  const [, session] = known(runtime, entry);
  return entryData(entry.entry.body.codec, session.retainedBytes);
}
async function nativeToolTemplate(data: VoltEntry | StrandsEntry) {
  if (!('messages' in data))
    return data.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema,
      ...(tool.strict === undefined ? {} : { strict: tool.strict }),
      ...(tool.providerOptions === undefined
        ? {}
        : { providerOptions: tool.providerOptions }),
    }));
  if (!data.tools.length) return [];
  // Use the same pinned public schema conversion as the actual Volt Agent.
  const [{ z }, { zodSchema }] = await Promise.all([
    import('zod'),
    import('@ai-sdk/provider-utils'),
  ]);
  return Promise.all(
    data.tools.map(async (tool) => {
      const converted = await zodSchema(z.fromJSONSchema(tool.inputSchema))
        .jsonSchema;
      const normalized = requestSchema.parse(
        JSON.parse(
          new TextDecoder().decode(
            requestBytes({
              prompt: [
                {
                  role: 'user',
                  content: [{ type: 'text', text: 'schema-template' }],
                },
              ],
              tools: [
                {
                  ...tool,
                  description: tool.description ?? '',
                  inputSchema: converted,
                },
              ],
            }),
          ),
        ),
      );
      return normalized.tools![0]!;
    }),
  );
}
export function guardedModel(input: {
  model: LanguageModelV3;
  runtime: ModelRuntime;
  entry: RestoredEntry;
}): LanguageModelV3 {
  const { model, runtime, entry } = input;
  const [internals, session] = known(runtime, entry);
  const data = retainedEntry(runtime, entry);
  if (
    model.specificationVersion !== 'v3' ||
    model.provider !== data.binding.provider ||
    model.modelId !== data.binding.modelId
  )
    throw new RuntimeError('DURABLE_IMPLEMENTATION_CHANGED');
  const expectedPrompt =
    'messages' in data
      ? data.messages.map((message) =>
          message.role === 'system'
            ? {
                role: 'system',
                content: message.parts.map((p) => p.text).join('\n'),
              }
            : {
                role: message.role,
                content: message.parts.map((p) => ({
                  type: p.type,
                  text: p.text,
                })),
              },
        )
      : [
          ...(data.systemPrompt
            ? [{ role: 'system', content: data.systemPrompt }]
            : []),
          ...data.prefix.map((message) => ({
            role: message.role,
            content: message.content.map((p) =>
              'text' in p
                ? { type: 'text', text: p.text }
                : { type: 'reasoning', text: p.reasoning.text },
            ),
          })),
          {
            role: 'user',
            content: [{ type: 'text', text: data.effectiveInput }],
          },
        ];
  const nativePart = (part: WirePart): LanguageModelV3StreamPart => {
    if (part.type === 'response-metadata')
      return {
        ...part,
        timestamp: part.timestamp ? new Date(part.timestamp.utc) : undefined,
      };
    if (part.type === 'finish')
      return {
        ...part,
        finishReason: { ...part.finishReason, raw: part.finishReason.raw },
        usage: {
          inputTokens: {
            total: part.usage.inputTokens.total,
            noCache: part.usage.inputTokens.noCache,
            cacheRead: part.usage.inputTokens.cacheRead,
            cacheWrite: part.usage.inputTokens.cacheWrite,
          },
          outputTokens: {
            total: part.usage.outputTokens.total,
            text: part.usage.outputTokens.text,
            reasoning: part.usage.outputTokens.reasoning,
          },
        },
      };
    return part;
  };
  return {
    specificationVersion: 'v3',
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    async doGenerate() {
      throw new RuntimeError('DURABLE_GENERATE_UNSUPPORTED');
    },
    async doStream(options: LanguageModelV3CallOptions) {
      assertNativeEntry(runtime, entry);
      checkedAdmission(internals.options, session, 'execute');
      if (
        model.provider !== data.binding.provider ||
        model.modelId !== data.binding.modelId
      )
        throw new RuntimeError('DURABLE_IMPLEMENTATION_CHANGED');
      if (Object.keys(ownFields(await model.supportedUrls, [])).length)
        throw new RuntimeError('DURABLE_URLS_UNSUPPORTED');
      if (session.promise) {
        await session.promise;
        throw new RuntimeError('DURABLE_DUPLICATE_CONSUMER');
      }
      const checkRelease = () => {
        const currentAdmission = checkedAdmission(
          internals.options,
          session,
          'execute',
        );
        if (
          currentAdmission.writerGeneration !== session.writerGeneration ||
          model.provider !== data.binding.provider ||
          model.modelId !== data.binding.modelId ||
          model.specificationVersion !== 'v3'
        )
          throw new RuntimeError('DURABLE_IMPLEMENTATION_CHANGED');
        assertNativeEntry(runtime, entry);
      };
      const execute = async (): Promise<LanguageModelV3StreamResult> => {
        const bytes = requestBytes(options);
        const reconstructed = requestSchema.parse(
          JSON.parse(new TextDecoder().decode(bytes)),
        );
        const generation =
          'messages' in data ? data.generation : data.vercelConfig;
        const expectedTools = await nativeToolTemplate(data);
        const template = {
          ...generation,
          prompt: expectedPrompt,
          tools: expectedTools,
          toolChoice: { type: 'auto' },
          providerOptions: {},
          includeRawChunks: false,
        };
        const candidate = {
          ...reconstructed,
          tools: reconstructed.tools ?? [],
          toolChoice: reconstructed.toolChoice ?? { type: 'auto' },
          providerOptions: reconstructed.providerOptions ?? {},
          includeRawChunks: reconstructed.includeRawChunks ?? false,
        };
        if (!same(candidate, template))
          throw new RuntimeError('DURABLE_ENTRY_CHANGED');
        let pin = session.pins[session.ordinal];
        if (pin) {
          if (
            pin.ordinal !== session.ordinal ||
            pin.entryDigest !== entry.entry.body.digest ||
            pin.request.digest !== digestBytes(bytes)
          )
            throw new RuntimeError('DURABLE_REQUEST_CHANGED');
        } else {
          if (session.ordinal !== 0)
            throw new RuntimeError('DURABLE_TOOLS_UNSUPPORTED');
          const request = await internals.options.bodies.put(
            'runtime-ai-sdk-v3-request/1',
            bytes,
          );
          pin = {
            requestId: randomUUID(),
            ordinal: session.ordinal,
            entryDigest: entry.entry.body.digest,
            previousResponseDigest: null,
            request,
          };
          await ownedWrite(internals, session, { type: 'pin', pin });
          session.pins.push(pin);
        }
        const begin = writeOperation({
          type: 'begin',
          key: entry.key,
          expected: session.fence,
          requestId: pin.requestId,
        });
        const callBegin = () =>
          internals.options.storage.execute(begin, {
            liveness: internals.options.liveness,
          });
        let answer: Awaited<ReturnType<typeof callBegin>>;
        try {
          answer = await callBegin();
        } catch {
          answer = await callBegin();
        }
        if (answer.kind !== 'execute' && answer.kind !== 'replay')
          throw new RuntimeError('DURABLE_NO_EXECUTION_GRANT');
        session.fence = answer.fence;
        session.attempt = answer.attempt;
        if (answer.kind === 'replay') {
          const tape = readTape(
            await internals.options.bodies.read(answer.tape),
          );
          if (
            tape.requestId !== pin.requestId ||
            tape.requestId !== answer.attempt.requestId ||
            tape.attempt !== answer.attempt.number
          )
            throw new RuntimeError('DURABLE_RECORD_DAMAGED');
          checkRelease();
          session.complete = true;
          session.ordinal++;
          return {
            stream: new ReadableStream({
              start(controller) {
                for (const part of tape.parts)
                  controller.enqueue(nativePart(part));
                controller.close();
              },
            }),
          };
        }
        // Dispatch exactly the admitted pinned bytes, with a fresh live signal.
        const pinnedOptions = requestSchema.parse(
          JSON.parse(
            new TextDecoder().decode(
              await internals.options.bodies.read(pin.request),
            ),
          ),
        );
        checkRelease();
        const native = await model.doStream({
          ...pinnedOptions,
          abortSignal: session.abort.signal,
        });
        ownFields(native, ['stream', 'request', 'response']);
        if (session.cancelling) {
          await native.stream.cancel();
          throw new RuntimeError('DURABLE_CANCELLED');
        }
        const reader = native.stream.getReader();
        session.reader = reader;
        let pendingPull: (() => void) | undefined;
        const parts: WirePart[] = [];
        let totalBytes = 0;
        let held = false;
        let delivered = 0;
        let sequence = 0;
        const downstream = new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            session.cancelOutput = () => {
              controller.error(new RuntimeError('DURABLE_CANCELLED'));
            };
            session.pumping = (async () => {
              try {
                while (!session.cancelling) {
                  const item = await reader.read();
                  if (item.done) break;
                  const part = normalizePart(item.value);
                  totalBytes += encode(part).length + 4;
                  if (totalBytes > 32 * 1024 * 1024)
                    throw new RuntimeError('DURABLE_CAPACITY');
                  parts.push(part);
                  validateParts(parts, false);
                  const auditVisible = !heldPart(part);
                  held ||=
                    part.type.startsWith('tool-') || part.type === 'finish';
                  if (!held) {
                    if (auditVisible) {
                      const body = await internals.options.bodies.put(
                        'runtime-ai-sdk-v3-part/1',
                        encode(part),
                      );
                      await ownedWrite(internals, session, {
                        type: 'partial',
                        attempt: answer.attempt,
                        sequence,
                        body,
                      });
                      sequence++;
                    }
                    if (session.cancelling) return;
                    controller.enqueue(nativePart(part));
                    delivered++;
                    if ((controller.desiredSize ?? 0) <= 0)
                      await new Promise<void>((resolve) => {
                        pendingPull = resolve;
                        session.wakePull = resolve;
                      });
                  }
                }
                if (session.cancelling) return;
                const tape = await internals.options.bodies.put(
                  'runtime-ai-sdk-v3-tape/1',
                  tapeBytes(pin.requestId, answer.attempt.number, parts),
                );
                await ownedWrite(internals, session, {
                  type: 'complete',
                  attempt: answer.attempt,
                  tape,
                  lastPartialSequence: sequence - 1,
                });
                session.complete = true;
                session.ordinal++;
                if (session.cancelling) return;
                for (const part of parts.slice(delivered))
                  controller.enqueue(nativePart(part));
                controller.close();
              } catch (error) {
                session.fatal =
                  error instanceof Error
                    ? error
                    : new RuntimeError('DURABLE_STREAM_FAILED');
                try {
                  if (!session.cancelling)
                    await ownedWrite(internals, session, {
                      type: 'abandon',
                      attempt: answer.attempt,
                      reason: 'durability-error',
                    });
                } catch {
                  /* Keep uncertainty when the journal is unavailable. */
                }
                if (!session.cancelling)
                  controller.error(new RuntimeError('DURABLE_STREAM_FAILED'));
              } finally {
                session.reader = undefined;
                reader.releaseLock();
              }
            })();
          },
          pull() {
            pendingPull?.();
            pendingPull = undefined;
            session.wakePull = undefined;
          },
          async cancel() {
            pendingPull?.();
            await runtime.bind(entry).cancel();
          },
        });
        return { stream: downstream };
      };
      session.promise = execute();
      return session.promise;
    },
  };
}
