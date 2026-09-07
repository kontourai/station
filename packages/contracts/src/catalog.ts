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
 * writes `user` (or `project` when the write is project-scoped), a registry
 * install writes `registry`, and `package`/`plugin`/`project` are derived from
 * the root a skill was discovered under. `migrated-playbook` is written by
 * `station doctor --migrate-playbooks`, the one-shot helper that reads a legacy
 * `prompts.json` — the word records where the skill came from, and is not a
 * live product noun.
 *
 * `user` and `project` are both writable roots and differ only in scope:
 * `user` is `<home>/skills` (every project on this machine sees it), `project`
 * is `<home>/projects/<slug>/skills` (one workspace does). Before `project`
 * existed a workspace-scoped skill reported `user`, so a reader could not tell
 * the two apart and no surface could name the difference (#1582 D6).
 */
export type SkillOrigin =
  | 'user'
  | 'project'
  | 'registry'
  | 'plugin'
  | 'package'
  | 'migrated-playbook';

/**
 * Why Station will not write a skill's own package, as a code a reader may
 * branch on.
 *
 * The DECISION belongs to the server (`SkillService.isSkillWritable`); this is
 * that decision projected, never a second derivation of it. `source` and
 * `origin` are close enough to be tempting and answer a different question: a
 * registry install living in a writable root is perfectly writable, and an
 * install record stating `source: 'local'` says nothing about which root the
 * package actually sits in. The rule has already moved once — in #1619 it
 * stopped meaning "this name resolves to this one directory" and started
 * meaning "this package sits in a root Station writes" — so a client
 * rebuilding it from those fields would have been wrong before that change and
 * wrong again after it.
 */
export type SkillWriteRefusalReason =
  /**
   * A SOURCE serves it in place (a plugin's prompt file), not a directory
   * Station owns. Its remedy is unlike the others': there is no registry entry
   * to install, so the plugin that provides it is the thing to change.
   */
  | 'served-in-place'
  /** It is served from a canonical package root, which ships read-only. */
  | 'canonical-package'
  /** Its package sits in some other root, which Station does not write. */
  | 'outside-writable-root'
  /**
   * Its name cannot become a directory NAME, so Station cannot work out where
   * it would write this package. Discovery registers a frontmatter `name`
   * unvalidated, so this is reachable; the remedy is a rename, not an install.
   *
   * What could not be resolved is the WRITE TARGET. The package itself was
   * discovered and its directory is known, so `packageDirectory` is populated
   * here like anywhere else — a rename is not actionable without it.
   */
  | 'unresolvable-name';

/** The server's refusal to write a skill package, with its own sentence about it. */
export interface SkillWriteRefusal {
  reason: SkillWriteRefusalReason;
  /**
   * WHAT is wrong, in Station's own words, as a complete sentence — for
   * display. Readers render it rather than composing a description from
   * `reason`, and nothing may branch on the text.
   *
   * It contains NO author-controlled text: not the skill's name, not its
   * path, and not an exception message. That is the whole point of it. An
   * earlier draft of this field interpolated the package directory, and review
   * showed the mitigation had simply moved rather than held — a plugin names
   * its own directories, so a refusal could be made to read as a session-expiry
   * notice directing the reader to another domain, using a bland frontmatter
   * name and hostile prose one level up in the path.
   *
   * Where the package sits is a fact a reader needs, so it is carried in
   * `packageDirectory` and rendered as its own element. What to DO about the refusal
   * belongs to `reason` — the remedies genuinely differ — so a reader switches
   * on the code for the remedy and renders this for the description.
   */
  detail: string;
  /**
   * WHERE THE PACKAGE SITS — the directory the refused package was discovered
   * in. Named for the package on purpose: a refusal involves two directories,
   * this one and the place Station would have written instead, and a bare
   * `directory` reads just as easily as the latter.
   *
   * Present for every refusal the rule currently produces, because the rule
   * answers "writable" outright when no package was discovered, so a refusal
   * always has a discovered location behind it. It stays OPTIONAL rather than
   * required only because the rule itself is being widened in a sibling change
   * (#1619) and a reader must not be forced to fabricate a path if some future
   * reason has none. Do not read the optionality as a case that exists today.
   *
   * AUTHOR-CONTROLLED, every segment of it: a plugin chooses its directory
   * names and the last segment is usually the skill's own name. Surfaces must
   * render it as its own element — a path, labelled as a path — and never
   * splice it into `detail`'s sentence, because text that borrows the grammar
   * of Station's explanation is read as Station speaking.
   */
  packageDirectory?: string;
}

export interface Skill extends RegistryItem {
  name: string;
  source?: string;
  /**
   * May Station write this skill's own package — the server's writability
   * predicate PROJECTED, never re-derived here. Absent means the server did
   * not state it, and a reader must then treat the package as read-only: a
   * missing decision is not a permissive one.
   */
  writable?: boolean;
  /** Why `writable` is false. Absent whenever `writable` is not false. */
  writeRefusal?: SkillWriteRefusal;
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
