import { randomUUID } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { StationConfinement } from '@kontourai/station-contracts/provider';
import type { TerminalLaunchProfile } from '@kontourai/station-contracts/terminal-transport';
import { z } from 'zod/v3';
import { FileTerminalHistoryStore } from '../../adapters/file-terminal-history-store.js';
import type { IPtyProcess } from '../../domain/pty-adapter.js';
import { createLogger } from '../../utils/logger.js';
import { DEFAULT_COMMAND_OUTPUT_CAP_BYTES } from './command-process.js';
import {
  type HostedShellProcess,
  isHostedShellProcess,
  type ShellHost,
  type ShellJournalSpec,
  type ShellLaunch,
  type ShellSpawnKind,
} from './shell-host.js';
import {
  readPackageScripts,
  type TerminalCommandProgram,
  TerminalProgramUnavailable,
} from './terminal-command-programs.js';
import {
  resolveTerminalJournalOptions,
  TerminalJournal,
  type TerminalJournalOptions,
} from './terminal-journal.js';
import {
  TerminalHistoryLocationUnavailable,
  TerminalJournalPrivacy,
} from './terminal-journal-privacy.js';
import {
  defaultTerminalJournalDirectory,
  type TerminalRetention,
} from './terminal-retention.js';

/** Written between a shell's earlier output and the shell reopened after a restart. */
export const TERMINAL_RESTORED_DIVIDER =
  '\r\n\x1b[2m── restored after restart ──\x1b[0m\r\n';

/**
 * The divider as a restored shell's journal records it. ConPTY starts by
 * clearing the screen and painting from its top-left, which would erase the
 * divider and the earlier output still on screen; on Windows a screenful of
 * line feeds first moves both into scrollback, above the new shell.
 */
function restoredDivider(rows: number): string {
  return process.platform === 'win32'
    ? `${TERMINAL_RESTORED_DIVIDER}${'\r\n'.repeat(rows)}`
    : TERMINAL_RESTORED_DIVIDER;
}

const limitsSchema = z
  .object({
    maxSessions: z.number().int().min(1).max(256).default(32),
    maxDiskBytes: z
      .number()
      .int()
      .safe()
      .min(1024)
      .max(1024 ** 4)
      .default(1024 ** 3),
    maxTailBytes: z
      .number()
      .int()
      .safe()
      .min(1024)
      .max(1024 ** 4)
      .default(64 * 1024 * 1024),
  })
  .strict();

const logger = createLogger({ name: 'terminal-sessions' });
const scopeSchema = z
  .object({ projectId: z.string().min(1), bindingKey: z.string().min(1) })
  .strict();
type TerminalSessionScope = z.infer<typeof scopeSchema>;
const recordSchema = scopeSchema
  .extend({
    terminalId: z.string().uuid(),
    cwd: z.string().min(1),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
    status: z.enum(['starting', 'running', 'exited', 'failed']),
    journalUnavailable: z.boolean().default(false),
    createdAt: z.number(),
    /** The named program, for presentation; never a stored executable. */
    launch: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('shell') }).strict(),
        z
          .object({
            kind: z.literal('agent'),
            connectionId: z.string(),
            mode: z.string(),
          })
          .strict(),
        z.object({ kind: z.literal('server') }).strict(),
        // A command session's program, re-resolved by name on restart.
        z
          .object({ kind: z.literal('script'), name: z.string().min(1) })
          .strict(),
        // An approved agent command, kept for display; never run again.
        z
          .object({ kind: z.literal('run'), command: z.string().min(1) })
          .strict(),
      ])
      .optional(),
    exitCode: z.number().int().nullable().optional(),
    /** The signal number that ended it, when one did. */
    exitSignal: z.number().int().nullable().optional(),
    /**
     * Absent: an interactive PTY. `command`: a program with no PTY whose
     * output is capped at `outputCapBytes` (an agent's ACP terminal or
     * approved run, or a package script). Only a script can be restarted: it
     * is resolved again by name. It is never a user shell: no ordinal and no
     * restore.
     */
    kind: z.literal('command').optional(),
    outputCapBytes: z.number().int().optional(),
    /** Its output passed `outputCapBytes` and it was ended. */
    outputCapped: z.boolean().optional(),
    /**
     * The latest explicit restart: the same id, a new run whose output
     * begins after `afterSeq` in a new journal segment.
     */
    restart: z
      .object({
        count: z.number().int().min(1),
        afterSeq: z.number().int().nonnegative(),
        at: z.number(),
      })
      .strict()
      .optional(),
    legacy: z
      .object({
        projectSlug: z.string(),
        terminalId: z.string(),
        imported: z.boolean(),
      })
      .optional(),
    /** A shell's stable "Shell N" number within its binding. */
    ordinal: z.number().int().positive().optional(),
    /** The journal's parent directory; absent is `<home>/terminal-journals`. */
    journalRoot: z.string().min(1).optional(),
    /** Opened with history off: its journal was never written to disk. */
    persist: z.literal(false).optional(),
    /** When it ended, for age-based expiry. */
    endedAt: z.number().optional(),
    /** When a shell was reopened after its host restarted. */
    restoredAt: z.number().optional(),
    /**
     * Why a shell that ended with its host was not reopened (#492): its
     * binding no longer resolves, or resolves somewhere its directory is not.
     * The same reason is written to its journal, below its earlier output.
     */
    restoreRefused: z
      .object({ reason: z.string().min(1), at: z.number() })
      .strict()
      .optional(),
    /** Ended because its in-process host stopped with the core, not by itself. */
    hostStopped: z.literal(true).optional(),
  })
  .strict();
type SessionRecord = z.infer<typeof recordSchema>;
/**
 * A record as a caller sees it. `journalRoot` is storage layout and never
 * leaves the service; the launch directory and the process id are host
 * details for operate authority only.
 */
export type TerminalSessionView = Omit<SessionRecord, 'cwd' | 'journalRoot'> & {
  /** The launch directory; present only for a caller who may operate it. */
  cwd?: string;
};

function sessionView(
  record: SessionRecord,
  operate: boolean,
): TerminalSessionView {
  // Named fields, never a spread: a field added to the record stays
  // internal until it is projected here deliberately.
  return {
    projectId: record.projectId,
    bindingKey: record.bindingKey,
    terminalId: record.terminalId,
    cols: record.cols,
    rows: record.rows,
    status: record.status,
    journalUnavailable: record.journalUnavailable,
    createdAt: record.createdAt,
    ...(record.launch && { launch: { ...record.launch } }),
    ...(record.exitCode !== undefined && { exitCode: record.exitCode }),
    ...(record.exitSignal !== undefined && { exitSignal: record.exitSignal }),
    ...(record.kind && { kind: record.kind }),
    ...(record.outputCapBytes !== undefined && {
      outputCapBytes: record.outputCapBytes,
    }),
    ...(record.outputCapped !== undefined && {
      outputCapped: record.outputCapped,
    }),
    ...(record.restart && { restart: { ...record.restart } }),
    ...(record.legacy && { legacy: { ...record.legacy } }),
    ...(record.ordinal !== undefined && { ordinal: record.ordinal }),
    ...(record.persist !== undefined && { persist: record.persist }),
    ...(record.endedAt !== undefined && { endedAt: record.endedAt }),
    ...(record.restoredAt !== undefined && { restoredAt: record.restoredAt }),
    // An authored reason with no host path, also written to the journal an
    // observer may read, so observe authority is enough (#492).
    ...(record.restoreRefused && {
      restoreRefused: { ...record.restoreRefused },
    }),
    ...(record.hostStopped && { hostStopped: record.hostStopped }),
    ...(operate && { cwd: record.cwd }),
  };
}
type LiveSession = {
  process: IPtyProcess;
  exit: Promise<void>;
};
type TerminalExit = {
  exitCode: number | null;
  /** The signal number that ended it, or null. */
  signal: number | null;
  outputCapped: boolean;
};
/** A command's cap is refused outside these bounds, never clamped. */
const outputCapSchema = z
  .number()
  .int()
  .min(1024)
  .max(1024 ** 3);
