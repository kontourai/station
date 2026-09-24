/**
 * Device services per SSH device host (#1973).
 *
 * The local host's `LocalMobileDeviceHost` and `DeviceSessionService` are
 * built once by the runtime. An SSH device host gets the SAME two classes,
 * built on first use from the endpoint the device host resolver answers for
 * its id — so inventory, Start, sessions, the live producer and D12 checks
 * run unchanged through that host's forwarded, guarded hub. The Tools
 * drawer's service (#2442) is built the same way, from the SAME endpoint:
 * its accessibility tree and iOS foreground app come from that host's hub,
 * never the local one. A host that was removed answers nothing, and its
 * sessions are disposed.
 */
import { LocalMobileDeviceHost } from '../../mobile-device/mobile-device-host.js';
import type { DeviceHostResolver } from '../device-host-resolver.js';
import type { DeviceHubEndpoint } from '../device-hub-endpoint.js';
import type { DeviceSessionService } from '../device-session-service.js';
import type { DeviceToolsService } from '../device-tools.js';
import {
  createSshDeviceToolsService,
  type SshDeviceToolHost,
} from './ssh-device-tools.js';

export interface RemoteDeviceHostServicesOptions {
  /** Whether the id still names a stored host. */
  has(hostId: string): boolean;
  resolver: DeviceHostResolver;
  /** The session service for a host, or undefined (no live surfaces). */
  createSessions?: (input: {
    hostId: string;
    host: LocalMobileDeviceHost;
    endpoint: DeviceHubEndpoint;
  }) => DeviceSessionService | undefined;
  /**
   * Where a host's Device Tools vectors run (#2442: the registry's
   * `runTool`). The drawer's service is built HERE, from the endpoint this
   * class resolved for that host — no caller chooses which hub it reads.
   * Absent → no Tools drawer service for SSH device hosts.
   */
  toolsHost?: SshDeviceToolHost;
}

export interface RemoteDeviceHostEntry {
  host: LocalMobileDeviceHost;
  sessions?: DeviceSessionService;
  tools?: DeviceToolsService;
}

type Entry = RemoteDeviceHostEntry;

export class RemoteDeviceHostServices {
  readonly #o: RemoteDeviceHostServicesOptions;
  readonly #entries = new Map<string, Entry>();
  readonly #endpoints = new Map<string, DeviceHubEndpoint>();
  readonly #toolsGeneration = new Map<string, number>();

  constructor(options: RemoteDeviceHostServicesOptions) {
    this.#o = options;
  }

  get(hostId: string): Entry | undefined {
    if (hostId === 'local' || !this.#o.has(hostId)) {
      this.#drop(hostId);
      return undefined;
    }
    const cached = this.#entries.get(hostId);
    if (cached) {
      this.#refreshTools(hostId, cached);
      return cached;
    }
    const endpoint = this.#o.resolver.resolve({ hostId });
    if (!endpoint) return undefined;
    const host = new LocalMobileDeviceHost({ hub: endpoint, hostId });
    const sessions = this.#o.createSessions?.({ hostId, host, endpoint });
    const entry: Entry = { host, ...(sessions ? { sessions } : {}) };
    this.#endpoints.set(hostId, endpoint);
    this.#refreshTools(hostId, entry);
    this.#entries.set(hostId, entry);
    return entry;
  }

  /**
   * The Tools drawer's service for the host as it is NOW (#2442 review L4).
   * The service remembers what it last set on each device (iOS location);
   * once the host is retargeted, removed or disabled that describes another
   * machine's devices, so the service is rebuilt with nothing remembered.
   */
  #refreshTools(hostId: string, entry: Entry): void {
    const toolsHost = this.#o.toolsHost;
    const endpoint = this.#endpoints.get(hostId);
    if (!toolsHost || !endpoint) return;
    const generation = toolsHost.generation(hostId);
    if (entry.tools && this.#toolsGeneration.get(hostId) === generation) return;
    entry.tools = createSshDeviceToolsService({
      hostId,
      host: toolsHost,
      endpoint,
    });
    this.#toolsGeneration.set(hostId, generation);
  }

  #drop(hostId: string): void {
    const entry = this.#entries.get(hostId);
    if (!entry) return;
    this.#entries.delete(hostId);
    this.#endpoints.delete(hostId);
    this.#toolsGeneration.delete(hostId);
    void entry.sessions?.dispose();
  }

  async dispose(): Promise<void> {
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.allSettled(entries.map((entry) => entry.sessions?.dispose()));
  }
}
