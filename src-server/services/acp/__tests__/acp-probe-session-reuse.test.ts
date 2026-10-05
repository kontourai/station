import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ACPProbe } from '../acp-probe.js';
import { PROBE_SESSION_REFRESH_MS } from '../acp-probe-session.js';

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
const [storeDir, logPath, capsJson, settingsDir] = process.argv.slice(2);
const caps = JSON.parse(capsJson);
// The agent's own settings, which the user can change between probes.
const setting = (name, fallback) => {
  const file = path.join(settingsDir, name);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : fallback;
};
let counter = 0;
const log = (method, params) =>
  fs.appendFileSync(logPath, JSON.stringify({ method, sessionId: params && params.sessionId }) + '\\n');
const sessionFile = (id) => path.join(storeDir, id + '.json');
// Like Grok Build: session/new answers with the agent's CURRENT default
// model, and a reattach answers with the model stored in that session.
const capabilityAnswer = (model) => ({
  modes: { availableModes: [{ id: 'code', name: 'Code' }, { id: 'ask', name: 'Ask' }], currentModeId: 'code' },
  configOptions: [{ id: 'model', name: 'Model', type: 'select', currentValue: model, options: [{ value: model, name: model }] }],
});
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
        // Grok Build sends no agentInfo at all; _meta.noAgentInfo mimics it.
        reply(id, { protocolVersion: 1, agentCapabilities: caps, ...(caps._meta && caps._meta.noAgentInfo ? {} : { agentInfo: { name: 'fake-agent', version: setting('version', '1.0.0') } }) });
        break;
      case 'session/new': {
        const sessionId = 'sess-' + process.pid + '-' + ++counter;
        const model = setting('default-model', 'm1');
        fs.writeFileSync(sessionFile(sessionId), JSON.stringify({ cwd: params.cwd, model, updatedAt: new Date().toISOString() }));
        reply(id, { sessionId, ...capabilityAnswer(model) });
        break;
      }
      case 'session/resume':
      case 'session/load': {
        if (caps._meta && caps._meta.hangReattach) break;
        if (!fs.existsSync(sessionFile(params.sessionId))) { fail(id, 'Path not found.'); break; }
        reply(id, capabilityAnswer(JSON.parse(fs.readFileSync(sessionFile(params.sessionId), 'utf8')).model));
        break;
      }
      case 'session/list': {
        // Ignores params.cwd on purpose: an agent may list every session.
        const sessions = fs.readdirSync(storeDir).map((name) => ({
          sessionId: name.replace(/\\.json$/, ''),
          ...JSON.parse(fs.readFileSync(path.join(storeDir, name), 'utf8')),
        }));
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
const expectedConfigOptions = (model: string) => [
  {
    id: 'model',
    name: 'Model',
    type: 'select',
    currentValue: model,
    options: [{ value: model, name: model }],
  },
];

const makeTempDir = trackTempDirs();

function fakeAgent(agentCapabilities: Record<string, unknown>) {
  const root = realpathSync(makeTempDir('station-acp-probe-session-'));
  const store = join(root, 'store');
  mkdirSync(store);
  const agentPath = join(root, 'agent.cjs');
  writeFileSync(agentPath, FAKE_AGENT);
  const logPath = join(root, 'methods.log');
  const stationHome = join(root, 'home');
  const settings = join(root, 'settings');
  mkdirSync(settings);
  const config: ACPConnectionConfig = {
    id: 'fake-agent',
    name: 'Fake agent',
    command: process.execPath,
    args: [
      agentPath,
      store,
      logPath,
      JSON.stringify(agentCapabilities),
      settings,
    ],
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
    setDefaultModel: (model: string) =>
      writeFileSync(join(settings, 'default-model'), model),
    setVersion: (version: string) =>
      writeFileSync(join(settings, 'version'), version),
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

/**
 * Background probes are the periodic sweep, the only path that reattaches;
 * a user-initiated (`'request'`) probe always mints a fresh session.
 */
async function probeTimes(
  probe: ACPProbe,
  times: number,
  { initiator = 'background', model = 'm1' } = {} as {
    initiator?: 'background' | 'request';
    model?: string;
  },
) {
  for (let run = 0; run < times; run += 1) {
    await expect(probe.probe(initiator)).resolves.toBe(true);
    expect(probe.getModes()).toEqual(EXPECTED_MODES);
    expect(probe.getConfigOptions()).toEqual(expectedConfigOptions(model));
  }
}

describe('#3411 capability probes do not leak agent sessions', () => {
  test('an agent that can resume keeps exactly one probe session across repeated probes', async () => {
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
      'session/new',
      'session/resume',
      'session/resume',
      'session/resume',
    ]);
    expect(agent.storedSessions()).toHaveLength(1);

    // A Station restart (or a connection re-registration) builds a fresh
    // ACPProbe with no in-memory session. It mints one session rather than
    // adopting a stored one: session/list cannot say how old a session is
    // (Grok bumps updatedAt on every resume), so a recovered session could
    // carry a default model from arbitrarily long ago. This agent's list also
    // ignores the cwd filter, so adopting from it could pick anything.
    const restarted = agent.newProbe();
    try {
      await probeTimes(restarted, 2);
    } finally {
      await restarted.dispose();
    }
    expect(agent.methods().slice(4)).toEqual(['session/new', 'session/resume']);
    expect(agent.storedSessions()).toHaveLength(2);
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
    // The hung resume waits out the whole budget, so it is kept short, but a
    // healthy spawn and handshake must fit inside it on a loaded host: 1.5s
    // did not (it failed the healthy probes under CPU pressure).
    const probe = agent.newProbe({}, 6_000);
    try {
      await probeTimes(probe, 1);
      // The hung session/resume times out within the probe budget...
      await expect(probe.probe('background')).resolves.toBe(false);
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

  describe("a reattach answers from the session's own stored model, so fresh sessions are minted to bound staleness", () => {
    const resumable = { sessionCapabilities: { resume: {} } };

    test('a user-initiated probe mints a fresh session and reports the current default', async () => {
      const agent = fakeAgent(resumable);
      const probe = agent.newProbe();
      try {
        await probeTimes(probe, 2);
        agent.setDefaultModel('m2');
        // The periodic sweep reattaches, and the stored session still says m1.
        await probeTimes(probe, 1, { model: 'm1' });
        // Reconnect (or any request path) mints a fresh session: m2.
        await probeTimes(probe, 1, { initiator: 'request', model: 'm2' });
        // The fresh session becomes the one the sweep reattaches to.
        await probeTimes(probe, 1, { model: 'm2' });
      } finally {
        await probe.dispose();
      }
      expect(agent.methods()).toEqual([
        'session/new',
        'session/resume',
        'session/resume',
        'session/new',
        'session/resume',
      ]);
      expect(agent.storedSessions()).toHaveLength(2);
    }, 30_000);

    test('an agent that reports no agentInfo (as Grok Build does) is still reattached by the background sweep', async () => {
      const agent = fakeAgent({
        sessionCapabilities: { resume: {} },
        _meta: { noAgentInfo: true },
      });
      const probe = agent.newProbe();
      try {
        await probeTimes(probe, 3);
      } finally {
        await probe.dispose();
      }
      expect(agent.methods()).toEqual([
        'session/new',
        'session/resume',
        'session/resume',
      ]);
      expect(agent.storedSessions()).toHaveLength(1);
    }, 30_000);

    test('a changed agent version mints a fresh session', async () => {
      const agent = fakeAgent(resumable);
      const probe = agent.newProbe();
      try {
        await probeTimes(probe, 2);
        agent.setDefaultModel('m2');
        agent.setVersion('1.1.0');
        await probeTimes(probe, 1, { model: 'm2' });
        await probeTimes(probe, 1, { model: 'm2' });
      } finally {
        await probe.dispose();
      }
      expect(agent.methods()).toEqual([
        'session/new',
        'session/resume',
        'session/new',
        'session/resume',
      ]);
    }, 30_000);

    test(`a retained session older than the refresh interval (${PROBE_SESSION_REFRESH_MS} ms, six hours) is replaced`, async () => {
      expect(PROBE_SESSION_REFRESH_MS).toBe(6 * 60 * 60 * 1000);
      const agent = fakeAgent(resumable);
      const probe = agent.newProbe();
      const realNow = Date.now.bind(Date);
      try {
        await probeTimes(probe, 2);
        agent.setDefaultModel('m2');
        const clock = vi.spyOn(Date, 'now');
        // Just inside the interval: still reattaches, still m1.
        clock.mockImplementation(
          () => realNow() + PROBE_SESSION_REFRESH_MS - 60_000,
        );
        await probeTimes(probe, 1, { model: 'm1' });
        // Past it: a fresh session, the current default, and the new one is
        // what the next sweep reattaches to.
        clock.mockImplementation(() => realNow() + PROBE_SESSION_REFRESH_MS);
        await probeTimes(probe, 2, { model: 'm2' });
      } finally {
        vi.restoreAllMocks();
        await probe.dispose();
      }
      expect(agent.methods()).toEqual([
        'session/new',
        'session/resume',
        'session/resume',
        'session/new',
        'session/resume',
      ]);
    }, 30_000);
  });

  test('a session already in a user-configured directory is never adopted', async () => {
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
      expect(
        JSON.parse(readFileSync(join(agent.store, 'user-session.json'), 'utf8'))
          .model,
      ).toBeUndefined();
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
