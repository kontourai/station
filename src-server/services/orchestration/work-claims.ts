/**
 * station#3413 part B: work claims. An agent says what it has taken ("working
 * on #NNNN", "these paths", with a note) so its peers in the Project don't
 * duplicate it.
 *
 * A claim is information, not exclusion: two Sessions may claim the same work
 * item and both claims stand. It expires unless renewed, its claimant may
 * release it, and it belongs to the Project (or the global space) its
 * claimant Session ran in when it claimed.
 *
 * Why Station-local, and not Flow Agents' `AssignmentProvider`: the contract
 * Station pins (`@kontourai/flow-agents` 6.5.1) has an EXCLUSIVE claim (a
 * second actor's claim throws), no renew operation and no TTL enforcement on
 * its claim path, a subject that is a work item id only, and one shipped
 * store, a local file under the Project's repository; host-provider selection
 * is still open upstream (kontourai/flow-agents#1436). This module is the one
 * seam (`WorkClaimStore`) a Flow-backed store could later stand behind.
 *
 * Nothing here is a label nothing computes: "active" is derived when read
 * (unreleased, unexpired, and its claimant Session has not ended), never
 * stored.
 */
import { randomUUID } from 'node:crypto';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import type { OrchestrationService } from './orchestration-service.js';
import type { SqliteDatabase } from './sqlite-database.js';

/** Released or expired rows older than this are deleted on the next write. */
const WORK_CLAIM_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const WORK_CLAIMS_SCHEMA = `
CREATE TABLE IF NOT EXISTS orchestration_work_claims (
  claim_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  conversation_id TEXT,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('project', 'global')),
  project_id TEXT,
  task_id TEXT,
  work_item_ref TEXT,
  paths_json TEXT NOT NULL,
  note TEXT,
  claimed_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT,
  release_note TEXT,
  CHECK ((scope_kind = 'project') = (project_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_work_claims_scope
  ON orchestration_work_claims (scope_kind, project_id, released_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_work_claims_session
  ON orchestration_work_claims (session_id);
CREATE INDEX IF NOT EXISTS idx_work_claims_conversation
  ON orchestration_work_claims (conversation_id);
`;

/** The Project a claim belongs to, or the global space. */
export type WorkClaimScope =
  | { readonly kind: 'project'; readonly id: string }
  | { readonly kind: 'global' };

/** Who claims: the verified caller's own Session, and its conversation. */
export interface WorkClaimant {
  readonly sessionId: string;
  readonly conversationId?: string;
}

export interface WorkClaimRecord {
  readonly claimId: string;
  readonly sessionId: string;
  readonly conversationId?: string;
  readonly scope: WorkClaimScope;
  /** The Task the claimant Session was dispatched for, when it was. */
  readonly taskId?: string;
  readonly workItemRef?: string;
  readonly paths: readonly string[];
  readonly note?: string;
  readonly claimedAt: string;
  readonly renewedAt: string;
  readonly expiresAt: string;
  readonly releasedAt?: string;
  readonly releaseNote?: string;
}

export interface WorkClaimInput {
  readonly claimant: WorkClaimant;
  readonly scope: WorkClaimScope;
  readonly taskId?: string;
  readonly workItemRef?: string;
  readonly paths: readonly string[];
  readonly note?: string;
  readonly ttlSeconds: number;
}

export type WorkClaimOutcome =
  | { readonly kind: 'claimed'; readonly claim: WorkClaimRecord }
  | { readonly kind: 'too_many'; readonly max: number };

export type WorkClaimChangeOutcome =
  | { readonly kind: 'renewed' | 'released'; readonly claim: WorkClaimRecord }
  /** No claim with this id that this claimant made. */
  | { readonly kind: 'not_found' }
  /** The claimant's, but released, or (for a renewal) expired. */
  | { readonly kind: 'not_active'; readonly claim: WorkClaimRecord };

export interface WorkClaimQuery {
  /** Only claims in this scope. */
  readonly scope?: WorkClaimScope;
  readonly taskId?: string;
  /** Only claims these Sessions, or Sessions of these conversations, made. */
  readonly claimants?: {
    readonly sessionIds: readonly string[];
    readonly conversationIds: readonly string[];
  };
  /** Read at most this many; the caller decides what one more means. */
  readonly limit?: number;
}

/**
 * The one seam claims are stored behind. Expiry and release are decided
 * here; whether the claimant Session has ended is not (that is runtime state,
 * see {@link createActiveWorkClaimReader}).
 */
