import { randomUUID } from 'node:crypto';
import type { LiveSurfaceInput } from '@kontourai/station-contracts/live-surface';
import type {
  DeviceAgentReveal,
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

interface DeviceAutomationHost {
  host: Pick<LocalMobileDeviceHost, 'inventory' | 'capture'>;
  sessions: DeviceSessionService;
  tools: Pick<DeviceToolsService, 'accessibility'>;
}
interface DeviceAutomationDeps extends DeviceAutomationHost {
  surfaces: Pick<LiveSurfaceRegistry, 'get'>;
  remoteHostIds?: () => readonly string[];
  remoteHost?: (hostId: string) => DeviceAutomationHost | undefined;
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

/** Host-scoped device agent path. All input uses the existing allowlisted hub producer. */
export class DeviceAutomation {
  private readonly reveals = new Map<
    string,
    {
      authority: DeviceAgentAuthority;
      reveal: DeviceAgentReveal;
      at: number;
      admitted: () => Promise<boolean>;
    }
  >();

  async revealRequests(
    projectId: string,
    conversationId: string,
    principalId?: string,
  ): Promise<DeviceAgentReveal[]> {
    const entries = [...this.reveals.values()].filter(
      (entry) =>
        entry.authority.projectId === projectId &&
        entry.authority.conversationId === conversationId &&
        (principalId === undefined ||
          entry.authority.principalId === principalId) &&
        Date.now() - entry.at < 10 * 60_000 &&
        this.sessionServices(entry.reveal.session.sessionId)?.session
          .surfaceId === entry.reveal.session.surfaceId,
    );
    const reveals: DeviceAgentReveal[] = [];
    for (const entry of entries)
      if (await entry.admitted()) reveals.push(structuredClone(entry.reveal));
    return reveals;
  }
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

  private hostServices(hostId: string): DeviceAutomationHost | undefined {
    return hostId === 'local' ? this.deps : this.deps.remoteHost?.(hostId);
  }

  private sessionServices(id: string) {
    let selected:
      | {
          session: NonNullable<ReturnType<DeviceSessionService['get']>>;
          services: DeviceAutomationHost;
        }
      | undefined;
    for (const hostId of ['local', ...(this.deps.remoteHostIds?.() ?? [])]) {
      const services = this.hostServices(hostId);
      const session = services?.sessions.get(id);
      if (!services || !session || session.hostId !== hostId) continue;
      if (selected) return undefined;
      selected = { session, services };
    }
    return selected;
  }

  async list(access: DeviceAgentAccessDeps, authority: DeviceAgentAuthority) {
    const standing = await authorizeDeviceAgentCaller(access);
    if (
      !standing.ok ||
      (standing.actor.kind !== 'operator' &&
        access.shares.list(authority.projectId).length === 0)
    )
      return refused('not-authorized');
    for (const id of this.owners.keys())
      if (!this.sessionServices(id)) this.owners.delete(id);
    const devices: MobileDeviceSummary[] = [];
    const sessions = [];
    const hosts: Array<{ hostId: string; state: string }> = [];
    for (const hostId of ['local', ...(this.deps.remoteHostIds?.() ?? [])]) {
      if (
        standing.actor.kind !== 'operator' &&
        !access.shares
          .list(authority.projectId)
          .some((share) => share.hostId === hostId)
      )
        continue;
      const services = this.hostServices(hostId);
      if (!services) continue;
      const inventory = await services.host.inventory();
      // Only publish hosts for which at least one device is admitted (or the operator).
      const visible: MobileDeviceSummary[] = [];
      for (const device of services.sessions.withStartingRows(
        inventory.devices,
      )) {
        if (
          device.hostId === hostId &&
          (await deviceAgentMayAccess(access, authority, device))
        )
          visible.push(device);
      }
      if (standing.actor.kind === 'operator' || visible.length > 0)
        hosts.push({ hostId, state: inventory.state });
      devices.push(...visible);
      for (const session of services.sessions.list()) {
        if (
          session.hostId === hostId &&
          this.owners.get(session.sessionId) === ownerKey(authority) &&
          visible.some(
            (device) =>
              device.hostId === session.hostId &&
              device.platform === session.platform &&
              device.deviceId === session.deviceId,
          )
        ) {
          sessions.push({
            ...session,
            lease: this.deps.surfaces.get(session.surfaceId)?.lease.snapshot(),
          });
        }
      }
    }
    const fresh = await authorizeDeviceAgentCaller(access);
    if (
      !fresh.ok ||
      ownerKey(fresh.authority) !== ownerKey(authority) ||
      fresh.authority.sessionId !== authority.sessionId
    )
      return refused('not-authorized');
    return { ok: true, hosts, devices, sessions };
  }

  async open(
    access: DeviceAgentAccessDeps,
    authority: DeviceAgentAuthority,
    target: MobileDeviceTarget,
    reveal = true,
  ) {
    if (!(await deviceAgentMayAccess(access, authority, target)))
      return refused('not-authorized');
    const services = this.hostServices(target.hostId);
    if (!services) return refused('host-unavailable');
    const started = await services.sessions.start(target, () =>
      deviceAgentMayAccess(access, authority, target),
    );
    if (started.state === 'starting') return { ok: true, ...started };
    const session = await services.sessions.open(
      target,
      () => deviceAgentMayAccess(access, authority, target),
      (created) => this.owners.set(created.sessionId, ownerKey(authority)),
    );
    // Opening/revealing a session observes it; it never claims the input lease.
    if (this.hostServices(target.hostId)?.sessions !== services.sessions)
      return refused('host-unavailable');
    if (!(await deviceAgentMayAccess(access, authority, session)))
      return refused('not-authorized');
    services.sessions.noteAgentActivity(session.sessionId);
    if (reveal) {
      const key = JSON.stringify([ownerKey(authority), session.sessionId]);
      const previous = this.reveals.get(key);
      const retained =
        previous && Date.now() - previous.at < 10 * 60_000
          ? previous
          : undefined;
      this.reveals.set(key, {
        authority,
        reveal: {
          intentId: retained?.reveal.intentId ?? randomUUID(),
          session,
        },
        at: retained?.at ?? Date.now(),
        admitted: async () =>
          this.hostServices(target.hostId)?.sessions === services.sessions &&
          services.sessions.get(session.sessionId)?.surfaceId ===
            session.surfaceId &&
          (await deviceAgentMayAccess(access, authority, session)),
      });
      while (this.reveals.size > 200)
        this.reveals.delete(this.reveals.keys().next().value!);
    }
    return {
      ok: true,
      session,
      paneRevealed: false,
      revealRequested: reveal,
      instructions:
        'Use Device to watch this session. device_input uses surface pixel coordinates; device_snapshot reads accessibility and device_screenshot captures PNG. Human takeover interrupts input.',
      lease: this.deps.surfaces.get(session.surfaceId)?.lease.snapshot(),
    };
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
    const resolved = this.sessionServices(id);
    const session = resolved?.session;
    if (
      !resolved ||
      !session ||
      !(await deviceAgentMayAccess(access, authority, session))
    )
      return refused('not-authorized');
    const entry = this.deps.surfaces.get(session.surfaceId);
    if (!entry) return refused('unknown-session');
    const agent = {
      kind: 'agent' as const,
      principal: authority.principalId,
      sessionId: authority.sessionId,
    };
    const scopedAccess: DeviceAgentAccessDeps = {
      ...access,
      resolveCaller: () => {
        const current = this.sessionServices(id);
        return current?.session.surfaceId === session.surfaceId &&
          current.services.sessions === resolved.services.sessions &&
          current.services.tools === resolved.services.tools
          ? access.resolveCaller()
          : null;
      },
    };
    const context = {
      agentGrant: mintDeviceAgentGrant(scopedAccess, authority, session),
    };
    const claim = await claimAgentControl(
      entry,
      agent,
      authority.principalId,
      context,
    );
    if (!claim.ok) return claim;
    resolved.services.sessions.noteAgentActivity(id);
    return {
      ok: true as const,
      session,
      services: resolved.services,
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
    const session = this.sessionServices(id)?.session;
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
        ? { capture: await selected.services.host.capture(selected.session) }
        : {
            tree: await selected.services.tools.accessibility(selected.session),
          };
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
      await selected.services.sessions.close(id);
      this.owners.delete(id);
      return { ok: true, shutdown: false };
    });
  }
}
