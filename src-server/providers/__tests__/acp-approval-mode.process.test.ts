import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import type { ApprovalMode } from '@kontourai/station-contracts/provider';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import type { CanonicalRuntimeEvent } from '../adapter-shape.js';
import { AcpAdapter } from '../adapters/acp-adapter.js';

/**
 * #3290: Station's approval mode governs OpenCode over ACP.
 *
 * Every test here drives the real `ACPProcess` (a real spawn, with the real
 * launch environment) against `fixtures/fake-opencode-acp.mjs`, an ACP
 * engine with OpenCode 1.18.18's wire shapes that evaluates its permission
 * rules the way OpenCode does: the engine's own defaults, then the user's
 * rules, then the agent's, last match wins. The user's rules here are
 * `permission: "allow"`, the configuration under which the reported
 * incident ran a shell command without asking.
 *
 * The fixture is launched through an executable named `opencode`, so the
 * adapter recognizes it by its command exactly as it recognizes the real
 * one; a copy named `kiro-cli` is an ACP engine that decides for itself.
 */
const FIXTURE = fileURLToPath(
  new URL('./fixtures/fake-opencode-acp.mjs', import.meta.url),
);
const USER_CONFIG = JSON.stringify({
  permission: 'allow',
  provider: { mine: { name: 'Mine' } },
});

const makeTempDir = trackTempDirs();

type Harness = {
  adapter: AcpAdapter;
  events: CanonicalRuntimeEvent[];
  recordPath: string;
  cwd: string;
  stop: () => Promise<void>;
};

