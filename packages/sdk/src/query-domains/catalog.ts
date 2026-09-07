import type {
  InstallResult,
  RegistryItem,
} from '@kontourai/station-contracts/catalog';
import type { LayoutCatalogItem } from '@kontourai/station-contracts/distribution';
import type { LayoutComponentRef } from '@kontourai/station-contracts/layout';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import {
  type MutationOptions,
  type QueryConfig,
  useApiMutation,
  useApiQuery,
} from '../query-core';
import {
  fetchKitLayout,
  fetchKitRegistry,
  fetchRegistryItems,
  type KitLayoutProjection,
  type KitRegistryEntry,
  type KitStandardView,
  requestIntegration,
  requestRegistryCatalogAction,
  requestRegistryIntegrationAction,
  requestRegistryLayoutAction,
} from './catalogRequests';

interface IntegrationRegistryActionInput {
  id: string;
  action: 'install' | 'uninstall';
}

interface RegistryActionInput {
  id: string;
  action: 'install' | 'uninstall';
  /**
   * Operator pre-install decision for a registry entry that resolves as a
   * PLUGIN (station#4288). A JSON-manifest registry serves its plugin catalog
   * through the agent face too, and the server refuses a code-contributing
   * plugin without a decision — so the Registry view previews the entry's
   * source and carries the answer here. Ignored for plain agent installs.
   */
  consent?: {
    permissions: string[];
    contentDigest: string;
    dependencies: string[];
    dependencyApprovals?: Array<{
      id: string;
      permissions: string[];
      contentDigest: string;
      dependencies: string[];
    }>;
  };
  /** Preview conflict components to skip, as `type:id` keys. */
  skip?: string[];
}

export interface LayoutRegistryActionInput {
  id: string;
  action: 'install' | 'remove' | 'enable' | 'disable';
}

/**
 * `icon` is inherited from `ToolDef`: a glyph or local raster-path input. UI
 * consumers receive the resolved same-origin `iconUrl` only when it is valid.
 */
export interface IntegrationViewModel extends ToolDef {
  /** Names of configured secret env vars; values and backing refs never cross the API. */
  secretEnvKeys?: string[];
  /** Same-origin, output-only URL for Station-validated local raster art. */
  iconUrl?: string;
  source?: string;
  plugin?: string;
  /**
   * Server-derived: this tool server is registered by the Station runtime and
   * re-created on every start (audit CI-R7). Never inferred client-side from
   * `kind` — both built-ins persist as `kind: 'mcp'`.
   */
  builtin?: boolean;
  usedBy?: string[];
  connected?: boolean;
  tools?: Array<{ name: string; description?: string }>;
  /** Per-server MCP-UI render permission (S2). Default true; false when revoked. */
  renderAllowed?: boolean;
  /**
   * True when this tool server's `ToolDef.env` declares one or more entries
   * (never the values themselves — `GET /integrations` never sends raw
   * `env`). Consumers (e.g. the ACP MCP-passthrough tool-server picker,
   * docs/design/connections-onboarding.md §5) must treat this as
   * non-passthrough-eligible: secrets never cross the ACP trust boundary.
   */
  requiresEnvSecrets?: boolean;
}

export interface IntegrationLifecycleResult extends IntegrationViewModel {
  live?: boolean;
  restartRequired?: boolean;
  restartRequiredScope?: 'integration' | 'runtime';
  activationError?: string;
  reconciliationError?: string;
}

export type RegistryCatalogTab =
  | 'agents'
  | 'skills'
  | 'integrations'
  | 'plugins'
  | 'layouts'
  | 'kits';

export type {
  KitExperience,
  KitLayoutProjection,
  KitRegistryEntry,
  KitStandardView,
} from './catalogRequests';

/**
 * The host-owned details retained in a project layout. The data is a
 * read-only description of the selected Kit projection, never Kit content or
 * an executable action.
 */
export interface KitProjectLayoutConfig extends Record<string, unknown> {
  kit: {
    contributionRef: string;
    incarnation: number;
    lifecycle: KitRegistryEntry['lifecycle'];
    status: string;
    standardViews: Array<KitStandardView & { tabId: string }>;
  };
  tabs: Array<{
    id: string;
    label: string;
    description: string;
    component: LayoutComponentRef;
  }>;
}

export interface KitProjectLayoutInput {
  slug: string;
  name: string;
  description: string;
  type: 'kit-observability';
  config: KitProjectLayoutConfig;
}

function kitSlugSegment(contributionRef: string): string {
  const normalized = contributionRef
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized.slice(0, 48) || 'contribution';
}

export function canMaterializeKitProjectLayout(
  entry: KitRegistryEntry,
  projection: KitLayoutProjection,
): boolean {
  return (
    entry.lifecycle === 'installed' &&
    entry.experience.status === 'enabled' &&
    Boolean(projection.component || projection.standardViews.length > 0)
  );
}

