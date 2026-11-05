/**
 * An agent's ACP terminals as `command` terminal sessions (#3994): each
 * `terminal/create` is a `TerminalSessions` command session, so it shares the
 * user's shells' journal, sanitizer, cwd confinement, session isolation and
 * (under the supervisor) workload host, and the user can watch it. The ACP
 * answers stay what the protocol defines: output from the journal, truncated
 * from the beginning to `outputByteLimit`, and an exit as an exit code or a
 * signal name, never both.
 *
 * #2497: the engine chose the program, so it runs only under the agent
 * session's execution authority (`TerminalSessions.openAgentCommand`): a
 * session confined to its workspace is refused with the reason, as an ACP
 * error, and nothing starts.
 */
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { RequestError } from '@agentclientprotocol/sdk/unstable';
import type { StationConfinement } from '@kontourai/station-contracts/provider';
import { signalName } from '../terminal/command-process.js';
import type { ShellLaunch } from '../terminal/shell-host.js';
import {
  type AgentCommandExecution,
  TerminalSessionRefusal,
} from '../terminal/terminal-sessions.js';

type Scope = { projectId: string; bindingKey: string };

/** The part of `TerminalSessions` an agent's terminals use. */
export interface AgentCommandSessions {
  openAgentCommand(
    execution: AgentCommandExecution,
    scope: Scope,
    input: {
      cwd: string;
      launch: ShellLaunch;
      outputCapBytes?: number;
    },
  ): Promise<{
    terminalId: string;
    exited: Promise<{
      exitCode: number | null;
      signal: number | null;
      outputCapped: boolean;
    }>;
  }>;
  readInternal(
    scope: Scope,
    terminalId: string,
    fromSeq?: number,
    maxReadBytes?: number,
  ): Promise<{
    outputCapped?: boolean;
    journal: {
      firstSeq: number;
      reset: boolean;
      records: { seq: number; data: string }[];
    };
  }>;
  closeInternal(scope: Scope, terminalId: string): Promise<void>;
}

export interface AcpExitStatus {
  exitCode: number | null;
  signal: string | null;
}

interface SessionTerminal {
  /** Absent when the command never started. */
  sessionId?: string;
  outputByteLimit?: number;
  exit: AcpExitStatus | null;
  exited: Promise<AcpExitStatus>;
  /** The reason a command never started, reported as its output. */
  spawnFailure?: string;
}

/**
 * The last `limit` bytes of `text`, never splitting a character, and whether
 * anything was dropped. ACP: "the client truncates from the beginning".
 */
export function limitAcpOutput(
  text: string,
  limit: number | null | undefined,
): { output: string; truncated: boolean } {
  if (limit === null || limit === undefined)
    return { output: text, truncated: false };
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= limit) return { output: text, truncated: false };
  let start = bytes.byteLength - limit;
  // Skip continuation bytes so the kept text starts on a character.
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start++;
  return { output: bytes.subarray(start).toString('utf8'), truncated: true };
}

function acpExit(exit: {
  exitCode: number | null;
  signal: number | null;
}): AcpExitStatus {
  const signal = signalName(exit.signal);
  // A signal death has no exit code; the process never produced one.
  return signal
    ? { exitCode: null, signal }
    : { exitCode: exit.exitCode, signal: null };
}

/** One agent session's terminals; ids are the ACP ids the bridge assigns. */
export class AcpSessionTerminals {
  private readonly terminals = new Map<string, SessionTerminal>();

  constructor(
    private readonly sessions: AgentCommandSessions,
    private readonly scope: Scope,
    /** The agent session's directory: a terminal's cwd must be inside it. */
    private readonly root: string,
    /** The session's execution authority, read at each create. */
    private readonly execution: () => AgentCommandExecution,
    private readonly outputCapBytes?: number,
  ) {}

  has(id: string): boolean {
    return this.terminals.has(id);
  }

