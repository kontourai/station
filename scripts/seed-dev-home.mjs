#!/usr/bin/env node
/**
 * Seed an isolated development Station home from a read-only snapshot of the
 * developer's real home, so a dev instance has real Projects, Agents and
 * conversation history instead of an empty database, and can never act on
 * the developer's behalf.
 *
 * Fail closed: only roots and SQLite tables named KEEP below are carried.
 * Everything else, including any root or table added after this was written,
 * is dropped or emptied. Dropped on purpose: credentials and sign-in state,
 * scheduled jobs and pending work, links to other machines, plugin code and
 * grants, and telemetry queues. No source file is written: SQLite stores are
 * copied with `VACUUM INTO` from a read-only connection (which, like any
 * reader, may create or update the `-shm` index and an empty `-wal`), so a running source Station is never
 * disturbed.
 *
 *   node scripts/seed-dev-home.mjs --target=<dir> [--source=<home>] [--force]
 *
 * Docs: docs/guides/development.md ("Seeding a dev home from real data").
 */
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { invokedDirectly } from './lib/module-entry.mjs';

export const DEV_HOME_SEED_MARKER = 'dev-home-seed.json';

/** Why a root is left out. Every dropped root names one. */
export const DROP_CATEGORIES = Object.freeze({
  credentials: 'Credentials, keys, sign-in sessions and paired browsers',
  'pending-work': 'Scheduled jobs, wake-ups, recovery and other pending work',
  'other-machines': 'Links to other machines, devices and environments',
  execution:
    'Plugin code, grants and confined engine homes that run or authorize work',
  'live-state': 'Process, lock and transaction state of the running source',
  'bulk-or-derived': 'Large, rebuildable or user-repository content',
  telemetry: 'Telemetry queues that would report as the developer',
});

/**
 * One decision per known top-level root: `'keep'` or a drop category. A root
 * missing here is dropped as unknown; the completeness test keeps this in
 * step with STATION_HOME_ROOTS so a new root gets a deliberate decision.
 */
export const ROOT_DECISIONS = Object.freeze({
  '.station-home-schema.json': 'keep',
  agents: 'keep',
  analytics: 'keep',
  'conversation-acknowledgements.json': 'keep',
  'conversation-intent-summaries': 'keep',
  'conversation-pull-request-links.json': 'keep',
  'conversation-work-state.json': 'keep',
  kits: 'keep',
  knowledge: 'keep',
  'knowledge-document-imports': 'keep',
  'knowledge-stores': 'keep',
  layouts: 'keep',
  pricing: 'keep',
  projects: 'keep',
  'project-resource-shadow.json': 'keep',
  prompts: 'keep',
  'session-summaries': 'keep',
  skills: 'keep',
  'task-captures': 'keep',
  'task-graph.json': 'keep',
  'task-outputs': 'keep',
  'untrusted-conversation-marks.json': 'keep',
  workflows: 'keep',
  // Selected files only (CONFIG_KEEP / DATA_KEEP below).
  config: 'keep',
  data: 'keep',

  authentication: 'credentials',
  security: 'credentials',
  'app-homes': 'credentials',
  'confined-homes': 'credentials',
  'runtime-auth-health.json': 'credentials',
  'project-s3-sources.json': 'credentials',
  browser: 'credentials',

  automation: 'pending-work',
  scheduler: 'pending-work',
  'task-follow-ups': 'pending-work',
  'action-operations.json': 'pending-work',
  'attention-snoozes.json': 'pending-work',
  'checkpoint-restores.json': 'pending-work',
  'create-request-claims.json': 'pending-work',
  'delegation-attempt-claims.json': 'pending-work',
  'notifications.json': 'pending-work',
  'principal-notifications.json': 'pending-work',
  'operator-setup': 'pending-work',
  'project-creation-requests': 'pending-work',
  'proposed-changes.json': 'pending-work',
  'setup-imports.json': 'pending-work',
  'task-room-work.json': 'pending-work',
  'task-worktrees.json': 'pending-work',
  imports: 'pending-work',
  'station-home-recovery.json': 'pending-work',

  devices: 'other-machines',
  environments: 'other-machines',
  integrations: 'other-machines',
  'repository-acquisitions': 'other-machines',

  'agent-plugin-data': 'execution',
  plugins: 'execution',
  'plugin-grants.json': 'execution',
  'plugin-install-publication.mutation': 'execution',
  'plugin-trust.json': 'execution',
  'mcp-ui-render-grants.json': 'execution',
  'project-working-configuration': 'execution',
  'workspace-home-role.json': 'execution',

  '.review-evidence-coordination': 'live-state',
  '.storage-transactions': 'live-state',
  '.station-portable-data-root': 'live-state',
  coordination: 'live-state',
  runtime: 'live-state',
  'terminal-sessions.json': 'live-state',
  'terminal-journals': 'live-state',
  'terminal-history': 'live-state',
  'instances.json': 'live-state',
  'update-restore.json': 'live-state',
  logs: 'live-state',
  monitoring: 'live-state',
  quarantine: 'live-state',
  service: 'live-state',
  tmp: 'live-state',

  cache: 'bulk-or-derived',
  'connection-smoke.json': 'bulk-or-derived',
  feedback: 'bulk-or-derived',
  'knowledge-index': 'bulk-or-derived',
  'media-tools': 'bulk-or-derived',
  'pull-request-guides': 'bulk-or-derived',
  scratch: 'bulk-or-derived',
  'checkpoint-retention.json': 'bulk-or-derived',
  'turn-checkpoints': 'bulk-or-derived',
  'turn-checkpoints-evicted': 'bulk-or-derived',
  vectordb: 'bulk-or-derived',
  workspaces: 'bulk-or-derived',
});

