import { basename, dirname } from 'node:path';
import type {
  PackageMcpAdmissionJournal,
  PackageMcpInstallation,
} from './package-mcp-admission.js';
import { computePluginContentDigest } from './plugin-content-integrity.js';
import {
  type InstalledPluginRoot,
  prepareLocalPluginDataScope,
  preparePluginIncarnation,
  publishPluginIncarnation,
  resolveInstalledPluginRoot,
} from './plugin-incarnation.js';
import {
  type PluginDataScopeBackend,
  PluginInstallationConflict,
  type PluginInstallationRevision,
  PluginInstallationService,
  type PluginInstallationStateBackend,
  type PluginMaterializationBackend,
} from './plugin-installation-service.js';

export function localPluginInstallationState(
  journal: PackageMcpAdmissionJournal,
): PluginInstallationStateBackend {
  const project = (
    value: PackageMcpInstallation,
  ): PluginInstallationRevision => {
    if (!value.materialization || !value.dataScope)
      throw new PluginInstallationConflict();
    return {
      scope: value.journalId,
      installation: value.pluginId,
      generation: value.incarnation,
      artifact: { digest: value.contentDigest },
      materialization: value.materialization,
      dataScope: value.dataScope,
    };
  };
  const reference = (
    value: PluginInstallationRevision,
  ): PackageMcpInstallation => ({
    journalId: value.scope,
    pluginId: value.installation,
    incarnation: value.generation,
    contentDigest: value.artifact.digest,
    materialization: value.materialization,
    dataScope: value.dataScope,
  });
  return {
    async current(id) {
      const result = journal.currentInstallation(id);
      if (result.state === 'unavailable')
        throw new PluginInstallationConflict();
      return result.state === 'observed' ? project(result.installation) : null;
    },
    async create(id, value) {
      const result = journal.recordInstallation({
        pluginId: id,
        contentDigest: value.artifact.digest,
        materialization: value.reference,
        dataScope: value.dataScope,
        previous: null,
      });
      if (result.state !== 'recorded') throw new PluginInstallationConflict();
      return project(result.installation);
    },
    async fence(expected) {
      const result = journal.requestRetirement(reference(expected));
      if (result.state !== 'fenced') throw new PluginInstallationConflict();
      return {
        async replace(next) {
          const replaced = result.retirement.replace({
            contentDigest: next.artifact.digest,
            materialization: next.reference,
            dataScope: next.dataScope,
          });
          if (replaced.state !== 'recorded')
            throw new PluginInstallationConflict();
          return project(replaced.installation);
        },
        async withdraw() {
          if (result.retirement.withdraw().state !== 'applied')
            throw new PluginInstallationConflict();
        },
        async cancel() {
          if (result.retirement.cancel().state !== 'applied')
            throw new PluginInstallationConflict();
        },
      };
    },
  };
}

/** Filesystem paths are confined to this execution/materialization adapter. */
export function localPluginMaterializations(
  pluginsDir: string,
  stagedSource?: string,
): PluginMaterializationBackend {
  const roots = new Map<string, InstalledPluginRoot>();
  const capture = (root: InstalledPluginRoot) => {
    if (!root.generation) throw new PluginInstallationConflict();
    const digest = computePluginContentDigest(
      dirname(root.packageRoot),
      basename(root.packageRoot),
    );
    if (!digest) throw new PluginInstallationConflict();
    roots.set(root.generation, root);
    return {
      reference: root.generation,
      dataScope: root.dataScope!,
      artifact: { digest },
    };
  };
  return {
    async current(id) {
      const root = resolveInstalledPluginRoot(pluginsDir, id);
      return root ? capture(root) : null;
    },
    async prepare(id, artifact, data) {
      if (
        !stagedSource ||
        computePluginContentDigest(
          dirname(stagedSource),
          basename(stagedSource),
        ) !== artifact.digest
      )
        throw new PluginInstallationConflict();
      const prepared = preparePluginIncarnation(
        pluginsDir,
        id,
        stagedSource,
        data,
      );
      const captured = capture(prepared.captured);
      if (captured.artifact.digest !== artifact.digest)
        throw new PluginInstallationConflict();
      return captured;
    },
    async select(id, next) {
      const root = next ? roots.get(next.reference) : null;
      if (next && !root) throw new PluginInstallationConflict();
      publishPluginIncarnation(pluginsDir, id, root ?? null);
    },
  };
}
export function createLocalPluginInstallationService(
  pluginsDir: string,
  journal: PackageMcpAdmissionJournal,
  stagedSource?: string,
) {
  return new PluginInstallationService(
    localPluginInstallationState(journal),
    localPluginMaterializations(pluginsDir, stagedSource),
    localPluginDataScopes(pluginsDir),
  );
}

export function localPluginDataScopes(
  pluginsDir: string,
): PluginDataScopeBackend {
  return {
    async prepare(installation, previous, choice) {
      return prepareLocalPluginDataScope(
        pluginsDir,
        installation,
        previous,
        choice,
      );
    },
  };
}
