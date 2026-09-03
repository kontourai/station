import {
  STATION_AGENT_PLUGIN_EXTENSION_ID,
  type StationAgentPluginExtensionV1,
} from './agent-plugin.js';
import type { KnowledgeNamespaceConfig } from './knowledge.js';
import type {
  OperationalEventProjection,
  OperationalEventScope,
} from './operational-event.js';
import type { WorkspacePaneDescriptor } from './workspace-pane.js';

/**
 * Canonical persisted plugin identity. Plugin directories and registry aliases
 * use this exact path-safe lowercase identifier rather than accepting a second
 * broader spelling at their storage boundary.
 */
export const CANONICAL_PLUGIN_ID_PATTERN =
  /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;

export function isCanonicalPluginId(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_PLUGIN_ID_PATTERN.test(value);
}

/** Plugin permission consent tier. */
export type PermissionTier = 'passive' | 'active' | 'trusted';

/**
 * The tier of each built-in plugin permission.
 *
 * This lived in the server's `plugin-permissions.ts` while enforcement was
 * the only thing that needed it. The permission REVIEW surface needs the
 * same answer (station#3815) — and a second copy would be worse than
 * useless here, because the tier is exactly what decides whether a
 * permission is routed through the isolated host approval page. A display
 * that disagreed with enforcement would tell someone a grant is Passive
 * while the server treats it as Trusted.
 *
 * It is static data about a permission, not per-request state, so it lives
 * with the type it describes rather than being threaded through a payload.
 */
export const PERMISSION_TIERS: Record<string, PermissionTier> = {
  'navigation.dock': 'passive',
  // Interrupting the user is an ACTIVE capability, not a passive one: the
  // shell's confirm chrome is a focus-trapping, full-viewport overlay
  // rendered in Station's own authority, and the requesting plugin supplies
  // its body text. That needs the user's explicit yes at install, not an
  // auto-grant. (Absent from this table it would read `trusted`, which is
  // stricter still but the wrong shape — this is not host-level authority.)
  'ui.confirm': 'active',
  'network.fetch': 'active',
  'agents.invoke': 'active',
  'tools.invoke': 'active',
  'events.subscribe': 'trusted',
  'events.read-payload': 'trusted',
  'providers.register': 'trusted',
  'plugin.server': 'trusted',
  'system.config': 'trusted',
};

/**
 * An unknown permission reads as `trusted` — the cautious answer. A plugin
 * declaring something outside this vocabulary gets the strictest handling
 * (isolated host approval to grant), never the most permissive.
 */
export function permissionTier(permission: string): PermissionTier {
  // The lookup value is validated rather than defaulted, because a plain
  // object literal answers Object's inherited keys: `PERMISSION_TIERS['__proto__']`
  // is `Object.prototype`, so `?? 'trusted'` never fires and the tier reads as
  // neither passive nor trusted -- slipping a manifest-declared `"__proto__"`
  // permission past the trusted-tier host-approval refusal. Permission names
  // come from a plugin manifest, so those keys are in the input space.
  //
  // Written as an explicit membership test rather than `Object.hasOwn`, which
  // needs the ES2022 lib that two packages compiling these sources do not
  // target.
  const tier = PERMISSION_TIERS[permission];
  return tier === 'passive' || tier === 'active' || tier === 'trusted'
    ? tier
    : 'trusted';
}

export interface PluginProviderEntry {
  type: string;
  module: string;
  layout?: string;
}

export interface PluginDependency {
  id: string;
  source?: string;
}

export interface PluginSettingField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'select';
  description?: string;
  default?: string | number | boolean;
  options?: Array<{ label: string; value: string }>;
  secret?: boolean;
  required?: boolean;
}

export const PLUGIN_COMMAND_EXECUTION_SCHEMA_VERSION =
  'station.plugin-command-execution/v1' as const;

export type PluginCommandResolvedTarget =
  | { kind: 'surface'; surfaceId: string }
  | { kind: 'composer'; sessionId: string };

/** Client-visible host facts bound into admission and rechecked before effect. */
export interface PluginCommandResolvedContext {
  activeChatSessionId?: string;
  projectSlug?: string;
  sessionId?: string;
  taskId?: string;
}

/** Browser intent admitted by the host before a local palette effect. */
export interface PluginCommandExecutionRequest {
  schemaVersion: typeof PLUGIN_COMMAND_EXECUTION_SCHEMA_VERSION;
  requestId: string;
  pluginId: string;
  pluginVersion: string;
  commandGeneration: string;
  commandId: string;
  target: PluginCommandResolvedTarget;
  context: PluginCommandResolvedContext;
}

/** Durable operational-event receipt. No command input or composer text. */
export interface PluginCommandExecutionReceipt {
  schemaVersion: typeof PLUGIN_COMMAND_EXECUTION_SCHEMA_VERSION;
  receiptId: string;
  requestId: string;
  pluginId: string;
  pluginVersion: string;
  commandGeneration: string;
  commandId: string;
  target: PluginCommandResolvedTarget;
  actor: import('./client-origin.js').ClientOriginActor;
  reportedSurface: import('./client-origin.js').ClientOriginSurface;
  decision: 'authorized';
  outcome: 'admitted';
  recordedAt: string;
}

