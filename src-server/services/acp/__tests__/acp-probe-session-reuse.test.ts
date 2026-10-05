import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ACPProbe } from '../acp-probe.js';

/**
 * #3411: a capability probe must not leave a new stored session behind on
 * every run. These tests drive the REAL probe path — `ACPProbe.probe()` with
 * its default factory, so a real `ACPProcess` spawns a real child and speaks
 * ACP over stdio — against a fake agent that persists each session as a file
 * (the way agents with on-disk session stores do) and logs every method it
 * receives. The store's size is the leak; the method log is how it was (or
 * was not) avoided.
 */
const FAKE_AGENT = `
const fs = require('node:fs');
const path = require('node:path');
const [storeDir, logPath, capsJson] = process.argv.slice(2);
const caps = JSON.parse(capsJson);
let counter = 0;
const log = (method, params) =>
  fs.appendFileSync(logPath, JSON.stringify({ method, sessionId: params && params.sessionId }) + '\\n');
const sessionFile = (id) => path.join(storeDir, id + '.json');
const capabilityAnswer = {
  modes: { availableModes: [{ id: 'code', name: 'Code' }, { id: 'ask', name: 'Ask' }], currentModeId: 'code' },
  configOptions: [{ id: 'model', name: 'Model', type: 'select', currentValue: 'm1', options: [{ value: 'm1', name: 'M1' }] }],
};
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
const fail = (id, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message } }) + '\\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const { id, method, params } = JSON.parse(line);
    log(method, params);
    switch (method) {
      case 'initialize':
        reply(id, { protocolVersion: 1, agentCapabilities: caps });
        break;
      case 'session/new': {
        const sessionId = 'sess-' + process.pid + '-' + ++counter;
        fs.writeFileSync(sessionFile(sessionId), JSON.stringify({ cwd: params.cwd, updatedAt: new Date().toISOString() }));
        reply(id, { sessionId, ...capabilityAnswer });
        break;
      }
      case 'session/resume':
      case 'session/load': {
        if (caps._meta && caps._meta.hangReattach) break;
        if (!fs.existsSync(sessionFile(params.sessionId))) { fail(id, 'Path not found.'); break; }
        reply(id, capabilityAnswer);
        break;
      }
      case 'session/list': {
        const sessions = fs.readdirSync(storeDir).map((name) => ({
          sessionId: name.replace(/\\.json$/, ''),
          ...JSON.parse(fs.readFileSync(path.join(storeDir, name), 'utf8')),
        })).filter((session) => !params.cwd || session.cwd === params.cwd);
        reply(id, { sessions });
        break;
      }
      case 'session/delete':
        fs.unlinkSync(sessionFile(params.sessionId));
        reply(id, {});
        break;
      default:
        fail(id, 'unexpected ' + method);
    }
  }
});
`;

const EXPECTED_MODES = [
  { id: 'code', name: 'Code' },
  { id: 'ask', name: 'Ask' },
];
const EXPECTED_CONFIG_OPTIONS = [
  {
    id: 'model',
    name: 'Model',
    type: 'select',
    currentValue: 'm1',
    options: [{ value: 'm1', name: 'M1' }],
  },
];

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fakeAgent(agentCapabilities: Record<string, unknown>) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'station-acp-probe-session-')),
  );
  roots.push(root);
  const store = join(root, 'store');
  mkdirSync(store);
  const agentPath = join(root, 'agent.cjs');
  writeFileSync(agentPath, FAKE_AGENT);
  const logPath = join(root, 'methods.log');
  const stationHome = join(root, 'home');
  const config: ACPConnectionConfig = {
    id: 'fake-agent',
    name: 'Fake agent',
    command: process.execPath,
    args: [agentPath, store, logPath, JSON.stringify(agentCapabilities)],
    enabled: true,
  };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
  return {
    root,
    config,
    logger,
    stationHome,
    newProbe: (
      overrides: Partial<ACPConnectionConfig> = {},
      operationTimeoutMs?: number,
    ) =>
      new ACPProbe(
        { ...config, ...overrides },
        logger,
        stationHome,
        undefined,
        operationTimeoutMs,
      ),
    storedSessions: () => readdirSync(store),
    store,
    methods: (): string[] =>
      existsSync(logPath)
        ? readFileSync(logPath, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line).method)
            .filter((method: string) => method !== 'initialize')
        : [],
  };
}

async function probeTimes(probe: ACPProbe, times: number) {
  for (let run = 0; run < times; run += 1) {
    await expect(probe.probe()).resolves.toBe(true);
    expect(probe.getModes()).toEqual(EXPECTED_MODES);
    expect(probe.getConfigOptions()).toEqual(EXPECTED_CONFIG_OPTIONS);
  }
}