export interface WorkClaimStore {
  claim(input: WorkClaimInput): WorkClaimOutcome;
  renew(
    claimId: string,
    claimant: WorkClaimant,
    ttlSeconds: number,
  ): WorkClaimChangeOutcome;
  release(
    claimId: string,
    claimant: WorkClaimant,
    note?: string,
  ): WorkClaimChangeOutcome;
  /** Unreleased, unexpired claims, newest first. */
  listUnexpired(query: WorkClaimQuery): WorkClaimRecord[];
}

interface WorkClaimRow {
  claim_id: string;
  session_id: string;
  conversation_id: string | null;
  scope_kind: 'project' | 'global';
  project_id: string | null;
  task_id: string | null;
  work_item_ref: string | null;
  paths_json: string;
  note: string | null;
  claimed_at: string;
  renewed_at: string;
  expires_at: string;
  released_at: string | null;
  release_note: string | null;
}

function recordOf(row: WorkClaimRow): WorkClaimRecord {
  const paths = JSON.parse(row.paths_json) as unknown;
  return {
    claimId: row.claim_id,
    sessionId: row.session_id,
    ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
    scope:
      row.scope_kind === 'project' && row.project_id
        ? { kind: 'project', id: row.project_id }
        : { kind: 'global' },
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.work_item_ref ? { workItemRef: row.work_item_ref } : {}),
    paths: Array.isArray(paths)
      ? paths.filter((path): path is string => typeof path === 'string')
      : [],
    ...(row.note ? { note: row.note } : {}),
    claimedAt: row.claimed_at,
    renewedAt: row.renewed_at,
    expiresAt: row.expires_at,
    ...(row.released_at ? { releasedAt: row.released_at } : {}),
    ...(row.release_note ? { releaseNote: row.release_note } : {}),
  };
}

const CLAIMANT_MATCH =
  '(session_id = ? OR (conversation_id IS NOT NULL AND conversation_id = ?))';

const claimantValues = (claimant: WorkClaimant) => [
  claimant.sessionId,
  // An absent conversation matches no row: `conversation_id = ''` never holds.
  claimant.conversationId ?? '',
];

