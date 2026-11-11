import type {
  ConversationListItem,
  ConversationReadState,
} from '@kontourai/station-contracts/orchestration';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import {
  deriveReadMarkerState,
  READ_MARKER_REFUSAL_CODES,
  READ_MARKER_SUMMARY_MAX_TARGETS,
  type ReadMarkerState,
  type ReadMarkerSummaryItem,
  type ReadMarkerTarget,
  ReadMarkerTooManyTargetsError,
} from '@kontourai/station-contracts/read-markers';
import {
  isHostedSessionReadAuthority,
  type SessionReadAuthority,
} from '@kontourai/station-contracts/tenancy';
import {
  type ConversationAcknowledgementStore,
  conversationAcknowledgementKey,
  type IsOwnerDevice,
} from '../orchestration/conversation-acknowledgement-store.js';
import type {
  ReadMarkerBaseline,
  ReadMarkerStore,
} from './read-marker-store.js';

/**
 * Whose read state a request reads and writes (#3075).
 *
 * A personal Station uses the conversation inventory's own person key
 * (`conversationAcknowledgementKey`): the local operator and their unbound
 * paired devices are one person. A hosted Station's inventory key is the
 * tenant alone, which would make one member's reading clear unread for every
 * member, so read markers there are keyed by the verified person inside the
 * tenant. A hosted request that carries only the tenant names no person and
 * has no read state (`undefined`); so does a principal that cannot be
 * resolved.
 */
export function readMarkerPersonKey(input: {
  authority: SessionReadAuthority;
  principal: () => PrincipalRef;
  isOwnerDevice?: IsOwnerDevice;
}): string | undefined {
  if (!isHostedSessionReadAuthority(input.authority))
    return conversationAcknowledgementKey(input.authority, input.isOwnerDevice);
  const tenantId = input.authority.tenantExecutionContext?.tenantId;
  if (!tenantId) return undefined;
  let principal: PrincipalRef;
  try {
    principal = input.principal();
  } catch {
    return undefined;
  }
  return principal.kind === 'human'
    ? `tenant:${tenantId}#${principal.id}`
    : undefined;
}

/**
 * An agent conversation's versions (#3075 owner design). `version` is its
 * CONTENT version: it moves only when readable transcript content is
 * appended, never on lifecycle bookkeeping. It is what `readState` reports,
 * what a client acknowledges as rendered, and what a mark is bounded by.
 * `space` says what it counts: `content` is the event store's monotonic
 * sequence (runtime conversations), `time` the epoch ms of a file-backed
 * conversation's own `updatedAt`, which has no lifecycle events.
 * `acknowledgeableUntil` is the inventory `updatedAt` (epoch ms) a client
 * shows; it bounds the last-viewed record only.
 */
export interface AgentConversationVersion {
  readonly version: number;
  readonly space: 'content' | 'time';
  readonly acknowledgeableUntil: number;
}

/** An inventory item, as the version source reads its versions. */
export type AgentConversationVersionItem = Pick<
  ConversationListItem,
  'id' | 'source' | 'updatedAt'
>;

/**
 * Current versions of the caller's agent conversations. Batched: one summary
 * request reads the caller's inventory once, not once per conversation. A
 * conversation the caller cannot read is absent from the answer.
 */
export interface AgentConversationVersionSource {
  latestVersions(
    conversationIds: readonly string[],
    request: Request,
  ): Promise<ReadonlyMap<string, AgentConversationVersion>>;
  /** The versions of inventory items the caller has already read. */
  versionsOf(
    items: readonly AgentConversationVersionItem[],
  ): ReadonlyMap<string, AgentConversationVersion>;
  /**
   * An older client's acknowledgement carries only the inventory
   * `updatedAt` it showed: the content version it could have seen then,
   * mapped conservatively (never content persisted after that view), or
   * `undefined` when nothing can be claimed.
   */
  contentVersionAsOfView(
    conversationId: string,
    updatedAt: string,
  ): number | undefined;
}

