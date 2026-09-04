/** Canonical read-only SQL shared by EventStore and its isolated transcript reader. No initialization or migrations. */
import { createHash } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';

/** Both EventStore's corruption-watching handle and a native readonly connection. */
interface TranscriptQueryDatabase {
  prepare(sql: string): {
    get(...parameters: SQLInputValue[]): unknown;
    all(...parameters: SQLInputValue[]): unknown[];
  };
}
export class TranscriptReadLimitError extends Error {}
/** Recency only breaks comparable FTS relevance; shared with the write owner's public constant. */
export const MESSAGE_SEARCH_RECENCY_SCORE_PER_DAY = 0.000000001;
export function queryTranscriptMessages(
  db: TranscriptQueryDatabase,
  options: {
    query: string;
    ownerUserId: string;
    tenantId?: string;
    limit: number;
  },
  bounded = false,
): Array<{
  threadId: string;
  eventId: string;
  turnId?: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  agentSlug?: string;
  projectSlug?: string;
  engine?: string;
  turnAnchorId?: string;
}> {
  const contentTerms = nonCjkSearchTerms(options.query);
  const cjkTerms = cjkSearchTerms(options.query);
  // A punctuation-only query must not degrade into an owner-wide match.
  if (!contentTerms && !cjkTerms) return [];
  const matchTerms = [
    ftsColumnPhrase(
      'owner_scope_key',
      messageOwnerScopeKey(options.ownerUserId),
    ),
  ];
  if (options.tenantId) {
    matchTerms.splice(
      1,
      0,
      ftsColumnPhrase(
        'tenant_scope_key',
        messageTenantScopeKey(options.tenantId),
      ),
    );
  }
  if (contentTerms) {
    matchTerms.push(ftsColumnPhrase('content', contentTerms));
  }
  if (cjkTerms) {
    matchTerms.push(ftsColumnPhrase('cjk_terms', cjkTerms));
  }
  const column = (name: string, limit = 256) =>
    bounded
      ? `CASE WHEN length(CAST(${name} AS BLOB)) <= ${limit} THEN ${name} END`
      : name;
  const overflow = bounded
    ? `(${['s.thread_id', 's.event_id', 's.turn_id', 'h.agent_slug', 'h.project_slug', 'p.provider'].map((name) => `coalesce(length(CAST(${name} AS BLOB)), 0) > 256`).join(' OR ')} OR length(CAST(s.content AS BLOB)) > 131072)`
    : '0';
  const rows = db
    .prepare(
      `SELECT ${column('s.thread_id')} AS thread_id, ${column('s.event_id')} AS event_id,
                ${column('s.turn_id')} AS turn_id, s.role, ${column('s.content', 131072)} AS content,
                s.created_at, ${column('h.agent_slug')} AS agent_slug,
                ${column('h.project_slug')} AS project_slug, ${column('p.provider')} AS provider,
                ${overflow} AS oversized,
                (SELECT e.id FROM orchestration_events e
                  WHERE e.thread_id = s.thread_id AND e.turn_id = s.turn_id
                    AND e.method = 'turn.started' LIMIT 1) AS turn_anchor_id
           FROM orchestration_message_search_v3 s
           INNER JOIN orchestration_conversation_history h
             ON h.thread_id = s.thread_id
           LEFT JOIN provider_session_state p
             ON p.thread_id = s.thread_id
          WHERE orchestration_message_search_v3 MATCH ?
            AND h.owner_user_id = ?
            AND (? IS NULL OR h.tenant_id = ?)
          ORDER BY bm25(orchestration_message_search_v3) +
                     ((julianday('now') - julianday(s.created_at)) * ?) ASC,
                   s.created_at DESC,
                   s.event_id ASC
          LIMIT ?`,
    )
    .all(
      matchTerms.join(' AND '),
      options.ownerUserId,
      options.tenantId ?? null,
      options.tenantId ?? null,
      MESSAGE_SEARCH_RECENCY_SCORE_PER_DAY,
      options.limit,
    ) as Array<{
    oversized?: number;
    thread_id: string;
    event_id: string;
    turn_id: string | null;
    role: 'user' | 'assistant';
    content: string;
    created_at: string;
    agent_slug: string | null;
    project_slug: string | null;
    provider: string | null;
    turn_anchor_id: string | null;
  }>;
  if (
    bounded &&
    rows.some((row) => row.oversized || typeof row.content !== 'string')
  )
    throw new TranscriptReadLimitError(
      'Transcript candidate exceeds its allowance',
    );
  return rows.map((row) => ({
    threadId: row.thread_id,
    eventId: row.event_id,
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    ...(row.agent_slug ? { agentSlug: row.agent_slug } : {}),
    ...(row.project_slug ? { projectSlug: row.project_slug } : {}),
    ...(row.provider ? { engine: row.provider } : {}),
    ...(row.turn_anchor_id ? { turnAnchorId: row.turn_anchor_id } : {}),
  }));
}

