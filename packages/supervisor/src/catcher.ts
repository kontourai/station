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
  onCatch: () => void,
  log: (message: string) => void,
): ListenerCatcher {
  const held: Socket[] = [];
  let lastCaughtAt = 0;
  let listening = true;
  const server = createServer({ pauseOnConnect: true }, (socket) => {
    lastCaughtAt = now();
    socket.on('error', ignoreHeldError);
    held.push(socket);
    onCatch();
  });
  const stop = () => {
    if (!listening) return;
    listening = false;
    server.close();
  };
  server.on('error', (error) =>
    log(`catcher ${name} failed: ${error.message}`),
  );
  // Listening on a raw handle posts its accepts synchronously, so they are in
  // place before the caller drains the generation that sent the spare.
  server.listen(handle);
  return {
    name,
    get lastCaughtAt() {
      return lastCaughtAt;
    },
    get heldCount() {
      return held.filter((socket) => !socket.destroyed).length;
    },
    stop,
    close(): HeldConnection[] {
      stop();
      return held.splice(0).filter((socket) => !socket.destroyed);
    },
  };
}
