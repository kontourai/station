// @ts-check
/**
 * A stand-in workload host that speaks the supervisor's workload protocol
 * (protocol 1.3) with plain child processes and an in-memory journal: the
 * real host lives in the core server's tree because it needs node-pty. Both
 * kinds run on pipes here. Messages are typed against `protocol.ts`.
 *
 * Environment:
 *   FAKE_HOST_PID_FILE=<path>   write this host's pid there on start
 *
 * @import { WorkloadEventMessage, WorkloadExit, WorkloadInfo, WorkloadRequest, WorkloadResponseMessage } from '../../protocol.ts'
 */
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

if (typeof process.send !== 'function') {
  process.stderr.write('fake-workload-host: needs an IPC channel\n');
  process.exit(3);
}
if (process.env.FAKE_HOST_PID_FILE)
  writeFileSync(process.env.FAKE_HOST_PID_FILE, String(process.pid));

/** @param {unknown} message */
function send(message) {
  /** @type {any} */ (process).send(message);
}

/**
 * @typedef {{
 *   info: WorkloadInfo,
 *   child: import('node:child_process').ChildProcess,
 *   records: { seq: number, data: string }[],
 *   exited: Promise<void>,
 * }} Workload
 */
/** @type {Map<string, Workload>} */
const workloads = new Map();

/** Kills a workload's whole tree, as the real host does. */
/** @param {Workload} workload */
function killTree(workload) {
  const pid = workload.info.pid;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    workload.child.kill('SIGKILL');
  }
}

/** @param {WorkloadRequest} request @returns {Promise<unknown>} */
async function handle(request) {
  if (request.op === 'list') return [...workloads.values()].map((w) => w.info);
  if (request.op === 'spawn') {
    if (workloads.has(request.workloadId)) throw ['exists', 'workload exists'];
    const candidate = request.candidates[0];
    if (!candidate) throw ['bad-request', 'no candidates'];
    const child = spawn(candidate.command, candidate.args, {
      cwd: request.cwd,
      env: request.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const pid = child.pid;
    if (pid === undefined) throw ['failed', 'spawn failed'];
    /** @type {(value?: void) => void} */
    let done = () => {};
    /** @type {Workload} */
    const workload = {
      info: {
        workloadId: request.workloadId,
        kind: request.kind,
        pid,
        cols: request.cols,
        rows: request.rows,
        lastSeq: 0,
        state: 'running',
      },
      child,
      records: [],
      exited: new Promise((resolve) => {
        done = resolve;
      }),
    };
    /** @param {Buffer} chunk */
    const onData = (chunk) => {
      const seq = workload.info.lastSeq + 1;
      workload.records.push({ seq, data: chunk.toString('utf8') });
      workload.info.lastSeq = seq;
      send(
        /** @type {WorkloadEventMessage} */ ({
          type: 'workload.event',
          workloadId: request.workloadId,
          event: 'output',
          lastSeq: seq,
        }),
      );
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', (code) => {
      /** @type {WorkloadExit} */
      const exit = {
        exitCode: code ?? -1,
        signal: null,
        outputIncomplete: false,
        journalFailed: false,
      };
      workload.info.state = 'exited';
      workload.info.exit = exit;
      send(
        /** @type {WorkloadEventMessage} */ ({
          type: 'workload.event',
          workloadId: request.workloadId,
          event: 'exit',
          exit,
        }),
      );
      done();
    });
    workloads.set(request.workloadId, workload);
    return workload.info;
  }
  const workload = workloads.get(request.workloadId);
  if (!workload) throw ['not-found', 'no such workload'];
  switch (request.op) {
    case 'write':
      workload.child.stdin?.write(request.data);
      return null;
    case 'resize':
      workload.info.cols = request.cols;
      workload.info.rows = request.rows;
      return null;
    case 'signal':
      workload.child.kill(request.signal);
      return null;
    case 'terminate':
      if (workload.info.state === 'running') killTree(workload);
      await workload.exited;
      return workload.info;
    case 'attach':
      return workload.info;
    case 'flush':
      return null;
    case 'read': {
      const records = workload.records.filter((r) => r.seq > request.fromSeq);
      return {
        firstSeq: workload.records[0]?.seq ?? 1,
        lastSeq: workload.info.lastSeq,
        reset: false,
        records,
      };
    }
  }
  throw ['bad-request', 'unknown op'];
}

async function stopAll() {
  await Promise.all(
    [...workloads.values()].map(async (workload) => {
      if (workload.info.state === 'running') killTree(workload);
      await workload.exited;
    }),
  );
  process.exit(0);
}

process.on('message', (/** @type {any} */ message) => {
  if (message?.type === 'host.stop') {
    void stopAll();
    return;
  }
  if (message?.type !== 'workload.request') return;
  handle(message.request).then(
    (result) =>
      send(
        /** @type {WorkloadResponseMessage} */ ({
          type: 'workload.response',
          id: message.id,
          ok: true,
          result,
        }),
      ),
    (/** @type {unknown} */ error) => {
      const [code, text] = Array.isArray(error)
        ? error
        : ['failed', String(error)];
      send({
        type: 'workload.response',
        id: message.id,
        ok: false,
        code,
        message: text,
      });
    },
  );
});
process.on('disconnect', () => void stopAll());
send({ type: 'host.ready' });
