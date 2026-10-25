import {
  decodeTerminalFrame,
  encodeTerminalFrame,
  TERMINAL_INPUT,
  TERMINAL_OUTPUT,
  TERMINAL_WINDOW_BYTES,
} from '@kontourai/station-contracts/terminal-transport';
import { WebSocket } from 'ws';
import { z } from 'zod/v3';
import { createLogger } from '../../utils/logger.js';
import {
  TerminalSessionRefusal,
  type TerminalSessions,
} from './terminal-sessions.js';

const logger = createLogger({ name: 'terminal-channel' });
const channelId = z.number().int().min(1).max(0xffffffff);
const seq = z.number().int().nonnegative().safe();
const scope = {
  projectId: z.string().min(1).max(256),
  bindingKey: z.string().min(1).max(512),
};
const dimensions = {
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
};
const request = { requestId: z.string().min(1).max(64) };
const attachment = {
  ...request,
  channel: channelId,
  ...scope,
  fromSeq: seq.default(0),
  windowBytes: z
    .number()
    .int()
    .min(2048)
    .max(TERMINAL_WINDOW_BYTES)
    .default(TERMINAL_WINDOW_BYTES),
};
const commandSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('open'),
      ...attachment,
      fromSeq: z.literal(0).default(0),
      ...dimensions,
    })
    .strict(),
  z
    .object({
      type: z.literal('attach'),
      ...attachment,
      terminalId: z.string().uuid(),
    })
    .strict(),
  z.object({ type: z.literal('list'), ...request, ...scope }).strict(),
  z
    .object({ type: z.literal('detach'), ...request, channel: channelId })
    .strict(),
  z
    .object({ type: z.literal('close'), ...request, channel: channelId })
    .strict(),
  z
    .object({
      type: z.literal('resize'),
      ...request,
      channel: channelId,
      ...dimensions,
    })
    .strict(),
  z.object({ type: z.literal('ack'), channel: channelId, seq }).strict(),
]);
type Command = z.infer<typeof commandSchema>;
type Input = { type: 'input'; channel: number; seq: number; data: string };
type Work = Command | Input;
type Channel = {
  terminalId: string;
  scope: { projectId: string; bindingKey: string };
  cursor: number;
  ack: number;
  inputSeq: number;
  replayTarget: number;
  ready: boolean;
  window: number;
  outstanding: { seq: number; bytes: number }[];
  pumping: boolean;
  dirty: boolean;
};

/** One bounded command queue, independently credited output channels. */
export class TerminalChannelConnection<Principal> {
  private channels = new Map<number, Channel>();
  private usedChannels = new Set<number>();
  private queue: Work[] = [];
  private queuedBytes = 0;
  private running = false;
  private stopped = false;
  private unsubscribe: () => void;
  private heartbeat: ReturnType<typeof setInterval>;

