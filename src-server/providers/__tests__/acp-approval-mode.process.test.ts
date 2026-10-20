import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import type { ApprovalMode } from '@kontourai/station-contracts/provider';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { openCodeAgentReader } from '../../services/acp/opencode-approval-verify.js';
import type { CanonicalRuntimeEvent } from '../adapter-shape.js';
import {
  AcpAdapter,
  START_PREFLIGHT_REUSE_MS,
} from '../adapters/acp-adapter.js';

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
  command: string;
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
    command: connection.command,
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

/** The pid of each engine process launched, in order. */
function pids(h: Harness): number[] {
  return records(h)
    .filter((entry) => 'pid' in entry)
    .map((entry) => Number(entry.pid));
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The agents whose resolved rules were read (`opencode debug agent`). */
function agentReads(h: Harness): unknown[] {
  return records(h)
    .filter((entry) => 'debugAgent' in entry)
    .map((entry) => entry.debugAgent);
}

/** The permissions the engine was answered "always" for. */
function engineAlways(h: Harness): unknown[] {
  return records(h)
    .filter((entry) => 'always' in entry)
    .map((entry) => entry.always);
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
    answer?: 'accept' | 'acceptForSession' | 'decline';
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
        FAKE_OPENCODE_REFUSE_RESUME: process.env.FAKE_OPENCODE_REFUSE_RESUME,
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
        'bas?': 'ask',
        'edi?': 'ask',
        '*_**': 'ask',
        'tas?': 'deny',
      });
      expect(content.agent.plan.permission['edi?']).toMatchObject({
        '*': 'deny',
      });
      // Pinned, so a user or project default_agent cannot start elsewhere.
      expect(content.default_agent).toBe('build');
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
      expect(buildRules(launches(h)[0])).toMatchObject({ '*?': 'allow' });
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
      expect(buildRules(launches(h)[0])).toMatchObject({ 'tas?': 'deny' });
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
        expect.objectContaining({ 'bas?': 'ask' }),
        expect.objectContaining({ '*?': 'allow' }),
        expect.objectContaining({ 'bas?': 'ask' }),
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
        expect.objectContaining({ 'bas?': 'ask' }),
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

    test('a takeover whose resume fails keeps the old engine, says so, and refuses the turn rather than run looser than the pick', async () => {
      h = harness('opencode');
      await start(h, 'takeover-fails');
      await turn(h, 'takeover-fails', 'run: echo native');
      const [oldPid] = pids(h);
      expect(alive(oldPid)).toBe(true);

      process.env.FAKE_OPENCODE_REFUSE_RESUME = '1';
      const from = h.events.length;
      // OpenCode's own settings are not known to be as strict as Ask (here
      // they allow everything), so the turn is not sent at all.
      await expect(
        turn(h, 'takeover-fails', 'run: echo after', { approvalMode: 'ask' }),
      ).rejects.toThrow(
        /still using its own settings, so this message was not sent: the new engine process did not resume the session/,
      );
      // The second process was started on the floor, refused the resume and
      // was discarded; the old one is untouched.
      expect(launches(h).map(buildRules)).toEqual([
        undefined,
        expect.objectContaining({ 'bas?': 'ask' }),
      ]);
      expect(alive(oldPid)).toBe(true);
      const discardedPid = pids(h)[1];
      await waitFor(
        () => (alive(discardedPid) ? undefined : true),
        'the discarded process to exit',
      );
      const since = h.events.slice(from);
      expect(since.some((event) => event.method === 'turn.started')).toBe(
        false,
      );
      expect(
        since.find((event) => event.method === 'runtime.warning'),
      ).toMatchObject({
        code: 'acp-approval-takeover-failed',
        details: { requestedApprovalMode: 'ask' },
      });
      expect(
        (
          since.find((event) => event.method === 'runtime.warning') as {
            message?: string;
          }
        )?.message,
      ).toMatch(
        /^Couldn't switch OpenCode to Station's approval rules; it's still using its own settings: /,
      );

      // Still usable on its own settings (a Default pick sends no mode): the
      // next turn runs on the same old process.
      const next = await turn(h, 'takeover-fails', 'run: echo again');
      expect(JSON.stringify(next.started)).toContain('bash ran');
      expect(alive(oldPid)).toBe(true);
    });

    test('a failed move from Ask to full access still runs, at Ask, and says the pick did not apply', async () => {
      h = harness('opencode');
      await start(h, 'ask-to-full', 'ask', 'host');
      process.env.FAKE_OPENCODE_REFUSE_RESUME = '1';
      const failed = await turn(h, 'ask-to-full', 'run: echo hi', {
        approvalMode: 'never',
        confinement: 'host',
        answer: 'accept',
      });
      expect(failed.asked).toBeDefined();
      const started = turnStarted(failed.started);
      expect(started?.metadata?.approvalMode).toBe('ask');
      expect(started?.metadata?.approvalTakeoverFailed).toBe(true);
    });

    test('a takeover whose resume succeeds stops the old engine process', async () => {
      h = harness('opencode');
      await start(h, 'takeover-ok');
      await turn(h, 'takeover-ok', 'run: echo native');
      const [oldPid] = pids(h);
      await turn(h, 'takeover-ok', 'run: echo governed', {
        approvalMode: 'ask',
        answer: 'accept',
      });
      const newPid = pids(h)[1];
      expect(alive(newPid)).toBe(true);
      await waitFor(
        () => (alive(oldPid) ? undefined : true),
        'the replaced process to exit',
      );
    });

    test('a failed move off full access refuses the turn instead of running it with full access', async () => {
      h = harness('opencode');
      await start(h, 'full-stuck', 'never', 'host');
      process.env.FAKE_OPENCODE_REFUSE_RESUME = '1';
      await expect(
        turn(h, 'full-stuck', 'run: echo hi', {
          approvalMode: 'ask',
          confinement: 'host',
        }),
      ).rejects.toThrow(/still running with full access/);
      delete process.env.FAKE_OPENCODE_REFUSE_RESUME;
      const retried = await turn(h, 'full-stuck', 'run: echo hi', {
        approvalMode: 'ask',
        confinement: 'host',
        answer: 'accept',
      });
      expect(retried.asked).toBeDefined();
    });

    test("finding 1: a user's default_agent cannot start a governed session outside build", async () => {
      process.env.FAKE_OPENCODE_USER_CONFIG = JSON.stringify({
        permission: 'allow',
        default_agent: 'helper',
        agent: { helper: { mode: 'primary', permission: { '*': 'allow' } } },
      });
      h = harness('opencode');
      await start(h, 'default-agent', 'ask');
      // Station pinned build, so the shell command asks.
      const shell = await turn(h, 'default-agent', 'run: echo hi', {
        answer: 'accept',
      });
      expect(shell.asked).toBeDefined();
      // And the user's own agent is refused while Station governs.
      await expect(
        h.adapter.sendTurn({
          provider: 'acp',
          threadId: 'default-agent',
          input: 'run: echo helper',
          confinement: 'workspace',
          modelOptions: { mode: 'helper' },
        } as never),
      ).rejects.toThrow(/the helper agent keeps its own permission rules/);
    });

    test("finding 1: a takeover is refused while the chat runs the user's own agent", async () => {
      process.env.FAKE_OPENCODE_USER_CONFIG = JSON.stringify({
        permission: 'allow',
        default_agent: 'helper',
        agent: { helper: { mode: 'primary', permission: { '*': 'allow' } } },
      });
      h = harness('opencode');
      await start(h, 'helper-native');
      const native = await turn(h, 'helper-native', 'run: echo native');
      expect(native.asked).toBeUndefined();
      await expect(
        turn(h, 'helper-native', 'run: echo pick', { approvalMode: 'ask' }),
      ).rejects.toMatchObject({
        code: 'acp_approval_governance_refused',
        message: expect.stringMatching(
          /the helper agent keeps its own permission rules/,
        ),
      });
      expect(launches(h)).toHaveLength(1);
    });

    test("finding 2: Station's rules are evaluated after the user's, whatever their key order", async () => {
      process.env.FAKE_OPENCODE_USER_CONFIG = JSON.stringify({
        agent: { build: { permission: { edit: 'allow', '*': 'allow' } } },
      });
      h = harness('opencode');
      await start(h, 'user-order', 'ask');
      const edit = await turn(h, 'user-order', 'edit: f2.txt', {
        answer: 'decline',
      });
      expect(edit.asked).toMatchObject({ payload: { toolKind: 'edit' } });
      expect(JSON.stringify(edit.started)).not.toContain('edit ran');
    });

    test('finding 2: when the resolved rules still let an action run unasked, Station refuses to govern and names it', async () => {
      // The user's own `*?` comes after Station's rules in this agent.
      process.env.FAKE_OPENCODE_USER_CONFIG = JSON.stringify({
        agent: { build: { permission: { 'bas?': 'allow', '*?': 'allow' } } },
      });
      h = harness('opencode');
      await expect(start(h, 'overridden', 'ask')).rejects.toThrow(
        /overrides Station's approval rules for bash in the build agent \(it would run without asking\)/,
      );
      // A structured, non-retryable refusal: clients name the next step.
      await expect(start(h, 'overridden-coded', 'ask')).rejects.toMatchObject({
        code: 'acp_approval_governance_refused',
      });
      expect(launches(h)).toHaveLength(0);
      // Default (OpenCode's own settings) still starts.
      await start(h, 'overridden-native');
      expect(launches(h)).toHaveLength(1);
    });

    test("P5: a user's own MCP allows (`*_*`, `github_*`) do not let an MCP tool run unasked in Ask", async () => {
      process.env.FAKE_OPENCODE_USER_CONFIG = JSON.stringify({
        agent: {
          build: {
            permission: { '*_*': 'allow', github_create_issue: 'allow' },
          },
        },
      });
      h = harness('opencode');
      await start(h, 'mcp-user-allows', 'ask');
      const call = await turn(
        h,
        'mcp-user-allows',
        'mcp: github_create_issue',
        {
          answer: 'decline',
        },
      );
      expect(call.asked).toMatchObject({ title: 'github_create_issue' });
      expect(JSON.stringify(call.started)).not.toContain(
        'github_create_issue ran',
      );
    });

    test("P5: an MCP allow evaluated after Station's rule is caught by verification, not sampled past", async () => {
      // The user holds Station's own key, so OpenCode keeps the user's
      // position for it and the user's later `github_*` allow comes after:
      // Station's MCP rule is effective for every tool but github_*.
      process.env.FAKE_OPENCODE_USER_CONFIG = JSON.stringify({
        agent: {
          build: { permission: { '*_**': 'ask', 'github_*': 'allow' } },
        },
      });
      h = harness('opencode');
      await expect(start(h, 'mcp-later-allow', 'ask')).rejects.toThrow(
        /for MCP tools in the build agent \(github_\* would run without asking\)/,
      );
    });

    test('full access: a subagent rule that could ask refuses full access instead of risking a hang', async () => {
      process.env.FAKE_OPENCODE_USER_CONFIG = JSON.stringify({
        agent: { general: { permission: { '*?': 'ask', 'bas?': 'ask' } } },
      });
      h = harness('opencode');
      await expect(start(h, 'general-asks', 'never', 'host')).rejects.toThrow(
        /for bash in the general agent \(a subagent could ask and hang\)/,
      );
    });

    test('an engine that cannot report its resolved rules is not governed', async () => {
      h = harness('opencode');
      const { command, cwd } = h;
      const adapter = new AcpAdapter({
        getConnections: async () => [
          {
            id: 'engine-under-test',
            name: 'OpenCode',
            command,
            args: ['acp'],
            enabled: true,
          } as never,
        ],
        readOpenCodeAgents: () => async () => {
          throw new Error('unknown command: debug');
        },
      });
      await expect(
        adapter.startSession({
          provider: 'acp',
          threadId: 'unreadable',
          cwd,
          confinement: 'workspace',
          metadata: { connectionId: 'engine-under-test' },
          modelOptions: { approvalMode: 'ask' },
        } as never),
      ).rejects.toThrow(/could not read OpenCode's resolved approval rules/);
      await adapter.stopAll();
    });

    test('the start preflight refuses definitively, before anything launches, and a pass is not checked twice', async () => {
      process.env.FAKE_OPENCODE_USER_CONFIG = JSON.stringify({
        agent: { build: { permission: { 'bas?': 'allow', '*?': 'allow' } } },
      });
      h = harness('opencode');
      const { command, cwd } = h;
      const reads: string[] = [];
      const adapter = new AcpAdapter({
        getConnections: async () => [
          {
            id: 'engine-under-test',
            name: 'OpenCode',
            command,
            args: ['acp'],
            enabled: true,
          } as never,
        ],
        readOpenCodeAgents: (input) => {
          const read = openCodeAgentReader(input);
          return (agent) => {
            reads.push(agent);
            return read(agent);
          };
        },
      });
      const input = (threadId: string, approvalMode?: ApprovalMode) =>
        ({
          provider: 'acp',
          threadId,
          cwd,
          confinement: 'workspace',
          metadata: { connectionId: 'engine-under-test' },
          ...(approvalMode ? { modelOptions: { approvalMode } } : {}),
        }) as never;
      try {
        await expect(
          adapter.preflightStart(input('pre-refused', 'ask')),
        ).rejects.toMatchObject({
          code: 'acp_approval_governance_refused',
          message: expect.stringMatching(
            /overrides Station's approval rules for bash in the build agent/,
          ),
        });
        expect(launches(h)).toHaveLength(0);
        // Default asks Station to apply nothing: no check, no refusal.
        reads.length = 0;
        await adapter.preflightStart(input('pre-native'));
        expect(reads).toEqual([]);

        delete process.env.FAKE_OPENCODE_USER_CONFIG;
        reads.length = 0;
        await adapter.preflightStart(input('pre-passed', 'ask'));
        const preflightReads = reads.length;
        expect(preflightReads).toBeGreaterThan(0);
        await adapter.startSession(input('pre-passed', 'ask'));
        expect(reads).toHaveLength(preflightReads);
        // A start with no preflight behind it still checks.
        await adapter.startSession(input('no-preflight', 'ask'));
        expect(reads.length).toBeGreaterThan(preflightReads);
      } finally {
        await adapter.stopAll();
      }
    });

    describe('a passed start preflight stands only for the same start, briefly', () => {
      function counted(started: Harness, clock: { now: number }) {
        const reads: string[] = [];
        const adapter = new AcpAdapter({
          getConnections: async () => [
            {
              id: 'engine-under-test',
              name: 'OpenCode',
              command: started.command,
              args: ['acp'],
              enabled: true,
            } as never,
          ],
          now: () => clock.now,
          readOpenCodeAgents: (input) => {
            const read = openCodeAgentReader(input);
            return (agent) => {
              reads.push(agent);
              return read(agent);
            };
          },
        });
        const input = (threadId: string, cwd: string) =>
          ({
            provider: 'acp',
            threadId,
            cwd,
            confinement: 'workspace',
            metadata: { connectionId: 'engine-under-test' },
            modelOptions: { approvalMode: 'ask' },
          }) as never;
        return { adapter, reads, input };
      }

      test('the window is one minute', () => {
        expect(START_PREFLIGHT_REUSE_MS).toBe(60_000);
      });

      test('a preflight for another directory is checked again', async () => {
        h = harness('opencode');
        const other = join(h.cwd, 'other');
        mkdirSync(other);
        const { adapter, reads, input } = counted(h, { now: 0 });
        try {
          await adapter.preflightStart(input('moved', h.cwd));
          const preflightReads = reads.length;
          await adapter.startSession(input('moved', other));
          expect(reads.length).toBeGreaterThan(preflightReads);
        } finally {
          await adapter.stopAll();
        }
      });

      test('a preflight older than the window is checked again; one inside it is not', async () => {
        h = harness('opencode');
        const clock = { now: 1_000 };
        const { adapter, reads, input } = counted(h, clock);
        try {
          await adapter.preflightStart(input('inside', h.cwd));
          let before = reads.length;
          clock.now += START_PREFLIGHT_REUSE_MS;
          await adapter.startSession(input('inside', h.cwd));
          expect(reads).toHaveLength(before);

          await adapter.preflightStart(input('expired', h.cwd));
          before = reads.length;
          clock.now += START_PREFLIGHT_REUSE_MS + 1;
          await adapter.startSession(input('expired', h.cwd));
          expect(reads.length).toBeGreaterThan(before);
        } finally {
          await adapter.stopAll();
        }
      });
    });

    test('a mode at start (a pick or a configured default) launches on the floor', async () => {
      h = harness('opencode');
      await start(h, 'configured', 'auto');
      expect(launches(h)).toHaveLength(1);
      expect(buildRules(launches(h)[0])).toMatchObject({ 'bas?': 'ask' });
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

    describe('#3924: OpenCode configuration is code OpenCode runs at launch', () => {
      test.each([
        '.opencode/plugin/planted.ts',
        'pkg/.opencode/tool/planted.ts',
        'sub/opencode.json',
        'opencode.jsonc',
        '.OpenCode/plugins/planted.ts',
        '../outside-the-project.txt',
      ])('Auto: an edit of %s asks a person', async (target) => {
        h = harness('opencode');
        await start(h, 'auto-config', 'auto');
        const edit = await turn(h, 'auto-config', `edit: ${target}`, {
          answer: 'decline',
        });
        expect(edit.asked).toMatchObject({ payload: { toolKind: 'edit' } });
        expect(existsSync(join(h.cwd, target))).toBe(false);
        // A project file is still Auto's to allow.
        const plain = await turn(h, 'auto-config', 'edit: src/plain.ts');
        expect(plain.asked).toBeUndefined();
        expect(existsSync(join(h.cwd, 'src/plain.ts'))).toBe(true);
      });

      test('Auto: an edit through a link into .opencode asks a person', async () => {
        h = harness('opencode');
        mkdirSync(join(h.cwd, '.opencode'));
        symlinkSync(join(h.cwd, '.opencode'), join(h.cwd, 'linked'));
        await start(h, 'auto-link', 'auto');
        const edit = await turn(h, 'auto-link', 'edit: linked/plugin/p.ts', {
          answer: 'decline',
        });
        expect(edit.asked).toBeDefined();
        expect(existsSync(join(h.cwd, '.opencode/plugin/p.ts'))).toBe(false);
      });

      test('full access outside a host session (Auto) still asks before a configuration edit', async () => {
        h = harness('opencode');
        await start(h, 'full-confined-config', 'never', 'workspace');
        const edit = await turn(
          h,
          'full-confined-config',
          'edit: .opencode/plugin/planted.ts',
          { approvalMode: 'never', answer: 'decline' },
        );
        expect(edit.asked).toBeDefined();
        expect(existsSync(join(h.cwd, '.opencode/plugin/planted.ts'))).toBe(
          false,
        );
      });

      test("Ask: allowing edits for the session is Station's grant, never OpenCode's 'always', and never covers configuration", async () => {
        h = harness('opencode');
        await start(h, 'ask-grant', 'ask');
        const first = await turn(h, 'ask-grant', 'edit: a.ts', {
          answer: 'acceptForSession',
        });
        expect(first.asked).toBeDefined();
        expect(engineAlways(h)).toEqual([]);
        const covered = await turn(h, 'ask-grant', 'edit: b.ts');
        expect(covered.asked).toBeUndefined();
        expect(existsSync(join(h.cwd, 'b.ts'))).toBe(true);
        const config = await turn(h, 'ask-grant', 'edit: opencode.json', {
          answer: 'decline',
        });
        expect(config.asked).toBeDefined();
        expect(existsSync(join(h.cwd, 'opencode.json'))).toBe(false);
      });

      test('a project whose OpenCode configuration runs code is not governed, and nothing is launched to check it', async () => {
        h = harness('opencode');
        // Positive control: a clean project is checked by reading the rules.
        await start(h, 'clean', 'ask');
        expect(agentReads(h).length).toBeGreaterThan(0);
        const readsBefore = agentReads(h).length;
        const launchesBefore = launches(h).length;

        mkdirSync(join(h.cwd, '.opencode/plugin'), { recursive: true });
        writeFileSync(join(h.cwd, '.opencode/plugin/planted.ts'), '');
        await expect(start(h, 'planted', 'ask')).rejects.toMatchObject({
          code: 'acp_approval_governance_refused',
          message: expect.stringMatching(
            /runs its own code when OpenCode starts.*\.opencode\/plugin/,
          ),
        });
        await expect(start(h, 'planted-auto', 'auto')).rejects.toMatchObject({
          code: 'acp_approval_governance_refused',
        });
        expect(agentReads(h)).toHaveLength(readsBefore);
        expect(launches(h)).toHaveLength(launchesBefore);
        // Default (OpenCode's own settings) is the user's to choose.
        await start(h, 'planted-native');
        expect(launches(h)).toHaveLength(launchesBefore + 1);
      });

      test.each([
        ['a global configuration file', 'global'],
        ['the project opencode.json', 'project'],
      ])(
        'Auto: a write through a dangling link to %s asks a person',
        async (_label, kind) => {
          h = harness('opencode');
          const destination =
            kind === 'global'
              ? join(h.cwd, '..', 'global-config', 'opencode', 'opencode.jsonc')
              : join(h.cwd, 'opencode.json');
          symlinkSync(
            kind === 'global'
              ? join('..', 'global-config', 'opencode', 'opencode.jsonc')
              : 'opencode.json',
            join(h.cwd, 'NOTES.md'),
          );
          await start(h, `auto-dangling-${kind}`, 'auto');
          const edit = await turn(
            h,
            `auto-dangling-${kind}`,
            'edit: NOTES.md',
            {
              answer: 'decline',
            },
          );
          expect(edit.asked).toMatchObject({ payload: { toolKind: 'edit' } });
          expect(existsSync(destination)).toBe(false);
        },
      );

      test('Auto: an absolute `link/..` path into global configuration asks a person', async () => {
        h = harness('opencode');
        const globalDir = join(h.cwd, '..', 'global-config-dotdot', 'opencode');
        mkdirSync(globalDir, { recursive: true });
        symlinkSync(globalDir, join(h.cwd, 'a'));
        await start(h, 'auto-dotdot', 'auto');
        const raw = `${h.cwd}/a/../opencode/plugins/x.js`;
        const edit = await turn(h, 'auto-dotdot', `edit: ${raw}`, {
          answer: 'decline',
        });
        expect(edit.asked).toMatchObject({ payload: { toolKind: 'edit' } });
        expect(
          existsSync(join(globalDir, '..', 'opencode', 'plugins', 'x.js')),
        ).toBe(false);
      });

      test('a start inside the preflight window is scanned again', async () => {
        h = harness('opencode');
        const input = {
          provider: 'acp',
          threadId: 'window',
          cwd: h.cwd,
          confinement: 'workspace',
          metadata: { connectionId: 'engine-under-test' },
          modelOptions: { approvalMode: 'ask' },
        } as never;
        await h.adapter.preflightStart(input);
        const reads = agentReads(h).length;
        expect(reads).toBeGreaterThan(0);
        mkdirSync(join(h.cwd, '.opencode/tools'), { recursive: true });
        writeFileSync(join(h.cwd, '.opencode/tools/planted.ts'), '');
        await expect(h.adapter.startSession(input)).rejects.toMatchObject({
          code: 'acp_approval_governance_refused',
          message: expect.stringMatching(/\.opencode\/tools/),
        });
        // The rules were not read again, and nothing launched.
        expect(agentReads(h)).toHaveLength(reads);
        expect(launches(h)).toHaveLength(0);
      });

      test('a takeover onto Station rules is refused once such code is present', async () => {
        h = harness('opencode');
        await start(h, 'takeover-planted');
        writeFileSync(
          join(h.cwd, 'opencode.json'),
          JSON.stringify({
            mcp: { planted: { type: 'local', command: ['x'] } },
          }),
        );
        await expect(
          turn(h, 'takeover-planted', 'run: echo pick', {
            approvalMode: 'ask',
          }),
        ).rejects.toMatchObject({
          code: 'acp_approval_governance_refused',
          message: expect.stringMatching(/opencode\.json \(mcp "planted"\)/),
        });
        expect(agentReads(h)).toEqual([]);
        expect(launches(h)).toHaveLength(1);
      });
    });
  },
);
