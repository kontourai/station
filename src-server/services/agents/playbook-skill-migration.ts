/**
 * Playbooks → Skills: the one-way pass that folds `<home>/prompts` into
 * `<home>/skills` (UX audit slice 2, `docs/adr/0016-*`).
 *
 * Three rules shape every line here, because this writes a user's own data:
 *
 * 1. **Nothing is ever deleted.** The playbook store is RENAMED to
 *    `prompts.migrated-<ts>/`, so rolling back is a rename, not a restore.
 * 2. **Resumable, and idempotent.** Every skill records the playbook UUID it
 *    came from in `legacyIds`, so a pass interrupted halfway recognises what it
 *    already wrote and finishes the rest. A completed pass leaves a marker and
 *    a second run is a no-op.
 * 3. **A label only where something derived it.** `origin: 'migrated-playbook'`
 *    and `legacyIds` are written by this pass and nothing else, and every
 *    migrated skill gets `command.enabled: true` because being runnable as a
 *    `/command` is the ONLY behaviour a playbook ever had — that is a
 *    derivation from what playbooks are, not a default we liked.
 *
 * It writes through slice 1's seams only — `createLocalSkill` (which owns
 * `SKILL.md` + `skill.json` + the name refusal), `SkillUsageService` (the
 * counter side store) and the agent config loader — so there is no second
 * serializer, no raw path join, and no second validator.
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import type {
  SkillCommand,
  SkillOrigin,
  SkillProvenance,
  SkillStats,
  SkillVariable,
} from '@kontourai/station-contracts/catalog';
import {
  resolveSkillCommandName,
  skillCommandSlug,
} from '@kontourai/station-contracts/skill-command';
import { isSafeSkillName, skillsRootDir } from '../../domain/skill-paths.js';
import {
  type AgentPromptTranslation,
  applyAgentPromptTranslation,
  translateAgentPromptBindings,
} from './agent-skill-binding.js';

interface LegacyPlaybookStorageRoots {
  promptsDir: string;
  promptsFile: string;
  filesDir: string;
}

/**
 * One row of a legacy `<home>/prompts/prompts.json`.
 *
 * Declared HERE and nowhere else: this module is the last reader of that
 * format, so the shape belongs to the reader rather than to the live
 * contracts — nothing else in Station may grow a second consumer of it.
 */
export interface LegacyPlaybookRecord {
  id: string;
  name: string;
  content: string;
  storageMode?: 'json-inline' | 'markdown-file';
  description?: string;
  category?: string;
  tags?: string[];
  agent?: string;
  global?: boolean;
  source?: string;
  requires?: string[];
  icon?: string;
  provenance?: SkillProvenance;
  stats?: SkillStats;
  createdAt: string;
  updatedAt: string;
}

function playbookStorageRoots(homeDir: string): LegacyPlaybookStorageRoots {
  const promptsDir = join(homeDir, 'prompts');
  return {
    promptsDir,
    promptsFile: join(promptsDir, 'prompts.json'),
    filesDir: join(promptsDir, 'files'),
  };
}

/**
 * Frontmatter as the retired `PromptService` wrote and read it — `key: value`
 * lines plus `- item` list continuations. Deliberately NOT the skill
 * frontmatter parser: this reads a format Station no longer writes, and
 * pointing it at the live parser would couple a frozen legacy shape to one
 * that is still moving.
 */
