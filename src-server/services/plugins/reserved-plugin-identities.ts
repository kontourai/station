/**
 * Plugin identities Station's own routes already occupy at the `{plugin}`
 * position under `/api/plugins`, and the install-time refusal that keeps a
 * plugin from taking one.
 *
 * A plugin's server module answers `/api/plugins/<name>/**` through the
 * `/:name/*` catch-all in `plugin-public-routes.ts`. Station also mounts
 * routes on that same prefix at LITERAL first segments — `/home-role/**`,
 * `/host-approvals/**`, `/install`, `/preview`, and the rest — and those
 * registrations run first, so they win. A plugin installed under one of those
 * names therefore has Station's routes sitting inside the namespace it
 * believes it owns, including `POST /home-role/requests`, which the pairing
 * scope table annotates as authority-bearing because creating a request
 * returns a transaction-bound decision cookie.
 *
 * ## Why the refusal is at install and not at a request boundary
 *
 * This list used to live in `plugin-api-surface.ts`, where it refused to
 * AUTHORIZE the plugin frame's `api-request` bridge for a colliding identity.
 * That bridge is gone (station#4300), but the collision never depended on it:
 * the two route sets overlap whether or not anything asks the shell to call
 * them. The name is what creates the overlap, so the name is what is refused,
 * once, at the moment a plugin tree is written.
 *
 * ## Derived, not trusted
 *
 * A hand-kept denylist rots the moment someone adds a route, silently and in
 * the plugin's favour. `__tests__/reserved-plugin-identities.test.ts` scans
 * the real route registrations in `src-server/routes/plugins/` and fails in
 * both directions:
 * a literal segment Station mounts and this list does not name, and a name
 * here that Station no longer mounts. That scan is why this list has seven
 * entries rather than the two an unaided reading would produce.
 */
export const STATION_RESERVED_PLUGIN_IDENTITIES = Object.freeze([
  'check-updates',
  'fetch',
  'home-role',
  'host-approvals',
  'install',
  'preview',
  'reload',
]);

export function isReservedPluginIdentity(pluginName: string): boolean {
  return STATION_RESERVED_PLUGIN_IDENTITIES.includes(pluginName);
}

/**
 * Refuse a plugin identity Station's own routes already occupy.
 *
 * Called from every path that writes a plugin tree under `<home>/plugins/` —
 * `installPluginFromSource`, `installPluginDependency`, and
 * `JsonManifestRegistryProvider.install`, which creates the directory itself
 * rather than delegating — and never from a path that reads or removes one: a plugin already installed
 * under such a name must stay listable, inspectable and — above all —
 * UNINSTALLABLE. Refusing it at a read boundary would strand it.
 */
export function assertPluginIdentityAvailable(pluginName: string): void {
  if (isReservedPluginIdentity(pluginName)) {
    throw new Error(
      `Plugin name '${pluginName}' is reserved: Station mounts its own routes at /api/plugins/${pluginName}, so a plugin installed under this name cannot own that namespace. Rename the plugin in its manifest.`,
    );
  }
}
