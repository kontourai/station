import type { Readable, Writable } from 'node:stream';
import type { ApplicationChannel } from '@kontourai/station-connect/application-channel';

export const PION_APPLICATION_IPC_VERSION =
  'station.application-ipc/v1' as const;
type Packet = {
  version: typeof PION_APPLICATION_IPC_VERSION;
  id: string;
  kind: 'open' | 'message' | 'close';
  body?: string;
};
type Listener = { message(value: string): void; closed(): void };
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export class PionApplicationIpc {
  readonly #channels = new Map<string, { listener?: Listener }>();
  #buffer = '';
  #failure: Error | undefined;
  #closed = false;
  readonly #decoder = new TextDecoder('utf-8', { fatal: true });
  constructor(
    private readonly input: Writable,
    private readonly output: Readable,
    private readonly accept: (channel: ApplicationChannel) => void,
  ) {
    output.on('data', this.#data);
    output.once('end', this.#ended);
    output.once('error', this.#fail);
    input.once('error', this.#fail);
  }
  readonly #fail = () => {
    if (this.#closed) return;
    this.#failure ??= new Error('pion_application_ipc_failed');
    this.close();
  };
  readonly #data = (chunk: Buffer) => {
    if (this.#closed) return;
    try {
      this.#buffer += this.#decoder.decode(chunk, { stream: true });
      if (Buffer.byteLength(this.#buffer) > 512 * 1024) throw new Error();
      while (true) {
        const end = this.#buffer.indexOf('\n');
        if (end < 0) break;
        const line = this.#buffer.slice(0, end);
        this.#buffer = this.#buffer.slice(end + 1);
        if (Buffer.byteLength(line) > 384 * 1024) throw new Error();
        this.#receive(JSON.parse(line));
      }
    } catch {
      this.#fail();
    }
  };
  readonly #ended = () => {
    if (!this.#closed) this.#fail();
  };
  #send(packet: Packet) {
    if (this.#closed) throw new Error('pion_application_ipc_closed');
    const encoded = `${JSON.stringify(packet)}\n`;
    if (
      Buffer.byteLength(encoded) > 384 * 1024 ||
      this.input.writableLength + Buffer.byteLength(encoded) > 512 * 1024
    )
      throw new Error('pion_application_ipc_capacity');
    this.input.write(encoded, (error) => {
      if (error) this.#fail();
    });
  }
  #receive(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error();
    const packet = value as Packet;
    const keys = Object.keys(packet).sort().join(',');
    if (
      packet.version !== PION_APPLICATION_IPC_VERSION ||
      !ID.test(packet.id) ||
      !['open', 'message', 'close'].includes(packet.kind) ||
      keys !==
        (packet.kind === 'message'
          ? 'body,id,kind,version'
          : 'id,kind,version') ||
      (packet.kind === 'message' &&
        (typeof packet.body !== 'string' ||
          Buffer.byteLength(packet.body) > 48 * 1024))
    )
      throw new Error();
    if (packet.kind === 'open') {
      if (this.#channels.has(packet.id) || this.#channels.size >= 32)
        throw new Error();
      const entry: { listener?: Listener } = {};
      this.#channels.set(packet.id, entry);
      const channel: ApplicationChannel = {
        send: (body) => {
          if (
            typeof body !== 'string' ||
            Buffer.byteLength(body) > 48 * 1024 ||
            !this.#channels.has(packet.id)
          )
            throw new Error('pion_application_channel_refused');
          this.#send({
            version: PION_APPLICATION_IPC_VERSION,
            id: packet.id,
            kind: 'message',
            body,
          });
        },
        close: () => {
          if (!this.#channels.delete(packet.id)) return;
          this.#send({
            version: PION_APPLICATION_IPC_VERSION,
            id: packet.id,
            kind: 'close',
          });
          entry.listener?.closed();
        },
        subscribe: (message, closed) => {
          if (entry.listener)
            throw new Error('pion_application_channel_consumed');
          entry.listener = { message, closed };
          return () => {
            entry.listener = undefined;
          };
        },
      };
      try {
        this.accept(channel);
      } catch {
        channel.close();
      }
      return;
    }
    const entry = this.#channels.get(packet.id);
    if (!entry) return;
    if (packet.kind === 'close') {
      this.#channels.delete(packet.id);
      entry.listener?.closed();
    } else entry.listener?.message(packet.body!);
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.output.off('data', this.#data);
    this.output.off('end', this.#ended);
    this.output.off('error', this.#fail);
    this.input.off('error', this.#fail);
    for (const entry of this.#channels.values()) entry.listener?.closed();
    this.#channels.clear();
    this.input.end();
  }
  finish() {
    if (this.#failure) throw this.#failure;
    if (this.#buffer) throw new Error('pion_application_ipc_partial');
  }
}
