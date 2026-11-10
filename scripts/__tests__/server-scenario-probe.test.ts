import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  FIXTURE_TEST_TIMEOUT_MS,
  runBoundedFixture,
} from './helpers/bounded-fixture-process.mjs';

const makeTempDir = trackTempDirs();
const probe = pathToFileURL(
  resolve(import.meta.dirname, '../bench/server-scenario-probe.mjs'),
).href;

// Observe the actual histogram returned to the preload. Its native methods,
// clock, count and samples are unchanged; the response itself is passed through.
const observer = `
import perfHooks from 'node:perf_hooks';
import { syncBuiltinESMExports } from 'node:module';
const monitor = perfHooks.monitorEventLoopDelay;
let histogram;
perfHooks.monitorEventLoopDelay = function (...args) {
  histogram = Reflect.apply(monitor, this, args);
  const primed = () => {
    if (!process.connected) return;
    if (histogram.count === 0) return setImmediate(primed);
    process.send({ type: 'fixture-native-primed', count: histogram.count });
  };
  setImmediate(primed);
  return histogram;
};
syncBuiltinESMExports();
const actions = new Map();
const repliedIds = [];
process.on('message', (message) => {
  if (message?.type === 'server-scenario-probe')
    actions.set(message.id, message.action);
});
const send = process.send.bind(process);
process.send = function (message, ...args) {
  const reset = message?.type === 'server-scenario-probe' &&
    actions.get(message.id) === 'reset';
  const count = reset ? histogram.count : undefined;
  const result = send(message, ...args);
  if (reset) send({ type: 'fixture-reset-observation', id: message.id, count });
  if (message?.type === 'server-scenario-probe' && process.argv[3] === 'protocol') {
    repliedIds.push(message.id);
    send({
      type: 'fixture-probe-reply-boundary', id: message.id,
      repliedIds: [...repliedIds], nativeCount: histogram.count,
    });
  }
  if (message?.type === 'server-scenario-probe') actions.delete(message.id);
  return result;
};
await import(process.argv[2]);
`;

const action = `
process.on('message', (message) => {
  if (message?.type === 'fixture-probe-batch') {
    // Same-child-turn delivery to the real handler, not another IPC transport proof.
    for (const request of message.requests) process.emit('message', request);
    process.send({ type: 'fixture-probe-batch-dispatched', id: message.id });
    return;
  }
  if (message?.type !== 'fixture-block') return;
  const started = performance.now();
  while (performance.now() - started < 80) {}
  process.send({
    type: 'fixture-block-complete', id: message.id,
    actionMs: performance.now() - started,
  });
});
process.once('disconnect', () => process.exit(0));
process.send({ type: 'fixture-ready' });
`;

