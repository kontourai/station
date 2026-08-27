import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { kitObservabilityDescriptorDigest } from '@kontourai/flow-agents/kit-observability-contract';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { JsonFileStore } from '../infra/json-store.js';
import type {
  StationKitHostInput,
  StationKitInstallation,
  StationKitLifecycle,
  StationKitLifecycleStore,
  StationKitLifecycleStoreOptions,
  StationKitMutationCandidate,
  StationKitMutationRequest,
  StationKitMutationResult,
  StationKitQuarantinedDiscovery,
  StationKitRegistryEntry,
} from './kit-observability-host.js';
import { StationKitObservabilityHost } from './kit-observability-host.js';

interface PersistedLifecycle {
  descriptorDigest: string;
  incarnation: number;
  available: boolean;
  enabled: boolean;
}

interface LifecycleState {
  version: 1;
  contributions: Record<string, PersistedLifecycle>;
}

export class KitLifecycleConflictError extends Error {
  constructor(contributionRef: string) {
    super(
      `Kit contribution '${contributionRef}' changed in another Station process; retry the lifecycle action.`,
    );
    this.name = 'KitLifecycleConflictError';
  }
}

/**
 * Host-owned installed-Kit lifecycle and persistence. It intentionally keeps
 * physical discovery, durable availability reconciliation, and presentation
 * incarnation separate from the public contribution/record adapter.
 */
export class StationKitObservabilityRegistry {
  #entries = new Map<
    string,
    StationKitInstallation & { incarnation: number }
  >();
  #store?: StationKitLifecycleStore;
  #persisted: LifecycleState;
  #quarantinedDiscoveries: StationKitQuarantinedDiscovery[] = [];
  #scanning = false;
  #dirty = false;
  #mutationLockPath?: string;
  #acquireMutationLock: (path: string) => Promise<() => Promise<void>>;
  #staleDescriptorRefs = new Set<string>();

  constructor(
    private readonly host: StationKitObservabilityHost,
    options: StationKitLifecycleStoreOptions = {},
  ) {
    this.#mutationLockPath = options.statePath
      ? `${options.statePath}.mutation`
      : undefined;
    this.#acquireMutationLock =
      options.acquireMutationLock ?? acquireFileMutationLockAsync;
    this.#store =
      options.store ??
      (options.statePath
        ? new JsonFileStore(
            options.statePath,
            { version: 1, contributions: {} },
            {
              onCorruption: 'throw',
              durableAtomicWrite: true,
            },
          )
        : undefined);
    this.#persisted = validateLifecycleState(this.#store?.read());
  }

  discoverInstalled(
    roots: readonly string[],
  ): Promise<StationKitRegistryEntry[]> {
    return this.runAtomically(() => this.discoverInstalledUnsafe(roots));
  }

