/**
 * Private, server-owned authority for explicitly declared native outputs.
 * It deliberately carries no model-visible fields and is not a replacement
 * for AuthorizedTurnCorrelation: callers receive an opaque grant only while
 * executing an already-authorized native turn.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { types } from 'node:util';
import {
  isPrincipalRef,
  type PrincipalRef,
} from '@kontourai/station-contracts/principal';
import {
  createNativeExecutionWorkspace,
  type NativeExecutionWorkspace,
  NativeExecutionWorkspaceUnavailableError,
} from './conversation/native-execution-workspace.js';
import type { NativeOutputDeclarationOperation } from './native-output-declaration.js';

declare const nativeOutputGrantBrand: unique symbol;
declare const nativeOutputCallBrand: unique symbol;

export type NativeOutputTurnGrant = Readonly<{
  readonly [nativeOutputGrantBrand]: true;
}>;
export type NativeOutputCallScope = Readonly<{
  readonly [nativeOutputCallBrand]: true;
}>;

export interface NativeOutputGrantFacts {
  threadId: string;
  turnId: string;
  principal: PrincipalRef;
  tenantId?: string;
  adapterId: string;
  configurationLease: unknown;
  /** Server-resolved workspace binding; never exposed through model inputs. */
  workspaceRoot?: string;
}

/** Opaque owner lease. Only literal synchronous true keeps a grant usable. */
export interface NativeOutputTurnLease {
  isCurrent(): boolean;
}

export interface NativeOutputCallFacts extends NativeOutputGrantFacts {
  callId: string;
}

export interface NativeOutputGrantAuthority {
  issue(
    facts: NativeOutputGrantFacts,
    lease: NativeOutputTurnLease,
  ): NativeOutputTurnGrant | null;
  bindNativeCall(
    grant: NativeOutputTurnGrant,
    callId: string,
  ): NativeOutputCallScope | null;
  /** Stream completion only closes new declarations; it never revokes a use awaiting durable terminal commit. */
  closeIssuance(grant: NativeOutputTurnGrant): void;
  revoke(grant: NativeOutputTurnGrant): void;
  admit(scope: NativeOutputCallScope): NativeOutputCallFacts | null;
  dispose(): void;
  retireTerminal(threadId: string, turnId: string): void;
}

/** Process-local relay capability; it never crosses a JSON or public seam. */
export interface NativeOutputRelayCompanion {
  /** Private captured location; independent of optional output-declaration grants. */
  readonly workspaceRequired?: boolean;
  readExecutionWorkspace?(
    threadId: unknown,
  ): NativeExecutionWorkspace | undefined;
  issueForRuntimeConfiguration(
    configurationLease: unknown,
    runtimeConfigurationLeaseIsCurrent: () => boolean,
  ): NativeOutputTurnContext | null;
}

export interface NativeOutputTurnContext {
  readonly grant: NativeOutputTurnGrant;
  readonly authority: NativeOutputGrantAuthority;
  /** Private companion used only by the native declaration tool. */
  readonly declarationOperation?: NativeOutputDeclarationOperation;
}

const nativeOutputTurnGrants = new AsyncLocalStorage<NativeOutputTurnContext>();
const nativeOutputCallScopes = new AsyncLocalStorage<NativeOutputCallScope>();
const nativeOutputRelayCompanions =
  new AsyncLocalStorage<NativeOutputRelayCompanion>();

export function runWithNativeOutputRelayCompanion<T>(
  companion: NativeOutputRelayCompanion,
  work: () => T,
): T {
  return nativeOutputRelayCompanions.run(companion, work);
}

export function currentNativeOutputRelayCompanion():
  | NativeOutputRelayCompanion
  | undefined {
  return nativeOutputRelayCompanions.getStore();
}

export function runWithNativeOutputTurnContext<T>(
  context: NativeOutputTurnContext,
  work: () => T,
): T {
  return nativeOutputTurnGrants.run(context, work);
}

/** Stream completion closes new bindings but preserves already-bound scopes. */
export function closeNativeOutputTurnContext(
  context: NativeOutputTurnContext,
): void {
  context.authority.closeIssuance(context.grant);
}

/** Only server-owned declaration code can read this private capability. */
export function currentNativeOutputCallScope():
  | NativeOutputCallScope
  | undefined {
  return nativeOutputCallScopes.getStore();
}

/** Private companion for the dedicated native declaration tool only. */
export function currentNativeOutputDeclarationOperation():
  | NativeOutputDeclarationOperation
  | undefined {
  return nativeOutputTurnGrants.getStore()?.declarationOperation;
}

