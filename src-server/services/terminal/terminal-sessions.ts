import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod/v3';
import type { IPtyProcess } from '../../domain/pty-adapter.js';
import { createLogger } from '../../utils/logger.js';
import type { ShellHost } from './shell-host.js';
import {
  TerminalJournal,
  type TerminalJournalOptions,
} from './terminal-journal.js';

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
    createdAt: z.number(),
    legacy: z
      .object({
        projectSlug: z.string(),
        terminalId: z.string(),
        imported: z.boolean(),
      })
      .optional(),
  })
  .strict();
type SessionRecord = z.infer<typeof recordSchema>;
type LiveSession = {
  process: IPtyProcess;
  exit: Promise<void>;
  unsubscribe: () => void;
};

export class TerminalSessionRefusal extends Error {}

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
}

/** Project/binding authority belongs here, independently of any transport. */
export class TerminalSessions<Principal> {
  private records = new Map<string, SessionRecord>();
  private journals = new Map<string, Promise<TerminalJournal>>();
  private live = new Map<string, LiveSession>();
  private commands: Promise<unknown> = Promise.resolve();
  private persistence: Promise<void> = Promise.resolve();
  private readonly ready: Promise<void>;
  private disposed = false;

  constructor(
    private readonly home: string,
    private readonly host: ShellHost,
    private readonly authority: TerminalSessionAuthority<Principal>,
    private readonly journalOptions: Partial<TerminalJournalOptions> = {},
  ) {
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
    },
  ) {
    return this.serialize(async () => {
      await this.check(principal, scope, 'operate');
      await this.ready;
      if (this.disposed)
        throw new TerminalSessionRefusal('Terminal sessions stopped');
      const root = await realpath(
        await this.authority.resolveRoot(principal, scope),
      );
      const requested = input.subdirectory ?? '.';
      if (isAbsolute(requested))
        throw new TerminalSessionRefusal(
          'Terminal subdirectory must be relative',
        );
      const cwd = await realpath(resolve(root, requested));
      const inside = relative(root, cwd);
      if (
        inside === '..' ||
        inside.startsWith(`..${sep}`) ||
        isAbsolute(inside)
      )
        throw new TerminalSessionRefusal(
          'Terminal directory is outside its binding',
        );
      await this.check(principal, scope, 'operate');
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
      }
      const record = recordSchema.parse({
        ...scope,
        terminalId: randomUUID(),
        cwd,
        cols: input.cols,
        rows: input.rows,
        status: 'starting',
        createdAt: Date.now(),
        ...(input.legacy && { legacy: { ...input.legacy, imported: false } }),
      });
      if (this.records.size >= 256)
        throw new TerminalSessionRefusal('Terminal session capacity reached');
      this.records.set(record.terminalId, record);
      await this.persist();
      try {
        const journal = await this.journal(record);
        if (record.legacy) {
          let history = '';
          try {
            history = await readFile(
              join(
                this.home,
                'terminal-history',
                this.legacyFilename(record.legacy),
              ),
              'utf8',
            );
          } catch (error) {
            if (!this.notFound(error)) throw error;
          }
          for (let offset = 0; offset < history.length; offset += 16384)
            await journal.append(history.slice(offset, offset + 16384));
          journal.seal();
          record.legacy.imported = true;
          await this.persist();
        }
        // Authorization and the binding's canonical root are checked again
        // after I/O and immediately before the only process-launch seam.
        await this.check(principal, scope, 'operate');
        if (
          (await realpath(
            await this.authority.resolveRoot(principal, scope),
          )) !== root ||
          (await realpath(cwd)) !== cwd
        )
          throw new TerminalSessionRefusal('Terminal binding changed');
        const proc = await this.host.spawn({
          terminalId: record.terminalId,
          cwd,
          cols: record.cols,
          rows: record.rows,
        });
        let exit!: () => void;
        const exited = new Promise<void>((done) => {
          exit = done;
        });
        const unsubscribeData = proc.onData((data) => {
          void journal.append(data).catch((error: unknown) => {
            record.status = 'failed';
            logger.error('Terminal journal write failed', {
              terminalId: record.terminalId,
              error,
            });
            proc.kill();
            void this.persist().catch((failure: unknown) =>
              logger.error('Terminal failure persistence failed', {
                error: failure,
              }),
            );
          });
        });
        const unsubscribeExit = proc.onExit(() => {
          if (record.status !== 'failed') record.status = 'exited';
          this.live.delete(record.terminalId);
          unsubscribeData();
          unsubscribeExit();
          exit();
          void this.persist().catch((error: unknown) =>
            logger.error('Terminal exit persistence failed', { error }),
          );
        });
        this.live.set(record.terminalId, {
          process: proc,
          exit: exited,
          unsubscribe: () => {
            unsubscribeData();
            unsubscribeExit();
          },
        });
        record.status = 'running';
        await this.persist();
        return await this.read(principal, scope, record.terminalId);
      } catch (error) {
        await this.stop(record.terminalId);
        record.status = 'failed';
        await this.persist();
        throw error;
      }
    });
  }

  async list(principal: Principal, scope: TerminalSessionScope) {
    await this.check(principal, scope, 'observe');
    await this.ready;
    return [...this.records.values()]
      .filter(
        (record) =>
          record.projectId === scope.projectId &&
          record.bindingKey === scope.bindingKey,
      )
      .map((record) => ({
        ...record,
        legacy: record.legacy && { ...record.legacy },
      }));
  }

  async read(
    principal: Principal,
    scope: TerminalSessionScope,
    terminalId: string,
    fromSeq = 0,
  ) {
    const record = await this.find(principal, scope, terminalId, 'observe');
    if (record.legacy && !record.legacy.imported)
      throw new TerminalSessionRefusal('Terminal history import incomplete');
    const journal = await (await this.journal(record)).read(fromSeq);
    await this.check(principal, scope, 'observe');
    return {
      ...record,
      legacy: record.legacy && { ...record.legacy },
      pid: this.live.get(terminalId)?.process.pid ?? null,
      journal,
    };
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
      await (await this.journal(record)).flush();
      await this.persist();
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.commands.catch(() => undefined);
    await Promise.all([...this.live.keys()].map((id) => this.stop(id)));
    await Promise.all(
      [...this.journals.values()].map(async (journal) =>
        (await journal).flush(),
      ),
    );
    await this.persistence;
  }

  private async find(
    principal: Principal,
    scope: TerminalSessionScope,
    id: string,
    operation: 'observe' | 'operate',
  ) {
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

  private journal(record: SessionRecord): Promise<TerminalJournal> {
    let journal = this.journals.get(record.terminalId);
    if (!journal) {
      journal = (async () => {
        const value = new TerminalJournal(
          join(this.home, 'terminal-journals', record.terminalId),
          this.journalOptions,
        );
        await value.load();
        return value;
      })();
      this.journals.set(record.terminalId, journal);
    }
    return journal;
  }

  private async load(): Promise<void> {
    try {
      const records = z
        .array(recordSchema)
        .parse(
          JSON.parse(
            await readFile(join(this.home, 'terminal-sessions.json'), 'utf8'),
          ),
        );
      for (const record of records) {
        if (this.records.has(record.terminalId))
          throw new Error('Duplicate terminal identity');
        // An in-process host cannot restore a PTY after a server restart.
        // Keep identity and output, and never re-run a command implicitly.
        if (record.status === 'running' || record.status === 'starting')
          record.status = 'exited';
        this.records.set(record.terminalId, record);
      }
    } catch (error) {
      if (!this.notFound(error)) throw error;
    }
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

  private async stop(id: string): Promise<void> {
    const session = this.live.get(id);
    if (!session) return;
    // Exit was subscribed at spawn, before either signal; no raw PID timer
    // can accidentally kill an unrelated process after PID reuse.
    const escalation = setTimeout(() => session.process.kill('SIGKILL'), 3000);
    try {
      session.process.kill();
      await session.exit;
    } finally {
      clearTimeout(escalation);
      session.unsubscribe();
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
