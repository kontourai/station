/**
 * Device services per SSH device host (#1973).
 *
 * The local host's `LocalMobileDeviceHost` and `DeviceSessionService` are
 * built once by the runtime. An SSH device host gets the SAME two classes,
 * built on first use from the endpoint the device host resolver answers for
 * its id — so inventory, Start, sessions, the live producer and D12 checks
 * run unchanged through that host's forwarded, guarded hub. A host that was
 * removed answers nothing, and its sessions are disposed.
 */
import { LocalMobileDeviceHost } from '../../mobile-device/mobile-device-host.js';
import type { DeviceHostResolver } from '../device-host-resolver.js';
import type { DeviceHubEndpoint } from '../device-hub-endpoint.js';
import type { DeviceSessionService } from '../device-session-service.js';

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
}

export interface RemoteDeviceHostEntry {
  host: LocalMobileDeviceHost;
  sessions?: DeviceSessionService;
}

type Entry = RemoteDeviceHostEntry;

export class RemoteDeviceHostServices {
  readonly #o: RemoteDeviceHostServicesOptions;
  readonly #entries = new Map<string, Entry>();

  constructor(options: RemoteDeviceHostServicesOptions) {
    this.#o = options;
  }

  get(hostId: string): Entry | undefined {
    if (hostId === 'local' || !this.#o.has(hostId)) {
      this.#drop(hostId);
      return undefined;
    }
    const cached = this.#entries.get(hostId);
    if (cached) return cached;
    const endpoint = this.#o.resolver.resolve({ hostId });
    if (!endpoint) return undefined;
    const host = new LocalMobileDeviceHost({ hub: endpoint, hostId });
    const sessions = this.#o.createSessions?.({ hostId, host, endpoint });
    const entry: Entry = { host, ...(sessions ? { sessions } : {}) };
    this.#entries.set(hostId, entry);
    return entry;
  }

  #drop(hostId: string): void {
    const entry = this.#entries.get(hostId);
    if (!entry) return;
    this.#entries.delete(hostId);
    void entry.sessions?.dispose();
  }

  async dispose(): Promise<void> {
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.allSettled(entries.map((entry) => entry.sessions?.dispose()));
  }
}
