/**
 * Plugin draft preview (epic #2323 S3): a plugin built from a Project folder
 * for in-app preview, with no install.
 *
 * A draft is inert data until a person runs it. Nothing in this contract
 * grants anything: the status describes what the server built, and the
 * registration key is an opaque host-minted name the bundle registers under
 * (`window.__station_ai_plugin_drafts[registrationKey]`), never the
 * installed-plugin global.
 */

export const PLUGIN_DRAFT_ROUTE_SEGMENT = 'plugin-draft' as const;

/** How long one lease keeps a draft's watcher alive without a refresh. */
export const PLUGIN_DRAFT_LEASE_TTL_MS = 90_000;

export type PluginDraftState =
  /** No lease is held for this Project; nothing is watched or built. */
  | 'idle'
  /** The Project folder has no plugin.json yet. Watched, not built. */
  | 'no-manifest'
  | 'building'
  | 'ready'
  | 'failed'
  /** The draft cannot be previewed here (folder missing, capacity reached). */
  | 'unavailable';

export interface PluginDraftDiagnostic {
  readonly text: string;
  /** Path relative to the Project folder. */
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
}

/** One pane the draft's manifest declares with a plugin-component renderer. */
export interface PluginDraftPane {
  readonly id: string;
  readonly name: string;
  /** The component export the pane renders (`renderer.name`). */
  readonly component: string;
}

export interface PluginDraftStatus {
  readonly projectSlug: string;
  readonly state: PluginDraftState;
  /** Absent while no lease is held. */
  readonly draftId?: string;
  /** The latest successfully built revision, or null when none exists. */
  readonly generation: number | null;
  /**
   * The key that revision registers under. Present with `generation`. It
   * embeds a per-process-lifetime nonce, so the same generation number in a
   * later server lifetime is a different key.
   */
  readonly registrationKey?: string;
  /**
   * Content digest of that revision's bytes. Part of the bundle URL: a request
   * whose digest does not match the retained revision is refused, so what a
   * viewer chose to run is exactly what is served.
   */
  readonly digest?: string;
  readonly hasCss: boolean;
  readonly pluginName?: string;
  readonly pluginVersion?: string;
  readonly panes: readonly PluginDraftPane[];
  /** Problems from the most recent build attempt. */
  readonly diagnostics: readonly PluginDraftDiagnostic[];
  readonly builtAt?: string;
  readonly leaseExpiresAt?: string;
}

/** Payload of `SERVER_EVENTS.PLUGIN_DRAFTS_REBUILT`. */
export interface PluginDraftRebuiltEvent {
  readonly projectSlug: string;
  readonly draftId: string;
  readonly generation: number;
}

/** Shape of a revision digest in a bundle URL. */
export const PLUGIN_DRAFT_DIGEST_PATTERN = /^[0-9a-f]{32}$/;
