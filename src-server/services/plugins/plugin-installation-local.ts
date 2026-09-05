import { mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import type {
  PackageMcpAdmissionJournal,
  PackageMcpInstallation,
} from './package-mcp-admission.js';
import {
  localPluginArtifactSource,
  materializePluginArtifact,
} from './plugin-artifact-local.js';
import {
  computePluginContentDigest,
  withPluginContentLock,
} from './plugin-content-integrity.js';
import {
  type InstalledPluginRoot,
  prepareLocalPluginDataScope,
  preparePluginIncarnation,
  publishPluginIncarnation,
  resolveInstalledPluginRoot,
  resolvePluginMaterialization,
} from './plugin-incarnation.js';
import {
  type PluginDataScopeBackend,
  PluginInstallationConflict,
  type PluginInstallationHost,
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
      ...(value.origin ? { origin: value.origin } : {}),
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
    ...(value.origin ? { origin: value.origin } : {}),
  });
  return {
    async recorded(revision) {
      return journal.installationRecorded(reference(revision));
    },
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
        ...(value.origin ? { origin: value.origin } : {}),
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
            ...(next.origin ? { origin: next.origin } : {}),
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
    async select(id, next, expected) {
      await withPluginContentLock(pluginsDir, id, async () => {
        const release = await acquireFileMutationLockAsync(
          join(pluginsDir, '.selection-publication.mutation'),
        );
        try {
          const current = resolveInstalledPluginRoot(pluginsDir, id);
          if (
            (current?.generation ?? null) !== (expected?.reference ?? null) ||
            (current?.dataScope ?? null) !== (expected?.dataScope ?? null)
          )
            throw new PluginInstallationConflict();
          const root = next
            ? (roots.get(next.reference) ??
              resolvePluginMaterialization(pluginsDir, id, next.reference))
            : null;
          if (next && root) {
            const actual = capture(root);
            if (
              actual.artifact.digest !== next.artifact.digest ||
              actual.dataScope !== next.dataScope
            )
              throw new PluginInstallationConflict();
          }
          publishPluginIncarnation(pluginsDir, id, root);
        } finally {
          await release();
        }
      });
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

/** Rebuild compatibility projections from the journal, never infer selection from directory presence. */
export async function reconcileLocalPluginInstallations(
  pluginsDir: string,
  journal: PackageMcpAdmissionJournal,
) {
  const selected = journal.selectedInstallations();
  if (selected.state !== 'observed')
    return { status: 'pending' as const, pending: ['installation-authority'] };
  const pending: string[] = [];
  for (const installation of selected.installations) {
    if (!installation.materialization) continue;
    try {
      await createLocalPluginInstallationService(pluginsDir, journal).reconcile(
        installation.pluginId,
      );
    } catch {
      pending.push(installation.pluginId);
    }
  }
  return {
    status: pending.length ? ('pending' as const) : ('applied' as const),
    pending,
  };
}

export function createLocalPluginInstallationHost(
  pluginsDir: string,
  journal: PackageMcpAdmissionJournal,
): PluginInstallationHost {
  return {
    async service(artifact) {
      const source = artifact ? localPluginArtifactSource(artifact) : undefined;
      const ordinary = createLocalPluginInstallationService(
        pluginsDir,
        journal,
        source,
      );
      if (!artifact || source) return ordinary;
      return {
        inspect: (id) => ordinary.inspect(id),
        restore: (input) => ordinary.restore(input),
        withdraw: (revision) => ordinary.withdraw(revision),
        reconcile: (id) => ordinary.reconcile(id),
        async install(input) {
          const temporary = mkdtempSync(join(pluginsDir, '.artifact-'));
          try {
            await materializePluginArtifact(artifact, temporary);
            return await createLocalPluginInstallationService(
              pluginsDir,
              journal,
              temporary,
            ).install(input);
          } finally {
            rmSync(temporary, { recursive: true, force: true });
          }
        },
      };
    },
    reconcile: () => reconcileLocalPluginInstallations(pluginsDir, journal),
  };
}

/** Local execution capture. The journal owns selection; directory aliases are
 * projections only. Callers retain this currentness capability across awaits. */
export function captureLocalPluginInstallation(
  pluginsDir: string,
  journal: PackageMcpAdmissionJournal,
  pluginId: string,
): {
  root: InstalledPluginRoot;
  installation: PackageMcpInstallation | null;
  isCurrent(): boolean;
} | null {
  const observed = journal.currentInstallation(pluginId);
  if (observed.state === 'unavailable') throw new PluginInstallationConflict();
  if (observed.state === 'observed') {
    const installation = observed.installation;
    if (!installation.materialization || !installation.dataScope)
      throw new PluginInstallationConflict();
    const root = resolvePluginMaterialization(
      pluginsDir,
      pluginId,
      installation.materialization,
    );
    if (root.dataScope !== installation.dataScope)
      throw new PluginInstallationConflict();
    return Object.freeze({
      root,
      installation,
      isCurrent() {
        try {
          return (
            journal.admissionOpen(installation) &&
            resolvePluginMaterialization(
              pluginsDir,
              pluginId,
              installation.materialization!,
            ).dataScope === installation.dataScope
          );
        } catch {
          return false;
        }
      },
    });
  }
  const root = resolveInstalledPluginRoot(pluginsDir, pluginId);
  if (!root) return null;
  if (root.kind !== 'legacy') throw new PluginInstallationConflict();
  return Object.freeze({
    root,
    installation: null,
    isCurrent() {
      try {
        return (
          journal.currentInstallation(pluginId).state === 'not-observed' &&
          resolveInstalledPluginRoot(pluginsDir, pluginId)?.kind === 'legacy'
        );
      } catch {
        return false;
      }
    },
  });
}