export function createSqliteWorkClaimStore(
  db: SqliteDatabase,
  options: {
    /** Active claims one claimant may hold; the next claim is refused. */
    maxActivePerClaimant: number;
    now?: () => number;
  },
): WorkClaimStore {
  const now = options.now ?? (() => Date.now());
  const maxActive = options.maxActivePerClaimant;
  const iso = (ms: number) => new Date(ms).toISOString();

  const prune = (at: number) => {
    const cutoff = iso(at - WORK_CLAIM_RETENTION_MS);
    db.prepare(
      'DELETE FROM orchestration_work_claims WHERE (released_at IS NOT NULL AND released_at < ?) OR expires_at < ?',
    ).run(cutoff, cutoff);
  };

  const readOwn = (claimId: string, claimant: WorkClaimant) =>
    db
      .prepare(
        `SELECT * FROM orchestration_work_claims WHERE claim_id = ? AND ${CLAIMANT_MATCH}`,
      )
      .get(claimId, ...claimantValues(claimant)) as WorkClaimRow | undefined;

  const readById = (claimId: string) =>
    db
      .prepare('SELECT * FROM orchestration_work_claims WHERE claim_id = ?')
      .get(claimId) as WorkClaimRow;

  /** Runs `body` in one write transaction, so a check and its write agree. */
  const inTransaction = <T>(body: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = body();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  return {
    claim(input) {
      return inTransaction(() => {
        const at = now();
        const atIso = iso(at);
        const expiresAt = iso(at + input.ttlSeconds * 1000);
        prune(at);
        // Claiming a work item this claimant already holds renews that claim
        // (its note and paths replaced), as Flow's same-actor re-claim does,
        // rather than recording it twice.
        const existing =
          input.workItemRef === undefined
            ? undefined
            : (db
                .prepare(
                  `SELECT * FROM orchestration_work_claims WHERE work_item_ref = ? AND released_at IS NULL AND expires_at > ? AND ${CLAIMANT_MATCH} ORDER BY claimed_at DESC LIMIT 1`,
                )
                .get(
                  input.workItemRef,
                  atIso,
                  ...claimantValues(input.claimant),
                ) as WorkClaimRow | undefined);
        if (existing) {
          db.prepare(
            'UPDATE orchestration_work_claims SET paths_json = ?, note = ?, renewed_at = ?, expires_at = ? WHERE claim_id = ?',
          ).run(
            JSON.stringify(input.paths),
            input.note ?? null,
            atIso,
            expiresAt,
            existing.claim_id,
          );
          return {
            kind: 'claimed',
            claim: recordOf(readById(existing.claim_id)),
          };
        }
        const { active } = db
          .prepare(
            `SELECT COUNT(*) AS active FROM orchestration_work_claims WHERE released_at IS NULL AND expires_at > ? AND ${CLAIMANT_MATCH}`,
          )
          .get(atIso, ...claimantValues(input.claimant)) as { active: number };
        if (active >= maxActive) return { kind: 'too_many', max: maxActive };
        const claimId = `claim_${randomUUID()}`;
        db.prepare(
          `INSERT INTO orchestration_work_claims (claim_id, session_id, conversation_id, scope_kind, project_id, task_id, work_item_ref, paths_json, note, claimed_at, renewed_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          claimId,
          input.claimant.sessionId,
          input.claimant.conversationId ?? null,
          input.scope.kind,
          input.scope.kind === 'project' ? input.scope.id : null,
          input.taskId ?? null,
          input.workItemRef ?? null,
          JSON.stringify(input.paths),
          input.note ?? null,
          atIso,
          atIso,
          expiresAt,
        );
        return { kind: 'claimed', claim: recordOf(readById(claimId)) };
      });
    },

    renew(claimId, claimant, ttlSeconds) {
      return inTransaction(() => {
        const row = readOwn(claimId, claimant);
        if (!row) return { kind: 'not_found' };
        const at = now();
        // An expired claim is not revived: the claimant claims again, so the
        // gap in which it held nothing stays visible.
        if (row.released_at !== null || row.expires_at <= iso(at))
          return { kind: 'not_active', claim: recordOf(row) };
        db.prepare(
          'UPDATE orchestration_work_claims SET renewed_at = ?, expires_at = ? WHERE claim_id = ?',
        ).run(iso(at), iso(at + ttlSeconds * 1000), claimId);
        return { kind: 'renewed', claim: recordOf(readById(claimId)) };
      });
    },

    release(claimId, claimant, note) {
      return inTransaction(() => {
        const row = readOwn(claimId, claimant);
        if (!row) return { kind: 'not_found' };
        if (row.released_at !== null)
          return { kind: 'not_active', claim: recordOf(row) };
        db.prepare(
          'UPDATE orchestration_work_claims SET released_at = ?, release_note = ? WHERE claim_id = ?',
        ).run(iso(now()), note ?? null, claimId);
        return { kind: 'released', claim: recordOf(readById(claimId)) };
      });
    },

    listUnexpired(query) {
      const where = ['released_at IS NULL', 'expires_at > ?'];
      const values: unknown[] = [iso(now())];
      if (query.scope) {
        where.push('scope_kind = ?');
        values.push(query.scope.kind);
        if (query.scope.kind === 'project') {
          where.push('project_id = ?');
          values.push(query.scope.id);
        }
      }
      if (query.taskId !== undefined) {
        where.push('task_id = ?');
        values.push(query.taskId);
      }
      if (query.claimants) {
        const { sessionIds, conversationIds } = query.claimants;
        if (sessionIds.length === 0 && conversationIds.length === 0) return [];
        const parts: string[] = [];
        if (sessionIds.length > 0) {
          parts.push(`session_id IN (${sessionIds.map(() => '?').join(',')})`);
          values.push(...sessionIds);
        }
        if (conversationIds.length > 0) {
          parts.push(
            `conversation_id IN (${conversationIds.map(() => '?').join(',')})`,
          );
          values.push(...conversationIds);
        }
        where.push(`(${parts.join(' OR ')})`);
      }
      const limit =
        query.limit !== undefined ? ` LIMIT ${Math.max(0, query.limit)}` : '';
      return (
        db
          .prepare(
            `SELECT * FROM orchestration_work_claims WHERE ${where.join(' AND ')} ORDER BY claimed_at DESC, claim_id ASC${limit}`,
          )
          .all(...values) as WorkClaimRow[]
      ).map(recordOf);
    },
  };
}

/** What a Session's state says about its claims: ended, or still live. */
export interface WorkClaimSessionState {
  readonly status?: string;
  readonly lifecycleState?: string;
}

/**
 * A Session has ended when Station closed it or its runtime is gone, or its
 * lifecycle reached the terminal `completed` (an explicit close; `idle` is a
 * finished turn in a Session still live). A Session Station holds no record
 * of has ended too.
 */
export function workClaimSessionEnded(
  session: WorkClaimSessionState | undefined,
): boolean {
  if (!session) return true;
  return (
    session.status === 'closed' ||
    session.status === 'dead' ||
    session.lifecycleState === 'completed'
  );
}

export interface ActiveWorkClaimReaderDeps {
  readonly store: Pick<WorkClaimStore, 'listUnexpired'>;
  /**
   * The current state of each claimant: the conversation's current Session
   * when the claim names a conversation, else the claiming Session. A key
   * missing from the map is a Session Station holds no record of.
   */
  readSessionStates(
    claims: readonly WorkClaimRecord[],
  ): Promise<ReadonlyMap<string, WorkClaimSessionState>>;
}

/** The key {@link ActiveWorkClaimReaderDeps.readSessionStates} answers by. */
export const workClaimantKey = (claim: WorkClaimRecord): string =>
  claim.conversationId ?? claim.sessionId;

export interface ActiveWorkClaimReader {
  /**
   * The active claims in one Project (`projectId`) or the global space
   * (`projectId: null`), optionally only those made by Sessions dispatched
   * for one Task: unreleased, unexpired, and whose claimant has not ended.
   * Newest first. Server-internal: it applies no caller's authority, so a
   * route that answers a caller decides that caller's reach first.
   */
  listActiveClaims(query: {
    projectId: string | null;
    taskId?: string;
  }): Promise<WorkClaimRecord[]>;
}

export function createActiveWorkClaimReader(
  deps: ActiveWorkClaimReaderDeps,
): ActiveWorkClaimReader {
  return {
    async listActiveClaims({ projectId, taskId }) {
      const unexpired = deps.store.listUnexpired({
        scope:
          projectId === null
            ? { kind: 'global' }
            : { kind: 'project', id: projectId },
        ...(taskId !== undefined ? { taskId } : {}),
      });
      if (unexpired.length === 0) return [];
      const states = await deps.readSessionStates(unexpired);
      return unexpired.filter(
        (claim) => !workClaimSessionEnded(states.get(workClaimantKey(claim))),
      );
    },
  };
}

type ClaimantStateReader = Pick<
  OrchestrationService,
  'currentConversationSessionId' | 'listSessionReadModel'
>;

/**
 * The current Session state of each claim's claimant, by
 * {@link workClaimantKey}: its conversation's current Session when it names
 * one, else its own. Read with Station's internal read scope: it decides
 * liveness, never who may see a claim.
 */
export async function readWorkClaimantStates(
  orchestrationService: ClaimantStateReader,
  claims: readonly WorkClaimRecord[],
): Promise<Map<string, WorkClaimSessionState>> {
  const current = new Map<string, string>();
  for (const claim of claims) {
    const key = workClaimantKey(claim);
    if (current.has(key)) continue;
    current.set(
      key,
      claim.conversationId
        ? orchestrationService.currentConversationSessionId(
            claim.conversationId,
          )
        : claim.sessionId,
    );
  }
  if (current.size === 0) return new Map();
  const summaries = await orchestrationService.listSessionReadModel(
    INTERNAL_SESSION_READ_SCOPE,
    { threadIds: [...new Set(current.values())] },
  );
  const byThread = new Map(
    summaries.map((summary) => [summary.threadId, summary]),
  );
  const states = new Map<string, WorkClaimSessionState>();
  for (const [key, threadId] of current) {
    const summary = byThread.get(threadId);
    if (summary)
      states.set(key, {
        status: summary.status,
        ...(summary.lifecycleState
          ? { lifecycleState: summary.lifecycleState }
          : {}),
      });
  }
  return states;
}

/**
 * The read API a Task brief composes (epic #4003): `listActiveClaims` over the
 * runtime's claim store, with liveness from the runtime's Session state.
 */
export function composeActiveWorkClaimReader(deps: {
  store: Pick<WorkClaimStore, 'listUnexpired'>;
  orchestrationService: ClaimantStateReader;
}): ActiveWorkClaimReader {
  return createActiveWorkClaimReader({
    store: deps.store,
    readSessionStates: (claims) =>
      readWorkClaimantStates(deps.orchestrationService, claims),
  });
}