/** Native SDK wrappers bind genuine callback ids; all other inputs get no scope. */
export function runWithCurrentNativeOutputCall<T>(
  callId: unknown,
  work: () => T,
): T {
  if (typeof callId !== 'string' || callId.length === 0) return work();
  const turn = nativeOutputTurnGrants.getStore();
  const scope = turn ? turn.authority.bindNativeCall(turn.grant, callId) : null;
  return scope ? nativeOutputCallScopes.run(scope, work) : work();
}

type GrantState = NativeOutputGrantFacts & {
  issuanceOpen: boolean;
  revoked: boolean;
  calls: Set<string>;
  checker: CapturedLeaseChecker;
};

type CapturedFacts = {
  threadId: unknown;
  turnId: unknown;
  principal: unknown;
  tenantId: unknown;
  adapterId: unknown;
  configurationLease: unknown;
  workspaceRoot: unknown;
};

type CapturedLeaseChecker = {
  receiver: unknown;
  isCurrent: () => unknown;
};

type ProvisionalReservation = {
  cancelled: boolean;
};

type OwnDataValue = {
  found: boolean;
  value: unknown;
};

const boundedId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024;
const MAX_ACTIVE_GRANTS = 256;
const MAX_CALLS_PER_GRANT = 256;
const captureLeaseChecker = (lease: unknown): CapturedLeaseChecker | null => {
  try {
    if (
      (typeof lease !== 'object' && typeof lease !== 'function') ||
      lease === null
    ) {
      return null;
    }
    const isCurrent = (lease as NativeOutputTurnLease).isCurrent;
    return typeof isCurrent === 'function'
      ? { receiver: lease, isCurrent: isCurrent as () => unknown }
      : null;
  } catch {
    return null;
  }
};
const current = (checker: CapturedLeaseChecker): boolean => {
  try {
    return Reflect.apply(checker.isCurrent, checker.receiver, []) === true;
  } catch {
    return false;
  }
};
const ownDataValue = (value: object, key: string): OwnDataValue | null => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return { found: false, value: undefined };
  if (!('value' in descriptor) || !descriptor.enumerable) return null;
  return { found: true, value: descriptor.value };
};
const copyPrincipal = (value: unknown): PrincipalRef | null => {
  try {
    if (
      typeof value !== 'object' ||
      value === null ||
      types.isProxy(value) ||
      Array.isArray(value)
    )
      return null;
    // Snapshot only own data descriptors. This neither invokes caller-owned
    // accessors nor reads a proxy-backed identity twice before validation.
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== 3 ||
      keys.some(
        (key) =>
          typeof key !== 'string' || !['id', 'kind', 'display'].includes(key),
      )
    )
      return null;
    const id = descriptors.id;
    const kind = descriptors.kind;
    const display = descriptors.display;
    if (
      !id ||
      !kind ||
      !display ||
      !('value' in id) ||
      !('value' in kind) ||
      !('value' in display) ||
      !id.enumerable ||
      !kind.enumerable ||
      !display.enumerable
    )
      return null;
    const snapshot = { id: id.value, kind: kind.value, display: display.value };
    if (!isPrincipalRef(snapshot)) return null;
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
};
const captureFacts = (facts: unknown): CapturedFacts | null => {
  try {
    if (
      (typeof facts !== 'object' && typeof facts !== 'function') ||
      facts === null ||
      types.isProxy(facts) ||
      Array.isArray(facts)
    )
      return null;
    const input = facts as object;
    const threadId = ownDataValue(input, 'threadId');
    const turnId = ownDataValue(input, 'turnId');
    const principal = ownDataValue(input, 'principal');
    const tenantId = ownDataValue(input, 'tenantId');
    const adapterId = ownDataValue(input, 'adapterId');
    const configurationLease = ownDataValue(input, 'configurationLease');
    const workspaceRoot = ownDataValue(input, 'workspaceRoot');
    if (
      !threadId?.found ||
      !turnId?.found ||
      !principal?.found ||
      !adapterId?.found ||
      !configurationLease?.found ||
      !tenantId
    )
      return null;
    return {
      threadId: threadId.value,
      turnId: turnId.value,
      principal: principal.value,
      tenantId: tenantId.value,
      adapterId: adapterId.value,
      configurationLease: configurationLease.value,
      workspaceRoot: workspaceRoot?.value,
    };
  } catch {
    return null;
  }
};

