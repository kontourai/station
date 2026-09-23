/**
 * A Project's registered local targets (#90 D7).
 *
 * A Project admin's browser reaches public addresses only. The operator can
 * share a specific local service with the Project's admins by registering it
 * here: `{host, port, label, addedBy, addedAt}`. Only the operator adds or
 * removes targets (the routes enforce that). A Station listener port can
 * never be registered, and the egress proxy refuses it again at connect.
 *
 * Stored in `<home>/browser/local-targets.json`, keyed by canonical Project
 * ID. Mutations are synchronous read-modify-write inside this process, which
 * owns the file.
 */
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { BlockList } from 'node:net';
import { join } from 'node:path';
import type { RegisteredLocalTarget } from './egress-policy.js';
import { canonicalIp, isLoopbackIp } from './ip-address.js';
import type { StationListeners } from './station-listeners.js';

export interface LocalTarget extends RegisteredLocalTarget {
  id: string;
  label: string;
  /** `operator` today; kept as a principal key for attribution. */
  addedBy: string;
  addedAt: string;
}

export type LocalTargetRefusal =
  | 'invalid-host'
  | 'invalid-port'
  | 'invalid-label'
  | 'station-listener'
  | 'duplicate'
  | 'not-found';

export class LocalTargetError extends Error {
  constructor(readonly code: LocalTargetRefusal) {
    super(`Local target refused: ${code}.`);
    this.name = 'LocalTargetError';
  }
}

/** LAN and tailnet ranges a target may name (loopback is checked apart). */
const REGISTRABLE = (() => {
  const list = new BlockList();
  list.addSubnet('10.0.0.0', 8, 'ipv4');
  list.addSubnet('172.16.0.0', 12, 'ipv4');
  list.addSubnet('192.168.0.0', 16, 'ipv4');
  list.addSubnet('100.64.0.0', 10, 'ipv4');
  list.addSubnet('fc00::', 7, 'ipv6');
  return list;
})();

/**
 * Normalize a target host: `localhost`, or a loopback, RFC1918, CGNAT/tailnet
 * or ULA IP literal. Public, link-local (including the metadata address),
 * multicast and unspecified addresses are refused: a public address needs no
 * registration, and the others are never a service to share.
 */
export function normalizeLocalTargetHost(host: unknown): string | undefined {
  if (typeof host !== 'string') return undefined;
  const value = host.trim().toLowerCase();
  if (value === 'localhost') return 'localhost';
  const ip = canonicalIp(value);
  if (!ip) return undefined;
  if (ip.address === '0.0.0.0' || ip.address === '0:0:0:0:0:0:0:0')
    return undefined;
  if (isLoopbackIp(ip)) return ip.address;
  return REGISTRABLE.check(ip.address, ip.family === 4 ? 'ipv4' : 'ipv6')
    ? ip.address
    : undefined;
}

interface StoreShape {
  version: 1;
  projects: Record<string, LocalTarget[]>;
}

export class LocalTargetStore {
  private readonly path: string;
  private readonly projects = new Map<string, LocalTarget[]>();

  constructor(
    private readonly stationHome: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.path = join(stationHome, 'browser', 'local-targets.json');
    this.load();
  }

  list(projectId: string): LocalTarget[] {
    return structuredClone(this.projects.get(projectId) ?? []);
  }

  add(
    projectId: string,
    input: { host: unknown; port: unknown; label: unknown },
    addedBy: string,
    listeners: StationListeners,
  ): LocalTarget {
    const host = normalizeLocalTargetHost(input.host);
    if (!host) throw new LocalTargetError('invalid-host');
    const port = input.port;
    if (
      typeof port !== 'number' ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65_535
    )
      throw new LocalTargetError('invalid-port');
    if (listeners.ports.includes(port))
      throw new LocalTargetError('station-listener');
    const label = typeof input.label === 'string' ? input.label.trim() : '';
    if (
      label === '' ||
      label.length > 80 ||
      [...label].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20)
    )
      throw new LocalTargetError('invalid-label');
    const targets = this.projects.get(projectId) ?? [];
    if (targets.some((t) => t.host === host && t.port === port))
      throw new LocalTargetError('duplicate');
    const target: LocalTarget = {
      id: `lt_${randomUUID()}`,
      host,
      port,
      label,
      addedBy,
      addedAt: this.now().toISOString(),
    };
    this.projects.set(projectId, [...targets, target]);
    this.persist();
    return structuredClone(target);
  }

  remove(projectId: string, targetId: string): LocalTarget {
    const targets = this.projects.get(projectId) ?? [];
    const target = targets.find((t) => t.id === targetId);
    if (!target) throw new LocalTargetError('not-found');
    this.projects.set(
      projectId,
      targets.filter((t) => t.id !== targetId),
    );
    this.persist();
    return structuredClone(target);
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as StoreShape;
      if (parsed?.version !== 1) return;
      for (const [projectId, targets] of Object.entries(
        parsed.projects ?? {},
      )) {
        if (!Array.isArray(targets)) continue;
        this.projects.set(
          projectId,
          targets.filter(
            (t) =>
              typeof t?.id === 'string' &&
              normalizeLocalTargetHost(t.host) === t.host &&
              Number.isInteger(t.port),
          ),
        );
      }
    } catch {
      // An unreadable store registers nothing: admins reach public only.
    }
  }

  private persist(): void {
    const store: StoreShape = {
      version: 1,
      projects: Object.fromEntries(this.projects),
    };
    mkdirSync(join(this.stationHome, 'browser'), {
      recursive: true,
      mode: 0o700,
    });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.path);
  }
}
