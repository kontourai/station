import { CLEAN_ID_PATTERN } from './agent-identity.js';
import type { AppConfig } from './config.js';

/**
 * Station#settings-revamp slice 1 — the declarative settings registry
 * (docs/design/settings-architecture.md §4 "Mechanism: the settings
 * registry"). One definition per PERSISTED `AppConfig` field: scope,
 * validation descriptor, label/description, and (when relevant) which env
 * var can override it. Everything downstream — the typed `PUT /config/app`
 * write path, `GET /config/app` provenance, and (later slices) the
 * registry-driven Settings UI — derives from this module instead of a
 * parallel, driftable list.
 *
 * Descriptor-based rather than a schema library (e.g. zod): `packages/
 * contracts` stays dependency-free. Composite fields (structured
 * objects/arrays) are validated by the existing AJV file schema
 * (`schemas/app.schema.json`) and rendered by custom editors in a later
 * slice — the registry only records that they exist and where they live.
 */

/** Who or what a setting controls, per docs/design/settings-architecture.md §3. */
export type SettingScope = 'station' | 'defaults' | 'device';

export type SettingValueDescriptor =
  | { kind: 'string'; minLength?: number; maxLength?: number; pattern?: string }
  | { kind: 'boolean' }
  | { kind: 'number'; min?: number; max?: number; integer?: boolean }
  | { kind: 'enum'; values: readonly string[] }
  /**
   * Structured objects/arrays. Validated by `schemas/app.schema.json` at
   * save time; the sanitizer accepts any value shape for these keys and
   * lets AJV be the source of truth for their internal structure.
   */
  | { kind: 'composite' };

export interface SettingDefinition<
  K extends keyof AppConfig = keyof AppConfig,
> {
  key: K;
  scope: SettingScope;
  descriptor: SettingValueDescriptor;
  label: string;
  description: string;
  /**
   * False when this persisted field is an implementation detail rather than
   * a setting a person can meaningfully choose. UI registry consumers must
   * enumerate `USER_FACING_APP_SETTINGS_REGISTRY`, and row renderers also
   * fail closed on this marker.
   */
  userFacing?: false;
  /**
   * Optional input placeholder for the registry-driven row renderer
   * (station#settings-revamp slice 3, `views/settings/registry-row.tsx`) —
   * used instead of a fabricated default when a field has real "absent"
   * behavior that isn't a single number/string worth pre-filling (e.g.
   * `defaultMaxOutputTokens`: absent means "no Station-applied cap", not 0).
   */
  placeholder?: string;
  /**
   * Env var consulted for this setting's effective value when NOTHING is
   * stored — a default, not an override (station#1557).
   *
   * It was called `envOverride` and documented as taking precedence over the
   * stored value. No resolver in Station ever did that: `region`, its only
   * declarer, resolves `agentSpec.region -> config.region -> AWS_REGION ->
   * default` (`src-server/providers/llm/bedrock-region.ts`). The UI believed
   * the declaration rather than the resolver and greyed out the value that
   * was actually in effect.
   *
   * Declaring this means: when the key is absent from the stored config and
   * this var is set, the var is where the effective value comes from — which
   * is what `buildAppConfigProvenance` reports as `source: 'env'`. Do not
   * declare it for a key whose resolver does not consult it.
   */
  envFallback?: string;
  secret?: boolean;
  /**
   * `null` is a legitimate STORED value for this key, distinct from absent
   * (e.g. `builtinAgentEngineConnectionId`: absent = re-derived each boot,
   * `null` = explicitly chose Station, sticky). The sanitizer passes `null`
   * through as a value instead of treating it as a clear, and the merge
   * helper persists it instead of deleting the key. Non-nullable keys keep
   * the default semantics: `null` in an update means "clear this field".
   */
  nullable?: true;
  /**
   * True when the persisted file schema requires this key
   * (`schemas/app.schema.json`'s `required`). A PUT that submits `null`/
   * `undefined` for a required key is a violation ("cannot be cleared"),
   * not an accepted clear — see `sanitizeAppConfigUpdate`'s required-key
   * guard below.
   */
  required?: true;
  /**
   * The value Station actually treats this setting as having when it is
   * absent from the loaded config — used only to synthesize `{ source:
   * 'default' }` provenance (`buildAppConfigProvenance`). Deliberately NOT
   * set from `schemas/app.schema.json`'s `"default"` hints blind: each value
   * here is cross-checked against the code that actually reads the field
   * absent, and follows the code where the two disagree (see the comments
   * on `defaultMaxTurns` and `defaultMaxOutputTokens` below for the one
   * case found where they do).
   */
  defaultValue?: unknown;
}

