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
 *   space) for every caller, bound or not: it answers "who is active HERE".
 *   The caller's own conversation (its current Session) is always in it, as
 *   its digest always reads, even when that Session runs `host`;
 * - a Session outside that reads exactly like one that does not exist
 *   (`session_not_found`), never refused with detail, in a list or a digest.
 *   No remote host or other Station is ever returned: a delegated Session on a
 *   paired Station or an SSH Environment is left out.
 *
 * Each row carries its Session's active claims (#3413 part B,
 * `session-work-claims.ts`): unreleased and unexpired, in the caller's own
 * scope (its own row's whatever their scope), and none for a Session that has
 * ended (`workClaimSessionEnded`).
 *
 * Nothing here is summarized by a model. The status is the ladder's word
 * (`sessionLadderWord`, the same derivation the UI words a row with); the
 * digest is folded from recorded events only (`session-digest.ts`).
 */
import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import { sessionLadderWord } from '@kontourai/station-contracts/session-attention';
import {
  type HostedTenantRegistry,
  type SessionReadAuthority,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { type Context, Hono } from 'hono';
import { getTenantRequestContext } from '../../runtime/bootstrap/runtime-tenant-context.js';
import type { StationControlDispatchScope } from '../../runtime/mcp/station-control-dispatch-scope.js';
import { stationControlRequestAuthority } from '../../security/station-control-request-authority.js';
import { publicAgentIdFromRuntimeKey } from '../../services/agents/runtime-agent-identity.js';
import {
  type EventStore,
  TurnDigestLineageTooLongError,
} from '../../services/orchestration/event-store.js';
import type { OrchestrationService } from '../../services/orchestration/orchestration-service.js';
import {
  type DigestDelegatedChild,
  DigestTurnTooLargeError,
  decodeDigestCursor,
  digestTurn,
  encodeDigestCursor,
  fitDigestPage,
  sessionDigestLineage,
} from '../../services/orchestration/session-digest.js';
import {
  type WorkClaimRecord,
  type WorkClaimStore,
  workClaimSessionEnded,
} from '../../services/orchestration/work-claims.js';
import {
  type StationControlScope,
  sameScope,
  stationControlRefusal,
  stationControlRefusalBody,
  stationControlScopeRefusal,
  stationControlSessionScope,
} from '../../tools/station-control-policy.js';
import type { StationControlCaller } from '../../tools/station-control-shared.js';
import {
  ACTIVE_WORK_DEFAULT_MINUTES,
  ACTIVE_WORK_MAX_MINUTES,
  WORK_DISCOVERY_DEFAULT_LIMIT,
} from '../chat/work-discovery-limits.js';
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
    | 'listThreadIdsStartedIn'
    | 'readTurnDigestFacts'
  >;
  stationControlDispatchScope?: StationControlDispatchScope;
  resolvePrincipal?: (c: PrincipalResolutionContext) => PrincipalRef;
  hostedTenantRegistry?: HostedTenantRegistry;
  /** #3413 part B: absent, rows carry no claims. */
  workClaims?: Pick<WorkClaimStore, 'listUnexpired'>;
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

/** Whether a Session is the caller's own, or of the caller's own conversation. */
const isOwnSession = (
  caller: StationControlCaller,
  session: Pick<OrchestrationSessionSummary, 'threadId' | 'conversationId'>,
): boolean =>
  session.threadId === caller.sessionId ||
  (caller.conversationId !== undefined &&
    session.conversationId === caller.conversationId);

const sessionNotFound = (c: Context) =>
  c.json(
    { success: false, code: 'session_not_found', error: 'Session not found' },
    404,
  );

/** A read that is past what this route reads: refused, typed, never cut. */
const tooLarge = (c: Context, code: string, error: string) =>
  c.json({ success: false, code, error }, 422);

const invalid = (c: Context, error: string, code = 'invalid_request') =>
  c.json({ success: false, code, error }, 400);

/** `limit` as a whole number from 1 to `max`; absent means `fallback`. */
function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  max: number,
): number | undefined {
  if (value === undefined) return fallback;
  if (!/^\d{1,5}$/u.test(value)) return undefined;
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

/** A claim as a row in the list shows it: what, until when, and the note. */
const activityClaim = (claim: WorkClaimRecord) => ({
  claimId: claim.claimId,
  ...(claim.workItemRef ? { workItemRef: claim.workItemRef } : {}),
  ...(claim.paths.length > 0 ? { paths: claim.paths } : {}),
  ...(claim.note ? { note: claim.note } : {}),
  ...(claim.taskId ? { taskId: claim.taskId } : {}),
  claimedAt: claim.claimedAt,
  expiresAt: claim.expiresAt,
});

/**
 * Who is reading, as the list and the digest decide visibility for them. An
 * agent caller is held to its own Project by the scope rule; a person is held
 * to the Projects they may `view` (`createSessionPersonActivityRoutes`). Both
 * read through the same owner-scoped read model.
 */
interface ActivityViewer {
  /** The viewer's own conversation: listed and digested whatever its scope. */
  isOwn(
    session: Pick<OrchestrationSessionSummary, 'threadId' | 'conversationId'>,
  ): boolean;
  /** Whether a Session that is not the viewer's own is listed. */
  listsSession(threadId: string): boolean;
  /** Whether a claim on a listed Session that is not the viewer's own shows. */
  showsClaim(claim: WorkClaimRecord): boolean;
  /** Whether a digest names a delegated child. */
  seesChild(threadId: string): boolean;
  /** Whether a digest's conversation (with its lineage) is the viewer's own. */
  ownsConversation(conversationId: string, lineage: readonly string[]): boolean;
  /** Whether a conversation that is not the viewer's own may be digested. */
  digestsConversation(conversationId: string): boolean;
}

/** The person-facing leaves' extra facts: which Projects a person may view. */
export interface SessionPersonActivityDeps extends SessionProjectActivityDeps {
  /** `ProjectConfig.id` for a slug; `undefined` when there is none. */
  projectIdForSlug(slug: string): string | undefined;
  /** Whether `userId` holds the Project `view` action in `localProjectId`. */
  personMayView(userId: string, localProjectId: string): boolean;
  /**
   * The Feature Preview selector: the leaves answer only while it is on, and
   * a typed `feature_preview_disabled` refusal otherwise.
   */
  preview: {
    select<T>(branches: { enabled: () => T; disabled: () => T }): T;
  };
}

/** The Feature Preview that gates the person-facing Session reads. */
export const SESSION_PERSON_READS_PREVIEW = {
  id: 'session-cli-reads',
  label: 'Session reads from the station CLI',
} as const;

/**
 * Refuses a request that is not a person's own: every internal request (a
 * station-control caller, a caller-less child, Station's own server code)
 * has its own routes and its own scope rule, so the person rule is never
 * applied to it.
 */
export function refuseNonPersonRequest(c: Context): Response | undefined {
  if (stationControlRequestAuthority(c.req.raw) === undefined) return undefined;
  return c.json(
    {
      success: false,
      code: 'person_credential_required',
      error:
        "This read answers a person's own credential. Agents use their Station Control tools.",
    },
    403,
  );
}

/** The Feature Preview refusal every person-facing Session read answers while off. */
export function sessionPersonReadsDisabled(c: Context): Response {
  return c.json(
    {
      success: false,
      error: `Enable ${SESSION_PERSON_READS_PREVIEW.label} in Settings → Advanced → Feature previews.`,
      code: 'feature_preview_disabled',
      previewId: SESSION_PERSON_READS_PREVIEW.id,
      settingsPath:
        '/settings?view=feature-previews&highlight=feature-previews',
    },
    404,
  );
}

function createSessionActivityCore(deps: SessionProjectActivityDeps) {
  const readAuthorityFor = (c: Context) =>
    sessionReadAuthorityFromRequest(
      resolveActorPrincipal(deps, c).userId,
      getTenantRequestContext(c.req.raw),
      deps.hostedTenantRegistry,
    );

  /** What the list and the digest both say about a Session. */
  const identityOf = (
    summary: OrchestrationSessionSummary,
    title: string | undefined,
  ) => ({
    ...(title ? { title } : {}),
    ...(summary.projectSlug ? { projectSlug: summary.projectSlug } : {}),
    engine: summary.provider,
    ...(summary.assignedAgentSlug
      ? { agent: publicAgentIdFromRuntimeKey(summary.assignedAgentSlug) }
      : {}),
    status: sessionLadderWord(summary),
  });

  /** One conversation per row (its current Session), never another host, newest first. */
  const activityRows = (sessions: readonly OrchestrationSessionSummary[]) =>
    sessions
      .filter(
        (session) =>
          (session.currentSessionId === undefined ||
            session.currentSessionId === session.threadId) &&
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

  /**
   * The visibility rule is decided per row, newest first, over the candidates
   * the request selected BEFORE the fold, so a call costs those Sessions, not
   * the Station's. That narrowing is an optimization and never the check:
   * every row still passes the viewer's rule here, except the viewer's own
   * conversation, which is its own whatever its scope.
   */
  const visibleRowsPage = (
    viewer: ActivityViewer,
    rows: ReturnType<typeof activityRows>,
    cursor: ListCursor | undefined,
    limit: number,
  ) => {
    const page: typeof rows = [];
    for (const row of rows) {
      const position = { at: row.at, id: row.session.threadId };
      if (cursor && !isAfter(cursor, position)) continue;
      // The viewer's own conversation is listed whatever its scope, as its
      // digest is read: the `host` and Project checks keep a scoped caller
      // out of OTHER Sessions, and its own Session is not another.
      if (
        !viewer.isOwn(row.session) &&
        !viewer.listsSession(row.session.threadId)
      )
        continue;
      // One visible row past the page proves there is more.
      if (page.length === limit) return { page, more: true };
      page.push(row);
    }
    return { page, more: false };
  };

  /**
   * The page's active claims, by row: a claim is its Session's, or its
   * conversation's (a later Session of the same conversation keeps it). A row
   * other than the viewer's own shows only claims the viewer may see.
   */
  const claimsByRow = (
    viewer: ActivityViewer,
    page: ReturnType<typeof activityRows>,
  ): Map<string, WorkClaimRecord[]> => {
    const byRow = new Map<string, WorkClaimRecord[]>();
    if (!deps.workClaims || page.length === 0) return byRow;
    const live = page.filter((row) => !workClaimSessionEnded(row.session));
    const claims = deps.workClaims.listUnexpired({
      claimants: {
        sessionIds: live.map((row) => row.session.threadId),
        conversationIds: live.flatMap((row) =>
          row.session.conversationId ? [row.session.conversationId] : [],
        ),
      },
    });
    for (const row of live) {
      const own = viewer.isOwn(row.session);
      const mine = claims.filter(
        (claim) =>
          (claim.sessionId === row.session.threadId ||
            (claim.conversationId !== undefined &&
              claim.conversationId === row.session.conversationId)) &&
          (own || viewer.showsClaim(claim)),
      );
      if (mine.length > 0) byRow.set(row.session.threadId, mine);
    }
    return byRow;
  };

  const listRow = (
    viewer: ActivityViewer,
    { session, at }: ReturnType<typeof activityRows>[number],
    claims: readonly WorkClaimRecord[] | undefined,
  ) => {
    const title =
      deps.eventStore.conversationTitle([
        session.conversationId ?? session.threadId,
        session.threadId,
      ]) ?? session.displayTitle;
    const worktree = recordedWorktree(
      deps.orchestrationService.firstStartedMetadataOfThread(session.threadId),
    );
    const isSelf = viewer.isOwn(session);
    return {
      sessionId: session.threadId,
      ...(session.conversationId
        ? { conversationId: session.conversationId }
        : {}),
      ...identityOf(session, title),
      turnRunning: session.hasActiveTurn === true,
      lastActivityAt: at,
      ...(session.cwd ? { workingDirectory: session.cwd } : {}),
      ...(worktree ? { worktree } : {}),
      ...(isSelf ? { self: true as const } : {}),
      ...(claims && claims.length > 0
        ? { claims: claims.map(activityClaim) }
        : {}),
    };
  };

  /**
   * One page of the list. `candidates` are the Sessions the request selected
   * before the fold; `undefined` reads every Session the read authority may
   * read (the viewer's rule still decides each row).
   */
  const listActivity = async (
    c: Context,
    viewer: ActivityViewer,
    activeOnly: boolean,
    candidates: () => readonly string[] | undefined,
  ) => {
    const limit = parseBoundedInteger(
      c.req.query('limit'),
      activeOnly
        ? WORK_DISCOVERY_DEFAULT_LIMIT
        : PROJECT_ACTIVITY_DEFAULT_LIMIT,
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
    const threadIds = candidates();
    const sessions = await deps.orchestrationService.listSessionReadModel(
      readAuthorityFor(c),
      threadIds === undefined ? undefined : { threadIds },
    );
    const minutes = parseBoundedInteger(
      c.req.query('activeWithinMinutes'),
      ACTIVE_WORK_DEFAULT_MINUTES,
      ACTIVE_WORK_MAX_MINUTES,
    );
    if (activeOnly && minutes === undefined)
      return invalid(
        c,
        `activeWithinMinutes must be a whole number from 1 to ${ACTIVE_WORK_MAX_MINUTES}.`,
      );
    const since =
      Date.now() - (minutes ?? ACTIVE_WORK_DEFAULT_MINUTES) * 60_000;
    const rows = activityRows(sessions).filter(
      ({ session, at }) =>
        !activeOnly ||
        session.hasActiveTurn === true ||
        Date.parse(at) >= since,
    );
    const { page, more } = visibleRowsPage(viewer, rows, cursor, limit);
    const last = page.at(-1);
    const claims = claimsByRow(viewer, page);
    return c.json({
      success: true,
      data: {
        sessions: page.map((row) =>
          listRow(viewer, row, claims.get(row.session.threadId)),
        ),
        nextCursor:
          more && last
            ? encodeListCursor({ at: last.at, id: last.session.threadId })
            : null,
      },
    });
  };

  /**
   * Delegated children: Sessions Station itself derived as launched from the
   * conversation, read with the same owner-scoped read as the list and only
   * those the viewer may see (another Project's read as absent).
   */
  const delegatedChildren = async (
    viewer: ActivityViewer,
    authority: SessionReadAuthority,
    conversationId: string,
  ) => {
    const naming = deps.eventStore.listSessionsNamingParents(
      [conversationId],
      DIGEST_CHILDREN_READ_LIMIT,
    );
    const candidates = naming.sessions.filter(
      (child) => child.binding === 'delegation-context' && child.stationDerived,
    );
    const summaries =
      candidates.length === 0
        ? []
        : await deps.orchestrationService.listSessionReadModel(authority, {
            threadIds: candidates.map((child) => child.threadId),
          });
    const children: Array<DigestDelegatedChild & { startedAt: string }> = [];
    for (const child of summaries) {
      if (isRemote(child) || !viewer.seesChild(child.threadId)) continue;
      const title =
        deps.eventStore.conversationTitle([child.threadId]) ??
        child.displayTitle;
      children.push({
        sessionId: child.threadId,
        ...(title ? { title } : {}),
        startedAt: child.createdAt,
      });
    }
    return { children, incomplete: naming.truncated };
  };

  /** Each turn (newest first) with the children that started while it ran. */
  const digestTurns = (
    read: ReturnType<EventStore['readTurnDigestFacts']>,
    children: readonly (DigestDelegatedChild & { startedAt: string })[],
  ) =>
    read.turns.map((facts, index) => {
      // A turn ran until the next newer one began.
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

  /**
   * Scope and read authority, decided before anything about the Session is
   * read, so a cursor or limit tells a viewer nothing about a Session it may
   * not see. A Session out of reach is `undefined`: it reads as absent.
   */
  const digestSubject = async (
    c: Context,
    viewer: ActivityViewer,
    requestedId: string,
  ) => {
    const { conversationId, lineage } = sessionDigestLineage(
      deps.eventStore,
      requestedId,
    );
    const currentId =
      deps.orchestrationService.currentConversationSessionId(conversationId);
    const subjectId = lineage.includes(currentId) ? currentId : requestedId;
    // A viewer reads the digest of its OWN conversation whatever its scope,
    // as `read_conversation` reads its own: a Session whose Project cannot be
    // confirmed is still its own.
    if (
      !viewer.ownsConversation(conversationId, lineage) &&
      !viewer.digestsConversation(conversationId)
    )
      return undefined;
    const authority = readAuthorityFor(c);
    // Defense in depth: the read model below applies the same owner check, so
    // this only keeps an unreadable Session from reaching the fold at all.
    if (!deps.orchestrationService.canUserReadSession(subjectId, authority))
      return undefined;
    const [summary] = await deps.orchestrationService.listSessionReadModel(
      authority,
      { threadIds: [subjectId] },
    );
    if (!summary || isRemote(summary)) return undefined;
    return { conversationId, lineage, subjectId, summary, authority };
  };

  const digest = async (c: Context, viewer: ActivityViewer) => {
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
    const subject = await digestSubject(c, viewer, requestedId);
    if (!subject) return sessionNotFound(c);
    const { conversationId, lineage, subjectId, summary, authority } = subject;

    const cursorValue = c.req.query('cursor');
    const cursor =
      cursorValue === undefined ? undefined : decodeDigestCursor(cursorValue);
    if (
      cursorValue !== undefined &&
      (!cursor || cursor.conversationId !== conversationId)
    )
      return invalid(
        c,
        'cursor is not a cursor this digest returned for this Session. Omit it to start from the newest turn.',
        'session_digest_cursor_invalid',
      );

    let read: ReturnType<EventStore['readTurnDigestFacts']>;
    try {
      read = deps.eventStore.readTurnDigestFacts(lineage, {
        ...(cursor ? { beforeGlobalSequence: cursor.before } : {}),
        turnLimit,
      });
    } catch (error) {
      if (error instanceof TurnDigestLineageTooLongError)
        return tooLarge(c, error.code, error.message);
      throw error;
    }
    const { children, incomplete } = await delegatedChildren(
      viewer,
      authority,
      conversationId,
    );
    const turns = digestTurns(read, children);
    let fitted: ReturnType<typeof fitDigestPage>;
    try {
      fitted = fitDigestPage(turns);
    } catch (error) {
      if (error instanceof DigestTurnTooLargeError)
        return tooLarge(c, error.code, error.message);
      throw error;
    }
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
          ...identityOf(summary, title),
          turnCount: read.totalTurns,
          ...(worktree ? { worktree } : {}),
        },
        turns: fitted.turns,
        ...(incomplete ? { delegatedChildrenIncomplete: true } : {}),
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
  };

  return { listActivity, digest };
}

export function createSessionProjectActivityRoutes(
  deps: SessionProjectActivityDeps,
) {
  const app = new Hono();
  const core = createSessionActivityCore(deps);

  /**
   * Whether the caller may see this Session at all: the one scope rule, with
   * the owner's Project `view` action. A Session Station holds no record of
   * has no target and is not visible to anyone but, for a bound operator,
   * the read authority still has to find it.
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

  /**
   * The agent's rule: every caller, bound or not, lists only its own Project
   * (or the global space); a bound operator keeps the operator's reach for a
   * digest, as for `read_conversation`.
   */
  const callerViewer = (caller: StationControlCaller): ActivityViewer => {
    const callerScope = stationControlSessionScope(caller);
    return {
      isOwn: (session) => isOwnSession(caller, session),
      listsSession: (threadId) => {
        const seen = visibleToCaller(caller, threadId);
        return (
          seen.visible &&
          seen.scope !== undefined &&
          sameScope(callerScope, seen.scope)
        );
      },
      showsClaim: (claim) => sameScope(callerScope, claim.scope),
      seesChild: (threadId) => visibleToCaller(caller, threadId).visible,
      // A caller reads the digest of its OWN conversation whatever its scope,
      // as `read_conversation` reads its own.
      ownsConversation: (conversationId, lineage) =>
        lineage.includes(caller.sessionId) ||
        (caller.conversationId !== undefined &&
          caller.conversationId === conversationId) ||
        deps.eventStore.conversationForSession(caller.sessionId)
          ?.conversationId === conversationId,
      digestsConversation: (conversationId) => {
        // The conversation as a whole: its newest started Session decides
        // the scope, and `host` is read across every Session of it.
        const target = deps.stationControlDispatchScope?.target(
          { kind: 'conversation', conversationId, remote: false },
          'view',
        );
        return (
          target !== undefined && !stationControlScopeRefusal(caller, target)
        );
      },
    };
  };

  const listActivity = (c: Context, activeOnly: boolean) => {
    const caller = callerOf(c);
    if (caller instanceof Response) return caller;
    // A caller whose own scope cannot be read matches no other Session (the
    // rule refuses it); its own conversation's current Session, and its own,
    // are candidates whatever its scope.
    const callerScope = stationControlSessionScope(caller);
    return core.listActivity(c, callerViewer(caller), activeOnly, () => [
      ...new Set([
        caller.sessionId,
        ...(caller.conversationId !== undefined
          ? [
              deps.orchestrationService.currentConversationSessionId(
                caller.conversationId,
              ),
            ]
          : []),
        ...(callerScope.kind === 'unreadable'
          ? []
          : deps.eventStore.listThreadIdsStartedIn(
              callerScope.kind === 'project' ? callerScope.id : undefined,
            )),
      ]),
    ]);
  };
  app.get('/', (c) => listActivity(c, false));
  app.get('/active-work', (c) => listActivity(c, true));

  app.get('/:sessionId/digest', (c) => {
    const caller = callerOf(c);
    if (caller instanceof Response) return caller;
    return core.digest(c, callerViewer(caller));
  });

  return app;
}

/**
 * #3427: a person's Project rule for a Session, shared by every person-facing
 * Session read. The Session's scope comes from Station's own records (the
 * same resolver the agent rule reads); the action checked is the PERSON's
 * `view` there, never the recorded owner's. The global space admits; a
 * Project the person may not view, or a scope that cannot be read, does not.
 */
export function personSessionScope(
  deps: Pick<
    SessionPersonActivityDeps,
    'stationControlDispatchScope' | 'personMayView'
  >,
) {
  const admits = (userId: string, scope: StationControlScope | undefined) =>
    scope?.kind === 'global' ||
    (scope?.kind === 'project' && deps.personMayView(userId, scope.id));
  const ofThread = (threadId: string) =>
    deps.stationControlDispatchScope?.target(
      { kind: 'thread', threadId, remote: false },
      'view',
    )?.scope;
  const ofConversation = (conversationId: string) =>
    deps.stationControlDispatchScope?.target(
      { kind: 'conversation', conversationId, remote: false },
      'view',
    )?.scope;
  return {
    admits,
    ofThread,
    ofConversation,
    /** Whether `userId` may see this Session under the Project rule. */
    seesSession: (userId: string, threadId: string) =>
      admits(userId, ofThread(threadId)),
  };
}

/**
 * #3427: the person-facing leaves of the same two reads, for `station
 * activity` and `station session digest`. A person's own credential reads
 * here, never an agent's: every internal request is refused
 * (`person_credential_required`), so the agent leaves above keep their scope
 * rule and these never apply the person rule to an agent.
 *
 * Authority, decided per Session before anything about it is read:
 *
 * - reads are owner-scoped: the read model is read with the person's own read
 *   authority, so another person's Session is never in it;
 * - a Session in a Project is visible only while the person holds that
 *   Project's `view` action (the same membership rule as the Project routes),
 *   a Session in the global space always, one whose Project cannot be read
 *   never. A Session out of reach reads like one that does not exist;
 * - `projectSlug` narrows the list to one Project (its Sessions only, not the
 *   global space). A Project the person may not view, or that does not exist,
 *   answers `project_not_found` alike. Without it, the list is every visible
 *   Session;
 * - no remote host or other Station is ever returned, and nothing is `self`.
 *
 * Gated by the `session-cli-reads` Feature Preview.
 */
export function createSessionPersonActivityRoutes(
  deps: SessionPersonActivityDeps,
) {
  const app = new Hono();
  const core = createSessionActivityCore(deps);

  const scope = personSessionScope(deps);

  /** The Project-scope rule for a person, `only` narrowing to one Project. */
  const personViewer = (userId: string, only?: string): ActivityViewer => {
    const admits = (
      found: StationControlScope | undefined,
      narrowed: boolean,
    ) =>
      narrowed && only !== undefined
        ? found?.kind === 'project' &&
          found.id === only &&
          scope.admits(userId, found)
        : scope.admits(userId, found);
    return {
      isOwn: () => false,
      listsSession: (threadId) => admits(scope.ofThread(threadId), true),
      showsClaim: (claim) => admits(claim.scope, false),
      seesChild: (threadId) => admits(scope.ofThread(threadId), false),
      ownsConversation: () => false,
      digestsConversation: (conversationId) =>
        admits(scope.ofConversation(conversationId), false),
    };
  };

  const projectNotFound = (c: Context) =>
    c.json(
      { success: false, code: 'project_not_found', error: 'Project not found' },
      404,
    );

  app.get('/activity', (c) => {
    const refused = refuseNonPersonRequest(c);
    if (refused) return refused;
    return deps.preview.select<Response | Promise<Response>>({
      disabled: () => sessionPersonReadsDisabled(c),
      enabled: () => {
        const userId = resolveActorPrincipal(deps, c).userId;
        const slug = c.req.query('projectSlug');
        let projectId: string | undefined;
        if (slug !== undefined) {
          projectId = undefined;
          try {
            if (slug.length > 0 && slug.length <= 256)
              projectId = deps.projectIdForSlug(slug);
          } catch {
            // A slug Station cannot read names no Project it may list.
          }
          if (!projectId || !deps.personMayView(userId, projectId))
            return projectNotFound(c);
        }
        const activeOnly = c.req.query('activeWithinMinutes') !== undefined;
        return core.listActivity(
          c,
          personViewer(userId, projectId),
          activeOnly,
          () =>
            projectId === undefined
              ? undefined
              : deps.eventStore.listThreadIdsStartedIn(projectId),
        );
      },
    });
  });

  app.get('/:sessionId/digest', (c) => {
    const refused = refuseNonPersonRequest(c);
    if (refused) return refused;
    return deps.preview.select<Response | Promise<Response>>({
      disabled: () => sessionPersonReadsDisabled(c),
      enabled: () =>
        core.digest(c, personViewer(resolveActorPrincipal(deps, c).userId)),
    });
  });

  return app;
}
