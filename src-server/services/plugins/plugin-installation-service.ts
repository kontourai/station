/** Installation intent boundary. Backend adapters carry their own locations;
 * these values never require a filesystem path, process ID, or server account. */
export interface PluginArtifactReference {
  readonly digest: string;
}
export type PluginArtifactEntry =
  | { readonly path: string; readonly kind: 'directory' }
  | {
      readonly path: string;
      readonly kind: 'file';
      readonly bytes: Uint8Array;
      readonly executable?: boolean;
    }
  | {
      readonly path: string;
      readonly kind: 'symlink';
      readonly target: string;
    };
/** Content capability issued by the acquisition owner; alternate hosts can
 * consume bytes without knowing any local staging path. */
export interface PreparedPluginArtifact extends PluginArtifactReference {
  readEntries(): AsyncIterable<PluginArtifactEntry>;
}
export interface PluginInstallationHost {
  service(
    artifact?: PreparedPluginArtifact,
  ): Promise<
    Pick<
      PluginInstallationService,
      'inspect' | 'install' | 'withdraw' | 'reconcile' | 'compensate'
    >
  >;
  reconcile(): Promise<{ status: 'applied' | 'pending'; pending: string[] }>;
}
export type { PluginInstallationRevision } from '@kontourai/station-contracts/plugin';

import type { PluginInstallationRevision } from '@kontourai/station-contracts/plugin';
export interface PluginMaterialization {
  readonly reference: string;
  readonly dataScope: string;
  readonly origin?: string;
  readonly artifact: PluginArtifactReference;
}
export interface PluginInstallationStateBackend {
  recorded(revision: PluginInstallationRevision): Promise<boolean>;
  current(installation: string): Promise<PluginInstallationRevision | null>;
  create(
    installation: string,
    materialization: PluginMaterialization,
  ): Promise<PluginInstallationRevision>;
  fence(expected: PluginInstallationRevision): Promise<{
    replace(next: PluginMaterialization): Promise<PluginInstallationRevision>;
    withdraw(): Promise<void>;
    cancel(): Promise<void>;
  }>;
}
export interface PluginMaterializationBackend {
  current(installation: string): Promise<PluginMaterialization | null>;
  prepare(
    installation: string,
    artifact: PluginArtifactReference,
    dataScope: string,
  ): Promise<PluginMaterialization>;
  select(
    installation: string,
    next: PluginMaterialization | null,
    expected: PluginMaterialization | null,
  ): Promise<void>;
}
export interface PluginDataScopeBackend {
  prepare(
    installation: string,
    previous: string | null,
    choice: 'preserve' | 'retain-and-reset',
  ): Promise<string>;
}
export class PluginInstallationConflict extends Error {
  constructor() {
    super(
      'Plugin installation changed or its authority is unavailable; inspect and retry.',
    );
    this.name = 'PluginInstallationConflict';
  }
}
export class PluginInstallationPending extends Error {
  readonly code = 'plugin-projection-pending';
  constructor(readonly selected: PluginInstallationRevision | null) {
    super(
      'Plugin selection is recorded but its catalog projection is pending. Reload plugins to reconcile it; stored code and data are retained.',
    );
    this.name = 'PluginInstallationPending';
  }
}
function same(
  a: PluginInstallationRevision | null,
  b: PluginInstallationRevision | null,
): boolean {
  return a === null || b === null
    ? a === b
    : a.scope === b.scope &&
        a.installation === b.installation &&
        a.generation === b.generation &&
        a.materialization === b.materialization &&
        a.dataScope === b.dataScope &&
        a.origin === b.origin &&
        a.artifact.digest === b.artifact.digest;
}

/** Publication is a saga across state and execution materialization. The
 * old selection remains retained; uncertain results never imply reclamation. */
