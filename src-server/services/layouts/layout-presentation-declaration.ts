import {
  BUILTIN_PROJECT_LAYOUTS,
  builtinLayoutPresentationDeclaration,
  InvalidLayoutDeclarationError,
  LAYOUT_PRIMARY_CHAT_PERMISSION,
  type LayoutPresentationDeclaration,
  type LayoutPresentationReadFields,
  parseLayoutPresentationDeclaration,
} from '@kontourai/station-contracts/layout';
import { enumerateLayoutDefinitionPanes } from '@kontourai/station-contracts/workspace-pane-layout-adapter';

/**
 * The pane ids a plugin layout's own tabs adapt into: the descriptors the
 * Project pane catalog issues for them (`workspace-pane-catalog.ts`, through
 * the same contracts adapter). These are the only drill-ins a plugin layout
 * may declare in this slice; opening another contributor's pane by reference
 * is the later extraction slices' work (design: "Coding capability map").
 */
function pluginLayoutOwnPaneIds(
  definition: unknown,
  pluginName: string,
  layoutSlug: string,
): ReadonlySet<string> {
  const adaptations = enumerateLayoutDefinitionPanes(definition, {
    layoutSlug,
    pluginId: pluginName,
  });
  return new Set(
    (adaptations ?? []).map((adaptation) => adaptation.descriptor.id),
  );
}

/**
 * Parse a plugin layout definition's contract fields, refusing an unknown
 * value or a drill-in that is not one of the layout's own panes. Throws
 * `InvalidLayoutDeclarationError`.
 */
export function parsePluginLayoutDeclaration(
  definition: unknown,
  pluginName: string,
  layoutSlug: string,
): LayoutPresentationDeclaration {
  const ownPaneIds = pluginLayoutOwnPaneIds(definition, pluginName, layoutSlug);
  return parseLayoutPresentationDeclaration(definition, {
    label: `Plugin '${pluginName}' layout`,
    resolvesDrillIn: (paneId) => ownPaneIds.has(paneId),
  });
}

/**
 * The install-time refusal (#2995): a plugin whose layout declaration does
 * not parse, or that claims `primary: 'chat'` without requesting
 * `layout.primaryChat` in its manifest — a claim that could then never be
 * granted — is not installed. Throws `InvalidLayoutDeclarationError`.
 */
export function assertInstallablePluginLayoutDeclaration(
  definition: unknown,
  plugin: {
    name: string;
    layoutSlug: string;
    requestedPermissions: readonly string[];
  },
): LayoutPresentationDeclaration {
  const declaration = parsePluginLayoutDeclaration(
    definition,
    plugin.name,
    plugin.layoutSlug,
  );
  if (
    declaration.primary === 'chat' &&
    !plugin.requestedPermissions.includes(LAYOUT_PRIMARY_CHAT_PERMISSION)
  ) {
    throw new InvalidLayoutDeclarationError(
      `Plugin '${plugin.name}' layout`,
      `primary 'chat' needs the '${LAYOUT_PRIMARY_CHAT_PERMISSION}' permission in the plugin manifest`,
    );
  }
  return declaration;
}

/** What a stored layout record says about who contributed it. */
export interface LayoutDeclarationRecord {
  type?: string;
  /** `LayoutMetadata.plugin`: a listing's copy of `config.plugin`. */
  plugin?: string;
  config?: Record<string, unknown> | null;
  /**
   * The server-owned attribution the catalog apply path records. Create and
   * update strip it from request bodies, so it is the only fact here a client
   * cannot write.
   */
  catalogContribution?: {
    id?: string;
    provenance: { origin: string; pluginId?: string };
  };
}

export interface LayoutDeclarationSources {
  /**
   * The installed plugin's current, parsed declaration for the catalog item
   * `contributionId`, or `null` when that item is not an installed, enabled
   * layout of `pluginName`.
   */
  pluginDeclaration(
    pluginName: string,
    contributionId: string | undefined,
  ): LayoutPresentationDeclaration | null;
  /** Whether the plugin holds {@link LAYOUT_PRIMARY_CHAT_PERMISSION}. */
  pluginHoldsPermission(pluginName: string, permission: string): boolean;
}