/** Other Agent Plugins extension namespaces remain opaque to Station. */
export interface PluginExtensions {
  [STATION_AGENT_PLUGIN_EXTENSION_ID]?: StationAgentPluginExtensionV1;
  [namespace: string]: unknown;
}

export type PluginOperationalEventProjection = 'metadata' | 'envelope';

/**
 * Inert manifest declaration. Station derives subscriber class, consumer
 * identity, permission grants, and the effective projection at runtime.
 */
export interface PluginOperationalEventSubscriptionEntry {
  id: string;
  version: string;
  eventTypes: string[];
  requiredScopes?: OperationalEventScope[];
  projection?: PluginOperationalEventProjection;
}

export type PluginOperationalEventObservationOutcome =
  | { kind: 'accepted' }
  | { kind: 'retry'; failureCode: string }
  | { kind: 'rejected'; failureCode: string };

/** Public server-module Adapter implemented by a trusted plugin. */
export interface PluginOperationalEventObserver {
  observe(input: {
    subscriptionId: string;
    projection: OperationalEventProjection;
    idempotencyKey: string;
    attempt: number;
    signal: AbortSignal;
  }): Promise<PluginOperationalEventObservationOutcome>;
}

/**
 * Closed invocation used by Station to resolve one owner-qualified reviewed
 * source.  `exactRef` and the association ids are opaque: Station preserves
 * their equality but never parses Fieldwork/Forage identifiers or adopts a
 * source owner's storage schema.
 */
export interface ReviewedSourcesInvocation {
  version: 'station.reviewed-sources/v1';
  operation: 'describe' | 'currentness';
  /** Exact manifest identity, not a display name or inferred owner. */
  pluginName: string;
  projectId: string;
  exactRef: string;
  assessment: {
    revision: number;
    sourceClaimId: string;
    sourceEvidenceId: string;
    answerClaimId: string;
    answerCitationEvidenceId: string;
  };
}

/**
 * A plugin supplies the owner payload as an opaque, versioned envelope.  A
 * restricted result is intentionally bare: consumers must not learn whether a
 * protected source, run, locator, or review exists.
 */
export type ReviewedSourcesResult =
  | {
      version: 'station.reviewed-sources/v1';
      status: 'available';
      payload: unknown;
    }
  | {
      version: 'station.reviewed-sources/v1';
      status:
        | 'restricted'
        | 'missing'
        | 'corrupt'
        | 'unsupported'
        | 'unavailable';
    };

/** Optional trusted server-module capability; it has no registration side effect. */
export interface PluginReviewedSourcesModule {
  readReviewedSource(
    input: ReviewedSourcesInvocation,
    context: { projectHomeDir: string },
  ): Promise<ReviewedSourcesResult>;
}

export interface PluginManifest {
  name: string;
  version: string;
  sdkVersion?: string;
  displayName?: string;
  description?: string;
  entrypoint?: string;
  serverModule?: string;
  build?: string;
  capabilities?: string[];
  permissions?: string[];
  links?: unknown;
  agents?: Array<{ slug: string; source: string }>;
  layout?: { slug: string; source: string };
  layouts?: Array<{ slug: string; source: string }>;
  /** Versioned, inert Pane declarations parsed before any renderer can load. */
  workspacePanes?: WorkspacePaneDescriptor[];
  /** Versioned declarations whose execution remains host-authorized. */
  operationalEventSubscriptions?: PluginOperationalEventSubscriptionEntry[];
  providers?: PluginProviderEntry[];
  integrations?: { required?: string[] };
  tools?: { required?: string[] };
  dependencies?: PluginDependency[];
  knowledge?: { namespaces: KnowledgeNamespaceConfig[] };
  prompts?: { source: string };
  skills?: string[];
  settings?: PluginSettingField[];
  /** Agent Plugins host overlays. Station reads only its reserved namespace. */
  extensions?: PluginExtensions;
}

export interface PluginOverrideConfig {
  disabled?: string[];
  settings?: Record<string, string | number | boolean>;
}

export type PluginOverrides = Record<string, PluginOverrideConfig>;

export interface ConflictInfo {
  type: 'agent' | 'command' | 'workspace' | 'pane' | 'provider' | 'tool';
  id: string;
  existingSource?: string;
}

export interface PluginComponent {
  type: 'agent' | 'command' | 'workspace' | 'pane' | 'provider' | 'tool';
  id: string;
  detail?: string;
  conflict?: ConflictInfo;
  /** False when omission would change the installed package truth. */
  skippable?: boolean;
}

export interface PluginPreview {
  valid: boolean;
  error?: string;
  manifest?: PluginManifest;
  components: PluginComponent[];
  conflicts: ConflictInfo[];
}