type SessionJournal = Pick<
  TerminalJournal,
  'read' | 'flush' | 'discard' | 'seal' | 'append' | 'backpressured' | 'drained'
>;

export class TerminalSessionRefusal extends Error {}

/**
 * #2497: the authority an agent's own terminal command (an ACP
 * `terminal/create`) runs under: the agent session it came from and that
 * session's server-derived execution confinement (#2493), never anything the
 * engine sent.
 */
export interface AgentCommandExecution {
  threadId: string;
  /** The session's current confinement; absent is `workspace`. */
  confinement: StationConfinement | undefined;
}

/**
 * #2497: why an agent's terminal command may not run on this host, or
 * undefined when it may. An agent command runs as Station's own OS user with
 * no sandbox: Station has no confinement provider for it (an ACP engine has
 * no process sandbox, `acp-approval-mode.ts`). So only a `host` session, one
 * a caller who may grant full access started, runs one; a `workspace`
 * session's command is refused rather than run unconfined.
 */
export function agentHostCommandRefusal(
  confinement: StationConfinement | undefined,
): string | undefined {
  return confinement === 'host'
    ? undefined
    : 'Station runs an agent terminal command on this computer only in a chat started with full access. This chat is confined to its workspace and Station has no sandbox for agent terminal commands, so the command did not run. Ask the person to run it.';
}

/** Written below a shell's earlier output when it is not reopened (#492). */
function terminalRestoreRefusedNote(reason: string): string {
  return `\r\n\x1b[2m── not restored after restart: ${reason} ──\x1b[0m\r\n`;
}

/**
 * A command session's program cannot run, with an authored reason: its
 * directory changed, or `TerminalProgramUnavailable`'s.
 */
export class TerminalCommandUnavailable extends TerminalSessionRefusal {}

interface TerminalSessionAuthority<Principal> {
  authorize(
    principal: Principal,
    scope: TerminalSessionScope,
    operation: 'observe' | 'operate',
  ): boolean | Promise<boolean>;
  resolveRoot(
    principal: Principal,
    scope: TerminalSessionScope,
  ): Promise<string>;
  /** Resolves a named program; refuses (throws) one this caller may not run. */
  resolveLaunch?(
    principal: Principal,
    scope: TerminalSessionScope,
    profile: Exclude<TerminalLaunchProfile, { kind: 'shell' }>,
  ): Promise<ShellLaunch>;
  /** The Project slug legacy history was written under. */
  legacyProjectSlug?(
    principal: Principal,
    scope: TerminalSessionScope,
  ): Promise<string>;
  /**
   * #492: the CURRENT root of a binding whose shell ended because its host
   * restarted, resolved under the authority that binding was recorded with
   * (its Project; for a thread, the chat's recorded owner), never a principal
   * of the moment. Throws `TerminalSessionRefusal` with the reason it cannot
   * be resolved; the shell then stays ended with that reason. Absent: no
   * shell is reopened.
   */
  restoreRoot?(scope: TerminalSessionScope): Promise<string>;
  /**
   * #2497: host checks for an agent's own terminal command in `scope`, after
   * the service has required a host-confined session. Throws
   * `TerminalSessionRefusal` to refuse. Absent: no agent command runs.
   */
  authorizeAgentCommand?(
    execution: AgentCommandExecution,
    scope: TerminalSessionScope,
  ): Promise<void>;
  /** Resolves a command session's program in `cwd`; throws to refuse it. */
  resolveCommand?(
    principal: Principal,
    scope: TerminalSessionScope,
    program: TerminalCommandProgram,
    cwd: string,
  ): Promise<ShellLaunch>;
}

/**
 * A binding's canonical root and a directory inside it: a relative
 * `requested` path, or a function of the root for a stored directory.
 */
export async function confineTerminalDirectory(
  bindingRoot: string,
  requested: string | ((root: string) => string),
): Promise<{ root: string; cwd: string }> {
  const root = await realpath(bindingRoot);
  if (typeof requested === 'string' && isAbsolute(requested))
    throw new TerminalSessionRefusal('Terminal subdirectory must be relative');
  const cwd = await realpath(
    typeof requested === 'string' ? resolve(root, requested) : requested(root),
  );
  const inside = relative(root, cwd);
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    throw new TerminalSessionRefusal(
      'Terminal directory is outside its binding',
    );
  return { root, cwd };
}

function isShell(record: SessionRecord): boolean {
  return (
    record.kind !== 'command' &&
    (!record.launch || record.launch.kind === 'shell')
  );
}

/**
 * Agent commands are retained apart from everything else, so a busy agent
 * can only expire its own ended commands, never a person's shell history or
 * script runs.
 */
const COMMAND_SESSION_SLOTS = 16;
type RetentionPool = 'command' | 'session';
function poolOf(record: SessionRecord): RetentionPool {
  return record.kind === 'command' && record.launch?.kind !== 'script'
    ? 'command'
    : 'session';
}

function sameScope(a: TerminalSessionScope, b: TerminalSessionScope) {
  return a.projectId === b.projectId && a.bindingKey === b.bindingKey;
}

/** Project/binding authority belongs here, independently of any transport. */
export class TerminalSessions<Principal> {
  private records = new Map<string, SessionRecord>();
  private journals = new Map<string, Promise<SessionJournal>>();
  private live = new Map<string, LiveSession>();
  private stopping = new Map<string, Promise<void>>();
  private commands: Promise<unknown> = Promise.resolve();
  private persistence: Promise<void> = Promise.resolve();
  private readonly ready: Promise<void>;
  private disposed = false;
  private readonly budget: z.infer<typeof limitsSchema>;
  private readonly journalOptions: TerminalJournalOptions;
  private readonly defaultRetention: TerminalRetention;
  private retention: TerminalRetention;
  private readonly privacy: TerminalJournalPrivacy;
  private readonly listeners = new Set<(terminalId: string) => void>();
  private readonly exits = new Map<string, (exit: TerminalExit) => void>();

  constructor(
    private readonly home: string,
    private readonly host: ShellHost,
    private readonly authority: TerminalSessionAuthority<Principal>,
    journalOptions: Partial<TerminalJournalOptions> = {},
    limits: {
      maxSessions?: number;
      maxDiskBytes?: number;
      maxTailBytes?: number;
    } = {},
    /**
     * The retention settings, read again before each open and maintenance
     * pass. Absent: the constructor's limits, with no age expiry.
     */
    private readonly readRetention?: () => Promise<TerminalRetention>,
    /** Keeps each journal's directory private to this user (Windows ACLs). */
    privacy?: TerminalJournalPrivacy,
  ) {
    this.privacy =
      privacy ??
      new TerminalJournalPrivacy(defaultTerminalJournalDirectory(home));
    this.journalOptions = resolveTerminalJournalOptions(journalOptions);
    this.budget = limitsSchema.parse(limits);
    this.defaultRetention = {
      persist: this.journalOptions.persist,
      directory: defaultTerminalJournalDirectory(home),
      maxAgeMs: Number.POSITIVE_INFINITY,
      maxTerminalBytes: this.journalOptions.maxBytes,
      maxTotalBytes: this.budget.maxDiskBytes,
    };
    this.retention = this.defaultRetention;
    if (this.capacity() < 1)
      throw new Error('Terminal journal exceeds global storage budget');
    this.ready = this.load();
    // Initialization remains a rejection for every caller, without an
    // unhandled rejection before the first request arrives.
    void this.ready.catch((error: unknown) =>
      logger.error('Terminal sessions unavailable', { error }),
    );
  }

