/**
 * #4519 round 2: a dynamic listener must not serve anything until managed
 * admission (the Tailscale Serve check on its port) has succeeded. The port
 * of an ephemeral listener is known only once it is bound, and once bound
 * the kernel completes connections, so the gate holds every request,
 * upgrade and CONNECT the server emits until `admitted()`. On `refused()`
 * nothing held is processed and every accepted socket is destroyed.
 *
 * Install the gate after the server's handlers are attached and before
 * `listen()`.
 */
import type { Server } from 'node:http';
import type { Socket } from 'node:net';

const GATED_EVENTS = ['request', 'upgrade', 'connect'] as const;

export interface ListenerAdmissionGate {
  /** Restore the handlers and deliver everything held, in arrival order. */
  admitted(): void;
  /** Drop everything held and destroy every socket accepted so far. */
  refused(): void;
}

type Handler = (...args: unknown[]) => void;

export function gateServerUntilAdmitted(server: Server): ListenerAdmissionGate {
  let state: 'pending' | 'admitted' | 'refused' = 'pending';
  const sockets = new Set<Socket>();
  const held: Array<{ deliver: () => void; drop: () => void }> = [];
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    if (state === 'refused') socket.destroy();
  };
  server.prependListener('connection', track);

  const restore: Array<() => void> = [];
  for (const event of GATED_EVENTS) {
    const handlers = server.listeners(event) as Handler[];
    if (handlers.length === 0) continue;
    server.removeAllListeners(event);
    const hold: Handler = (...args) => {
      const socket = socketOf(event, args);
      if (state === 'refused') {
        socket?.destroy();
        return;
      }
      held.push({
        deliver: () => {
          for (const handler of handlers) handler.apply(server, args);
        },
        drop: () => socket?.destroy(),
      });
    };
    server.on(event, hold);
    restore.push(() => {
      server.off(event, hold);
      for (const handler of handlers) server.on(event, handler);
    });
  }

  return {
    admitted() {
      if (state !== 'pending') return;
      state = 'admitted';
      server.off('connection', track);
      sockets.clear();
      for (const undo of restore) undo();
      for (const entry of held.splice(0)) entry.deliver();
    },
    refused() {
      if (state !== 'pending') return;
      state = 'refused';
      for (const entry of held.splice(0)) entry.drop();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
  };
}

function socketOf(event: string, args: unknown[]): Socket | undefined {
  // request: (req, res); upgrade/connect: (req, socket, head).
  if (event === 'request')
    return (args[0] as { socket?: Socket } | undefined)?.socket;
  return args[1] as Socket | undefined;
}