function defineSetting<K extends keyof AppConfig>(
  definition: SettingDefinition<K>,
): SettingDefinition<K> {
  return definition;
}

/**
 * One entry per persisted `AppConfig` field. See `INTERNAL_APP_CONFIG_FIELDS`
 * below for the two fields that are deliberately NOT here (runtime-derived,
 * never persisted). The module-level type assertion at the bottom of this
 * file fails to typecheck if a field is added to `AppConfig` without being
 * registered here or listed as internal.
 */
export const APP_SETTINGS_REGISTRY = [
  // --- scope: defaults (workspace-wide fallbacks entities override) ---
  defineSetting({
    key: 'region',
    scope: 'defaults',
    descriptor: { kind: 'string', pattern: '^[a-z]{2}-[a-z]+-[0-9]{1}$' },
    label: 'AWS region',
    description: 'Default AWS region for Bedrock (e.g. us-east-1).',
    envFallback: 'AWS_REGION',
  }),
  defineSetting({
    key: 'defaultModel',
    scope: 'defaults',
    descriptor: { kind: 'string' },
    label: 'Default model',
    description: 'Default Bedrock model ID for new agents.',
    required: true,
  }),
  defineSetting({
    key: 'invokeModel',
    scope: 'defaults',
    descriptor: { kind: 'string' },
    label: 'Invoke model',
    description: 'Model used for the /invoke endpoint’s tool calling.',
    required: true,
  }),
  defineSetting({
    key: 'structureModel',
    scope: 'defaults',
    descriptor: { kind: 'string' },
    label: 'Structure model',
    description: 'Model used for the /invoke endpoint’s structured output.',
    required: true,
  }),
  defineSetting({
    key: 'systemPrompt',
    scope: 'defaults',
    descriptor: { kind: 'string' },
    // "System prompt" retired (station#1543): the rendered control for this
    // same field already reads "Default Agent Instructions"
    // (views/settings/AgentDefaultsSection.tsx) — the registry was carrying a
    // second, divergent name for one setting.
    label: 'Default agent instructions',
    description: 'Global instructions prepended to every agent.',
  }),
  defineSetting({
    key: 'templateVariables',
    scope: 'defaults',
    descriptor: { kind: 'composite' },
    label: 'Template variables',
    description:
      'Custom template variables available as {{key}} in agent instructions.',
  }),

  // --- scope: station (controls for this Station instance) ---
  defineSetting({
    key: 'logLevel',
    scope: 'station',
    descriptor: {
      kind: 'enum',
      values: ['trace', 'debug', 'info', 'warn', 'error'],
    },
    label: 'Log level',
    description: 'Minimum severity Station writes to its server logs.',
  }),
  defineSetting({
    key: 'telemetryEnabled',
    scope: 'station',
    descriptor: { kind: 'boolean' },
    label: 'Usage telemetry',
    description:
      'Allow Station to send the documented anonymous product-usage events when this Station has a telemetry endpoint configured. No endpoint is configured by default, so nothing is sent.',
    defaultValue: true,
    envFallback: 'STATION_TELEMETRY_ENABLED',
  }),
  defineSetting({
    key: 'registryUrl',
    scope: 'station',
    descriptor: { kind: 'string' },
    label: 'Registry URL',
    description:
      'Where the Registry page loads its catalog of agents, skills, and plugins. Leave empty for the default catalog.',
  }),
  defineSetting({
    key: 'gitRemote',
    scope: 'station',
    descriptor: { kind: 'string' },
    label: 'Git remote',
    // Verified 2026-08-03 (station#1840 delivery review, M1): NOTHING reads or
    // writes this key today. The update path (system-update-routes.ts) reads
    // the remote straight off the checkout via `git remote get-url origin`,
    // never from config. The description must not claim behavior nothing
    // implements — say so plainly until a consumer exists.
    description:
      'Not currently used. Update checks read the git remote from the Station checkout itself.',
  }),
  defineSetting({
    key: 'terminalShell',
    scope: 'station',
    descriptor: { kind: 'string' },
    label: 'Terminal shell',
    description: 'Shell used when Station spawns a terminal session.',
  }),
  defineSetting({
    key: 'disableDefaultSkillRegistries',
    scope: 'station',
    descriptor: { kind: 'boolean' },
    label: 'Disable default skill registries',
    description:
      'Skip Station’s built-in skill catalogs so only registries you add yourself appear.',
  }),
  defineSetting({
    key: 'approvalGuardian',
    scope: 'station',
    descriptor: { kind: 'composite' },
    label: 'Approval guardian',
    // Mechanics: src-server/services/approvals/approval-guardian.ts, consumed
    // in agent-hooks.ts. An "allow" verdict skips the human approval pause in
    // BOTH modes; "deny" is blocked only in enforce mode; "defer" (and every
    // failure) falls back to asking the human.
    description:
      'A second model screens tool calls that would otherwise pause and ask for your approval, and clears the safe ones so they run without interrupting you. Off by default: each screening is an extra model call and needs a model configured.',
  }),
  defineSetting({
    key: 'mcpUiHost',
    scope: 'station',
    descriptor: { kind: 'boolean' },
    label: 'MCP UI host',
    // The MCP Apps host (docs/design/mcp-ui-host.md). Off makes a
    // successfully-resolved MCP UI fall back to the inert "unsupported" state.
    description:
      'Let tools that ship their own interface display it in chat, inside a sandboxed frame. Turn off to show a plain "unsupported" notice instead.',
    // Confirmed against MCPToolUIFrame.tsx: `config?.mcpUiHost !== false`.
    defaultValue: true,
  }),
  defineSetting({
    key: 'surfaceTrustFromVeritasEvidence',
    scope: 'station',
    descriptor: { kind: 'boolean' },
    label: 'Surface trust from Veritas evidence',
    description:
      'Fill in a project’s Trust panel from the newest Veritas evidence record in its workspace. Turn off to leave those evidence records out of Trust.',
    // Confirmed against runtime-routes.ts: `... !== false`.
    defaultValue: true,
  }),
  defineSetting({
    key: 'knowledgeStores',
    scope: 'station',
    descriptor: { kind: 'boolean' },
    label: 'Knowledge stores (preview)',
    // K2 store-layer work: registers the KnowledgeStoreProvider seam alongside
    // the namespace-based knowledge path. No consumer gates on this flag yet
    // (K3+ work) — no read path is rewired and no data moves until an explicit
    // future migration, which is why the description can truthfully say the
    // toggle changes nothing today.
    description:
      'Groundwork for Station’s next knowledge storage system. Turning this on changes nothing yet — it exists for Station development.',
    defaultValue: false,
  }),
  defineSetting({
    key: 'workspaceCheckpoints',
    scope: 'station',
    descriptor: { kind: 'boolean' },
    label: 'Workspace checkpoints',
    // station#2802: capture is wired through
    // wireTurnCheckpointCaptureWhenEnabled (turn-checkpoint-capture.ts) and
    // reads this at boot wiring time — a flip applies after a Station
    // restart, which the description states so the toggle cannot claim
    // immediacy it does not have. Off means NO event-bus subscription: no
    // git calls, no index writes, no .git growth.
    description:
      'Snapshot the session project’s working directory in git at the start and end of every turn, so later turns can be compared or recovered. Off by default: each snapshot is pinned in the project’s .git for 90 days, so turning this on spends disk in every project you chat in. Applies after a restart. Inspect and reclaim with `station checkpoints status` / `station checkpoints prune`.',
    defaultValue: false,
  }),
  defineSetting({
    key: 'distributionProfile',
    scope: 'station',
    descriptor: { kind: 'composite' },
    label: 'Layout sources',
    description:
      'Controls which layouts Station offers to projects after its next restart. Standard offers built-in layouts and locally installed plugin layouts; Minimal offers no layout sources. This is application configuration, not build or distribution, and does not set the Registry URL.',
  }),
  defineSetting({
    key: 'defaultMaxTurns',
    scope: 'station',
    descriptor: { kind: 'number', min: 1, integer: true },
    label: 'Default max turns',
    description:
      'How many steps an agent may take in one run before Station stops it. Raise it for long-running work; lower it to rein in runaway agents.',
    // `resolveMaxSteps` (src-server/constants.ts) falls through
    // `defaultMaxTurns || DEFAULT_MAX_STEPS` — the code's real absent-value
    // behavior is 200, not the file schema's stale documented "default": 10
    // (schemas/app.schema.json corrected to match in this same slice).
    defaultValue: 200,
  }),
  defineSetting({
    key: 'defaultMaxOutputTokens',
    scope: 'station',
    descriptor: { kind: 'number', min: 1, integer: true },
    label: 'Default max output tokens',
    description:
      'Cap on the tokens a model may produce in one response. Leave empty to use each model’s own limit.',
    placeholder: 'no cap',
    // Deliberately no `defaultValue`: every consumer (framework-model-factory.ts,
    // voltagent-adapter.ts) passes `spec.guardrails?.maxTokens ??
    // appConfig.defaultMaxOutputTokens` straight into the model constructor
    // with no secondary source — absent means "no Station-applied cap",
    // deferring to the underlying model's own default, not a fixed number.
    // The file schema's documented "default": 16384 is aspirational, not
    // enforced by any code path; left as-is (informational) rather than
    // corrected, since there is no single number to correct it to.
  }),
  defineSetting({
    key: 'defaultChatFontSize',
    scope: 'station',
    descriptor: { kind: 'number', min: 10, max: 24 },
    label: 'Default chat font size',
    description: 'Default font size for chat messages, in pixels.',
    // Confirmed against ChatDock.tsx: `appConfig?.defaultChatFontSize ??
    // CONFIG_DEFAULTS.defaultChatFontSize` (14).
    defaultValue: 14,
  }),
  defineSetting({
    key: 'runtime',
    scope: 'station',
    descriptor: { kind: 'enum', values: ['voltagent', 'strands'] },
    // Persisted for development boot selection, but the framework underneath
    // Station's engine is not a product choice or capability. Keep maintainer
    // copy because internal config/provenance diagnostics may name the field;
    // renderers fail closed on `userFacing: false` below.
    label: 'Station engine framework (internal)',
    description:
      "Implementation framework used by Station's engine; not a user-facing product setting.",
    userFacing: false,
    // Confirmed against runtime-initialize.ts / system-status-routes.ts:
    // `appConfig.runtime || 'voltagent'`.
    defaultValue: 'voltagent',
  }),
  defineSetting({
    key: 'defaultLLMProvider',
    scope: 'station',
    descriptor: { kind: 'string' },
    label: 'Default model connection',
    description: 'Default model connection used to resolve LLM model options.',
  }),
  defineSetting({
    key: 'defaultEmbeddingProvider',
    scope: 'station',
    descriptor: { kind: 'string' },
    label: 'Default embedding provider',
    // station#3239: typed and settable, but no project-creation path reads
    // it today — setting this has no effect until a consumer exists.
    description: 'Not currently applied. No project-creation path reads it.',
  }),
  defineSetting({
    key: 'defaultEmbeddingModel',
    scope: 'station',
    descriptor: { kind: 'string' },
    label: 'Default embedding model',
    // station#3239: same gap as `defaultEmbeddingProvider` — typed, never read.
    description: 'Not currently applied. No project-creation path reads it.',
  }),
  defineSetting({
    key: 'defaultVectorDbProvider',
    scope: 'station',
    descriptor: { kind: 'string' },
    label: 'Default vector DB provider',
    // station#3239: same gap as `defaultEmbeddingProvider` — typed, never read.
    description: 'Not currently applied. No project-creation path reads it.',
  }),
  defineSetting({
    key: 'agentConnections',
    scope: 'station',
    descriptor: { kind: 'composite' },
    label: 'Agent connections',
    // Persisted as a map keyed by agent slug.
    description: 'Connection overrides for individual agents.',
  }),
  defineSetting({
    key: 'builtinAgentEngineConnectionId',
    scope: 'station',
    descriptor: { kind: 'string', pattern: CLEAN_ID_PATTERN.source },
    nullable: true,
    label: 'Built-in agent engine',
    // station#1194. Serialized states (see the `nullable` doc above): absent =
    // re-derived each boot; null = explicitly Station, sticky; a connection
    // id = explicitly that engine, sticky. The description says what the
    // setting DOES — the encoding belongs here, not in user-facing copy
    // (station#1840 item 4).
    description:
      'Engine that powers Station’s built-in default agents. Chosen automatically until you pick one here; your choice then sticks until you change it.',
  }),
  defineSetting({
    key: 'fleetContribution',
    scope: 'station',
    descriptor: { kind: 'composite' },
    label: 'Fleet contribution',
    // station#1398.
    description:
      'Which local model connections this Station offers to your inference fleet. Nothing is contributed until you turn this on and name the connections.',
    // No `defaultValue`: absent is not a synthesizable value here, it is the
    // off state itself. `isFleetContributionEnabled` (fleet-contribution.ts)
    // is the single fail-closed read, and it treats absent, `enabled`
    // absent, and any non-`true` value identically.
  }),
  defineSetting({
    key: 'contribution',
    scope: 'station',
    descriptor: { kind: 'composite' },
    label: 'Contribution',
    // station#1500. Persisted as a map keyed by scope key; the "fleet" key is
    // NOT read here — fleet contribution is its own setting above.
    description:
      'What this Station offers to each shared space — repos it will run work in, agents it makes available, and model connections it contributes. Nothing is offered until you turn this on and name the resources. Fleet contribution is configured separately.',
    // No `defaultValue`, for the same reason `fleetContribution` has none:
    // absent is not a synthesizable value, it is the off state itself.
    // `isContributionEnabled` (contribution.ts) is the single fail-closed read.
  }),
  defineSetting({
    key: 'userProfile',
    scope: 'station',
    descriptor: { kind: 'composite' },
    label: 'About you',
    // station#2652. Persisted as `{ role?, comfort? }` from the first-run
    // "About you" step. The description states the reach honestly: this is
    // read on Station's own engine's turn path only, and no default is
    // assumed when the questions go unanswered.
    description:
      'What you told Station about your role and how much technical detail you want back, added to the context of chats run by Station’s own engine. External engines build their own context, so it has no effect there. Leave it unset and Station adds nothing.',
    // No `defaultValue`: absent is not a synthesizable value here, it is
    // "they did not answer". `buildUserProfileContextBlock` (user-profile.ts)
    // is the single fail-closed read and returns null for absent, empty, and
    // unrecognised values alike.
  }),
  defineSetting({
    key: 'firstRun',
    scope: 'station',
    descriptor: { kind: 'composite' },
    label: 'First run',
    // UX audit RT-02/SHELL-12. Persisted as `{ status, completedAt?,
    // skippedAt? }`. Registered so `PUT /config/app` accepts the write the
    // first-run chapter makes when it is completed or deferred; it has no
    // Settings control (see `DEFERRED_COMPOSITE_KEYS`).
    description:
      'Whether the guided first run has been offered on this Station and what you did with it. Written by the first-run chapter itself; absent means this home predates the chapter and it is not offered.',
    // No `defaultValue`: absent is not a synthesizable value here, it is
    // "this home predates the field", which is a different state from
    // `pending` — see `AppConfig.firstRun`.
  }),
] as const satisfies readonly SettingDefinition[];

