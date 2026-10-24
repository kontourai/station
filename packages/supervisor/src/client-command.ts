/**
 * `station-supervisor --request <status|stop|handoff> --home <dir> --instance <id>`:
 * the supervisor bundle as a client of a running supervisor's control
 * channel. The Station CLI runs this rather than linking a second client, so
 * the one control-channel client ships beside the supervisor it talks to.
 *
 * Output is NDJSON on stdout: every control message for the request (handoff
 * progress, then its result), and for `stop` a final `{"type":"stopped"}`
 * once the supervisor has closed the channel on its way out. Exit codes:
 *
 *   0  the request got its result (a refused handoff included)
 *   3  no supervisor is running for this home and instance
 *   1  anything else (refused handshake, timeout, malformed reply)
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { ControlRefusedError, connectControl } from './control-client.ts';
import type { ControlEndpoint, ControlServerMessage } from './protocol.ts';

export const CLIENT_REQUESTS = ['status', 'stop', 'handoff'] as const;
export type ClientRequest = (typeof CLIENT_REQUESTS)[number];

/** Exit code for "no supervisor is running here". */
export const EXIT_NOT_RUNNING = 3;

/** Errors that mean nothing listens at the endpoint. */
const NOT_RUNNING_CODES = new Set(['ENOENT', 'ECONNREFUSED']);

export interface ClientCommandOptions {
  request: ClientRequest;
  endpoint: ControlEndpoint;
  /** Handoff only: the next generation's entry; default the active entry. */
  entry?: string;
  /** Stop only: how long to wait for the supervisor to close the channel. */
  stopWaitMs?: number;
  write: (line: string) => void;
}

export interface ClientCommandResult {
  code: number;
  /** Set when the code is not 0: one line for stderr. */
  message?: string;
}

const RESULT_TYPES: Record<ClientRequest, string> = {
  status: 'status.result',
  stop: 'stop.result',
  handoff: 'handoff.result',
};

/** How long a stopping supervisor may take: its stop drain cap and kill grace, with margin. */
const DEFAULT_STOP_WAIT_MS = 45_000;

export async function runClientCommand(
  options: ClientCommandOptions,
): Promise<ClientCommandResult> {
  const { endpoint, request, write } = options;
  // No token means no supervisor ever published one here; on Unix a missing
  // socket says the same, and connecting reports it below either way.
  if (!existsSync(endpoint.tokenPath)) {
    return {
      code: EXIT_NOT_RUNNING,
      message: `no supervisor is running (no token at ${endpoint.tokenPath})`,
    };
  }
  let connection: Awaited<ReturnType<typeof connectControl>>;
  try {
    connection = await connectControl({
      path: endpoint.path,
      tokenPath: endpoint.tokenPath,
      client: { kind: 'station-supervisor-client', version: '1' },
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== undefined && NOT_RUNNING_CODES.has(code)) {
      return {
        code: EXIT_NOT_RUNNING,
        message: `no supervisor is running (${code} at ${endpoint.path})`,
      };
    }
    if (error instanceof ControlRefusedError) {
      return { code: 1, message: error.message };
    }
    return {
      code: 1,
      message: `could not reach the supervisor: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const id = randomUUID();
  const message: { type: string; id: string } & Record<string, unknown> = {
    type: request,
    id,
    ...(request === 'handoff' && options.entry !== undefined
      ? { entry: options.entry }
      : {}),
  };
  let reply: ControlServerMessage;
  try {
    reply = await connection.request(
      message,
      [RESULT_TYPES[request]],
      (each) => {
        if (each.type !== RESULT_TYPES[request] && each.type !== 'error') {
          write(JSON.stringify(each));
        }
      },
    );
  } catch (error) {
    connection.close();
    return {
      code: 1,
      message: `the supervisor closed the channel before answering: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  write(JSON.stringify(reply));
  if (reply.type === 'error') {
    connection.close();
    return { code: 1, message: `${reply.code}: ${reply.message}` };
  }
  if (request !== 'stop') {
    connection.close();
    return { code: 0 };
  }
  // The supervisor closes every control connection as it exits.
  const waitMs = options.stopWaitMs ?? DEFAULT_STOP_WAIT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = await Promise.race([
    connection.closed.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), waitMs);
    }),
  ]);
  clearTimeout(timer);
  if (!closed) {
    connection.close();
    return {
      code: 1,
      message: `the supervisor accepted the stop but was still running after ${waitMs}ms`,
    };
  }
  write(JSON.stringify({ type: 'stopped' }));
  return { code: 0 };
}
