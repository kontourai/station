/**
 * A minimal client for the process supervisor's control channel, for tests
 * that run the supervisor as a child process.
 *
 * The package's own client is not imported: its sources use `.ts` import
 * specifiers that the server tsconfig does not accept, while the `/protocol`
 * subpath (types and constants) has none.
 */
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import {
  type ControlServerMessage,
  SUPERVISOR_PROTOCOL,
} from '@kontourai/station-supervisor/protocol';

export interface ControlConnection {
  request(
    message: { type: string; id: string },
    until: string[],
  ): Promise<ControlServerMessage>;
  close(): void;
}

export function connectControl(
  path: string,
  tokenPath: string,
): Promise<ControlConnection> {
  return new Promise((resolveConnection, reject) => {
    const socket = createConnection(path);
    const waiters = new Set<(message: ControlServerMessage) => void>();
    let buffer = '';
    let welcomed = false;
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (
        let newline = buffer.indexOf('\n');
        newline >= 0;
        newline = buffer.indexOf('\n')
      ) {
        const message = JSON.parse(
          buffer.slice(0, newline),
        ) as ControlServerMessage;
        buffer = buffer.slice(newline + 1);
        if (!welcomed) {
          if (message.type !== 'welcome') {
            reject(new Error(`control refused: ${JSON.stringify(message)}`));
            socket.destroy();
            return;
          }
          welcomed = true;
          resolveConnection({
            request: (request, until) =>
              new Promise((resolveReply) => {
                const waiter = (reply: ControlServerMessage) => {
                  if ((reply as { id?: string }).id !== request.id) return;
                  if (!until.includes(reply.type) && reply.type !== 'error')
                    return;
                  waiters.delete(waiter);
                  resolveReply(reply);
                };
                waiters.add(waiter);
                socket.write(`${JSON.stringify(request)}\n`);
              }),
            close: () => socket.end(),
          });
          continue;
        }
        for (const waiter of [...waiters]) waiter(message);
      }
    });
    socket.write(
      `${JSON.stringify({
        type: 'hello',
        protocol: { ...SUPERVISOR_PROTOCOL },
        token: readFileSync(tokenPath, 'utf8').trim(),
        client: { kind: 'test', version: '0.0.0' },
        capabilities: [],
      })}\n`,
    );
  });
}
