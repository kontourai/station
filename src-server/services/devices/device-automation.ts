import type { LiveSurfaceInput } from '@kontourai/station-contracts/live-surface';
import type {
  MobileDeviceSummary,
  MobileDeviceTarget,
} from '@kontourai/station-contracts/mobile-device';
import {
  claimAgentControl,
  dispatchAgentInput,
  type LiveSurfaceRegistry,
  releaseAgentControl,
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

/** Holds are scoped to one tool call; refuse unbalanced input before any send. */
function completeGestures(events: readonly LiveSurfaceInput[]): boolean {
  const pointers = new Set<string>();
  const keys = new Set<string>();
  for (const event of events) {
    if (event.kind === 'pointer') {
      const button = event.button ?? 'left';
      if (event.type === 'down') pointers.add(button);
      if (event.type === 'up' && !pointers.delete(button)) return false;
    } else if (event.kind === 'key') {
      const key = event.code || event.key;
      if (event.type === 'down') keys.add(key);
      else if (!keys.delete(key)) return false;
    }
  }
  return pointers.size === 0 && keys.size === 0;
}

/** Local-device agent path. All input uses the existing allowlisted hub producer. */
export class DeviceAutomation {
  private readonly owners = new Map<string, string>();
  private readonly inputBatches = new Map<string, Promise<void>>();
  private readonly inFlight = new Map<
    string,
    {
      active: number;
      releases: Map<number, () => void>;
    }
  >();
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
    const opened = await this.withControl(
      access,
      authority,
      session.sessionId,
      async () => ({
        ok: true,
        session,
        paneRevealed: false,
        instructions:
          'Open Device in the pane chooser and select this local device to watch. Use device_input with deviceSessionId and events (surface pixel coordinates), device_snapshot for accessibility, and device_screenshot for PNG. Control is released after your last overlapping operation; human takeover interrupts input.',
      }),
    );
    return opened.ok
      ? {
          ...opened,
          lease: this.deps.surfaces.get(session.surfaceId)?.lease.snapshot(),
        }
      : opened;
  }

  private async withControl<T extends object>(
    access: DeviceAgentAccessDeps,
    authority: DeviceAgentAuthority,
    id: string,
    run: (
      selected: Extract<
        Awaited<ReturnType<DeviceAutomation['claim']>>,
        { ok: true }
      >,
    ) => Promise<T>,
  ) {
    const key = JSON.stringify([
      id,
      authority.principalId,
      authority.sessionId,
    ]);
    const group = this.inFlight.get(key) ?? {
      active: 0,
      releases: new Map<number, () => void>(),
    };
    this.inFlight.set(key, group);
    // Reserve before awaiting authorization: an already-running operation must
    // not release the shared fence while another call is still claiming it.
    group.active += 1;
    try {
      const selected = await this.claim(access, authority, id);
      if (!selected.ok) return selected;
      group.releases.set(selected.lease.fence, () => {
        releaseAgentControl(
          selected.entry,
          selected.agent,
          selected.lease.fence,
        );
      });
      return await run(selected);
    } finally {
      if (--group.active === 0) {
        this.inFlight.delete(key);
        // Old fences cannot release a human or a newer controller's lease.
        for (const release of group.releases.values()) release();
      }
    }
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

  private async withInputBatch<T>(
    surfaceId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const previous = this.inputBatches.get(surfaceId) ?? Promise.resolve();
    const operation = previous.then(run);
    const completed = operation.then(
      () => undefined,
      () => undefined,
    );
    this.inputBatches.set(surfaceId, completed);
    try {
      return await operation;
    } finally {
      if (this.inputBatches.get(surfaceId) === completed)
        this.inputBatches.delete(surfaceId);
    }
  }

  async input(
    access: DeviceAgentAccessDeps,
    authority: DeviceAgentAuthority,
    id: string,
    events: readonly LiveSurfaceInput[],
  ) {
    if (!completeGestures(events))
      return { ...refused('incomplete-gesture'), accepted: 0 };
    const result = await this.withControl(
      access,
      authority,
      id,
      async (selected) =>
        this.withInputBatch(selected.session.surfaceId, async () => {
          const supported = selected.entry.producer.capabilities.input;
          if (!events.every((event) => supported.includes(event.kind)))
            return { ...refused('unsupported-input'), accepted: 0 };
          let accepted = 0;
          for (const event of events) {
            // Re-authorize each event through the registry so revocation between
            // events stops the batch without changing the producer's send fencing.
            const result = await dispatchAgentInput(
              selected.entry,
              selected.agent,
              authority.principalId,
              selected.lease.fence,
              [event],
              selected.context,
            );
            accepted += result.accepted;
            if (!result.ok) {
              // A partial/uncertain gesture must be cancelled even while an
              // overlapping observation is still active on the same fence.
              releaseAgentControl(
                selected.entry,
                selected.agent,
                selected.lease.fence,
              );
              return { ...result, accepted };
            }
          }
          return { ok: true, accepted };
        }),
    );
    // A refusal before device admission must not acquire screen/control metadata.
    if (!('accepted' in result) && !('lease' in result)) return result;
    const session = this.deps.sessions.get(id);
    const lease = session
      ? this.deps.surfaces.get(session.surfaceId)?.lease.snapshot()
      : undefined;
    return { ...result, ...(lease ? { lease } : {}) };
  }

  async observe(
    access: DeviceAgentAccessDeps,
    authority: DeviceAgentAuthority,
    id: string,
    screenshot: boolean,
  ) {
    return this.withControl(access, authority, id, async (selected) => {
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
    });
  }

  async close(
    access: DeviceAgentAccessDeps,
    authority: DeviceAgentAuthority,
    id: string,
  ) {
    if (this.owners.get(id) !== ownerKey(authority))
      return refused('not-session-owner');
    const standing = await authorizeDeviceAgentCaller(access);
    if (!standing.ok || standing.actor.kind !== 'operator')
      return refused('operator-required');
    return this.withControl(access, authority, id, async (selected) => {
      // The early gate prevents claiming; recheck after the asynchronous claim.
      const current = await authorizeDeviceAgentCaller(access);
      if (!current.ok || current.actor.kind !== 'operator')
        return refused('operator-required');
      if (
        !selected.entry.lease.isCurrent(selected.lease.fence, selected.agent).ok
      )
        return refused('interrupted');
      await this.deps.sessions.close(id);
      this.owners.delete(id);
      return { ok: true, shutdown: false };
    });
  }
}
