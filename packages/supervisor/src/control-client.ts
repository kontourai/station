/**
 * Minimal control-channel client, for the CLI, the tray bridge, and tests.
 */
import { readFileSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { encodeLine, isRecord, NdjsonDecoder } from './ndjson.ts';
import {
  CONTROL_MAX_LINE_BYTES,
  type ControlServerMessage,
  type ProtocolVersion,
  type RefusedMessage,
  SUPERVISOR_PROTOCOL,
  type WelcomeMessage,
} from './protocol.ts';

export interface ControlClientOptions {
  path: string;
  /** The token itself, or omit and pass `tokenPath`. */
  token?: string;
  tokenPath?: string;
  capabilities?: string[];
  protocol?: ProtocolVersion;
  client?: { kind: string; version: string };
  timeoutMs?: number;
}

export class ControlRefusedError extends Error {
  readonly refusal: RefusedMessage;

  constructor(refusal: RefusedMessage) {
    super(`supervisor refused the connection: ${refusal.reason}`);
    this.refusal = refusal;
  }
}

export interface ControlConnection {
  welcome: WelcomeMessage;
  /** Sends a raw message. */
  send(message: unknown): void;
  /** Registers a listener for every message after the welcome. */
  onMessage(listener: (message: ControlServerMessage) => void): () => void;
  /** Sends a request and resolves with the first message whose type is in `until` and whose id matches. */
  request(
    message: { type: string; id: string } & Record<string, unknown>,
    until: string[],
    onMessage?: (message: ControlServerMessage) => void,
  ): Promise<ControlServerMessage>;
  closed: Promise<void>;
  close(): void;
}

export function connectControl(
  options: ControlClientOptions,
): Promise<ControlConnection> {
  const token =
    options.token ?? readFileSync(options.tokenPath ?? '', 'utf8').trim();
  return new Promise((resolve, reject) => {
    const socket: Socket = createConnection(options.path);
    const decoder = new NdjsonDecoder(CONTROL_MAX_LINE_BYTES);
    const listeners = new Set<(message: ControlServerMessage) => void>();
    let welcomed = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timed out waiting for the supervisor welcome'));
    }, options.timeoutMs ?? 5_000);
    const closed = new Promise<void>((resolveClosed) =>
      socket.on('close', () => resolveClosed()),
    );
    socket.on('error', (error) => {
      clearTimeout(timer);
      if (!welcomed) reject(error);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      if (!welcomed)
        reject(new Error('supervisor closed the connection before welcome'));
    });
    socket.on('data', (chunk: Buffer) => {
      for (const line of decoder.push(chunk)) {
        const message = JSON.parse(line) as ControlServerMessage;
        if (!welcomed) {
          clearTimeout(timer);
          if (message.type === 'welcome') {
            welcomed = true;
            resolve(connection(message));
          } else if (message.type === 'refused') {
            reject(new ControlRefusedError(message));
          } else {
            reject(new Error(`unexpected first message: ${line}`));
          }
          continue;
        }
        for (const listener of [...listeners]) listener(message);
      }
    });
    socket.write(
      encodeLine({
        type: 'hello',
        protocol: options.protocol ?? { ...SUPERVISOR_PROTOCOL },
        token,
        client: options.client ?? { kind: 'cli', version: '0.0.0' },
        capabilities: options.capabilities ?? [],
      }),
    );

    function connection(welcome: WelcomeMessage): ControlConnection {
      const onMessage = (listener: (message: ControlServerMessage) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      };
      return {
        welcome,
        send: (message) => socket.write(encodeLine(message)),
        onMessage,
        request: (message, until, onEach) =>
          new Promise((resolveRequest, rejectRequest) => {
            const off = onMessage((reply) => {
              if (
                !isRecord(reply) ||
                (reply as { id?: unknown }).id !== message.id
              )
                return;
              onEach?.(reply);
              if (until.includes(reply.type) || reply.type === 'error') {
                off();
                resolveRequest(reply);
              }
            });
            closed.then(() => {
              off();
              rejectRequest(new Error('control connection closed'));
            });
            socket.write(encodeLine(message));
          }),
        closed,
        close: () => socket.end(),
      };
    }
  });
}