/** Persisted settings that are eligible for registry-driven UI rendering. */
export const USER_FACING_APP_SETTINGS_REGISTRY = APP_SETTINGS_REGISTRY.filter(
  (definition) => definition.userFacing !== false,
);

/**
 * Registered keys for which `null` is a stored value rather than a clear —
 * derived from the registry so the sanitizer and the merge path
 * (`mergeAppConfigUpdate`) can never disagree with the definitions.
 */
export const NULLABLE_APP_CONFIG_KEYS: ReadonlySet<keyof AppConfig> = new Set(
  APP_SETTINGS_REGISTRY.filter(
    (definition) => definition.nullable === true,
  ).map((definition) => definition.key),
);

/**
 * `AppConfig` fields that are runtime-derived and never persisted to
 * `config/app.json` — `GET /config/app` injects them, and
 * `PUT /config/app` must always ignore them (see `sanitizeAppConfigUpdate`
 * below). Fixes a real bug:
 * a client that GETs config (which injects these) and PUTs it back used to
 * persist them.
 */
export const INTERNAL_APP_CONFIG_FIELDS = [
  'mcpUiFrameOrigin',
  'pluginFrameOrigin',
  'managedChatOrchestration',
] as const satisfies readonly (keyof AppConfig)[];

type RegisteredKey = (typeof APP_SETTINGS_REGISTRY)[number]['key'];
type InternalKey = (typeof INTERNAL_APP_CONFIG_FIELDS)[number];