/** A room the caller may read: its marker key and current sequence. */
export interface RoomVersion {
  /** Stable store key built from the room's own server-side identity. */
  readonly key: string;
  readonly latestVersion: number;
}

export interface RoomVersionSource<T> {
  /** `undefined` for a room the caller cannot read, or that does not exist. */
  latest(target: T, request: Request): Promise<RoomVersion | undefined>;
}

/**
 * The minimal per-request shape the service needs: the same duck-typed subset
 * of a Hono context the identity-bearing routes pass around.
 */
export interface ReadMarkerRequestContext {
  env: unknown;
  req: { raw: Request; header(name: string): string | undefined };
}

/** The caller is not a person, so has no read state to read or write. */
export class ReadMarkerNoPersonError extends Error {
  constructor() {
    super('Only a person has read state');
    this.name = 'ReadMarkerNoPersonError';
  }
}

/** The requested version is above the conversation's current version. */
export class ReadMarkerFutureVersionError extends RangeError {
  readonly code = READ_MARKER_REFUSAL_CODES.futureVersion;
  constructor(
    readonly requestedVersion: number,
    readonly latestVersion: number,
  ) {
    super(
      `Read marker version ${requestedVersion} is above the conversation's current version ${latestVersion}`,
    );
    this.name = 'ReadMarkerFutureVersionError';
  }
}

type ProjectRoomTarget = Extract<ReadMarkerTarget, { kind: 'project-room' }>;
type TaskRoomTarget = Extract<ReadMarkerTarget, { kind: 'task-room' }>;

interface Resolved {
  key: string;
  latestVersion: number;
  countable: boolean;
  /** Agent conversations: see {@link AgentConversationVersion}. */
  space?: AgentConversationVersion['space'];
  acknowledgeableUntil?: number;
}

export interface ReadMarkerServiceDeps {
  /**
   * Whose read state a request reads and writes: the per-person key the
   * conversation inventory already files "last viewed" under
   * (`conversationAcknowledgementKey`), so the owner's desktop and their
   * unbound paired phone are one person. `undefined` for a caller that is
   * not a person.
   */
  personKeyFor(c: ReadMarkerRequestContext): string | undefined;
  /**
   * The inventory's "last viewed" record (`acknowledgedAt`, Home's Just
   * finished), written alongside an acknowledgement and never read for
   * unread.
   */
  conversations: Pick<ConversationAcknowledgementStore, 'acknowledge'>;
  /** Every read marker, and the baselines. */
  store: ReadMarkerStore;
  /**
   * Called once each time a person's marker actually moves forward, with
   * their person key, so their other clients can re-read.
   */
  onChanged?: (personKey: string) => void;
  agentConversations?: AgentConversationVersionSource;
  projectRooms?: RoomVersionSource<ProjectRoomTarget>;
  taskRooms?: RoomVersionSource<TaskRoomTarget>;
  now?: () => Date;
}

const AGENT_PREFIX = 'agent-conversation:';

/**
 * Server-kept read state (#3075). Owns the three rules the contract states:
 * markers belong to the request's person, only move forward, and never pass
 * the conversation's current version.
 */
export class ReadMarkerService {
  constructor(private readonly deps: ReadMarkerServiceDeps) {}

  /** When read state began being kept; see `ReadMarkerStore.baseline`. */
  baseline(): ReadMarkerBaseline {
    return this.deps.store.baseline();
  }

  private personKey(c: ReadMarkerRequestContext): string {
    const key = this.deps.personKeyFor(c);
    if (!key) throw new ReadMarkerNoPersonError();
    return key;
  }

