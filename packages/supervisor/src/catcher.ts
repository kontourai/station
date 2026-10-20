/**
 * Listens on a spare copy of a held listener while a Windows handoff moves it
 * between generations. Every connection it accepts is held with reading
 * paused, so a generation can adopt it unread (see `ListenerSparesMessage`).
 */
import { createServer, type Socket } from 'node:net';
import type {
  HeldConnection,
  ListenerCatcher,
  ListenerHandle,
} from './generation-manager.ts';

/** A held connection reset before it is passed on is simply gone. */
function ignoreHeldError(): void {}

export function createNetCatcher(
  name: string,
  handle: ListenerHandle,
  now: () => number,
  log: (message: string) => void,
): ListenerCatcher {
  const held: Socket[] = [];
  let lastCaughtAt = 0;
  const server = createServer({ pauseOnConnect: true }, (socket) => {
    lastCaughtAt = now();
    socket.on('error', ignoreHeldError);
    held.push(socket);
  });
  server.on('error', (error) =>
    log(`catcher ${name} failed: ${error.message}`),
  );
  // Listening on a raw handle posts its accepts synchronously, so they are in
  // place before the caller drains the generation that sent the spare.
  server.listen(handle as unknown as Parameters<typeof server.listen>[0]);
  return {
    name,
    get lastCaughtAt() {
      return lastCaughtAt;
    },
    close(): HeldConnection[] {
      server.close();
      return held.splice(0).filter((socket) => !socket.destroyed);
    },
  };
}
