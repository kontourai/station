// @ts-check
// Child for handle-guard.test.ts. Mode `bind` listens and sends its raw
// `server._handle`; mode `adopt` listens on a handle it receives. Both answer
// HTTP with their mode and pid.
import http from 'node:http';

const mode = process.argv[2];
const server = http.createServer((_req, res) => {
  res.setHeader('Connection', 'close');
  res.end(`${mode}:${process.pid}`);
});
const send = /** @type {(message: unknown, handle?: unknown) => void} */ (
  /** @type {any} */ (process).send.bind(process)
);

process.on('message', (/** @type {{ type: string }} */ message, handle) => {
  if (message.type === 'adopt') {
    server.listen(/** @type {any} */ (handle), () => send({ type: 'adopted' }));
  } else if (message.type === 'exit') {
    process.exit(0);
  }
});
process.on('disconnect', () => process.exit(0));

if (mode === 'bind') {
  server.listen(0, '127.0.0.1', () => {
    const raw = /** @type {any} */ (server)._handle;
    const address = server.address();
    send(
      {
        type: 'bound',
        port: typeof address === 'object' && address ? address.port : 0,
        hasHandle: raw !== null && typeof raw === 'object',
        handleClass: raw?.constructor?.name ?? null,
      },
      raw,
    );
  });
}
