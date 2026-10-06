import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * The DDL OpenCode 1.18 leaves in its store, verbatim from `.schema` of a
 * real `opencode-stable.db` (drizzle migrations through
 * 20260622202450_simplify_session_input), for the tables this source touches
 * plus the credential tables it must never touch. Upstream definitions:
 * `packages/core/src/session/sql.ts`, `packages/core/src/project/sql.ts`.
 * Row contents in these tests are synthetic.
 */
export const OPENCODE_SCHEMA = `
CREATE TABLE \`project\` (
	\`id\` text PRIMARY KEY,
	\`worktree\` text NOT NULL,
	\`vcs\` text,
	\`name\` text,
	\`icon_url\` text,
	\`icon_color\` text,
	\`time_created\` integer NOT NULL,
	\`time_updated\` integer NOT NULL,
	\`time_initialized\` integer,
	\`sandboxes\` text NOT NULL
, \`commands\` text, \`icon_url_override\` text);
CREATE TABLE \`message\` (
	\`id\` text PRIMARY KEY,
	\`session_id\` text NOT NULL,
	\`time_created\` integer NOT NULL,
	\`time_updated\` integer NOT NULL,
	\`data\` text NOT NULL,
	CONSTRAINT \`fk_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
);
CREATE TABLE \`part\` (
	\`id\` text PRIMARY KEY,
	\`message_id\` text NOT NULL,
	\`session_id\` text NOT NULL,
	\`time_created\` integer NOT NULL,
	\`time_updated\` integer NOT NULL,
	\`data\` text NOT NULL,
	CONSTRAINT \`fk_part_message_id_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE
);
CREATE TABLE \`session\` (
	\`id\` text PRIMARY KEY,
	\`project_id\` text NOT NULL,
	\`parent_id\` text,
	\`slug\` text NOT NULL,
	\`directory\` text NOT NULL,
	\`title\` text NOT NULL,
	\`version\` text NOT NULL,
	\`share_url\` text,
	\`summary_additions\` integer,
	\`summary_deletions\` integer,
	\`summary_files\` integer,
	\`summary_diffs\` text,
	\`revert\` text,
	\`permission\` text,
	\`time_created\` integer NOT NULL,
	\`time_updated\` integer NOT NULL,
	\`time_compacting\` integer,
	\`time_archived\` integer, \`workspace_id\` text, \`path\` text, \`agent\` text, \`model\` text, \`cost\` real DEFAULT 0 NOT NULL, \`tokens_input\` integer DEFAULT 0 NOT NULL, \`tokens_output\` integer DEFAULT 0 NOT NULL, \`tokens_reasoning\` integer DEFAULT 0 NOT NULL, \`tokens_cache_read\` integer DEFAULT 0 NOT NULL, \`tokens_cache_write\` integer DEFAULT 0 NOT NULL, \`metadata\` text,
	CONSTRAINT \`fk_session_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
);
CREATE INDEX \`part_session_idx\` ON \`part\` (\`session_id\`);
CREATE INDEX \`session_project_idx\` ON \`session\` (\`project_id\`);
CREATE INDEX \`session_parent_idx\` ON \`session\` (\`parent_id\`);
CREATE INDEX \`session_workspace_idx\` ON \`session\` (\`workspace_id\`);
CREATE INDEX \`message_session_time_created_id_idx\` ON \`message\` (\`session_id\`,\`time_created\`,\`id\`);
CREATE INDEX \`part_message_id_id_idx\` ON \`part\` (\`message_id\`,\`id\`);
CREATE TABLE \`credential\` (
          \`id\` text PRIMARY KEY,
          \`integration_id\` text,
          \`label\` text NOT NULL,
          \`value\` text NOT NULL,
          \`connector_id\` text,
          \`method_id\` text,
          \`active\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
CREATE TABLE \`session_message\` (
	\`id\` text PRIMARY KEY,
	\`session_id\` text NOT NULL,
	\`type\` text NOT NULL,
	\`time_created\` integer NOT NULL,
	\`time_updated\` integer NOT NULL,
	\`data\` text NOT NULL, \`seq\` integer NOT NULL,
	CONSTRAINT \`fk_session_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
);
`;

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

/**
 * A writer that produces rows the way OpenCode's projector does: `message`
 * and `part` data are the v1 JSON with the row's id columns stripped
 * (`messageData`/`partData`), timestamps are epoch milliseconds, and the
 * store runs in WAL mode with the writer connection held open.
 */
export class OpenCodeFixtureWriter {
  readonly db: DatabaseSync;
  private clock = T0;
  private counter = 0;

