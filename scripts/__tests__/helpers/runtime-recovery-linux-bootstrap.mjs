import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { invokedDirectly } from '../../lib/module-entry.mjs';

/** @typedef {{pid: number, birth: string, uids: number[], caps: string[], nnp: number}} RuntimeRecoveryProcess */
/** @typedef {{version: number, root: string, release: string, scopeNonce: string, workerPid: number, workerBirth: string, uid: number, runtimePath: string, runtimeDigest: string}} RuntimeRecoveryRequest */
/** @typedef {RuntimeRecoveryRequest & {launchNonce: string, command: string, actor: RuntimeRecoveryProcess}} RuntimeRecoveryReceipt */
/** @param {string} path */
const readProc = (path) => readFileSync(path, 'utf8');

/** Selected proc fields only; bind both status samples to the same birth.
 * @param {number} pid
 * @param {(path: string) => string} read
 * @returns {RuntimeRecoveryProcess}
 */
export function readRuntimeRecoveryProcess(pid, read = readProc) {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error('Invalid fixture PID');
  const stat = () => {
    const value = read(`/proc/${pid}/stat`);
    if (!value.startsWith(`${pid} (`)) throw new Error('Invalid fixture PID');
    const fields = value
      .slice(value.lastIndexOf(')') + 1)
      .trim()
      .split(/\s+/);
    if (
      !/^[RSDZTtWXxKWPIN]$/.test(fields[0] ?? '') ||
      !/^\d{1,10}$/.test(fields[1] ?? '') ||
      !/^\d{1,20}$/.test(fields[6] ?? '') ||
      !/^\d{1,20}$/.test(fields[19] ?? '')
    )
      throw new Error('Invalid fixture stat');
    return `${fields[1]}:${fields[6]}:${fields[19]}`;
  };
  const status = () => {
    const value = read(`/proc/${pid}/status`);
    const uids =
      /^Uid:[ \t]*(\d{1,10})[ \t]+(\d{1,10})[ \t]+(\d{1,10})[ \t]+(\d{1,10})$/m
        .exec(value)
        ?.slice(1)
        .map(Number);
    const caps = ['CapEff', 'CapPrm', 'CapInh', 'CapAmb'].map((key) => {
      const match = new RegExp(`^${key}:[ \\t]*([a-fA-F0-9]{16})$`, 'm').exec(
        value,
      );
      if (!match) throw new Error('Missing fixture capabilities');
      return match[1].toLowerCase();
    });
    const statusPid = /^Pid:[ \t]*(\d{1,10})$/m.exec(value)?.[1];
    const tgid = /^Tgid:[ \t]*(\d{1,10})$/m.exec(value)?.[1];
    const nnp = /^NoNewPrivs:[ \t]*([01])$/m.exec(value)?.[1];
    if (
      !uids ||
      !uids.every(
        (uid) => Number.isSafeInteger(uid) && uid >= 0 && uid < 4294967295,
      ) ||
      statusPid !== String(pid) ||
      tgid !== String(pid) ||
      nnp === undefined
    )
      throw new Error('Missing fixture credentials');
    return { uids, caps, nnp: Number(nnp) };
  };
  const boot = read('/proc/sys/kernel/random/boot_id').trim();
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(boot)
  )
    throw new Error('Invalid fixture boot identity');
  const before = stat();
  const first = status();
  const second = status();
  if (
    before !== stat() ||
    JSON.stringify(first) !== JSON.stringify(second) ||
    boot !== read('/proc/sys/kernel/random/boot_id').trim()
  )
    throw new Error('Fixture process identity or credentials changed');
  return { pid, birth: `linux:${boot}:${before.split(':')[2]}`, ...first };
}

/** This is fixture launch evidence, not a general sandbox or broker policy.
 * @param {RuntimeRecoveryProcess} sample
 * @param {number} uid
 * @param {boolean} requireNnp
 */
export function assertRuntimeRecoveryCredentials(sample, uid, requireNnp) {
  if (
    !Number.isSafeInteger(uid) ||
    uid <= 0 ||
    !Array.isArray(sample?.uids) ||
    sample.uids.length !== 4 ||
    !sample.uids.every((value) => value === uid) ||
    !Array.isArray(sample?.caps) ||
    sample.caps.length !== 4 ||
    !sample.caps.every((value) => value === '0000000000000000') ||
    (sample.nnp !== 0 && sample.nnp !== 1) ||
    (requireNnp && sample.nnp !== 1)
  )
    throw new Error('Runtime recovery requires an unprivileged fixture actor');
}

/**
 * @param {RuntimeRecoveryRequest} request
 * @param {number} actorPid
 * @param {string} command
 * @param {(path: string) => string} read
 * @returns {RuntimeRecoveryReceipt}
 */
export function attestRuntimeRecoveryLaunch(
  request,
  actorPid,
  command,
  read = readProc,
) {
  const worker = readRuntimeRecoveryProcess(request.workerPid, read);
  const actor = readRuntimeRecoveryProcess(actorPid, read);
  assertRuntimeRecoveryCredentials(worker, request.uid, false);
  assertRuntimeRecoveryCredentials(actor, request.uid, true);
  const workerBirth = /^linux:([^:]+):(\d+)$/.exec(worker.birth);
  const actorBirth = /^linux:([^:]+):(\d+)$/.exec(actor.birth);
  if (
    worker.birth !== request.workerBirth ||
    !workerBirth ||
    !actorBirth ||
    actorBirth[1] !== workerBirth[1] ||
    BigInt(actorBirth[2]) < BigInt(workerBirth[2])
  )
    throw new Error('Runtime recovery launch identity changed');
  return {
    ...request,
    launchNonce: randomUUID(),
    workerPid: worker.pid,
    workerBirth: worker.birth,
    uid: request.uid,
    command,
    actor,
  };
}

if (invokedDirectly(import.meta.url)) {
  if (process.platform !== 'linux')
    throw new Error('Linux fixture bootstrap required');
  const requestPath = resolve(process.argv[2]);
  const request = JSON.parse(readFileSync(requestPath, 'utf8'));
  const release = realpathSync(process.cwd());
  const root = realpathSync(request.root);
  const within = relative(root, release);
  if (
    request.version !== 1 ||
    request.release !== release ||
    request.root !== root ||
    !within ||
    within.startsWith('..') ||
    resolve(requestPath) !==
      resolve(release, `.station-fixture-${request.scopeNonce}.json`) ||
    !/^[a-f0-9-]{36}$/.test(request.scopeNonce)
  )
    throw new Error('Runtime recovery fixture root binding changed');
  const expectedFixture = fileURLToPath(
    new URL('../fixtures/dogfood-runtime-fixture.mjs', import.meta.url),
  );
  const runtime = readFileSync(request.runtimePath);
  if (
    !runtime.equals(readFileSync(expectedFixture)) ||
    createHash('sha256').update(runtime).digest('hex') !== request.runtimeDigest
  )
    throw new Error('Runtime recovery listener fixture changed');
  const receipt = attestRuntimeRecoveryLaunch(
    request,
    process.pid,
    process.argv[3],
  );
  appendFileSync(`${requestPath}l`, `${JSON.stringify(receipt)}\n`, {
    mode: 0o600,
  });
  // Register only after the permanent privilege restriction has been checked.
  const { register } = await import('tsx/esm/api');
  register();
  const cli = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../..',
    'scripts/station-cli.ts',
  );
  process.argv = [process.execPath, cli, ...process.argv.slice(3)];
  await import(pathToFileURL(cli).href);
}