type KeysMatch<A extends string, B extends string> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

/**
 * Compile-time completeness check: if this line fails to typecheck, either
 * `AppConfig` gained a field that isn't registered (or listed as internal)
 * here, or the registry/internal list names a key that no longer exists on
 * `AppConfig`. Keep this assignment — it is the drift guard, not dead code.
 */
const _assertRegistryCoversAppConfig: KeysMatch<
  keyof AppConfig,
  RegisteredKey | InternalKey
> = true;
void _assertRegistryCoversAppConfig;

const REGISTRY_BY_KEY: ReadonlyMap<string, SettingDefinition> = new Map(
  APP_SETTINGS_REGISTRY.map((definition) => [definition.key, definition]),
);
const INTERNAL_FIELD_SET: ReadonlySet<string> = new Set(
  INTERNAL_APP_CONFIG_FIELDS,
);

export interface SanitizeAppConfigUpdateResult {
  accepted: Partial<AppConfig>;
  ignored: Array<{ key: string; reason: 'unknown' | 'runtime-derived' }>;
  violations: Array<{ key: string; message: string }>;
}

/**
 * Splits a raw `PUT /config/app` body into what may be persisted, what was
 * silently dropped (and why), and what is malformed enough to reject the
 * whole request.
 *
 * Lifted here from `src-server/domain/settings-registry-server.ts` in
 * station#settings-revamp slice 6 (docs/design/settings-architecture.md §6,
 * closing #175) — the function only ever touched registry data already
 * defined in this module, so it had no genuine server-only dependency.
 * Moving (not duplicating) it lets `station config set`'s `--offline` path
 * (`packages/cli/src/commands/config.ts`) run the exact same validation the
 * live `PUT /config/app` route runs, instead of a second copy that could
 * silently drift from it. The server module re-exports this unchanged so its
 * existing importers (the route, its tests) don't need to change.
 *
 * - Registered keys are validated against their descriptor. `null`/
 *   `undefined` are accepted as an explicit clear — UNLESS the key is
 *   `required` (the registry-declared mirror of `schemas/app.schema.json`'s
 *   `required` list: `defaultModel`/`invokeModel`/`structureModel`), in
 *   which case clearing it is a violation naming the key, caught here
 *   instead of surfacing as a confusing 400 from AJV deep inside
 *   `saveAppConfigFile`. `composite` values are accepted as-is —
 *   `saveAppConfigFile`'s AJV pass is the structural authority for those.
 * - Keys in `INTERNAL_APP_CONFIG_FIELDS` are runtime-derived and are always
 *   ignored (reason `'runtime-derived'`) — this is what stops a client that
 *   round-trips a `GET /config/app` response (which injects
 *   `mcpUiFrameOrigin`/`pluginFrameOrigin`/`managedChatOrchestration`) from persisting them.
 * - Unknown keys are ignored (reason `'unknown'`), not rejected: earlier
 *   `app.json` files can carry stray keys that prior clients still
 *   round-trip, and rejecting the whole request over them would be a
 *   regression, not a fix.
 */
