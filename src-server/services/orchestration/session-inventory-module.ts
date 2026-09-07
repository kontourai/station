import { createHash } from 'node:crypto';
import {
  type OwnerRef,
  SESSION_INVENTORY_CURRENT_GROUP_IDS,
  SESSION_INVENTORY_PAGE_MAX_ITEMS,
  SESSION_INVENTORY_VERSION,
  type SessionInventoryRow,
  type SessionInventoryScope,
  type SessionInventoryV2Group,
  type SessionInventoryV2GroupId,
  type SessionInventoryV2GroupPage,
  type SessionInventoryV2Projection,
  type SessionInventoryV2Row,
} from '@kontourai/station-contracts/session-inventory';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import type { ExactAnswerBasisModule } from '../evidence/exact-answer-basis-module.js';
import { reviewedSourceSessionInventoryGroup } from '../evidence/reviewed-source-session-inventory-adapter.js';
import type {
  SessionInventoryCursor,
  SessionInventoryEventDescriptor,
  SessionInventoryEventRead,
} from './event-store.js';
import type { SessionOutputsModule } from './session-outputs-module.js';
import type { SessionAnswerBasisQueryOutcome } from './session-query-module.js';
import type { SessionWorkItemModule } from './session-work-item-module.js';

export type SessionInventoryReadOutcome =
  | { status: 'found'; projection: SessionInventoryV2Projection }
  | { status: 'not-found' }
  | { status: 'unavailable' };
export type SessionInventoryPageOutcome =
  | { status: 'found'; page: SessionInventoryV2GroupPage }
  | { status: 'not-found' }
  | { status: 'unavailable' };
export interface SessionInventoryModule {
  read(input: {
    scope: SessionInventoryScope;
    /** Task route supplies exact, already-authorized kept rows. */
    keptRows?: readonly Extract<
      SessionInventoryRow,
      { kind: `task-kept-${string}` }
    >[];
    /** Exact Task work-item identity, supplied only by the Task route. */
    taskWorkItemRef?: string;
    authority: SessionReadAuthority;
    current: () => boolean;
  }): Promise<SessionInventoryReadOutcome>;
  page(input: {
    scope: SessionInventoryScope;
    groupId: SessionInventoryV2GroupId;
    continuation?: string;
    keptRows?: readonly Extract<
      SessionInventoryRow,
      { kind: `task-kept-${string}` }
    >[];
    taskWorkItemRef?: string;
    authority: SessionReadAuthority;
    current: () => boolean;
  }): Promise<SessionInventoryPageOutcome>;
}
/**
 * Task route composition supplies only already-validated, exact-provenance
 * rows. Keeping this pure prevents the Session module from reaching into a
 * Task graph or inferring that an unrelated Task item was retained here.
 */
export function withTaskKeptRows(
  projection: SessionInventoryV2Projection,
  rows: readonly Extract<
    SessionInventoryRow,
    { kind: `task-kept-${string}` }
  >[],
): SessionInventoryV2Projection {
  if (projection.scope.kind !== 'kept-in-task') return projection;
  const items = rows.slice(0, 2);
  return {
    ...projection,
    groups: projection.groups.map((group) =>
      group.id !== 'kept'
        ? group
        : {
            id: 'kept' as const,
            owner: owner('station.task-graph'),
            state: rows.length
              ? ('available' as const)
              : ('not-captured' as const),
            ...(rows.length
              ? { count: { kind: 'at-least' as const, value: rows.length } }
              : {}),
            items,
            // TaskOutput snapshots and gate records have no exact Session
            // provenance at this schema revision, so never widen them in.
            gaps: [{ kind: 'not-captured' as const }],
          },
    ),
  };
}

function taskKeptGroup(
  rows: readonly Extract<
    SessionInventoryRow,
    { kind: `task-kept-${string}` }
  >[],
): SessionInventoryV2Group {
  return {
    id: 'kept',
    owner: owner('station.task-graph'),
    state: rows.length ? 'available' : 'not-captured',
    ...(rows.length
      ? { count: { kind: 'exact' as const, value: rows.length } }
      : {}),
    items: rows,
    gaps: [{ kind: 'not-captured' as const }],
  };
}
const owner = (name: string): OwnerRef => ({ owner: name, id: 'v1' });
function gap(
  id: SessionInventoryV2GroupId,
  kind:
    | 'not-captured'
    | 'restricted'
    | 'unavailable'
    | 'unsupported-version'
    | 'corrupt' = 'not-captured',
  code?:
    | 'session-source-index-not-captured'
    | 'task-source-provenance-not-captured',
): SessionInventoryV2Group {
  return {
    id,
    owner: owner(id === 'sources' ? 'surface.sources' : 'station.inventory'),
    state: kind,
    items: [],
    gaps: [{ kind, ...(code ? { code } : {}) }],
  };
}
function empty(id: SessionInventoryV2GroupId): SessionInventoryV2Group {
  return {
    id,
    owner: owner('station.inventory'),
    state: 'empty',
    count: { kind: 'exact', value: 0 },
    items: [],
    gaps: [],
  };
}
/**
 * Bounded composition seam. It intentionally receives only owner projections:
 * it never exposes EventStore payloads, response bodies, or provider objects.
 */
