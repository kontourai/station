/**
 * Execution authority at the terminal service's launch seams, with a fake
 * shell host (no native backend, so it runs on every platform):
 *
 * - #492: a shell that ended with its host is reopened only inside its
 *   binding as it resolves NOW. A Project or chat that moved keeps the shell
 *   ended, with the reason recorded and written to its journal.
 * - #2497: an agent's own terminal command (`openAgentCommand`) runs only for
 *   a host-confined session in its own thread binding, and only after the
 *   host's agent-command authority allowed it, before the record and again
 *   at the spawn.
 */
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { StationConfinement } from '@kontourai/station-contracts/provider';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { IPtyProcess } from '../../../domain/pty-adapter.js';
import type { ShellHost } from '../shell-host.js';
import {
  type AgentCommandExecution,
  TerminalSessionRefusal,
  TerminalSessions,
} from '../terminal-sessions.js';

const temp = trackTempDirs();
const project = { projectId: 'project-a', bindingKey: 'project' };
const agentScope = { projectId: 'project-a', bindingKey: 'thread:agent' };

/** A process that prints one line, then exits 0 (a command) or stays (a shell). */
class FakeProcess implements IPtyProcess {
  pid = 4000 + Math.floor(Math.random() * 1000);
  private data = new Set<(data: string) => void>();
  private exits = new Set<
    (event: { exitCode: number; signal: number | null }) => void
  >();
  constructor(command: boolean) {
    setTimeout(() => {
      for (const listener of this.data) listener('fake-output\r\n');
      if (command) this.exit(0);
    }, 5);
  }
  private exit(exitCode: number) {
    for (const exit of [...this.exits]) exit({ exitCode, signal: null });
    this.exits.clear();
  }
  write() {}
  resize() {}
  kill() {
    this.exit(0);
  }
  onData(cb: (data: string) => void) {
    this.data.add(cb);
    return () => this.data.delete(cb);
  }
  onExit(cb: (event: { exitCode: number; signal: number | null }) => void) {
    this.exits.add(cb);
    return () => this.exits.delete(cb);
  }
}

function fakeHost() {
  const spawns: { cwd: string; command: boolean }[] = [];
  const host: ShellHost = {
    spawn: async (input) => {
      const command = 'kind' in input && input.kind === 'command';
      spawns.push({ cwd: input.cwd, command });
      return new FakeProcess(command);
    },
  };
  return { host, spawns };
}

const opened: TerminalSessions<string>[] = [];
afterEach(async () => {
  for (const sessions of opened.splice(0)) await sessions.dispose();
});

async function journalText(
  sessions: TerminalSessions<string>,
  scope: typeof project,
  id: string,
) {
  return (await sessions.read('operator', scope, id)).journal.records
    .map((record) => record.data)
    .join('');
}

describe('restore after a restart follows the current binding (#492)', () => {
  async function setup() {
    const home = temp('terminal-restore-binding-');
    const a = await realpath(temp('terminal-restore-a-'));
    const b = await realpath(temp('terminal-restore-b-'));
    await mkdir(join(a, 'sub'));
    const binding = { root: a, gone: false };
    const { host, spawns } = fakeHost();
    const create = () => {
      const sessions = new TerminalSessions<string>(home, host, {
        authorize: () => true,
        resolveRoot: async () => binding.root,
        restoreRoot: async () => {
          if (binding.gone)
            throw new TerminalSessionRefusal('its Project no longer exists');
          return binding.root;
        },
      });
      opened.push(sessions);
      return sessions;
    };
    return { a, b, binding, spawns, create };
  }

  /** Opens a shell, then stops its in-process host as a core exit does. */
  async function shellEndedWithHost(
    create: () => TerminalSessions<string>,
    subdirectory?: string,
  ) {
    const sessions = create();
    const shell = await sessions.open('operator', project, {
      cols: 80,
      rows: 24,
      ...(subdirectory ? { subdirectory } : {}),
    });
    await sessions.dispose();
    opened.splice(opened.indexOf(sessions), 1);
    return shell.terminalId;
  }

  test('reopens a shell whose binding still resolves where it was', async () => {
    const { a, spawns, create } = await setup();
    const id = await shellEndedWithHost(create);
    const sessions = create();
    const record = await sessions.read('operator', project, id);
    expect(record.status).toBe('running');
    expect(record.restoredAt).toEqual(expect.any(Number));
    expect(record.restoreRefused).toBeUndefined();
    expect(spawns.map((spawn) => spawn.cwd)).toEqual([a, a]);
  });

  test('keeps a shell ended, with the reason, when its Project moved', async () => {
    const { b, binding, spawns, create } = await setup();
    const id = await shellEndedWithHost(create);
    binding.root = b;
    const sessions = create();
    const record = await sessions.read('operator', project, id);
    expect(record.status).toBe('exited');
    expect(record.restoredAt).toBeUndefined();
    expect(record.restoreRefused).toEqual({
      reason: 'its directory is no longer inside its Project or chat',
      at: expect.any(Number),
    });
    // Nothing was started in the old directory.
    expect(spawns).toHaveLength(1);
    expect(await journalText(sessions, project, id)).toContain(
      'not restored after restart: its directory is no longer inside its Project or chat',
    );
    // It is not tried again on the next start.
    await sessions.dispose();
    opened.splice(opened.indexOf(sessions), 1);
    binding.root = (await sessions.read('operator', project, id)).cwd;
    const next = create();
    expect((await next.read('operator', project, id)).status).toBe('exited');
    expect(spawns).toHaveLength(1);
  });

  test('keeps a shell in a subdirectory ended when the binding moved beneath it', async () => {
    const { a, binding, spawns, create } = await setup();
    const id = await shellEndedWithHost(create, 'sub');
    binding.root = join(a, 'sub-elsewhere');
    await mkdir(binding.root);
    const sessions = create();
    const record = await sessions.read('operator', project, id);
    expect(record.status).toBe('exited');
    expect(record.restoreRefused?.reason).toBe(
      'its directory is no longer inside its Project or chat',
    );
    expect(spawns).toHaveLength(1);
  });

  test('keeps a shell ended with the binding authority’s reason when it cannot resolve', async () => {
    const { binding, spawns, create } = await setup();
    const id = await shellEndedWithHost(create);
    binding.gone = true;
    const sessions = create();
    const record = await sessions.read('operator', project, id);
    expect(record.status).toBe('exited');
    expect(record.restoreRefused?.reason).toBe('its Project no longer exists');
    expect(await journalText(sessions, project, id)).toContain(
      'not restored after restart: its Project no longer exists',
    );
    expect(spawns).toHaveLength(1);
  });
});