  private async resolve(
    targets: readonly ReadMarkerTarget[],
    request: Request,
  ): Promise<(Resolved | undefined)[]> {
    const conversationIds = targets.flatMap((target) =>
      target.kind === 'agent-conversation' ? [target.conversationId] : [],
    );
    const conversationVersions =
      conversationIds.length > 0 && this.deps.agentConversations
        ? await this.deps.agentConversations.latestVersions(
            conversationIds,
            request,
          )
        : new Map<string, AgentConversationVersion>();
    return Promise.all(
      targets.map(async (target): Promise<Resolved | undefined> => {
        switch (target.kind) {
          case 'agent-conversation': {
            const versions = conversationVersions.get(target.conversationId);
            return versions === undefined
              ? undefined
              : {
                  key: `${AGENT_PREFIX}${target.conversationId}`,
                  latestVersion: versions.version,
                  space: versions.space,
                  acknowledgeableUntil: versions.acknowledgeableUntil,
                  countable: false,
                };
          }
          case 'project-room': {
            const room = await this.deps.projectRooms?.latest(target, request);
            return room && { ...room, countable: true };
          }
          case 'task-room': {
            const room = await this.deps.taskRooms?.latest(target, request);
            return room && { ...room, countable: true };
          }
        }
      }),
    );
  }

  /** Stored seen versions for resolved targets, by marker key. */
  private seen(
    person: string,
    resolved: readonly (Resolved | undefined)[],
  ): Map<string, number> {
    const keys = resolved.flatMap((item) => (item ? [item.key] : []));
    return new Map(this.deps.store.getMany(person, keys));
  }

  private state(
    target: ReadMarkerTarget,
    item: Resolved,
    stored: number,
    baseline: ReadMarkerBaseline,
  ): ReadMarkerState {
    return deriveReadMarkerState({
      target,
      latestVersion: item.latestVersion,
      // Agent conversations never read below the baseline of their space.
      seenVersion:
        target.kind === 'agent-conversation'
          ? Math.max(stored, baselineIn(baseline, item.space))
          : stored,
      countable: item.countable,
    });
  }

  /**
   * Read state for many conversations at once, in request order. Refuses
   * (never truncates) more than {@link READ_MARKER_SUMMARY_MAX_TARGETS}.
   */
  async summary(
    c: ReadMarkerRequestContext,
    targets: readonly ReadMarkerTarget[],
  ): Promise<ReadMarkerSummaryItem[]> {
    if (targets.length > READ_MARKER_SUMMARY_MAX_TARGETS)
      throw new ReadMarkerTooManyTargetsError(targets.length);
    const person = this.personKey(c);
    const resolved = await this.resolve(targets, c.req.raw);
    const seen = this.seen(person, resolved);
    const baseline = this.baseline();
    return targets.map((target, index) => {
      const item = resolved[index];
      if (!item) return { target, unavailable: true as const };
      return this.state(target, item, seen.get(item.key) ?? 0, baseline);
    });
  }

  /**
   * Advance the caller's marker to `version`. Idempotent and monotonic: an
   * older or repeated version leaves it where it is. Answers `undefined` for
   * a conversation the caller cannot read; throws
   * {@link ReadMarkerFutureVersionError} for a version above the current one.
   */
  async mark(
    c: ReadMarkerRequestContext,
    target: ReadMarkerTarget,
    version: number,
  ): Promise<ReadMarkerState | undefined> {
    const person = this.personKey(c);
    const [resolved] = await this.resolve([target], c.req.raw);
    if (!resolved) return undefined;
    if (version > resolved.latestVersion)
      throw new ReadMarkerFutureVersionError(version, resolved.latestVersion);
    return this.advance(person, target, resolved, version);
  }

  /** Moves `person`'s marker forward and announces it if it moved. */
  private advance(
    person: string,
    target: ReadMarkerTarget,
    resolved: Resolved,
    version: number,
  ): ReadMarkerState {
    const before = this.seen(person, [resolved]).get(resolved.key) ?? 0;
    this.deps.store.advance({
      principalId: person,
      key: resolved.key,
      version,
      now: this.deps.now?.() ?? new Date(),
    });
    const after = this.seen(person, [resolved]).get(resolved.key) ?? 0;
    if (after > before) this.deps.onChanged?.(person);
    return this.state(target, resolved, after, this.baseline());
  }