function parseLegacyFrontmatter(text: string): {
  meta: Record<string, unknown>;
  body: string;
} {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: text.trim() };
  const meta: Record<string, unknown> = {};
  let currentArrayKey: string | null = null;
  for (const rawLine of match[1].split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    if (currentArrayKey && line.trim().startsWith('- ')) {
      meta[currentArrayKey] ??= [] as string[];
      const list = meta[currentArrayKey] as string[];
      list.push(
        line
          .trim()
          .slice(2)
          .replace(/^["']|["']$/g, ''),
      );
      continue;
    }
    currentArrayKey = null;
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!value) {
      currentArrayKey = key;
      continue;
    }
    meta[key] =
      value === 'true' || value === 'false'
        ? value === 'true'
        : value.replace(/^["']|["']$/g, '');
  }
  return { meta, body: match[2].trim() };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * The markdown-backed half of the legacy store: `files/<id>.md` carrying the
 * authored body, with `files/<id>.meta.json` beside it holding the identity
 * and counters that never belonged in frontmatter.
 *
 * This half is NOT optional. The pass archives the whole `prompts/` directory
 * when it succeeds, so a reader that skips `files/` reports success and takes
 * the only copy of those playbooks with it (review H1).
 */
function loadMarkdownPlaybooks(filesDir: string): LegacyPlaybookRecord[] {
  if (!existsSync(filesDir)) return [];
  return readdirSync(filesDir)
    .filter((file) => file.endsWith('.md'))
    .map((file) => {
      const fileId = basename(file, '.md');
      const { meta, body } = parseLegacyFrontmatter(
        readFileSync(join(filesDir, file), 'utf-8'),
      );
      const metaPath = join(filesDir, `${fileId}.meta.json`);
      const sidecar: Record<string, unknown> = existsSync(metaPath)
        ? JSON.parse(readFileSync(metaPath, 'utf-8'))
        : {};
      const now = new Date().toISOString();
      return {
        id: optionalString(sidecar.id) || fileId,
        name: optionalString(meta.name) || fileId,
        content: body,
        description: optionalString(meta.description),
        category: optionalString(meta.category),
        tags: Array.isArray(meta.tags) ? (meta.tags as string[]) : undefined,
        agent: optionalString(meta.agent),
        global: meta.global === true,
        source: optionalString(sidecar.source) || 'local',
        provenance: sidecar.provenance as
          | LegacyPlaybookRecord['provenance']
          | undefined,
        stats: sidecar.stats as LegacyPlaybookRecord['stats'] | undefined,
        createdAt: optionalString(sidecar.createdAt) || now,
        updatedAt: optionalString(sidecar.updatedAt) || now,
        storageMode: 'markdown-file' as const,
      };
    });
}

/**
 * Every playbook in this home, from BOTH stores the retired `PromptService`
 * read — `prompts.json` and the `files/` markdown rows — deduped by id in the
 * same order it used, so a markdown row wins over a stale JSON row of the same
 * id rather than the other way round.
 */
function loadPlaybooksFrom(homeDir: string): LegacyPlaybookRecord[] {
  const { promptsFile, filesDir } = playbookStorageRoots(homeDir);
  const jsonRows = existsSync(promptsFile)
    ? (JSON.parse(readFileSync(promptsFile, 'utf-8')) as LegacyPlaybookRecord[])
    : [];
  const deduped = new Map<string, LegacyPlaybookRecord>();
  for (const row of [...jsonRows, ...loadMarkdownPlaybooks(filesDir)]) {
    deduped.set(row.id, row);
  }
  return Array.from(deduped.values());
}

/** The file whose presence means "this home has already been migrated". */
export const PLAYBOOK_MIGRATION_MARKER = '.migrated.json';

/**
 * The `origin` this pass stamps on every skill it writes. It is what makes a
 * half-written package recognisably OURS, as distinct from an unrelated one
 * that happens to record the same legacy id.
 */
const MIGRATED_PLAYBOOK_ORIGIN = 'migrated-playbook';

/** What one playbook became. */
export interface MigratedPlaybookRow {
  playbookId: string;
  playbookName: string;
  skillName: string;
  /** The name we wanted, when a collision forced a different one. */
  renamedFrom?: string;
  /** `command.global` — offered to every agent's chat, not just attached ones. */
  global: boolean;
  /** Already present from an earlier (interrupted) pass; nothing was written. */
  alreadyMigrated: boolean;
  /**
   * An earlier pass wrote this skill's install record but died before its
   * `SKILL.md`; this pass finished the package rather than writing a duplicate.
   */
  repaired?: boolean;
  /** Whether the playbook's run/outcome counters were taken over. */
  statsAdopted: boolean;
}

/** What one agent record gained, and lost. */
export interface MigratedAgentRow {
  slug: string;
  /** Skill names appended to `agent.skills`. */
  addedSkills: string[];
  /** `agent.prompts` UUIDs that resolved; the key itself is then deleted. */
  resolvedPromptIds: string[];
  /** `agent.prompts` UUIDs no playbook or skill claims. Logged and dropped. */
  droppedPromptIds: string[];
}

export type PlaybookSkillMigrationStatus =
  | 'skipped'
  | 'migrated'
  | 'dry-run'
  | 'pending'
  | 'failed';

export interface PlaybookSkillMigrationReport {
  status: PlaybookSkillMigrationStatus;
  /** Why, whenever the status is not a plain `migrated`. */
  reason?: string;
  homeDir: string;
  skills: MigratedPlaybookRow[];
  agents: MigratedAgentRow[];
  /** `agent:` pins naming an agent this home has no record for. */
  unboundAgentPins: Array<{ agentSlug: string; skillName: string }>;
  /**
   * A package this migration did NOT write already records one of these
   * playbook ids. Nothing was overwritten; the playbook migrated under its own
   * name and the collision is reported.
   */
  conflicts: Array<{
    playbookId: string;
    playbookName: string;
    claimedBy: string;
    migratedAs: string;
  }>;
  /**
   * Agent records the writer refused. NON-EMPTY MEANS THE PASS DID NOT
   * COMPLETE: the marker is withheld and the playbook store is left in place,
   * so the next start retries exactly these (review H1).
   */
  failedAgents: Array<{ slug: string; reason: string }>;
  /**
   * Plugin-registered rows, left exactly where they are: they are scanned in
   * place by `PluginCommandSkillSource` and copying them would recreate the
   * stale-copy lifecycle this merge exists to remove.
   */
  pluginRowsLeftInPlace: number;
  /** Where `<home>/prompts` was moved to, once the pass succeeded. */
  promptsArchivedTo?: string;
  errors: string[];
}

/** The skill writes this migration is allowed to make. */
export interface PlaybookMigrationSkillPort {
  listSkills(): Array<{
    name: string;
    command?: SkillCommand;
    legacyIds?: string[];
    /** Only a skill this migration wrote may be adopted as its own prior work. */
    origin?: SkillOrigin;
    /** Re-derived at every discovery, so it reserves nothing here. */
    servedInPlace?: true;
  }>;
  createLocalSkill(
    input: PlaybookSkillInput,
    projectHomeDir: string,
  ): Promise<{ success: boolean; message: string }>;
  completeInterruptedLocalSkillPackage(
    input: PlaybookSkillInput,
    expectedIdentity: {
      name: string;
      origin: 'migrated-playbook';
      legacyId: string;
    },
    projectHomeDir: string,
  ): Promise<{ success: boolean; repaired: boolean; message: string }>;
  adoptSkillStats(
    name: string,
    stats: SkillStats,
  ): Promise<{ stats: SkillStats; adopted: boolean }>;
}

type PlaybookSkillInput = {
  name: string;
  description?: string;
  body: string;
  tags?: string[];
  category?: string;
  provenance?: SkillProvenance;
  command?: SkillCommand;
  variables?: SkillVariable[];
  legacyIds?: string[];
  origin?: SkillOrigin;
  installedAt?: string;
};

/**
 * The agent writes this migration is allowed to make.
 *
 * `saveAgent` rather than `updateAgent` deliberately: `updateAgent` merges and
 * drops `undefined` values, so it can add `skills` but can NEVER remove
 * `prompts` — and a `prompts` key left behind is a binding that still looks
 * live. Saving the whole record is the only way to delete a field.
 */
export interface PlaybookMigrationAgentPort {
  listAgents(): Promise<Array<{ slug: string }>>;
  /** Read-only; used by the dry run, which must not take a write lock. */
  loadAgent(slug: string): Promise<Record<string, unknown>>;
  /**
   * Read → derive → write inside the agent's own lock. The whole record is
   * returned by the updater, which is what lets `prompts` be DELETED (a merge
   * cannot remove a key), and the read happening under the same lock as the
   * write is what stops a concurrent editor save being republished away.
   * `null` means nothing to change, and nothing is written.
   */
  mutateAgent(
    slug: string,
    updater: (
      current: Record<string, unknown>,
    ) => Record<string, unknown> | null,
  ): Promise<Record<string, unknown> | null>;
}

export interface PlaybookSkillMigrationOptions {
  homeDir: string;
  skills: PlaybookMigrationSkillPort;
  agents: PlaybookMigrationAgentPort;
  logger: {
    info: (message: string, meta?: Record<string, unknown>) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
  };
  /** Report what WOULD happen and write nothing at all. */
  dryRun?: boolean;
  /** Injectable for tests; the archive suffix. */
  now?: () => Date;
}

function emptyReport(
  homeDir: string,
  status: PlaybookSkillMigrationStatus,
  reason?: string,
): PlaybookSkillMigrationReport {
  return {
    status,
    ...(reason ? { reason } : {}),
    homeDir,
    skills: [],
    agents: [],
    unboundAgentPins: [],
    conflicts: [],
    failedAgents: [],
    pluginRowsLeftInPlace: 0,
    errors: [],
  };
}

/**
 * Record what one agent gained and lost, and warn about the ids nothing claims.
 *
 * The migration DROPS an unresolvable id, and says so. It is emptying a store
 * that is about to be archived — refusing would strand the whole home over a
 * dangling id nothing can ever resolve. A live save refuses instead; see
 * `agent-skill-binding.ts`.
 */
function recordAgentRow(
  report: PlaybookSkillMigrationReport,
  agentSlug: string,
  translation: AgentPromptTranslation | undefined,
  logger: PlaybookSkillMigrationOptions['logger'],
): void {
  if (!translation) return;
  if (translation.unresolvedPromptIds.length > 0) {
    logger.warn('Agent prompt ids matched no playbook; dropped', {
      agentSlug,
      promptIds: translation.unresolvedPromptIds,
    });
  }
  report.agents.push({
    slug: agentSlug,
    addedSkills: translation.addedSkills,
    resolvedPromptIds: translation.resolvedPromptIds,
    droppedPromptIds: translation.unresolvedPromptIds,
  });
}

/**
 * Write (or finish) the skill package for one playbook.
 *
 * ONE call site for the first write and for the repair of a half-written one,
 * so a package completed on a retry is byte-identical to one written in a
 * single pass — a repair that produced a slightly different skill would be a
 * silent divergence nobody would ever look for.
 */
function skillInputForPlaybook(
  skillName: string,
  playbook: LegacyPlaybookRecord,
): PlaybookSkillInput {
  return {
    name: skillName,
    description: playbook.description,
    // Byte-for-byte. A playbook's content IS the skill's body; nothing
    // reformats it on the way through.
    body: playbook.content,
    tags: playbook.tags,
    category: playbook.category,
    provenance: playbook.provenance,
    // The only behaviour a playbook ever had.
    command: { enabled: true, global: playbook.global === true },
    legacyIds: [playbook.id],
    origin: MIGRATED_PLAYBOOK_ORIGIN,
    installedAt: playbook.createdAt,
  };
}

async function writeSkillForPlaybook(
  skills: PlaybookMigrationSkillPort,
  homeDir: string,
  skillName: string,
  playbook: LegacyPlaybookRecord,
): Promise<void> {
  const result = await skills.createLocalSkill(
    skillInputForPlaybook(skillName, playbook),
    homeDir,
  );
  if (!result.success) {
    throw new Error(`could not create skill '${skillName}': ${result.message}`);
  }
}

/**
 * Every skill PACKAGE on disk that records a legacy id, whether or not
 * discovery could see it.
 *
 * `listSkills()` only knows skills that parsed a `SKILL.md`, so it cannot see
 * an install record left behind by a pass that died between its two writes.
 * That record is exactly where the playbook UUID lives, and reading it is what
 * turns a half-written skill into something this pass RECOGNISES instead of
 * duplicating (review H2).
 *
 * Unreadable or id-less records are skipped in silence: they are simply not
 * evidence that any playbook was migrated.
 */
function scanSkillPackagesByLegacyId(
  homeDir: string,
): Map<string, { name: string; hasBody: boolean; adoptable: boolean }> {
  const index = new Map<
    string,
    { name: string; hasBody: boolean; adoptable: boolean }
  >();
  const root = skillsRootDir(homeDir);
  if (!existsSync(root)) return index;
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return index;
  }
  for (const name of entries) {
    const recordPath = join(root, name, 'skill.json');
    if (!existsSync(recordPath)) continue;
    let record: { legacyIds?: unknown; origin?: unknown };
    try {
      record = JSON.parse(readFileSync(recordPath, 'utf-8'));
    } catch {
      continue;
    }
    if (!Array.isArray(record.legacyIds)) continue;
    const hasBody = existsSync(join(root, name, 'SKILL.md'));
    // Only a package THIS migration wrote may be adopted and repaired. A
    // legacy id is just a string a user can put in their own `skill.json`, and
    // treating a coincident one as our own interrupted output would overwrite
    // an unrelated package's install record and publish a playbook's body into
    // its directory (review delta MEDIUM). `origin` is written by this pass and
    // nothing else, so it is the identity check the id alone is not.
    const adoptable = record.origin === MIGRATED_PLAYBOOK_ORIGIN;
    for (const legacyId of record.legacyIds) {
      if (typeof legacyId === 'string' && legacyId !== '') {
        index.set(legacyId, { name, hasBody, adoptable });
      }
    }
  }
  return index;
}

/**
 * Did this playbook's counters ever record anything? `qualityScore` is
 * excluded deliberately: it is derived from the other four and never stored,
 * so a value there is not evidence that anything happened.
 */
function hasCountedSomething(stats: SkillStats): boolean {
  return (
    stats.runs > 0 ||
    stats.successes > 0 ||
    stats.failures > 0 ||
    stats.lastRunAt !== undefined ||
    stats.lastOutcomeAt !== undefined
  );
}

/** A write refused by the filesystem itself, rather than by our own rules. */
function isUnwritableHomeError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === 'EROFS' || code === 'EACCES' || code === 'EPERM';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The directory name a playbook becomes.
 *
 * `skillCommandSlug` is the SAME derivation the slash command already used for
 * a playbook's name, so a migrated playbook keeps answering to the `/command`
 * its user types — that is the whole point of reusing it rather than inventing
 * a sanitizer here.
 */
function candidateNames(playbookName: string, playbookId: string): string {
  const slug = skillCommandSlug(playbookName);
  // A name made entirely of punctuation slugs to the empty string, which is
  // not a directory. Fall back to something that still names its origin.
  return slug || `playbook-${playbookId.slice(0, 8)}`;
}

/**
 * Reserve a directory name for `playbook`, avoiding three separate clashes:
 * a skill directory that already exists, a name this same pass already took,
 * and a `/command` word another skill already answers to. The `-2`/`-3` suffix
 * is recorded in the report — it is the one lossy step in the whole merge.
 */
function reserveSkillName(
  desired: string,
  takenNames: Set<string>,
  takenCommands: Set<string>,
): string {
  let candidate = desired;
  let suffix = 2;
  while (
    takenNames.has(candidate) ||
    takenCommands.has(candidate) ||
    !isSafeSkillName(candidate)
  ) {
    candidate = `${desired}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export async function migratePlaybooksToSkills(
  options: PlaybookSkillMigrationOptions,
): Promise<PlaybookSkillMigrationReport> {
  const { homeDir, skills, agents, logger, dryRun = false } = options;
  const roots = playbookStorageRoots(homeDir);
  const markerPath = join(roots.promptsDir, PLAYBOOK_MIGRATION_MARKER);

  if (existsSync(markerPath)) {
    return emptyReport(
      homeDir,
      'skipped',
      `already migrated (${markerPath} exists)`,
    );
  }
  if (!existsSync(roots.promptsFile) && !existsSync(roots.filesDir)) {
    return emptyReport(homeDir, 'skipped', 'this home has no playbook store');
  }

  const report = emptyReport(homeDir, dryRun ? 'dry-run' : 'migrated');

  let playbooks: LegacyPlaybookRecord[];
  try {
    playbooks = loadPlaybooksFrom(homeDir);
  } catch (error) {
    // An unreadable playbook store is NOT an empty one. Refuse rather than
    // archive a file we could not read, and leave no marker so a repaired
    // store is picked up on the next boot.
    report.status = 'failed';
    report.reason = `playbook store could not be read: ${errorText(error)}`;
    report.errors.push(report.reason);
    logger.warn(
      'Playbooks→Skills migration could not read the playbook store',
      {
        homeDir,
        error,
      },
    );
    return report;
  }

  const pluginRows = playbooks.filter((row) =>
    row.source?.startsWith('plugin:'),
  );
  report.pluginRowsLeftInPlace = pluginRows.length;
  const localRows = playbooks.filter(
    (row) => !row.source?.startsWith('plugin:'),
  );

  const existingSkills = skills.listSkills();
  // A skill served IN PLACE (a plugin's prompt file) does not reserve
  // anything. Its name is re-derived at every discovery, so it moves aside for
  // a migrated playbook; a directory Station owns cannot. Reserving against it
  // renamed the USER's playbook — changing the `/command` word they type —
  // because a plugin happened to ship the same title (seen on a live boot).
  const durableSkills = existingSkills.filter((skill) => !skill.servedInPlace);
  const takenNames = new Set(durableSkills.map((skill) => skill.name));
  const takenCommands = new Set(
    durableSkills
      .map((skill) => resolveSkillCommandName(skill))
      .filter((word): word is string => word !== null),
  );
  /**
   * Legacy id → who already claims it, from BOTH the discovered skills and the
   * packages discovery cannot see (an install record with no `SKILL.md`, left
   * by a pass that died between its two writes).
   *
   * `adoptable` is the whole point. A `legacyId` is just a string a user can
   * put in their own `skill.json`, so it identifies our prior work only when
   * the record also carries the `origin` this pass stamps. Applying that gate
   * to the raw scan but not to DISCOVERED skills left the worse half open: a
   * complete user skill with `origin: 'user'` and a coincident id was read as
   * `alreadyMigrated`, so the playbook's agent pin was routed to somebody
   * else's skill and the source playbook was archived without its package ever
   * being written (review delta-2 MEDIUM).
   */
  const claimants = new Map<
    string,
    { name: string; hasBody: boolean; adoptable: boolean }
  >();
  for (const skill of existingSkills) {
    for (const legacyId of skill.legacyIds ?? []) {
      claimants.set(legacyId, {
        name: skill.name,
        hasBody: true,
        adoptable: skill.origin === MIGRATED_PLAYBOOK_ORIGIN,
      });
    }
  }
  for (const [legacyId, entry] of scanSkillPackagesByLegacyId(homeDir)) {
    if (!claimants.has(legacyId)) claimants.set(legacyId, entry);
  }

  /** Legacy id → skill name, for both resumability and `agent.prompts`. */
  const byLegacyId = new Map<string, string>();
  for (const [legacyId, entry] of claimants) {
    // The NAME is taken either way — a directory is a directory, whoever wrote
    // it. Only the identity mapping is restricted to packages this migration
    // produced, so an unrelated record carrying a coincident id blocks the
    // name without being mistaken for our own work.
    takenNames.add(entry.name);
    if (entry.adoptable) byLegacyId.set(legacyId, entry.name);
  }

  /** agent slug → skill names its playbooks pinned to it. */
  const pins = new Map<string, string[]>();
  const addPin = (agentSlug: string, skillName: string) => {
    pins.set(agentSlug, [...(pins.get(agentSlug) ?? []), skillName]);
  };

  try {
    for (const playbook of localRows) {
      const alreadyMigrated = byLegacyId.get(playbook.id);
      if (alreadyMigrated) {
        // Half-written: the record landed, the body did not. Finish the
        // package under the name it already owns rather than leaving a skill
        // the listing cannot show — the alternative is an install record no
        // reader can render and a playbook store that keeps looking migrated.
        const needsRepair = claimants.get(playbook.id)?.hasBody === false;
        if (needsRepair && !dryRun) {
          const repair = await skills.completeInterruptedLocalSkillPackage(
            skillInputForPlaybook(alreadyMigrated, playbook),
            {
              name: alreadyMigrated,
              origin: MIGRATED_PLAYBOOK_ORIGIN,
              legacyId: playbook.id,
            },
            homeDir,
          );
          if (!repair.success) {
            throw new Error(
              `could not repair skill '${alreadyMigrated}': ${repair.message}`,
            );
          }
        }
        report.skills.push({
          playbookId: playbook.id,
          playbookName: playbook.name,
          skillName: alreadyMigrated,
          global: playbook.global === true,
          alreadyMigrated: true,
          ...(needsRepair ? { repaired: true } : {}),
          statsAdopted: false,
        });
        if (playbook.agent) addPin(playbook.agent, alreadyMigrated);
        continue;
      }

      // A package that claims this playbook's id but was not written by this
      // migration is a CONFLICT, not a resumption: it is reported, and this
      // playbook takes the next free name rather than overwriting it.
      const conflicting = claimants.get(playbook.id);
      const desired = candidateNames(playbook.name, playbook.id);
      const skillName = reserveSkillName(desired, takenNames, takenCommands);
      if (conflicting) {
        report.conflicts.push({
          playbookId: playbook.id,
          playbookName: playbook.name,
          claimedBy: conflicting.name,
          migratedAs: skillName,
        });
        logger.warn(
          'A skill this migration did not write already claims this playbook id',
          {
            playbookId: playbook.id,
            claimedBy: conflicting.name,
            migratedAs: skillName,
          },
        );
      }
      takenNames.add(skillName);
      takenCommands.add(skillName);
      byLegacyId.set(playbook.id, skillName);

      const row: MigratedPlaybookRow = {
        playbookId: playbook.id,
        playbookName: playbook.name,
        skillName,
        ...(skillName === desired ? {} : { renamedFrom: desired }),
        global: playbook.global === true,
        alreadyMigrated: false,
        statsAdopted: false,
      };

      if (!dryRun) {
        await writeSkillForPlaybook(skills, homeDir, skillName, playbook);
        // Only counters that counted something. The playbook reader seeds
        // every row with a zeroed `stats` object, so adopting unconditionally
        // writes a `.usage.json` entry for a playbook nobody ever ran — a
        // record asserting "0 runs" where the honest answer is "never
        // counted", which is the distinction the usage store's own
        // `statsUnavailable` contract exists to keep (seen live: `ship-it`
        // gained a zero row on the first --temp-home boot).
        if (playbook.stats && hasCountedSomething(playbook.stats)) {
          const adoption = await skills.adoptSkillStats(
            skillName,
            playbook.stats,
          );
          row.statsAdopted = adoption.adopted;
        }
      }

      report.skills.push(row);
      // The playbook's `agent:` pin becomes an `agent.skills` binding, not
      // `agent:` frontmatter: after the merge the agent record is where a
      // binding lives, and two places to say it is how they drift apart.
      if (playbook.agent) addPin(playbook.agent, skillName);
    }

    await bindAgents({ agents, pins, byLegacyId, report, dryRun, logger });

    if (report.failedAgents.length > 0) {
      // A binding this pass could not write is UNFINISHED WORK, not a footnote.
      // Completing here would write the marker and archive `prompts/`, and the
      // agent would then be stranded forever: with the flag on its `prompts`
      // key is inert, with the flag off the store it names is gone, and no
      // later boot ever retries (review H1). Every skill already written keeps
      // its `legacyIds`, so the next start resumes and re-attempts exactly
      // these agents.
      report.status = 'pending';
      report.reason = `${report.failedAgents.length} agent record(s) could not be updated (${report.failedAgents
        .map((entry) => entry.slug)
        .join(
          ', ',
        )}); the playbook store is left in place and the migration will retry on the next start`;
      logger.warn(
        'Playbooks→Skills migration incomplete: agent bindings were refused',
        { homeDir, failedAgents: report.failedAgents },
      );
      return report;
    }

    if (!dryRun) {
      // The marker is the last write to the playbook store: everything above
      // has landed, so a crash from here on leaves a home that skips rather
      // than repeats. The archive rename that follows carries it along.
      writeFileSync(
        markerPath,
        `${JSON.stringify(
          {
            migratedAt: (options.now?.() ?? new Date()).toISOString(),
            skills: report.skills,
            agents: report.agents,
            unboundAgentPins: report.unboundAgentPins,
            conflicts: report.conflicts,
            pluginRowsLeftInPlace: report.pluginRowsLeftInPlace,
          },
          null,
          2,
        )}\n`,
        'utf-8',
      );

      const stamp = (options.now?.() ?? new Date())
        .toISOString()
        .replace(/[:.]/g, '-');
      const archive = join(homeDir, `prompts.migrated-${stamp}`);
      try {
        // Never a delete. Rolling this migration back is `mv` in the other
        // direction plus removing the skills it wrote.
        renameSync(roots.promptsDir, archive);
        report.promptsArchivedTo = archive;
      } catch (error) {
        // The migration itself succeeded; only the tidy-up did not. The marker
        // is already in place, so the next boot skips rather than repeats.
        report.errors.push(
          `playbook store kept at ${roots.promptsDir}: ${errorText(error)}`,
        );
        logger.warn('Playbooks→Skills migration could not archive the store', {
          promptsDir: roots.promptsDir,
          error,
        });
      }
    }
  } catch (error) {
    if (isUnwritableHomeError(error)) {
      // Writes are not allowed here YET (a read-only mount, a home not owned
      // by this process). Say so plainly and leave no marker: every skill this
      // pass did write carries its `legacyIds`, so the next boot resumes from
      // exactly where this one stopped.
      report.status = 'pending';
      report.reason = `writes are not permitted in ${homeDir} yet (${errorText(error)}); the migration will resume on the next start`;
      report.errors.push(report.reason);
      logger.warn('Playbooks→Skills migration pending: home is not writable', {
        homeDir,
        error,
      });
      return report;
    }
    report.status = 'failed';
    report.reason = errorText(error);
    report.errors.push(report.reason);
    logger.warn('Playbooks→Skills migration stopped', { homeDir, error });
    return report;
  }

  logger.info(
    dryRun
      ? 'Playbooks→Skills migration dry run'
      : 'Playbooks→Skills migration complete',
    {
      skills: report.skills.length,
      agentsBound: report.agents.length,
      pluginRowsLeftInPlace: report.pluginRowsLeftInPlace,
      archivedTo: report.promptsArchivedTo,
    },
  );
  return report;
}

/**
 * Move every binding onto the agent record: the `agent:` pins collected above,
 * and each agent's own `prompts: string[]` of playbook UUIDs.
 *
 * Both are appended to `agent.skills` and `prompts` is then DELETED. This
 * ACTIVATES bindings that were previously inert — nothing in the runtime ever
 * read `agent.prompts`, while `agent.skills` reaches the model. That behaviour
 * change is the point, and it is stated in the release note; the alternative
 * (dropping `prompts` silently) discards what the user asked for when they
 * ticked the box.
 */
async function bindAgents(context: {
  agents: PlaybookMigrationAgentPort;
  pins: Map<string, string[]>;
  byLegacyId: Map<string, string>;
  report: PlaybookSkillMigrationReport;
  dryRun: boolean;
  logger: PlaybookSkillMigrationOptions['logger'];
}): Promise<void> {
  const { agents, pins, byLegacyId, report, dryRun, logger } = context;
  const known = new Set((await agents.listAgents()).map((agent) => agent.slug));

  for (const [agentSlug, skillNames] of pins) {
    if (known.has(agentSlug)) continue;
    for (const skillName of skillNames) {
      report.unboundAgentPins.push({ agentSlug, skillName });
    }
    logger.warn('Playbook pinned to an agent this home has no record of', {
      agentSlug,
      skills: skillNames,
    });
  }

  for (const agentSlug of known) {
    // Derived INSIDE the lock, from the record as it is at that instant. The
    // previous shape read the record, derived, and then wrote it back whole,
    // so an editor save landing in between was republished away.
    let translation: AgentPromptTranslation | undefined;
    const derive = (spec: Record<string, unknown>) => {
      // The SAME mapping every live agent save applies while the flag is on —
      // one function, so a record written by the migration and a record
      // written by a `PUT /api/agents/:slug` cannot end up shaped differently.
      translation = translateAgentPromptBindings({
        currentSkills: spec.skills,
        declaredPrompts: spec.prompts,
        extraSkillNames: pins.get(agentSlug) ?? [],
        resolveLegacyId: (legacyId) => byLegacyId.get(legacyId),
        hadPromptsKey: Object.hasOwn(spec, 'prompts'),
      });
      // `null` means the record already says what this pass would say.
      // Skipping matters on a RETRY: republishing an untouched agent is a
      // write that can fail for a new reason and would hold the migration
      // open.
      return applyAgentPromptTranslation(spec, translation);
    };

    if (dryRun) {
      // Nothing is written, so the derivation runs against a plain read.
      if (derive(await agents.loadAgent(agentSlug)) === null) continue;
      recordAgentRow(report, agentSlug, translation, logger);
      continue;
    }

    try {
      const written = await agents.mutateAgent(agentSlug, derive);
      if (written === null) continue;
      recordAgentRow(report, agentSlug, translation, logger);
    } catch (error) {
      // Keep going so the report names EVERY refused record rather than the
      // first — an operator fixing permissions wants the whole list. The pass
      // still refuses to complete: see the `failedAgents` gate above.
      // `failedAgents` only — pushing the same failure into `errors` too made
      // the doctor print every refused agent twice (seen live).
      const reason = error instanceof Error ? error.message : String(error);
      report.failedAgents.push({ slug: agentSlug, reason });
      logger.warn('Playbooks→Skills migration could not update an agent', {
        agentSlug,
        error,
      });
    }
  }
}