export function sanitizeAppConfigUpdate(
  updates: Record<string, unknown>,
): SanitizeAppConfigUpdateResult {
  const accepted: Record<string, unknown> = {};
  const ignored: SanitizeAppConfigUpdateResult['ignored'] = [];
  const violations: SanitizeAppConfigUpdateResult['violations'] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (INTERNAL_FIELD_SET.has(key)) {
      ignored.push({ key, reason: 'runtime-derived' });
      continue;
    }

    const definition = REGISTRY_BY_KEY.get(key);
    if (!definition) {
      ignored.push({ key, reason: 'unknown' });
      continue;
    }

    if (value === null || value === undefined) {
      if (definition.required) {
        violations.push({
          key,
          message: `${key}: required — cannot be cleared`,
        });
        continue;
      }
      accepted[key] = value;
      continue;
    }

    const violation = describeDescriptorViolation(
      key,
      definition.descriptor,
      value,
    );
    if (violation) {
      violations.push({ key, message: violation });
      continue;
    }

    accepted[key] = value;
  }

  return { accepted: accepted as Partial<AppConfig>, ignored, violations };
}

/**
 * Whether a raw string would be ACCEPTED as this setting's value.
 *
 * Exported for provenance (station#1557 review round 2): a registered key's
 * `envFallback` supplies the effective value only when the field's own
 * validator would accept it, so a surface that names the environment as the
 * source has to apply the same test the resolver does. Reported live —
 * `AWS_REGION=US-EAST-1` produced a "Set by operator: AWS_REGION" badge for a
 * value the Bedrock resolver discarded as malformed.
 *
 * Strings, enums, and booleans can be judged from a raw string; every
 * other kind returns `false`. "Cannot tell" answers no, because the caller is
 * deciding whether to make a claim.
 */