export function querySessionOwner(
  db: TranscriptQueryDatabase,
  threadId: string,
  bounded = false,
): string | undefined {
  const owner = "json_extract(payload, '$.metadata.userId')";
  const selected = bounded
    ? `CASE WHEN length(CAST(${owner} AS BLOB)) <= 256 THEN ${owner} END`
    : owner;
  const overflow = bounded
    ? `, length(CAST(${owner} AS BLOB)) > 256 AS oversized`
    : '';
  const row = db
    .prepare(
      `SELECT ${selected} AS user_id${overflow}
         FROM orchestration_events
         WHERE thread_id = ?
           AND json_valid(payload)
           AND json_extract(payload, '$.metadata.userId') IS NOT NULL
           AND json_type(payload, '$.metadata.userId') = 'text'
           AND method IN ('session.started', 'session.configured')
         ORDER BY created_at DESC, sequence DESC
         LIMIT 1`,
    )
    .get(threadId) as { user_id?: unknown; oversized?: number } | undefined;
  if (bounded && row?.oversized)
    throw new TranscriptReadLimitError('Session owner exceeds its allowance');
  return typeof row?.user_id === 'string' ? row.user_id : undefined;
}

/** Opaque FTS scope terms keep user/tenant postings disjoint from body terms. */
function messageSearchScopeKey(
  kind: 'owner' | 'tenant',
  value: string,
): string {
  return createHash('sha256').update(`${kind}\0${value}`).digest('hex');
}

export function messageOwnerScopeKey(ownerUserId: string): string {
  return messageSearchScopeKey('owner', ownerUserId);
}

export function messageTenantScopeKey(tenantId: string): string {
  return messageSearchScopeKey('tenant', tenantId);
}

/** Quote exactly one FTS5 column phrase; user text never becomes syntax. */
function ftsColumnPhrase(column: string, value: string): string {
  return `${column} : "${value.replaceAll('"', '""')}"`;
}

const CJK_CODE_POINT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_RUN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

/**
 * unicode61 treats a CJK run as one token, so a substring query cannot match
 * it. Index each CJK code point and adjacent pair as a quoted FTS phrase;
 * this preserves phrase order while making one- and two-character queries
 * searchable without changing tokenization of scope hashes or Latin text.
 */
export function cjkSearchTerms(value: string): string {
  const terms: string[] = [];
  let run: string[] = [];
  const flush = () => {
    for (let index = 0; index < run.length; index += 1) {
      terms.push(run[index]!);
      if (index + 1 < run.length) {
        terms.push(`${run[index]}${run[index + 1]}`);
      }
    }
    run = [];
  };
  for (const character of value) {
    if (CJK_CODE_POINT.test(character)) {
      run.push(character);
    } else if (run.length > 0) {
      flush();
    }
  }
  if (run.length > 0) flush();
  return terms.join(' ');
}

/** Keep unicode61's established behavior for non-CJK text in a mixed query. */
function nonCjkSearchTerms(value: string): string {
  return value.replace(CJK_RUN, ' ').trim();
}

export function messageSearchExcerpt(content: string, query: string): string {
  const normalized = query.trim();
  const matchAt = content
    .toLocaleLowerCase()
    .indexOf(normalized.toLocaleLowerCase());
  if (matchAt < 0 || content.length <= 240) return content.slice(0, 240);
  const start = Math.max(0, matchAt - 80);
  const end = Math.min(content.length, start + 240);
  return `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`;
}
