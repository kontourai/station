// UNWIRED #91: this transport requires the real native authority/final-fetch owner.
import { randomBytes } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import {
  NATIVE_MODEL_CHANNEL_LIMITS,
  type NativeModelRequest,
  nativeModelFrameWriter,
  nativeModelWorkerFrame,
  readNativeModelFrames,
} from './native-model-stdio-protocol.js';

export interface NativeModelChannelPeer {
  input: Writable;
  output: Readable;
  /** Actual owned worker/container settlement, not merely a reported native exit. */
  settled: Promise<void>;
  stop(): Promise<void>;
}

export interface NativeModelChannelRequest {
  response: Promise<Response>;
  /** Includes every owned terminal/accounting operation, also after cancellation. */
  settled: Promise<void>;
  /** Recheck original authority at the actual host-to-worker write; the body is synchronous. */
  invokeDelivery(write: () => void): Promise<void>;
}

/** The required host callback owns authority, reservation, keys, final fetch and usage.
 * This transport supplies none of those guarantees and has no raw-fetch fallback. */
export class NativeModelStdioChannel {
  #token = randomBytes(32).toString('base64url');
  get token(): string {
    return this.#token;
  }
  readonly ready: Promise<{ port: number; uid: number | null }>;
  readonly settled: Promise<void>;
  #resolveReady!: (value: { port: number; uid: number | null }) => void;
  #rejectReady!: (error: unknown) => void;
  #ready = false;
  #closed = false;
  #retiring = false;
  #failure: unknown;
  #stopping?: Promise<void>;
  #peerSettled = false;
  #seen = new Set<string>();
  #active = new Map<
    string,
    { controller: AbortController; settled: Promise<void> }
  >();
  #send: ReturnType<typeof nativeModelFrameWriter>;

  constructor(
    private readonly peer: NativeModelChannelPeer,
    private readonly request: (
      request: NativeModelRequest,
      signal: AbortSignal,
    ) => NativeModelChannelRequest,
  ) {
    this.#send = nativeModelFrameWriter(peer.input);
    void peer.settled.then(
      () => {
        this.#peerSettled = true;
      },
      (error) => {
        this.#failure ??= error;
      },
    );
    this.ready = new Promise((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    void this.ready.catch(() => {});
    const reading = readNativeModelFrames(
      peer.output,
      nativeModelWorkerFrame,
      (frame) => {
        if (this.#closed) return;
        if (frame.type === 'ready') {
          if (this.#ready)
            throw new Error('native_model_channel_duplicate_ready');
          this.#ready = true;
          this.#resolveReady(frame);
        } else if (frame.type === 'cancel') {
          this.#active.get(frame.id)?.controller.abort();
        } else {
          if (
            !this.#ready ||
            this.#seen.has(frame.id) ||
            this.#seen.size >= NATIVE_MODEL_CHANNEL_LIMITS.totalRequests ||
            this.#active.size >=
              NATIVE_MODEL_CHANNEL_LIMITS.simultaneousRequests
          )
            throw new Error('native_model_channel_request_refused');
          this.#seen.add(frame.id);
          const controller = new AbortController();
          const pending = this.#respond(
            { ...frame, body: Buffer.from(frame.body, 'base64') },
            controller.signal,
          );
          this.#active.set(frame.id, { controller, settled: pending });
          void pending
            .finally(() => this.#active.delete(frame.id))
            .catch(() => {});
        }
      },
    );
    this.settled = (async () => {
      try {
        await reading;
        if (!this.#ready) throw new Error('native_model_channel_not_ready');
        if (!this.#retiring)
          throw new Error('native_model_channel_unexpected_close');
      } catch (error) {
        this.#failure ??= error;
        this.#rejectReady(error);
        try {
          await this.#stop();
        } catch (stopError) {
          this.#failure ??= stopError;
        }
      }
      this.#closed = true;
      for (const item of this.#active.values()) item.controller.abort();
      const outcomes = await Promise.allSettled([
        peer.settled,
        ...[...this.#active.values()].map((item) => item.settled),
      ]);
      for (const outcome of outcomes)
        if (outcome.status === 'rejected') this.#failure ??= outcome.reason;
      if (this.#failure) throw this.#failure;
    })();
    void this.settled.catch(() => {});
    void this.#send({ type: 'init', token: this.token }).catch((error) => {
      this.#failure = error;
      this.#rejectReady(error);
      peer.output.destroy(
        error instanceof Error
          ? error
          : new Error('native_model_channel_init_failed'),
      );
    });
  }

  toJSON() {
    return { transport: 'private-native-model-stdio' };
  }

  inspect() {
    return {
      admissionClosed: this.#closed,
      workerSettled: this.#peerSettled,
      ready: this.#ready,
      requests: this.#seen.size,
      pending: this.#active.size,
      failure: this.#failure,
    };
  }

  async #respond(
    input: NativeModelRequest,
    signal: AbortSignal,
  ): Promise<void> {
    let result: NativeModelChannelRequest | undefined;
    try {
      signal.throwIfAborted();
      const handle = this.request(input, signal);
      result = handle;
      void handle.settled.catch((error) => {
        this.#failure ??= error;
        this.peer.output.destroy(
          error instanceof Error
            ? error
            : new Error('native_model_terminal_failed'),
        );
      });
      const response = await handle.response;
      signal.throwIfAborted();
      const headers = [...response.headers.entries()].filter(([name]) =>
        [
          'content-type',
          'x-request-id',
          'openai-processing-ms',
          'x-codex-turn-state',
        ].includes(name),
      );
      await this.#send(
        { type: 'head', id: input.id, status: response.status, headers },
        (write) => handle.invokeDelivery(write),
      );
      if (response.body)
        for await (const bytes of response.body) {
          signal.throwIfAborted();
          const data = Buffer.from(bytes);
          for (
            let offset = 0;
            offset < data.length;
            offset += NATIVE_MODEL_CHANNEL_LIMITS.chunkBytes
          )
            await this.#send(
              {
                type: 'data',
                id: input.id,
                body: data
                  .subarray(
                    offset,
                    offset + NATIVE_MODEL_CHANNEL_LIMITS.chunkBytes,
                  )
                  .toString('base64'),
              },
              (write) => handle.invokeDelivery(write),
            );
        }
      signal.throwIfAborted();
      await this.#send({ type: 'end', id: input.id }, (write) =>
        handle.invokeDelivery(write),
      );
    } catch (error) {
      this.#failure ??= error;
      this.#closed = true;
      this.peer.output.destroy(
        error instanceof Error
          ? error
          : new Error('native_model_request_failed'),
      );
      await this.#stop();
    } finally {
      if (result) await result.settled;
    }
  }

  async close(): Promise<void> {
    this.#retiring = true;
    if (!this.#closed) {
      this.#closed = true;
      for (const item of this.#active.values()) item.controller.abort();
      void this.#send({ type: 'shutdown' }).catch(() => {});
      void this.#stop().catch((error) => {
        this.#failure ??= error;
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([this.#stop(), this.settled]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('native_model_channel_unsettled')),
            2_000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #stop(): Promise<void> {
    if (!this.#stopping) this.#stopping = this.peer.stop();
    return this.#stopping;
  }
}
