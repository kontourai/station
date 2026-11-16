import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * The DDL OpenCode 2.3.0 leaves in its store, verbatim from `sqlite_master`
 * of a real `opencode.db` (migrations through 20261030054400_job), for the
 * tables this source touches plus the credential table it must never touch.
 * Upstream definitions: `packages/core/src/session/sql.ts` (OpenCode v2.3.0).
 * Row contents in these tests are synthetic; their JSON shapes follow
 * `packages/schema/src/session-message.ts` and real rows' structure.
 */
export const OPENCODE_V2_SCHEMA = `
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
CREATE TABLE \`project\` (
          \`id\` text PRIMARY KEY,
          \`worktree\` text NOT NULL,
          \`vcs\` text,
          \`name\` text,
          \`icon_url\` text,
          \`icon_url_override\` text,
          \`icon_color\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_initialized\` integer,
          \`time_active\` integer DEFAULT 0 NOT NULL,
          \`time_archived\` integer,
          \`sandboxes\` text NOT NULL,
          \`commands\` text
        );
CREATE TABLE \`session_message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_session_message_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
CREATE TABLE \`session_part\` (
          \`message_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`ordinal\` integer NOT NULL,
          \`type\` text NOT NULL,
          \`call_id\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`session_part_pk\` PRIMARY KEY(\`message_id\`, \`ordinal\`),
          CONSTRAINT \`fk_session_part_message_id_session_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`session_message\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_part_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
CREATE TABLE \`session_v2\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`workspace_id\` text,
          \`parent_id\` text,
          \`fork_session_id\` text,
          \`fork_boundary\` text,
          \`slug\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`path\` text,
          \`title\` text,
          \`version\` text NOT NULL,
          \`share_url\` text,
          \`summary_additions\` integer,
          \`summary_deletions\` integer,
          \`summary_files\` integer,
          \`summary_diffs\` text,
          \`metadata\` text,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          \`revert\` text,
          \`permission\` text,
          \`agent\` text,
          \`model\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_idle\` integer,
          \`time_viewed\` integer,
          \`idle_outcome\` text,
          \`time_compacting\` integer,
          \`time_archived\` integer,
          \`time_suspended\` integer,
          \`resume_attempts\` integer DEFAULT 0 NOT NULL, \`time_busy\` integer,
          CONSTRAINT \`fk_session_v2_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
CREATE UNIQUE INDEX \`session_message_session_seq_idx\` ON \`session_message\` (\`session_id\`,\`seq\`);
CREATE INDEX \`session_message_session_time_created_id_idx\` ON \`session_message\` (\`session_id\`,\`time_created\`,\`id\`);
CREATE INDEX \`session_message_session_type_seq_idx\` ON \`session_message\` (\`session_id\`,\`type\`,\`seq\`);
CREATE INDEX \`session_message_time_created_idx\` ON \`session_message\` (\`time_created\`);
CREATE INDEX \`session_part_session_message_idx\` ON \`session_part\` (\`session_id\`,\`message_id\`,\`ordinal\`);
CREATE INDEX \`session_v2_parent_idx\` ON \`session_v2\` (\`parent_id\`);
CREATE INDEX \`session_v2_project_idx\` ON \`session_v2\` (\`project_id\`);
CREATE INDEX \`session_v2_time_suspended_idx\` ON \`session_v2\` (\`time_suspended\`) WHERE "session_v2"."time_suspended" is not null;
CREATE INDEX \`session_v2_workspace_idx\` ON \`session_v2\` (\`workspace_id\`);
`;

/**
 * OpenCode's key-value table, verbatim from its migration
 * `20260804233008_loose_psylocke` (OpenCode v2.3.0). It records the 1.x to 2.x
 * migration's state under `migration.v1-v2`.
 */
export const OPENCODE_V2_KV_SCHEMA = `
CREATE TABLE IF NOT EXISTS \`kv\` (
          \`key\` text PRIMARY KEY,
          \`value\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
`;

/** The same store before OpenCode 2.3 added `session_part`. */
export const OPENCODE_V2_SCHEMA_WITHOUT_PARTS = OPENCODE_V2_SCHEMA.replace(
  /CREATE TABLE `session_part`[\s\S]*?\);\n/u,
  '',
).replace(/CREATE INDEX `session_part_session_message_idx`[^\n]*\n/u, '');

const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);

type Json = Record<string, unknown>;

export interface V2Tokens {
  input: number;
  output: number;
  reasoning: number;
  read: number;
  write: number;
}

