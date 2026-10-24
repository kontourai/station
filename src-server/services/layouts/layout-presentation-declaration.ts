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

/** What a stored layout record or listing says about who contributed it. */
export interface LayoutDeclarationRecord {
  type?: string;
  /** `LayoutMetadata.plugin`. */
  plugin?: string;
  config?: Record<string, unknown> | null;
  catalogContribution?: {
    provenance: { origin: string; pluginId?: string };
  };
}

export interface LayoutDeclarationSources {
  /**
   * The installed plugin's current, parsed declaration, or `null` when the
   * plugin's layout cannot be read as an installed, enabled contribution.
   */
  pluginDeclaration(pluginName: string): LayoutPresentationDeclaration | null;
  /** Whether the plugin holds {@link LAYOUT_PRIMARY_CHAT_PERMISSION}. */
  pluginHoldsPermission(pluginName: string, permission: string): boolean;
}

const TABS: LayoutPresentationReadFields = Object.freeze({
  presentation: 'tabs',
});

function contributingPlugin(
  layout: LayoutDeclarationRecord,
): string | undefined {
  const configPlugin = layout.config?.plugin;
  if (typeof configPlugin === 'string' && configPlugin.length > 0)
    return configPlugin;
  if (typeof layout.plugin === 'string' && layout.plugin.length > 0)
    return layout.plugin;
  const provenance = layout.catalogContribution?.provenance;
  return provenance?.origin === 'plugin' ? provenance.pluginId : undefined;
}

/**
 * The declaration a layout READ states (#2995): the CONTRIBUTOR's, never the
 * stored record's — so no request body can write a layout a Chat centre.
 *
 * - A read whose plugin binding is withheld from the caller (#2090) states
 *   `tabs` and nothing else: the drill-in ids name the plugin.
 * - A contributed layout states its installed plugin's current declaration,
 *   less `primary` unless the plugin holds `layout.primaryChat`. An
 *   unreadable, disabled or MCP contribution states `tabs`.
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
  const origin = layout.catalogContribution?.provenance.origin;
  const pluginName = contributingPlugin(layout);
  if (pluginName !== undefined) {
    const declared = options.sources.pluginDeclaration(pluginName);
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
  if (origin === 'plugin' || origin === 'mcp') return TABS;
  const builtin = BUILTIN_PROJECT_LAYOUTS.find(
    (candidate) => candidate.type === layout.type,
  );
  return builtin ? builtinLayoutPresentationDeclaration(builtin) : TABS;
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