  async create(
    id: string,
    input: {
      command: string;
      args: string[];
      cwd?: string | null;
      env?: Record<string, string>;
      outputByteLimit?: number | null;
    },
  ): Promise<void> {
    const cwd = await this.confine(input.cwd || this.root);
    const terminal: SessionTerminal = {
      ...(typeof input.outputByteLimit === 'number' && {
        outputByteLimit: input.outputByteLimit,
      }),
      exit: null,
      exited: Promise.resolve({ exitCode: null, signal: null }),
    };
    try {
      const opened = await this.sessions.openAgentCommand(
        this.execution(),
        this.scope,
        {
          cwd,
          launch: {
            file: input.command,
            args: input.args,
            ...(input.env && { env: input.env }),
          },
          ...(this.outputCapBytes !== undefined && {
            outputCapBytes: this.outputCapBytes,
          }),
        },
      );
      terminal.sessionId = opened.terminalId;
      terminal.exited = opened.exited.then((exit) => {
        terminal.exit = acpExit(exit);
        return terminal.exit;
      });
    } catch (error) {
      // Refused, not failed: the engine is told why, and nothing started.
      if (error instanceof TerminalSessionRefusal)
        throw RequestError.invalidRequest(
          { command: input.command, refused: 'execution-authority' },
          error.message,
        );
      const message = error instanceof Error ? error.message : String(error);
      if (!/spawn failed/.test(message)) throw error;
      // A command that never started is a failed terminal, reported through
      // the shell's failure channel: 127 not found, 126 not runnable.
      terminal.spawnFailure = `${message}\n`;
      terminal.exit = {
        exitCode:
          (error as { code?: unknown }).code === 'ENOENT' ||
          /\bENOENT\b/.test(message)
            ? 127
            : 126,
        signal: null,
      };
      terminal.exited = Promise.resolve(terminal.exit);
    }
    this.terminals.set(id, terminal);
  }

  async output(id: string): Promise<{
    output: string;
    truncated: boolean;
    exitStatus: AcpExitStatus | null;
  }> {
    const terminal = this.get(id);
    let text = terminal.spawnFailure ?? '';
    let dropped = false;
    if (terminal.sessionId) {
      const read = await this.sessions.readInternal(
        this.scope,
        terminal.sessionId,
      );
      text = read.journal.records.map((record) => record.data).join('');
      // Retention evicted early output, or the cap ended the command.
      dropped =
        read.journal.reset ||
        read.journal.firstSeq > 1 ||
        read.outputCapped === true;
    }
    const limited = limitAcpOutput(text, terminal.outputByteLimit);
    return {
      output: limited.output,
      truncated: limited.truncated || dropped,
      exitStatus: terminal.exit,
    };
  }

  waitForExit(id: string): Promise<AcpExitStatus> {
    return this.get(id).exited;
  }

  /** Ends the command; its output stays readable until it is released. */
  async kill(id: string): Promise<void> {
    const terminal = this.terminals.get(id);
    if (terminal?.sessionId)
      await this.sessions.closeInternal(this.scope, terminal.sessionId);
  }

  async release(id: string): Promise<void> {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    this.terminals.delete(id);
    if (terminal.sessionId)
      await this.sessions.closeInternal(this.scope, terminal.sessionId);
  }

  private get(id: string): SessionTerminal {
    const terminal = this.terminals.get(id);
    if (!terminal)
      throw RequestError.invalidParams(
        { terminalId: id },
        `unknown terminal '${id}'`,
      );
    return terminal;
  }

  /** The agent's own directory or one inside it; anything else is refused. */
  private async confine(requested: string): Promise<string> {
    if (!isAbsolute(requested))
      throw RequestError.invalidParams(
        { cwd: requested },
        `Station refuses terminal directory '${requested}': it must be absolute.`,
      );
    const [root, cwd] = await Promise.all([
      realpath(this.root),
      realpath(requested).catch(() => {
        throw RequestError.invalidParams(
          { cwd: requested },
          `Station refuses terminal directory '${requested}': it does not exist.`,
        );
      }),
    ]);
    const inside = relative(root, cwd);
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
      throw RequestError.invalidParams(
        { cwd: requested },
        `Station refuses terminal directory '${requested}': it is outside this session's directory.`,
      );
    return cwd;
  }
}

/** The Project an agent's terminals are recorded under when its session has none. */
export const AGENT_TERMINAL_UNBOUND_PROJECT = '.agent-terminals';

/**
 * The adapter's `agentTerminals` option: an agent session's terminals are
 * recorded under its Project and its thread's binding, so they are listed
 * beside that thread's work. Undefined until the host has terminal sessions.
 */
export function agentTerminalsFor(source: {
  sessions: () => AgentCommandSessions | undefined;
  projectId: (slug: string) => string | undefined;
}) {
  return (input: {
    threadId: string;
    projectSlug?: string;
    cwd: string;
    /** The session's current server-derived confinement (#2493). */
    confinement: () => StationConfinement | undefined;
  }): AcpSessionTerminals | undefined => {
    const sessions = source.sessions();
    if (!sessions) return undefined;
    return new AcpSessionTerminals(
      sessions,
      {
        projectId:
          (input.projectSlug && source.projectId(input.projectSlug)) ||
          AGENT_TERMINAL_UNBOUND_PROJECT,
        bindingKey: `thread:${input.threadId}`,
      },
      input.cwd,
      () => ({ threadId: input.threadId, confinement: input.confinement() }),
    );
  };
}