const TABS: LayoutPresentationReadFields = Object.freeze({
  presentation: 'tabs',
});

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The declaration a layout READ states (#2995): the CONTRIBUTOR's, never the
 * stored record's — so no request body can write a layout a Chat centre.
 *
 * The contributor is decided from server-owned provenance only
 * (`catalogContribution.provenance`, issued by catalog apply). `config.plugin`
 * is client-writable (create and update accept it), so it never selects a
 * plugin's declaration:
 *
 * - A read whose plugin binding is withheld from the caller (#2090) states
 *   `tabs` and nothing else: the drill-in ids name the plugin.
 * - A record attributed to a plugin states that plugin's current declaration
 *   for the attributed catalog item, less `primary` unless the plugin holds
 *   `layout.primaryChat`. A `config.plugin` naming any other plugin makes the
 *   record contradict its attribution, and it states `tabs`.
 * - A record that names a plugin without attribution (hand-written, or from
 *   before attribution was recorded) states `tabs`: nothing the server
 *   issued vouches for the binding. MCP contributions state `tabs`.
 * - Anything else states the declaration of the built-in starter of its
 *   `type` (Coding's `primary: 'chat'`, `presentation: 'stack'` and
 *   drill-ins), or `tabs`.
 *
 * Every answer states `presentation`, which is how a reader tells this
 * server's answer from an older server's record that states nothing.
 */
export function resolveLayoutReadDeclaration(
  layout: LayoutDeclarationRecord,
  options: { withheld: boolean; sources: LayoutDeclarationSources },
): LayoutPresentationReadFields {
  if (options.withheld) return TABS;
  const provenance = layout.catalogContribution?.provenance;
  const claimedPlugin =
    nonEmpty(layout.config?.plugin) ?? nonEmpty(layout.plugin);
  if (provenance?.origin === 'plugin') {
    const pluginName = nonEmpty(provenance.pluginId);
    if (!pluginName) return TABS;
    if (claimedPlugin !== undefined && claimedPlugin !== pluginName)
      return TABS;
    const declared = options.sources.pluginDeclaration(
      pluginName,
      layout.catalogContribution?.id,
    );
    if (!declared) return TABS;
    const granted =
      declared.primary === 'chat' &&
      options.sources.pluginHoldsPermission(
        pluginName,
        LAYOUT_PRIMARY_CHAT_PERMISSION,
      );
    return {
      ...(granted ? { primary: 'chat' as const } : {}),
      presentation: declared.presentation ?? 'tabs',
      ...(declared.drillIns ? { drillIns: [...declared.drillIns] } : {}),
    };
  }
  if (provenance?.origin === 'mcp' || claimedPlugin !== undefined) return TABS;
  const builtin = BUILTIN_PROJECT_LAYOUTS.find(
    (candidate) => candidate.type === layout.type,
  );
  return builtin ? builtinLayoutPresentationDeclaration(builtin) : TABS;
}

/**
 * Declaration sources for ONE request: the catalog listing, each plugin's
 * parsed declaration and each grant are read at most once, however many
 * layout rows the request answers.
 */
export function memoizeLayoutDeclarationSources(
  sources: LayoutDeclarationSources,
): LayoutDeclarationSources {
  const declarations = new Map<string, LayoutPresentationDeclaration | null>();
  const grants = new Map<string, boolean>();
  return {
    pluginDeclaration(pluginName, contributionId) {
      const key = JSON.stringify([pluginName, contributionId ?? null]);
      if (!declarations.has(key))
        declarations.set(
          key,
          sources.pluginDeclaration(pluginName, contributionId),
        );
      return declarations.get(key) ?? null;
    },
    pluginHoldsPermission(pluginName, permission) {
      const key = JSON.stringify([pluginName, permission]);
      if (!grants.has(key))
        grants.set(key, sources.pluginHoldsPermission(pluginName, permission));
      return grants.get(key) === true;
    },
  };
}

/**
 * The declaration fields are response-only. Stripped from every write body
 * so a GET→PUT round trip is not refused by the `.strict()` store, and so a
 * client cannot persist a claim (`paneReferences` is stripped the same way).
 */
export function withoutClientLayoutDeclaration<
  T extends Record<string, unknown>,
>(value: T): Omit<T, 'primary' | 'presentation' | 'drillIns'> {
  const {
    primary: _primary,
    presentation: _presentation,
    drillIns: _drillIns,
    ...rest
  } = value;
  return rest;
}
