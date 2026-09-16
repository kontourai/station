/**
 * The operator's view of per-principal plugin visibility (#2067).
 *
 * One declaration, read by the route that answers `GET /api/plugins/visibility`,
 * by the SDK that fetches it, and by the Settings section that renders it — so
 * a column the server stops sending cannot keep a UI claiming it.
 *
 * This is deliberately the OPERATOR surface only. There is no contract here
 * for "what a collaborator may see", because that answer is never sent as a
 * flag: a plugin outside a principal's projection is ABSENT from their
 * `GET /api/plugins` response. The projection is the derivation; a
 * `visible: false` field on the wire would be a second, weaker copy of it
 * that a client could re-assemble an inventory from.
 */

/** One row of the operator's picker: a principal and what they were granted. */
export interface PluginVisibilityPrincipal {
  /** The principal id a grant names. Never a display string. */
  id: string;
  /** Cosmetic. Never keys a store, never identifies anyone. */
  display: string;
  /**
   * Every pairing position naming this principal has been revoked. The row
   * stays listed so an operator reviewing grants can still remove them; the
   * flag is what says the person no longer reaches this Station.
   */
  revoked: boolean;
  /**
   * The plugin names granted to this principal, AS RECORDED.
   *
   * For the operator's own row this is empty, and that is not a mistake: the
   * operator sees every installed plugin because the projection derives it,
   * not because a grant record says so. Filling this column in with the
   * installed set would display a record that does not exist.
   */
  plugins: string[];
  /** Whether this row is the instance operator — the row with no grants to edit. */
  operator: boolean;
}

export interface PluginVisibilityDirectory {
  principals: PluginVisibilityPrincipal[];
}

/** The body both `POST` and `DELETE /api/plugins/visibility/grants` take. */
export interface PluginVisibilityGrantInput {
  /**
   * The TARGET of the change. Never the authority for it — the route resolves
   * the caller from the request's own authentication and refuses a
   * non-operator before this body is read.
   */
  principalId: string;
  plugin: string;
}

/**
 * Plugin names Station reserves because it emits them as SENTINELS on its
 * own plugin event channels (#2067).
 *
 * In contracts rather than beside the relay, because the manifest readers
 * enforce it and a service reaching into a routes module for a rule is how a
 * rule ends up enforced in one of two places — which is exactly what
 * happened to this one.
 *
 * `workspace-home-role` satisfies `isCanonicalPluginId` and is not a
 * reserved object key, so without this a plugin could take the name and have
 * Station's own frames for it ride the Home-role relay exemption.
 */
export const RESERVED_EVENT_SENTINEL_PLUGIN_NAMES: ReadonlySet<string> =
  new Set(['workspace-home-role']);
