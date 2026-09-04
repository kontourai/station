/** Installation intent boundary. Backend adapters carry their own locations;
 * these values never require a filesystem path, process ID, or server account. */
export interface PluginArtifactReference {
  readonly digest: string;
}
export type { PluginInstallationRevision } from '@kontourai/station-contracts/plugin';

import type { PluginInstallationRevision } from '@kontourai/station-contracts/plugin';
export interface PluginMaterialization {
  readonly reference: string;
  readonly dataScope: string;
  readonly artifact: PluginArtifactReference;
}
export interface PluginInstallationStateBackend {
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
  async install(input: {
    installation: string;
    expected: PluginInstallationRevision | null;
    artifact: PluginArtifactReference;
    data?: 'preserve' | 'retain-and-reset';
  }) {
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
    const dataScope = await this.dataScopes.prepare(
      input.installation,
      input.expected?.dataScope ?? null,
      input.data ?? 'preserve',
    );
    const next = await this.materializations.prepare(
      input.installation,
      input.artifact,
      dataScope,
    );
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
      await this.materializations.select(input.installation, next);
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
      if (observed && observed.materialization === next.reference) throw error;
      if (observed === undefined || !same(observed, input.expected))
        throw error;
      await this.materializations.select(input.installation, prior);
      if (!published) await fence?.cancel();
      throw error;
    }
  }
  async withdraw(expected: PluginInstallationRevision) {
    if (!same(await this.state.current(expected.installation), expected))
      throw new PluginInstallationConflict();
    const prior = await this.materializations.current(expected.installation);
    if (prior?.reference !== expected.materialization)
      throw new PluginInstallationConflict();
    const fence = await this.state.fence(expected);
    try {
      await this.materializations.select(expected.installation, null);
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
        await this.materializations.select(expected.installation, prior);
        await fence.cancel();
      }
      throw error;
    }
  }
}
