import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import {
  type AcpSessionListing,
  acpSessionListingEnabled,
  hasDedicatedSessionSource,
} from '../../services/acp/acp-session-listing.js';
import { isRecord } from '../../utils/is-record.js';
import type {
  AttachedSessionDescriptor,
  AttachedSessionDiscoveryResult,
  AttachedSessionReadResult,
  AttachedSessionSource,
  AttachedSessionSourceOutcome,
} from './attached-session-source.js';
import { boundedInteger, digest, text } from './session-source-values.js';

const DEFAULT_MAX_SESSIONS = 512;
const MAX_SESSIONS_CEILING = 2048;
const EPOCH = '1970-01-01T00:00:00.000Z';

interface AcpSessionListSourceOptions {
  /**
   * Each configured connection's last `session/list` answer, as the ACP
   * capability probe recorded it (`ACPManager.sessionListings`). Called on
   * every discovery; it must only read cached state, never start an agent.
   */
  listings: () => ReadonlyArray<{
    connection: Pick<ACPConnectionConfig, 'id' | 'command' | 'enabled'>;
    listing: AcpSessionListing;
  }>;
  /** Defaults to the `STATION_EXTERNAL_ACP_SESSIONS=1` opt-in. */
  enabled?: () => boolean;
  maxSessions?: number;
}

/**
 * Sessions an ACP agent reports through `session/list`, for every configured
 * connection whose `initialize` advertises it (see `acp-session-listing.ts`).
 *
 * LIST ONLY. Station imports no history for these sessions: ACP's only
 * history read, `session/load`, resumes the session in the agent, so a
 * follower that called it would take over the session it is meant to watch.
 * `read` therefore answers with no events, and the thread Station shows is
 * the session's folder and project with no transcript. The source starts no
 * process: the listing rides the probe Station already runs per connection
 * (every five minutes), so a new session can take that long to appear.
 *
 * No continuation is declared for ACP (`externalSessionContinuation` is
 * `unsupported`): Station has no evidence that resuming one of these
 * sessions keeps its history.
 */
export class AcpSessionListSource implements AttachedSessionSource {
  readonly provider = 'acp';
  readonly kind = 'acp-session-list';
  readonly metadataOnly = true as const;
  private readonly listings: AcpSessionListSourceOptions['listings'];
  private readonly enabled: () => boolean;
  private readonly maxSessions: number;
  private readonly handles = new Map<string, AttachedSessionDescriptor>();
  /** First time each listed session was seen, so `createdAt` stays fixed. */
  private readonly firstSeenAt = new Map<string, string>();

  constructor(options: AcpSessionListSourceOptions) {
    this.listings = options.listings;
    this.enabled = options.enabled ?? (() => acpSessionListingEnabled());
    this.maxSessions = boundedInteger(
      'maxSessions',
      options.maxSessions ?? DEFAULT_MAX_SESSIONS,
      MAX_SESSIONS_CEILING,
    );
  }

  /** Station's own ACP sessions are listed by the agent too; they are not external. */
  ownedNativeSessionId(session: {
    provider: string;
    resumeCursor?: unknown;
  }): string | undefined {
    if (session.provider !== 'acp' || !isRecord(session.resumeCursor))
      return undefined;
    return text(session.resumeCursor.acpSessionId);
  }

  async discover(): Promise<AttachedSessionDiscoveryResult> {
    this.handles.clear();
    if (!this.enabled()) return { outcome: 'missing_root', sessions: [] };
    const listings = this.listings().filter(
      ({ connection }) =>
        connection.enabled !== false && !hasDedicatedSessionSource(connection),
    );
    if (listings.length === 0) return { outcome: 'missing_root', sessions: [] };

    let outcome: AttachedSessionSourceOutcome = 'ok';
    const sessions: AttachedSessionDescriptor[] = [];
    const current = new Set<string>();
    for (const { connection, listing } of listings) {
      outcome = mergeOutcome(outcome, listingOutcome(listing));
      for (const listed of listing.sessions) {
        if (sessions.length >= this.maxSessions) {
          outcome = mergeOutcome(outcome, 'candidate_limit');
          break;
        }
        const sourceHandle = digest([
          this.kind,
          connection.id,
          listed.sessionId,
        ]);
        if (this.handles.has(sourceHandle)) continue;
        current.add(sourceHandle);
        const createdAt =
          this.firstSeenAt.get(sourceHandle) ?? listed.updatedAt ?? EPOCH;
        this.firstSeenAt.set(sourceHandle, createdAt);
        const descriptor: AttachedSessionDescriptor = {
          provider: this.provider,
          sessionId: listed.sessionId,
          threadId: `external:acp:${digest([connection.id, listed.sessionId])}`,
          cwd: listed.cwd,
          createdAt,
          ...(listed.updatedAt
            ? { modifiedAtMs: Date.parse(listed.updatedAt) }
            : {}),
          sourceHandle,
        };
        this.handles.set(sourceHandle, descriptor);
        sessions.push(descriptor);
      }
    }
    for (const handle of this.firstSeenAt.keys())
      if (!current.has(handle)) this.firstSeenAt.delete(handle);
    return { outcome, sessions };
  }

  async read(
    session: AttachedSessionDescriptor,
  ): Promise<AttachedSessionReadResult> {
    const known = this.handles.get(session.sourceHandle);
    if (
      !known ||
      known.threadId !== session.threadId ||
      known.sessionId !== session.sessionId
    ) {
      return { outcome: 'unknown_source', events: [], cursor: 0 };
    }
    return { outcome: 'ok', events: [], cursor: 0 };
  }
}

function listingOutcome(
  listing: AcpSessionListing,
): AttachedSessionSourceOutcome {
  switch (listing.outcome) {
    case 'limit':
      return 'candidate_limit';
    case 'malformed':
      return 'malformed_record';
    case 'failed':
      return 'unknown_source';
    default:
      return listing.rejected > 0 ? 'rejected_candidate' : 'ok';
  }
}

function mergeOutcome(
  current: AttachedSessionSourceOutcome,
  next: AttachedSessionSourceOutcome,
): AttachedSessionSourceOutcome {
  const priority: Record<AttachedSessionSourceOutcome, number> = {
    ok: 0,
    incomplete_tail: 1,
    byte_limit: 2,
    line_limit: 3,
    candidate_limit: 4,
    malformed_record: 5,
    rejected_candidate: 6,
    missing_root: 7,
    unknown_source: 8,
  };
  return priority[next] > priority[current] ? next : current;
}
