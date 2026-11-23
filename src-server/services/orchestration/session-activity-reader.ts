import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { sessionLadderWord } from '@kontourai/station-contracts/session-attention';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import { publicAgentIdFromRuntimeKey } from '../agents/runtime-agent-identity.js';
import type { EventStore } from './event-store.js';
import type { OrchestrationService } from './orchestration-service.js';
import {
  type WorkClaimRecord,
  type WorkClaimStore,
  workClaimSessionEnded,
} from './work-claims.js';

export interface SessionActivityReaderDeps {
  orchestrationService: Pick<
    OrchestrationService,
    'listSessionReadModel' | 'firstStartedMetadataOfThread'
  >;
  eventStore: Pick<EventStore, 'conversationTitle'>;
  workClaims?: Pick<WorkClaimStore, 'listUnexpired'>;
}

/** A delegated Session on a paired Station or an SSH Environment is another host's. */
export const isRemoteActivitySession = (session: {
  delegation?: { environmentKind?: string };
}): boolean =>
  session.delegation?.environmentKind !== undefined &&
  session.delegation.environmentKind !== 'current';

/**
 * The worktree Station provisioned for a Session, from its start record: the
 * path and branch it stamped (`worktree`, or an isolation of mode `worktree`).
 * Absent for a Session whose folder nothing recorded as a worktree.
 */
export function recordedActivityWorktree(
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

interface ActivityCursor {
  /** The previous page's last row: its activity time and its id. */
  at: string;
  id: string;
}

function encodeListCursor(cursor: ActivityCursor): string {
  return Buffer.from(
    JSON.stringify({ v: 1, t: cursor.at, i: cursor.id }),
    'utf8',
  ).toString('base64url');
}

export function decodeActivityCursor(
  value: string,
  maxLength = 1024,
): ActivityCursor | undefined {
  if (value.length > maxLength || !/^[A-Za-z0-9_-]+$/u.test(value))
    return undefined;
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
function isAfter(cursor: ActivityCursor, position: ActivityCursor): boolean {
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

export interface ActivityListViewer {
  /** The viewer's own conversation: listed and digested whatever its scope. */
  isOwn(
    session: Pick<OrchestrationSessionSummary, 'threadId' | 'conversationId'>,
  ): boolean;
  /** Whether a Session that is not the viewer's own is listed. */
  listsSession(threadId: string): boolean;
  /** Whether a claim on a listed Session that is not the viewer's own shows. */
  showsClaim(claim: WorkClaimRecord): boolean;
}

/** What the list and the digest both say about a Session. */
export const sessionActivityIdentity = (
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

export function createSessionActivityReader(deps: SessionActivityReaderDeps) {
  /** One conversation per row (its current Session), never another host, newest first. */
  const activityRows = (sessions: readonly OrchestrationSessionSummary[]) =>
    sessions
      .filter(
        (session) =>
          (session.currentSessionId === undefined ||
            session.currentSessionId === session.threadId) &&
          !isRemoteActivitySession(session),
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
    viewer: ActivityListViewer,
    rows: ReturnType<typeof activityRows>,
    cursor: ActivityCursor | undefined,
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
    viewer: ActivityListViewer,
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
    viewer: ActivityListViewer,
    { session, at }: ReturnType<typeof activityRows>[number],
    claims: readonly WorkClaimRecord[] | undefined,
  ) => {
    const title =
      deps.eventStore.conversationTitle([
        session.conversationId ?? session.threadId,
        session.threadId,
      ]) ?? session.displayTitle;
    const worktree = recordedActivityWorktree(
      deps.orchestrationService.firstStartedMetadataOfThread(session.threadId),
    );
    const isSelf = viewer.isOwn(session);
    return {
      sessionId: session.threadId,
      ...(session.conversationId
        ? { conversationId: session.conversationId }
        : {}),
      ...sessionActivityIdentity(session, title),
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

  return {
    async page(input: {
      authority: SessionReadAuthority;
      viewer: ActivityListViewer;
      threadIds?: readonly string[];
      selectThreadIds?: () => readonly string[];
      cursor?: ActivityCursor;
      limit: number;
      activeWithinMinutes?: number;
      now?: () => number;
    }) {
      const {
        authority,
        viewer,
        threadIds,
        cursor,
        limit,
        activeWithinMinutes,
      } = input;
      const sessions = await deps.orchestrationService.listSessionReadModel(
        authority,
        {
          purpose: 'project-activity',
          ...(threadIds === undefined ? {} : { threadIds }),
          ...(input.selectThreadIds
            ? { selectThreadIds: input.selectThreadIds }
            : {}),
        },
      );
      const since =
        activeWithinMinutes === undefined
          ? undefined
          : (input.now ?? Date.now)() - activeWithinMinutes * 60_000;
      const rows = activityRows(sessions).filter(
        ({ session, at }) =>
          since === undefined ||
          session.hasActiveTurn === true ||
          Date.parse(at) >= since,
      );
      const { page, more } = visibleRowsPage(viewer, rows, cursor, limit);
      const last = page.at(-1);
      const claims = claimsByRow(viewer, page);
      return {
        sessions: page.map((row) =>
          listRow(viewer, row, claims.get(row.session.threadId)),
        ),
        nextCursor:
          more && last
            ? encodeListCursor({ at: last.at, id: last.session.threadId })
            : null,
      };
    },
  };
}
