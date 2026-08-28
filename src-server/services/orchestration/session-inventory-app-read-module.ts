import { createHash, randomBytes } from 'node:crypto';
import {
  SESSION_INVENTORY_GROUP_IDS,
  type SessionInventoryGroupId,
  type SessionInventoryGroupPage,
  type SessionInventoryProjection,
  type SessionInventoryScope,
} from '@kontourai/station-contracts/session-inventory';
import {
  buildStationSessionInventoryMcpEnvelope,
  buildStationSessionInventoryMcpGroupPageEnvelope,
  parseStationSessionInventoryMcpEnvelope,
  type StationSessionInventoryMcpEnvelope,
} from '@kontourai/station-contracts/session-inventory-mcp';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';

export const SESSION_INVENTORY_APP_READ_TTL_MS = 5 * 60_000;
export const SESSION_INVENTORY_APP_READ_MAX_SESSIONS = 128;
export const SESSION_INVENTORY_APP_READ_MAX_PER_CALLER = 16;
export const SESSION_INVENTORY_APP_READ_MAX_RATE_CALLERS = 128;
export const SESSION_INVENTORY_APP_READ_MAX_PAGES = 128;

const RATE_WINDOW_MS = 60_000;
const MAX_CALLER_READS_PER_WINDOW = 64;

export type SessionInventoryAppRouteFamily = 'orchestration' | 'task';
export type SessionInventoryAppContinuation = {
  groupId: SessionInventoryGroupId;
  continuationToken: string;
};
export type SessionInventoryAppReadOutcome =
  | {
      status: 'available';
      occurrenceId: string;
      data: StationSessionInventoryMcpEnvelope;
      continuations: readonly SessionInventoryAppContinuation[];
    }
  | { status: 'unavailable' };

export interface SessionInventoryAppReadModule {
  open(
    input: SessionInventoryAppReadInput,
  ): Promise<SessionInventoryAppReadOutcome>;
  page(
    input: SessionInventoryAppReadInput & {
      occurrenceId: string;
      groupId: SessionInventoryGroupId;
      continuationToken: string;
    },
  ): Promise<SessionInventoryAppReadOutcome>;
  revoke(input: {
    scope?: SessionInventoryScope;
    routeFamily: SessionInventoryAppRouteFamily;
    callerBinding?: string;
    occurrenceId?: string;
  }): void;
}

export type SessionInventoryAppReadInput = {
  scope: SessionInventoryScope;
  routeFamily: SessionInventoryAppRouteFamily;
  callerBinding: string;
  authority: SessionReadAuthority;
  request?: Request;
};

type State = {
  scope: SessionInventoryScope;
  scopeKey: string;
  routeFamily: SessionInventoryAppRouteFamily;
  callerBinding: string;
  authorityFingerprint: string;
  occurrenceId: string;
  expiresAt: number;
  pages: number;
  inFlight: boolean;
  revoked: boolean;
  continuations: Map<
    SessionInventoryGroupId,
    { token: string; cursor: string }
  >;
};

/**
 * One bounded app-read occurrence. It stores only opaque continuation control
 * state; every projection and page is re-authorized from its owning module.
 */
