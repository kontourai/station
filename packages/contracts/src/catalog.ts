export interface SkillSourceContext {
  kind: 'agent' | 'plugin' | 'user' | 'asset';
  agentSlug?: string;
  conversationId?: string;
  asset?: GuidanceAssetReference;
  action?: GuidanceAssetConversionAction;
  convertedAt?: string;
}

export type GuidanceAssetReferenceKind = 'skill' | 'provider-capability';
export type GuidanceAssetSourceOwner =
  | 'user'
  | 'registry'
  | 'plugin'
  | 'provider';
export type GuidanceAssetConversionAction = 'provider-capability-to-skill';

export interface GuidanceAssetReference {
  kind: GuidanceAssetReferenceKind;
  id: string;
  name: string;
  owner: GuidanceAssetSourceOwner;
  providerId?: string;
  connectionId?: string;
}

export interface SkillProvenance {
  createdFrom?: SkillSourceContext;
  updatedFrom?: SkillSourceContext;
}

export interface SkillStats {
  runs: number;
  successes: number;
  failures: number;
  qualityScore: number | null;
  lastRunAt?: string;
  lastOutcomeAt?: string;
}

export type SkillOutcome = 'success' | 'failure';

export type GuidanceAssetKind = 'skill';
export type GuidanceAssetStorageMode =
  | 'json-inline'
  | 'markdown-file'
  | 'skill-package';
export type GuidanceAssetRuntimeMode =
  | 'slash-command'
  | 'prompt-record'
  | 'skill-catalog';

export interface GuidanceAssetPackaging {
  installable: boolean;
  installed?: boolean;
  installedVersion?: string;
  version?: string;
  path?: string;
  source?: string;
  resources?: Array<{ name: string; path: string }>;
  scripts?: Array<{ name: string; path: string }>;
}

export interface GuidanceAsset {
  id: string;
  kind: GuidanceAssetKind;
  name: string;
  body: string;
  description?: string;
  tags?: string[];
  category?: string;
  scope?: {
    agent?: string;
    global?: boolean;
  };
  source?: string;
  storageMode: GuidanceAssetStorageMode;
  runtimeMode: GuidanceAssetRuntimeMode;
  packaging?: GuidanceAssetPackaging;
  provenance?: SkillProvenance;
  stats?: SkillStats;
  createdAt?: string;
  updatedAt?: string;
}

export interface RegistryItem {
  id: string;
  displayName?: string;
  description?: string;
  version?: string;
  source?: string;
  status?: string;
  tags?: string[];
  installed: boolean;
  installedPluginName?: string;
  /** Manifest-declared glyph; see `ToolDef.icon`. Present only when the
   * underlying provider read the full manifest (e.g. disk-installed
   * integrations); curated-but-not-yet-installed registry entries fall back
   * to initials in the UI. */
  icon?: string;
  /** Same-origin, output-only URL for signature-validated local raster art. */
  iconUrl?: string;
}

/**
 * A skill that is also runnable as a slash command.
 *
 * `enabled` is DECLARED, never inferred: it is written by an author in
 * `SKILL.md` frontmatter and mirrored into `skill.json` so a listing does not
 * have to parse bodies. Nothing derives it from a skill's shape, its body, or
 * where it was found — a skill with `{{variables}}` in its body is not a
 * command until someone says so.
 *
 * `enabled` and `global` are two different facts, not one switch:
 * `enabled` = "runnable as `/command`"; `global` = "offered in every agent's
 * chat without being attached to that agent". An enabled, non-global command
 * skill is offered only to the agents whose `skills` list names it.
 */
export interface SkillCommand {
  enabled: boolean;
  /**
   * The command word, without the leading `/`. Absent means "derive it from
   * the skill name" — `skillCommandSlug(skill.name)` in
   * `@kontourai/station-contracts/skill-command`, the one derivation every
   * consumer shares.
   */
  name?: string;
  global?: boolean;
}

/**
 * One `{{placeholder}}` a skill body substitutes.
 *
 * The SET of variables is always derived from the body; a frontmatter
 * declaration only attaches `description`/`default` to a name the body
 * already uses (see `mergeSkillVariables`).
 */