// The shared bounded fixture owns this driver and its IPC child as one tree.
// No Station server, home, socket or native addon is started by this fixture.
const driver = `
import { fork } from 'node:child_process';
const [probe, observer, entry, mode = 'first-stall', input = '{}'] = process.argv.slice(2);
const fixtureArgs = mode === 'first-stall' ? [probe] : [probe, 'protocol'];
const child = fork(entry, fixtureArgs, {
  execArgv: ['--import', observer],
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  windowsHide: true,
});
const lifecycle = { exit: null, disconnected: false, errors: [] };
child.on('error', (error) => lifecycle.errors.push(error.stack));
const exited = new Promise((resolve) => {
  child.once('exit', (code, signal) => {
    lifecycle.exit = { code, signal };
    resolve(lifecycle.exit);
  });
});
const disconnected = new Promise((resolve) => {
  child.once('disconnect', () => {
    lifecycle.disconnected = true;
    resolve();
  });
});
function response(type, id, send) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(Error('fixture reply timed out: ' + type)), 2000);
    function finish(error, value) {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
      child.off('disconnect', onDisconnect);
      error ? reject(error) : resolve(value);
    }
    function onMessage(value) {
      if (value?.type === type && (id === undefined || value.id === id))
        finish(undefined, value);
    }
    function onError(error) { finish(error); }
    function onExit(code, signal) {
      finish(Error('fixture exited before reply: ' + code + '/' + signal));
    }
    function onDisconnect() { finish(Error('fixture disconnected before reply')); }
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
    child.once('disconnect', onDisconnect);
    try { send?.(); } catch (error) { finish(error); }
  });
}
const receipt = {};
let failure;
let cleanupFailure;
try {
  const [, primed] = await Promise.all([
    response('fixture-ready'), response('fixture-native-primed'),
  ]);
  receipt.nativeCountBeforeReset = primed.count;
  if (mode === 'invalid-budget') {
    const invalid = JSON.parse(input);
    const request = { type: 'server-scenario-probe', id: 10, action: 'sample' };
    if (Object.hasOwn(invalid, 'value')) request.remainingBudgetMs = invalid.value;
    receipt.reply = await response('server-scenario-probe', 10, () => child.send(request));
  } else if (mode === 'overlap' || mode === 'cancel-other') {
    const first = response('server-scenario-probe', 10);
    const overlapping = response('server-scenario-probe', 11);
    const boundary = response('fixture-probe-reply-boundary', 10);
    const dispatched = response('fixture-probe-batch-dispatched', 100);
    child.send({
      type: 'fixture-probe-batch', id: 100, requests: [
        { type: 'server-scenario-probe', id: 10, action: 'reset', remainingBudgetMs: 1000 },
        ...(mode === 'cancel-other'
          ? [{ type: 'server-scenario-probe', id: 999, action: 'cancel' }] : []),
        { type: 'server-scenario-probe', id: 11, action: 'sample', remainingBudgetMs: 1000 },
      ],
    });
    [receipt.first, receipt.overlapping, receipt.boundary] =
      await Promise.all([first, overlapping, boundary, dispatched]);
    receipt.delivery = 'fixture process.emit batch in one child turn';
  } else if (mode === 'cancel') {
    const fresh = response('server-scenario-probe', 12);
    const boundary = response('fixture-probe-reply-boundary', 12);
    const dispatched = response('fixture-probe-batch-dispatched', 100);
    child.send({
      type: 'fixture-probe-batch', id: 100, requests: [
        { type: 'server-scenario-probe', id: 10, action: 'reset', remainingBudgetMs: 1000 },
        { type: 'server-scenario-probe', id: 10, action: 'cancel' },
        { type: 'server-scenario-probe', id: 12, action: 'reset', remainingBudgetMs: 1000 },
      ],
    });
    [receipt.fresh, receipt.boundary] = await Promise.all([fresh, boundary, dispatched]);
    receipt.delivery = 'fixture process.emit batch in one child turn';
  } else {
  const [reset, observation] = await Promise.all([
    response('server-scenario-probe', 1, () => child.send({
      type: 'server-scenario-probe', id: 1, action: 'reset', remainingBudgetMs: 1000,
    })),
    response('fixture-reset-observation', 1),
  ]);
  receipt.nativeCountAtResetReply = observation.count;
  if (reset.error) throw Error(reset.error);
  const actionStarted = performance.now();
  const blocked = await response('fixture-block-complete', 2, () => child.send({
    type: 'fixture-block', id: 2,
  }));
  const actionRoundTripMs = performance.now() - actionStarted;
  receipt.actionMs = blocked.actionMs;
  receipt.actionRoundTripMs = actionRoundTripMs;
  const sample = await response('server-scenario-probe', 3, () => child.send({
    type: 'server-scenario-probe', id: 3, action: 'sample', remainingBudgetMs: 1000,
  }));
  receipt.sample = sample;
  if (sample.error) throw Error(sample.error);
  }
} catch (error) {
  failure = error;
} finally {
  let timer;
  try {
    if (child.connected) child.disconnect();
    const [result] = await Promise.race([
      Promise.all([exited, disconnected]),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('fixture child exit/disconnect timed out: ' +
          JSON.stringify({ ...lifecycle, connected: child.connected,
            exitCode: child.exitCode, signalCode: child.signalCode }))), 2000);
      }),
    ]);
    if (result.code !== 0 || result.signal !== null || lifecycle.errors.length)
      throw Error('fixture child did not exit cleanly: ' + JSON.stringify(lifecycle));
    receipt.childLifecycle = lifecycle;
  } catch (error) {
    cleanupFailure = error;
  } finally {
    clearTimeout(timer);
  }
}
if (failure || cleanupFailure) {
  console.error(JSON.stringify({
    failure: failure?.stack, cleanupFailure: cleanupFailure?.stack, receipt,
  }));
  if (failure && cleanupFailure)
    throw new AggregateError([failure, cleanupFailure], 'fixture and cleanup failed');
  throw failure ?? cleanupFailure;
}
console.log(JSON.stringify(receipt));
`;