export function createSessionInventoryAppReadModule(input: {
  read(input: {
    scope: SessionInventoryScope;
    authority: SessionReadAuthority;
    request?: Request;
    current: () => boolean;
  }): Promise<
    | { status: 'found'; projection: SessionInventoryProjection }
    | { status: 'not-found' | 'unavailable' }
  >;
  page(input: {
    scope: SessionInventoryScope;
    groupId: SessionInventoryGroupId;
    continuation: string;
    authority: SessionReadAuthority;
    request?: Request;
    current: () => boolean;
  }): Promise<
    | { status: 'found'; page: SessionInventoryGroupPage }
    | { status: 'not-found' | 'unavailable' }
  >;
  /** Replays the route family's exact principal, ACL, and Task witnesses. */
  authorize(input: {
    scope: SessionInventoryScope;
    routeFamily: SessionInventoryAppRouteFamily;
    authority: SessionReadAuthority;
    request?: Request;
  }): boolean;
  isEnabled: () => boolean | Promise<boolean>;
  now?: () => number;
}): SessionInventoryAppReadModule {
  const sessions = new Map<string, State>();
  const rates = new Map<string, { startedAt: number; count: number }>();
  const now = input.now ?? Date.now;
  const unavailable = (): SessionInventoryAppReadOutcome => ({
    status: 'unavailable',
  });
  const current = (
    state: State,
    authority: SessionReadAuthority,
    request?: Request,
  ) =>
    !state.revoked &&
    state.expiresAt > now() &&
    input.authorize({
      scope: state.scope,
      routeFamily: state.routeFamily,
      authority,
      request,
    });
  const terminate = (state: State) => {
    state.revoked = true;
    sessions.delete(state.occurrenceId);
  };
  const purge = () => {
    const at = now();
    for (const state of sessions.values())
      if (state.expiresAt <= at || state.revoked) terminate(state);
  };
  const takeRate = (callerBinding: string) => {
    const at = now();
    for (const [key, value] of rates)
      if (at - value.startedAt >= RATE_WINDOW_MS) rates.delete(key);
    if (
      !rates.has(callerBinding) &&
      rates.size >= SESSION_INVENTORY_APP_READ_MAX_RATE_CALLERS
    )
      rates.delete(rates.keys().next().value!);
    const previous = rates.get(callerBinding);
    const next =
      !previous || at - previous.startedAt >= RATE_WINDOW_MS
        ? { startedAt: at, count: 1 }
        : { ...previous, count: previous.count + 1 };
    rates.set(callerBinding, next);
    return next.count <= MAX_CALLER_READS_PER_WINDOW;
  };
  const continuations = (state: State): SessionInventoryAppContinuation[] =>
    [...state.continuations.entries()].map(([groupId, value]) => ({
      groupId,
      continuationToken: value.token,
    }));
  const captureContinuations = (
    state: State,
    groups: readonly { id: SessionInventoryGroupId; continuation?: string }[],
  ) => {
    state.continuations.clear();
    for (const group of groups)
      if (typeof group.continuation === 'string' && group.continuation.length) {
        state.continuations.set(group.id, {
          token: mint(),
          cursor: group.continuation,
        });
      }
  };
  const renderOpen = async (
    state: State,
    authority: SessionReadAuthority,
    request?: Request,
  ): Promise<SessionInventoryAppReadOutcome> => {
    if (state.inFlight || !current(state, authority, request))
      return unavailable();
    state.inFlight = true;
    try {
      if (!(await input.isEnabled()) || !current(state, authority, request)) {
        terminate(state);
        return unavailable();
      }
      // A first result is never publishable: authorizing before and after the
      // owner I/O prevents a principal/ACL epoch from crossing this response.
      const first = await input.read({
        scope: state.scope,
        authority,
        request,
        current: () => current(state, authority, request),
      });
      if (
        first.status !== 'found' ||
        !(await input.isEnabled()) ||
        !current(state, authority, request)
      ) {
        terminate(state);
        return unavailable();
      }
      const second = await input.read({
        scope: state.scope,
        authority,
        request,
        current: () => current(state, authority, request),
      });
      if (
        second.status !== 'found' ||
        !current(state, authority, request) ||
        fingerprintProjection(first.projection) !==
          fingerprintProjection(second.projection)
      ) {
        terminate(state);
        return unavailable();
      }
      const envelope = buildStationSessionInventoryMcpEnvelope(
        second.projection,
      );
      if (!envelope || !parseStationSessionInventoryMcpEnvelope(envelope)) {
        terminate(state);
        return unavailable();
      }
      captureContinuations(state, second.projection.groups);
      state.pages += 1;
      state.expiresAt = now() + SESSION_INVENTORY_APP_READ_TTL_MS;
      return {
        status: 'available',
        occurrenceId: state.occurrenceId,
        data: envelope,
        continuations: continuations(state),
      };
    } catch {
      terminate(state);
      return unavailable();
    } finally {
      state.inFlight = false;
    }
  };
  const renderPage = async (
    state: State,
    authority: SessionReadAuthority,
    request: Request | undefined,
    groupId: SessionInventoryGroupId,
    continuationToken: string,
  ): Promise<SessionInventoryAppReadOutcome> => {
    const continuation = state.continuations.get(groupId);
    if (
      state.inFlight ||
      !continuation ||
      continuation.token !== continuationToken ||
      state.pages >= SESSION_INVENTORY_APP_READ_MAX_PAGES ||
      !current(state, authority, request)
    )
      return unavailable();
    state.inFlight = true;
    try {
      if (!(await input.isEnabled()) || !current(state, authority, request)) {
        terminate(state);
        return unavailable();
      }
      const first = await input.page({
        scope: state.scope,
        groupId,
        continuation: continuation.cursor,
        authority,
        request,
        current: () => current(state, authority, request),
      });
      if (
        first.status !== 'found' ||
        !(await input.isEnabled()) ||
        !current(state, authority, request)
      ) {
        terminate(state);
        return unavailable();
      }
      const second = await input.page({
        scope: state.scope,
        groupId,
        continuation: continuation.cursor,
        authority,
        request,
        current: () => current(state, authority, request),
      });
      if (
        second.status !== 'found' ||
        !current(state, authority, request) ||
        fingerprintPage(first.page) !== fingerprintPage(second.page)
      ) {
        terminate(state);
        return unavailable();
      }
      const page = second.page;
      const envelope = buildStationSessionInventoryMcpGroupPageEnvelope(page);
      if (
        !envelope ||
        !parseStationSessionInventoryMcpEnvelope(envelope) ||
        page.scope.kind !== state.scope.kind ||
        page.group.id !== groupId
      ) {
        terminate(state);
        return unavailable();
      }
      state.continuations.delete(groupId);
      if (page.group.continuation) {
        state.continuations.set(groupId, {
          token: mint(),
          cursor: page.group.continuation,
        });
      }
      state.pages += 1;
      state.expiresAt = now() + SESSION_INVENTORY_APP_READ_TTL_MS;
      return {
        status: 'available',
        occurrenceId: state.occurrenceId,
        data: envelope,
        continuations: continuations(state),
      };
    } catch {
      terminate(state);
      return unavailable();
    } finally {
      state.inFlight = false;
    }
  };
  return {
    async open({ scope, routeFamily, callerBinding, authority, request }) {
      purge();
      if (
        authority.mode === 'hosted' ||
        !validScope(scope) ||
        !validBinding(callerBinding) ||
        !takeRate(callerBinding) ||
        sessions.size >= SESSION_INVENTORY_APP_READ_MAX_SESSIONS ||
        [...sessions.values()].filter(
          (state) => state.callerBinding === callerBinding,
        ).length >= SESSION_INVENTORY_APP_READ_MAX_PER_CALLER
      )
        return unavailable();
      const state: State = {
        scope,
        scopeKey: JSON.stringify(scope),
        routeFamily,
        callerBinding,
        authorityFingerprint: fingerprintAuthority(authority),
        occurrenceId: mint(),
        expiresAt: now() + SESSION_INVENTORY_APP_READ_TTL_MS,
        pages: 0,
        inFlight: false,
        revoked: false,
        continuations: new Map(),
      };
      sessions.set(state.occurrenceId, state); // Reserve before owner I/O.
      return renderOpen(state, authority, request);
    },
    async page({
      scope,
      routeFamily,
      occurrenceId,
      groupId,
      continuationToken,
      callerBinding,
      authority,
      request,
    }) {
      purge();
      const state = sessions.get(occurrenceId);
      if (
        authority.mode === 'hosted' ||
        !validScope(scope) ||
        !validBinding(callerBinding) ||
        !validToken(occurrenceId) ||
        !validToken(continuationToken) ||
        !SESSION_INVENTORY_GROUP_IDS.includes(groupId) ||
        !takeRate(callerBinding) ||
        !state ||
        state.revoked ||
        state.inFlight ||
        state.scopeKey !== JSON.stringify(scope) ||
        state.routeFamily !== routeFamily ||
        state.callerBinding !== callerBinding ||
        state.authorityFingerprint !== fingerprintAuthority(authority)
      )
        return unavailable();
      return renderPage(state, authority, request, groupId, continuationToken);
    },
    revoke({ scope, routeFamily, callerBinding, occurrenceId }) {
      for (const state of sessions.values())
        if (
          (scope === undefined || state.scopeKey === JSON.stringify(scope)) &&
          state.routeFamily === routeFamily &&
          (!callerBinding || state.callerBinding === callerBinding) &&
          (!occurrenceId || state.occurrenceId === occurrenceId)
        )
          terminate(state);
    },
  };
}

function mint() {
  return randomBytes(24).toString('base64url');
}
function validToken(value: string) {
  return /^[A-Za-z0-9_-]{24,128}$/.test(value);
}
function validBinding(value: string) {
  return /^[A-Za-z0-9_-]{20,256}$/.test(value);
}
function validScope(scope: SessionInventoryScope) {
  return (
    typeof scope.sessionId === 'string' &&
    scope.sessionId.length > 0 &&
    (scope.kind !== 'current-answer' ||
      (typeof scope.turnId === 'string' && scope.turnId.length > 0)) &&
    (scope.kind !== 'kept-in-task' ||
      (typeof scope.taskId === 'string' && scope.taskId.length > 0))
  );
}
function fingerprintAuthority(authority: SessionReadAuthority) {
  return createHash('sha256')
    .update(JSON.stringify(authority))
    .digest('base64url');
}
function fingerprintProjection(value: SessionInventoryProjection) {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url');
}
function fingerprintPage(value: SessionInventoryGroupPage) {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url');
}