function launcher(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

function harness(command: 'opencode' | 'kiro-cli'): Harness {
  const dir = makeTempDir('station-acp-approval-');
  const cwd = makeTempDir('station-acp-approval-cwd-');
  const recordPath = join(dir, 'launches.jsonl');
  writeFileSync(recordPath, '');
  const connection: ACPConnectionConfig = {
    id: 'engine-under-test',
    name: command === 'opencode' ? 'OpenCode' : 'Kiro',
    command: launcher(dir, command),
    args: ['acp'],
    enabled: true,
  };
  process.env.FAKE_OPENCODE_RECORD = recordPath;
  const adapter = new AcpAdapter({
    getConnections: async () => [connection],
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  });
  const events: CanonicalRuntimeEvent[] = [];
  const drained = (async () => {
    for await (const event of adapter.streamEvents()) events.push(event);
  })();
  return {
    adapter,
    events,
    recordPath,
    cwd,
    stop: async () => {
      await adapter.stopAll();
      await drained;
    },
  };
}

async function waitFor<T>(
  find: () => T | undefined,
  what: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = find();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function records(h: Harness): Array<Record<string, unknown>> {
  return readFileSync(h.recordPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** One entry per engine process the adapter launched. */
function launches(
  h: Harness,
): Array<{ OPENCODE_CONFIG_CONTENT: string | null }> {
  return records(h).filter(
    (entry): entry is { OPENCODE_CONFIG_CONTENT: string | null } =>
      'OPENCODE_CONFIG_CONTENT' in entry,
  );
}

/** The session ids a relaunched engine resumed (`session/resume`). */
function resumes(h: Harness): unknown[] {
  return records(h)
    .filter((entry) => 'resumed' in entry)
    .map((entry) => entry.resumed);
}

/** The floor a launch carried: none, or Station's build rules. */
function buildRules(
  launch: { OPENCODE_CONFIG_CONTENT: string | null } | undefined,
) {
  if (!launch?.OPENCODE_CONFIG_CONTENT) return undefined;
  return JSON.parse(launch.OPENCODE_CONFIG_CONTENT).agent?.build?.permission;
}

async function start(
  h: Harness,
  threadId: string,
  approvalMode?: ApprovalMode,
  confinement: 'host' | 'workspace' = 'workspace',
) {
  await h.adapter.startSession({
    provider: 'acp',
    threadId,
    cwd: h.cwd,
    confinement,
    metadata: { connectionId: 'engine-under-test' },
    ...(approvalMode ? { modelOptions: { approvalMode } } : {}),
  });
}

/** Sends one turn and resolves with what it did once it has settled. */
async function turn(
  h: Harness,
  threadId: string,
  input: string,
  options: {
    approvalMode?: ApprovalMode;
    confinement?: 'host' | 'workspace';
    answer?: 'accept' | 'decline';
  } = {},
) {
  const from = h.events.length;
  const { turnId } = await h.adapter.sendTurn({
    provider: 'acp',
    threadId,
    input,
    confinement: options.confinement ?? 'workspace',
    ...(options.approvalMode
      ? { modelOptions: { approvalMode: options.approvalMode } }
      : {}),
  } as never);
  const since = () => h.events.slice(from);
  const settled = () =>
    since().find(
      (event) =>
        event.method === 'turn.completed' &&
        (event as { turnId?: string }).turnId === turnId,
    );
  const opened = () =>
    since().find((event) => event.method === 'request.opened') as
      | (CanonicalRuntimeEvent & { requestId: string })
      | undefined;
  await waitFor(() => settled() ?? opened(), 'the turn to settle or ask');
  const request = opened();
  if (request && options.answer) {
    await h.adapter.respondToRequest(
      threadId,
      request.requestId,
      options.answer,
    );
  }
  if (request && !options.answer) {
    return { asked: request, started: since(), completed: undefined };
  }
  await waitFor(settled, 'turn.completed');
  const toolUpdates = since().filter(
    (event) => event.method === 'tool.completed',
  );
  return { asked: request, started: since(), completed: toolUpdates };
}

function turnStarted(events: CanonicalRuntimeEvent[]) {
  return events.find((event) => event.method === 'turn.started') as
    | (CanonicalRuntimeEvent & { metadata?: Record<string, unknown> })
    | undefined;
}

describe.skipIf(process.platform === 'win32')(
  '#3290 approval mode over ACP (real process, OpenCode-shaped engine)',
  () => {
    let saved: Record<string, string | undefined>;
    let h: Harness | undefined;

    beforeEach(() => {
      saved = {
        OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT,
        FAKE_OPENCODE_USER_CONFIG: process.env.FAKE_OPENCODE_USER_CONFIG,
        FAKE_OPENCODE_RECORD: process.env.FAKE_OPENCODE_RECORD,
      };
      delete process.env.OPENCODE_CONFIG_CONTENT;
      process.env.FAKE_OPENCODE_USER_CONFIG = USER_CONFIG;
    });

    afterEach(async () => {
      await h?.stop();
      h = undefined;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    test('the launch environment carries Station rules merged into the inline configuration Station inherited', async () => {
      process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        model: 'mine/model',
        agent: { reviewer: { mode: 'primary', prompt: 'Review.' } },
      });
      h = harness('opencode');
      await start(h, 'launch-env', 'ask');

      const [launch] = launches(h);
      const content = JSON.parse(launch?.OPENCODE_CONFIG_CONTENT ?? 'null');
      // The inherited inline configuration is kept, not replaced.
      expect(content.model).toBe('mine/model');
      expect(content.agent.reviewer).toEqual({
        mode: 'primary',
        prompt: 'Review.',
      });
      // Station's rules are added to build and plan.
      expect(content.agent.build.permission).toMatchObject({
        bash: 'ask',
        edit: 'ask',
        '*_*': 'ask',
        task: 'deny',
      });
      expect(content.agent.plan.permission.edit).toMatchObject({ '*': 'deny' });
    });

    test('Ask: a shell command waits for a person, although the user allows everything', async () => {
      h = harness('opencode');
      await start(h, 'ask', 'ask');
      const configured = await waitFor(
        () =>
          h?.events.find((event) => event.method === 'session.configured') as
            | (CanonicalRuntimeEvent & { metadata?: Record<string, unknown> })
            | undefined,
        'session.configured',
      );
      expect(configured.metadata?.approvalMode).toBe('ask');

      const result = await turn(h, 'ask', 'run: echo STATION_PROBE', {
        answer: 'accept',
      });
      expect(result.asked).toMatchObject({
        method: 'request.opened',
        title: 'echo STATION_PROBE',
        payload: { toolKind: 'execute' },
      });
      expect(turnStarted(result.started)?.metadata?.approvalMode).toBe('ask');
    });

    test('Ask: a declined shell command does not run', async () => {
      h = harness('opencode');
      await start(h, 'ask-decline', 'ask');
      const result = await turn(h, 'ask-decline', 'run: rm -rf build', {
        answer: 'decline',
      });
      expect(result.asked).toBeDefined();
      expect(
        result.started.some(
          (event) =>
            event.method === 'tool.completed' &&
            JSON.stringify(event).includes('bash ran'),
        ),
      ).toBe(false);
    });

    test('Auto: a file edit runs without a person; a shell command still asks', async () => {
      h = harness('opencode');
      await start(h, 'auto', 'auto');
      const edit = await turn(h, 'auto', 'edit: src/index.ts');
      expect(edit.asked).toBeUndefined();
      expect(JSON.stringify(edit.started)).toContain('edit ran');

      const shell = await turn(h, 'auto', 'run: echo hi', {
        answer: 'accept',
      });
      expect(shell.asked).toMatchObject({ payload: { toolKind: 'execute' } });
    });

    test('Full access in a host session: nothing asks, and a built-in subagent may start', async () => {
      h = harness('opencode');
      await start(h, 'full', 'never', 'host');
      expect(buildRules(launches(h)[0])).toMatchObject({ '*': 'allow' });
      const shell = await turn(h, 'full', 'run: echo hi', {
        confinement: 'host',
      });
      expect(shell.asked).toBeUndefined();
      expect(JSON.stringify(shell.started)).toContain('bash ran');
      expect(turnStarted(shell.started)?.metadata?.approvalMode).toBe('never');
      const task = await turn(h, 'full', 'task: general', {
        confinement: 'host',
      });
      expect(task.asked).toBeUndefined();
      expect(JSON.stringify(task.started)).toContain('task ran');
      // The user's own subagents stay denied: their rules could ask.
      const own = await turn(h, 'full', 'task: reviewer', {
        confinement: 'host',
      });
      expect(own.asked).toBeUndefined();
      expect(JSON.stringify(own.started)).not.toContain('task ran');
    });

    test('Ask and Auto start no subagent, and never ask about one', async () => {
      h = harness('opencode');
      await start(h, 'no-task', 'ask');
      const task = await turn(h, 'no-task', 'task: general');
      expect(task.asked).toBeUndefined();
      expect(JSON.stringify(task.started)).not.toContain('task ran');
      const auto = await turn(h, 'no-task', 'task: general', {
        approvalMode: 'auto',
      });
      expect(auto.asked).toBeUndefined();
      expect(JSON.stringify(auto.started)).not.toContain('task ran');
    });

    test('Full access outside a host session applies Auto (no process sandbox)', async () => {
      h = harness('opencode');
      await start(h, 'full-confined', 'never', 'workspace');
      const shell = await turn(h, 'full-confined', 'run: echo hi', {
        answer: 'accept',
      });
      expect(shell.asked).toBeDefined();
      expect(turnStarted(shell.started)?.metadata?.approvalMode).toBe('auto');
      // Confined full access is Auto's floor: no subagent.
      expect(buildRules(launches(h)[0])).toMatchObject({ task: 'deny' });
      const task = await turn(h, 'full-confined', 'task: general');
      expect(JSON.stringify(task.started)).not.toContain('task ran');
    });

    test('a mid-session change applies from the next turn', async () => {
      h = harness('opencode');
      await start(h, 'switch', 'ask', 'host');
      const before = await turn(h, 'switch', 'run: echo one', {
        confinement: 'host',
        answer: 'accept',
      });
      expect(before.asked).toBeDefined();

      const after = await turn(h, 'switch', 'run: echo two', {
        approvalMode: 'never',
        confinement: 'host',
      });
      expect(after.asked).toBeUndefined();
      expect(turnStarted(after.started)?.metadata?.approvalMode).toBe('never');

      // And back: the stricter pick asks again.
      const back = await turn(h, 'switch', 'run: echo three', {
        approvalMode: 'ask',
        confinement: 'host',
        answer: 'accept',
      });
      expect(back.asked).toBeDefined();
      // Full access runs on its own floor: each crossing relaunched and
      // resumed the same session.
      expect(launches(h).map(buildRules)).toEqual([
        expect.objectContaining({ bash: 'ask' }),
        expect.objectContaining({ '*': 'allow' }),
        expect.objectContaining({ bash: 'ask' }),
      ]);
      expect(resumes(h)).toEqual([
        'ses_fixture00000000000000000',
        'ses_fixture00000000000000000',
      ]);
    });

    test('Ask to Auto and back needs no restart', async () => {
      h = harness('opencode');
      await start(h, 'ask-auto', 'ask');
      await turn(h, 'ask-auto', 'edit: a.ts', { answer: 'accept' });
      const auto = await turn(h, 'ask-auto', 'edit: b.ts', {
        approvalMode: 'auto',
      });
      expect(auto.asked).toBeUndefined();
      const ask = await turn(h, 'ask-auto', 'edit: c.ts', {
        approvalMode: 'ask',
        answer: 'accept',
      });
      expect(ask.asked).toBeDefined();
      expect(launches(h)).toHaveLength(1);
      expect(resumes(h)).toEqual([]);
    });

    test("Default with nothing configured launches on the engine's own configuration and reports no mode", async () => {
      h = harness('opencode');
      await start(h, 'native');
      expect(launches(h)).toEqual([{ OPENCODE_CONFIG_CONTENT: null }]);
      const configured = await waitFor(
        () =>
          h?.events.find((event) => event.method === 'session.configured') as
            | (CanonicalRuntimeEvent & { metadata?: Record<string, unknown> })
            | undefined,
        'session.configured',
      );
      expect(configured.metadata).not.toHaveProperty('approvalMode');
      // The user's own "allow" decides: nothing asks.
      const shell = await turn(h, 'native', 'run: echo hi');
      expect(shell.asked).toBeUndefined();
      expect(JSON.stringify(shell.started)).toContain('bash ran');
      expect(turnStarted(shell.started)?.metadata).not.toHaveProperty(
        'approvalMode',
      );
    });

    test('the first pick relaunches on the floor and resumes the same session, keeping its mode', async () => {
      h = harness('opencode');
      await h.adapter.startSession({
        provider: 'acp',
        threadId: 'takeover',
        cwd: h.cwd,
        confinement: 'workspace',
        metadata: { connectionId: 'engine-under-test' },
        modelOptions: { mode: 'plan' },
      });
      const native = await turn(h, 'takeover', 'run: echo native');
      expect(native.asked).toBeUndefined();

      const governed = await turn(h, 'takeover', 'run: echo governed', {
        approvalMode: 'ask',
        answer: 'accept',
      });
      expect(governed.asked).toMatchObject({ title: 'echo governed' });
      expect(turnStarted(governed.started)?.metadata?.approvalMode).toBe('ask');
      expect(launches(h).map(buildRules)).toEqual([
        undefined,
        expect.objectContaining({ bash: 'ask' }),
      ]);
      expect(resumes(h)).toEqual(['ses_fixture00000000000000000']);
      // The new process came back in `build`; the session's `plan` was
      // re-applied, so plan still denies edits.
      const edit = await turn(h, 'takeover', 'edit: x.ts', {
        approvalMode: 'ask',
      });
      expect(edit.asked).toBeUndefined();
      expect(JSON.stringify(edit.started)).not.toContain('edit ran');
    });

    test('a mode at start (a pick or a configured default) launches on the floor', async () => {
      h = harness('opencode');
      await start(h, 'configured', 'auto');
      expect(launches(h)).toHaveLength(1);
      expect(buildRules(launches(h)[0])).toMatchObject({ bash: 'ask' });
      expect(resumes(h)).toEqual([]);
    });

    test('plan mode keeps edits blocked even at full access', async () => {
      h = harness('opencode');
      await h.adapter.startSession({
        provider: 'acp',
        threadId: 'plan',
        cwd: h.cwd,
        confinement: 'host',
        metadata: { connectionId: 'engine-under-test' },
        modelOptions: { approvalMode: 'never', mode: 'plan' },
      });
      const edit = await turn(h, 'plan', 'edit: src/index.ts', {
        confinement: 'host',
      });
      expect(edit.asked).toBeUndefined();
      expect(JSON.stringify(edit.started)).not.toContain('edit ran');
    });

    test('an engine that decides for itself is launched untouched and refuses a mode', async () => {
      process.env.OPENCODE_CONFIG_CONTENT = '{"model":"mine/model"}';
      h = harness('kiro-cli');
      await expect(start(h, 'refused', 'ask')).rejects.toThrow(
        /decides which of its actions ask/,
      );
      // Refused before anything was launched.
      expect(launches(h)).toHaveLength(0);

      await start(h, 'engine-decides');
      expect(launches(h)).toEqual([
        { OPENCODE_CONFIG_CONTENT: '{"model":"mine/model"}' },
      ]);
      const configured = await waitFor(
        () =>
          h?.events.find((event) => event.method === 'session.configured') as
            | (CanonicalRuntimeEvent & { metadata?: Record<string, unknown> })
            | undefined,
        'session.configured',
      );
      expect(configured.metadata?.approvalMode).toBeUndefined();
      // The user's own "allow" decides: nothing asks.
      const shell = await turn(h, 'engine-decides', 'run: echo hi');
      expect(shell.asked).toBeUndefined();
      expect(
        turnStarted(shell.started)?.metadata?.approvalMode,
      ).toBeUndefined();
      await expect(
        turn(h, 'engine-decides', 'run: echo again', { approvalMode: 'ask' }),
      ).rejects.toThrow(/decides which of its actions ask/);
    });
  },
);
