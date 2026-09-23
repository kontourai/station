import type { PluginCommandContribution } from './agent-plugin.js';
import type { KnowledgeNamespaceConfig } from './knowledge.js';
import type {
  OperationalEventProjection,
  OperationalEventScope,
} from './operational-event.js';
import type { WorkspacePaneDescriptor } from './workspace-pane.js';
import type { WorkspacePaneHostContributionV1 } from './workspace-pane-host-contribution.js';

/**
 * Canonical logical plugin identity. Local adapters derive safe physical keys;
 * filesystem spellings never create a second logical identifier grammar.
 */
export const CANONICAL_PLUGIN_ID_PATTERN =
  /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;

export function isCanonicalPluginId(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_PLUGIN_ID_PATTERN.test(value);
}

/** Plugin permission consent tier. */
export type PermissionTier = 'passive' | 'active' | 'trusted';

export interface PluginPermissionPrompt {
  permission: string;
  tier: PermissionTier;
}

/** Current installed permission truth. Missing dependency status is unknown, not approved. */
export interface PluginInstallPermissionStatus {
  autoGranted: string[];
  consentGranted?: string[];
  pendingConsent: PluginPermissionPrompt[];
  withdrawn?: string[];
  /** Optional for compatibility with servers predating dependency status. */
  dependencies?: Array<{
    id: string;
    pendingConsent: PluginPermissionPrompt[];
  }>;
}

/** Direct and registry plugin-install outcome; older servers may omit status fields. */
export interface PluginInstallResult {
  success: boolean;
  message?: string;
  error?: string;
  plugin?: {
    name: string;
    displayName?: string;
    version: string;
    hasBundle: boolean;
    agents: Array<{ slug: string }>;
  };
  layout?: { slug: string };
  tools?: Array<{ id: string; status: string }>;
  dependencies?: Array<{ id: string; status: string; error?: string }>;
  permissions?: PluginInstallPermissionStatus;
}

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
  /** Exact opaque version, or '*' for any declared version. */
  version?: string;
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
  commands?: PluginCommandContribution[];
  permissions?: string[];
  links?: unknown;
  agents?: Array<{ slug: string; source: string }>;
  layout?: { slug: string; source: string };
  layouts?: Array<{ slug: string; source: string }>;
  /** Versioned, inert Pane declarations parsed before any renderer can load. */
  workspacePanes?: WorkspacePaneDescriptor[];
  /** Inert package-level actions/Agent selection; admission is server-owned. */
  workspacePaneHost?: WorkspacePaneHostContributionV1;
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
}

export type PluginManifestRejectionCode =
  | 'manifest-missing'
  | 'manifest-unreadable'
  | 'malformed-json'
  | 'unsafe-manifest-content'
  | 'invalid-plugin-name'
  | 'reserved-plugin-name'
  | 'missing-version'
  | 'invalid-workspace-panes'
  | 'invalid-manifest';

export interface PluginManifestRejection {
  code: PluginManifestRejectionCode;
  /** Bounded, path-free reason safe for the authenticated Plugins surface. */
  reason: string;
  recovery: {
    kind: 'repair-manifest' | 'restore-manifest' | 'reinstall-plugin';
    instruction: string;
  };
}

/** A directory is visible even when no trustworthy plugin identity can be read. */
export interface RejectedInstalledPluginRecord {
  status: 'rejected';
  /** Directory entry, not a validated plugin identity. */
  name: string;
  displayName: string;
  rejection: PluginManifestRejection;
}

export interface PluginOverrideConfig {
  disabled?: string[];
  settings?: Record<string, string | number | boolean>;
}

export type PluginOverrides = Record<string, PluginOverrideConfig>;

export interface ConflictInfo {
  type: 'agent' | 'layout' | 'pane' | 'provider' | 'tool';
  id: string;
  existingSource?: string;
}