/**
 * Turns the host-negotiated projection into a normal project LayoutDefinition
 * input. MCP references pass through without rewriting so LayoutRenderer uses
 * its existing hardened MCP frame. Standard views use Station's deliberately
 * inert, read-only builtin renderer.
 */
export function materializeKitProjectLayout(
  entry: KitRegistryEntry,
  projection: KitLayoutProjection,
): KitProjectLayoutInput {
  if (!canMaterializeKitProjectLayout(entry, projection)) {
    throw new Error(
      'This Kit can’t be added to a Project layout until Station enables its read-only view.',
    );
  }

  const standardViews = projection.standardViews.map((view, index) => ({
    ...view,
    tabId: `kit-standard-${index + 1}`,
  }));
  const tabs: KitProjectLayoutConfig['tabs'] = [
    ...(projection.component
      ? [
          {
            id: 'kit-mcp-app',
            label: 'App view',
            description: 'Read-only Kit MCP app view.',
            component: projection.component,
          },
        ]
      : []),
    ...standardViews.map((view) => ({
      id: view.tabId,
      label: view.projection,
      description: `Read-only standard view (${view.schemaRef}).`,
      component: {
        kind: 'builtin-component' as const,
        name: 'kit-standard-view',
      },
    })),
  ];

  return {
    slug: `kit-${kitSlugSegment(entry.contributionRef)}-${entry.incarnation}`,
    name: `Kit: ${entry.contributionRef}`,
    description: 'A read-only Kit view, hosted by Station.',
    type: 'kit-observability',
    config: {
      kit: {
        contributionRef: entry.contributionRef,
        incarnation: entry.incarnation,
        lifecycle: entry.lifecycle,
        status: entry.experience.status,
        standardViews,
      },
      tabs,
    },
  };
}

// The skills domain owns the one authored-asset CRUD/import surface.

export function useRegistryItemsQuery<T = any>(
  tab: RegistryCatalogTab,
  config?: QueryConfig<T[]>,
) {
  return useApiQuery(
    ['registry', tab],
    () => fetchRegistryItems<T>(tab, false),
    {
      ...config,
    },
  );
}

export function useInstalledRegistryItemsQuery<T = any>(
  tab: RegistryCatalogTab,
  config?: QueryConfig<T[]>,
) {
  return useApiQuery(
    ['registry', tab, 'installed'],
    () => fetchRegistryItems<T>(tab, true),
    { ...config },
  );
}

export function useKitRegistryQuery(config?: QueryConfig<KitRegistryEntry[]>) {
  return useApiQuery(['registry', 'kits'], () => fetchKitRegistry(), config);
}

export function useKitLayoutQuery(
  contributionRef: string | undefined,
  config?: QueryConfig<KitLayoutProjection>,
) {
  return useApiQuery(
    ['registry', 'kits', contributionRef ?? '', 'layout'],
    () => fetchKitLayout(contributionRef!),
    {
      ...config,
      enabled: !!contributionRef && (config?.enabled ?? true),
    },
  );
}

export function useIntegrationsQuery(
  config?: QueryConfig<IntegrationViewModel[]>,
) {
  return useApiQuery(
    ['integrations'],
    () => requestIntegration<IntegrationViewModel[]>(''),
    config,
  );
}

export function useIntegrationQuery(
  id: string | undefined,
  config?: QueryConfig<IntegrationViewModel>,
) {
  return useApiQuery(
    id ? ['integrations', id] : ['integrations'],
    () =>
      requestIntegration<IntegrationViewModel>(`/${encodeURIComponent(id!)}`),
    { ...config, enabled: !!id && (config?.enabled ?? true) },
  );
}

export function useSaveIntegrationMutation(
  options?: MutationOptions<void, IntegrationViewModel & { isNew: boolean }>,
) {
  return useApiMutation(
    async (input: IntegrationViewModel & { isNew: boolean }) => {
      // The ordinary integrations projection may carry server-only metadata.
      // In particular, a prior response shape exposed this field, but only
      // the dedicated access:manage projection may author/read it.
      const {
        id,
        isNew,
        secretEnvBindingIds: _secretEnvBindingIds,
        ...data
      } = input as IntegrationViewModel & {
        isNew: boolean;
        secretEnvBindingIds?: unknown;
      };
      await requestIntegration<void>(
        isNew ? '' : `/${encodeURIComponent(id)}`,
        {
          method: isNew ? 'POST' : 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(isNew ? { id, ...data } : data),
        },
      );
    },
    {
      invalidateKeys: [['integrations']],
      // This mutation's variables carry write-only secretEnv material.
      evictSettledVariables: true,
      onSuccess: options?.onSuccess,
      onError: options?.onError,
    },
  );
}