export interface SkillVariable {
  name: string;
  description?: string;
  default?: string;
}

/**
 * Where a skill came from, written by the writer that knows: `createLocalSkill`
 * writes `user`, a registry install writes `registry`, and `package`/`plugin`
 * are derived from the read-only root a skill was discovered under.
 * `migrated-playbook` is written by `station doctor --migrate-playbooks`, the
 * one-shot helper that reads a legacy `prompts.json` — the word records where
 * the skill came from, and is not a live product noun.
 */
export type SkillOrigin =
  | 'user'
  | 'registry'
  | 'plugin'
  | 'package'
  | 'migrated-playbook';

export interface Skill extends RegistryItem {
  name: string;
  source?: string;
  path?: string;
  installedVersion?: string;
  updateAvailable?: boolean;
  body?: string;
  resources?: Array<{ name: string; path: string }>;
  scripts?: Array<{ name: string; path: string }>;
  provenance?: SkillProvenance;
  command?: SkillCommand;
  /**
   * Why an enabled command declaration is not in effect (a clash the server's
   * `resolveSkillCommands` awarded to another skill, a word nobody can type).
   * Written by the skills listing/detail — `command.enabled: false` plus this
   * field is the server's verdict, and clients must not re-arbitrate it.
   */
  commandDiagnostic?: string;
  variables?: SkillVariable[];
  /**
   * Usage counters, joined from `<home>/skills/.usage.json`. Never present on
   * disk in the skill package itself; a read-only package/plugin skill has
   * stats too.
   */
  stats?: SkillStats;
  /**
   * Why `stats` is absent, when the counter store could not be read. An
   * unreadable store is NOT an unused skill: a reader must render this instead
   * of "0 runs", which is a different fact.
   */
  statsUnavailable?: string;
  /** Identifiers this skill was migrated from (legacy UUIDs, `<plugin>:<id>`). */
  legacyIds?: string[];
  origin?: SkillOrigin;
}

export interface InstallResult {
  success: boolean;
  message: string;
}

export type ProviderCapabilityStatus =
  | 'ready'
  | 'warning'
  | 'error'
  | 'disabled'
  | 'unknown';
export type ProviderCapabilityAuthStatus =
  | 'authenticated'
  | 'unauthenticated'
  | 'unknown';
export type ProviderCapabilityFreshness =
  | 'live'
  | 'cached'
  | 'stale'
  | 'unknown';

export interface ProviderCapabilityModel {
  id: string;
  name: string;
  provider?: string;
  capabilities?: Record<string, unknown>;
}

export interface ProviderNativeSkill {
  id: string;
  name: string;
  description?: string;
  path?: string;
  scope?: string;
  enabled: boolean;
  provenance: GuidanceAssetReference;
}

export interface ProviderNativeSlashCommand {
  id: string;
  name: string;
  description?: string;
  inputHint?: string;
  provenance: GuidanceAssetReference;
}

/** #895 wave B: per-connection session-surface evidence from a live protocol
 * handshake (ACP initialize). Evidence only — probe results may upgrade the
 * matrix, never downgrade a session (agent-engine-unification.md §4.1). */
export interface ProviderSessionSurfaceEvidence {
  loadSession?: boolean;
  mcpTransports?: Array<'stdio' | 'http' | 'sse'>;
  promptImage?: boolean;
  promptAudio?: boolean;
  promptEmbeddedContext?: boolean;
  sessionResume?: boolean;
}

export interface ProviderCapabilityInventory {
  providerId: string;
  connectionId?: string;
  displayName: string;
  status: ProviderCapabilityStatus;
  authStatus: ProviderCapabilityAuthStatus;
  version?: string | null;
  checkedAt?: string;
  freshness: ProviderCapabilityFreshness;
  source: GuidanceAssetSourceOwner;
  message?: string;
  models: ProviderCapabilityModel[];
  skills: ProviderNativeSkill[];
  slashCommands: ProviderNativeSlashCommand[];
  sessionSurfaces?: ProviderSessionSurfaceEvidence;
}