/**
 * `config/` files carried. `providers.json` (inline API keys), `acp.json`
 * (launch commands and env), telemetry queues and account preferences stay
 * behind; connections must be added again in the dev instance.
 */
const CONFIG_KEEP = Object.freeze([
  'app.json',
  'agent-registry.json',
  'feature-previews.json',
  'knowledge-store-roots.json',
  'registry-sources.json',
]);

/** `data/` entries carried. `agent-runtime` (durable turn journals) and recovery stay behind. */
const DATA_KEEP = Object.freeze(['orchestration.sqlite', 'attachments']);

/**
 * `data/orchestration.sqlite` tables whose rows are carried: the event log,
 * conversation history and its projections, search, and Task content. Every
 * other table is emptied (wake-ups, recovery intents, prepared turns,
 * claims, outboxes, deliveries, native session bindings, approvals in
 * flight, plugin trust migration state, and anything unknown, because the
 * plugins and their trust records stay behind), so a dev Station boots with
 * history it can read and no work it would resume. A full-text table is kept or emptied as
 * a whole, never through its shadow tables.
 */
export const ORCHESTRATION_KEEP_TABLES = Object.freeze([
  'monument_meta',
  'sqlite_sequence',
  'context_compaction_policies',
  'orchestration_attachment_quota',
  'orchestration_attachment_refs',
  'orchestration_command_receipts',
  'orchestration_context_seed_witnesses',
  'orchestration_conversation_context_boundaries',
  'orchestration_conversation_fork_context',
  'orchestration_conversation_handoffs',
  'orchestration_conversation_history',
  'orchestration_conversation_history_quarantine',
  'orchestration_conversation_history_upgrade',
  'orchestration_conversation_sessions',
  'orchestration_conversation_start_context',
  'orchestration_declared_outputs',
  'orchestration_declared_output_handle_uses',
  'orchestration_event_content',
  'orchestration_event_store_backfill_progress',
  'orchestration_event_store_backfills',
  'orchestration_events',
  'orchestration_html_reply_pages',
  'orchestration_message_search',
  'orchestration_message_search_backfill',
  'orchestration_message_search_backfill_v3',
  'orchestration_message_search_projection',
  'orchestration_message_search_projection_v3',
  'orchestration_message_search_v2',
  'orchestration_message_search_v3',
  'orchestration_session_parent_mentions',
  'orchestration_session_projection_facts',
  'orchestration_stream_epoch',
  'orchestration_stream_identity',
  'orchestration_turn_boundaries',
  'orchestration_turn_provenance',
  'orchestration_usage_export_state',
  'project_task_room_attachment_formats',
  'project_task_room_formats',
  'project_task_room_heads',
  'project_task_room_identities',
  'project_task_room_member_formats',
  'project_task_room_records',
  'project_task_room_save_revisions',
  'revision_evidence_receipts',
  'skill_experience_snapshots',
  'task_learning_dismissals',
  'task_learning_promotions',
  'task_record_versions',
  'task_review_captures',
  'task_review_events',
  'task_review_threads',
  'task_summary_revisions',
]);