  private discoverInstalledUnsafe(
    roots: readonly string[],
  ): StationKitRegistryEntry[] {
    this.#scanning = true;
    this.#quarantinedDiscoveries = [];
    const discovered = new Set<string>();
    const candidates = new Map<string, StationKitInstallation>();
    const ambiguous = new Set<string>();
    try {
      for (const root of roots) {
        if (!existsSync(root)) continue;
        for (const dirent of readdirSync(root, { withFileTypes: true })) {
          if (!dirent.isDirectory()) continue;
          const directory = join(root, dirent.name);
          const contribution = this.host.discover(directory);
          if (contribution.status !== 'supported') continue;
          const contributionRef = contribution.contribution.metadata.name;
          const candidate = {
            contribution,
            directory,
          } satisfies StationKitInstallation;
          const previous = candidates.get(contributionRef);
          if (previous?.contribution.status === 'supported') {
            candidates.delete(contributionRef);
            ambiguous.add(contributionRef);
            this.#quarantinedDiscoveries.push({
              contributionRef,
              reason: 'duplicate_contribution_ref',
              directories: [
                ...(previous.directory ? [previous.directory] : []),
                directory,
              ],
            });
          } else if (!ambiguous.has(contributionRef)) {
            candidates.set(contributionRef, candidate);
          } else {
            const quarantined = this.#quarantinedDiscoveries.find(
              (entry) => entry.contributionRef === contributionRef,
            );
            if (quarantined) quarantined.directories.push(directory);
          }
        }
      }
      for (const [contributionRef, candidate] of candidates) {
        discovered.add(contributionRef);
        this.installUnsafe(candidate);
      }
      for (const contributionRef of ambiguous) {
        this.#entries.delete(contributionRef);
        const persisted = this.#persisted.contributions[contributionRef];
        if (persisted?.available) {
          this.writePersisted(contributionRef, {
            ...persisted,
            available: false,
          });
        }
      }
      this.reconcileAvailability(discovered);
    } finally {
      this.#scanning = false;
    }
    // Materialize presentation before publishing the staged lifecycle state.
    // A malformed contribution must not leave earlier scan entries persisted.
    const entries = this.list();
    this.flushPersisted();
    return entries;
  }

  install(input: StationKitInstallation): Promise<StationKitRegistryEntry> {
    return this.runAtomically(() => this.installUnsafe(input));
  }

  private installUnsafe(
    input: StationKitInstallation,
  ): StationKitRegistryEntry {
    if (input.contribution.status !== 'supported') {
      throw new Error(
        'Only supported Kit observability contributions can install',
      );
    }
    const contributionRef = input.contribution.contribution.metadata.name;
    const existing = this.#entries.get(contributionRef);
    const persisted = this.#persisted.contributions[contributionRef];
    const descriptorDigest = kitObservabilityDescriptorDigest(
      input.contribution.contribution,
    );
    const sameDescriptor =
      (existing?.contribution.status === 'supported' &&
        kitObservabilityDescriptorDigest(existing.contribution.contribution) ===
          descriptorDigest) ||
      persisted?.descriptorDigest === descriptorDigest;
    const reinstalled =
      sameDescriptor &&
      (existing?.lifecycle === 'uninstalled' ||
        persisted?.available === false) &&
      input.directory !== undefined;
    // The journal is freshly read under the mutation lock. Prefer its
    // incarnation over an entry snapshot that may predate another process's
    // descriptor update.
    const previousIncarnation = persisted?.incarnation ?? existing?.incarnation;
    const incarnation = previousIncarnation
      ? sameDescriptor && !reinstalled
        ? previousIncarnation
        : previousIncarnation + 1
      : 1;
    const lifecycle =
      input.lifecycle ??
      (persisted?.enabled === false ? 'disabled' : 'installed');
    this.#entries.set(contributionRef, {
      ...copyInstallation(input),
      lifecycle,
      incarnation,
    });
    this.writePersisted(contributionRef, {
      descriptorDigest,
      incarnation,
      available: lifecycle !== 'uninstalled',
      ...(lifecycle === 'disabled' ? { enabled: false } : { enabled: true }),
    });
    this.#staleDescriptorRefs.delete(contributionRef);
    return this.get(contributionRef)!;
  }

  update(
    contributionRef: string,
    input: Omit<StationKitInstallation, 'lifecycle'>,
  ): Promise<StationKitRegistryEntry> {
    return this.runAtomically(() => {
      if (!this.#entries.has(contributionRef)) {
        throw new Error(
          `Kit contribution '${contributionRef}' is not installed`,
        );
      }
      if (
        input.contribution.status !== 'supported' ||
        input.contribution.contribution.metadata.name !== contributionRef
      ) {
        throw new Error(
          'Kit updates must retain the installed contribution identity',
        );
      }
      return this.installUnsafe({
        ...input,
        ...(this.#entries.get(contributionRef)?.lifecycle === 'disabled'
          ? { lifecycle: 'disabled' as const }
          : {}),
      });
    }, contributionRef);
  }

  disable(contributionRef: string): Promise<StationKitRegistryEntry> {
    return this.transition(contributionRef, 'disabled');
  }

  enable(contributionRef: string): Promise<StationKitRegistryEntry> {
    return this.transition(contributionRef, 'installed');
  }

  async uninstall(contributionRef: string): Promise<StationKitRegistryEntry> {
    const entry = this.#entries.get(contributionRef);
    if (!entry?.directory || existsSync(entry.directory)) {
      throw new Error(
        'Kit uninstallation is derived from committed plugin removal; use the plugin lifecycle route.',
      );
    }
    return await this.transition(contributionRef, 'uninstalled');
  }

  get(contributionRef: string): StationKitRegistryEntry | undefined {
    const entry = this.#entries.get(contributionRef);
    return entry ? this.toEntry(contributionRef, entry) : undefined;
  }

  list(): StationKitRegistryEntry[] {
    return [...this.#entries.entries()]
      .map(([contributionRef, entry]) => this.toEntry(contributionRef, entry))
      .sort((left, right) =>
        left.contributionRef.localeCompare(right.contributionRef),
      );
  }

  quarantinedDiscoveries(): readonly StationKitQuarantinedDiscovery[] {
    return this.#quarantinedDiscoveries.map(snapshot);
  }

  requestMutation(
    contributionRef: string,
    request?: StationKitMutationRequest,
  ): StationKitMutationResult {
    const entry = this.#entries.get(contributionRef);
    if (entry?.contribution.status !== 'supported') {
      return {
        allowed: false,
        code: 'mutation_denied',
        reason:
          'Kit contribution is not installed in this Station composition.',
      };
    }
    return this.host.requestMutation(
      entry.contribution.contribution,
      entry.lifecycle ?? 'installed',
      request,
    );
  }

  prepareMutation(
    contributionRef: string,
    intent: StationKitMutationRequest['intent'],
  ): StationKitMutationCandidate | StationKitMutationResult {
    const entry = this.#entries.get(contributionRef);
    if (entry?.contribution.status !== 'supported') {
      return {
        allowed: false,
        code: 'mutation_denied',
        reason:
          'Kit contribution is not installed in this Station composition.',
      };
    }
    const proposed = this.host.requestMutation(
      entry.contribution.contribution,
      entry.lifecycle ?? 'installed',
      { intent, approved: true },
    );
    if (!proposed.allowed || !proposed.action) return proposed;
    const action = snapshot(proposed.action);
    return {
      contributionRef,
      descriptorDigest: descriptorDigestFor(entry),
      incarnation: entry.incarnation,
      action,
      target: snapshot('target' in action ? action.target : null),
      actionDigest: digestAction(action),
    };
  }

  confirmMutation(
    candidate: StationKitMutationCandidate,
    approved: boolean,
  ): StationKitMutationResult {
    const entry = this.#entries.get(candidate.contributionRef);
    if (entry?.contribution.status !== 'supported') {
      return staleMutationResult();
    }
    if (
      descriptorDigestFor(entry) !== candidate.descriptorDigest ||
      entry.incarnation !== candidate.incarnation
    ) {
      return staleMutationResult();
    }
    const current = this.prepareMutation(
      candidate.contributionRef,
      candidate.action.intent,
    );
    if (
      'allowed' in current ||
      current.actionDigest !== candidate.actionDigest ||
      JSON.stringify(current.target) !== JSON.stringify(candidate.target)
    ) {
      return staleMutationResult();
    }
    return this.host.requestMutation(
      entry.contribution.contribution,
      entry.lifecycle ?? 'installed',
      { intent: candidate.action.intent, approved },
    );
  }

  private transition(
    contributionRef: string,
    lifecycle: StationKitLifecycle,
  ): Promise<StationKitRegistryEntry> {
    return this.runAtomically(
      () => this.transitionUnsafe(contributionRef, lifecycle),
      contributionRef,
    );
  }

  private transitionUnsafe(
    contributionRef: string,
    lifecycle: StationKitLifecycle,
  ): StationKitRegistryEntry {
    if (this.#staleDescriptorRefs.has(contributionRef)) {
      throw new KitLifecycleConflictError(contributionRef);
    }
    const entry = this.#entries.get(contributionRef);
    if (!entry)
      throw new Error(`Kit contribution '${contributionRef}' is not installed`);
    if (
      lifecycle === 'installed' &&
      entry.directory &&
      !existsSync(entry.directory)
    ) {
      throw new Error(
        `Kit contribution '${contributionRef}' is not physically available`,
      );
    }
    entry.lifecycle = lifecycle;
    this.writePersisted(contributionRef, {
      descriptorDigest: descriptorDigestFor(entry),
      incarnation: entry.incarnation,
      available: lifecycle !== 'uninstalled',
      ...(lifecycle === 'disabled' ? { enabled: false } : { enabled: true }),
    });
    return this.toEntry(contributionRef, entry);
  }

  private reconcileAvailability(discovered: ReadonlySet<string>): void {
    for (const [contributionRef, state] of Object.entries(
      this.#persisted.contributions,
    )) {
      if (!discovered.has(contributionRef) && state.available) {
        const entry = this.#entries.get(contributionRef);
        if (entry) entry.lifecycle = 'uninstalled';
        this.writePersisted(contributionRef, { ...state, available: false });
      }
    }
  }

  private writePersisted(
    contributionRef: string,
    state: PersistedLifecycle,
  ): void {
    this.#persisted = {
      version: 1,
      contributions: {
        ...this.#persisted.contributions,
        [contributionRef]: snapshot(state),
      },
    };
    this.#dirty = true;
    if (!this.#scanning) this.flushPersisted();
  }

  private flushPersisted(): void {
    if (!this.#dirty || !this.#store) return;
    this.#store.write(this.#persisted);
    this.#dirty = false;
  }

  private async runAtomically<T>(
    operation: () => T,
    conflictRef?: string,
  ): Promise<T> {
    const entries = new Map(
      [...this.#entries.entries()].map(([ref, entry]) => [
        ref,
        { ...copyInstallation(entry), incarnation: entry.incarnation },
      ]),
    );
    const persisted = snapshot(this.#persisted);
    const quarantinedDiscoveries = snapshot(this.#quarantinedDiscoveries);
    const scanning = this.#scanning;
    const dirty = this.#dirty;
    if (this.#mutationLockPath) {
      mkdirSync(dirname(this.#mutationLockPath), {
        recursive: true,
        mode: 0o700,
      });
    }
    const release = this.#mutationLockPath
      ? await this.#acquireMutationLock(this.#mutationLockPath)
      : undefined;
    try {
      const fresh = this.#store
        ? validateLifecycleState(this.#store.read())
        : this.#persisted;
      if (
        conflictRef &&
        !samePersistedLifecycle(
          persisted.contributions[conflictRef],
          fresh.contributions[conflictRef],
        )
      ) {
        if (
          persisted.contributions[conflictRef]?.descriptorDigest !==
          fresh.contributions[conflictRef]?.descriptorDigest
        ) {
          this.#staleDescriptorRefs.add(conflictRef);
        }
        this.#persisted = fresh;
        this.refreshEntriesFromPersisted();
        throw new KitLifecycleConflictError(conflictRef);
      }
      this.#persisted = fresh;
      this.refreshEntriesFromPersisted();
      const result = operation();
      if (conflictRef) this.#staleDescriptorRefs.delete(conflictRef);
      return result;
    } catch (error) {
      // JsonFileStore writes atomically. Restoring these in-memory snapshots
      // keeps a rejected write from becoming a ghost lifecycle transition.
      if (!(error instanceof KitLifecycleConflictError)) {
        this.#entries = entries;
        this.#persisted = persisted;
      }
      this.#quarantinedDiscoveries = quarantinedDiscoveries;
      this.#scanning = scanning;
      this.#dirty = dirty;
      throw error;
    } finally {
      await release?.();
    }
  }

  private refreshEntriesFromPersisted(): void {
    for (const [contributionRef, entry] of this.#entries) {
      const persisted = this.#persisted.contributions[contributionRef];
      if (
        !persisted ||
        persisted.descriptorDigest !== descriptorDigestFor(entry)
      )
        continue;
      entry.incarnation = persisted.incarnation;
      entry.lifecycle = !persisted.available
        ? 'uninstalled'
        : persisted.enabled
          ? 'installed'
          : 'disabled';
    }
  }

  private toEntry(
    contributionRef: string,
    entry: StationKitInstallation & { incarnation: number },
  ): StationKitRegistryEntry {
    const installation = copyInstallation(entry);
    if (installation.contribution.status !== 'supported') {
      throw new Error('Only supported Kit contributions have lifecycle state');
    }
    const input: StationKitHostInput = {
      contribution: installation.contribution,
      lifecycle: entry.lifecycle ?? 'installed',
      ...(installation.mcpApps ? { mcpApps: installation.mcpApps } : {}),
      ...(installation.project
        ? {
            project: {
              ...installation.project,
              incarnation: entry.incarnation,
            },
          }
        : {}),
    };
    return {
      contributionRef,
      contribution: snapshot(installation.contribution.contribution),
      lifecycle: entry.lifecycle ?? 'installed',
      incarnation: entry.incarnation,
      experience: this.host.present(input),
    };
  }
}

function validateLifecycleState(value: unknown): LifecycleState {
  if (value === undefined) return { version: 1, contributions: {} };
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['version', 'contributions']) ||
    value.version !== 1 ||
    !isPlainObject(value.contributions)
  ) {
    throw new Error('Kit observability lifecycle state is invalid');
  }
  const contributions: Record<string, PersistedLifecycle> = {};
  for (const [contributionRef, state] of Object.entries(value.contributions)) {
    if (
      !isSafeContributionRef(contributionRef) ||
      !isPlainObject(state) ||
      !hasExactKeys(state, [
        'descriptorDigest',
        'incarnation',
        'available',
        'enabled',
      ]) ||
      typeof state.descriptorDigest !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(state.descriptorDigest) ||
      typeof state.incarnation !== 'number' ||
      !Number.isSafeInteger(state.incarnation) ||
      state.incarnation < 1 ||
      typeof state.available !== 'boolean' ||
      typeof state.enabled !== 'boolean'
    ) {
      throw new Error('Kit observability lifecycle state is invalid');
    }
    contributions[contributionRef] = {
      descriptorDigest: state.descriptorDigest as string,
      incarnation: state.incarnation as number,
      available: state.available as boolean,
      enabled: state.enabled as boolean,
    };
  }
  return { version: 1, contributions };
}

function samePersistedLifecycle(
  left: PersistedLifecycle | undefined,
  right: PersistedLifecycle | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    [...expected].sort().every((key, index) => keys[index] === key)
  );
}

