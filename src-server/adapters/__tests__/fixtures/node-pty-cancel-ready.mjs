import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

if (process.platform !== 'win32')
  throw new Error('Vendor cancellation requires Windows');
const require = createRequire(import.meta.url);
const { WindowsPtyAgent } = require('node-pty/lib/windowsPtyAgent');
const { EventEmitter2 } = require('node-pty/lib/eventEmitter2');
const cwd = process.argv[2];
if (!cwd) throw new Error('Vendor cancellation requires an owned folder');
const environment = Object.entries(process.env)
  .filter(([, value]) => typeof value === 'string')
  .map(([key, value]) => `${key}=${value}`);

async function observe(mode) {
  const ready = new EventEmitter2();
  const failed = new EventEmitter2();
  let connections = 0;
  let disposals = 0;
  let errors = 0;
  let acknowledgeError;
  const errorSeen = new Promise((resolve) => {
    acknowledgeError = resolve;
  });
  const absentPipe = String.raw`\\.\pipe\station-cancelled-${randomUUID()}`;
  const connection = {
    onReady: ready.event,
    onError: failed.event,
    connectSocket(socket) {
      connections++;
      // A missing fence reaches real IPC and fails instead of faking success.
      socket.connect(absentPipe);
    },
    dispose() {
      disposals++;
    },
  };
  const agent = new WindowsPtyAgent(
    process.execPath,
    ['-e', 'process.exit(0)'],
    environment,
    cwd,
    80,
    24,
    false,
    false,
    false,
    {
      connectionTimeout: mode === 'timeout' ? 20 : 1000,
      conoutConnectionFactory: () => connection,
    },
  );
  const subscription = agent.onError(() => {
    errors++;
    acknowledgeError();
  });
  let timer;
  try {
    if (mode === 'cancel') agent.kill();
    else
      await Promise.race([
        errorSeen,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Vendor watchdog did not fail closed')),
            3000,
          );
        }),
      ]);
    ready.fire();
    failed.fire(new Error('late worker failure'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      connections,
      0,
      'cancelled readiness reopened the output pipe',
    );
    assert.equal(
      errors,
      mode === 'timeout' ? 1 : 0,
      'late worker error escaped its cancellation fence',
    );
    assert.equal(agent.innerPid, 0, 'cancelled allocation started a shell');
    assert.equal(
      disposals,
      1,
      'native allocation was not released exactly once',
    );
    return { mode, connections, errors, pid: agent.innerPid, disposals };
  } finally {
    clearTimeout(timer);
    subscription.dispose();
    // The injected connection has no real reader worker; close its owned pipes.
    agent.inSocket.destroy();
    agent.outSocket.destroy();
  }
}
const cancelled = await observe('cancel');
const timedOut = await observe('timeout');
console.log(
  JSON.stringify({
    schema: 'station-pty-cancel-ready/1',
    status: 'PASS',
    cancelled,
    timedOut,
  }),
);