export function acceptsSettingValue(
  definition: SettingDefinition,
  raw: string,
): boolean {
  // Fails CLOSED for every descriptor a raw string cannot be judged against
  // (round-3 review, M10). `composite` would otherwise return `null` — i.e.
  // accept anything — because its structure is AJV's job at save time, so a
  // future `envFallback` on a composite key would let a surface name an env
  // var holding arbitrary garbage as the source: the exact defect the live
  // boot check found. Numbers cannot be judged from a raw string alone.
  if (definition.descriptor.kind === 'boolean') {
    return [
      '0',
      'false',
      'off',
      'disabled',
      '1',
      'true',
      'on',
      'enabled',
    ].includes(raw.trim().toLowerCase());
  }
  if (
    definition.descriptor.kind !== 'string' &&
    definition.descriptor.kind !== 'enum'
  ) {
    return false;
  }
  return (
    describeDescriptorViolation(
      definition.key as string,
      definition.descriptor,
      raw,
    ) === null
  );
}

function describeDescriptorViolation(
  key: string,
  descriptor: SettingValueDescriptor,
  value: unknown,
): string | null {
  switch (descriptor.kind) {
    case 'string': {
      if (typeof value !== 'string') return `${key}: expected a string`;
      if (
        descriptor.minLength !== undefined &&
        value.length < descriptor.minLength
      ) {
        return `${key}: expected at least ${descriptor.minLength} characters`;
      }
      if (
        descriptor.maxLength !== undefined &&
        value.length > descriptor.maxLength
      ) {
        return `${key}: expected at most ${descriptor.maxLength} characters`;
      }
      if (
        descriptor.pattern !== undefined &&
        !new RegExp(descriptor.pattern).test(value)
      ) {
        return `${key}: expected to match pattern ${descriptor.pattern}`;
      }
      return null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : `${key}: expected a boolean`;
    case 'number': {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return `${key}: expected a number`;
      }
      if (descriptor.integer && !Number.isInteger(value)) {
        return `${key}: expected an integer`;
      }
      if (descriptor.min !== undefined && value < descriptor.min) {
        return `${key}: expected at least ${descriptor.min}`;
      }
      if (descriptor.max !== undefined && value > descriptor.max) {
        return `${key}: expected at most ${descriptor.max}`;
      }
      return null;
    }
    case 'enum':
      return descriptor.values.includes(value as string)
        ? null
        : `${key}: expected one of ${descriptor.values.join('|')}`;
    case 'composite':
      return null;
    default: {
      const exhaustive: never = descriptor;
      return exhaustive;
    }
  }
}

/**
 * Per-field provenance for `GET /config/app` (station#settings-revamp slice
 * 1, docs/design/settings-architecture.md §4). Moved here in slice 3 so both
 * the server (`src-server/domain/settings-registry-server.ts`, which builds
 * it) and the SDK/UI (`useConfigProvenanceQuery`, `ProvenanceBadge.tsx`,
 * which consume it) share one type instead of each declaring its own copy.
 */
export type SettingProvenanceSource = 'file' | 'env' | 'default';

export interface SettingProvenanceEntry {
  source: SettingProvenanceSource;
  /** Which env var supplied the value, for `source: 'env'` only. */
  envVar?: string;
}
