/**
 * station#3413: the REST side of Station Control's `list_project_activity` and
 * `get_session_digest`. An agent working in a Project can cheaply learn which
 * other Sessions are active there and what has happened in one of them,
 * without paging a transcript.
 *
 * Both leaves are agent-only reads. Each acts as the VERIFIED station-control
 * caller and answers `station_control_caller_required` to a request that
 * carries none, so the operator's UI, a paired device and Station's own server
 * code, which have their own routes, have nothing to do here.
 *
 * Authority (#2377), decided per Session before anything about it is read:
 *
 * - reads are owner-scoped: the read model is read with the verified caller's
 *   own read authority, so another person's Session is never in it;
 * - the scope rule every dispatch route applies (`stationControlScopeRefusal`,
 *   the owner's Project `view` action): a caller that is not bound stays in its
 *   own Session's Project (or the global space), never reaches a Session that
 *   runs `host`, and never another Station. A bound operator keeps the
 *   operator's reach for a digest, as for `read_conversation`;
 * - `list_project_activity` lists the caller's own Project (or the global
 *   space) for every caller, bound or not: it answers "who is active HERE";
 * - a Session outside that reads exactly like one that does not exist
 *   (`session_not_found`), never refused with detail, in a list or a digest.
 *   No remote host or other Station is ever returned: a delegated Session on a
 *   paired Station or an SSH Environment is left out.
 *
 * Nothing here is summarized by a model. The status is the ladder's word
 * (`sessionLadderWord`, the same derivation the UI words a row with); the
 * digest is folded from recorded events only (`session-digest.ts`).
 */
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import { sessionLadderWord } from '@kontourai/station-contracts/session-attention';
import {
  type HostedTenantRegistry,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { type Context, Hono } from 'hono';
import { getTenantRequestContext } from '../../runtime/bootstrap/runtime-tenant-context.js';
import type { StationControlDispatchScope } from '../../runtime/mcp/station-control-dispatch-scope.js';
import { stationControlRequestAuthority } from '../../security/station-control-request-authority.js';
import { publicAgentIdFromRuntimeKey } from '../../services/agents/runtime-agent-identity.js';
import type { EventStore } from '../../services/orchestration/event-store.js';
import type { OrchestrationService } from '../../services/orchestration/orchestration-service.js';
import {
  type DigestDelegatedChild,
  decodeDigestCursor,
  digestTurn,
  encodeDigestCursor,
  fitDigestPage,
} from '../../services/orchestration/session-digest.js';
import {
  sameScope,
  stationControlRefusal,
  stationControlRefusalBody,
  stationControlScopeRefusal,
  stationControlSessionScope,
} from '../../tools/station-control-policy.js';
import type { StationControlCaller } from '../../tools/station-control-shared.js';
import {
  type PrincipalResolutionContext,
  resolveActorPrincipal,
} from './orchestration.js';
import {
  PROJECT_ACTIVITY_DEFAULT_LIMIT,
  PROJECT_ACTIVITY_MAX_LIMIT,
  SESSION_DIGEST_DEFAULT_TURNS,
  SESSION_DIGEST_MAX_TURNS,
  SESSION_DIGEST_PAGE_MAX_BYTES,
} from './project-activity-limits.js';

/** Delegated children one digest reads; past it the digest says it is incomplete. */
const DIGEST_CHILDREN_READ_LIMIT = 200;

export interface SessionProjectActivityDeps {
  orchestrationService: Pick<
    OrchestrationService,
    | 'canUserReadSession'
    | 'currentConversationSessionId'
    | 'firstStartedMetadataOfThread'
    | 'listSessionReadModel'
  >;
  eventStore: Pick<
    EventStore,
    | 'conversationForSession'
    | 'conversationSessions'
    | 'conversationTitle'
    | 'listSessionsNamingParents'
    | 'readTurnDigestFacts'
  >;
  stationControlDispatchScope?: StationControlDispatchScope;
  resolvePrincipal?: (c: PrincipalResolutionContext) => PrincipalRef;
  hostedTenantRegistry?: HostedTenantRegistry;
}

function callerOf(c: Context): StationControlCaller | Response {
  const authority = stationControlRequestAuthority(c.req.raw);
  if (authority?.kind === 'caller') return authority.caller;
  return c.json(
    stationControlRefusalBody(
      stationControlRefusal('station_control_caller_required'),
    ),
    403,
  );
}

/** A delegated Session on a paired Station or an SSH Environment is another host's. */
const isRemote = (session: {
  delegation?: { environmentKind?: string };
}): boolean =>
  session.delegation?.environmentKind !== undefined &&
  session.delegation.environmentKind !== 'current';

/**
 * The worktree Station provisioned for a Session, from its start record: the
 * path and branch it stamped (`worktree`, or an isolation of mode `worktree`).
 * Absent for a Session whose folder nothing recorded as a worktree.
 */
function recordedWorktree(
  metadata: Record<string, unknown> | undefined,
): { path: string; branch: string } | undefined {
  for (const key of ['worktree', 'workspaceIsolation']) {
    const value = metadata?.[key];
    if (!value || typeof value !== 'object') continue;
    const { mode, path, branch } = value as Record<string, unknown>;
    if (
      mode === 'worktree' &&
      typeof path === 'string' &&
      typeof branch === 'string'
    )
      return { path, branch };
  }
  return undefined;
}

const sessionNotFound = (c: Context) =>
  c.json(
    { success: false, code: 'session_not_found', error: 'Session not found' },
    404,
  );

const invalid = (c: Context, error: string, code = 'invalid_request') =>
  c.json({ success: false, code, error }, 400);

/** `limit` as a whole number from 1 to `max`; absent means `fallback`. */
function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  max: number,
): number | undefined {
  if (value === undefined) return fallback;
  if (!/^\d{1,4}$/u.test(value)) return undefined;
  const parsed = Number(value);
  return parsed >= 1 && parsed <= max ? parsed : undefined;
}