/** OpenCode 2.x assistant content items (`Session.Message.AssistantContent`). */
export const v2Content = {
  text: (value: string): Json => ({ type: 'text', text: value }),
  reasoning: (value: string): Json => ({
    type: 'reasoning',
    text: value,
    native: { reasoningField: 'reasoning_content' },
    time: { created: T0, completed: T0 },
  }),
  tool: (
    id: string,
    name: string,
    state:
      | { status: 'completed'; input: Json; output: string }
      | { status: 'error'; input: Json; error: string }
      | { status: 'running'; input: Json },
  ): Json => ({
    type: 'tool',
    id,
    name,
    executed: false,
    state:
      state.status === 'completed'
        ? {
            status: 'completed',
            input: state.input,
            content: [{ type: 'text', text: state.output }],
            metadata: { status: 'completed', truncated: false, exit: 0 },
          }
        : state.status === 'error'
          ? {
              status: 'error',
              input: state.input,
              error: { type: 'tool.execution', message: state.error },
              metadata: { truncated: false },
            }
          : { status: 'running', input: state.input, metadata: {} },
    time: {
      created: T0,
      ran: T0,
      ...(state.status === 'running' ? {} : { completed: T0 }),
    },
  }),
};

/**
 * A writer that produces rows the way OpenCode 2.x's projector does: message
 * data is the encoded message without its `id` and `type` (both are columns),
 * `seq` is the session's event order (with gaps, since other events share
 * the sequence), timestamps are epoch milliseconds, and the store runs in WAL
 * mode with the writer connection held open. With part rows, an assistant
 * row's content lives in `session_part` and its inline `content` is `[]`.
 */
export class OpenCodeV2FixtureWriter {
  readonly db: DatabaseSync;
  private clock = T0;
  private counter = 0;
  private readonly seqs = new Map<string, number>();

