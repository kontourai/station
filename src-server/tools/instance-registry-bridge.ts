/**
 * Packaged, deliberately small boundary between the native desktop host and
 * Station's home-scoped instance registry.  Do not replace this with Rust JSON
 * I/O: the shared module owns registry validation, locking, and atomic publish.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  claimDesktopSidecar,
  type InstanceConfig,
  reconcileStaleInstances,
  removeInstance,
  updateStatus,
  upsertInstance,
} from '@kontourai/station-shared/instance-registry';
import {
  birthProvesReuse,
  lookupProcessBirthFingerprint,
} from '@kontourai/station-shared/process-identity';
import { ensureStationHomeSchemaSync } from '@kontourai/station-shared/station-home-schema';
import { quarantineLegacyServiceManifest } from './legacy-service-manifest-quarantine.js';

type Operation =
  | 'read'
  | 'upsert'
  | 'updateStatus'
  | 'remove'
  | 'claimSidecar'
  | 'ensureHomeSchema'
  | 'prepareRuntime'
  | 'supervisorIdentity'
  | 'profileLockIdentity';
const OPERATIONS = new Set<Operation>([
  'read',
  'upsert',
  'updateStatus',
  'remove',
  'claimSidecar',
  'ensureHomeSchema',
  'prepareRuntime',
  'supervisorIdentity',
  'profileLockIdentity',
]);
const CONFIG_KEYS = new Set([
  'port',
  'uiPort',
  'checkout',
  'channel',
  'buildSha',
  'builtAt',
  'type',
  'status',
  'pid',
  'birth',
  'startedAt',
  'env',
]);
const INSTANCE_TYPES = new Set(['service', 'sidecar', 'worktree', 'inline']);

function fail(message: string): never {
  throw new Error(message);
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail('invalid input');
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    fail('invalid input');
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) fail('invalid input');
  return value;
}

function home(value: unknown): string {
  const path = requiredString(value);
  if (!isAbsolute(path)) fail('invalid input');
  return path;
}

function instanceConfig(value: unknown): Partial<InstanceConfig> {
  const config = object(value);
  exactKeys(config, [...CONFIG_KEYS]);
  if (
    'port' in config &&
    (typeof config.port !== 'number' || !Number.isFinite(config.port))
  )
    fail('invalid input');
  if (
    'uiPort' in config &&
    (typeof config.uiPort !== 'number' || !Number.isFinite(config.uiPort))
  )
    fail('invalid input');
  if (
    'pid' in config &&
    (!Number.isInteger(config.pid) || (config.pid as number) <= 0)
  )
    fail('invalid input');
  for (const key of [
    'checkout',
    'channel',
    'buildSha',
    'builtAt',
    'status',
    'startedAt',
    'birth',
  ]) {
    if (key in config && typeof config[key] !== 'string') fail('invalid input');
  }
  if (
    'type' in config &&
    (typeof config.type !== 'string' || !INSTANCE_TYPES.has(config.type))
  )
    fail('invalid input');
  if (
    'env' in config &&
    (typeof config.env !== 'object' ||
      config.env === null ||
      Array.isArray(config.env) ||
      Object.values(config.env).some((entry) => typeof entry !== 'string'))
  )
    fail('invalid input');
  return config as Partial<InstanceConfig>;
}

export type ProcessProbe = (pid: number) => void;

type ProcessLiveness = 'alive' | 'dead' | 'unavailable';

function processLiveness(
  pid: number,
  probe: ProcessProbe = (candidate) => process.kill(candidate, 0),
): ProcessLiveness {
  if (!Number.isInteger(pid) || pid <= 0) return 'dead';
  try {
    probe(pid);
    return 'alive';
  } catch (error) {
    // A signal-0 failure proves absence only for ESRCH. Permission denial and
    // probe failures remain an ownership fence.
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
      ? 'dead'
      : 'unavailable';
  }
}

function input(operation: Operation): Record<string, unknown> {
  const raw = readFileSync(0, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    fail('invalid input');
  }
  const parsed = object(value);
  const allowed =
    operation === 'read' ||
    operation === 'ensureHomeSchema' ||
    operation === 'prepareRuntime' ||
    operation === 'supervisorIdentity' ||
    operation === 'profileLockIdentity'
      ? operation === 'prepareRuntime'
        ? ['home', 'root']
        : operation === 'profileLockIdentity'
          ? ['pid']
          : ['home']
      : operation === 'upsert' || operation === 'claimSidecar'
        ? ['home', 'id', 'instance']
        : operation === 'updateStatus'
          ? ['home', 'id', 'status', 'pid']
          : ['home', 'id'];
  exactKeys(parsed, allowed);
  return parsed;
}

function redactedCode(
  error: unknown,
): 'REGISTRY_UNTRUSTED' | 'INVALID_INPUT' | 'OPERATION_FAILED' {
  const message = error instanceof Error ? error.message : '';
  if (message === 'invalid input') return 'INVALID_INPUT';
  if (
    message.includes('instance registry') ||
    message.includes('owner-controlled')
  )
    return 'REGISTRY_UNTRUSTED';
  return 'OPERATION_FAILED';
}

export function readRegistryInstances(
  stationHome: string,
  options: { processProbe?: ProcessProbe } = {},
) {
  // Desktop startup is the reconciliation boundary for a sidecar left by a
  // force-killed parent. This mutates only records whose pid/birth identity
  // proves they are stale; a live sibling remains a live owner.
  const registry = reconcileStaleInstances(stationHome, {
    processProbe: options.processProbe,
  });
  return Object.entries(registry.instances).map(([id, instance]) => {
    const liveness =
      typeof instance.pid === 'number'
        ? processLiveness(instance.pid, options.processProbe)
        : undefined;
    return {
      id,
      ...instance,
      // Birth-aware (station#3064): Desktop decides whether a service
      // owns this home from this field, and now that a supervisor
      // publishes a real pid, a REUSED pid would hand ownership to an
      // unrelated process — or, read the other way, keep Desktop from
      // taking back a home whose service died. Fail-open on probe
      // failure, like every other birth comparison. Narrower than the
      // name suggests (alive AND identity-verified), deliberately: the
      // conservative direction for a decision that gates spawning a
      // second writer.
      pidAlive:
        typeof instance.pid === 'number'
          ? liveness !== 'dead' &&
            // A reused birth proves staleness only after the signal probe
            // succeeded. An ambiguous probe must keep the registry fence.
            (liveness !== 'alive' ||
              !birthProvesReuse(instance.birth, instance.pid))
          : null,
    };
  });
}

/**
 * Compatibility entry point for the native bridge.  The transaction itself is
 * isolated so this protocol adapter cannot grow another filesystem authority.
 */