/**
 * Combines dispatch-time authority with the current runtime configuration.
 * The principal is retained as attribution only; `sourceLease` is the live
 * authorization, adapter, lifecycle, and generation fence.
 */
export function createNativeOutputRelayCompanion(input: {
  workspaceRequired?: boolean;
  authority: NativeOutputGrantAuthority;
  facts: Omit<NativeOutputGrantFacts, 'configurationLease'>;
  sourceLease: NativeOutputTurnLease;
  declarationOperation?: NativeOutputDeclarationOperation;
}): NativeOutputRelayCompanion | null {
  const captured = captureFacts({ ...input.facts, configurationLease: null });
  const principal = captured && copyPrincipal(captured.principal);
  const sourceChecker = captureLeaseChecker(input.sourceLease);
  if (!captured || !principal || !sourceChecker) return null;
  const workspaceRequired = input.workspaceRequired === true;
  return Object.freeze({
    workspaceRequired,
    readExecutionWorkspace(threadId: unknown) {
      if (threadId !== captured.threadId || !current(sourceChecker))
        throw new NativeExecutionWorkspaceUnavailableError();
      if (
        typeof captured.workspaceRoot !== 'string' ||
        !captured.workspaceRoot
      ) {
        if (workspaceRequired)
          throw new NativeExecutionWorkspaceUnavailableError();
        return undefined;
      }
      return createNativeExecutionWorkspace(captured.workspaceRoot);
    },
    issueForRuntimeConfiguration(
      configurationLease: unknown,
      isConfigurationCurrent: () => boolean,
    ) {
      if (typeof isConfigurationCurrent !== 'function') return null;
      const grant = input.authority.issue(
        {
          threadId: captured.threadId as string,
          turnId: captured.turnId as string,
          principal,
          ...(captured.tenantId === undefined
            ? {}
            : { tenantId: captured.tenantId as string }),
          adapterId: captured.adapterId as string,
          configurationLease,
          ...(typeof captured.workspaceRoot === 'string'
            ? { workspaceRoot: captured.workspaceRoot }
            : {}),
        },
        {
          isCurrent: () =>
            current(sourceChecker) && isConfigurationCurrent() === true,
        },
      );
      return grant
        ? Object.freeze({
            grant,
            authority: input.authority,
            ...(input.declarationOperation
              ? { declarationOperation: input.declarationOperation }
              : {}),
          })
        : null;
    },
  });
}