const FTS_SHADOW_SUFFIXES = [
  '_data',
  '_idx',
  '_content',
  '_docsize',
  '_config',
];

function defaultSourceHome(env = process.env) {
  const root = env.STATION_ROOT || join(homedir(), '.station');
  return join(root, 'instances', 'default');
}

function isInside(child, parent) {
  const path = relative(parent, child);
  return (
    path === '' ||
    !(path === '..' || path.startsWith(`..${sep}`) || resolve(path) === path)
  );
}

function quoteIdentifier(name) {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Copy one SQLite store as a consistent snapshot, reading the source only. */
function snapshotSqlite(sourcePath, targetPath) {
  mkdirSync(dirname(targetPath), { recursive: true });
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    // The snapshot is staged and renamed into place only when complete, so
    // it needs no per-write fsync; an interrupted seed is discarded whole.
    source.exec('PRAGMA synchronous = OFF');
    source.exec(`VACUUM INTO '${targetPath.replaceAll("'", "''")}'`);
  } finally {
    source.close();
  }
}

/** Empty every table not in `keep`; returns the emptied table names. */
function pruneSqliteTables(databasePath, keep) {
  const keepSet = new Set(keep);
  const db = new DatabaseSync(databasePath);
  try {
    const rows = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'")
      .all();
    const virtual = rows
      .filter((row) => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql ?? ''))
      .map((row) => row.name);
    const shadowOf = (name) =>
      virtual.find(
        (table) =>
          name !== table &&
          FTS_SHADOW_SUFFIXES.some((suffix) => name === `${table}${suffix}`),
      );
    db.exec('PRAGMA synchronous = OFF');
    const cleared = [];
    // Guard triggers (for example, deletion permits) protect live rows from
    // a running Station; a seed is not one, so they are lifted for the
    // deletes and put back exactly as they were.
    const triggers = db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL",
      )
      .all();
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      for (const { name } of triggers) {
        db.exec(`DROP TRIGGER ${quoteIdentifier(name)}`);
      }
      for (const { name } of rows) {
        if (shadowOf(name)) continue;
        if (keepSet.has(name)) continue;
        if (name.startsWith('sqlite_')) continue;
        const count = db
          .prepare(`SELECT count(*) AS n FROM ${quoteIdentifier(name)}`)
          .get().n;
        if (count > 0) {
          db.exec(`DELETE FROM ${quoteIdentifier(name)}`);
          cleared.push(name);
        }
      }
      for (const { sql } of triggers) db.exec(sql);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    db.exec('VACUUM');
    return cleared.sort();
  } finally {
    db.close();
  }
}

/**
 * Copy a kept tree. Symbolic links are skipped, never followed, so nothing
 * outside the source home is pulled in. SQLite stores go through
 * `snapshotSqlite`; their `-wal`/`-shm` sidecars are not copied.
 */
