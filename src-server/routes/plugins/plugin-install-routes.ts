import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerEventName } from '@kontourai/station-contracts/runtime-events';
import { Hono } from 'hono';
import type { PluginProviderReadView } from '../../providers/registries/registry.js';
import { getPluginRegistryProviders } from '../../providers/registries/registry.js';
import type { AgentConfigurationMutationRunner } from '../../runtime/types.js';
import { isContextSafetyError } from '../../services/orchestration/context-safety.js';
import {
  describePluginManifestRejection,
  rejectedInstalledPluginRecord,
  scanInstalledPluginInventory,
} from '../../services/plugins/installed-plugin-inventory.js';
import type { PackageMcpAdmissionJournal } from '../../services/plugins/package-mcp-admission.js';
import { readPluginCatalogInstallation } from '../../services/plugins/plugin-catalog-installation.js';
import { scanPluginPromptFileSafety } from '../../services/plugins/plugin-command-skill-source.js';
import {
  findPluginContentLockCycleError,
  pluginContentLockCycleMessage,
} from '../../services/plugins/plugin-content-integrity.js';
import {
  derivePluginConsentBasis,
  isPluginConsentRefusedError,
  type PluginInstallConsent,
} from '../../services/plugins/plugin-install-consent.js';
import { localPluginInstallationState } from '../../services/plugins/plugin-installation-local.js';
import type { PluginInstallationHost } from '../../services/plugins/plugin-installation-service.js';
import { PluginInstallationPending } from '../../services/plugins/plugin-installation-service.js';
import { readPluginManifestFileWithFormat } from '../../services/plugins/plugin-manifest-loader.js';
import {
  getPermissionTier,
  observePluginGrantRevisions,
  PluginGrantsUnavailableError,
  readPluginGrantState,
  requiredPermissionsForManifest,
} from '../../services/plugins/plugin-permissions.js';
import type { RegistryTrustPolicyAuthority } from '../../services/plugins/registry-trust-policy.js';
import type { Logger } from '../../utils/logger.js';
import {
  errorMessage,
  getBody,
  param,
  pluginInstallSchema,
  pluginPreviewSchema,
  pluginRecoverySchema,
  validate,
} from '../schemas/schemas.js';
import {
  configurationActivationPayload,
  configurationMutationStatus,
} from '../system/configuration-activation.js';
import { buildPlugin } from './plugin-bundles.js';
import { capturePluginConfigurationMutation } from './plugin-configuration-activation.js';
import {
  installPluginFromSource,
  type PluginInstallSharedDeps,
  previewInstalledPluginRecovery,
  recoverInstalledPlugin,
  resolvePluginRegistrySource,
} from './plugin-install-shared.js';
import {
  detectPluginConflicts,
  detectWorkspacePaneCatalogConflicts,
  fetchPluginSource,
  getPluginGitInfo,
  PluginPreviewUnsupportedDependencyError,
  resolvePluginDependencies,
} from './plugin-source.js';

interface PluginInstallRouteDeps {
  installationHost?: PluginInstallationHost;
  registryTrustPolicyAuthority?: RegistryTrustPolicyAuthority;
  packageMcpJournal?: PackageMcpAdmissionJournal;
  agentsDir: string;
  eventBus?: {
    emit: (event: ServerEventName, data?: Record<string, unknown>) => void;
  };
  logger: Logger;
  pluginsDir: string;
  projectHomeDir: string;
  applyConfigurationMutation?: AgentConfigurationMutationRunner;
  refreshKitObservability?: () => void;
  settleProviderAdapterRetirements?: () => Promise<void>;
  reconcileEngineConnections?: (
    plugin: string,
    view?: PluginProviderReadView,
  ) => Promise<void>;
  quiesceEventSubscriptions?: (
    pluginName: string,
  ) => Promise<{ release(): void }>;
}