export class PluginInstallationService {
  constructor(
    private readonly state: PluginInstallationStateBackend,
    private readonly materializations: PluginMaterializationBackend,
    private readonly dataScopes: PluginDataScopeBackend,
  ) {}
  async inspect(installation: string) {
    return this.state.current(installation);
  }
  async reconcile(
    installation: string,
  ): Promise<PluginInstallationRevision | null> {
    const selected = await this.state.current(installation);
    const prior = await this.materializations.current(installation);
    const next = selected
      ? {
          reference: selected.materialization,
          artifact: selected.artifact,
          dataScope: selected.dataScope,
        }
      : null;
    if (
      (prior?.reference ?? null) !== (next?.reference ?? null) ||
      prior?.dataScope !== next?.dataScope
    ) {
      await this.materializations.select(installation, next, prior);
    }
    if (!same(await this.state.current(installation), selected))
      throw new PluginInstallationConflict();
    return selected;
  }
  async install(input: {
    installation: string;
    expected: PluginInstallationRevision | null;
    artifact: PluginArtifactReference;
    data?: 'preserve' | 'retain-and-reset';
    origin: string;
  }) {
    if (!/^[a-f0-9]{64}$/.test(input.origin))
      throw new Error(
        'Plugin acquisition origin is required; existing code and data are retained.',
      );
    if (input.expected && !input.expected.origin)
      throw new Error(
        'Plugin acquisition origin is unknown; reviewed migration is required. Existing code and data are retained.',
      );
    await this.reconcile(input.installation);
    if (!same(await this.state.current(input.installation), input.expected))
      throw new PluginInstallationConflict();
    const prior = await this.materializations.current(input.installation);
    if (
      (prior?.reference ?? null) !== (input.expected?.materialization ?? null)
    )
      throw new PluginInstallationConflict();
    if (
      prior &&
      input.expected &&
      (prior.artifact.digest !== input.expected.artifact.digest ||
        prior.dataScope !== input.expected.dataScope)
    )
      throw new PluginInstallationConflict();
    if (
      input.expected &&
      (input.origin !== undefined || input.expected.origin !== undefined) &&
      input.expected.origin !== input.origin
    )
      throw new Error(
        'Plugin acquisition origin changed or is unknown; reviewed migration is required. Existing code and data are retained.',
      );
    const dataScope = await this.dataScopes.prepare(
      input.installation,
      input.expected?.dataScope ?? null,
      input.data ?? 'preserve',
    );
    const prepared = await this.materializations.prepare(
      input.installation,
      input.artifact,
      dataScope,
    );
    const next = {
      ...prepared,
      ...(input.origin ? { origin: input.origin } : {}),
    };
    const fence = input.expected
      ? await this.state.fence(input.expected)
      : null;
    let published = false;
    try {
      // Claim an absent installation through CAS before publishing a pointer;
      // a losing concurrent create must never remove the winner's selection.
      const created = fence
        ? null
        : await this.state.create(input.installation, next);
      await this.materializations.select(input.installation, next, prior);
      const selected = fence ? await fence.replace(next) : created!;
      published = true;
      return {
        selected,
        previous: input.expected,
        retainedPrevious: input.expected !== null,
        data: input.expected
          ? selected.dataScope === input.expected.dataScope
            ? ('preserved' as const)
            : ('reset-with-prior-retained' as const)
          : ('new' as const),
      };
    } catch (error) {
      // A transport/backend can lose the acknowledgement after commit. Never
      // restore the prior pointer over a possibly committed new selection.
      const observed = await this.state
        .current(input.installation)
        .catch(() => undefined);
      if (observed && observed.materialization === next.reference)
        throw new PluginInstallationPending(observed);
      if (observed === undefined) throw new PluginInstallationPending(null);
      if (!same(observed, input.expected)) throw error;
      const projection = await this.materializations.current(
        input.installation,
      );
      if (projection?.reference === next.reference)
        await this.materializations.select(
          input.installation,
          prior,
          projection,
        );
      else if ((projection?.reference ?? null) !== (prior?.reference ?? null))
        throw new PluginInstallationPending(observed);
      if (!published) await fence?.cancel();
      throw error;
    }
  }
  /** Compensate an owned activation/removal transaction by restoring its prior
   * selection under NEW admission. The caller holds the same configuration
   * mutation. This is NOT user-facing code rollback: compensation of a failed
   * explicit reset also restores that transaction's prior data-scope selection.
   * Neither operation reverses writes made by plugin code. */
  async compensate(input: {
    expected: PluginInstallationRevision | null;
    retained: PluginInstallationRevision;
  }): Promise<PluginInstallationRevision> {
    const { expected, retained } = input;
    if (
      (expected &&
        (expected.scope !== retained.scope ||
          expected.installation !== retained.installation)) ||
      !(await this.state.recorded(retained))
    )
      throw new PluginInstallationConflict();
    await this.reconcile(retained.installation);
    if (!same(await this.state.current(retained.installation), expected))
      throw new PluginInstallationConflict();
    const prior = await this.materializations.current(retained.installation);
    const next: PluginMaterialization = {
      reference: retained.materialization,
      artifact: retained.artifact,
      dataScope: retained.dataScope,
      ...(retained.origin ? { origin: retained.origin } : {}),
    };
    const fence = expected ? await this.state.fence(expected) : null;
    try {
      const created = fence
        ? null
        : await this.state.create(retained.installation, next);
      await this.materializations.select(retained.installation, next, prior);
      return fence ? await fence.replace(next) : created!;
    } catch (error) {
      const observed = await this.state
        .current(retained.installation)
        .catch(() => undefined);
      if (observed === undefined || !same(observed, expected))
        throw new PluginInstallationPending(observed ?? null);
      const projection = await this.materializations.current(
        retained.installation,
      );
      if (
        projection?.reference === next.reference &&
        projection.dataScope === next.dataScope
      )
        await this.materializations.select(
          retained.installation,
          prior,
          projection,
        );
      await fence?.cancel();
      throw error;
    }
  }
  async withdraw(expected: PluginInstallationRevision) {
    await this.reconcile(expected.installation);
    if (!same(await this.state.current(expected.installation), expected))
      throw new PluginInstallationConflict();
    const prior = await this.materializations.current(expected.installation);
    if (prior?.reference !== expected.materialization)
      throw new PluginInstallationConflict();
    const fence = await this.state.fence(expected);
    try {
      await this.materializations.select(expected.installation, null, prior);
      await fence.withdraw();
      return {
        withdrawn: true as const,
        retained: expected,
        reclamation: 'not-proven' as const,
      };
    } catch (error) {
      const observed = await this.state
        .current(expected.installation)
        .catch(() => undefined);
      if (observed !== undefined && same(observed, expected)) {
        await this.materializations.select(expected.installation, prior, null);
        await fence.cancel();
      }
      throw error;
    }
  }
}