describe('#3411 capability probes do not leak agent sessions', () => {
  test('an agent that can resume keeps exactly one probe session across repeated probes and a restart', async () => {
    const agent = fakeAgent({
      loadSession: true,
      sessionCapabilities: { list: {}, resume: {} },
    });
    const probe = agent.newProbe();
    try {
      await probeTimes(probe, 4);
    } finally {
      await probe.dispose();
    }
    expect(agent.methods()).toEqual([
      'session/list',
      'session/new',
      'session/resume',
      'session/resume',
      'session/resume',
    ]);
    expect(agent.storedSessions()).toHaveLength(1);

    // A Station restart (or a connection re-registration) builds a fresh
    // ACPProbe with no in-memory session. It recovers the stored probe
    // session through session/list instead of minting a second one.
    const restarted = agent.newProbe();
    try {
      await probeTimes(restarted, 2);
    } finally {
      await restarted.dispose();
    }
    expect(agent.methods().slice(5)).toEqual([
      'session/list',
      'session/resume',
      'session/resume',
    ]);
    expect(agent.storedSessions()).toHaveLength(1);
  }, 30_000);

  test('an agent that can only load reattaches with session/load', async () => {
    const agent = fakeAgent({ loadSession: true });
    const probe = agent.newProbe();
    try {
      await probeTimes(probe, 3);
    } finally {
      await probe.dispose();
    }
    expect(agent.methods()).toEqual([
      'session/new',
      'session/load',
      'session/load',
    ]);
    expect(agent.storedSessions()).toHaveLength(1);
  }, 30_000);

  test('an agent that can delete keeps no probe session at all', async () => {
    const agent = fakeAgent({
      loadSession: true,
      sessionCapabilities: { list: {}, resume: {}, delete: {} },
    });
    const probe = agent.newProbe();
    try {
      await probeTimes(probe, 3);
    } finally {
      await probe.dispose();
    }
    expect(agent.methods()).toEqual([
      'session/new',
      'session/delete',
      'session/new',
      'session/delete',
      'session/new',
      'session/delete',
    ]);
    expect(agent.storedSessions()).toHaveLength(0);
  }, 30_000);

  test('a retained session the agent no longer has is replaced, and the probe still succeeds', async () => {
    const agent = fakeAgent({ sessionCapabilities: { resume: {} } });
    const probe = agent.newProbe();
    try {
      await probeTimes(probe, 1);
      for (const name of agent.storedSessions()) {
        unlinkSync(join(agent.store, name));
      }
      await probeTimes(probe, 2);
    } finally {
      await probe.dispose();
    }
    expect(agent.methods()).toEqual([
      'session/new',
      'session/resume',
      'session/new',
      'session/resume',
    ]);
    expect(agent.storedSessions()).toHaveLength(1);
    expect(agent.logger.warn).toHaveBeenCalledWith(
      'ACPProbe could not reattach its probe session; creating a new one',
      expect.objectContaining({ id: 'fake-agent', step: 'resume' }),
    );
  }, 30_000);

  test('a reattach that never answers costs one failed probe, not every later one', async () => {
    const agent = fakeAgent({
      sessionCapabilities: { resume: {} },
      _meta: { hangReattach: true },
    });
    const probe = agent.newProbe({}, 1_500);
    try {
      await probeTimes(probe, 1);
      // The hung session/resume times out within the probe budget...
      await expect(probe.probe()).resolves.toBe(false);
      expect(probe.getModes()).toEqual(EXPECTED_MODES);
      // ...and the next probe skips reattaching rather than hanging again.
      await probeTimes(probe, 1);
    } finally {
      await probe.dispose();
    }
    expect(agent.methods()).toEqual([
      'session/new',
      'session/resume',
      'session/new',
    ]);
  }, 30_000);

  test('a user-configured directory is never searched for a session to adopt', async () => {
    const agent = fakeAgent({ sessionCapabilities: { list: {}, resume: {} } });
    const userDir = join(agent.root, 'user-project');
    mkdirSync(userDir);
    // One of the user's own sessions in that directory.
    writeFileSync(
      join(agent.store, 'user-session.json'),
      JSON.stringify({ cwd: userDir, updatedAt: new Date().toISOString() }),
    );
    const probe = agent.newProbe({ cwd: userDir });
    try {
      await probeTimes(probe, 2);
    } finally {
      await probe.dispose();
    }
    expect(agent.methods()).toEqual(['session/new', 'session/resume']);
    const stored = agent.storedSessions();
    expect(stored).toHaveLength(2);
    expect(stored).toContain('user-session.json');
  }, 30_000);

  test('an agent with no session lifecycle still probes successfully, and Station says what it cannot clean up', async () => {
    const agent = fakeAgent({});
    const probe = agent.newProbe();
    try {
      await probeTimes(probe, 2);
    } finally {
      await probe.dispose();
    }
    expect(agent.methods()).toEqual(['session/new', 'session/new']);
    expect(agent.storedSessions()).toHaveLength(2);
    const unmanagedWarnings = agent.logger.warn.mock.calls.filter(
      ([message]) =>
        message ===
        'ACP agent advertises no session resume, load, or delete; each capability probe leaves a new session in its store',
    );
    expect(unmanagedWarnings).toHaveLength(1);
  }, 30_000);
});
