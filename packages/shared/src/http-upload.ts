import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';
import type { MEDIA_UPLOAD_POLICIES } from '@kontourai/station-contracts/walkthrough';

type UploadPolicy = (typeof MEDIA_UPLOAD_POLICIES)['walkthrough'];

/** Also serialized into the CLI listener; keep runtime dependencies in parameters. */
export function configureHttpReceive(
  server: Server,
  classify: (method: string, path: string) => UploadPolicy | undefined,
  maxReceiveMs: number,
) {
  const ordinaryTotalMs = server.requestTimeout;
  // Node's parser exposes only a server-wide total. Keep a finite parser cap;
  // enforce the original total for ordinary bodies without changing socket timers.
  server.requestTimeout = maxReceiveMs;
  const receives = new WeakMap<
    Socket,
    { firstByteAt?: number; lastDataAt: number; current?: IncomingMessage }
  >();
  server.prependListener('connection', (socket) => {
    const state: {
      firstByteAt?: number;
      lastDataAt: number;
      current?: IncomingMessage;
    } = { lastDataAt: Date.now() };
    receives.set(socket, state);
    socket.prependListener('data', () => {
      state.lastDataAt = Date.now();
      if (!state.current || state.current.complete)
        state.firstByteAt ??= state.lastDataAt;
    });
  });
  server.prependListener('request', (request, response) => {
    const receive = receives.get(request.socket);
    const receivedAt =
      receive?.firstByteAt ?? receive?.lastDataAt ?? Date.now();
    if (receive) {
      receive.firstByteAt = undefined;
      receive.current = request;
    }
    const upload = classify(
      request.method ?? '',
      (request.url ?? '/').split('?')[0],
    );
    const hasBody =
      request.headers['transfer-encoding'] ||
      Number(request.headers['content-length']);
    if (!hasBody) return;
    // Node's finish listener calls destroySoon for Connection: close. A FIN
    // followed by a short bounded drain lets a still-writing peer read the
    // refusal before unread input would otherwise cause an immediate reset.
    response.prependOnceListener('finish', () => {
      if (!upload || response.statusCode < 400 || request.complete) return;
      const socket = request.socket;
      const destroySoon = socket.destroySoon;
      const linger = () => {
        socket.destroySoon = destroySoon;
        let discarded = 0;
        const stop = () => socket.destroy();
        const discard = (chunk: Buffer) => {
          discarded += chunk.length;
          if (discarded >= 1024 * 1024) {
            request.pause();
            socket.pause();
          }
        };
        // At most one second and one MiB (plus one socket chunk), no retention.
        const deadline = setTimeout(stop, 1000);
        deadline.unref();
        socket.once('close', () => {
          clearTimeout(deadline);
          socket.removeListener('data', discard);
          request.removeListener('end', stop);
        });
        socket.on('data', discard);
        request.once('end', stop);
        socket.end();
        request.resume();
      };
      socket.destroySoon = linger;
      response.once('close', () => {
        if (socket.destroySoon === linger) socket.destroySoon = destroySoon;
      });
    });
    let idle: ReturnType<typeof setTimeout> | undefined;
    const expire = () => {
      if (request.complete) {
        dispose();
        return;
      }
      if (!response.headersSent) {
        response.writeHead(408, { Connection: 'close', 'Content-Length': '0' });
        response.end();
      } else request.destroy();
    };
    const totalMs = Math.max(
      1,
      (upload?.totalMs ?? ordinaryTotalMs) - (Date.now() - receivedAt),
    );
    const total = setTimeout(expire, totalMs);
    total.unref();
    const progress = () => {
      if (!upload) return;
      clearTimeout(idle);
      idle = setTimeout(expire, upload.idleMs);
      idle.unref();
    };
    // Observing socket bytes never drains IncomingMessage ahead of route admission.
    if (upload) {
      request.socket.on('data', progress);
      progress();
    }
    const dispose = () => {
      clearTimeout(total);
      clearTimeout(idle);
      request.socket.removeListener('data', progress);
    };
    request.once('end', dispose);
    request.once('close', dispose);
    response.once('finish', dispose);
    response.once('close', dispose);
    // Do not set a socket timeout on body end: Node may already have installed
    // its keep-alive timer after an early response (401/413).
  });
}