  open(
    principal: Principal,
    scope: TerminalSessionScope,
    input: {
      cols: number;
      rows: number;
      subdirectory?: string;
      legacy?: { projectSlug: string; terminalId: string };
      /** Socket form of `legacy`: the slug is resolved by the server. */
      legacyTerminalId?: string;
      launch?: TerminalLaunchProfile;
      /**
       * Returns the binding's running shell instead of opening a second one.
       * Opens are serialized, so concurrent callers share one shell.
       */
      adopt?: boolean;
    },
  ) {
    return this.serialize(async () => {
      await this.check(principal, scope, 'operate');
      await this.ready;
      if (this.disposed)
        throw new TerminalSessionRefusal('Terminal sessions stopped');
      const shellRequested = !input.launch || input.launch.kind === 'shell';
      if (
        input.adopt &&
        shellRequested &&
        !input.legacy &&
        input.legacyTerminalId === undefined
      ) {
        const running = [...this.records.values()].find(
          (record) =>
            sameScope(record, scope) &&
            isShell(record) &&
            record.status === 'running' &&
            this.live.has(record.terminalId),
        );
        if (running)
          return {
            ...(await this.read(principal, scope, running.terminalId)),
            adopted: true as const,
          };
      }
      await this.maintain();
      if (input.legacyTerminalId !== undefined && !input.legacy) {
        if (!this.authority.legacyProjectSlug)
          throw new TerminalSessionRefusal('Legacy terminals unavailable');
        input = {
          ...input,
          legacy: {
            projectSlug: await this.authority.legacyProjectSlug(
              principal,
              scope,
            ),
            terminalId: input.legacyTerminalId,
          },
        };
      }
      const profile = input.launch;
      let launch: ShellLaunch | undefined;
      if (profile && profile.kind !== 'shell') {
        if (!this.authority.resolveLaunch)
          throw new TerminalSessionRefusal('Launch profile unavailable');
        launch = await this.authority.resolveLaunch(principal, scope, profile);
      }
      const { root, cwd } = await this.confine(
        principal,
        scope,
        input.subdirectory ?? '.',
      );
      await this.check(principal, scope, 'operate');
      let legacyHistory = '';
      if (input.legacy) {
        if (scope.bindingKey !== 'project')
          throw new TerminalSessionRefusal(
            'Legacy terminals require the project binding',
          );
        const existing = [...this.records.values()].find(
          (record) =>
            record.projectId === scope.projectId &&
            record.legacy?.projectSlug === input.legacy!.projectSlug &&
            record.legacy.terminalId === input.legacy!.terminalId,
        );
        if (existing) return this.read(principal, scope, existing.terminalId);
        // Today's filenames lose punctuation. A collision must not import
        // one Project's output into a different Project or old id.
        const filename = this.legacyFilename(input.legacy);
        if (
          [...this.records.values()].some(
            (record) =>
              record.legacy && this.legacyFilename(record.legacy) === filename,
          )
        )
          throw new TerminalSessionRefusal('Ambiguous legacy terminal history');
        const source = await new FileTerminalHistoryStore(
          join(this.home, 'terminal-history'),
        ).loadForProject(
          `${input.legacy.projectSlug}:${input.legacy.terminalId}`,
          scope.projectId,
        );
        if (source.state !== 'owned')
          throw new TerminalSessionRefusal(
            'Legacy terminal ownership unavailable',
          );
        legacyHistory = source.history;
      }
      const record = recordSchema.parse({
        ...scope,
        terminalId: randomUUID(),
        cwd,
        cols: input.cols,
        rows: input.rows,
        status: 'starting',
        createdAt: Date.now(),
        ...(profile && { launch: profile }),
        ...(input.legacy && { legacy: { ...input.legacy, imported: false } }),
        ...(shellRequested && { ordinal: this.nextOrdinal(scope) }),
        ...this.storage(),
      });
      await this.makeRoom(record, principal);
      this.records.set(record.terminalId, record);
      await this.persist();
      try {
        const journal = await this.journal(record);
        if (record.legacy) {
          for (let offset = 0; offset < legacyHistory.length; offset += 16384)
            await journal.append(legacyHistory.slice(offset, offset + 16384));
          journal.seal();
          record.legacy.imported = true;
          await this.persist();
        }
        await this.recheck(principal, scope, root, cwd);
        // A host that journals output itself continues this journal on disk.
        await journal.flush();
        const proc = await this.host.spawn({
          terminalId: record.terminalId,
          cwd,
          cols: record.cols,
          rows: record.rows,
          journal: this.journalSpec(record),
          ...(launch && { launch }),
        });
        this.track(record, proc, journal);
        record.status = 'running';
        await this.persist();
        return await this.read(principal, scope, record.terminalId);
      } catch (error) {
        await this.stop(record.terminalId);
        record.status = 'failed';
        record.endedAt = Date.now();
        await this.persist();
        throw error;
      }
    });
  }

  /**
   * Server-owned launch (engine sign-in): Station chose the program, its
   * arguments and directory, so no principal authorizes them. Clients attach
   * by id under `scope`, through the ordinary observe/operate checks.
   */
  openInternal(
    scope: TerminalSessionScope,
    input: {
      cwd: string;
      cols: number;
      rows: number;
      launch: ShellLaunch;
      /**
       * `command`: no PTY, output capped at `outputCapBytes` (default 16
       * MiB). The caller confines `cwd`; this only canonicalizes it.
       */
      kind?: 'command';
      outputCapBytes?: number;
    },
  ): Promise<{ terminalId: string; exited: Promise<TerminalExit> }> {
    return this.launchInternal(scope, input);
  }

  /**
   * An agent's own terminal command (#2497): the engine chose the program,
   * so unlike `openInternal` it runs only under the agent session's
   * execution authority. The session must be host-confined
   * (`agentHostCommandRefusal`), `scope` must be its own thread binding, and
   * the host's `authorizeAgentCommand` must allow it; all of it is checked
   * before anything is recorded and again immediately before the spawn. The
   * caller confines `cwd` to the session's directory.
   */
  openAgentCommand(
    execution: AgentCommandExecution,
    scope: TerminalSessionScope,
    input: {
      cwd: string;
      launch: ShellLaunch;
      outputCapBytes?: number;
    },
  ): Promise<{ terminalId: string; exited: Promise<TerminalExit> }> {
    const authorize = async () => {
      const refusal = agentHostCommandRefusal(execution.confinement);
      if (refusal) throw new TerminalSessionRefusal(refusal);
      if (scope.bindingKey !== `thread:${execution.threadId}`)
        throw new TerminalSessionRefusal(
          "An agent's terminal command runs only in its own chat's binding",
        );
      if (!this.authority.authorizeAgentCommand)
        throw new TerminalSessionRefusal('Agent terminal commands unavailable');
      await this.authority.authorizeAgentCommand(execution, scope);
    };
    return this.launchInternal(
      scope,
      { ...input, cols: 80, rows: 24, kind: 'command' },
      authorize,
    );
  }