  constructor(
    readonly dataDir: string,
    readonly fileName = 'opencode-stable.db',
    schema = OPENCODE_SCHEMA,
  ) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, fileName));
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(schema);
    this.db
      .prepare(
        `INSERT INTO project (id, worktree, vcs, time_created, time_updated, sandboxes)
         VALUES ('prj_fixture', '/', 'git', ?, ?, '[]')`,
      )
      .run(T0, T0);
    this.db
      .prepare(
        `INSERT INTO credential (id, label, value, time_created, time_updated)
         VALUES ('cred_fixture', 'fixture', 'not-a-secret', ?, ?)`,
      )
      .run(T0, T0);
  }

  get path(): string {
    return join(this.dataDir, this.fileName);
  }

  tick(): number {
    this.clock += 1000;
    return this.clock;
  }

  /** Ascending, prefix-typed ids like `Identifier.ascending`. */
  nextId(prefix: 'msg' | 'prt'): string {
    this.counter += 1;
    return `${prefix}_${this.clock.toString(16).padStart(12, '0')}${String(this.counter).padStart(14, '0')}`;
  }

  session(
    id: string,
    directory: string,
    options: { parentId?: string; archived?: boolean; version?: string } = {},
  ): string {
    const now = this.tick();
    this.db
      .prepare(
        `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version,
           time_created, time_updated, time_archived, agent, model)
         VALUES (?, 'prj_fixture', ?, 'fixture-slug', ?, 'Fixture session', ?, ?, ?, ?, 'build', ?)`,
      )
      .run(
        id,
        options.parentId ?? null,
        directory,
        options.version ?? '1.18.18',
        now,
        now,
        options.archived ? now : null,
        JSON.stringify({ id: 'model-a', providerID: 'provider-a' }),
      );
    return id;
  }

  touch(sessionId: string): void {
    this.db
      .prepare('UPDATE session SET time_updated = ? WHERE id = ?')
      .run(this.tick(), sessionId);
  }

  user(
    sessionId: string,
    texts: Array<string | { text: string; synthetic?: boolean }>,
    extraParts: Array<Record<string, unknown>> = [],
  ): string {
    const id = this.nextId('msg');
    const created = this.tick();
    this.insertMessage(id, sessionId, created, {
      role: 'user',
      time: { created },
      agent: 'build',
      model: { providerID: 'provider-a', modelID: 'model-a' },
      summary: { diffs: [] },
    });
    for (const entry of texts) {
      const value = typeof entry === 'string' ? { text: entry } : entry;
      this.part(sessionId, id, {
        type: 'text',
        text: value.text,
        ...(value.synthetic ? { synthetic: true } : {}),
      });
    }
    for (const part of extraParts) this.part(sessionId, id, part);
    this.touch(sessionId);
    return id;
  }

  assistant(
    sessionId: string,
    parentId: string,
    options: {
      finish?: string;
      completed?: boolean;
      error?: { name: string; data: Record<string, unknown> };
      summary?: boolean;
    } = {},
  ): string {
    const id = this.nextId('msg');
    const created = this.tick();
    this.insertMessage(
      id,
      sessionId,
      created,
      this.assistantData(parentId, created, options),
    );
    this.touch(sessionId);
    return id;
  }

  /** Rewrites an assistant message's data the way `MessageUpdated` upserts it. */
  completeAssistant(
    sessionId: string,
    messageId: string,
    parentId: string,
    finish = 'stop',
  ): void {
    const row = this.db
      .prepare('SELECT time_created FROM message WHERE id = ?')
      .get(messageId) as { time_created: number };
    this.db
      .prepare('UPDATE message SET data = ?, time_updated = ? WHERE id = ?')
      .run(
        JSON.stringify(
          this.assistantData(parentId, row.time_created, {
            finish,
            completed: true,
          }),
        ),
        this.tick(),
        messageId,
      );
    this.touch(sessionId);
  }

  part(
    sessionId: string,
    messageId: string,
    data: Record<string, unknown>,
  ): string {
    const id = this.nextId('prt');
    const now = this.tick();
    this.db
      .prepare(
        `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, messageId, sessionId, now, now, JSON.stringify(data));
    return id;
  }

  text(sessionId: string, messageId: string, value: string): string {
    return this.part(sessionId, messageId, {
      type: 'text',
      text: value,
      time: { start: this.clock, end: this.clock },
    });
  }

  tool(
    sessionId: string,
    messageId: string,
    callId: string,
    tool: string,
    state: Record<string, unknown>,
  ): string {
    return this.part(sessionId, messageId, {
      type: 'tool',
      tool,
      callID: callId,
      state,
    });
  }

  stepFinish(
    sessionId: string,
    messageId: string,
    tokens: {
      input: number;
      output: number;
      reasoning: number;
      read: number;
      write: number;
    },
    /**
     * `current` (default): total = input + output + reasoning + cache, output
     * without reasoning. `legacy` (OpenCode <= 1.3): output already includes
     * reasoning and total = input + output + cache. `absent`: no total.
     */
    shape: 'current' | 'legacy' | 'absent' = 'current',
  ): string {
    const withoutReasoning =
      tokens.input + tokens.output + tokens.read + tokens.write;
    const total =
      shape === 'current'
        ? withoutReasoning + tokens.reasoning
        : shape === 'legacy'
          ? withoutReasoning
          : undefined;
    return this.part(sessionId, messageId, {
      type: 'step-finish',
      reason: 'stop',
      snapshot: 'snapshot-fixture',
      cost: 0.01,
      tokens: {
        ...(total === undefined ? {} : { total }),
        input: tokens.input,
        output: tokens.output,
        reasoning: tokens.reasoning,
        cache: { read: tokens.read, write: tokens.write },
      },
    });
  }

  close(): void {
    this.db.close();
  }

  private insertMessage(
    id: string,
    sessionId: string,
    created: number,
    data: Record<string, unknown>,
  ): void {
    this.db
      .prepare(
        `INSERT INTO message (id, session_id, time_created, time_updated, data)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, sessionId, created, created, JSON.stringify(data));
  }

  private assistantData(
    parentId: string,
    created: number,
    options: {
      finish?: string;
      completed?: boolean;
      error?: { name: string; data: Record<string, unknown> };
      summary?: boolean;
    },
  ): Record<string, unknown> {
    return {
      parentID: parentId,
      role: 'assistant',
      mode: 'build',
      agent: 'build',
      variant: 'default',
      path: { cwd: '/', root: '/' },
      cost: 0,
      tokens: {
        total: 0,
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: 'model-a',
      providerID: 'provider-a',
      time: {
        created,
        ...(options.completed === false ? {} : { completed: created + 500 }),
      },
      ...(options.error ? { error: options.error } : {}),
      ...(options.summary ? { summary: true } : {}),
      ...(options.finish ? { finish: options.finish } : {}),
    };
  }
}