export function prepareRuntime(
  stationHome: string,
  stationRoot: string,
): ReturnType<typeof quarantineLegacyServiceManifest> {
  return quarantineLegacyServiceManifest(stationHome, stationRoot);
}

export function runInstanceRegistryBridge(): void {
  const operation = process.argv[2];
  if (
    typeof operation !== 'string' ||
    !OPERATIONS.has(operation as Operation) ||
    process.argv.length !== 3
  ) {
    fail('invalid input');
  }
  const inputValue = input(operation as Operation);
  const stationHome =
    operation === 'profileLockIdentity' ? undefined : home(inputValue.home);
  if (operation === 'ensureHomeSchema') {
    ensureStationHomeSchemaSync(stationHome!);
    process.stdout.write('{"ok":true}\n');
    return;
  }
  if (operation === 'prepareRuntime') {
    const result = prepareRuntime(stationHome!, home(inputValue.root));
    if (result.kind === 'refused') {
      // Keep refusal structured and path-free while preserving the native
      // caller's current fail-closed nonzero-exit contract.
      process.stdout.write(
        '{"ok":false,"result":{"kind":"refused"},"error":{"code":"RUNTIME_REFUSED"}}\n',
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    return;
  }
  if (operation === 'supervisorIdentity') {
    const birth = lookupProcessBirthFingerprint(process.ppid);
    if (!birth) fail('supervisor identity unavailable');
    process.stdout.write(
      `${JSON.stringify({ ok: true, pid: process.ppid, birth })}\n`,
    );
    return;
  }
  if (operation === 'profileLockIdentity') {
    const pid = inputValue.pid;
    if (!Number.isInteger(pid) || (pid as number) <= 0) fail('invalid input');
    const birth = lookupProcessBirthFingerprint(pid as number);
    if (!birth) fail('profile lock identity unavailable');
    process.stdout.write(`${JSON.stringify({ ok: true, pid, birth })}\n`);
    return;
  }
  if (operation === 'read') {
    const instances = readRegistryInstances(stationHome!);
    process.stdout.write(`${JSON.stringify({ ok: true, instances })}\n`);
    return;
  }
  const id = requiredString(inputValue.id);
  if (operation === 'claimSidecar') {
    const instance = instanceConfig(inputValue.instance) as InstanceConfig;
    if (instance.type === 'sidecar') {
      instance.pid ??= process.ppid;
      instance.birth = lookupProcessBirthFingerprint(instance.pid) ?? undefined;
    }
    const claimed = claimDesktopSidecar(id, instance, stationHome!);
    process.stdout.write(`${JSON.stringify({ ok: true, claimed })}\n`);
    return;
  }
  if (operation === 'upsert') {
    const instance = instanceConfig(inputValue.instance);
    if (instance.type === 'sidecar' && typeof instance.pid === 'number') {
      instance.birth = lookupProcessBirthFingerprint(instance.pid) ?? undefined;
    }
    upsertInstance(id, instance, stationHome!);
  } else if (operation === 'updateStatus') {
    const status = requiredString(inputValue.status);
    const pid = inputValue.pid;
    if (pid !== undefined && (!Number.isInteger(pid) || (pid as number) <= 0))
      fail('invalid input');
    updateStatus(id, status, pid as number | undefined, stationHome!);
  } else {
    removeInstance(id, stationHome!);
  }
  process.stdout.write('{"ok":true}\n');
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    runInstanceRegistryBridge();
  } catch (error) {
    // This protocol reaches native logs/UI. Never serialize Error.message: the
    // shared registry intentionally includes filesystem paths in diagnostics.
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: { code: redactedCode(error) } })}\n`,
    );
    process.exitCode = 1;
  }
}