  private launchInternal(
    scope: TerminalSessionScope,
    input: {
      cwd: string;
      cols: number;
      rows: number;
      launch: ShellLaunch;
      kind?: 'command';
      outputCapBytes?: number;
    },
    authorize?: () => Promise<void>,
  ): Promise<{ terminalId: string; exited: Promise<TerminalExit> }> {
    return this.serialize(async () => {
      await authorize?.();
      await this.ready;
      if (this.disposed)
        throw new TerminalSessionRefusal('Terminal sessions stopped');
      const outputCapBytes =
        input.kind === 'command'
          ? outputCapSchema.parse(
              input.outputCapBytes ?? DEFAULT_COMMAND_OUTPUT_CAP_BYTES,
            )
          : undefined;
      const spawnKind: ShellSpawnKind =
        outputCapBytes === undefined ? {} : { kind: 'command', outputCapBytes };
      const cwd = await realpath(input.cwd);
      const record = recordSchema.parse({
        ...scopeSchema.parse(scope),
        terminalId: randomUUID(),
        cwd,
        cols: input.cols,
        rows: input.rows,
        status: 'starting',
        createdAt: Date.now(),
        ...(outputCapBytes === undefined
          ? { launch: { kind: 'server' } }
          : { kind: 'command', outputCapBytes }),
        ...this.storage(),
      });
      await this.makeRoom(record);
      this.records.set(record.terminalId, record);
      await this.persist();
      const exited = new Promise<TerminalExit>((done) =>
        this.exits.set(record.terminalId, done),
      );
      try {
        const journal = await this.journal(record);
        await journal.flush();
        // The authority can change while the record is written (a turn
        // re-confines the session): checked again at the launch seam.
        await authorize?.();
        const proc = await this.host.spawn({
          terminalId: record.terminalId,
          cwd,
          cols: record.cols,
          rows: record.rows,
          journal: this.journalSpec(record),
          launch: input.launch,
          ...spawnKind,
        });
        this.track(record, proc, journal);
        record.status = 'running';
        await this.persist();
      } catch (error) {
        this.exits.delete(record.terminalId);
        await this.stop(record.terminalId);
        record.status = 'failed';
        record.endedAt = Date.now();
        await this.persist();
        throw error;
      }
      return { terminalId: record.terminalId, exited };
    });
  }

  /**
   * A person's command session (#3994): a package script, or an agent's
   * command the person approved. Needs operate authority on `scope`; the
   * program is resolved in the binding's directory. With `expectedCwd`, a
   * directory that no longer resolves to it is refused, so a command runs
   * only where the person was shown it would.
   */
  openCommand(
    principal: Principal,
    scope: TerminalSessionScope,
    input: {
      program: TerminalCommandProgram;
      subdirectory?: string;
      expectedCwd?: string;
    },
  ) {
    return this.serialize(async () => {
      await this.check(principal, scope, 'operate');
      await this.ready;
      if (this.disposed)
        throw new TerminalSessionRefusal('Terminal sessions stopped');
      await this.maintain();
      const { root, cwd } = await this.confine(
        principal,
        scope,
        input.subdirectory ?? '.',
      );
      if (input.expectedCwd !== undefined && cwd !== input.expectedCwd)
        throw new TerminalCommandUnavailable('Its directory has changed');
      const launch = await this.resolveCommand(
        principal,
        scope,
        input.program,
        cwd,
      );
      const record = recordSchema.parse({
        ...scope,
        terminalId: randomUUID(),
        cwd,
        cols: 80,
        rows: 24,
        status: 'starting',
        createdAt: Date.now(),
        kind: 'command',
        outputCapBytes: DEFAULT_COMMAND_OUTPUT_CAP_BYTES,
        launch: input.program,
        ...this.storage(),
      });
      await this.makeRoom(record, principal);
      this.records.set(record.terminalId, record);
      await this.persist();
      const exited = new Promise<TerminalExit>((done) =>
        this.exits.set(record.terminalId, done),
      );
      try {
        const journal = await this.journal(record);
        await this.recheck(principal, scope, root, cwd);
        await journal.flush();
        const proc = await this.host.spawn({
          terminalId: record.terminalId,
          cwd,
          cols: record.cols,
          rows: record.rows,
          journal: this.journalSpec(record),
          launch,
          kind: 'command',
          outputCapBytes: DEFAULT_COMMAND_OUTPUT_CAP_BYTES,
        });
        this.track(record, proc, journal);
        record.status = 'running';
        await this.persist();
      } catch (error) {
        this.exits.delete(record.terminalId);
        await this.stop(record.terminalId);
        record.status = 'failed';
        record.endedAt = Date.now();
        await this.persist();
        throw error;
      }
      // Opening needs operate authority, checked above.
      return { record: sessionView(record, true), exited };
    });
  }

  /** The package scripts in the binding's directory, for the script runner. */
  async scripts(principal: Principal, scope: TerminalSessionScope) {
    await this.check(principal, scope, 'observe');
    const { root } = await this.confine(principal, scope, '.');
    const scripts = await readPackageScripts(root);
    await this.check(principal, scope, 'observe');
    return scripts;
  }

  private async resolveCommand(
    principal: Principal,
    scope: TerminalSessionScope,
    program: TerminalCommandProgram,
    cwd: string,
  ): Promise<ShellLaunch> {
    if (!this.authority.resolveCommand)
      throw new TerminalSessionRefusal('Command sessions unavailable');
    try {
      return await this.authority.resolveCommand(
        principal,
        scope,
        program,
        cwd,
      );
    } catch (error) {
      // Only an authored reason is passed on; anything else stays a failure.
      if (error instanceof TerminalProgramUnavailable)
        throw new TerminalCommandUnavailable(error.message);
      throw error;
    }
  }

  /** Ends a server-owned launch; refuses an id outside `scope`. */
  closeInternal(scope: TerminalSessionScope, terminalId: string) {
    return this.serialize(async () => {
      await this.ready;
      const record = this.internalRecord(scope, terminalId);
      await this.stop(terminalId);
      if (record.status !== 'failed') record.status = 'exited';
      record.endedAt ??= Date.now();
      await (await this.journal(record)).flush();
      await this.persist();
    });
  }

  /**
   * Ends every running session of a deleted Project, in every binding. Their
   * records and history stay, like any ended terminal's, until retention
   * expires them; a deleted Project's shells are never restored.
   */
  endProject(projectId: string) {
    return this.serialize(async () => {
      await this.ready;
      const records = [...this.records.values()].filter(
        (record) =>
          record.projectId === projectId && this.live.has(record.terminalId),
      );
      for (const record of records) {
        await this.stop(record.terminalId);
        if (record.status !== 'failed') record.status = 'exited';
        record.endedAt ??= Date.now();
        await (await this.journal(record)).flush();
      }
      if (records.length) await this.persist();
      return records.length;
    });
  }

  /**
   * A server-owned launch's journal, for the server component that started
   * it (an agent's ACP terminal); refuses an id outside `scope`.
   */
  async readInternal(
    scope: TerminalSessionScope,
    terminalId: string,
    fromSeq = 0,
    maxReadBytes = Number.MAX_SAFE_INTEGER,
  ) {
    await this.ready;
    const record = this.internalRecord(scope, terminalId);
    if (record.journalUnavailable)
      throw new TerminalSessionRefusal('Terminal journal unavailable');
    const journal = await (await this.journal(record)).read(
      fromSeq,
      maxReadBytes,
    );
    return { ...record, journal };
  }

  private internalRecord(scope: TerminalSessionScope, terminalId: string) {
    const record = this.records.get(terminalId);
    if (
      !record ||
      record.projectId !== scope.projectId ||
      record.bindingKey !== scope.bindingKey
    )
      throw new TerminalSessionRefusal('Terminal not found');
    return record;
  }