/** Factory-only state prevents post-construction authority injection. */
export function createNativeOutputGrantAuthority(): NativeOutputGrantAuthority {
  const grants = new WeakMap<object, GrantState>();
  const calls = new WeakMap<object, { grant: object; callId: string }>();
  const byTurn = new Map<string, Set<object>>();
  const reservations = new Map<string, ProvisionalReservation>();
  let disposed = false;
  let activeGrants = 0;
  let pendingReservations = 0;
  const key = (threadId: string, turnId: string) =>
    `${threadId.length}:${threadId}\u0000${turnId.length}:${turnId}`;
  const release = (grant: object, state: GrantState) => {
    if (state.revoked) return;
    state.revoked = true;
    state.calls.clear();
    activeGrants -= 1;
    const turnKey = key(state.threadId, state.turnId);
    const pending = byTurn.get(turnKey);
    pending?.delete(grant);
    if (pending?.size === 0) byTurn.delete(turnKey);
  };
  const releaseReservation = (
    turnKey: string,
    reservation: ProvisionalReservation,
  ) => {
    if (reservations.get(turnKey) !== reservation) return;
    reservations.delete(turnKey);
    pendingReservations -= 1;
  };
  const reservationIsCurrent = (
    turnKey: string,
    reservation: ProvisionalReservation,
  ) => reservations.get(turnKey) === reservation && !reservation.cancelled;

  return {
    issue(facts, lease) {
      // Every fact, including the opaque configuration lease identity, is
      // captured before the owner callback below can reenter or mutate input.
      const captured = captureFacts(facts);
      const principal = captured && copyPrincipal(captured.principal);
      if (
        !captured ||
        !principal ||
        !boundedId(captured.threadId) ||
        !boundedId(captured.turnId) ||
        !boundedId(captured.adapterId) ||
        (captured.tenantId !== undefined && !boundedId(captured.tenantId)) ||
        (captured.workspaceRoot !== undefined &&
          (typeof captured.workspaceRoot !== 'string' ||
            captured.workspaceRoot.length === 0 ||
            captured.workspaceRoot.length > 4096)) ||
        disposed ||
        activeGrants + pendingReservations >= MAX_ACTIVE_GRANTS
      )
        return null;
      const turnKey = key(captured.threadId, captured.turnId);
      if (byTurn.has(turnKey) || reservations.has(turnKey)) return null;
      // Reserve exact identity before any owner-controlled lease property is
      // accessed, so a reentrant terminal retirement cancels this issuance.
      const reservation = { cancelled: false };
      reservations.set(turnKey, reservation);
      pendingReservations += 1;
      const failReservation = () => {
        releaseReservation(turnKey, reservation);
        return null;
      };
      const checker = captureLeaseChecker(lease);
      if (!checker) return failReservation();
      // Capturing the owner-controlled property can itself reenter.
      if (
        !reservationIsCurrent(turnKey, reservation) ||
        disposed ||
        activeGrants + pendingReservations > MAX_ACTIVE_GRANTS ||
        byTurn.has(turnKey)
      )
        return failReservation();
      if (!current(checker)) return failReservation();
      // isCurrent is owner code: it may dispose this authority or create or
      // retire a competing exact turn while it runs.
      if (
        !reservationIsCurrent(turnKey, reservation) ||
        disposed ||
        activeGrants + pendingReservations > MAX_ACTIVE_GRANTS ||
        byTurn.has(turnKey)
      )
        return failReservation();
      const token = {} as NativeOutputTurnGrant;
      grants.set(token, {
        threadId: captured.threadId,
        turnId: captured.turnId,
        principal,
        ...(captured.tenantId === undefined
          ? {}
          : { tenantId: captured.tenantId }),
        adapterId: captured.adapterId,
        configurationLease: captured.configurationLease,
        ...(typeof captured.workspaceRoot === 'string'
          ? { workspaceRoot: captured.workspaceRoot }
          : {}),
        issuanceOpen: true,
        revoked: false,
        calls: new Set(),
        checker,
      });
      const pending = new Set<object>();
      pending.add(token);
      byTurn.set(turnKey, pending);
      activeGrants += 1;
      releaseReservation(turnKey, reservation);
      return token;
    },
    bindNativeCall(grant, callId) {
      if (disposed || !boundedId(callId)) return null;
      const state = grants.get(grant);
      if (
        !state ||
        state.revoked ||
        !state.issuanceOpen ||
        state.calls.size >= MAX_CALLS_PER_GRANT ||
        state.calls.has(callId) ||
        !current(state.checker)
      )
        return null;
      if (
        disposed ||
        state.revoked ||
        !state.issuanceOpen ||
        state.calls.size >= MAX_CALLS_PER_GRANT ||
        state.calls.has(callId)
      )
        return null;
      state.calls.add(callId);
      const scope = {} as NativeOutputCallScope;
      calls.set(scope, { grant, callId });
      return scope;
    },
    closeIssuance(grant) {
      const state = grants.get(grant);
      if (state) state.issuanceOpen = false;
    },
    revoke(grant) {
      const state = grants.get(grant);
      if (state) release(grant, state);
    },
    admit(scope) {
      if (disposed) return null;
      const bound = calls.get(scope);
      const state = bound ? grants.get(bound.grant) : undefined;
      if (
        !state ||
        state.revoked ||
        !state.calls.has(bound!.callId) ||
        !current(state.checker)
      )
        return null;
      if (disposed || state.revoked || !state.calls.has(bound!.callId))
        return null;
      return Object.freeze({
        threadId: state.threadId,
        turnId: state.turnId,
        callId: bound!.callId,
        principal: Object.freeze({ ...state.principal }),
        ...(state.tenantId === undefined ? {} : { tenantId: state.tenantId }),
        adapterId: state.adapterId,
        configurationLease: state.configurationLease,
        ...(state.workspaceRoot === undefined
          ? {}
          : { workspaceRoot: state.workspaceRoot }),
      });
    },
    retireTerminal(threadId, turnId) {
      const turnKey = key(threadId, turnId);
      const reservation = reservations.get(turnKey);
      if (reservation) reservation.cancelled = true;
      const pending = byTurn.get(turnKey);
      if (!pending) return;
      for (const grant of pending) {
        const state = grants.get(grant);
        if (state) release(grant, state);
      }
      byTurn.delete(turnKey);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const reservation of reservations.values())
        reservation.cancelled = true;
      for (const pending of byTurn.values()) {
        for (const grant of pending) {
          const state = grants.get(grant);
          if (state && !state.revoked) {
            state.revoked = true;
            state.calls.clear();
          }
        }
      }
      byTurn.clear();
      activeGrants = 0;
    },
  };
}
