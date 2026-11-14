/**
 * #4515: one valid policy that sets every key this build enforces at once,
 * shared by the contracts round trip and the `station policy check` child
 * process test. A slice that lands a key adds a restricting value here (and
 * its client projection to `EVERY_KEY_SUMMARY_LIMITS`); the round trip's
 * coverage check fails until it does.
 */

/** Carries a path token, as a real mirror might; it must never reach a client. */
export const EVERY_KEY_FEED_URL = 'https://mirror.example/station/t0ken/';

/** A pinned engine environment value; it must never reach a client. */
export const EVERY_KEY_ENGINE_GATEWAY = 'https://gateway.example/acme-t0ken';

export const EVERY_KEY_LIMITS = {
  // #4518: an approval ceiling that restricts (`never` would restrict nothing).
  maxApprovalMode: 'auto',
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
  // #4520: an allow list and one locked, pinned launch.
  engines: {
    allowed: ['claude', 'acp'],
    acpRegistryAgents: false,
    engineHostAuth: 'off',
    instances: {
      claude: {
        locked: true,
        binaryPath: '/opt/acme/bin/claude',
        launchArgs: ['--settings', '/opt/acme/claude.json'],
        environment: { ANTHROPIC_BASE_URL: EVERY_KEY_ENGINE_GATEWAY },
      },
    },
  },
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
 * What clients see in `summary.limits` for {@link EVERY_KEY_LIMITS}: the
 * same values, except that `updates` says a mirror is set (`mirror: true`)
 * instead of naming it, and `engines` is summarized beside `limits`.
 */
const { engines: _engines, ...LIMITS_WITHOUT_ENGINES } = EVERY_KEY_LIMITS;
export const EVERY_KEY_SUMMARY_LIMITS = {
  ...LIMITS_WITHOUT_ENGINES,
  updates: { mode: 'off', mirror: true, allowNightly: false },
} as const;

/**
 * `summary.engines` for {@link EVERY_KEY_LIMITS}: which fields and variable
 * names are pinned, never their values.
 */
export const EVERY_KEY_ENGINE_SUMMARY = {
  allowed: ['claude', 'acp'],
  acpRegistryAgents: false,
  pinned: [
    {
      engine: 'claude',
      locked: true,
      fields: ['binaryPath', 'launchArgs', 'environment'],
      environmentNames: ['ANTHROPIC_BASE_URL'],
    },
  ],
} as const;
