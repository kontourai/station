/**
 * #4515: one valid policy that sets every key this build enforces at once,
 * shared by the contracts round trip and the `station policy check` child
 * process test. A slice that lands a key adds a restricting value here (and
 * its client projection to `EVERY_KEY_SUMMARY_LIMITS`); the round trip's
 * coverage check fails until it does.
 */

/** Carries a path token, as a real mirror might; it must never reach a client. */
export const EVERY_KEY_FEED_URL = 'https://mirror.example/station/t0ken/';

export const EVERY_KEY_LIMITS = {
  // #4521: the capability switches.
  telemetry: false,
  webhookAutomations: false,
  registries: {
    allowedUrls: ['https://plugins.example.com/registry.json'],
    unsignedPackages: false,
    defaultSkillRegistries: false,
    acpRegistryInstalls: false,
  },
  // #4519: network exposure, in canonical order.
  clients: ['desktop', 'local-browser'],
  // #4522: update control, with a mirror.
  updates: { mode: 'off', feedUrl: EVERY_KEY_FEED_URL, allowNightly: false },
} as const;

/** #4517: one lock and one default. */
export const EVERY_KEY_SETTINGS = {
  defaultMaxTurns: { value: 40, locked: true },
  checkoutStaleAfterDays: { value: 9, locked: false },
} as const;

export const EVERY_KEY_POLICY = {
  schemaVersion: 1,
  organization: 'Acme',
  supportUrl: 'https://help.example/station',
  settings: EVERY_KEY_SETTINGS,
  limits: EVERY_KEY_LIMITS,
} as const;

/**
 * What clients see of {@link EVERY_KEY_LIMITS}: the same values, except
 * that `updates` says a mirror is set (`mirror: true`) instead of naming it.
 */
export const EVERY_KEY_SUMMARY_LIMITS = {
  ...EVERY_KEY_LIMITS,
  updates: { mode: 'off', mirror: true, allowNightly: false },
} as const;