  constructor(
    readonly dataDir: string,
    readonly fileName = 'opencode.db',
    schema = OPENCODE_V2_SCHEMA,
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

  tick(): number {
    this.clock += 1000;
    return this.clock;
  }

  /** Ascending `msg_` ids like `Identifier.ascending` (30 characters). */
  nextId(): string {
    this.counter += 1;
    return `msg_${this.clock.toString(16).padStart(12, '0')}${String(this.counter).padStart(14, '0')}`;
  }

  session(
    id: string,
    directory: string,
    options: { parentId?: string; archived?: boolean; version?: string } = {},
  ): string {
    const now = this.tick();
    this.db
      .prepare(
        `INSERT INTO session_v2 (id, project_id, parent_id, slug, directory, path, version,
           agent, model, time_created, time_updated)
         VALUES (?, 'prj_fixture', ?, 'fixture-slug', ?, '', ?, 'build', ?, ?, ?)`,
      )
      .run(
        id,
        options.parentId ?? null,
        directory,
        options.version ?? '2.3.0',
        JSON.stringify({ id: 'model-a', providerID: 'provider-a' }),
        now,
        now,
      );
    if (options.archived) {
      this.db
        .prepare('UPDATE session_v2 SET time_archived = ? WHERE id = ?')
        .run(now, id);
    }
    return id;
  }

  user(sessionId: string, text: string): string {
    const created = this.tick();
    return this.insert(sessionId, 'user', created, {
      time: { created },
      text,
      files: [],
    });
  }

  assistant(
    sessionId: string,
    options: {
      content?: Json[];
      finish?: string;
      completed?: boolean;
      error?: { type: string; message: string };
      tokens?: V2Tokens;
      /** Write the content as `session_part` rows (`experimental.part_rows`). */
      partRows?: boolean;
      /**
       * With part rows: inline content an older OpenCode build wrote to the
       * row after its parts were split out (OpenCode reads parts first).
       */
      inlineContent?: Json[];
    } = {},
  ): string {
    const created = this.tick();
    const id = this.insert(
      sessionId,
      'assistant',
      created,
      this.assistantData(created, {
        ...options,
        content: options.partRows
          ? (options.inlineContent ?? [])
          : options.content,
      }),
    );
    if (options.partRows) {
      for (const [ordinal, item] of (options.content ?? []).entries()) {
        this.part(sessionId, id, ordinal, item);
      }
    }
    return id;
  }

  /** Rewrites an assistant row the way a later `MessageUpdated` does. */
  updateAssistant(
    sessionId: string,
    messageId: string,
    options: Parameters<OpenCodeV2FixtureWriter['assistant']>[1] = {},
  ): void {
    const row = this.db
      .prepare('SELECT time_created FROM session_message WHERE id = ?')
      .get(messageId) as { time_created: number };
    this.db
      .prepare(
        'UPDATE session_message SET data = ?, time_updated = ? WHERE id = ?',
      )
      .run(
        JSON.stringify(this.assistantData(row.time_created, options)),
        this.tick(),
        messageId,
      );
    this.touch(sessionId);
  }

  part(
    sessionId: string,
    messageId: string,
    ordinal: number,
    item: Json,
  ): void {
    const now = this.tick();
    this.db
      .prepare(
        `INSERT INTO session_part (message_id, session_id, ordinal, type, call_id,
           time_created, time_updated, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        messageId,
        sessionId,
        ordinal,
        String(item.type),
        item.type === 'tool' ? String(item.id) : null,
        now,
        now,
        JSON.stringify(item),
      );
  }

  idle(
    sessionId: string,
    outcome: 'succeeded' | 'failed' | 'interrupted',
    error?: { type: string; message: string },
  ): string {
    const created = this.tick();
    return this.insert(sessionId, 'idle', created, {
      time: { created },
      outcome,
      ...(error
        ? { error: { ...error, status: 429, response: { body: '{}' } } }
        : {}),
    });
  }

  compaction(sessionId: string, status: 'running' | 'completed'): string {
    const created = this.tick();
    return this.insert(
      sessionId,
      'compaction',
      created,
      compactionData(status, created),
    );
  }

  /**
   * Finishes a running compaction in place, the way OpenCode's
   * `session.compaction.ended` updates the latest running compaction row.
   */
  completeCompaction(sessionId: string, messageId: string): void {
    const row = this.db
      .prepare('SELECT time_created FROM session_message WHERE id = ?')
      .get(messageId) as { time_created: number };
    this.db
      .prepare(
        'UPDATE session_message SET data = ?, time_updated = ? WHERE id = ?',
      )
      .run(
        JSON.stringify(compactionData('completed', row.time_created)),
        this.tick(),
        messageId,
      );
    this.touch(sessionId);
  }

  /** A row with no conversation turn (`synthetic`, `model-switched`, ...). */
  other(sessionId: string, type: string, data: Json): string {
    const created = this.tick();
    return this.insert(sessionId, type, created, {
      time: { created },
      ...data,
    });
  }

  /**
   * Records the 1.x to 2.x migration's state the way OpenCode's
   * `V1Migration.run` does (`KVTable`, JSON value).
   */
  migrationState(phase: 'sessions' | 'completed'): number {
    this.db.exec(OPENCODE_V2_KV_SCHEMA);
    const now = this.tick();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO kv (key, value, time_created, time_updated)
         VALUES ('migration.v1-v2', ?, ?, ?)`,
      )
      .run(JSON.stringify({ phase }), now, now);
    return now;
  }

  touch(sessionId: string): void {
    this.db
      .prepare('UPDATE session_v2 SET time_updated = ? WHERE id = ?')
      .run(this.tick(), sessionId);
  }

  close(): void {
    this.db.close();
  }

  private insert(
    sessionId: string,
    type: string,
    created: number,
    data: Json,
  ): string {
    const id = this.nextId();
    const seq = (this.seqs.get(sessionId) ?? 0) + 2;
    this.seqs.set(sessionId, seq);
    this.db
      .prepare(
        `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, sessionId, type, seq, created, created, JSON.stringify(data));
    this.touch(sessionId);
    return id;
  }

  private assistantData(
    created: number,
    options: Parameters<OpenCodeV2FixtureWriter['assistant']>[1] = {},
  ): Json {
    return {
      time: {
        created,
        streamed: created + 400,
        ...(options.completed === false ? {} : { completed: created + 500 }),
      },
      agent: 'build',
      model: { id: 'model-a', providerID: 'provider-a', variant: 'default' },
      content: options.content ?? [],
      snapshot: { start: 'snap-start', end: 'snap-end', files: [] },
      ...(options.finish ? { finish: options.finish } : {}),
      ...(options.error
        ? { error: { ...options.error, status: 429, response: { body: '{}' } } }
        : {}),
      // A step that failed before the provider reported usage has no
      // `cost` or `tokens`, as in real stores.
      ...(options.tokens
        ? {
            cost: 0,
            tokens: {
              input: options.tokens.input,
              output: options.tokens.output,
              reasoning: options.tokens.reasoning,
              cache: { read: options.tokens.read, write: options.tokens.write },
            },
          }
        : {}),
    };
  }
}

function compactionData(
  status: 'running' | 'completed',
  created: number,
): Json {
  return {
    time: { created },
    status,
    reason: 'auto',
    summary: status === 'running' ? '' : 'Synthetic summary.',
    ...(status === 'completed'
      ? {
          model: {
            id: 'model-a',
            providerID: 'provider-a',
            variant: 'default',
          },
          cost: 0,
          tokens: {
            input: 9,
            output: 9,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        }
      : {}),
  };
}
