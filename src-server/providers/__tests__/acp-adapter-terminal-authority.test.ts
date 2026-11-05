/**
 * #2497: an ACP engine's `terminal/create` runs under its session's execution
 * authority, through the callbacks `AcpAdapter` builds for a live session
 * (not a helper): the session's server-derived confinement (#2493) at its
 * start, then as each turn carries it, reaches the terminal service's
 * agent-command seam, and a session confined to its workspace gets an
 * explicit refusal with nothing started. The same holds where the host has
 * no terminal sessions and a command would be a plain child process.
 */
import { realpath } from 'node:fs/promises';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import type { StationConfinement } from '@kontourai/station-contracts/provider';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import type { IPtyProcess } from '../../domain/pty-adapter.js';
import type { ACPProcess } from '../../services/acp/acp-process.js';
import { agentTerminalsFor } from '../../services/acp/acp-session-terminals.js';
import type { ShellHost } from '../../services/terminal/shell-host.js';
import { TerminalSessions } from '../../services/terminal/terminal-sessions.js';
import { AcpAdapter } from '../adapters/acp-adapter.js';
import { FakeAcpProcess } from './fake-acp-process.js';

const temp = trackTempDirs();
const CONNECTIONS: ACPConnectionConfig[] = [
  { id: 'lab', name: 'Lab', command: 'lab-cli', args: [], enabled: true },
];
const logger = { debug() {}, warn() {}, error() {}, info() {} };

/** A command that exits 0 a moment after it starts; no native process. */
function exitingProcess(): IPtyProcess {
  const exits = new Set<
    (event: { exitCode: number; signal: number | null }) => void
  >();
  setTimeout(() => {
    for (const exit of exits) exit({ exitCode: 0, signal: null });
  }, 5);
  return {
    pid: 4242,
    write() {},
    resize() {},
    kill() {},
    onData: () => () => {},
    onExit(cb) {
      exits.add(cb);
      return () => exits.delete(cb);
    },
  };
}

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

async function startSession(input: {
  confinement: StationConfinement | undefined;
  terminalSessions: boolean;
}) {
  const cwd = await realpath(temp('acp-terminal-authority-cwd-'));
  const spawns: string[] = [];
  const host: ShellHost = {
    spawn: async (spawn) => {
      spawns.push(spawn.launch?.file ?? 'shell');
      return exitingProcess();
    },
  };
  const authorizeAgentCommand = vi.fn(async () => {});
  const sessions = new TerminalSessions<string>(
    temp('acp-terminal-authority-home-'),
    host,
    {
      authorize: () => true,
      resolveRoot: async () => cwd,
      authorizeAgentCommand,
    },
  );
  let proc: FakeAcpProcess | undefined;
  const adapter = new AcpAdapter({
    getConnections: async () => CONNECTIONS,
    logger,
    managedWorkspaceHomeDir: temp('acp-terminal-authority-managed-'),
    processFactory: (opts) => {
      proc = new FakeAcpProcess(opts);
      return proc as unknown as ACPProcess;
    },
    ...(input.terminalSessions && {
      agentTerminals: agentTerminalsFor({
        sessions: () => sessions,
        projectId: () => undefined,
      }),
    }),
  });
  const drained = (async () => {
    for await (const _event of adapter.streamEvents());
  })();
  const threadId = `acp-terminal-authority-${crypto.randomUUID()}`;
  await adapter.startSession({
    provider: 'acp',
    threadId,
    cwd,
    metadata: { connectionId: 'lab' },
    ...(input.confinement && { confinement: input.confinement }),
  });
  stops.push(async () => {
    await adapter.stopAll();
    await drained;
    await sessions.dispose();
  });
  if (!proc) throw new Error('adapter did not start the engine');
  const engine = proc;
  const create = () =>
    engine.client.createTerminal({
      sessionId: 'native',
      command: process.execPath,
      args: ['-e', ''],
    });
  return {
    adapter,
    engine,
    threadId,
    sessions,
    spawns,
    authorizeAgentCommand,
    create,
  };
}

describe('ACP terminal/create on terminal sessions', () => {
  test('a host session runs its command through the agent-command authority', async () => {
    const { engine, threadId, spawns, authorizeAgentCommand, create } =
      await startSession({ confinement: 'host', terminalSessions: true });
    const { terminalId } = await create();
    await expect(
      engine.client.waitForTerminalExit({ sessionId: 'native', terminalId }),
    ).resolves.toEqual({ exitCode: 0, signal: null });
    expect(spawns).toEqual([process.execPath]);
    expect(authorizeAgentCommand).toHaveBeenCalledWith(
      { threadId, confinement: 'host' },
      { projectId: '.agent-terminals', bindingKey: `thread:${threadId}` },
    );
  });

  test.each<StationConfinement | undefined>(['workspace', undefined])(
    'a %s session is refused with the reason and nothing starts',
    async (confinement) => {
      const { sessions, spawns, create } = await startSession({
        confinement,
        terminalSessions: true,
      });
      await expect(create()).rejects.toMatchObject({
        code: -32600,
        message: expect.stringContaining('confined to its workspace'),
      });
      expect(spawns).toEqual([]);
      expect(await sessions.listObservable('operator')).toEqual([]);
    },
  );

  test('a turn that re-confines the session refuses its next command', async () => {
    const { adapter, engine, threadId, spawns, create } = await startSession({
      confinement: 'host',
      terminalSessions: true,
    });
    await adapter.sendTurn({
      threadId,
      input: 'continue',
      confinement: 'workspace',
    });
    await expect(create()).rejects.toMatchObject({ code: -32600 });
    expect(spawns).toEqual([]);
    engine.resolvePrompt('end_turn');
  });
});

describe('ACP terminal/create without terminal sessions', () => {
  test.each<StationConfinement | undefined>(['workspace', undefined])(
    'a %s session is refused before a child process starts',
    async (confinement) => {
      const { create } = await startSession({
        confinement,
        terminalSessions: false,
      });
      await expect(create()).rejects.toMatchObject({
        code: -32600,
        message: expect.stringContaining('confined to its workspace'),
      });
    },
  );

  test('a host session still runs its command', async () => {
    const { engine, create } = await startSession({
      confinement: 'host',
      terminalSessions: false,
    });
    const { terminalId } = await create();
    await expect(
      engine.client.waitForTerminalExit({ sessionId: 'native', terminalId }),
    ).resolves.toEqual({ exitCode: 0, signal: null });
  });
});
