import { readFileSync, writeFileSync } from 'node:fs';
import { parentPort } from 'node:worker_threads';

// Each disposable fixture instance has immutable input data. Executable
// source is fixed, including the deliberately unresponsive worker case.
const { mode, marker, empty, responseBytes } = JSON.parse(
  readFileSync(new URL('./inputs.json', import.meta.url), 'utf8'),
);
if (mode === 'must-not-launch') {
  writeFileSync(marker, 'constructed');
  throw new Error('must not launch');
}
parentPort.on('message', (wire) => {
  if (mode === 'idle') return;
  if (mode === 'infinite') {
    writeFileSync(marker, 'entered');
    while (true) {}
  }
  const request = JSON.parse(wire);
  if (mode === 'crash') throw new Error('crash');
  if (mode === 'oversized') {
    parentPort.postMessage('x'.repeat(responseBytes + 1));
    return;
  }
  if (mode === 'bad-page') {
    parentPort.postMessage(
      JSON.stringify({ id: request.id, page: { invalid: true } }),
    );
    return;
  }
  if (mode === 'wrong-id') {
    parentPort.postMessage(JSON.stringify({ id: request.id + 1, page: empty }));
    return;
  }
  if (mode === 'delayed-open') {
    setTimeout(
      () =>
        parentPort.postMessage(
          JSON.stringify({
            id: request.id,
            page: {
              state: 'resolved',
              target: {
                kind: 'task',
                projectId: request.projectId,
                taskId: request.taskId,
              },
            },
          }),
        ),
      20,
    );
    return;
  }
  if (mode === 'late-success' || mode === 'delayed-success') {
    setTimeout(
      () => {
        parentPort.postMessage(JSON.stringify({ id: request.id, page: empty }));
        if (mode === 'late-success') writeFileSync(marker, 'sent');
      },
      mode === 'late-success' ? 30 : 80,
    );
    return;
  }
  throw new Error('Unknown worker fixture mode');
});