  constructor(
    private ws: WebSocket,
    private sessions: TerminalSessions<Principal>,
    private principal: Principal,
  ) {
    this.unsubscribe = sessions.onChange((id) => {
      for (const [number, channel] of this.channels)
        if (channel.terminalId === id) this.pump(number, channel);
    });
    // Recheck authority even on quiet shells; no output is published from
    // the invalidation callback without a new authorized service read.
    this.heartbeat = setInterval(() => {
      for (const [number, channel] of this.channels) this.pump(number, channel);
    }, 1000);
    ws.on('message', (raw, binary) => {
      try {
        let work: Work;
        if (binary) {
          const frame = decodeTerminalFrame(
            Array.isArray(raw)
              ? Buffer.concat(raw)
              : raw instanceof ArrayBuffer
                ? new Uint8Array(raw)
                : raw,
          );
          if (frame.kind !== TERMINAL_INPUT)
            throw new Error('Invalid input kind');
          work = {
            type: 'input',
            channel: frame.channel,
            seq: frame.seq,
            data: new TextDecoder('utf-8', { fatal: true }).decode(frame.data),
          };
        } else work = commandSchema.parse(JSON.parse(raw.toString()));
        if (work.type === 'ack') {
          this.acknowledge(work.channel, work.seq);
          return;
        }
        // Coalesce only adjacent resizes: input/close/detach are barriers.
        const last = this.queue.at(-1);
        if (
          work.type === 'resize' &&
          last?.type === 'resize' &&
          last.channel === work.channel
        ) {
          this.send({
            type: 'superseded',
            requestId: last.requestId,
            channel: last.channel,
          });
          this.queuedBytes -= this.size(last);
          this.queue.pop();
        }
        const size = this.size(work);
        if (this.queue.length >= 128 || this.queuedBytes + size > 256 * 1024) {
          this.ws.close(4429, 'terminal_command_capacity');
          return;
        }
        this.queue.push(work);
        this.queuedBytes += size;
        void this.drain();
      } catch {
        this.send({ type: 'error', code: 'invalid-frame' });
      }
    });
    ws.once('close', () => this.stop());
    ws.once('error', () => this.stop());
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.heartbeat);
    this.unsubscribe();
    this.channels.clear();
    this.queue = [];
    this.queuedBytes = 0;
  }

  private size(work: Work): number {
    return Buffer.byteLength(JSON.stringify(work));
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.stopped && this.queue.length) {
        const work = this.queue.shift()!;
        this.queuedBytes -= this.size(work);
        try {
          await this.execute(work);
        } catch (error) {
          if (!(error instanceof TerminalSessionRefusal))
            logger.warn('Terminal command failed', { error });
          this.send({
            type: 'error',
            code: 'terminal-refused',
            ...('channel' in work && { channel: work.channel }),
            ...('requestId' in work && { requestId: work.requestId }),
          });
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async execute(work: Work): Promise<void> {
    if (work.type === 'ack') return;
    if (work.type === 'list') {
      const records = await this.sessions.list(this.principal, work);
      this.send({ type: 'list', requestId: work.requestId, records });
      return;
    }
    if (work.type === 'open' || work.type === 'attach') {
      // Never reuse a channel on a socket: delayed input cannot target a
      // different PTY after detach. Reconnect creates a new input sequence.
      if (
        this.usedChannels.has(work.channel) ||
        this.usedChannels.size >= 256 ||
        this.channels.size >= 32
      )
        throw new TerminalSessionRefusal('Channel unavailable');
      this.usedChannels.add(work.channel);
      const record =
        work.type === 'open'
          ? await this.sessions.open(this.principal, work, work)
          : await this.sessions.read(
              this.principal,
              work,
              work.terminalId,
              work.fromSeq,
              2048,
            );
      if (this.stopped) return;
      const channel: Channel = {
        terminalId: record.terminalId,
        scope: { projectId: work.projectId, bindingKey: work.bindingKey },
        cursor: work.fromSeq,
        ack: work.fromSeq,
        inputSeq: 0,
        replayTarget: record.journal.lastSeq,
        ready: false,
        window: work.windowBytes,
        outstanding: [],
        pumping: false,
        dirty: false,
      };
      this.channels.set(work.channel, channel);
      this.send({
        type: 'attached',
        requestId: work.requestId,
        channel: work.channel,
        terminalId: record.terminalId,
        status: record.status,
        replayThrough: channel.replayTarget,
      });
      this.pump(work.channel, channel);
      return;
    }
    const channel = this.channels.get(work.channel);
    if (!channel) throw new TerminalSessionRefusal('Channel unavailable');
    if (work.type === 'input') {
      if (!channel.ready || work.seq !== channel.inputSeq + 1)
        throw new TerminalSessionRefusal('Input is not current');
      await this.sessions.write(
        this.principal,
        channel.scope,
        channel.terminalId,
        work.data,
      );
      channel.inputSeq = work.seq;
      this.send({ type: 'input-ack', channel: work.channel, seq: work.seq });
      return;
    }
    if (work.type === 'resize')
      await this.sessions.resize(
        this.principal,
        channel.scope,
        channel.terminalId,
        work.cols,
        work.rows,
      );
    else if (work.type === 'close')
      await this.sessions.close(
        this.principal,
        channel.scope,
        channel.terminalId,
      );
    // Detach is authorized too; a revoked observer cannot query identity.
    else
      await this.sessions.read(
        this.principal,
        channel.scope,
        channel.terminalId,
        channel.cursor,
        2048,
      );
    if (work.type === 'detach' || work.type === 'close')
      this.channels.delete(work.channel);
    this.send({
      type: 'done',
      requestId: work.requestId,
      channel: work.channel,
    });
  }

  private acknowledge(number: number, seq: number): void {
    const channel = this.channels.get(number);
    if (
      !channel ||
      seq < channel.ack ||
      seq > channel.cursor ||
      (seq !== channel.ack &&
        !channel.outstanding.some((record) => record.seq === seq))
    ) {
      this.send({ type: 'error', channel: number, code: 'invalid-ack' });
      return;
    }
    channel.ack = seq;
    channel.outstanding = channel.outstanding.filter(
      (record) => record.seq > seq,
    );
    if (!channel.ready && seq >= channel.replayTarget) {
      channel.ready = true;
      this.send({ type: 'ready', channel: number, seq });
    }
    this.pump(number, channel);
  }

  private pump(number: number, channel: Channel): void {
    channel.dirty = true;
    if (channel.pumping || this.stopped) return;
    channel.pumping = true;
    void this.output(number, channel)
      .catch((error: unknown) => {
        if (!(error instanceof TerminalSessionRefusal))
          logger.warn('Terminal output unavailable', { error });
        if (this.channels.get(number) !== channel) return;
        this.channels.delete(number);
        this.send({ type: 'error', channel: number, code: 'terminal-refused' });
      })
      .finally(() => {
        channel.pumping = false;
      });
  }

  private async output(number: number, channel: Channel): Promise<void> {
    while (
      channel.dirty &&
      !this.stopped &&
      this.channels.get(number) === channel
    ) {
      channel.dirty = false;
      const snapshot = await this.sessions.read(
        this.principal,
        channel.scope,
        channel.terminalId,
        channel.cursor,
        TERMINAL_WINDOW_BYTES,
      );
      if (this.stopped || this.channels.get(number) !== channel) return;
      if (snapshot.journal.reset) {
        // Wait for already-sent output to drain before replacing its epoch.
        if (channel.outstanding.length) return;
        channel.cursor = snapshot.journal.firstSeq - 1;
        channel.ack = channel.cursor;
        channel.ready = false;
        channel.replayTarget = snapshot.journal.lastSeq;
        this.send({
          type: 'reset',
          channel: number,
          fromSeq: channel.cursor,
          replayThrough: channel.replayTarget,
        });
      }
      let available =
        channel.window -
        channel.outstanding.reduce((sum, record) => sum + record.bytes, 0);
      for (const record of snapshot.journal.records) {
        const data = Buffer.from(record.data);
        if (data.byteLength > available) break;
        if (
          !this.send(
            encodeTerminalFrame(TERMINAL_OUTPUT, number, record.seq, data),
          )
        )
          return;
        channel.outstanding.push({ seq: record.seq, bytes: data.byteLength });
        channel.cursor = record.seq;
        available -= data.byteLength;
      }
      this.send({
        type: 'progress',
        channel: number,
        sentThrough: channel.cursor,
        replayThrough: channel.replayTarget,
        status: snapshot.status,
        lastSeq: snapshot.journal.lastSeq,
      });
      // A bounded page may leave more available without another PTY event.
      if (
        snapshot.journal.records.length &&
        channel.cursor < snapshot.journal.lastSeq &&
        available >= 2048
      )
        channel.dirty = true;
    }
  }

  private send(value: object | Uint8Array): boolean {
    if (this.stopped || this.ws.readyState !== WebSocket.OPEN) return false;
    if (this.ws.bufferedAmount > 256 * 1024) {
      this.ws.close(4429, 'terminal_output_capacity');
      return false;
    }
    this.ws.send(value instanceof Uint8Array ? value : JSON.stringify(value));
    return true;
  }
}
