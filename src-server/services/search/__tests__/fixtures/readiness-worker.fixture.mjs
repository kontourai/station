import { readFileSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';

// station#1707. A worker whose 'online' event and readiness sentinel are
// deliberately far apart: the thread begins executing JS immediately (which
// is all `worker.on('online')` reports), and only later does it register its
// handler and announce that it can answer — standing in for the transform,
// evaluate and database-open the real entry modules do before their own
// sentinel. Requests posted before then queue on the port, exactly as they do
// against a real worker still booting.
const { mode, readyDelayMs } = JSON.parse(
  readFileSync(workerData.databasePath, 'utf8'),
);

// An entry module that fails while loading. Node still emits 'online' first —
// the thread did start executing JS — so this is the case that separates
// "settled because the worker said it was ready" from "settled because the
// thread exists", and after worker-posted readiness it is the COMMON failure
// path: any broken entry module reaches it.
if (mode === 'throw') throw new Error('entry module failed to load');

// Never announces readiness and never answers: the owner's own bound is the
// only thing that can end the wait.
if (mode === 'never') {
  setTimeout(() => {}, 60_000);
} else {
  setTimeout(() => {
    parentPort.on('message', (wire) => {
      const request = JSON.parse(wire);
      parentPort.postMessage(
        JSON.stringify({ id: request.id, result: { state: 'available' } }),
      );
    });
    // The last top-level effect, as in the real workers — just later.
    parentPort.postMessage({ type: 'ready' });
  }, readyDelayMs);
}