  /**
   * Ends the running program, if any, and starts it again under the same
   * id (#3994): its journal continues in a new segment, so earlier output
   * stays readable. `subdirectory` moves it within its binding's root; an
   * unchanged directory is confined to the binding again, which may have
   * moved. Server launches and commands other than scripts store no program
   * and are refused; a script is resolved again by name.
   */
  restart(
    principal: Principal,
    scope: TerminalSessionScope,
    terminalId: string,
    input: { subdirectory?: string } = {},
  ) {
    return this.serialize(async () => {
      const record = await this.find(principal, scope, terminalId, 'operate');
      await this.ready;
      if (this.disposed)
        throw new TerminalSessionRefusal('Terminal sessions stopped');
      if (
        record.launch?.kind === 'server' ||
        (record.kind === 'command' && record.launch?.kind !== 'script')
      )
        throw new TerminalSessionRefusal('This terminal cannot be restarted');
      if (record.journalUnavailable)
        throw new TerminalSessionRefusal('Terminal journal unavailable');
      if (record.legacy && !record.legacy.imported)
        throw new TerminalSessionRefusal('Terminal history import incomplete');
      let launch: ShellLaunch | undefined;
      if (record.launch?.kind === 'agent') {
        if (!this.authority.resolveLaunch)
          throw new TerminalSessionRefusal('Launch profile unavailable');
        launch = await this.authority.resolveLaunch(
          principal,
          record,
          record.launch,
        );
      }
      const { root, cwd } = await this.confine(
        principal,
        record,
        input.subdirectory ?? (() => record.cwd),
      );
      if (record.launch?.kind === 'script')
        launch = await this.resolveCommand(
          principal,
          record,
          record.launch,
          cwd,
        );
      await this.stop(terminalId);
      const previous = await this.journal(record);
      // The next run's records start a new segment of the same journal.
      previous.seal();
      await previous.flush();
      const { lastSeq } = await previous.read(0, 2048);
      await this.recheck(principal, record, root, cwd);
      record.status = 'starting';
      record.cwd = cwd;
      delete record.exitCode;
      delete record.exitSignal;
      // A new run: its exit, not the previous one's, dates expiry and decides
      // whether it ended with its host.
      delete record.endedAt;
      delete record.hostStopped;
      delete record.outputCapped;
      record.restart = {
        count: (record.restart?.count ?? 0) + 1,
        afterSeq: lastSeq,
        at: Date.now(),
      };
      await this.persist();
      const spawnKind: ShellSpawnKind =
        record.kind === 'command'
          ? {
              kind: 'command',
              outputCapBytes:
                record.outputCapBytes ?? DEFAULT_COMMAND_OUTPUT_CAP_BYTES,
            }
          : {};
      try {
        const proc = await this.host.spawn({
          terminalId,
          cwd,
          cols: record.cols,
          rows: record.rows,
          journal: this.journalSpec(record),
          ...(launch && { launch }),
          ...spawnKind,
        });
        this.track(record, proc, previous);
        record.status = 'running';
        await this.persist();
      } catch (error) {
        record.status = 'failed';
        await this.persist();
        throw error;
      }
      return this.read(principal, record, terminalId, lastSeq, 2048);
    });
  }

  /**
   * The binding's canonical root and a directory inside it: a relative
   * `requested` path, or a function of the root for a stored directory.
   */
  private async confine(
    principal: Principal,
    scope: TerminalSessionScope,
    requested: string | ((root: string) => string),
  ): Promise<{ root: string; cwd: string }> {
    return confineTerminalDirectory(
      await this.authority.resolveRoot(principal, scope),
      requested,
    );
  }

  /**
   * Authorization and the binding's canonical root are checked again after
   * I/O and immediately before each process-launch seam.
   */
  private async recheck(
    principal: Principal,
    scope: TerminalSessionScope,
    root: string,
    cwd: string,
  ): Promise<void> {
    await this.check(principal, scope, 'operate');
    if (
      (await realpath(await this.authority.resolveRoot(principal, scope))) !==
        root ||
      (await realpath(cwd)) !== cwd
    )
      throw new TerminalSessionRefusal('Terminal binding changed');
  }

  /**
   * Journals a live shell's output and records its exit. A hosted shell (a
   * supervisor workload) journals its own output, and its journal replaces
   * the local one: this only hears that more is readable.
   */
  private track(
    record: SessionRecord,
    proc: IPtyProcess,
    journal: SessionJournal,
  ): void {
    const hosted: HostedShellProcess | undefined = isHostedShellProcess(proc)
      ? proc
      : undefined;
    if (hosted)
      this.journals.set(record.terminalId, Promise.resolve(hosted.journal));
    let exit!: () => void;
    const exited = new Promise<void>((done) => {
      exit = done;
    });
    let writerFailed = false;
    let paused = false;
    const unsubscribeData = hosted
      ? hosted.onOutput(() => this.changed(record.terminalId))
      : proc.onData((data) => {
          const write = journal.append(data);
          if (!paused && journal.backpressured && proc.pause && proc.resume) {
            paused = true;
            proc.pause();
          }
          void write
            .then(() => {
              if (paused && journal.drained) {
                paused = false;
                proc.resume?.();
              }
              this.changed(record.terminalId);
            })
            .catch((error: unknown) => {
              if (writerFailed) return;
              writerFailed = true;
              unsubscribeData();
              record.status = 'failed';
              record.endedAt = Date.now();
              record.journalUnavailable = true;
              logger.error('Terminal journal write failed', {
                terminalId: record.terminalId,
                error,
              });
              void this.persist().catch((failure: unknown) =>
                logger.error('Terminal failure persistence failed', {
                  error: failure,
                }),
              );
              void this.stop(record.terminalId)
                .then(() => this.persist())
                .catch((failure: unknown) =>
                  logger.error('Terminal failure persistence failed', {
                    error: failure,
                  }),
                );
            });
        });
    const unsubscribeExit = proc.onExit((event) => {
      // node-pty can destroy a paused socket before publishing onExit.
      if (event.outputIncomplete) {
        record.status = 'failed';
        record.journalUnavailable = true;
        logger.error('Terminal exited with output delivery paused', {
          terminalId: record.terminalId,
        });
      }
      if (record.status !== 'failed') record.status = 'exited';
      record.endedAt = Date.now();
      record.exitCode = event.outputIncomplete ? null : event.exitCode;
      record.exitSignal = event.outputIncomplete ? null : event.signal;
      if (event.outputCapped) record.outputCapped = true;
      if (this.live.get(record.terminalId)?.process === proc)
        this.live.delete(record.terminalId);
      this.changed(record.terminalId);
      unsubscribeData();
      unsubscribeExit();
      exit();
      this.exits.get(record.terminalId)?.({
        exitCode: record.exitCode,
        signal: record.exitSignal ?? null,
        outputCapped: record.outputCapped === true,
      });
      this.exits.delete(record.terminalId);
      void this.persist().catch((error: unknown) =>
        logger.error('Terminal exit persistence failed', { error }),
      );
    });
    this.live.set(record.terminalId, {
      process: proc,
      exit: exited,
    });
  }

  async list(principal: Principal, scope: TerminalSessionScope) {
    await this.check(principal, scope, 'observe');
    await this.ready;
    await this.check(principal, scope, 'observe');
    const operate = await this.authority.authorize(principal, scope, 'operate');
    return [...this.records.values()]
      .filter(
        (record) =>
          record.projectId === scope.projectId &&
          record.bindingKey === scope.bindingKey,
      )
      .map((record) => sessionView(record, operate));
  }

