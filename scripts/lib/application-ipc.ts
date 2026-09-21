import { randomUUID } from 'node:crypto';
import type { ApplicationChannel } from '@kontourai/station-connect/application-channel';

type Packet = {
  version: 'station.lab-ipc/v1';
  id: string;
  kind: 'open' | 'message' | 'close';
  body?: string;
};
type Listener = { message(value: unknown): void; closed(): void };
type Entry = { listener?: Listener; channel: ApplicationChannel };
/** Test-owned process IPC only; never a network authentication mechanism. */
export class ApplicationIpc {
  private readonly channels = new Map<string, Entry>();
  private readonly unsubscribe: () => void;
  private stopped = false;
  constructor(
    private readonly transport: {
      send(packet: Packet, done: (error: Error | null) => void): boolean;
      subscribe(listener: (value: unknown) => void): () => void;
    },
    private readonly accept?: (channel: ApplicationChannel) => void,
  ) {
    this.unsubscribe = transport.subscribe((value) => this.receive(value));
  }
  open(): ApplicationChannel {
    if (this.accept || this.stopped || this.channels.size >= 32)
      throw new Error('Lab IPC channel admission refused');
    const id = randomUUID();
    const channel = this.create(id);
    this.send({ version: 'station.lab-ipc/v1', id, kind: 'open' });
    return channel;
  }
  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe();
    const entries = [...this.channels.entries()];
    this.channels.clear();
    for (const [id, entry] of entries) {
      try {
        this.transport.send(
          { version: 'station.lab-ipc/v1', id, kind: 'close' },
          () => {},
        );
      } catch {
        /* The owned process/connection lifetime remains the cleanup owner. */
      }
      entry.listener?.closed();
    }
  }
  private send(packet: Packet) {
    if (this.stopped) throw new Error('Lab IPC retired');
    try {
      const queued = this.transport.send(packet, (error) => {
        if (error) this.close();
      });
      if (!queued) throw new Error('Lab IPC send capacity exhausted');
    } catch (error) {
      this.close();
      throw error;
    }
  }
  private create(id: string): ApplicationChannel {
    const entry: Entry = {
      channel: {
        send: (body) => {
          if (
            !this.channels.has(id) ||
            typeof body !== 'string' ||
            Buffer.byteLength(body) > 48 * 1024
          )
            throw new Error('Lab IPC message refused');
          this.send({
            version: 'station.lab-ipc/v1',
            id,
            kind: 'message',
            body,
          });
        },
        close: () => {
          if (!this.channels.delete(id)) return;
          try {
            this.send({ version: 'station.lab-ipc/v1', id, kind: 'close' });
          } catch {
            /* Retired IPC cannot carry another close notification. */
          } finally {
            entry.listener?.closed();
          }
        },
        subscribe: (message, closed) => {
          if (entry.listener)
            throw new Error('Lab IPC channel already consumed');
          entry.listener = { message, closed };
          return () => {
            entry.listener = undefined;
          };
        },
      },
    };
    this.channels.set(id, entry);
    return entry.channel;
  }
  private receive(value: unknown) {
    if (this.stopped) return;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      this.close();
      return;
    }
    const packet = value as Packet;
    if (
      packet.version !== 'station.lab-ipc/v1' ||
      typeof packet.id !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(packet.id) ||
      !['open', 'message', 'close'].includes(packet.kind) ||
      Object.keys(packet).sort().join(',') !==
        (packet.kind === 'message'
          ? 'body,id,kind,version'
          : 'id,kind,version') ||
      (packet.kind === 'message' &&
        (typeof packet.body !== 'string' ||
          Buffer.byteLength(packet.body) > 48 * 1024))
    ) {
      this.close();
      return;
    }
    if (packet.kind === 'open') {
      if (
        !this.accept ||
        this.channels.has(packet.id) ||
        this.channels.size >= 32
      ) {
        this.close();
        return;
      }
      const channel = this.create(packet.id);
      try {
        this.accept(channel);
      } catch {
        channel.close();
      }
      return;
    }
    const entry = this.channels.get(packet.id);
    if (!entry) return; // A late close/message after cancellation cannot reopen an ID.
    if (packet.kind === 'close') {
      this.channels.delete(packet.id);
      entry.listener?.closed();
    } else entry.listener?.message(packet.body);
  }
}

export function bridgeApplicationChannels(
  left: ApplicationChannel,
  right: ApplicationChannel,
  signal: AbortSignal,
) {
  let closed = false;
  let unleft = () => {};
  let unright = () => {};
  const close = () => {
    if (closed) return;
    closed = true;
    unleft();
    unright();
    signal.removeEventListener('abort', close);
    left.close();
    right.close();
  };
  const forward = (channel: ApplicationChannel, message: unknown) => {
    try {
      if (typeof message !== 'string' || Buffer.byteLength(message) > 48 * 1024)
        throw new Error('Lab channel frame refused');
      channel.send(message);
    } catch {
      close();
    }
  };
  unleft = left.subscribe((message) => forward(right, message), close);
  unright = right.subscribe((message) => forward(left, message), close);
  signal.addEventListener('abort', close, { once: true });
  if (signal.aborted) close();
  return close;
}