export interface PluginComponent {
  type: 'agent' | 'layout' | 'pane' | 'provider' | 'tool';
  id: string;
  /**
   * Human-readable name the manifest declares for this component (a Pane's
   * `name`). Presentation only; absent when the component declares none.
   */
  name?: string;
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
/** Opaque installation authority observation, distinct from package bytes. */
export interface PluginInstallationRevision {
  readonly scope: string;
  readonly installation: string;
  readonly generation: string;
  readonly artifact: { readonly digest: string };
  readonly materialization: string;
  readonly dataScope: string;
  /** Acquisition-owner scoped continuity token; not authenticated publisher identity. */
  readonly origin?: string;
}

/** Server-observed runtime readiness, independent of install/consent completion. */
export type PluginInstallationReadiness =
  | { readonly state: 'ready' }
  | { readonly state: 'pending'; readonly recovery: 'review' }
  | { readonly state: 'unavailable' };

/**
 * A plugin lifecycle change an agent asked a person to make (#2323 S5).
 *
 * Station's agent tools cannot install, update or remove a plugin: those
 * routes refuse the internal caller class station-control uses. What an agent
 * can do is leave a proposal, which a person opens from Needs attention and
 * completes through the ordinary Plugins flow (preview, consent, install; or
 * the ordinary update or remove confirmation).
 *
 * A proposal carries NO decision authority. Nothing in it is a consent basis:
 * `/install` still requires the preview-derived decision the person gives on
 * the preview, and `proposedContentDigest` is only a comparison point for the
 * "changed since proposed" warning, never an input to the install.
 */
export type PluginLifecycleProposalKind = 'install' | 'update' | 'remove';

export type PluginLifecycleProposalStatus = 'open' | 'completed' | 'dismissed';

export interface PluginLifecycleProposalAuthor {
  /**
   * What the server observed about the caller: `agent` for Station's own
   * internal caller class (station-control, Station's agent adapter),
   * `person` for any credentialed caller. Derived from the request's
   * authenticated principal, never from the body.
   */
  readonly principal: 'agent' | 'person';
  /** Person authors only: the resolved principal id (server-derived). */
  readonly principalId?: string;
  /**
   * The agent and conversation the proposing tool call named. Display
   * provenance only: it names who asked, it authorizes nothing.
   */
  readonly agentSlug?: string;
  readonly conversationId?: string;
  /**
   * Where `agentSlug`/`conversationId` came from (#2323 S5 review M3).
   * `runtime`: Station's own agent runtime stamped them and the server
   * verified its attestation. `caller`: the tool call supplied them, which
   * for an external engine can be model-written text; the review says so.
   */
  readonly reportedBy?: 'runtime' | 'caller';
}

/** Why an install proposal carries no content digest. */
export type PluginProposalDigestUnavailableReason =
  /** A git source: proposing never clones it. */
  | 'remote-source'
  /** The folder exceeded the bounded walk (file count or total bytes). */
  | 'too-large'
  /** The folder could not be read. */
  | 'unreadable';

export interface PluginLifecycleProposal {
  readonly id: string;
  readonly kind: PluginLifecycleProposalKind;
  /** Install only: the local folder (absolute, normalized) or git URL. */
  readonly source?: string;
  /** Update and remove only: the installed plugin's name. */
  readonly pluginName?: string;
  readonly rationale: string;
  readonly author: PluginLifecycleProposalAuthor;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * Install of a LOCAL folder only: the plugin tree digest Station observed
   * when the proposal was made, in the same encoding the install preview's
   * `contentDigest` uses. Absent for a git source (proposing does not clone)
   * and when the folder could not be digested; the review then has nothing
   * to compare against and says so rather than implying the bytes held.
   */
  readonly proposedContentDigest?: string;
  /** Install only, when no digest was recorded: why. */
  readonly proposedContentDigestUnavailable?: PluginProposalDigestUnavailableReason;
  readonly status: PluginLifecycleProposalStatus;
  /** When the status left `open`. */
  readonly resolvedAt?: string;
}

/**
 * The Plugins view's query key for opening a proposal (#2323 S5): the
 * attention item links to `/plugins?proposal=<id>`, and the view reads the
 * same key. One declaration, so the link and the reader cannot drift.
 */
export const PLUGIN_PROPOSAL_QUERY_KEY = 'proposal';

export function pluginProposalHref(proposalId: string): string {
  return `/plugins?${PLUGIN_PROPOSAL_QUERY_KEY}=${encodeURIComponent(proposalId)}`;
}

/**
 * #2323 S4: whether a Project's folder still holds the code an installed
 * local-folder plugin was installed from.
 *
 * - `unchanged`: the folder's plugin tree digest equals the source digest
 *   the installation recorded when a person consented to it.
 * - `changed`: the digests differ. Reinstalling from the folder would run
 *   code nobody has reviewed yet; the UI offers "Reinstall from source",
 *   which is the ordinary preview and consent, not a shortcut past it.
 * - `unknown`: the folder is that plugin's source, but Station cannot say
 *   whether it changed ({@link PluginLocalSourceUnknownReason}).
 *
 * The match is DERIVED, not stored: an installation records only a hash of
 * its acquisition source, and the server recomputes that hash from each
 * Project folder. No host path appears in this record.
 */
export type PluginLocalSourceState = 'unchanged' | 'changed' | 'unknown';

export type PluginLocalSourceUnknownReason =
  /** The folder exceeded the bounded digest walk (file count or bytes). */
  | 'too-large'
  /** The folder could not be read. */
  | 'unreadable'
  /**
   * More distinct source folders matched than one status read walks; this
   * one was not compared.
   */
  | 'too-many-sources'
  /** The installation carries no recorded source digest to compare with. */
  | 'not-recorded'
  /**
   * The Project stores its folder as a `~`-relative path. The install
   * preview reads the path it is given literally, so Station cannot offer a
   * reinstall from it; set the Project's folder to an absolute path.
   */
  | 'source-path-not-absolute';

export interface PluginLocalSourceStatus {
  /** The installed plugin whose acquisition source is this Project's folder. */
  readonly pluginName: string;
  /** The Project whose working directory is that source. */
  readonly projectSlug: string;
  readonly status: PluginLocalSourceState;
  /** Present when `status` is `unknown`. */
  readonly reason?: PluginLocalSourceUnknownReason;
  /** The source digest the installation recorded at consent, when it did. */
  readonly installedSourceDigest?: string;
  /** The folder's digest now, when Station could compute it. */
  readonly currentSourceDigest?: string;
}