  async read(
    principal: Principal,
    scope: TerminalSessionScope,
    terminalId: string,
    fromSeq = 0,
    maxReadBytes = Number.MAX_SAFE_INTEGER,
  ) {
    const record = await this.find(principal, scope, terminalId, 'observe');
    if (record.journalUnavailable)
      throw new TerminalSessionRefusal('Terminal journal unavailable');
    if (record.legacy && !record.legacy.imported)
      throw new TerminalSessionRefusal('Terminal history import incomplete');
    const journal = await (await this.journal(record)).read(
      fromSeq,
      maxReadBytes,
    );
    await this.check(principal, scope, 'observe');
    const operate = await this.authority.authorize(
      principal,
      record,
      'operate',
    );
    return {
      ...sessionView(record, operate),
      pid: operate ? (this.live.get(terminalId)?.process.pid ?? null) : null,
      journal,
    };
  }

  async canOperate(
    principal: Principal,
    scope: TerminalSessionScope,
    terminalId: string,
  ): Promise<boolean> {
    const record = await this.find(principal, scope, terminalId, 'observe');
    const allowed = await this.authority.authorize(
      principal,
      record,
      'operate',
    );
    await this.check(principal, record, 'observe');
    return allowed;
  }

  /**
   * The shell's current directory, or the directory a command runs in (it
   * never moves): a host path, so operate authority only.
   */
  async cwd(
    principal: Principal,
    scope: TerminalSessionScope,
    terminalId: string,
  ): Promise<string | null> {
    const record = await this.find(principal, scope, terminalId, 'operate');
    const cwd =
      record.kind === 'command'
        ? record.cwd
        : await this.live.get(terminalId)?.process.getCwd?.();
    await this.find(principal, scope, terminalId, 'operate');
    return cwd || null;
  }

  /** Every record the caller may observe, across Projects and bindings. */
  async listObservable(principal: Principal) {
    await this.ready;
    const visible: (TerminalSessionView & { pid: number | null })[] = [];
    for (const record of [...this.records.values()]) {
      if (!(await this.authority.authorize(principal, record, 'observe')))
        continue;
      const operate = await this.authority.authorize(
        principal,
        record,
        'operate',
      );
      visible.push({
        ...sessionView(record, operate),
        pid: operate
          ? (this.live.get(record.terminalId)?.process.pid ?? null)
          : null,
      });
    }
    return visible;
  }

  write(
    principal: Principal,
    scope: TerminalSessionScope,
    terminalId: string,
    data: string,
  ) {
    return this.serialize(async () => {
      await this.find(principal, scope, terminalId, 'operate');
      const session = this.live.get(terminalId);
      if (!session) throw new TerminalSessionRefusal('Terminal has ended');
      session.process.write(data);
    });
  }

  resize(
    principal: Principal,
    scope: TerminalSessionScope,
    terminalId: string,
    cols: number,
    rows: number,
  ) {
    return this.serialize(async () => {
      const record = await this.find(principal, scope, terminalId, 'operate');
      recordSchema.pick({ cols: true, rows: true }).parse({ cols, rows });
      const session = this.live.get(terminalId);
      if (!session) throw new TerminalSessionRefusal('Terminal has ended');
      session.process.resize(cols, rows);
      record.cols = cols;
      record.rows = rows;
      await this.persist();
    });
  }

  close(principal: Principal, scope: TerminalSessionScope, terminalId: string) {
    return this.serialize(async () => {
      const record = await this.find(principal, scope, terminalId, 'operate');
      await this.stop(terminalId);
      if (record.status !== 'failed') record.status = 'exited';
      record.endedAt ??= Date.now();
      await (await this.journal(record)).flush();
      await this.persist();
    });
  }

