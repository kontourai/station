// UNWIRED(#91): accepted-parent issuance, effect/accounting owners and actual native-client qualification remain required.
import { z } from 'zod/v3';
import {
  NATIVE_DELEGATION_RPC_PATH,
  NATIVE_MODEL_CHANNEL_LIMITS,
  readNativeModelFrames,
} from './native-model-stdio-protocol.js';

const identity = z.union([z.string().min(1).max(256), z.number().int().safe()]);
const requestSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: identity.optional(),
    method: z.string().min(1).max(128),
    params: z.unknown().optional(),
  })
  .passthrough();
const responseSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: identity,
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.number().int().safe(),
        message: z.string().max(8192),
        data: z.unknown().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) => Object.hasOwn(value, 'result') !== Object.hasOwn(value, 'error'),
  );

/** Stdio-to-owned-loopback relay only. It supplies no parent, tool or financial authority. */
export async function runNativeDelegationRpcClient(): Promise<void> {
  const url = new URL(process.env.STATION_NATIVE_RPC_URL ?? '');
  const key = process.env.STATION_NATIVE_RPC_KEY ?? '';
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== NATIVE_DELEGATION_RPC_PATH ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(key)
  )
    throw new Error('native_delegation_rpc_binding_unavailable');

  const controller = new AbortController();
  const active = new Set<Promise<void>>();
  const seen = new Set<string>();
  let requests = 0;
  let outputBytes = 0;
  let output = Promise.resolve();
  let failure: unknown;
  const fail = (error: unknown) => {
    failure ??= error;
    controller.abort(error);
    process.stdin.destroy();
  };
  process.stdout.on('error', fail);

  const emit = (packet: z.infer<typeof responseSchema>): Promise<void> => {
    const bytes = Buffer.from(JSON.stringify(packet) + '\n');
    outputBytes += bytes.byteLength;
    if (
      bytes.byteLength > NATIVE_MODEL_CHANNEL_LIMITS.bodyBytes ||
      outputBytes > NATIVE_MODEL_CHANNEL_LIMITS.lifetimeBytes
    )
      throw new Error('native_delegation_rpc_output_bound');
    output = output.then(() => {
      controller.signal.throwIfAborted();
      return new Promise<void>((resolve, reject) => {
        process.stdout.write(bytes, (error) =>
          error ? reject(error) : resolve(),
        );
      });
    });
    return output;
  };

  const forward = async (
    request: z.infer<typeof requestSchema>,
  ): Promise<void> => {
    const body = JSON.stringify(request);
    if (Buffer.byteLength(body) > NATIVE_MODEL_CHANNEL_LIMITS.bodyBytes)
      throw new Error('native_delegation_rpc_input_bound');
    const deadline = new AbortController();
    const timeout = setTimeout(
      () => deadline.abort(new Error('native_delegation_rpc_deadline')),
      30_000,
    );
    timeout.unref();
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + key,
          'content-type': 'application/json',
        },
        body,
        redirect: 'error',
        signal: AbortSignal.any([controller.signal, deadline.signal]),
      });
      if (!response.ok) throw new Error('native_delegation_rpc_refused');
      const chunks: Buffer[] = [];
      let bytes = 0;
      if (response.body)
        for await (const raw of response.body) {
          const chunk = Buffer.from(raw);
          bytes += chunk.byteLength;
          if (bytes > NATIVE_MODEL_CHANNEL_LIMITS.bodyBytes) {
            deadline.abort();
            throw new Error('native_delegation_rpc_response_bound');
          }
          chunks.push(chunk);
        }
      controller.signal.throwIfAborted();
      if (request.id === undefined) {
        if (bytes !== 0)
          throw new Error('native_delegation_rpc_notification_response');
        return;
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(chunks),
      );
      const packet = responseSchema.parse(JSON.parse(text));
      if (packet.id !== request.id)
        throw new Error('native_delegation_rpc_response_identity');
      await emit(packet);
    } finally {
      clearTimeout(timeout);
    }
  };

  try {
    await readNativeModelFrames(process.stdin, requestSchema, (request) => {
      if (
        controller.signal.aborted ||
        active.size >= NATIVE_MODEL_CHANNEL_LIMITS.simultaneousRequests ||
        ++requests > NATIVE_MODEL_CHANNEL_LIMITS.totalRequests
      )
        throw new Error('native_delegation_rpc_admission_closed');
      if (request.id === undefined) {
        if (!request.method.startsWith('notifications/'))
          throw new Error('native_delegation_rpc_notification_required');
      } else {
        const id = JSON.stringify(request.id);
        if (seen.has(id)) throw new Error('native_delegation_rpc_duplicate_id');
        seen.add(id);
      }
      let pending: Promise<void>;
      pending = forward(request)
        .catch(fail)
        .finally(() => active.delete(pending));
      active.add(pending);
    });
  } catch (error) {
    fail(error);
  } finally {
    controller.abort();
    await Promise.allSettled([...active]);
    await output.catch(fail);
    process.stdout.removeListener('error', fail);
  }
  if (failure)
    throw new Error('native_delegation_rpc_client_failed', { cause: failure });
}