export function useDeleteIntegrationMutation(
  options?: MutationOptions<void, string>,
) {
  return useApiMutation(
    async (id: string) => {
      await requestIntegration<void>(`/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
    },
    {
      invalidateKeys: [['integrations']],
      onSuccess: options?.onSuccess,
      onError: options?.onError,
    },
  );
}

export function useReconnectIntegrationMutation(
  options?: MutationOptions<void, string>,
) {
  return useApiMutation(
    async (id: string) => {
      await requestIntegration<void>(`/${encodeURIComponent(id)}/reconnect`, {
        method: 'POST',
      });
    },
    {
      invalidateKeys: [['integrations']],
      onSuccess: options?.onSuccess,
      onError: options?.onError,
    },
  );
}

export function useSetIntegrationEnabledMutation(
  options?: MutationOptions<
    IntegrationLifecycleResult,
    { id: string; enabled: boolean }
  >,
) {
  return useApiMutation(
    async ({ id, enabled }) =>
      requestIntegration<IntegrationLifecycleResult>(
        `/${encodeURIComponent(id)}/enabled`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled }),
        },
      ),
    {
      invalidateKeys: [['integrations']],
      onSuccess: options?.onSuccess,
      onError: options?.onError,
    },
  );
}

export function useApplyIntegrationToolsMutation(
  options?: MutationOptions<
    IntegrationLifecycleResult,
    { id: string; disabledTools: string[] }
  >,
) {
  return useApiMutation(
    async ({ id, disabledTools }) =>
      requestIntegration<IntegrationLifecycleResult>(
        `/${encodeURIComponent(id)}/tools/apply`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ disabledTools }),
        },
      ),
    {
      invalidateKeys: [['integrations']],
      onSuccess: options?.onSuccess,
      onError: options?.onError,
    },
  );
}

/**
 * Set a server's MCP-UI render permission (S2). `allowRender: false` revokes
 * rendering of that server's UI in layouts; `true` re-allows (the default).
 */
export function useSetIntegrationRenderPermissionMutation(
  options?: MutationOptions<void, { serverId: string; allowRender: boolean }>,
) {
  return useApiMutation(
    async ({
      serverId,
      allowRender,
    }: {
      serverId: string;
      allowRender: boolean;
    }) => {
      await requestIntegration<void>(
        `/${encodeURIComponent(serverId)}/ui/permissions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ allowRender }),
        },
      );
    },
    {
      invalidateKeys: [['integrations']],
      onSuccess: options?.onSuccess,
      onError: options?.onError,
    },
  );
}

export function useRegistryIntegrationsQuery(
  config?: QueryConfig<RegistryItem[]>,
) {
  return useRegistryItemsQuery<RegistryItem>('integrations', config);
}

export function useRegistryIntegrationActionMutation(
  options?: MutationOptions<InstallResult, IntegrationRegistryActionInput>,
) {
  return useApiMutation(
    (input: IntegrationRegistryActionInput) =>
      requestRegistryIntegrationAction(input),
    {
      invalidateKeys: [
        ['registry', 'integrations'],
        ['registry', 'integrations', 'installed'],
        ['integrations'],
      ],
      onSuccess: options?.onSuccess,
      onError: options?.onError,
    },
  );
}

export function useRegistryAgentActionMutation(
  options?: MutationOptions<InstallResult, RegistryActionInput>,
) {
  return useApiMutation(
    (input: RegistryActionInput) =>
      requestRegistryCatalogAction('agents', input),
    {
      invalidateKeys: [
        ['registry', 'agents'],
        ['registry', 'agents', 'installed'],
        ['agents'],
      ],
      onSuccess: options?.onSuccess,
      onError: options?.onError,
    },
  );
}

export function useRegistrySkillActionMutation(
  options?: MutationOptions<InstallResult, RegistryActionInput>,
) {
  return useApiMutation(
    (input: RegistryActionInput) =>
      requestRegistryCatalogAction('skills', input),
    {
      invalidateKeys: [
        ['registry', 'skills'],
        ['registry', 'skills', 'installed'],
        ['skills'],
      ],
      onSuccess: options?.onSuccess,
      onError: options?.onError,
    },
  );
}

/** Runs a layout lifecycle action and refreshes every catalog projection. */
export function useRegistryLayoutActionMutation(
  options?: MutationOptions<LayoutCatalogItem, LayoutRegistryActionInput>,
) {
  return useApiMutation(
    (input: LayoutRegistryActionInput) => requestRegistryLayoutAction(input),
    {
      invalidateKeys: [
        ['registry', 'layouts'],
        ['registry', 'layouts', 'installed'],
        ['projects', 'layouts', 'available'],
      ],
      onSuccess: options?.onSuccess,
      onError: options?.onError,
    },
  );
}