  /** Internal invalidation only: consumers must authorize a read before output. */
  onChange(listener: (terminalId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(terminalId: string): void {
    for (const listener of this.listeners) listener(terminalId);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.listeners.clear();
    await this.ready;
    await this.commands.catch(() => undefined);
    // A supervisor workload outlives this core: detach from it rather than
    // ending it, so the next generation reattaches. The supervisor ends it
    // when the supervisor itself stops.
    const stops = await Promise.allSettled(
      [...new Set([...this.live.keys(), ...this.stopping.keys()])].map(
        async (id) => {
          const session = this.live.get(id);
          if (!session || !isHostedShellProcess(session.process)) {
            await this.stop(id);
            // Its host is stopping, not the person: it may reopen on restart.
            const record = this.records.get(id);
            if (record && record.status === 'exited') record.hostStopped = true;
            return;
          }
          session.process.detach();
          this.live.delete(id);
        },
      ),
    );
    const flushes = await Promise.allSettled(
      [...this.journals.values()].map(async (journal) =>
        (await journal).flush(),
      ),
    );
    const writes = await Promise.allSettled([
      this.records.size > 0 ? this.persist() : this.persistence,
    ]);
    const errors = [...stops, ...flushes, ...writes].flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (errors.length === 1) throw errors[0];
    if (errors.length)
      throw new AggregateError(errors, 'Terminal session cleanup failed');
  }

  private async find(
    principal: Principal,
    scope: TerminalSessionScope,
    id: string,
    operation: 'observe' | 'operate',
  ) {
    if (this.disposed && operation === 'operate')
      throw new TerminalSessionRefusal('Terminal sessions stopped');
    await this.check(principal, scope, operation);
    await this.ready;
    const record = this.records.get(id);
    if (
      !record ||
      record.projectId !== scope.projectId ||
      record.bindingKey !== scope.bindingKey
    )
      throw new TerminalSessionRefusal('Terminal not found');
    // Check the stored scope, not a scope reconstructed from an id or cwd.
    await this.check(principal, record, operation);
    return record;
  }

  private async check(
    principal: Principal,
    scope: TerminalSessionScope,
    operation: 'observe' | 'operate',
  ) {
    scopeSchema.parse({
      projectId: scope.projectId,
      bindingKey: scope.bindingKey,
    });
    if (!(await this.authority.authorize(principal, scope, operation)))
      throw new TerminalSessionRefusal('Terminal access refused');
  }

  /** Where a new record's journal goes, under the current settings. */
  private storage(): Pick<SessionRecord, 'journalRoot' | 'persist'> {
    return {
      ...(this.retention.directory !== this.defaultRetention.directory && {
        journalRoot: this.retention.directory,
      }),
      ...(!this.retention.persist && { persist: false as const }),
    };
  }

  /** The next "Shell N" for a binding: numbers are never reused while any remain. */
  private nextOrdinal(scope: TerminalSessionScope): number {
    let highest = 0;
    for (const record of this.records.values())
      if (sameScope(record, scope))
        highest = Math.max(highest, record.ordinal ?? 0);
    return highest + 1;
  }

  private capacity(): number {
    return Math.min(
      this.budget.maxSessions,
      Math.floor(
        this.retention.maxTotalBytes / this.retention.maxTerminalBytes,
      ),
      Math.floor(this.budget.maxTailBytes / this.journalOptions.tailBytes),
    );
  }

  private journalDirectory(record: SessionRecord): string {
    return join(
      record.journalRoot ?? this.defaultRetention.directory,
      record.terminalId,
    );
  }

  private journalSpec(record: SessionRecord): ShellJournalSpec {
    return {
      directory: this.journalDirectory(record),
      options: {
        ...this.journalOptions,
        maxBytes: this.retention.maxTerminalBytes,
        persist: record.persist !== false,
      },
    };
  }

  private journal(record: SessionRecord): Promise<SessionJournal> {
    if (this.records.get(record.terminalId) !== record)
      return Promise.reject(new TerminalSessionRefusal('Terminal not found'));
    let journal = this.journals.get(record.terminalId);
    if (!journal) {
      const spec = this.journalSpec(record);
      const pending: Promise<SessionJournal> = (async () => {
        // Private before the first byte is written, wherever history lives.
        if (spec.options.persist)
          try {
            await this.privacy.ensure(
              record.journalRoot ?? this.defaultRetention.directory,
              spec.directory,
            );
          } catch (error) {
            // A later attempt may succeed once the location is fixed.
            queueMicrotask(() => {
              if (this.journals.get(record.terminalId) === pending)
                this.journals.delete(record.terminalId);
            });
            if (error instanceof TerminalHistoryLocationUnavailable)
              throw new TerminalSessionRefusal(error.message);
            throw error;
          }
        const value = new TerminalJournal(spec.directory, spec.options);
        await value.load();
        return value;
      })();
      journal = pending;
      this.journals.set(record.terminalId, journal);
    }
    return journal;
  }

  /**
   * Applies the current retention settings to ended terminals: expires those
   * past the maximum age, moves the rest into the configured directory, and
   * trims to the total budget. Running shells are never touched.
   */
  private async maintain(): Promise<void> {
    await this.refreshRetention();
    const now = Date.now();
    for (const record of [...this.records.values()]) {
      if (
        this.live.has(record.terminalId) ||
        this.stopping.has(record.terminalId) ||
        record.status === 'running' ||
        record.status === 'starting'
      )
        continue;
      if (now - (record.endedAt ?? record.createdAt) > this.retention.maxAgeMs)
        await this.retire(record);
      else if (
        (record.journalRoot ?? this.defaultRetention.directory) !==
        this.retention.directory
      )
        await this.relocate(record);
    }
    try {
      await this.makeRoom(null);
    } catch (error) {
      // Every retained terminal is running; the next open is refused instead.
      if (!(error instanceof TerminalSessionRefusal)) throw error;
    }
  }

  /** Moves an ended terminal's journal into the configured directory. */
  private async relocate(record: SessionRecord): Promise<void> {
    const from = this.journalDirectory(record);
    const root = this.retention.directory;
    const to = join(root, record.terminalId);
    try {
      await lstat(to);
      logger.warn('Terminal journal already exists at the new location', {
        terminalId: record.terminalId,
      });
      return;
    } catch (error) {
      if (!this.notFound(error)) throw error;
    }
    const cached = this.journals.get(record.terminalId);
    if (cached) await Promise.allSettled([cached]);
    this.journals.delete(record.terminalId);
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      await rename(from, to);
      try {
        // Renamed, it keeps the ACL of where it was.
        await this.privacy.protect(root, to);
      } catch (error) {
        await rename(to, from);
        throw error;
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EXDEV') {
        // Private before any copied byte lands in it.
        await this.privacy.protect(root, to);
        await cp(from, to, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
        await rm(from, { recursive: true, force: true });
      } else if (!this.notFound(error)) {
        logger.warn('Terminal journal could not be moved', {
          terminalId: record.terminalId,
          error,
        });
        return;
      }
    }
    if (root === this.defaultRetention.directory) delete record.journalRoot;
    else record.journalRoot = root;
    await this.persist();
  }

  /**
   * Reopens a shell that ended only because its host restarted: a fresh
   * shell in the same directory, continuing the same journal after a
   * divider. Nothing that ran before is run again.
   */
  private async restore(record: SessionRecord): Promise<void> {
    if (
      !this.authority.restoreRoot ||
      record.journalUnavailable ||
      (record.legacy && !record.legacy.imported)
    )
      return;
    // #492: the directory must still be inside the binding as it resolves
    // NOW, so a Project or chat that moved never reopens a shell where it
    // used to be.
    let root: string;
    try {
      root = await this.authority.restoreRoot(record);
    } catch (error) {
      return this.refuseRestore(
        record,
        error instanceof TerminalSessionRefusal
          ? error.message
          : 'its Project or chat could not be resolved',
      );
    }
    let cwd: string;
    try {
      cwd = (await confineTerminalDirectory(root, () => record.cwd)).cwd;
      if (!(await stat(cwd)).isDirectory()) throw new Error('not a directory');
    } catch (error) {
      return this.refuseRestore(
        record,
        error instanceof TerminalSessionRefusal
          ? 'its directory is no longer inside its Project or chat'
          : 'its directory is no longer available',
      );
    }
    if (cwd !== record.cwd)
      return this.refuseRestore(record, 'its directory has moved');
    const journal = await this.journal(record);
    await journal.append(restoredDivider(record.rows));
    await journal.flush();
    const proc = await this.host.spawn({
      terminalId: record.terminalId,
      cwd,
      cols: record.cols,
      rows: record.rows,
      journal: this.journalSpec(record),
    });
    this.track(record, proc, journal);
    record.status = 'running';
    delete record.exitCode;
    delete record.endedAt;
    delete record.hostStopped;
    delete record.restoreRefused;
    record.restoredAt = Date.now();
    await this.persist();
  }

  /**
   * A shell that stays ended (#492): the reason is recorded on it and written
   * below its earlier output, so its tab says why. It is not tried again.
   */
  private async refuseRestore(
    record: SessionRecord,
    reason: string,
  ): Promise<void> {
    logger.info('Terminal not restored after restart', {
      terminalId: record.terminalId,
      reason,
    });
    const journal = await this.journal(record);
    await journal.append(terminalRestoreRefusedNote(reason));
    await journal.flush();
    delete record.hostStopped;
    record.restoreRefused = { reason, at: Date.now() };
    await this.persist();
  }

  /** Disk use of the terminals the caller may observe, per Project. */
  usage(principal: Principal) {
    return this.serialize(async () => {
      await this.ready;
      await this.maintain();
      const projects = new Map<
        string,
        { projectId: string; terminals: number; running: number; bytes: number }
      >();
      for (const record of [...this.records.values()]) {
        if (!(await this.authority.authorize(principal, record, 'observe')))
          continue;
        const entry = projects.get(record.projectId) ?? {
          projectId: record.projectId,
          terminals: 0,
          running: 0,
          bytes: 0,
        };
        entry.terminals += 1;
        if (this.live.has(record.terminalId)) entry.running += 1;
        entry.bytes += await this.diskBytes(record);
        projects.set(record.projectId, entry);
      }
      const list = [...projects.values()];
      return {
        retention: { ...this.retention },
        projects: list,
        terminals: list.reduce((sum, entry) => sum + entry.terminals, 0),
        bytes: list.reduce((sum, entry) => sum + entry.bytes, 0),
      };
    });
  }

  /**
   * Deletes the history of ended terminals, in one Project or everywhere the
   * caller may operate. Running terminals keep theirs and are counted.
   */
  clearHistory(principal: Principal, projectId?: string) {
    return this.serialize(async () => {
      await this.ready;
      let cleared = 0;
      let running = 0;
      for (const record of [...this.records.values()]) {
        if (projectId !== undefined && record.projectId !== projectId) continue;
        if (!(await this.authority.authorize(principal, record, 'operate')))
          continue;
        if (
          this.live.has(record.terminalId) ||
          this.stopping.has(record.terminalId)
        ) {
          running += 1;
          continue;
        }
        await this.retire(record);
        cleared += 1;
      }
      return { cleared, running };
    });
  }

  private async diskBytes(record: SessionRecord): Promise<number> {
    const directory = this.journalDirectory(record);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (this.notFound(error)) return 0;
      throw error;
    }
    let bytes = 0;
    for (const name of names) {
      try {
        bytes += (await lstat(join(directory, name))).size;
      } catch (error) {
        if (!this.notFound(error)) throw error;
      }
    }
    return bytes;
  }

  private async load(): Promise<void> {
    const restoring: SessionRecord[] = [];
    await this.refreshRetention();
    try {
      const records = z
        .array(recordSchema)
        .max(256)
        .parse(
          JSON.parse(
            await readFile(join(this.home, 'terminal-sessions.json'), 'utf8'),
          ),
        );
      for (const record of records) {
        if (this.records.has(record.terminalId))
          throw new Error('Duplicate terminal identity');
        this.records.set(record.terminalId, record);
        if (await this.reconcile(record)) restoring.push(record);
      }
      // Records from before stable ordinals are numbered in creation order.
      for (const record of [...this.records.values()].sort(
        (a, b) => a.createdAt - b.createdAt,
      ))
        if (isShell(record) && record.ordinal === undefined)
          record.ordinal = this.nextOrdinal(record);
    } catch (error) {
      if (!this.notFound(error)) throw error;
    }
    await this.makeRoom(null);
    await this.retireOversized();
    await this.maintain();
    await this.restoreAll(restoring);
    if (this.records.size > 0) await this.persist();
  }

  /**
   * Settles a loaded record against its host. A shell the supervisor kept
   * running across this restart is reattached. Otherwise it has ended; true
   * when it ended only because its host went away, so it may be reopened.
   */
  private async reconcile(record: SessionRecord): Promise<boolean> {
    if (record.status !== 'running' && record.status !== 'starting')
      return record.hostStopped === true && isShell(record);
    const reattached = await this.host.attach?.(
      record.terminalId,
      this.journalSpec(record),
    );
    if (reattached && reattached !== 'ended' && record.status === 'running') {
      this.track(record, reattached, reattached.journal);
      return false;
    }
    // A shell whose start was never recorded is not resumed either.
    if (reattached && reattached !== 'ended') await reattached.terminate?.();
    const wasRunning = record.status === 'running';
    record.status = 'exited';
    record.endedAt ??= Date.now();
    // The host no longer knows a shell it was running: the host itself
    // restarted (a reboot, or an in-process host with its core). One that
    // ended while the host kept running (`'ended'`) stays ended.
    return wasRunning && !reattached && isShell(record);
  }

  /** Startup: an ended journal larger than the per-terminal size is expired. */
  private async retireOversized(): Promise<void> {
    for (const record of [...this.records.values()]) {
      // A reattached shell's host owns its journal and keeps it in bounds.
      if (this.live.has(record.terminalId)) continue;
      const directory = this.journalDirectory(record);
      let names: string[];
      try {
        names = await readdir(directory);
      } catch (error) {
        if (this.notFound(error)) continue;
        throw error;
      }
      const sizes = await Promise.all(
        names.map(async (name) => (await lstat(join(directory, name))).size),
      );
      if (
        sizes.reduce((sum, size) => sum + size, 0) >
        this.retention.maxTerminalBytes
      )
        await this.retire(record);
    }
  }

  private async restoreAll(restoring: readonly SessionRecord[]): Promise<void> {
    for (const record of restoring) {
      if (this.records.get(record.terminalId) !== record) continue;
      try {
        await this.restore(record);
      } catch (error) {
        logger.warn('Terminal could not be restored after restart', {
          terminalId: record.terminalId,
          error,
        });
        await this.stop(record.terminalId);
        record.status = 'exited';
        record.endedAt ??= Date.now();
      }
    }
  }

  private async refreshRetention(): Promise<void> {
    if (!this.readRetention) return;
    try {
      this.retention = await this.readRetention();
    } catch (error) {
      logger.warn('Terminal retention settings unavailable', { error });
    }
  }

  /**
   * Expires the oldest ended records until `incoming` fits its pool, or, for
   * null, until every pool is within its capacity. A pool only expires its
   * own records.
   */
  private async makeRoom(
    incoming: SessionRecord | null,
    principal?: Principal,
  ): Promise<void> {
    const pools: RetentionPool[] = incoming
      ? [poolOf(incoming)]
      : ['session', 'command'];
    for (const pool of pools) {
      const capacity =
        pool === 'command' ? COMMAND_SESSION_SLOTS : this.capacity();
      const members = () =>
        [...this.records.values()].filter(
          (record) => record !== incoming && poolOf(record) === pool,
        );
      while (members().length + (incoming ? 1 : 0) > capacity) {
        let victim: SessionRecord | undefined;
        for (const record of members().sort(
          (a, b) => a.createdAt - b.createdAt,
        )) {
          if (
            this.live.has(record.terminalId) ||
            this.stopping.has(record.terminalId)
          )
            continue;
          if (
            principal !== undefined &&
            !(await this.authority.authorize(principal, record, 'operate'))
          )
            continue;
          victim = record;
          break;
        }
        if (!victim)
          throw new TerminalSessionRefusal('Terminal session capacity reached');
        if (principal !== undefined)
          await this.check(principal, victim, 'operate');
        await this.retire(victim);
      }
    }
  }

  private async retire(record: SessionRecord): Promise<void> {
    const pending = this.journals.get(record.terminalId);
    let journal: SessionJournal | undefined;
    if (pending) {
      const settled = await Promise.allSettled([pending]);
      const result = settled[0]!;
      if (result.status === 'fulfilled') journal = result.value;
      else
        logger.warn('Retiring an unavailable ended terminal journal', {
          terminalId: record.terminalId,
          error: result.reason,
        });
    }
    if (journal) await journal.discard();
    else
      await rm(this.journalDirectory(record), {
        recursive: true,
        force: true,
      });
    this.journals.delete(record.terminalId);
    this.records.delete(record.terminalId);
    await this.persist();
    this.changed(record.terminalId);
  }

  private persist(): Promise<void> {
    const task = this.persistence.then(async () => {
      await mkdir(this.home, { recursive: true, mode: 0o700 });
      const path = join(this.home, 'terminal-sessions.json');
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify([...this.records.values()]), {
        mode: 0o600,
      });
      await rename(temporary, path);
    });
    this.persistence = task;
    return task;
  }