export function registerPluginInstallRoutes(
  app: Hono,
  deps: PluginInstallRouteDeps,
): void {
  const {
    agentsDir,
    applyConfigurationMutation,
    eventBus,
    logger,
    pluginsDir,
    projectHomeDir,
    refreshKitObservability,
    settleProviderAdapterRetirements,
    reconcileEngineConnections,
    quiesceEventSubscriptions,
  } = deps;

  app.get('/:name/retained-generations', (c) => {
    const history = deps.packageMcpJournal?.history(c.req.param('name'), {
      after: c.req.query('cursor') ? Number(c.req.query('cursor')) : undefined,
    });
    if (!history || history.state === 'unavailable')
      return c.json(
        { error: 'Package installation history is unavailable' },
        503,
      );
    return c.json(history);
  });

  app.get('/', async (c) => {
    const readEntries = () => {
      const inventory = scanInstalledPluginInventory(pluginsDir, logger);
      const selected = deps.packageMcpJournal?.selectedInstallations();
      if (selected?.state === 'unavailable')
        throw new Error('Plugin installation inventory unavailable');
      const entries = new Map(
        inventory.map((entry) => [entry.directoryName, entry]),
      );
      for (const installed of selected?.installations ?? []) {
        try {
          const catalog = readPluginCatalogInstallation(
            pluginsDir,
            installed.pluginId,
            deps.packageMcpJournal,
          );
          if (!catalog) throw new Error('Selected installation is unavailable');
          entries.set(installed.pluginId, {
            state: 'valid',
            directoryName: installed.pluginId,
            manifest: catalog.manifest,
          });
        } catch (error) {
          entries.set(installed.pluginId, {
            state: 'rejected',
            directoryName: installed.pluginId,
            rejection: describePluginManifestRejection(error),
          });
        }
      }
      return entries;
    };
    try {
      // Git is only display metadata. Await it before the final synchronous
      // installation projection, so selection/readiness cannot stale across it.
      const gitObservations = new Map<
        string,
        {
          root: string;
          digest: string;
          git: Awaited<ReturnType<typeof getPluginGitInfo>>;
        }
      >();
      for (const entry of readEntries().values()) {
        if (entry.state !== 'valid') continue;
        try {
          const catalog = readPluginCatalogInstallation(
            pluginsDir,
            entry.directoryName,
            deps.packageMcpJournal,
          );
          if (!catalog) continue;
          const git = await getPluginGitInfo(catalog.packageRoot, logger);
          gitObservations.set(entry.directoryName, {
            root: catalog.packageRoot,
            digest: catalog.artifact.digest,
            git,
          });
        } catch {
          /* Final projection below owns the current bounded rejection. */
        }
      }
      const plugins = [];
      for (const entry of readEntries().values()) {
        if (entry.state === 'rejected') {
          plugins.push(rejectedInstalledPluginRecord(entry));
          continue;
        }
        try {
          const catalog = readPluginCatalogInstallation(
            pluginsDir,
            entry.directoryName,
            deps.packageMcpJournal,
          );
          if (!catalog) throw new Error('Selected installation is unavailable');
          const manifest = catalog.manifest;
          const observation = gitObservations.get(entry.directoryName);
          const git =
            observation?.root === catalog.packageRoot &&
            observation.digest === catalog.artifact.digest
              ? observation.git
              : undefined;
          const declared = requiredPermissionsForManifest(manifest);
          const grantState = readPluginGrantState(
            projectHomeDir,
            manifest.name,
            catalog.artifact,
          );
          const granted = grantState.granted;
          plugins.push({
            name: manifest.name,
            displayName: manifest.displayName,
            version: manifest.version,
            description: manifest.description,
            installationReadiness: catalog.readiness,
            hasBundle:
              catalog.readiness.state === 'ready' &&
              existsSync(join(catalog.packageRoot, 'dist', 'bundle.js')),
            ...(catalog.retained ? { retainedOnRemoval: true } : {}),
            hasSettings:
              catalog.readiness.state === 'ready' &&
              Array.isArray(manifest.settings) &&
              manifest.settings.length > 0,
            layout: manifest.layout,
            workspacePanes: manifest.workspacePanes,
            agents: manifest.agents,
            providers: manifest.providers,
            links: manifest.links,
            git,
            permissions: {
              declared,
              granted,
              missing: declared
                .filter((permission) => !granted.includes(permission))
                .map((permission) => ({
                  permission,
                  tier: getPermissionTier(permission),
                })),
              contentBinding: grantState.binding,
              withheld: grantState.withheld,
            },
          });
        } catch (error) {
          if (error instanceof PluginGrantsUnavailableError) throw error;
          plugins.push(
            rejectedInstalledPluginRecord({
              state: 'rejected',
              directoryName: entry.directoryName,
              rejection: describePluginManifestRejection(error),
            }),
          );
        }
      }
      return c.json({ plugins });
    } catch (error) {
      if (error instanceof PluginGrantsUnavailableError)
        return c.json(
          {
            success: false,
            error: 'Plugin permissions are unavailable',
            grantsUnavailable: true,
          },
          503,
        );
      return c.json(
        { success: false, error: 'Plugin installation inventory unavailable' },
        503,
      );
    }
  });

  const recoveryDependencies: PluginInstallSharedDeps = {
    agentsDir,
    pluginsDir,
    projectHomeDir,
    logger,
    eventBus,
    installationHost: deps.installationHost,
    registryTrustPolicyAuthority: deps.registryTrustPolicyAuthority,
    packageMcpJournal: deps.packageMcpJournal,
    buildPlugin: (directory, name, manifest) =>
      buildPlugin(directory, name, logger, manifest),
    settleProviderAdapterRetirements,
    reconcileEngineConnections,
    quiesceEventSubscriptions,
  };
  app.get('/:name/recovery-preview', async (c) => {
    try {
      return c.json(
        await previewInstalledPluginRecovery(
          param(c, 'name'),
          recoveryDependencies,
        ),
      );
    } catch (error) {
      return c.json(
        { success: false, error: errorMessage(error) },
        error instanceof PluginGrantsUnavailableError
          ? 503
          : error instanceof AggregateError
            ? 500
            : 409,
      );
    }
  });
  app.post('/:name/recover', validate(pluginRecoverySchema), async (c) => {
    try {
      const body = getBody(c);
      const mutation = await capturePluginConfigurationMutation(
        applyConfigurationMutation,
        async (beginMutation, _activation, activationSession) =>
          recoverInstalledPlugin(
            param(c, 'name'),
            {
              ...recoveryDependencies,
              beginConfigurationMutation: beginMutation,
              activationSession,
            },
            {
              recoveryRevision: body.recoveryRevision,
              consent: {
                ...body.consent,
                kind: 'operator-decision',
                dependencies: body.consent.dependencies ?? [],
              },
            },
          ),
        { rediscoverSkills: true },
      );
      return c.json(
        {
          ...mutation.value,
          success: mutation.activation?.status !== 'pending',
          ...configurationActivationPayload(mutation.activation),
        },
        configurationMutationStatus(mutation.activation, 200),
      );
    } catch (error) {
      return c.json(
        { success: false, error: errorMessage(error) },
        error instanceof PluginGrantsUnavailableError
          ? 503
          : error instanceof AggregateError
            ? 500
            : 409,
      );
    }
  });

  app.post('/preview', validate(pluginPreviewSchema), async (c) => {
    try {
      const grantRevisions = observePluginGrantRevisions(projectHomeDir);
      const { source: bodySource, registryId } = getBody(c);
      let source = bodySource;
      // The Registry view previews by catalog id: its listings carry provider
      // labels, not source paths, so the server resolves the id through the
      // same registry providers the install itself would use. `code` lets a
      // caller distinguish "this id is not a plugin" (an agent-face entry it
      // should install as before) from a broken plugin source.
      if (!source && registryId) {
        const resolved = await resolvePluginRegistrySource(registryId);
        if (!resolved) {
          return c.json(
            {
              valid: false,
              error: `Plugin '${registryId}' not found in registry`,
              code: 'registry-plugin-not-found',
              components: [],
              conflicts: [],
            },
            404,
          );
        }
        source = resolved;
      }
      if (!source) {
        return c.json(
          {
            valid: false,
            error: 'source or registryId is required',
            components: [],
            conflicts: [],
          },
          400,
        );
      }

      const result = await fetchPluginSource(source, pluginsDir, logger);
      if ('error' in result) {
        return c.json({
          valid: false,
          error: result.error,
          components: [],
          conflicts: [],
        });
      }

      const { tempDir } = result;
      try {
        const { manifest, format } = await readPluginManifestFileWithFormat(
          join(tempDir, 'plugin.json'),
        );
        // Preview refuses exactly what install refuses, through the SAME scan
        // (`collectPluginPromptFiles`). A preview that reported "valid" for a
        // plugin the installer will reject is worse than refusing late: the
        // user approves it on the strength of a look that never happened.
        const blockedPromptFiles = scanPluginPromptFileSafety(
          tempDir,
          manifest.name,
        );
        if (blockedPromptFiles.length > 0) {
          return c.json(
            {
              valid: false,
              error: `Blocked potentially unsafe context in prompt files for plugin '${manifest.name}'.`,
              findings: blockedPromptFiles,
              components: [],
              conflicts: [],
            },
            400,
          );
        }
        const conflicts = [
          ...detectPluginConflicts(manifest, agentsDir, pluginsDir, logger),
          ...detectWorkspacePaneCatalogConflicts(manifest, projectHomeDir),
        ];
        const components: Array<{
          type: string;
          id: string;
          detail?: string;
          conflict?: (typeof conflicts)[0];
          skippable?: boolean;
        }> = [];

        for (const agent of manifest.agents || []) {
          const slug = agent.slug;
          const conflict = conflicts.find(
            (entry) => entry.type === 'agent' && entry.id === slug,
          );
          components.push({
            type: 'agent',
            id: slug,
            detail: agent.source,
            conflict,
          });
        }

        if (manifest.layout) {
          const conflict = conflicts.find(
            (entry) =>
              entry.type === 'layout' && entry.id === manifest.layout?.slug,
          );
          components.push({
            type: 'layout',
            id: manifest.layout.slug,
            detail: manifest.layout.source,
            conflict,
          });
        }

        for (const pane of manifest.workspacePanes ?? []) {
          const conflict = conflicts.find(
            (entry) => entry.type === 'pane' && entry.id === pane.id,
          );
          components.push({
            type: 'pane',
            id: pane.id,
            detail: `${pane.renderer.kind}:${pane.rendererId}`,
            conflict,
            skippable: false,
          });
        }

        for (const provider of manifest.providers || []) {
          components.push({
            type: 'provider',
            id: provider.type,
            detail: provider.module,
          });
        }

        for (const toolId of manifest.integrations?.required || []) {
          const installed = existsSync(
            join(projectHomeDir, 'integrations', toolId, 'integration.json'),
          );
          components.push({
            type: 'tool',
            id: toolId,
            detail: installed ? 'already installed' : 'will install',
          });
        }

        const dependencies = await resolvePluginDependencies(
          manifest,
          pluginsDir,
          () => ({
            // A READ route, so it hands the resolver an installer that cannot
            // install (archive#4288, review LOW). `resolvePluginDependencies`
            // only ever calls `listAvailable`, and this closure used to carry
            // a live provider install anyway — inert today, and a loaded gun
            // for whoever adds a call to it. The refusal names the route so
            // the mistake reads as a mistake rather than a provider outage.
            async install(id: string): Promise<never> {
              throw new Error(
                `Plugin preview must not install ${id}: /preview stages and reports, it never mutates.`,
              );
            },
            async listAvailable() {
              const entries = await Promise.all(
                getPluginRegistryProviders().map((entry) =>
                  entry.provider.listAvailable(),
                ),
              );
              return entries.flat();
            },
          }),
          logger,
          undefined,
          source,
        );
        const git = await getPluginGitInfo(tempDir, logger);
        // archive#4288: the preview already staged and validated everything a
        // consent decision needs, and then threw it away. It now RETURNS it,
        // so the operator can be asked before `POST /install` writes anything
        // — and so the answer can be bound to these exact bytes.
        const consentBasis = derivePluginConsentBasis(tempDir, manifest);
        if (consentBasis === null) {
          return c.json(
            {
              valid: false,
              error: `Plugin '${manifest.name}' source could not be read`,
              components: [],
              conflicts: [],
            },
            400,
          );
        }

        const installationRevision =
          format !== 'agent-plugin-1.0'
            ? undefined
            : deps.installationHost
              ? await (await deps.installationHost.service()).inspect(
                  manifest.name,
                )
              : deps.packageMcpJournal
                ? await localPluginInstallationState(
                    deps.packageMcpJournal,
                  ).current(manifest.name)
                : undefined;
        return c.json({
          valid: true,
          manifest,
          installationRevision,
          grantRevision: grantRevisions.revisionFor(manifest.name),
          existingDataScope: installationRevision != null,
          components,
          conflicts,
          dependencies: dependencies.map((entry) => ({
            ...entry,
            ...(entry.consent
              ? {
                  consent: {
                    ...entry.consent,
                    grantRevision: grantRevisions.revisionFor(entry.id),
                  },
                }
              : {}),
          })),
          git,
          contentDigest: consentBasis.contentDigest,
          permissions: {
            required: consentBasis.required,
            autoGranted: consentBasis.autoGranted,
            pendingConsent: consentBasis.pendingConsent,
          },
        });
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    } catch (error: unknown) {
      if (error instanceof PluginPreviewUnsupportedDependencyError) {
        return c.json(
          {
            valid: false,
            error: errorMessage(error),
            code: 'unsupported-plugin-dependency',
            components: [],
            conflicts: [],
          },
          400,
        );
      }
      if (isContextSafetyError(error)) {
        return c.json(
          {
            valid: false,
            error: error.message,
            findings: error.findings,
            components: [],
            conflicts: [],
          },
          400,
        );
      }
      return c.json(
        {
          valid: false,
          error: errorMessage(error),
          components: [],
          conflicts: [],
        },
        500,
      );
    }
  });

  app.post('/install', validate(pluginInstallSchema), async (c) => {
    try {
      const { source, skip, consent, dataPolicy, expectedInstallation } =
        getBody(c);
      // archive#4288. Refused before the source is even staged: this route is
      // how an operator admits a plugin's code into the shell's own document,
      // and the permission derivation cannot see the contributions that run
      // there (`layout`, `workspacePanes`, `entrypoint`, `agents` — eight of
      // eleven). So the decision is required unconditionally rather than only
      // when the derivation happens to produce something, and what it binds is
      // the DIGEST of the reviewed bytes, which covers every contribution.
      if (!consent) {
        return c.json(
          {
            success: false,
            error:
              'Plugin installs need an approval taken before anything is written. Preview the plugin, then install it from that preview.',
            consent: { reason: 'missing' },
          },
          400,
        );
      }
      const operatorDecision: PluginInstallConsent = {
        kind: 'operator-decision',
        grantRevision: consent.grantRevision,
        permissions: consent.permissions,
        contentDigest: consent.contentDigest,
        dependencies: consent.dependencies ?? [],
        ...(consent.dependencyApprovals
          ? { dependencyApprovals: consent.dependencyApprovals }
          : {}),
      };
      const mutation = await capturePluginConfigurationMutation(
        applyConfigurationMutation,
        async (beginMutation, _activation, activationSession) => {
          const installed = await installPluginFromSource(
            source,
            skip,
            {
              agentsDir,
              registryTrustPolicyAuthority: deps.registryTrustPolicyAuthority,
              packageMcpJournal: deps.packageMcpJournal,
              installationHost: deps.installationHost,
              beginConfigurationMutation: beginMutation,
              buildPlugin: (pluginDir, name, manifest) =>
                buildPlugin(pluginDir, name, logger, manifest),
              eventBus,
              logger,
              pluginsDir,
              projectHomeDir,
              settleProviderAdapterRetirements,
              reconcileEngineConnections,
              quiesceEventSubscriptions,
            },
            {
              consent: operatorDecision,
              dataPolicy,
              expectedInstallation,
              activationSession,
            },
          );
          return installed;
        },
        { rediscoverSkills: true },
      );
      if (mutation.value.success) {
        try {
          refreshKitObservability?.();
        } catch (error: unknown) {
          logger.warn('Kit observability refresh failed after plugin install', {
            error: errorMessage(error),
          });
        }
      }
      return c.json(
        {
          ...mutation.value,
          success: mutation.activation?.status !== 'pending',
          ...configurationActivationPayload(mutation.activation),
        },
        configurationMutationStatus(mutation.activation, 200),
      );
    } catch (error: unknown) {
      if (error instanceof PluginInstallationPending)
        return c.json(
          {
            success: false,
            error: errorMessage(error),
            lifecycle: {
              status: 'pending',
              selected: error.selected,
              code: error.code,
            },
          },
          202,
        );

      if (isContextSafetyError(error)) {
        return c.json(
          {
            success: false,
            error: error.message,
            findings: error.findings,
          },
          400,
        );
      }
      if (isPluginConsentRefusedError(error)) {
        // 400 and not 500: the request and the plugin disagree about what was
        // approved. Earlier dependency effects may already have been rolled
        // back. A 400 does not claim the request performed no earlier writes.
        // Failed rollback remains an aggregate and must not be reported as 400.
        logger.warn(
          'Plugin install refused: consent did not cover the source',
          {
            plugin: error.pluginName,
            reason: error.reason,
          },
        );
        return c.json(
          {
            success: false,
            // Through the route-catch sanitizer like every other outward
            // message here, not raw: this sentence names the plugin, and a
            // plugin's name comes from its own manifest.
            error: errorMessage(error),
            consent: {
              reason: error.reason,
              required: error.required,
              consented: error.consented,
            },
          },
          400,
        );
      }
      const lockCycle = findPluginContentLockCycleError(error);
      if (lockCycle) {
        // 409, not 500: this is refused concurrency, not a broken install.
        // Another plugin operation holds a content lock this one needs, and
        // the acquisition was refused rather than allowed to deadlock, so
        // retrying once that operation finishes is the right move. It says
        // nothing about what this request had already done before the
        // refusal — dependencies installed ahead of it are rolled back by the
        // install's own failure path, which is changed and reverted, not
        // untouched. A 500 with the sentence buried in it tells the operator
        // none of that.
        logger.warn('Plugin install refused: plugin content lock cycle', {
          plugins: lockCycle.plugins,
          cycle: lockCycle.cycle,
        });
        return c.json(
          {
            success: false,
            error: pluginContentLockCycleMessage(lockCycle),
            lockCycle: lockCycle.plugins,
          },
          409,
        );
      }
      logger.error('Plugin install failed', { error: errorMessage(error) });
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });
}