describe("an agent's terminal command runs under its session's authority (#2497)", () => {
  async function setup(
    authorizeAgentCommand?: (
      execution: AgentCommandExecution,
      scope: typeof project,
    ) => Promise<void>,
  ) {
    const home = temp('terminal-agent-command-');
    const root = await realpath(temp('terminal-agent-command-root-'));
    const { host, spawns } = fakeHost();
    const sessions = new TerminalSessions<string>(home, host, {
      authorize: () => true,
      resolveRoot: async () => root,
      ...(authorizeAgentCommand && { authorizeAgentCommand }),
    });
    opened.push(sessions);
    const run = (execution: AgentCommandExecution, scope = agentScope) =>
      sessions.openAgentCommand(execution, scope, {
        cwd: root,
        launch: { file: process.execPath, args: ['-e', ''] },
      });
    return { root, sessions, spawns, run };
  }
  const host: AgentCommandExecution = {
    threadId: 'agent',
    confinement: 'host',
  };

  test('runs a host session’s command after the host authority allowed it, twice', async () => {
    const authorize = vi.fn(async () => {});
    const { root, sessions, spawns, run } = await setup(authorize);
    const { terminalId, exited } = await run(host);
    expect(await exited).toMatchObject({ exitCode: 0 });
    expect(spawns).toEqual([{ cwd: root, command: true }]);
    // Before anything was recorded, and again at the spawn.
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(authorize).toHaveBeenCalledWith(host, agentScope);
    const [record] = await sessions.listObservable('operator');
    expect(record).toMatchObject({ terminalId, kind: 'command' });
  });

  test.each<StationConfinement | undefined>(['workspace', undefined])(
    'refuses a %s session’s command and starts nothing',
    async (confinement) => {
      const authorize = vi.fn(async () => {});
      const { sessions, spawns, run } = await setup(authorize);
      await expect(run({ threadId: 'agent', confinement })).rejects.toThrow(
        /confined to its workspace/,
      );
      await expect(
        run({ threadId: 'agent', confinement }),
      ).rejects.toBeInstanceOf(TerminalSessionRefusal);
      expect(spawns).toEqual([]);
      expect(await sessions.listObservable('operator')).toEqual([]);
    },
  );

  test('refuses when the session is re-confined before the spawn', async () => {
    let confinement: StationConfinement = 'host';
    const authorize = vi.fn(async () => {
      // The first check passes; the session is then re-confined.
      confinement = 'workspace';
    });
    const { sessions, spawns, run } = await setup(authorize);
    const execution = {
      threadId: 'agent',
      get confinement() {
        return confinement;
      },
    };
    await expect(run(execution)).rejects.toThrow(/confined to its workspace/);
    expect(spawns).toEqual([]);
    expect(await sessions.listObservable('operator')).toMatchObject([
      { status: 'failed' },
    ]);
  });

  test('refuses another binding than the session’s own thread', async () => {
    const authorize = vi.fn(async () => {});
    const { spawns, run } = await setup(authorize);
    await expect(run(host, project)).rejects.toThrow(/own chat's binding/);
    await expect(
      run({ ...host, threadId: 'other' }, agentScope),
    ).rejects.toThrow(/own chat's binding/);
    expect(authorize).not.toHaveBeenCalled();
    expect(spawns).toEqual([]);
  });

  test('refuses when the host authority refuses, or offers none', async () => {
    const refusing = await setup(async () => {
      throw new TerminalSessionRefusal('Project not found');
    });
    await expect(refusing.run(host)).rejects.toThrow('Project not found');
    expect(refusing.spawns).toEqual([]);
    const absent = await setup();
    await expect(absent.run(host)).rejects.toThrow(
      'Agent terminal commands unavailable',
    );
    expect(absent.spawns).toEqual([]);
  });
});
