import { NodePtyAdapter } from '../../node-pty-adapter.ts';

if (process.platform !== 'win32') {
  throw new Error('The native ConPTY regression requires Windows');
}

const count = 30;
const cwd = process.argv[2];
if (!cwd) throw new Error('The native ConPTY regression needs an owned folder');

const states = Array.from({ length: count }, (_, index) => ({
  index,
  process: null,
  ready: false,
  exited: false,
  text: '',
}));
let phase = 'starting';
let ready = 0;
let exited = 0;
let resizes = 0;
let resizeAfterExit = 0;
let resolveReady;
let resolveExited;
let rejectFailure;
const allReady = new Promise((resolve) => {
  resolveReady = resolve;
});
const allExited = new Promise((resolve) => {
  resolveExited = resolve;
});
const failure = new Promise((_, reject) => {
  rejectFailure = reject;
});
// A failed spawn may arrive before all of its sibling spawn promises settle.
void failure.catch(() => {});
const fail = (error) => rejectFailure(error);
const deadline = setTimeout(() => {
  const error = new Error(
    `Native PTY phase ${phase} stalled: ${ready}/${count} markers, ${exited}/${count} exits`,
  );
  console.error(error.message);
  fail(error);
}, 15_000);

const spawns = states.map(async (state) => {
  const marker = `STATION_PTY_RACE_READY_${state.index}`;
  const terminal = await new NodePtyAdapter().spawn({
    shell: process.env.COMSPEC ?? 'cmd.exe',
    args: ['/d', '/q', '/k', `echo ${marker}`],
    cwd,
    cols: 80,
    rows: 24,
    env: process.env,
  });
  state.process = terminal;
  terminal.onData((chunk) => {
    state.text = (state.text + chunk).slice(-1024);
    if (state.ready || !state.text.includes(marker)) return;
    state.ready = true;
    ready++;
    if (ready === count) resolveReady();
  });
  terminal.onExit((event) => {
    state.exited = true;
    exited++;
    if (!state.ready || phase !== 'exiting') {
      fail(
        new Error(`PTY ${state.index} exited before the concurrent exit phase`),
      );
    } else if (event.exitCode !== 0) {
      fail(new Error(`PTY ${state.index} exited with code ${event.exitCode}`));
    }
    if (exited === count) resolveExited();
  });
});

let problem;
try {
  await Promise.race([Promise.all(spawns), failure]);
  await Promise.race([allReady, failure]);
  phase = 'exiting';
  for (const state of states) state.process.write('exit\r');
  let round = 0;
  do {
    for (const active of states) {
      try {
        active.process.resize(81 + (round % 11), 25 + (round % 7));
        resizes++;
      } catch (error) {
        // A resize racing with an observed native exit must remain a safe refusal.
        if (
          !(error instanceof Error) ||
          error.message !== 'Cannot resize a pty that has already exited'
        )
          throw error;
        resizeAfterExit++;
      }
    }
    round++;
    await Promise.race([
      new Promise((resolve) => setTimeout(resolve, 1)),
      failure,
    ]);
  } while (exited < count || round < 30);
  await Promise.race([allExited, failure]);
} catch (error) {
  problem = error;
} finally {
  clearTimeout(deadline);
  await Promise.allSettled(spawns);
  const cleanup = await Promise.allSettled(
    states
      .filter((state) => state.process && !state.exited)
      .map((state) => state.process.terminate()),
  );
  const rejected = cleanup.find((entry) => entry.status === 'rejected');
  if (rejected) problem ??= rejected.reason;
}

if (problem) {
  console.error(
    JSON.stringify({
      schema: 'station-pty-concurrent-exit/1',
      status: 'FAIL',
      ready,
      exited,
      message: problem instanceof Error ? problem.message : String(problem),
    }),
  );
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify({
      schema: 'station-pty-concurrent-exit/1',
      status: 'PASS',
      started: states.length,
      ready,
      exited,
      resizes,
      resizeAfterExit,
    }),
  );
}
// Natural Node retirement also observes the addon's watcher-thread teardown.