export function createSessionInventoryModule(input: {
  sessionOutputs: SessionOutputsModule;
  /** Indexed canonical facts only; never a transcript/event-page replay. */
  /** Complete, allowlisted historical descriptors for Whole Session only. */
  readWholeSessionEvents?: (
    sessionId: string,
    frozenHighWater?: number,
    continuation?: { sequence: number; eventId: string },
    group?: import('./event-store.js').SessionInventoryEventGroup,
    limit?: number,
  ) => SessionInventoryEventRead;
  readWholeSessionHighWater?: (sessionId: string) => number;
  canReadSession: (
    sessionId: string,
    authority: SessionReadAuthority,
  ) => boolean;
  /** Exact Thread owner read; current-answer never falls back to a Session fold. */
  readAnswerBasis?: (
    sessionId: string,
    turnId: string,
    authority: SessionReadAuthority,
  ) => Promise<SessionAnswerBasisQueryOutcome>;
  readExactAnswerBasis?: ExactAnswerBasisModule['read'];
  /** Persisted EventStore cursor authority, supplied only by runtime composition. */
  issueCursor?: (cursor: SessionInventoryCursor) => string;
  readCursor?: (token: string) => SessionInventoryCursor | undefined;
  /** Authorized, bounded work-item owner. Inventory never scans conversations. */
  sessionWorkItems?: SessionWorkItemModule;
  /** Exact EventStore lineage lookup used solely to address that owner. */
  conversationForSession?: (
    sessionId: string,
  ) => { conversationId: string } | undefined;
}): SessionInventoryModule {
  const canRead = (
    sessionId: string,
    authority: SessionReadAuthority,
    current: () => boolean,
  ) => current() && input.canReadSession(sessionId, authority);
  const folded = async (
    scope: SessionInventoryScope,
    authority: SessionReadAuthority,
    frozenHighWater?: number,
    group?: import('./event-store.js').SessionInventoryEventGroup,
    limit = 2,
    start?: { sequence: number; eventId: string },
    answerResult?: SessionAnswerBasisQueryOutcome,
  ): Promise<{
    groups: Partial<Record<SessionInventoryV2GroupId, SessionInventoryV2Group>>;
    highWater: number;
    continuation?: { sequence: number; eventId: string };
  }> => {
    if (scope.kind === 'current-answer') {
      if (!answerResult && !input.readAnswerBasis)
        return { groups: {}, highWater: 0 };
      const answer = answerResult
        ? answerResult
        : await input.readAnswerBasis!(
            scope.sessionId,
            scope.turnId,
            authority,
          );
      if (answer.status !== 'found') return { groups: {}, highWater: 0 };
      // The exact Thread owner has already proved session/turn/authority.
      // Do not infer a same-turn output: a declaration is lineage, whereas
      // answer support requires an explicit owner contribution relation.
      const inputs: SessionInventoryRow[] = answer.inputs.map((item) => ({
        kind: 'thread-authored-input',
        key: `input:${item.eventId}`,
        owner: owner('thread.answer-basis'),
        // `readAnswerBasis` returns the exact inputs that the Thread owner
        // contributed to this answer's Basis composition; this is not a
        // same-turn heuristic.
        relations: ['contributed-to'],
        sessionId: answer.sessionId,
        eventId: item.eventId,
        turnId: answer.turnId,
        inputKind:
          item.kind === 'steer'
            ? 'steer'
            : item.attachments.length
              ? 'attachment'
              : 'message',
        attachmentDescriptors: item.attachments.map((attachment) => ({
          kind: 'attachment' as const,
          name: attachment.name,
          mediaType: attachment.mediaType,
          length: attachment.size,
        })),
      }));
      const group = (
        id: SessionInventoryV2GroupId,
        items: SessionInventoryRow[],
      ): SessionInventoryV2Group => ({
        id,
        owner: owner('thread.answer-basis'),
        state: items.length ? 'available' : 'empty',
        count: { kind: 'exact', value: items.length },
        items,
        gaps: [],
      });
      return {
        groups: {
          inputs: group('inputs', inputs),
          // Surface and Flow have separate exact owners. Until they publish a
          // contribution bound to this answer, their groups stay explicit gaps.
          sources: gap('sources'),
          execution: gap('execution'),
          decisions: gap('decisions'),
          outputs: gap('outputs'),
          'verification-delivery': gap('verification-delivery'),
        },
        highWater: 0,
      };
    }
    if (scope.kind !== 'whole-session' || !input.readWholeSessionEvents)
      return { groups: {}, highWater: 0 };
    const inputs: SessionInventoryRow[] = [];
    const execution: SessionInventoryRow[] = [];
    const decisions: SessionInventoryRow[] = [];
    const resources: SessionInventoryRow[] = [];
    let events: readonly SessionInventoryEventDescriptor[];
    let highWater = 0;
    let ownerContinuation: { sequence: number; eventId: string } | undefined;
    try {
      const first = input.readWholeSessionEvents(
        scope.sessionId,
        frozenHighWater,
        start,
        group,
        limit,
      );
      highWater = first.highWater;
      events = first.events;
      ownerContinuation = first.continuation;
    } catch {
      const unavailable = (
        id: 'inputs' | 'execution' | 'decisions' | 'resources',
      ): SessionInventoryV2Group => ({
        id,
        owner: owner('thread.canonical-events'),
        state: 'unavailable',
        items: [],
        gaps: [{ kind: 'unavailable' }],
      });
      return {
        groups: group
          ? { [group]: unavailable(group) }
          : {
              inputs: unavailable('inputs'),
              execution: unavailable('execution'),
              decisions: unavailable('decisions'),
              resources: unavailable('resources'),
            },
        highWater: 0,
      };
    }
    for (const event of events) {
      const fact = event as SessionInventoryEventDescriptor & {
        // Test-only legacy shape retained while old persisted event fixtures
        // migrate; production EventStore returns descriptors only.
        payload?: Record<string, unknown>;
      };
      const descriptor = (fact.payload ?? fact) as Record<string, any>;
      // Deliberately enumerate only typed canonical facts. In particular,
      // text/reasoning deltas, progress, arguments, output, error details,
      // request text and arbitrary metadata never reach this projection.
      if (descriptor.method === 'turn.started') {
        const attachments = (descriptor.attachments ?? []).map(
          (attachment: {
            name: string;
            mediaType?: string;
            mimeType?: string;
            length?: number;
            size?: number;
          }) => ({
            kind: 'attachment' as const,
            name: attachment.name,
            mediaType: attachment.mediaType ?? attachment.mimeType ?? '',
            length: attachment.length ?? attachment.size ?? 0,
          }),
        );
        inputs.push({
          kind: 'thread-authored-input',
          key: `input:${event.id}`,
          owner: owner('thread.canonical-events'),
          relations: ['provided-to'],
          sessionId: scope.sessionId,
          eventId: event.id,
          turnId: descriptor.turnId,
          inputKind:
            descriptor.inputKind === 'steer'
              ? 'steer'
              : attachments.length
                ? 'attachment'
                : 'message',
          attachmentDescriptors: attachments,
        });
      } else if (descriptor.method === 'tool.completed') {
        const terminalStatus =
          descriptor.terminalStatus ??
          (descriptor.status === 'success'
            ? 'succeeded'
            : descriptor.status === 'error'
              ? 'failed'
              : descriptor.status === 'unresolved'
                ? 'unresolved'
                : 'cancelled');
        // station#1558: `ThreadToolResultRow.terminalStatus` is a published,
        // version-validated vocabulary of succeeded/failed/cancelled, and an
        // unresolved completion is none of them. Emitting it as `cancelled`
        // would put a fabricated outcome in an inventory whose whole purpose
        // is to be believable; widening the enum would make every older
        // consumer reject the ROW (their validator is exact), which is a
        // worse failure than not describing this one event. So the event is
        // simply not projected as a tool-result row — the transcript still
        // carries it. Revisit if the inventory contract gains a version that
        // can say "outcome never observed".
        if (terminalStatus === 'unresolved') continue;
        execution.push({
          kind: 'thread-tool-result',
          key: `tool:${event.id}`,
          owner: owner('thread.canonical-events'),
          relations: ['observed-during'],
          sessionId: scope.sessionId,
          eventId: event.id,
          turnId: descriptor.turnId ?? '',
          toolCallId: descriptor.toolCallId,
          name: descriptor.name ?? descriptor.toolName,
          terminalStatus,
        });
      } else if (descriptor.method === 'request.resolved') {
        decisions.push({
          kind: 'station-request-decision',
          key: `request:${event.id}`,
          owner: owner('thread.canonical-events'),
          relations: ['observed-during'],
          sessionId: scope.sessionId,
          eventId: event.id,
          requestId: descriptor.requestId,
          status:
            descriptor.status === 'approved'
              ? 'accepted'
              : descriptor.status === 'denied'
                ? 'declined'
                : descriptor.status === 'cancelled'
                  ? 'cancelled'
                  : descriptor.status === 'accepted' ||
                      descriptor.status === 'declined' ||
                      descriptor.status === 'pending'
                    ? descriptor.status
                    : 'pending',
        });
      } else if (
        descriptor.method === 'session.configured' &&
        descriptor.model
      ) {
        resources.push({
          kind: 'station-resource-summary',
          key: `model:${event.id}`,
          owner: owner('thread.canonical-events'),
          relations: ['observed-during'],
          sessionId: scope.sessionId,
          model: descriptor.model,
          engine: descriptor.engine ?? descriptor.provider,
        });
      } else if (descriptor.method === 'token-usage.updated') {
        const inputTokens = descriptor.inputTokens ?? descriptor.promptTokens;
        const outputTokens =
          descriptor.outputTokens ?? descriptor.completionTokens;
        const cachedTokens =
          descriptor.cachedTokens ?? descriptor.cacheReadTokens;
        const costMicros =
          descriptor.costMicros ??
          (descriptor.reportedCostUsd === undefined
            ? undefined
            : Math.round(descriptor.reportedCostUsd * 1_000_000));
        resources.push({
          kind: 'station-resource-summary',
          key: `usage:${event.id}`,
          owner: owner('thread.canonical-events'),
          relations: ['observed-during'],
          sessionId: scope.sessionId,
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
          ...(cachedTokens === undefined ? {} : { cachedTokens }),
          ...(costMicros === undefined ? {} : { costMicros }),
        });
      }
    }
    const ownerGroup = (
      id: 'inputs' | 'execution' | 'decisions' | 'resources',
      items: SessionInventoryV2Group['items'],
    ): SessionInventoryV2Group => ({
      id,
      owner: owner('thread.canonical-events'),
      state: items.length ? 'available' : 'empty',
      count: {
        kind: items.length > 2 ? 'at-least' : 'exact',
        value: items.length,
      },
      // Preview/page shaping happens once at the public boundary below. Keep
      // the bounded fold intact here so page two can never silently lose its
      // third canonical fact.
      items,
      gaps: [],
    });
    const groups = {
      inputs: ownerGroup('inputs', inputs),
      execution: ownerGroup('execution', execution),
      decisions: ownerGroup('decisions', decisions),
      resources: ownerGroup('resources', resources),
    };
    return {
      groups: group ? { [group]: groups[group] } : groups,
      highWater,
      ...(ownerContinuation ? { continuation: ownerContinuation } : {}),
    };
  };
  const authorityKey = (authority: SessionReadAuthority) =>
    `${authority.mode}:${authority.tenantExecutionContext?.tenantId ?? ''}:${authority.userId}`;
  const scopeCursor = (
    scope: SessionInventoryScope,
    groupId: SessionInventoryV2GroupId,
    highWater: number,
    contentDigest: string,
    position: number,
    authority: SessionReadAuthority,
    page?: {
      start?: { sequence: number; eventId: string };
      next: { sequence: number; eventId: string };
      size: number;
    },
  ) =>
    input.issueCursor?.({
      sessionId: scope.sessionId,
      authority: authorityKey(authority),
      version: SESSION_INVENTORY_VERSION,
      scope: scope.kind,
      ...(scope.kind === 'current-answer' ? { turnId: scope.turnId } : {}),
      ...(scope.kind === 'kept-in-task' ? { taskId: scope.taskId } : {}),
      groupId,
      highWater,
      contentDigest,
      position,
      ...(page
        ? {
            pageSize: page.size,
            ...(page.start
              ? {
                  pageStartSequence: page.start.sequence,
                  pageStartEventId: page.start.eventId,
                }
              : {}),
            nextSequence: page.next.sequence,
            nextEventId: page.next.eventId,
          }
        : {}),
    });
  const digest = (items: readonly SessionInventoryV2Row[]) =>
    createHash('sha256').update(JSON.stringify(items)).digest('hex');
  const preview = (
    group: SessionInventoryV2Group,
    scope: SessionInventoryScope,
    highWater: number,
    authority: SessionReadAuthority,
    ownerContinuation?: { sequence: number; eventId: string },
  ): SessionInventoryV2Group => {
    if (group.items.length <= 2 && !ownerContinuation) return group;
    if (ownerContinuation && group.items.length <= 2) {
      const continuation = scopeCursor(
        scope,
        group.id,
        highWater,
        digest(group.items),
        group.items.length,
        authority,
        { next: ownerContinuation, size: group.items.length },
      );
      return {
        ...group,
        count: { kind: 'at-least', value: group.items.length + 1 },
        ...(continuation ? { continuation } : {}),
      };
    }
    const continuation = scopeCursor(
      scope,
      group.id,
      highWater,
      digest(group.items),
      2,
      authority,
    );
    return {
      ...group,
      count: { kind: 'at-least', value: group.items.length },
      items: group.items.slice(0, 2),
      ...(continuation ? { continuation } : {}),
    };
  };
  const outputs = async (
    scope: SessionInventoryScope,
    authority: SessionReadAuthority,
    current: () => boolean,
    page = false,
    cursor?: string,
  ): Promise<SessionInventoryV2Group | undefined> => {
    // Same-turn declaration is lineage, not answer support. Until an owner
    // publishes an explicit contribution relation, current-answer exposes none.
    if (scope.kind !== 'whole-session') return gap('outputs');
    let result: Awaited<ReturnType<SessionOutputsModule['list']>>;
    try {
      result = await input.sessionOutputs.list({
        sessionId: scope.sessionId,
        limit: 20,
        ...(cursor ? { cursor } : {}),
        authority,
        current,
      });
    } catch {
      return {
        id: 'outputs',
        owner: owner('station.session-outputs'),
        state: 'unavailable',
        items: [],
        gaps: [{ kind: 'unavailable' }],
      };
    }
    if (!canRead(scope.sessionId, authority, current)) return undefined;
    if (result.status === 'unavailable')
      return {
        id: 'outputs',
        owner: owner('station.session-outputs'),
        state: 'unavailable',
        items: [],
        gaps: [{ kind: 'unavailable' }],
      };
    if (result.status !== 'found') return undefined;
    const items = result.page.items.slice(0, page ? 20 : 2).map((output) => ({
      kind: 'station-session-output' as const,
      key: `output:${output.ref.eventId}`,
      owner: owner('station.session-outputs'),
      relations: ['produced-by'] as const,
      output,
    }));
    return {
      id: 'outputs',
      owner: owner('station.session-outputs'),
      state: items.length ? 'available' : 'empty',
      count: {
        kind: result.page.cursor ? 'at-least' : 'exact',
        value: result.page.items.length,
      },
      items,
      ...(result.page.cursor ? { continuation: result.page.cursor } : {}),
      gaps: [],
    };
  };
  const workItems = (
    scope: SessionInventoryScope,
    authority: SessionReadAuthority,
    current: () => boolean,
    taskWorkItemRef?: string,
  ): SessionInventoryV2Group | undefined => {
    // A current answer is not a conversation-wide observation scope. Work
    // items remain absent until an owner publishes an exact answer edge.
    if (scope.kind === 'current-answer') return gap('work-items');
    if (!input.sessionWorkItems || !input.conversationForSession)
      return gap('work-items');
    try {
      const lineage = input.conversationForSession(scope.sessionId);
      if (!lineage) return gap('work-items');
      const outcome = input.sessionWorkItems.read({
        sessionId: scope.sessionId,
        conversationId: lineage.conversationId,
        authority,
        current,
      });
      if (!canRead(scope.sessionId, authority, current)) return undefined;
      if (outcome.status === 'not-found')
        return gap('work-items', 'restricted');
      if (outcome.status === 'unavailable')
        return gap('work-items', 'unavailable');
      if (outcome.status === 'corrupt') return gap('work-items', 'corrupt');
      const associations = new Map(
        outcome.projection.observations.map((association) => [
          association.associationId,
          association,
        ]),
      );
      const items: SessionInventoryV2Row[] = outcome.projection.items.flatMap(
        (presentation) => {
          const association = associations.get(presentation.associationIds[0]);
          if (!association) return [];
          return [
            {
              kind: 'station-session-work-item' as const,
              key: `work-item:${association.associationId}`,
              owner: owner('station.session-work-items'),
              relations: [
                'observed-during',
                'produced-by',
                ...(scope.kind === 'kept-in-task' &&
                taskWorkItemRef === presentation.workItemRef
                  ? (['kept-in-task'] as const)
                  : []),
              ],
              sessionId: association.sessionId,
              conversationId: association.conversationId,
              eventId: association.eventId,
              turnId: association.turnId,
              toolCallId: association.toolCallId,
              provider: association.provider,
              workItemRef: presentation.workItemRef,
              repository: presentation.repository,
              nativeId: presentation.nativeId,
              associationIds: presentation.associationIds,
              observedAt: presentation.observedAt,
            },
          ];
        },
      );
      // The owner guarantees all association ids resolve. Treat an impossible
      // disagreement as typed corruption instead of dropping a presentation.
      if (items.length !== outcome.projection.items.length)
        return gap('work-items', 'corrupt');
      return {
        id: 'work-items',
        owner: owner('station.session-work-items'),
        state: items.length ? 'available' : 'empty',
        count: { kind: 'exact', value: items.length },
        items,
        gaps: [],
      };
    } catch {
      return gap('work-items', 'unavailable');
    }
  };
  return {
    async read({ scope, authority, current, keptRows, taskWorkItemRef }) {
      if (!canRead(scope.sessionId, authority, current))
        return { status: 'not-found' };
      // A current-answer inventory is an exact Surface Basis view.  Do not
      // publish an unbound legacy fold when runtime composition is absent.
      if (scope.kind === 'current-answer' && !input.readExactAnswerBasis)
        return { status: 'unavailable' };
      // A current-answer projection is addressed by the exact Session/turn
      // tuple.  Do this point read before any owner group so a missing,
      // wrong, or denied turn never degrades into an apparently valid empty
      // inventory (and therefore stays the route's opaque 404).
      let currentAnswer: SessionAnswerBasisQueryOutcome | undefined;
      let exactAnswer:
        | Awaited<ReturnType<ExactAnswerBasisModule['read']>>
        | undefined;
      if (scope.kind === 'current-answer' && input.readExactAnswerBasis) {
        exactAnswer = await input.readExactAnswerBasis({
          sessionId: scope.sessionId,
          turnId: scope.turnId,
          authority,
          current,
        });
        if (!canRead(scope.sessionId, authority, current))
          return { status: 'not-found' };
        if (exactAnswer.status === 'not-found') return { status: 'not-found' };
        if (exactAnswer.status !== 'found') return { status: 'unavailable' };
        currentAnswer = exactAnswer.answer;
      } else if (scope.kind === 'current-answer' && input.readAnswerBasis) {
        currentAnswer = await input.readAnswerBasis(
          scope.sessionId,
          scope.turnId,
          authority,
        );
        if (!canRead(scope.sessionId, authority, current))
          return { status: 'not-found' };
        if (currentAnswer.status === 'not-found')
          return { status: 'not-found' };
        if (currentAnswer.status !== 'found') return { status: 'unavailable' };
      }
      // Sources are deliberately an owner-contract gap at bf501ca. Live now is
      // supplied by native state only, never persisted or inferred here.
      const outputGroup = await outputs(scope, authority, current);
      if (!outputGroup) return { status: 'not-found' };
      const workItemGroup = workItems(
        scope,
        authority,
        current,
        taskWorkItemRef,
      );
      if (!workItemGroup) return { status: 'not-found' };
      if (!canRead(scope.sessionId, authority, current))
        return { status: 'not-found' };
      const snapshotHighWater =
        scope.kind === 'whole-session'
          ? input.readWholeSessionHighWater?.(scope.sessionId)
          : undefined;
      const foldGroups =
        scope.kind === 'current-answer'
          ? [
              [
                'inputs' as const,
                await folded(
                  scope,
                  authority,
                  undefined,
                  undefined,
                  2,
                  undefined,
                  currentAnswer,
                ),
              ] as const,
            ]
          : await Promise.all(
              (['inputs', 'execution', 'decisions', 'resources'] as const).map(
                async (group) =>
                  [
                    group,
                    await folded(scope, authority, snapshotHighWater, group),
                  ] as const,
              ),
            );
      const foldedGroups = Object.assign(
        {},
        ...foldGroups.map(([, result]) => result.groups),
      ) as Partial<Record<SessionInventoryV2GroupId, SessionInventoryV2Group>>;
      const highWater = foldGroups.reduce(
        (current, [, result]) => Math.max(current, result.highWater),
        0,
      );
      const groups = SESSION_INVENTORY_CURRENT_GROUP_IDS.map((id) =>
        id === 'outputs'
          ? outputGroup
          : id === 'work-items'
            ? workItemGroup
            : foldedGroups[id]
              ? foldedGroups[id]
              : id === 'sources'
                ? scope.kind === 'current-answer' &&
                  exactAnswer?.status === 'found'
                  ? (() => {
                      return reviewedSourceSessionInventoryGroup({
                        sessionId: scope.sessionId,
                        turnId: scope.turnId,
                        answerReferenceId:
                          exactAnswer.answer.binding.answer.messageId,
                        contribution: exactAnswer.reviewedSource,
                        basis: exactAnswer.projection,
                      });
                    })()
                  : gap(
                      id,
                      'not-captured',
                      scope.kind === 'kept-in-task'
                        ? 'task-source-provenance-not-captured'
                        : 'session-source-index-not-captured',
                    )
                : id === 'kept' && scope.kind === 'kept-in-task'
                  ? keptRows
                    ? taskKeptGroup(keptRows)
                    : gap(id)
                  : id === 'live-now'
                    ? gap(id)
                    : empty(id),
      );
      const projection = {
        version: SESSION_INVENTORY_VERSION,
        scope,
        groups: groups.map((group) =>
          preview(
            group,
            scope,
            highWater,
            authority,
            foldGroups.find(([id]) => id === group.id)?.[1].continuation,
          ),
        ),
        ...(scope.kind === 'current-answer' && exactAnswer?.status === 'found'
          ? {
              basis: exactAnswer.projection,
              basisBinding: exactAnswer.answer.binding,
            }
          : {}),
      } as SessionInventoryV2Projection;
      return {
        status: 'found',
        projection,
      };
    },
    async page({
      scope,
      groupId,
      continuation,
      authority,
      current,
      keptRows,
      taskWorkItemRef,
    }) {
      if (!canRead(scope.sessionId, authority, current))
        return { status: 'not-found' };
      if (scope.kind === 'current-answer' && !input.readExactAnswerBasis)
        return { status: 'unavailable' };
      let currentAnswer: SessionAnswerBasisQueryOutcome | undefined;
      let exactAnswer:
        | Awaited<ReturnType<ExactAnswerBasisModule['read']>>
        | undefined;
      if (scope.kind === 'current-answer' && input.readExactAnswerBasis) {
        exactAnswer = await input.readExactAnswerBasis({
          sessionId: scope.sessionId,
          turnId: scope.turnId,
          authority,
          current,
        });
        if (!canRead(scope.sessionId, authority, current))
          return { status: 'not-found' };
        if (exactAnswer.status === 'not-found') return { status: 'not-found' };
        if (exactAnswer.status !== 'found') return { status: 'unavailable' };
        currentAnswer = exactAnswer.answer;
      } else if (scope.kind === 'current-answer' && input.readAnswerBasis) {
        currentAnswer = await input.readAnswerBasis(
          scope.sessionId,
          scope.turnId,
          authority,
        );
        if (!canRead(scope.sessionId, authority, current))
          return { status: 'not-found' };
        if (currentAnswer.status === 'not-found')
          return { status: 'not-found' };
        if (currentAnswer.status !== 'found') return { status: 'unavailable' };
      }
      if (groupId === 'outputs') {
        const group = await outputs(
          scope,
          authority,
          current,
          true,
          continuation,
        );
        if (!group || !canRead(scope.sessionId, authority, current))
          return { status: 'not-found' };
        return {
          status: 'found',
          page: {
            version: SESSION_INVENTORY_VERSION,
            scope,
            group,
            ...(scope.kind === 'current-answer' &&
            exactAnswer?.status === 'found'
              ? {
                  basis: exactAnswer.projection,
                  basisBinding: exactAnswer.answer.binding,
                }
              : {}),
          } as SessionInventoryV2GroupPage,
        };
      }
      const cursor = continuation
        ? input.readCursor?.(continuation)
        : undefined;
      const inventoryGroup =
        groupId === 'inputs' ||
        groupId === 'execution' ||
        groupId === 'decisions' ||
        groupId === 'resources'
          ? groupId
          : undefined;
      if (!continuation && inventoryGroup && scope.kind === 'whole-session') {
        const highWater = input.readWholeSessionHighWater?.(scope.sessionId);
        const direct = await folded(
          scope,
          authority,
          highWater,
          inventoryGroup,
          SESSION_INVENTORY_PAGE_MAX_ITEMS,
        );
        const group = direct.groups[groupId] ?? empty(groupId);
        const next = direct.continuation
          ? scopeCursor(
              scope,
              groupId,
              direct.highWater,
              digest(group.items),
              group.items.length,
              authority,
              { next: direct.continuation, size: group.items.length },
            )
          : undefined;
        return {
          status: 'found',
          page: {
            version: SESSION_INVENTORY_VERSION,
            scope,
            group: {
              ...group,
              count: {
                kind: next ? 'at-least' : 'exact',
                value: group.items.length + (next ? 1 : 0),
              },
              ...(next ? { continuation: next } : {}),
            },
          } as SessionInventoryV2GroupPage,
        };
      }
      if (
        cursor?.nextSequence !== undefined &&
        cursor.nextEventId !== undefined &&
        cursor.pageSize !== undefined &&
        inventoryGroup
      ) {
        const priorStart =
          cursor.pageStartSequence === undefined
            ? undefined
            : {
                sequence: cursor.pageStartSequence,
                eventId: cursor.pageStartEventId!,
              };
        const prior = await folded(
          scope,
          authority,
          cursor.highWater,
          inventoryGroup,
          cursor.pageSize,
          priorStart,
        );
        const priorGroup = prior.groups[groupId] ?? empty(groupId);
        if (
          !cursor ||
          cursor.sessionId !== scope.sessionId ||
          cursor.version !== SESSION_INVENTORY_VERSION ||
          cursor.authority !== authorityKey(authority) ||
          cursor.scope !== scope.kind ||
          cursor.groupId !== groupId ||
          cursor.highWater !== prior.highWater ||
          cursor.contentDigest !== digest(priorGroup.items) ||
          prior.continuation?.sequence !== cursor.nextSequence ||
          prior.continuation?.eventId !== cursor.nextEventId
        )
          return { status: 'not-found' };
        const start = {
          sequence: cursor.nextSequence,
          eventId: cursor.nextEventId,
        };
        const nextRead = await folded(
          scope,
          authority,
          cursor.highWater,
          inventoryGroup,
          SESSION_INVENTORY_PAGE_MAX_ITEMS,
          start,
        );
        const nextGroup = nextRead.groups[groupId] ?? empty(groupId);
        const next = nextRead.continuation
          ? scopeCursor(
              scope,
              groupId,
              cursor.highWater,
              digest(nextGroup.items),
              cursor.position + nextGroup.items.length,
              authority,
              {
                start,
                next: nextRead.continuation,
                size: nextGroup.items.length,
              },
            )
          : undefined;
        return {
          status: 'found',
          page: {
            version: SESSION_INVENTORY_VERSION,
            scope,
            group: {
              ...nextGroup,
              count: {
                kind: next ? 'at-least' : 'exact',
                value:
                  cursor.position + nextGroup.items.length + (next ? 1 : 0),
              },
              ...(next ? { continuation: next } : {}),
            },
            ...(scope.kind === 'current-answer' &&
            exactAnswer?.status === 'found'
              ? {
                  basis: exactAnswer.projection,
                  basisBinding: exactAnswer.answer.binding,
                }
              : {}),
          } as SessionInventoryV2GroupPage,
        };
      }
      const directWorkItems =
        groupId === 'work-items'
          ? workItems(scope, authority, current, taskWorkItemRef)
          : undefined;
      if (groupId === 'work-items' && !directWorkItems)
        return { status: 'not-found' };
      const foldedResult = await folded(
        scope,
        authority,
        cursor?.highWater,
        inventoryGroup,
        2,
        undefined,
        currentAnswer,
      );
      const allGroups = foldedResult.groups;
      const whole =
        groupId === 'sources' &&
        scope.kind === 'current-answer' &&
        exactAnswer?.status === 'found'
          ? reviewedSourceSessionInventoryGroup({
              sessionId: scope.sessionId,
              turnId: scope.turnId,
              answerReferenceId: exactAnswer.answer.binding.answer.messageId,
              contribution: exactAnswer.reviewedSource,
              basis: exactAnswer.projection,
            })
          : groupId === 'kept' && scope.kind === 'kept-in-task'
            ? keptRows
              ? taskKeptGroup(keptRows)
              : gap('kept')
            : groupId === 'work-items'
              ? directWorkItems!
              : (allGroups[groupId] ??
                (groupId === 'sources'
                  ? gap(
                      'sources',
                      'not-captured',
                      scope.kind === 'kept-in-task'
                        ? 'task-source-provenance-not-captured'
                        : 'session-source-index-not-captured',
                    )
                  : empty(groupId)));
      const contentDigest = digest(whole.items);
      const highWater = foldedResult.highWater;
      if (!continuation) {
        const items = whole.items.slice(0, SESSION_INVENTORY_PAGE_MAX_ITEMS);
        const next =
          items.length < whole.items.length
            ? scopeCursor(
                scope,
                groupId,
                highWater,
                contentDigest,
                items.length,
                authority,
              )
            : undefined;
        return {
          status: 'found',
          page: {
            version: SESSION_INVENTORY_VERSION,
            scope,
            group: {
              ...whole,
              count: {
                kind: next ? 'at-least' : 'exact',
                value: whole.items.length,
              },
              items,
              ...(next ? { continuation: next } : {}),
            },
            ...(scope.kind === 'current-answer' &&
            exactAnswer?.status === 'found'
              ? {
                  basis: exactAnswer.projection,
                  basisBinding: exactAnswer.answer.binding,
                }
              : {}),
          } as SessionInventoryV2GroupPage,
        };
      }
      if (
        !cursor ||
        cursor.sessionId !== scope.sessionId ||
        cursor.version !== SESSION_INVENTORY_VERSION ||
        cursor.authority !== authorityKey(authority) ||
        cursor.scope !== scope.kind ||
        cursor.taskId !==
          (scope.kind === 'kept-in-task' ? scope.taskId : undefined) ||
        cursor.groupId !== groupId ||
        (scope.kind === 'current-answer' && cursor.turnId !== scope.turnId) ||
        (scope.kind !== 'current-answer' && cursor.turnId !== undefined) ||
        cursor.highWater !== highWater ||
        cursor.contentDigest !== contentDigest
      )
        return { status: 'not-found' };
      if (cursor.position > whole.items.length) return { status: 'not-found' };
      const items = whole.items.slice(
        cursor.position,
        cursor.position + SESSION_INVENTORY_PAGE_MAX_ITEMS,
      );
      const nextOffset = cursor.position + items.length;
      const next =
        nextOffset < whole.items.length
          ? scopeCursor(
              scope,
              groupId,
              highWater,
              contentDigest,
              nextOffset,
              authority,
            )
          : undefined;
      return {
        status: 'found',
        page: {
          version: SESSION_INVENTORY_VERSION,
          scope,
          group: {
            ...whole,
            count: {
              kind: next ? 'at-least' : 'exact',
              value: whole.items.length,
            },
            items,
            ...(next ? { continuation: next } : {}),
          },
          ...(scope.kind === 'current-answer' && exactAnswer?.status === 'found'
            ? {
                basis: exactAnswer.projection,
                basisBinding: exactAnswer.answer.binding,
              }
            : {}),
        } as SessionInventoryV2GroupPage,
      };
    },
  };
}
