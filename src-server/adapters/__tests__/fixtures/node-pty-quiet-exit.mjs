import { NodePtyAdapter } from '../../node-pty-adapter.ts';

if (process.platform !== 'win32') {
  throw new Error('The quiet ConPTY regression requires Windows');
}
const cwd = process.argv[2];
if (!cwd) throw new Error('The quiet ConPTY regression needs an owned folder');

const readerPorts = () =>
  process.getActiveResourcesInfo().filter((name) => name === 'MessagePort')
    .length;
const adapter = new NodePtyAdapter();
const capability = await adapter.probeCapability();
if (capability.state !== 'available') throw new Error(capability.reason);
const readerPortsBefore = readerPorts();
let terminal;
let exited = false;
let outputBytes = 0;
let exitCode;
let signal;
let unsubscribeData;

try {
  terminal = await adapter.spawn({
    shell: process.execPath,
    args: ['-e', 'setTimeout(() => process.exit(0), 250)'],
    cwd,
    cols: 80,
    rows: 24,
    env: process.env,
  });
  if (!Number.isInteger(terminal.pid) || terminal.pid <= 0) {
    throw new Error('Quiet PTY was published without a positive PID');
  }
  unsubscribeData = terminal.onData((chunk) => {
    outputBytes += Buffer.byteLength(chunk);
  });
  const event = await new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('Quiet PTY did not report its natural exit'));
    }, 5_000);
    unsubscribe = terminal.onExit((observation) => {
      exited = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(observation);
    });
  });
  exitCode = event.exitCode;
  signal = event.signal;
  if (exitCode !== 0) throw new Error(`Quiet PTY exited with code ${exitCode}`);
  if (signal !== null && signal !== 0)
    throw new Error(`Quiet PTY exited with signal ${signal}`);
  const deadline = Date.now() + 5_000;
  while (readerPorts() > readerPortsBefore && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const readerPortsAfter = readerPorts();
  if (readerPortsAfter > readerPortsBefore) {
    throw new Error(
      `Quiet PTY output reader did not retire: ${readerPortsBefore} before, ${readerPortsAfter} after`,
    );
  }
  if (outputBytes !== 0)
    throw new Error(`Quiet PTY produced ${outputBytes} output bytes`);
  console.log(
    JSON.stringify({
      schema: 'station-pty-quiet-exit/1',
      status: 'PASS',
      pid: terminal.pid,
      outputBytes,
      exitCode,
      signal,
      readerPortsBefore,
      readerPortsAfter,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      schema: 'station-pty-quiet-exit/1',
      status: 'FAIL',
      pid: terminal?.pid,
      exited,
      outputBytes,
      exitCode,
      signal,
      readerPortsBefore,
      readerPortsAfter: readerPorts(),
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
  if (terminal && !exited) {
    try {
      await terminal.terminate();
    } catch (cleanupError) {
      console.error(
        `Quiet PTY cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
  }
} finally {
  unsubscribeData?.();
}
// The launcher must retire naturally after the reader and its worker settle.