  /**
   * `POST /api/conversations/:id/acknowledgement` (#3075). Two records:
   *
   * - The "last viewed" record under the inventory's own key (`inheritedKey`,
   *   `acknowledgedAt`, Home's Just finished): the `updatedAt` the client
   *   showed, refused above the current `updatedAt`. Never read for unread.
   * - The person's read marker: the content version the client rendered
   *   (`readVersion`), refused above the current one. An older client that
   *   sends only `updatedAt` gets the content version as of that view,
   *   mapped conservatively, so content persisted after it stays unread.
   *
   * `undefined` when the caller cannot read the conversation; `state` is
   * absent for a caller that names no person.
   */
  async acknowledgeConversation(
    c: ReadMarkerRequestContext,
    conversationId: string,
    view: { updatedAt: string; readVersion?: number },
    inheritedKey: string,
  ): Promise<{ state?: ReadMarkerState } | undefined> {
    const target: ReadMarkerTarget = {
      kind: 'agent-conversation',
      conversationId,
    };
    const [resolved] = await this.resolve([target], c.req.raw);
    if (!resolved) return undefined;
    const viewedAt = Date.parse(view.updatedAt);
    const until = resolved.acknowledgeableUntil ?? resolved.latestVersion;
    if (viewedAt > until)
      throw new ReadMarkerFutureVersionError(viewedAt, until);
    if (
      view.readVersion !== undefined &&
      view.readVersion > resolved.latestVersion
    )
      throw new ReadMarkerFutureVersionError(
        view.readVersion,
        resolved.latestVersion,
      );
    const person = this.deps.personKeyFor(c);
    const rendered = person
      ? (view.readVersion ??
        (resolved.space === 'time'
          ? viewedAt
          : this.deps.agentConversations?.contentVersionAsOfView(
              conversationId,
              view.updatedAt,
            )))
      : undefined;
    // The read marker first: the last-viewed record is secondary, and a
    // failure writing it must not leave content unmarked.
    const state =
      person === undefined
        ? undefined
        : rendered === undefined
          ? this.state(
              target,
              resolved,
              this.seen(person, [resolved]).get(resolved.key) ?? 0,
              this.baseline(),
            )
          : this.advance(
              person,
              target,
              resolved,
              Math.min(rendered, resolved.latestVersion),
            );
    this.deps.conversations.acknowledge({
      userId: inheritedKey,
      conversationId,
      updatedAt: new Date(viewedAt).toISOString(),
    });
    return state ? { state } : {};
  }

  /**
   * The caller's derived read state for inventory items, from their person
   * key and each item's content version; `undefined` when the caller is not
   * a person (no read state, never a guessed one).
   */
  conversationReadStates(
    c: ReadMarkerRequestContext,
    items: readonly AgentConversationVersionItem[],
  ): ReadonlyMap<string, ConversationReadState> | undefined {
    const person = this.deps.personKeyFor(c);
    if (!person) return undefined;
    const versions = this.deps.agentConversations?.versionsOf(items);
    if (!versions) return undefined;
    const seen = this.deps.store.getMany(
      person,
      [...versions.keys()].map((id) => `${AGENT_PREFIX}${id}`),
    );
    const baseline = this.baseline();
    return new Map(
      [...versions].map(([id, { version, space }]) => {
        const seenVersion = Math.min(
          Math.max(
            seen.get(`${AGENT_PREFIX}${id}`) ?? 0,
            baselineIn(baseline, space),
          ),
          version,
        );
        return [id, { version, seenVersion, unread: version > seenVersion }];
      }),
    );
  }
}

/** The baseline in a conversation's own version space. */
function baselineIn(
  baseline: ReadMarkerBaseline,
  space: AgentConversationVersion['space'] | undefined,
): number {
  return space === 'time' ? baseline.time : baseline.sequence;
}
