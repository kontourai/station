import type { MobileDeviceTarget } from '@kontourai/station-contracts/mobile-device';
import { browserAgentCallerRefusal } from '../../tools/station-control-browser-tools.js';
import type { StationControlCaller } from '../../tools/station-control-shared.js';
import type { BrowserPrincipalAuthorizer } from '../browser/browser-agent-authority.js';
import { type DeviceAccessDeps, mayUseNamedDevice } from './device-shares.js';

export interface DeviceAgentAuthority {
  readonly principalId: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly conversationId: string;
}

export interface DeviceAgentAccessDeps {
  resolveCaller(): StationControlCaller | null;
  agentAccessEnabled(): boolean;
  authorizePrincipal: BrowserPrincipalAuthorizer;
  shares: DeviceAccessDeps['shares'];
  resolveAndroidAvd?: DeviceAccessDeps['resolveAndroidAvd'];
}

/** Re-resolve the verified caller and membership; tool arguments supply no identity. */
export async function authorizeDeviceAgentCaller(deps: DeviceAgentAccessDeps) {
  const caller = deps.resolveCaller();
  const refusal = browserAgentCallerRefusal(caller);
  if (refusal || !caller)
    return { ok: false as const, code: refusal?.code ?? 'caller-required' };
  if (!deps.agentAccessEnabled())
    return { ok: false as const, code: 'agent-access-disabled' };
  const principalId = caller.principal!.id;
  const projectId = caller.localProjectId!;
  const actor = await deps.authorizePrincipal(principalId, projectId);
  if (!actor) return { ok: false as const, code: 'not-authorized' };
  return {
    ok: true as const,
    authority: Object.freeze({
      principalId,
      projectId,
      sessionId: caller.sessionId,
      conversationId: caller.conversationId ?? caller.sessionId,
    }),
    actor,
  };
}

export async function deviceAgentMayAccess(
  deps: DeviceAgentAccessDeps,
  authority: DeviceAgentAuthority,
  target: MobileDeviceTarget,
): Promise<boolean> {
  const fresh = await authorizeDeviceAgentCaller(deps);
  if (
    !fresh.ok ||
    authority.principalId !== fresh.authority.principalId ||
    authority.sessionId !== fresh.authority.sessionId ||
    authority.projectId !== fresh.authority.projectId ||
    authority.conversationId !== fresh.authority.conversationId
  )
    return false;
  return mayUseNamedDevice(
    deps,
    fresh.actor.kind === 'operator'
      ? fresh.actor
      : {
          ...fresh.actor,
          projectId: authority.projectId,
          shares: deps.shares.list(authority.projectId),
        },
    'drive',
    target.platform,
    target.deviceId,
    target.hostId,
  );
}

// Grants never cross the wire. Each targets one device and rechecks the current
// caller, membership and shares on every surface authorization, including input.
const grants = new WeakMap<
  object,
  {
    principalId: string;
    target: MobileDeviceTarget;
    check: () => Promise<boolean>;
  }
>();

export function mintDeviceAgentGrant(
  deps: DeviceAgentAccessDeps,
  authority: DeviceAgentAuthority,
  target: MobileDeviceTarget,
): object {
  const grant = Object.freeze({});
  const selected = { ...target };
  grants.set(grant, {
    principalId: authority.principalId,
    target: selected,
    check: () => deviceAgentMayAccess(deps, authority, selected),
  });
  return grant;
}

export async function deviceAgentGrantAllows(
  grant: object,
  principal: string,
  target: MobileDeviceTarget,
): Promise<boolean> {
  const minted = grants.get(grant);
  return (
    !!minted &&
    minted.principalId === principal &&
    minted.target.hostId === target.hostId &&
    minted.target.platform === target.platform &&
    minted.target.deviceId === target.deviceId &&
    (await minted.check())
  );
}