function copyTree(source, target, skipped) {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) {
    skipped.push(source);
    return;
  }
  if (stat.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(source)) {
      copyTree(join(source, entry), join(target, entry), skipped);
    }
    return;
  }
  if (!stat.isFile()) return;
  if (/\.(sqlite|db)-(wal|shm|journal)$/.test(source)) return;
  if (/\.mutation\.[^/]*\.tmp$/.test(source)) return;
  if (/\.(sqlite|db)$/.test(source)) {
    snapshotSqlite(source, target);
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

function rootDecision(name) {
  const direct = ROOT_DECISIONS[name];
  if (direct) return direct;
  for (const suffix of ['.previous', '.mutation']) {
    if (name.endsWith(suffix)) {
      const owner = ROOT_DECISIONS[name.slice(0, -suffix.length)];
      if (owner) return owner;
    }
  }
  return 'unknown';
}

/**
 * Build `target` from `source`. The target is assembled beside itself and
 * renamed into place, so an interrupted seed never leaves a half home. An
 * existing target is replaced only with `force` and only when it carries a
 * previous seed's marker.
 */
export function seedDevHome({
  source,
  target,
  force = false,
  now = new Date(),
}) {
  const sourceHome = realpathSync(resolve(source));
  const targetHome = resolve(target);
  if (!existsSync(join(sourceHome, '.station-home-schema.json'))) {
    throw new Error(`${sourceHome} is not a Station home`);
  }
  if (isInside(targetHome, sourceHome) || isInside(sourceHome, targetHome)) {
    throw new Error(
      'The target must be outside the source home, and the source outside the target',
    );
  }
  if (existsSync(targetHome)) {
    if (readdirSync(targetHome).length > 0) {
      if (!force) {
        throw new Error(
          `${targetHome} is not empty; pass --force to replace a previous seed`,
        );
      }
      if (!existsSync(join(targetHome, DEV_HOME_SEED_MARKER))) {
        throw new Error(
          `${targetHome} was not made by this seed; refusing to replace it`,
        );
      }
      if (existsSync(join(targetHome, 'instances.json'))) {
        throw new Error(
          `${targetHome} has a Station instance record; stop it and remove instances.json first`,
        );
      }
    }
  }

  const staging = `${targetHome}.seeding-${randomUUID()}`;
  mkdirSync(staging, { recursive: true });
  const kept = [];
  const dropped = {};
  const drop = (category, name) => {
    if (!dropped[category]) dropped[category] = [];
    dropped[category].push(name);
  };
  const skippedLinks = [];
  let clearedTables = [];
  try {
    for (const name of readdirSync(sourceHome).sort()) {
      const decision = rootDecision(name);
      if (decision !== 'keep') {
        drop(decision, name);
        continue;
      }
      const from = join(sourceHome, name);
      const to = join(staging, name);
      if (name === 'config' || name === 'data') {
        const allow = name === 'config' ? CONFIG_KEEP : DATA_KEEP;
        if (!lstatSync(from).isDirectory()) continue;
        for (const entry of readdirSync(from).sort()) {
          const base = entry.replace(/\.previous$/, '');
          if (!allow.includes(base)) {
            const category =
              name === 'data'
                ? 'pending-work'
                : base.startsWith('telemetry')
                  ? 'telemetry'
                  : base === 'distribution-lifecycle.json'
                    ? 'live-state'
                    : 'credentials';
            drop(category, `${name}/${entry}`);
            continue;
          }
          copyTree(join(from, entry), join(to, entry), skippedLinks);
          kept.push(`${name}/${entry}`);
        }
        continue;
      }
      copyTree(from, to, skippedLinks);
      kept.push(name);
    }
    const orchestration = join(staging, 'data', 'orchestration.sqlite');
    if (existsSync(orchestration)) {
      clearedTables = pruneSqliteTables(
        orchestration,
        ORCHESTRATION_KEEP_TABLES,
      );
    }
    const marker = {
      schema: 'station.dev-home-seed/v1',
      createdAt: now.toISOString(),
      source: sourceHome,
      kept,
      dropped,
      clearedTables,
      skippedLinks: skippedLinks.map((path) => relative(sourceHome, path)),
    };
    writeFileSync(
      join(staging, DEV_HOME_SEED_MARKER),
      `${JSON.stringify(marker, null, 2)}\n`,
    );
    if (existsSync(targetHome))
      rmSync(targetHome, { recursive: true, force: true });
    mkdirSync(dirname(targetHome), { recursive: true });
    renameSync(staging, targetHome);
    return marker;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function parseArgs(argv) {
  const options = { source: defaultSourceHome(), force: false };
  for (const arg of argv) {
    const [key, ...rest] = arg.split('=');
    const value = rest.join('=');
    if (key === '--source') options.source = value;
    else if (key === '--target') options.target = value;
    else if (key === '--force') options.force = true;
    else if (key === '--help' || key === '-h') options.help = true;
    else throw new Error(`Unknown option ${arg}`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.target) {
    console.log(
      'Usage: node scripts/seed-dev-home.mjs --target=<dir> [--source=<home>] [--force]',
    );
    if (!options.help) process.exitCode = 2;
    return;
  }
  const marker = seedDevHome(options);
  console.log(`Seeded ${resolve(options.target)} from ${marker.source}`);
  console.log(`Kept: ${marker.kept.join(', ')}`);
  for (const [category, names] of Object.entries(marker.dropped)) {
    console.log(
      `Dropped (${DROP_CATEGORIES[category] ?? 'unknown root'}): ${names.join(', ')}`,
    );
  }
  console.log(
    `Emptied ${marker.clearedTables.length} orchestration tables of pending work`,
  );
  console.log(
    `Start it with: ./station start --home=${resolve(options.target)} --instance=<name> --port=<free port>`,
  );
}

if (invokedDirectly(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
