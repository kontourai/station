import {
  deriveReadMarkerState,
  READ_MARKER_REFUSAL_CODES,
  READ_MARKER_SUMMARY_MAX_TARGETS,
  type ReadMarkerState,
  type ReadMarkerSummaryItem,
  type ReadMarkerTarget,
  ReadMarkerTooManyTargetsError,
} from '@kontourai/station-contracts/read-markers';
import type { ConversationAcknowledgementStore } from '../orchestration/conversation-acknowledgement-store.js';
import type { ReadMarkerStore } from './read-marker-store.js';

/**
 * Current versions of the caller's agent conversations. Batched: one summary
 * request reads the caller's inventory once, not once per conversation. A
 * conversation the caller cannot read is absent from the answer.
 */
export interface AgentConversationVersionSource {
  latestVersions(
    conversationIds: readonly string[],
    request: Request,
  ): Promise<ReadonlyMap<string, number>>;
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
  /** Agent-conversation markers: the inventory's own acknowledgement store. */
  conversations: Pick<
    ConversationAcknowledgementStore,
    'getMany' | 'acknowledge'
  >;
  /** Room markers and the baseline. */
  store: ReadMarkerStore;
  agentConversations?: AgentConversationVersionSource;
  projectRooms?: RoomVersionSource<ProjectRoomTarget>;
  taskRooms?: RoomVersionSource<TaskRoomTarget>;
  now?: () => Date;
}

const AGENT_PREFIX = 'agent-conversation:';

/** Epoch ms of a stored acknowledgement version, or 0 when it does not parse. */
export function acknowledgedVersion(value: string | undefined): number {
  const at = value === undefined ? Number.NaN : Date.parse(value);
  return Number.isSafeInteger(at) && at > 0 ? at : 0;
}

/**
 * Server-kept read state (#3075). Owns the three rules the contract states:
 * markers belong to the request's person, only move forward, and never pass
 * the conversation's current version.
 */
export class ReadMarkerService {
  constructor(private readonly deps: ReadMarkerServiceDeps) {}

  /** When read state began being kept; see `ReadMarkerStore.baseline`. */
  baseline(): number {
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
        : new Map<string, number>();
    return Promise.all(
      targets.map(async (target): Promise<Resolved | undefined> => {
        switch (target.kind) {
          case 'agent-conversation': {
            const latestVersion = conversationVersions.get(
              target.conversationId,
            );
            return latestVersion === undefined
              ? undefined
              : {
                  key: `${AGENT_PREFIX}${target.conversationId}`,
                  latestVersion,
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
    const conversationIds = keys.flatMap((key) =>
      key.startsWith(AGENT_PREFIX) ? [key.slice(AGENT_PREFIX.length)] : [],
    );
    const result = new Map(
      this.deps.store.getMany(
        person,
        keys.filter((key) => !key.startsWith(AGENT_PREFIX)),
      ),
    );
    const acknowledged = this.deps.conversations.getMany(
      person,
      conversationIds,
    );
    for (const id of conversationIds)
      result.set(
        `${AGENT_PREFIX}${id}`,
        acknowledgedVersion(acknowledged.get(id)),
      );
    return result;
  }

  private state(
    target: ReadMarkerTarget,
    item: Resolved,
    stored: number,
    baseline: number,
  ): ReadMarkerState {
    return deriveReadMarkerState({
      target,
      latestVersion: item.latestVersion,
      // Agent conversations never read below the baseline.
      seenVersion:
        target.kind === 'agent-conversation'
          ? Math.max(stored, baseline)
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
    if (target.kind === 'agent-conversation') {
      // The acknowledgement store keeps the later of the two versions.
      this.deps.conversations.acknowledge({
        userId: person,
        conversationId: target.conversationId,
        updatedAt: new Date(version).toISOString(),
      });
    } else {
      this.deps.store.advance({
        principalId: person,
        key: resolved.key,
        version,
        now: this.deps.now?.() ?? new Date(),
      });
    }
    const seen = this.seen(person, [resolved]);
    return this.state(
      target,
      resolved,
      seen.get(resolved.key) ?? 0,
      this.baseline(),
    );
  }
}