test(
  'probe reset acknowledgement primes the native histogram before the first synchronous action',
  async () => {
    const directory = makeTempDir('server-scenario-probe-');
    const observerPath = join(directory, 'observer.mjs');
    const actionPath = join(directory, 'action.mjs');
    const driverPath = join(directory, 'driver.mjs');
    writeFileSync(observerPath, observer);
    writeFileSync(actionPath, action);
    writeFileSync(driverPath, driver);
    const result = await runBoundedFixture(
      process.execPath,
      [driverPath, probe, pathToFileURL(observerPath).href, actionPath],
      { cwd: directory, maxOutputBytes: 64 * 1024 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.signal, result.stderr).toBeNull();
    const receipt = JSON.parse(result.stdout);
    console.info('native histogram reset boundary', receipt);
    expect(receipt.nativeCountBeforeReset).toBeGreaterThan(0);
    expect(receipt.nativeCountAtResetReply, result.stdout).toBeGreaterThan(0);
    expect(receipt.actionMs).toBeGreaterThanOrEqual(80);
    expect(receipt.sample.eventLoopDelayMs.samples).toBeGreaterThan(0);
    expect(receipt.sample.eventLoopDelayMs.max).toBeGreaterThanOrEqual(60);
  },
  FIXTURE_TEST_TIMEOUT_MS,
);

async function runProtocolFixture(
  mode: string,
  input: { value?: number | null } = {},
) {
  const directory = makeTempDir('server-scenario-protocol-');
  const observerPath = join(directory, 'observer.mjs');
  const actionPath = join(directory, 'action.mjs');
  const driverPath = join(directory, 'driver.mjs');
  writeFileSync(observerPath, observer);
  writeFileSync(actionPath, action);
  writeFileSync(driverPath, driver);
  const result = await runBoundedFixture(
    process.execPath,
    [
      driverPath,
      probe,
      pathToFileURL(observerPath).href,
      actionPath,
      mode,
      JSON.stringify(input),
    ],
    { cwd: directory, maxOutputBytes: 64 * 1024 },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.signal, result.stderr).toBeNull();
  const receipt = JSON.parse(result.stdout);
  expect(receipt.nativeCountBeforeReset).toBeGreaterThan(0);
  expect(receipt.childLifecycle).toEqual({
    exit: { code: 0, signal: null },
    disconnected: true,
    errors: [],
  });
  return receipt;
}

test.each([
  { label: 'zero', input: { value: 0 } },
  { label: 'negative', input: { value: -1 } },
  { label: 'above maximum', input: { value: 30001 } },
  { label: 'null', input: { value: null } },
  { label: 'missing', input: {} },
])(
  'probe rejects invalid budget $label through real IPC',
  async ({ input }) => {
    const receipt = await runProtocolFixture('invalid-budget', input);
    expect(receipt.reply).toEqual({
      type: 'server-scenario-probe',
      id: 10,
      error: 'invalid probe budget or action',
    });
  },
  FIXTURE_TEST_TIMEOUT_MS,
);

test(
  'probe refuses overlap delivered in one fixture message batch',
  async () => {
    const receipt = await runProtocolFixture('overlap');
    expect(receipt.delivery).toBe(
      'fixture process.emit batch in one child turn',
    );
    expect(receipt.first).toEqual({
      type: 'server-scenario-probe',
      id: 10,
      reset: true,
    });
    expect(receipt.overlapping).toEqual({
      type: 'server-scenario-probe',
      id: 11,
      error: 'probe request overlaps a pending operation',
    });
    expect(receipt.boundary.nativeCount).toBeGreaterThan(0);
    expect(receipt.boundary.repliedIds).toEqual([11, 10]);
  },
  FIXTURE_TEST_TIMEOUT_MS,
);

test(
  'probe cancellation retires its id before a fresh reset reply in one fixture message batch',
  async () => {
    const receipt = await runProtocolFixture('cancel');
    expect(receipt.delivery).toBe(
      'fixture process.emit batch in one child turn',
    );
    expect(receipt.fresh).toEqual({
      type: 'server-scenario-probe',
      id: 12,
      reset: true,
    });
    // The negative barrier is the fresh native-primed reply itself, not a sleep
    // or a claim that an arbitrary amount of future time has been observed.
    expect(receipt.boundary.nativeCount).toBeGreaterThan(0);
    expect(receipt.boundary.repliedIds).toEqual([12]);
  },
  FIXTURE_TEST_TIMEOUT_MS,
);

test(
  'probe ignores cancellation of another id in one fixture message batch',
  async () => {
    const receipt = await runProtocolFixture('cancel-other');
    expect(receipt.first).toEqual({
      type: 'server-scenario-probe',
      id: 10,
      reset: true,
    });
    expect(receipt.overlapping).toEqual({
      type: 'server-scenario-probe',
      id: 11,
      error: 'probe request overlaps a pending operation',
    });
    expect(receipt.boundary.nativeCount).toBeGreaterThan(0);
    expect(receipt.boundary.repliedIds).toEqual([11, 10]);
  },
  FIXTURE_TEST_TIMEOUT_MS,
);