  private stop(id: string): Promise<void> {
    const pending = this.stopping.get(id);
    if (pending) return pending;
    const session = this.live.get(id);
    if (!session) return Promise.resolve();
    const task = this.terminate(session).finally(() =>
      this.stopping.delete(id),
    );
    this.stopping.set(id, task);
    return task;
  }

  private async terminate(session: LiveSession): Promise<void> {
    if (session.process.terminate) {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () =>
            reject(new Error('Terminal process-group cleanup did not settle')),
          6000,
        );
      });
      try {
        await Promise.race([
          session.process.terminate().then(() => session.exit),
          expired,
        ]);
      } finally {
        clearTimeout(deadline);
      }
      return;
    }
    // Exit was subscribed at spawn, before either signal; no raw PID timer
    // can accidentally kill an unrelated process after PID reuse.
    const signal = (name?: string) => {
      try {
        session.process.kill(name);
      } catch (error) {
        logger.warn('Terminal signal failed', { error });
      }
    };
    const escalation = setTimeout(() => signal('SIGKILL'), 3000);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(
        () => reject(new Error('Terminal did not exit after kill escalation')),
        6000,
      );
    });
    try {
      signal();
      await Promise.race([session.exit, expired]);
    } finally {
      clearTimeout(escalation);
      clearTimeout(deadline);
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.commands.then(operation);
    this.commands = task.catch(() => undefined);
    return task;
  }

  private legacyFilename(legacy: {
    projectSlug: string;
    terminalId: string;
  }): string {
    return `${`${legacy.projectSlug}:${legacy.terminalId}`.replace(/[^a-zA-Z0-9]/g, '-')}.txt`;
  }

  private notFound(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
  }
}
