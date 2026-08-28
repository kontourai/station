import type { PermissionTier } from '@kontourai/station-contracts/plugin';

/**
 * The words Station uses for what a plugin permission LETS A PLUGIN DO
 * (archive#3815).
 *
 * These lived inside `PermissionManager` when the consent modal was the only
 * surface that named a permission. Reviewing what a plugin already holds is
 * a second surface, and two copies of this vocabulary would drift into
 * describing the same permission two ways — the grant dialog promising one
 * thing and the review list another.
 *
 * Written as capabilities, not API names: a person deciding whether to keep
 * a grant is asking "what can it do", and `plugin.server` does not answer
 * that. The raw identifier is still shown alongside for the reader who wants
 * it.
 */
export const PERMISSION_LABELS: Record<string, string> = {
  'network.fetch': 'Make network requests through the server',
  'agents.invoke': 'Invoke AI agents',
  'tools.invoke': 'Use MCP tools',
  'providers.register': 'Register system providers (auth, registry, etc.)',
  'system.config': 'Modify system configuration',
  'plugin.server': 'Run server-side plugin code inside Station',
  'navigation.dock': 'Add items to the navigation dock',
  'ui.confirm': 'Interrupt you with a confirmation dialog in Station chrome',
  'events.subscribe': 'Subscribe to Station events',
  'events.read-payload': 'Read the contents of Station events',
};

/**
 * A permission Station has no written description for still has to render.
 * "Custom permission" says exactly what is known — this plugin declared
 * something outside the built-in vocabulary — rather than inventing a
 * capability sentence from the identifier.
 */
export function describePermission(permission: string): string {
  // Typed `string`, so a non-string lookup result would be rendered as a React
  // child and throw "Objects are not valid as a React child" -- crashing the
  // very panel a person uses to review a plugin's permissions. A plain object
  // literal answers Object's inherited keys (`PERMISSION_LABELS['__proto__']`
  // is `Object.prototype`), and permission names come from a plugin manifest.
  const label = PERMISSION_LABELS[permission];
  return typeof label === 'string' ? label : 'Custom permission';
}

/**
 * What each tier means for the person deciding, in one line.
 *
 * The tier is the reason a permission is or is not routed through the
 * isolated host approval page, so it is the most decision-relevant fact
 * about a grant — more than the identifier and more than the capability
 * sentence.
 */
export const TIER_MEANING: Record<PermissionTier, string> = {
  // NOT "reads only": `navigation.dock` is passive and steers shell
  // navigation. The tier's real meaning is how it is obtained,
  // which is also what a person needs to know when deciding to keep it.
  passive: 'Low risk. Granted automatically at install.',
  active: 'Acts on your behalf. Granted when you approve it here.',
  trusted:
    'Can run server-side code or change how Station behaves. Granted only on the separate host review page.',
};

export const TIER_LABEL: Record<PermissionTier, string> = {
  passive: 'Passive',
  active: 'Active',
  trusted: 'Trusted',
};

/**
 * Withdrawing a `trusted` grant is worth a confirmation and the others are
 * not — not because revoking is dangerous (it only ever narrows what a
 * plugin may do) but because it is ASYMMETRIC to undo: re-granting a trusted
 * permission means going back through the isolated review page, while
 * re-granting the other tiers is one click in this same panel.
 */
export function revokeNeedsConfirmation(tier: PermissionTier): boolean {
  return tier === 'trusted';
}
