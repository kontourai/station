/**
 * The supervisor's workload host process (`station-pty-host.js`). The
 * supervisor forks it from the build root, beside the server bundle, so
 * node-pty resolves from that build's node_modules; it outlives every core
 * generation. See `PtyWorkloadHost`.
 *
 * It ends every workload and exits on `host.stop` or when its IPC channel
 * closes, which is how it learns the supervisor is gone.
 */
import type { WorkloadRequest } from '@kontourai/station-supervisor/protocol';
import { NodePtyAdapter } from '../adapters/node-pty-adapter.js';
import {
  PtyWorkloadHost,
  WorkloadFailure,
} from '../services/terminal/pty-workload-host.js';

if (typeof process.send !== 'function') {
  process.stderr.write('station-pty-host: must be started by the supervisor\n');
  process.exit(2);
}
const send = (message: unknown) => {
  if (process.connected) process.send?.(message);
};

const host = new PtyWorkloadHost({ pty: new NodePtyAdapter(), emit: send });

let stopping = false;
function stop(): void {
  if (stopping) return;
  stopping = true;
  void host.stopAll().finally(() => process.exit(0));
}

process.on('message', (message: unknown) => {
  if (typeof message !== 'object' || message === null) return;
  const { type, id, request } = message as {
    type?: unknown;
    id?: unknown;
    request?: unknown;
  };
  if (type === 'host.stop') {
    stop();
    return;
  }
  if (type !== 'workload.request' || typeof id !== 'string') return;
  host.handle(request as WorkloadRequest).then(
    (result) => send({ type: 'workload.response', id, ok: true, result }),
    (error: unknown) =>
      send({
        type: 'workload.response',
        id,
        ok: false,
        code: error instanceof WorkloadFailure ? error.code : 'failed',
        message: error instanceof Error ? error.message : String(error),
      }),
  );
});
process.on('disconnect', stop);
// The supervisor stops this process; a terminal's Ctrl-C reaching the
// supervisor's group must not end the shells under it.
process.on('SIGINT', () => {});
process.on('SIGTERM', stop);
send({ type: 'host.ready' });