interface ListCursor {
  /** The previous page's last row: its activity time and its id. */
  at: string;
  id: string;
}

function encodeListCursor(cursor: ListCursor): string {
  return Buffer.from(
    JSON.stringify({ v: 1, t: cursor.at, i: cursor.id }),
    'utf8',
  ).toString('base64url');
}

function decodeListCursor(value: string): ListCursor | undefined {
  if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      parsed?.v !== 1 ||
      typeof parsed.t !== 'string' ||
      typeof parsed.i !== 'string'
    )
      return undefined;
    return { at: parsed.t, id: parsed.i };
  } catch {
    return undefined;
  }
}

/**
 * Newest activity first, the id breaking a tie so a cursor names one position:
 * whether `position` comes strictly after `cursor` in that order.
 */
function isAfter(cursor: ListCursor, position: ListCursor): boolean {
  return (
    position.at < cursor.at ||
    (position.at === cursor.at && position.id > cursor.id)
  );
}

export function createSessionProjectActivityRoutes(
  deps: SessionProjectActivityDeps,
) {
  const app = new Hono();

  const readAuthorityFor = (c: Context) =>
    sessionReadAuthorityFromRequest(
      resolveActorPrincipal(deps, c).userId,
      getTenantRequestContext(c.req.raw),
      deps.hostedTenantRegistry,
    );

  /**
   * Whether the caller may see this Session at all: the one scope rule, with
   * the owner's Project `view` action. A Session Station holds no record of
   * has no target and is not visible to anyone but, for a bound operator,
   * the read authority below still has to find it.
   */
  const visibleToCaller = (
    caller: StationControlCaller,
    threadId: string,
  ): {
    visible: boolean;
    scope?: ReturnType<typeof stationControlSessionScope>;
  } => {
    const target = deps.stationControlDispatchScope?.target(
      { kind: 'thread', threadId, remote: false },
      'view',
    );
    if (!target || stationControlScopeRefusal(caller, target))
      return { visible: false };
    return { visible: true, scope: target.scope };
  };

  app.get('/', async (c) => {
    const caller = callerOf(c);
    if (caller instanceof Response) return caller;
    const limit = parseBoundedInteger(
      c.req.query('limit'),
      PROJECT_ACTIVITY_DEFAULT_LIMIT,
      PROJECT_ACTIVITY_MAX_LIMIT,
    );
    if (limit === undefined)
      return invalid(
        c,
        `limit must be a whole number from 1 to ${PROJECT_ACTIVITY_MAX_LIMIT}.`,
        'project_activity_limit_out_of_range',
      );
    const cursorValue = c.req.query('cursor');
    const cursor =
      cursorValue === undefined ? undefined : decodeListCursor(cursorValue);
    if (cursorValue !== undefined && !cursor)
      return invalid(
        c,
        'cursor is not a cursor this read returned. Omit it to start from the newest.',
        'project_activity_cursor_invalid',
      );

    const callerScope = stationControlSessionScope(caller);
    const sessions = await deps.orchestrationService.listSessionReadModel(
      readAuthorityFor(c),
    );
    const rows = sessions
      .filter(
        (session) =>
          // One row per conversation: its current Session.
          (session.currentSessionId === undefined ||
            session.currentSessionId === session.threadId) &&
          // Never another Station or a remote host.
          !isRemote(session),
      )
      .map((session) => ({
        session,
        at: session.lastEventAt ?? session.updatedAt,
      }))
      .sort((a, b) =>
        a.at === b.at
          ? a.session.threadId < b.session.threadId
            ? -1
            : 1
          : a.at < b.at
            ? 1
            : -1,
      );

    // The scope rule is decided lazily, newest first, so a page costs the
    // rows it walks and not the whole inventory.
    const page: typeof rows = [];
    let more = false;
    for (const row of rows) {
      const position = { at: row.at, id: row.session.threadId };
      if (cursor && !isAfter(cursor, position)) continue;
      const seen = visibleToCaller(caller, row.session.threadId);
      // The caller's own Project (or the global space), whoever the caller is.
      if (!seen.visible || !seen.scope || !sameScope(callerScope, seen.scope))
        continue;
      if (page.length === limit) {
        more = true;
        break;
      }
      page.push(row);
    }
    const last = page.at(-1);
    return c.json({
      success: true,
      data: {
        sessions: page.map(({ session, at }) => {
          const title =
            deps.eventStore.conversationTitle([
              session.conversationId ?? session.threadId,
              session.threadId,
            ]) ?? session.displayTitle;
          const worktree = recordedWorktree(
            deps.orchestrationService.firstStartedMetadataOfThread(
              session.threadId,
            ),
          );
          return {
            sessionId: session.threadId,
            ...(session.conversationId
              ? { conversationId: session.conversationId }
              : {}),
            ...(title ? { title } : {}),
            ...(session.projectSlug
              ? { projectSlug: session.projectSlug }
              : {}),
            engine: session.provider,
            ...(session.assignedAgentSlug
              ? {
                  agent: publicAgentIdFromRuntimeKey(session.assignedAgentSlug),
                }
              : {}),
            status: sessionLadderWord(session),
            turnRunning: session.hasActiveTurn === true,
            lastActivityAt: at,
            ...(session.cwd ? { workingDirectory: session.cwd } : {}),
            ...(worktree ? { worktree } : {}),
            ...(session.threadId === caller.sessionId ||
            (caller.conversationId !== undefined &&
              session.conversationId === caller.conversationId)
              ? { self: true as const }
              : {}),
          };
        }),
        nextCursor:
          more && last
            ? encodeListCursor({ at: last.at, id: last.session.threadId })
            : null,
      },
    });
  });

  app.get('/:sessionId/digest', async (c) => {
    const caller = callerOf(c);
    if (caller instanceof Response) return caller;
    const requestedId = c.req.param('sessionId');
    if (!requestedId || requestedId.length > 512) return sessionNotFound(c);
    const turnLimit = parseBoundedInteger(
      c.req.query('turnLimit'),
      SESSION_DIGEST_DEFAULT_TURNS,
      SESSION_DIGEST_MAX_TURNS,
    );
    if (turnLimit === undefined)
      return invalid(
        c,
        `turnLimit must be a whole number from 1 to ${SESSION_DIGEST_MAX_TURNS}.`,
        'session_digest_limit_out_of_range',
      );

    // Scope and read authority first, so a cursor or limit tells a caller
    // nothing about a Session it may not see.
    const conversationId =
      deps.eventStore.conversationForSession(requestedId)?.conversationId ??
      requestedId;
    const lineage = [
      ...new Set([
        conversationId,
        requestedId,
        ...deps.eventStore
          .conversationSessions(conversationId)
          .map((entry) => entry.sessionId),
      ]),
    ];
    const currentId =
      deps.orchestrationService.currentConversationSessionId(conversationId);
    const subjectId = lineage.includes(currentId) ? currentId : requestedId;
    // The conversation as a whole: its newest started Session decides the
    // scope, and `host` is read across every Session of it.
    const target = deps.stationControlDispatchScope?.target(
      { kind: 'conversation', conversationId, remote: false },
      'view',
    );
    if (!target || stationControlScopeRefusal(caller, target))
      return sessionNotFound(c);
    const authority = readAuthorityFor(c);
    if (!deps.orchestrationService.canUserReadSession(subjectId, authority))
      return sessionNotFound(c);
    const [summary] = await deps.orchestrationService.listSessionReadModel(
      authority,
      { threadIds: [subjectId] },
    );
    if (!summary || isRemote(summary)) return sessionNotFound(c);

    const cursorValue = c.req.query('cursor');
    let beforeSequence: number | undefined;
    if (cursorValue !== undefined) {
      const cursor = decodeDigestCursor(cursorValue);
      if (!cursor || cursor.conversationId !== conversationId)
        return invalid(
          c,
          'cursor is not a cursor this digest returned for this Session. Omit it to start from the newest turn.',
          'session_digest_cursor_invalid',
        );
      beforeSequence = cursor.before;
    }

    const read = deps.eventStore.readTurnDigestFacts(lineage, {
      ...(beforeSequence !== undefined
        ? { beforeGlobalSequence: beforeSequence }
        : {}),
      turnLimit,
    });

    // Delegated children: Sessions Station itself derived as launched from
    // this conversation, placed in the turn during which they started, and
    // only those the caller may see (another Project's read as absent).
    const naming = deps.eventStore.listSessionsNamingParents(
      [conversationId],
      DIGEST_CHILDREN_READ_LIMIT,
    );
    const candidates = naming.sessions.filter(
      (child) => child.binding === 'delegation-context' && child.stationDerived,
    );
    // The same read as the list: owner-scoped, so a child the caller's owner
    // may not read is not in it.
    const childSummaries =
      candidates.length === 0
        ? []
        : await deps.orchestrationService.listSessionReadModel(authority, {
            threadIds: candidates.map((child) => child.threadId),
          });
    const children: Array<DigestDelegatedChild & { startedAt: string }> = [];
    for (const child of childSummaries) {
      if (isRemote(child) || !visibleToCaller(caller, child.threadId).visible)
        continue;
      const title =
        deps.eventStore.conversationTitle([child.threadId]) ??
        child.displayTitle;
      children.push({
        sessionId: child.threadId,
        ...(title ? { title } : {}),
        startedAt: child.createdAt,
      });
    }
    const turns = read.turns.map((facts, index) => {
      // Turns are newest first: this turn ran until the next newer one began.
      const end =
        index === 0
          ? read.newerTurnStartedAt
          : read.turns[index - 1]!.startedAt;
      return digestTurn(
        facts,
        children
          .filter(
            (child) =>
              child.startedAt >= facts.startedAt &&
              (end === undefined || child.startedAt < end),
          )
          .sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
      );
    });
    const fitted = fitDigestPage(turns);
    // The turns that fit end the page; the rest wait behind the cursor, so a
    // page that fills early loses nothing.
    const lastIncluded = read.turns[fitted.turns.length - 1];
    const more = fitted.turns.length < turns.length || read.hasMore;
    const worktree = recordedWorktree(
      deps.orchestrationService.firstStartedMetadataOfThread(subjectId),
    );
    const title =
      deps.eventStore.conversationTitle(lineage) ?? summary.displayTitle;
    return c.json({
      success: true,
      data: {
        session: {
          sessionId: subjectId,
          conversationId,
          ...(title ? { title } : {}),
          ...(summary.projectSlug ? { projectSlug: summary.projectSlug } : {}),
          engine: summary.provider,
          ...(summary.assignedAgentSlug
            ? { agent: publicAgentIdFromRuntimeKey(summary.assignedAgentSlug) }
            : {}),
          status: sessionLadderWord(summary),
          turnCount: read.totalTurns,
          ...(worktree ? { worktree } : {}),
        },
        turns: fitted.turns,
        ...(naming.truncated ? { delegatedChildrenIncomplete: true } : {}),
        page: {
          turns: fitted.turns.length,
          bytes: fitted.bytes,
          maxBytes: SESSION_DIGEST_PAGE_MAX_BYTES,
          order: 'newest-first',
        },
        nextCursor:
          more && lastIncluded
            ? encodeDigestCursor({
                conversationId,
                before: lastIncluded.startSequence,
              })
            : null,
      },
    });
  });

  return app;
}