function descriptorDigestFor(
  entry: StationKitInstallation & { incarnation: number },
): string {
  if (entry.contribution.status !== 'supported') {
    throw new Error('Only supported Kit contributions have lifecycle state');
  }
  return kitObservabilityDescriptorDigest(entry.contribution.contribution);
}

function digestAction(action: unknown): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(action))
    .digest('hex')}`;
}

function staleMutationResult(): StationKitMutationResult {
  return {
    allowed: false,
    code: 'mutation_denied',
    reason:
      'The Kit contribution changed while approval was pending; request a new operator approval.',
  };
}

function copyInstallation(
  input: StationKitInstallation,
): StationKitInstallation {
  return {
    contribution: snapshot(input.contribution),
    ...(input.directory ? { directory: input.directory } : {}),
    ...(input.lifecycle ? { lifecycle: input.lifecycle } : {}),
    ...(input.project ? { project: { ...input.project } } : {}),
    ...(input.mcpApps
      ? {
          mcpApps: {
            ...input.mcpApps,
            visibility: [...input.mcpApps.visibility],
          },
        }
      : {}),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeContributionRef(value: string): boolean {
  return /^[a-z][a-z0-9-]{0,62}$/.test(value);
}

function snapshot<T>(value: T): T {
  return structuredClone(value);
}
