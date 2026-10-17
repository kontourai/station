import type { LiveSurfaceInput } from '@kontourai/station-contracts/live-surface';
import type {
  MobileDeviceSummary,
  MobileDeviceTarget,
} from '@kontourai/station-contracts/mobile-device';
import {
  claimAgentControl,
  dispatchAgentInput,
  type LiveSurfaceRegistry,
} from '../live-surface/registry.js';
import type { LocalMobileDeviceHost } from '../mobile-device/mobile-device-host.js';
import {
  authorizeDeviceAgentCaller,
  type DeviceAgentAccessDeps,
  type DeviceAgentAuthority,
  deviceAgentMayAccess,
  mintDeviceAgentGrant,
} from './device-agent-authority.js';
import type { DeviceSessionService } from './device-session-service.js';
import type { DeviceToolsService } from './device-tools.js';

interface DeviceAutomationDeps {
  host: Pick<LocalMobileDeviceHost, 'inventory' | 'capture'>;
  sessions: DeviceSessionService;
  surfaces: Pick<LiveSurfaceRegistry, 'get'>;
  tools: Pick<DeviceToolsService, 'accessibility'>;
}
const ownerKey = (authority: DeviceAgentAuthority) =>
  JSON.stringify([
    authority.principalId,
    authority.projectId,
    authority.conversationId,
  ]);
const refused = (code: string) => ({ ok: false as const, code });

/** Local-device agent path. All input uses the existing allowlisted hub producer. */
export class DeviceAutomation {
  private readonly owners = new Map<string, string>();
  constructor(private readonly deps: DeviceAutomationDeps) {}

  async list(access: DeviceAgentAccessDeps, authority: DeviceAgentAuthority) {
    const standing = await authorizeDeviceAgentCaller(access);
    if (
      !standing.ok ||
      (standing.actor.kind !== 'operator' &&
        access.shares.list(authority.projectId).length === 0)
    )
      return refused('not-authorized');
    for (const id of this.owners.keys())
      if (!this.deps.sessions.get(id)) this.owners.delete(id);
    const inventory = await this.deps.host.inventory();
    if (inventory.state === 'unavailable')
      return {
        ...refused(inventory.failure ?? 'hub-unavailable'),
        hosts: [{ hostId: 'local', state: inventory.state }],
      };
    const devices: MobileDeviceSummary[] = [];
    for (const device of this.deps.sessions.withStartingRows(
      inventory.devices,
    )) {
      if (await deviceAgentMayAccess(access, authority, device))
        devices.push(device);
    }
    const sessions = this.deps.sessions
      .list()
      .filter(
        (session) =>
          this.owners.get(session.sessionId) === ownerKey(authority) &&
          devices.some(
            (device) =>
              device.platform === session.platform &&
              device.deviceId === session.deviceId,
          ),
      )
      .map((session) => ({
        ...session,
        lease: this.deps.surfaces.get(session.surfaceId)?.lease.snapshot(),
      }));
    return {
      ok: true,
      hosts: [{ hostId: 'local', state: inventory.state }],
      devices,
      sessions,
    };
  }

  async open(
    access: DeviceAgentAccessDeps,
    authority: DeviceAgentAuthority,
    target: MobileDeviceTarget,
  ) {
    if (!(await deviceAgentMayAccess(access, authority, target)))
      return refused('not-authorized');
    const started = await this.deps.sessions.start(target, () =>
      deviceAgentMayAccess(access, authority, target),
    );
    if (started.state === 'starting') return { ok: true, ...started };
    const session = await this.deps.sessions.open(
      target,
      () => deviceAgentMayAccess(access, authority, target),
      (created) => this.owners.set(created.sessionId, ownerKey(authority)),
    );
    const selected = await this.claim(access, authority, session.sessionId);
    if (!selected.ok) return selected;
    return {
      ok: true,
      session,
      lease: selected.lease,
      paneRevealed: false,
      instructions:
        'Open Device in the pane chooser and select this local device to watch. Use device_input with deviceSessionId and events (surface pixel coordinates), device_snapshot for accessibility, and device_screenshot for PNG. Human takeover interrupts input.',
    };
  }

  private async claim(
    access: DeviceAgentAccessDeps,
    authority: DeviceAgentAuthority,
    id: string,
  ) {
    const session = this.deps.sessions.get(id);
    if (!session || !(await deviceAgentMayAccess(access, authority, session)))
      return refused('not-authorized');
    const entry = this.deps.surfaces.get(session.surfaceId);
    if (!entry) return refused('unknown-session');
    const agent = {
      kind: 'agent' as const,
      principal: authority.principalId,
      sessionId: authority.sessionId,
    };
    const context = {
      agentGrant: mintDeviceAgentGrant(access, authority, session),
    };
    const claim = await claimAgentControl(
      entry,
      agent,
      authority.principalId,
      context,
    );
    if (!claim.ok) return claim;
    this.deps.sessions.noteAgentActivity(id);
    return {
      ok: true as const,
      session,
      entry,
      agent,
      context,
      lease: claim.lease,
    };
  }

  async input(
    access: DeviceAgentAccessDeps,
    authority: DeviceAgentAuthority,
    id: string,
    events: readonly LiveSurfaceInput[],
  ) {
    const selected = await this.claim(access, authority, id);
    if (!selected.ok) return selected;
    return dispatchAgentInput(
      selected.entry,
      selected.agent,
      authority.principalId,
      selected.lease.fence,
      events,
      selected.context,
    );
  }

  async observe(
    access: DeviceAgentAccessDeps,
    authority: DeviceAgentAuthority,
    id: string,
    screenshot: boolean,
  ) {
    const selected = await this.claim(access, authority, id);
    if (!selected.ok) return selected;
    const result = screenshot
      ? { capture: await this.deps.host.capture(selected.session) }
      : { tree: await this.deps.tools.accessibility(selected.session) };
    // An observation may complete after takeover or revocation. Publish nothing
    // from that operation once its fence or device grant has gone stale.
    if (
      !(await selected.entry.authorize(
        authority.principalId,
        'view',
        selected.context,
      )) ||
      !selected.entry.lease.isCurrent(selected.lease.fence, selected.agent).ok
    )
      return refused('interrupted');
    return { ok: true, ...result };
  }

  async close(
    access: DeviceAgentAccessDeps,
    authority: DeviceAgentAuthority,
    id: string,
  ) {
    if (this.owners.get(id) !== ownerKey(authority))
      return refused('not-session-owner');
    const selected = await this.claim(access, authority, id);
    if (!selected.ok) return selected;
    if (
      !selected.entry.lease.isCurrent(selected.lease.fence, selected.agent).ok
    )
      return refused('interrupted');
    await this.deps.sessions.close(id);
    this.owners.delete(id);
    return { ok: true, shutdown: false };
  }
}
