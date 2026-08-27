/**
 * Agent Skills Service — discovers, indexes, and serves skills
 * following the Agent Skills open specification (agentskills.io).
 *
 * Progressive disclosure:
 *   Tier 1 (catalog): name + description injected into system prompt at startup
 *   Tier 2 (body):    full SKILL.md loaded on demand via activate_skill tool
 *   Tier 3 (resources): scripts/references/assets loaded when referenced
 */

import { existsSync, readFileSync } from 'node:fs';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import type {
  GuidanceAsset,
  SkillCommand,
  SkillOrigin,
  SkillOutcome,
  SkillProvenance,
  SkillStats,
  SkillVariable,
} from '@kontourai/station-contracts/catalog';
import { skillToGuidanceAsset } from '@kontourai/station-contracts/guidance-assets';
import {
  type ResolvedSkillCommand,
  resolveSkillCommands,
} from '@kontourai/station-contracts/skill-command';
import { mergeSkillVariables } from '@kontourai/station-contracts/skill-variables';
import {
  extractResourceLinks,
  frontmatterToProperties,
  handleSkillRead,
  parseFrontmatter,
  type ResolvedSkill,
  type SkillResource,
  toDisclosureInstructions,
  toDisclosurePrompt,
  toReadToolSchema,
} from 'agent-skills-ts-sdk';
import type { ConfigLoader, SkillConfig } from '../../domain/config-loader.js';
import {
  canonicalSkillsDiscovered,
  skillActivationDuration,
  skillActivations,
  skillDiscoveries,
  skillDiscoveryDuration,
  skillOps,
} from '../../telemetry/metrics.js';
import type { CanonicalSkillSource } from '../flow/flow-agents-skills-source.js';
import {
  type BoundDirectoryEntry,
  type BoundDirectoryIdentity,
  boundDirectoryIdentity,
  enumerateBoundDirectory,
  publishBoundDirectoryFileExclusive,
} from './bound-directory-enumeration.js';
import { assertSkillCommandAllowed } from './skill-command-validation.js';
import { withLocalSkillMutation } from './skill-local-mutation.js';
import {
  assertSafeSkillName,
  readSkillCommand,
  readSkillLegacyIds,
  readSkillOrigin,
  readSkillVariables,
  resolveSkillDirectory,
  serializeSkillMarkdown,
} from './skill-metadata.js';
import {
  expectedLocalSkillRevision,
  localSkillRevisionFromDirectory,
} from './skill-revision.js';
import {
  installSkillFromRegistry,
  removeInstalledSkill,
} from './skill-service-install.js';
import { SkillUsageService } from './skill-usage-service.js';

const SCRIPT_EXTS = new Set(['.py', '.sh', '.js', '.ts']);

export interface EditableSkillInput {
  name: string;
  description?: string;
  body: string;
  tags?: string[];
  category?: string;
  agent?: string;
  global?: boolean;
  provenance?: SkillProvenance;
  command?: SkillCommand;
  /** Declarations, as authored — not the derived variable set. */
  variables?: SkillVariable[];
  legacyIds?: string[];
  origin?: SkillOrigin;
  /**
   * When this skill was first installed. Only `station doctor
   * --migrate-playbooks` supplies it, so a migrated skill keeps the date its
   * source record was created rather than claiming it was installed the
   * moment the upgrade ran.
   */
  installedAt?: string;
}

/** Identity the interrupted-package repair must prove before it can publish. */
export interface InterruptedLocalSkillPackageIdentity {
  name: string;
  origin: 'migrated-playbook';
  legacyId: string;
}

export interface InterruptedLocalSkillPackageCompletion {
  success: boolean;
  repaired: boolean;
  message: string;
}

export interface InterruptedLocalSkillPackageRepairOptions {
  beforePublishForTest?: () => void | Promise<void>;
  afterPublishForTest?: () => void | Promise<void>;
}

const MODELED_SKILL_FRONTMATTER_KEYS = new Set([
  'name',
  'description',
  'category',
  'tags',
  'agent',
  'global',
  'provenance',
  'command',
  'variables',
]);

function frontmatterKey(line: string): string | undefined {
  if (/^\s/.test(line)) return undefined;
  const match = line.match(/^(?:"([^"]+)"|'([^']+)'|([^:#][^:]*?))\s*:/);
  return (match?.[1] ?? match?.[2] ?? match?.[3])?.trim();
}

/**
 * Retain source text for fields the Station editor does not model. Parsing is
 * deliberately a separate prerequisite: this scanner preserves formatting;
 * it is not a YAML validator.
 *
 * Accepted limitation (station#2684 review round 2): unknown-key blocks keep
 * their bytes verbatim but are re-emitted after the modeled fields, so their
 * ordering relative to modeled keys — and a comment's attachment to an
 * adjacent modeled key — is not preserved. Nothing is lost; position churns.
 * Byte-perfect positional rewriting needs a CST-aware YAML writer, which is
 * not warranted for a file Station itself owns the write path for.
 */
function preservedFrontmatterLines(source: string): string[] {
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return [];
  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === '---',
  );
  if (closingIndex < 0) return [];

  const preserved: string[] = [];
  let preserveBlock = false;
  for (const line of lines.slice(1, closingIndex)) {
    const key = frontmatterKey(line);
    if (key !== undefined) {
      preserveBlock = !MODELED_SKILL_FRONTMATTER_KEYS.has(key);
    }
    if (preserveBlock || line.trimStart().startsWith('#')) {
      preserved.push(line);
    }
  }
  return preserved;
}

/**
 * A discovered skill plus the Station-owned metadata its own frontmatter
 * declared. Captured at discovery, where the file is already open, so a
 * listing never re-reads bodies AND a read-only package/plugin skill — which
 * has no `skill.json` to mirror into — still gets its declarations honoured.
 */
interface RegisteredSkill extends ResolvedSkill {
  declaredCommand?: SkillCommand;
  declaredVariables?: SkillVariable[];
  /**
   * Install facts supplied by a SOURCE rather than found on disk beside the
   * skill. A plugin's prompt file has no `skill.json` to read them from, so the
   * source that scanned it states them and `skillRecords()` reads them from
   * here instead — the same shape the install record would have carried.
   */
  provided?: {
    source?: string;
    legacyIds?: string[];
    origin?: SkillOrigin;
  };
}

/** What `listSkills()` answers, per skill. */
export interface SkillListing {
  name: string;
  description: string;
  version?: string;
  source?: string;
  path?: string;
  installed?: boolean;
  provenance?: SkillProvenance;
  command?: SkillCommand;
  /** Why an enabled declaration is not in effect, when it is not. */
  commandDiagnostic?: string;
  /** The body's `{{placeholder}}` set with declared metadata attached. */
  variables?: SkillVariable[];
  stats?: SkillStats;
  /** Why `stats` is absent, when the counter store could not be read. */
  statsUnavailable?: string;
  legacyIds?: string[];
  origin?: SkillOrigin;
  /**
   * Served in place by a SOURCE (a plugin's prompt file) rather than by a
   * directory Station owns. Its name is re-derived at every discovery, so it
   * can be moved aside; a directory cannot.
   */
  servedInPlace?: true;
}

/**
 * `getSkill`'s answer: the install record, plus what the declarations on disk
 * actually DO and — when they could not be read at all — why.
 */
export interface SkillDetail extends SkillConfig {
  commandDiagnostic?: string;
  /** Present only when `command`/`variables` did not come from `SKILL.md`. */
  declarationsDiagnostic?: string;
}

/**
 * The identity record was published but an exact cleanup could not be made
 * durable.  Callers must retain this as an operator-recoverable state rather
 * than flattening it into an ordinary failed create.
 */
export class SkillPublicationIndeterminateError extends Error {
  constructor(cause: unknown) {
    super('Skill publication is indeterminate after compensation failure.', {
      cause,
    });
    this.name = 'SkillPublicationIndeterminateError';
  }
}

export class SkillService {
  private registry = new Map<string, RegisteredSkill>();
  /** Read-only package-contributed skill roots (e.g. flow-agents, S3). */
  private readonly canonicalSources: CanonicalSkillSource[];
  /**
   * Run/outcome counters. A side store rather than `skill.json`, so read-only
   * package and plugin skills are counted too — see `skill-usage-service.ts`.
   */
  private readonly usage: SkillUsageService;
  /** See the constructor option of the same name. */
  private readonly pluginCommandSource?: (
    projectHomeDir: string,
    takenNames: ReadonlySet<string>,
  ) => Array<
    ResolvedSkill & {
      source?: string;
      legacyIds?: string[];
      command?: SkillCommand;
    }
  >;
  /**
   * Legacy id (a migrated UUID, `<ns>:<id>`) → the registry key that claims
   * it.
   *
   * Rebuilt from the FINAL registry at the end of every discovery, so it can
   * never point at a skill a later registration replaced. Kept as an index
   * rather than re-derived per lookup because `resolveSkillName` is on the
   * path of every `GET /api/skills/:name` that names a legacy id, and the
   * derivation reads a `skill.json` per skill.
   */
  private legacyIdIndex = new Map<string, string>();

  constructor(
    private configLoader: ConfigLoader,
    private logger: {
      info: (...a: any[]) => void;
      warn: (...a: any[]) => void;
      debug: (...a: any[]) => void;
    },
    options: {
      canonicalSources?: CanonicalSkillSource[];
      usage?: SkillUsageService;
      /**
       * Plugin-contributed command skills, scanned IN PLACE as read-only
       * entries. Absent means only the on-disk roots are discovered.
       */
      pluginCommandSource?: (
        projectHomeDir: string,
        takenNames: ReadonlySet<string>,
      ) => Array<
        ResolvedSkill & {
          source?: string;
          legacyIds?: string[];
          command?: SkillCommand;
        }
      >;
    } = {},
  ) {
    this.canonicalSources = options.canonicalSources ?? [];
    this.pluginCommandSource = options.pluginCommandSource;
    this.usage =
      options.usage ??
      new SkillUsageService(() => this.configLoader.getProjectHomeDir());
  }

  // ── Discovery ──────────────────────────────────────────

  async discoverSkills(
    projectHomeDir: string,
    projectSlug?: string,
  ): Promise<void> {
    const start = Date.now();
    this.registry.clear();

    // Canonical package sources scan FIRST so locally installed or
    // project-scoped skills override a canonical skill on name collision
    // (later registrations win in the registry map).
    for (const source of this.canonicalSources) {
      const before = this.registry.size;
      try {
        await this.scanDirectory(source.root);
      } catch (e) {
        this.logger.warn('Canonical skill source scan failed', {
          source: source.label,
          root: source.root,
          error: e,
        });
      }
      canonicalSkillsDiscovered.add(this.registry.size - before, {
        source: source.label,
      });
    }

    const dirs = [
      join(projectHomeDir, 'skills'),
      join(projectHomeDir, 'plugins'),
    ];
    if (projectSlug) {
      dirs.unshift(join(projectHomeDir, 'projects', projectSlug, 'skills'));
    }

    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      await this.scanDirectory(dir);
    }

    // Registered LAST, against every name already taken.
    //
    // These used to go in before the writable roots, which meant a local skill
    // that happened to share a plugin skill's slug OVERWROTE the plugin entry
    // — taking its `legacyIds` with it, so `<ns>:<id>` stopped resolving for
    // layouts even though the plugin was still
    // installed (review M2). Nothing has to lose now: the plugin skill takes a
    // suffix and both exist. Which of them answers to the shared `/command`
    // word is still decided by `resolveSkillCommands`, where a user's own
    // skill already outranks a plugin's.
    for (const skill of this.pluginCommandSource?.(
      projectHomeDir,
      new Set(this.registry.keys()),
    ) ?? []) {
      this.registry.set(skill.name, {
        name: skill.name,
        description: skill.description,
        body: skill.body,
        resources: skill.resources,
        location: skill.location,
        declaredCommand: skill.command,
        provided: {
          source: skill.source,
          legacyIds: skill.legacyIds,
          origin: 'plugin',
        },
      });
    }

    this.rebuildLegacyIdIndex();

    this.logger.info('Skills discovered', {
      count: this.registry.size,
      projectSlug,
    });
    skillDiscoveries.add(1, {
      count: this.registry.size,
      projectSlug: projectSlug || 'global',
    });
    skillDiscoveryDuration.record(Date.now() - start, {
      projectSlug: projectSlug || 'global',
    });
  }

  private async scanDirectory(dir: string, depth = 0): Promise<void> {
    if (depth > 4) return;
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;

      const skillMdPath = join(dir, entry.name, 'SKILL.md');
      if (existsSync(skillMdPath)) {
        try {
          const content = await readFile(skillMdPath, 'utf-8');
          // One parse, two readers: the spec properties the SDK models, and
          // the raw frontmatter map that carries Station's own `command`/
          // `variables` declarations.
          const { metadata, body } = parseFrontmatter(content);
          const properties = frontmatterToProperties(metadata);
          const frontmatter = metadata as unknown as Record<string, unknown>;

          const links = extractResourceLinks(body);
          const resources: SkillResource[] = [];
          for (const link of links) {
            const resourcePath = join(dir, entry.name, link.path);
            if (existsSync(resourcePath)) {
              resources.push({
                name: link.name,
                path: link.path,
                content: await readFile(resourcePath, 'utf-8'),
              });
            }
          }

          this.registry.set(properties.name, {
            name: properties.name,
            description: properties.description,
            body,
            resources,
            location: skillMdPath,
            declaredCommand: readSkillCommand(frontmatter.command),
            declaredVariables: readSkillVariables(frontmatter.variables),
          });
        } catch (e) {
          this.logger.warn('Failed to parse skill', {
            path: skillMdPath,
            error: e,
          });
        }
      } else {
        await this.scanDirectory(join(dir, entry.name), depth + 1);
      }
    }
  }

  // ── Prompt Generation (Tier 1) ─────────────────────────

  getSkillCatalogPrompt(skillNames?: string[]): string {
    if (this.registry.size === 0) return '';
    if (skillNames !== undefined && skillNames.length === 0) return '';

    const allSkills = Array.from(this.registry.values());
    const filtered =
      skillNames !== undefined
        ? allSkills.filter((s) => skillNames.includes(s.name))
        : allSkills;
    if (filtered.length === 0) return '';

    const entries = filtered.map((s) => ({
      name: s.name,
      description: s.description,
      resources: s.resources.map((r) => r.name),
    }));

    const catalog = toDisclosurePrompt(entries);
    const instructions = toDisclosureInstructions({
      toolName: 'activate_skill',
    });
    return `${catalog}\n\n${instructions}`;
  }

  // ── Tool Definition (Tier 2 + 3) ───────────────────────

  getSkillTool(skillNames?: string[]): {
    name: string;
    description: string;
    parameters: object;
    execute: (input: any) => Promise<any>;
  } | null {
    const allSkills = Array.from(this.registry.values());
    const skills =
      skillNames !== undefined
        ? allSkills.filter((s) => skillNames.includes(s.name))
        : allSkills;
    if (skills.length === 0) return null;
    const schema = toReadToolSchema(skills, { toolName: 'activate_skill' });

    return {
      name: schema.name,
      description: schema.description,
      parameters: schema.parametersJsonSchema,
      execute: async (input: any) => {
        const start = Date.now();
        const result = handleSkillRead(skills, {
          name: input.name,
          resource: input.resource,
        });
        skillActivations.add(1, { skill: input.name || 'unknown' });
        skillActivationDuration.record(Date.now() - start, {
          skill: input.name || 'unknown',
        });
        if (!result.ok) return { error: (result as any).error };

        const skill = this.registry.get(input.name);
        if (skill && !input.resource) {
          const scriptTools = this.getScriptToolDefs(skill);
          const allowedTools = this.getAllowedTools(skill);
          return {
            content: (result as any).content,
            ...(scriptTools.length > 0 && { scriptTools }),
            ...(allowedTools && { allowedTools }),
          };
        }
        return { content: (result as any).content };
      },
    };
  }

  // ── CRUD (delegates to ConfigLoader) ───────────────────

  listSkills(): SkillListing[] {
    const usage = this.usage.snapshot();
    const records = this.skillRecords();
    // Declarations become behaviour in ONE place, across every root: a command
    // word nobody can type, or one two skills both claim, is reported disabled
    // with the reason rather than listed as enabled and doing nothing. Origin
    // is passed in because a clash is decided by SOURCE first (see
    // `resolveSkillCommands`), the same precedence discovery already applies.
    const commands = resolveSkillCommands(
      records.map((record) => ({
        name: record.skill.name,
        command: record.skill.declaredCommand,
        origin: record.origin,
      })),
    );
    return records.map(({ skill: s, origin, install }) => {
      // Unreadable counters are NOT zero counters. When the store cannot be
      // read the listing says so, so no reader renders "0 runs" for a number
      // nobody computed.
      const stats = Object.hasOwn(usage.stats, s.name)
        ? usage.stats[s.name]
        : undefined;
      // Frontmatter is the portable source of truth for `command`/`variables`,
      // exactly as it already is for `agent`/`global` in `getSkill`. It was
      // captured at discovery, so this join reads no skill bodies.
      const resolvedCommand = commands.get(s.name) ?? {};
      const command = resolvedCommand.command;
      const variables = mergeSkillVariables(s.body, s.declaredVariables);
      return {
        name: s.name,
        description: s.description,
        installed: true,
        ...(command ? { command } : {}),
        ...(resolvedCommand.commandDiagnostic
          ? { commandDiagnostic: resolvedCommand.commandDiagnostic }
          : {}),
        ...(variables.length > 0 ? { variables } : {}),
        ...(stats ? { stats } : {}),
        ...(usage.unavailable ? { statsUnavailable: usage.unavailable } : {}),
        version: install.version,
        source: install.source,
        path: install.path,
        provenance: install.provenance,
        ...(install.legacyIds ? { legacyIds: install.legacyIds } : {}),
        ...(origin ? { origin } : {}),
        ...(s.provided ? { servedInPlace: true as const } : {}),
      };
    });
  }

  /**
   * Every discovered skill with its install record and derived origin, read
   * once. `listSkills` and the detail read share it so a clash cannot be
   * arbitrated from two different views of where a skill came from.
   */
  private skillRecords(): Array<{
    skill: RegisteredSkill;
    origin: SkillOrigin | undefined;
    install: {
      version?: string;
      source?: string;
      path?: string;
      provenance?: SkillProvenance;
      legacyIds?: string[];
    };
  }> {
    return Array.from(this.registry.values()).map((skill) => {
      if (skill.provided) {
        // No install record exists for a skill served straight out of a
        // plugin, so the SOURCE's own statement is the record.
        return {
          skill,
          origin: skill.provided.origin,
          install: {
            source: skill.provided.source,
            path: skill.location ? dirname(skill.location) : undefined,
            legacyIds: skill.provided.legacyIds,
          },
        };
      }
      const canonical = this.canonicalSourceFor(skill.location);
      if (canonical) {
        return {
          skill,
          origin: 'package' as const,
          install: {
            version: canonical.version,
            source: canonical.label,
            path: skill.location ? dirname(skill.location) : undefined,
          },
        };
      }
      let version: string | undefined;
      let source: string | undefined;
      let path: string | undefined;
      let provenance: SkillProvenance | undefined;
      let legacyIds: string[] | undefined;
      let recordedOrigin: SkillOrigin | undefined;
      if (skill.location) {
        const metaPath = join(dirname(skill.location), '.station-meta.json');
        if (existsSync(metaPath)) {
          try {
            version = JSON.parse(readFileSync(metaPath, 'utf-8')).version;
          } catch {}
        }
        const skillJsonPath = join(dirname(skill.location), 'skill.json');
        if (existsSync(skillJsonPath)) {
          try {
            const config = JSON.parse(readFileSync(skillJsonPath, 'utf-8'));
            source = config.source;
            path = config.path;
            version = config.version ?? version;
            provenance = config.provenance;
            legacyIds = readSkillLegacyIds(config.legacyIds);
            recordedOrigin = readSkillOrigin(config.origin);
          } catch {}
        }
      }
      return {
        skill,
        origin: recordedOrigin ?? this.deriveOrigin(skill.location, source),
        install: { version, source, path, provenance, legacyIds },
      };
    });
  }

  /**
   * Where a skill came from, when no writer recorded it: derived from the root
   * it was discovered under, then from the install record's own `source`.
   * Never guessed — an unrecognised source stays `undefined` rather than
   * defaulting to `user`.
   */
  private deriveOrigin(
    location: string | undefined,
    source: string | undefined,
  ): SkillOrigin | undefined {
    if (location && this.canonicalSourceFor(location)) return 'package';
    if (location) {
      const pluginsRoot = join(this.projectHomeDir(), 'plugins');
      if (location.startsWith(pluginsRoot)) return 'plugin';
    }
    if (source === 'registry') return 'registry';
    if (source === 'plugin') return 'plugin';
    if (source === 'flow-agents') return 'package';
    if (source === 'local') return 'user';
    return undefined;
  }

  private projectHomeDir(): string {
    try {
      return this.configLoader.getProjectHomeDir();
    } catch {
      return '';
    }
  }

  /**
   * Can Station write this skill's own package? False for canonical package
   * skills and for anything served from a root Station does not own (a
   * plugin's, or another project's) — those must be installed into the
   * workspace before they can be edited.
   */
  isSkillWritable(
    name: string,
    projectHomeDir: string,
    projectSlug?: string,
  ): boolean {
    const registered = this.registry.get(name);
    if (!registered?.location) return true;
    if (this.canonicalSourceFor(registered.location)) return false;
    return (
      dirname(registered.location) ===
      this.resolveSkillDir(projectHomeDir, name, projectSlug)
    );
  }

  /**
   * Rebuild `legacyIdIndex` from what is registered NOW.
   *
   * From the final registry, deliberately: an index written as skills are
   * registered would keep an entry pointing at a key a later registration
   * replaced, and a stale legacy id resolving to somebody else's content is
   * worse than one that does not resolve at all.
   */
  private rebuildLegacyIdIndex(): void {
    this.legacyIdIndex = new Map();
    for (const record of this.skillRecords()) {
      for (const legacyId of record.install.legacyIds ?? []) {
        this.legacyIdIndex.set(legacyId, record.skill.name);
      }
    }
  }

  /**
   * The skill whose name or recorded `legacyIds` matches, if any.
   *
   * The index built at discovery is the ONLY derivation. It replaced a scan of
   * `listSkills()` rather than sitting in front of one: two readers of the same
   * fact is how they end up disagreeing, and a fallback that reproduces the
   * index exactly also makes the index unfalsifiable — breaking it changed
   * nothing any test could see.
   *
   * It is also on the path of every `GET /api/skills/:name` that names a
   * legacy id, and the scan it replaced read a `skill.json` per skill.
   */
  resolveSkillName(nameOrLegacyId: string): string | undefined {
    if (this.registry.has(nameOrLegacyId)) return nameOrLegacyId;
    const indexed = this.legacyIdIndex.get(nameOrLegacyId);
    return indexed !== undefined && this.registry.has(indexed)
      ? indexed
      : undefined;
  }

  /** Count one use of a skill. Works for read-only skills (side store). */
  async trackSkillRun(name: string): Promise<SkillStats> {
    skillOps.add(1, { operation: 'run' });
    return this.usage.trackRun(name);
  }

  /**
   * Take a migrated record's counters over as this skill's. Adopts only into
   * an untouched counter — see `SkillUsageService.adoptStats`.
   */
  async adoptSkillStats(
    name: string,
    stats: SkillStats,
  ): Promise<{ stats: SkillStats; adopted: boolean }> {
    return this.usage.adoptStats(name, stats);
  }

  async recordSkillOutcome(
    name: string,
    outcome: SkillOutcome,
  ): Promise<SkillStats> {
    skillOps.add(1, { operation: `outcome:${outcome}` });
    return this.usage.recordOutcome(name, outcome);
  }

  /** Whether a skill of this exact name has been discovered. */
  hasSkill(name: string): boolean {
    return this.registry.has(name);
  }

  listGuidanceAssets(): GuidanceAsset[] {
    return Array.from(this.registry.values()).map((skill) =>
      skillToGuidanceAsset({
        id: skill.name,
        name: skill.name,
        description: skill.description,
        installed: true,
        installedVersion: (() => {
          if (!skill.location) return undefined;
          const metaPath = join(dirname(skill.location), '.station-meta.json');
          if (!existsSync(metaPath)) return undefined;
          try {
            return JSON.parse(readFileSync(metaPath, 'utf-8')).version;
          } catch {
            return undefined;
          }
        })(),
        body: skill.body,
        path: skill.location ? dirname(skill.location) : undefined,
        resources: skill.resources.map((resource) => ({
          name: resource.name,
          path: resource.path,
        })),
        scripts: skill.resources
          .filter((resource) => {
            const ext = extname(resource.path);
            return SCRIPT_EXTS.has(ext);
          })
          .map((resource) => ({
            name: resource.name,
            path: resource.path,
          })),
      }),
    );
  }

  /**
   * One skill's detail.
   *
   * `variables` on the RESULT is the DERIVED set — the body's
   * `{{placeholder}}`s carrying any declared description/default — not the raw
   * declaration list `skill.json`/frontmatter store. That is the only answer a
   * caller can act on: a declaration for a placeholder the body never uses
   * substitutes nothing. `loadDeclaredMetadata` is what the write path reads
   * when it needs the declarations back.
   */
  async getSkill(name: string): Promise<SkillDetail> {
    skillOps.add(1, { operation: 'get' });
    // Canonical package skills have no installed config record — serve them
    // straight from the registry (read-only, content from the package).
    const registered = this.registry.get(name);
    // A skill a SOURCE serves in place (a plugin's prompt file) has no
    // install record to load — `configLoader.loadSkill` would throw and the
    // route would answer 404 for a skill the listing shows. The source's own
    // statement is the record, same as a canonical package skill's.
    if (registered?.provided) {
      const variables = mergeSkillVariables(
        registered.body,
        registered.declaredVariables,
      );
      const resolved = this.resolvedCommandFor(
        name,
        registered.declaredCommand,
        registered.provided.origin,
      );
      return {
        name: registered.name,
        description: registered.description,
        // The record's `source` is the narrow install enum; a plugin skill's
        // full `plugin:<ns>` string is carried by `legacyIds` and by the
        // listing, which is not constrained to the enum.
        source: 'plugin',
        installedAt: '',
        path: registered.location ? dirname(registered.location) : '',
        body: registered.body,
        origin: registered.provided.origin,
        ...(registered.provided.legacyIds
          ? { legacyIds: registered.provided.legacyIds }
          : {}),
        ...(resolved.command ? { command: resolved.command } : {}),
        ...(resolved.commandDiagnostic
          ? { commandDiagnostic: resolved.commandDiagnostic }
          : {}),
        ...(variables.length > 0 ? { variables } : {}),
      };
    }
    const canonical = registered
      ? this.canonicalSourceFor(registered.location)
      : null;
    if (registered?.location && canonical) {
      const variables = mergeSkillVariables(
        registered.body,
        registered.declaredVariables,
      );
      const resolved = this.resolvedCommandFor(
        name,
        registered.declaredCommand,
      );
      return {
        name: registered.name,
        description: registered.description,
        source: canonical.label,
        installedAt: '',
        version: canonical.version,
        path: dirname(registered.location),
        body: registered.body,
        origin: 'package',
        ...(resolved.command ? { command: resolved.command } : {}),
        ...(resolved.commandDiagnostic
          ? { commandDiagnostic: resolved.commandDiagnostic }
          : {}),
        ...(variables.length > 0 ? { variables } : {}),
      };
    }
    const config = await this.configLoader.loadSkill(name);
    const skillPath = join(config.path, 'SKILL.md');
    if (!existsSync(skillPath)) {
      // The mirror is the ONLY thing left to read, so say so. A silent
      // fallback is what let a `command` deleted from SKILL.md keep answering
      // from a stale install record while the listing said it was gone
      // (review finding 5).
      return this.fromInstallRecordOnly(
        config,
        `SKILL.md is missing at ${skillPath}; command and variables are shown from the install record and may be stale`,
      );
    }

    try {
      const content = await readFile(skillPath, 'utf-8');
      const { metadata, body } = parseFrontmatter(content);
      const properties = frontmatterToProperties(metadata);
      const frontmatter = metadata as unknown as Record<string, unknown>;
      // Frontmatter ONLY. The `skill.json` mirror exists so a listing need not
      // parse bodies; it is never a fallback for a file that parsed and simply
      // does not declare a command any more.
      const resolved = this.resolvedCommandFor(
        name,
        readSkillCommand(frontmatter.command),
      );
      const variables = mergeSkillVariables(
        body,
        readSkillVariables(frontmatter.variables),
      );
      return {
        ...config,
        body,
        description: properties.description ?? config.description,
        tags: Array.isArray(frontmatter.tags)
          ? (frontmatter.tags as string[])
          : config.tags,
        category:
          typeof frontmatter.category === 'string'
            ? frontmatter.category
            : config.category,
        agent:
          typeof frontmatter.agent === 'string'
            ? frontmatter.agent
            : config.agent,
        global:
          typeof frontmatter.global === 'boolean'
            ? frontmatter.global
            : config.global,
        provenance: config.provenance,
        command: resolved.command,
        commandDiagnostic: resolved.commandDiagnostic,
        variables: variables.length > 0 ? variables : undefined,
        legacyIds: readSkillLegacyIds(config.legacyIds),
        origin:
          readSkillOrigin(config.origin) ??
          this.deriveOrigin(registered?.location ?? skillPath, config.source),
      };
    } catch (error) {
      return this.fromInstallRecordOnly(
        config,
        `SKILL.md at ${skillPath} could not be parsed (${error instanceof Error ? error.message : String(error)}); command and variables are shown from the install record and may be stale`,
      );
    }
  }

  /**
   * The detail Station can still answer when `SKILL.md` cannot be read — the
   * install record, carrying the reason it is being used. Never silently.
   */
  private fromInstallRecordOnly(
    config: SkillConfig,
    declarationsDiagnostic: string,
  ): SkillDetail {
    // The mirror goes through the SAME resolution frontmatter does. Returning
    // it raw let a mirrored `enabled: true` that is invalid or clashes come
    // back as an active command with no diagnostic, while the listing — which
    // never saw the malformed skill at all — said otherwise (review delta
    // finding 3). A stale record is still a declaration, not an outcome.
    // The record's OWN origin, passed explicitly: a skill whose `SKILL.md`
    // cannot be read is absent from discovery, so the resolver would otherwise
    // insert it as `unknown` and let a registry skill outrank a user one —
    // while this very response reports `origin: user` (review delta-2 finding
    // (d)).
    const origin =
      readSkillOrigin(config.origin) ??
      this.deriveOrigin(undefined, config.source);
    const resolved = this.resolvedCommandFor(
      config.name,
      readSkillCommand(config.command),
      origin,
    );
    const variables = mergeSkillVariables(
      config.body,
      readSkillVariables(config.variables),
    );
    return {
      ...config,
      command: resolved.command,
      commandDiagnostic: resolved.commandDiagnostic,
      variables: variables.length > 0 ? variables : undefined,
      legacyIds: readSkillLegacyIds(config.legacyIds),
      origin,
      declarationsDiagnostic,
    };
  }

  /**
   * One skill's command, resolved against every discovered skill — the same
   * derivation `listSkills()` applies, so a detail read and a listing can never
   * disagree about whether a command is in effect.
   */
  private resolvedCommandFor(
    name: string,
    declared: SkillCommand | undefined,
    originOverride?: SkillOrigin,
  ): ResolvedSkillCommand {
    const entries = this.skillRecords().map((record) => ({
      name: record.skill.name,
      command:
        record.skill.name === name ? declared : record.skill.declaredCommand,
      origin:
        record.skill.name === name
          ? (originOverride ?? record.origin)
          : record.origin,
    }));
    if (!entries.some((entry) => entry.name === name)) {
      entries.push({ name, command: declared, origin: originOverride });
    }
    return resolveSkillCommands(entries).get(name) ?? {};
  }

  /**
   * The declarations as authored, for the write path — `getSkill`'s `variables`
   * is the derived set and must never be written back as declarations.
   */
  private async loadDeclaredMetadata(
    name: string,
    skillPath: string,
  ): Promise<Pick<SkillConfig, 'command' | 'variables'>> {
    if (!existsSync(skillPath)) {
      const registered = this.registry.get(name);
      return {
        command: registered?.declaredCommand,
        variables: registered?.declaredVariables,
      };
    }
    try {
      const { metadata } = parseFrontmatter(await readFile(skillPath, 'utf-8'));
      const frontmatter = metadata as unknown as Record<string, unknown>;
      return {
        command: readSkillCommand(frontmatter.command),
        variables: readSkillVariables(frontmatter.variables),
      };
    } catch {
      return {};
    }
  }

  async createLocalSkill(
    input: EditableSkillInput,
    projectHomeDir: string,
    projectSlug?: string,
  ): Promise<{ success: boolean; message: string }> {
    return this.withLocalSkillMutation(
      [input.name],
      projectHomeDir,
      projectSlug,
      () => this.createLocalSkillOwned(input, projectHomeDir, projectSlug),
    );
  }

  /** The create half of the local-Skill capability.  Never call unlocked. */
  private async createLocalSkillOwned(
    input: EditableSkillInput,
    projectHomeDir: string,
    projectSlug?: string,
  ): Promise<{ success: boolean; message: string }> {
    assertSafeSkillName(input.name);
    // A `/command` word held by a skill SERVED IN PLACE never refuses a LOCAL
    // write. Those names are re-derived at every discovery — the plugin skill
    // simply moves to `name-2` once this package exists — so refusing would
    // make the outcome depend on write TIMING: creating `deploy` succeeded if
    // a local `deploy` predated discovery and failed if the plugin currently
    // held it, for the same two files (review delta MEDIUM). Read-time
    // arbitration already says the same thing — `COMMAND_CLAIM_PRECEDENCE`
    // puts `user` and `migrated-playbook` above `plugin` — so this is the
    // write side agreeing with the read side rather than a second rule.
    assertSkillCommandAllowed(
      input.name,
      input.command,
      this.localWriteClashCandidates(),
    );
    const skillDir = this.resolveSkillDir(
      projectHomeDir,
      input.name,
      projectSlug,
    );
    // Ordinary creation is also creation, not an implicit update.  This is
    // checked under the universal capability, so it cannot replace a setup
    // import (or another ordinary create) that won the same target.
    if (existsSync(skillDir) || this.hasSkill(input.name)) {
      return {
        success: false,
        message: `Skill '${input.name}' already exists`,
      };
    }
    await mkdir(skillDir, { recursive: true });
    // `skill.json` FIRST, and `SKILL.md` after it.
    //
    // The two writes are not atomic together, so one of them is going to be
    // the durable one when a process dies between them — and it has to be the
    // one that carries IDENTITY. `legacyIds` lives in the install record, and
    // the migration helper recognises its own prior work by those ids: with
    // `SKILL.md` first, a crash left a command-enabled body that no id claimed,
    // discovery reserved its name, and the retry wrote the same record again
    // as `name-2` — an orphan command plus a duplicate (review H2). With the
    // record first, the worst partial state is a skill.json nothing has
    // rendered yet, which the migration finds by id and REPAIRS.
    //
    // The half-written state is already a modelled one: `getSkill` answers
    // from the install record and says why (`declarationsDiagnostic`).
    const publication = this.projectLocalSkillPublication(
      input,
      projectHomeDir,
      projectSlug,
    );
    try {
      // These are the exact two canonical byte sequences projected above.
      // ConfigLoader's local save format is the same stable JSON encoder.
      await this.configLoader.saveSkill(input.name, publication.config);
      await writeFile(
        join(skillDir, 'SKILL.md'),
        publication.skillMarkdown,
        'utf-8',
      );
    } catch (error) {
      // The record is intentionally first, but it is not a committed Skill
      // until its body is durable.  Under this capability no other local
      // writer can observe/reuse the directory while exact compensation runs.
      try {
        await this.configLoader.deleteSkill(input.name);
      } catch (compensationError) {
        throw new SkillPublicationIndeterminateError(compensationError);
      }
      throw error;
    }
    await this.discoverSkills(projectHomeDir, projectSlug);
    return { success: true, message: `Created ${input.name}` };
  }

  /**
   * Project exactly what the local writer will publish. Setup recovery records
   * this revision before effect execution, then creation receives the same
   * fixed installedAt value so a restart never guesses at a later revision.
   */
  projectLocalSkillPublication(
    input: EditableSkillInput,
    projectHomeDir: string,
    projectSlug?: string,
  ): {
    input: EditableSkillInput;
    config: SkillConfig;
    skillMarkdown: string;
    revision: string;
  } {
    assertSafeSkillName(input.name);
    const stableInput = {
      ...input,
      installedAt: input.installedAt ?? new Date().toISOString(),
    };
    const skillDir = this.resolveSkillDir(
      projectHomeDir,
      stableInput.name,
      projectSlug,
    );
    const config: SkillConfig = {
      name: stableInput.name,
      description: stableInput.description,
      source: 'local',
      installedAt: stableInput.installedAt,
      path: skillDir,
      body: stableInput.body,
      tags: stableInput.tags,
      category: stableInput.category,
      agent: stableInput.agent,
      global: stableInput.global,
      provenance: stableInput.provenance,
      command: stableInput.command,
      variables: stableInput.variables,
      legacyIds: stableInput.legacyIds,
      origin: stableInput.origin ?? 'user',
    };
    const skillMarkdown = serializeSkillMarkdown(stableInput);
    return {
      input: stableInput,
      config,
      skillMarkdown,
      revision: expectedLocalSkillRevision([
        {
          type: 'file',
          path: 'skill.json',
          content: Buffer.from(JSON.stringify(config, null, 2), 'utf8'),
        },
        {
          type: 'file',
          path: 'SKILL.md',
          content: Buffer.from(skillMarkdown, 'utf8'),
        },
      ]),
    };
  }

  /**
   * Finish only the missing body of one identity-bound local package.
   *
   * This is deliberately not a general update or overwrite path. The install
   * record is the durable identity left by a crashed migration, so this method
   * refuses unless that exact record is already present and untouched; it
   * never serializes or rewrites `skill.json`.
   */
  async completeInterruptedLocalSkillPackage(
    input: EditableSkillInput,
    expectedIdentity: InterruptedLocalSkillPackageIdentity,
    projectHomeDir: string,
    projectSlug?: string,
    options: InterruptedLocalSkillPackageRepairOptions = {},
  ): Promise<InterruptedLocalSkillPackageCompletion> {
    return this.withLocalSkillMutation(
      [expectedIdentity.name],
      projectHomeDir,
      projectSlug,
      () =>
        this.completeInterruptedLocalSkillPackageOwned(
          input,
          expectedIdentity,
          projectHomeDir,
          projectSlug,
          options,
        ),
    );
  }

  private async completeInterruptedLocalSkillPackageOwned(
    input: EditableSkillInput,
    expectedIdentity: InterruptedLocalSkillPackageIdentity,
    projectHomeDir: string,
    projectSlug?: string,
    options: InterruptedLocalSkillPackageRepairOptions = {},
  ): Promise<InterruptedLocalSkillPackageCompletion> {
    if (
      input.name !== expectedIdentity.name ||
      input.origin !== 'migrated-playbook' ||
      expectedIdentity.origin !== 'migrated-playbook' ||
      input.legacyIds?.length !== 1 ||
      input.legacyIds[0] !== expectedIdentity.legacyId
    ) {
      return {
        success: false,
        repaired: false,
        message:
          'Interrupted package input does not match its expected identity',
      };
    }
    assertSafeSkillName(expectedIdentity.name);
    const skillDir = this.resolveSkillDir(
      projectHomeDir,
      expectedIdentity.name,
      projectSlug,
    );
    let expectedDirectory: BoundDirectoryIdentity;
    try {
      const directory = await lstat(skillDir);
      if (!directory.isDirectory()) {
        return {
          success: false,
          repaired: false,
          message: 'Interrupted package directory is unavailable',
        };
      }
      expectedDirectory = boundDirectoryIdentity(directory);
    } catch {
      return {
        success: false,
        repaired: false,
        message: 'Interrupted package record is unavailable',
      };
    }
    const publication = this.projectLocalSkillPublication(
      input,
      projectHomeDir,
      projectSlug,
    );
    try {
      const initial = await enumerateBoundDirectory({
        directory: skillDir,
        expected: expectedDirectory,
        limits: { entries: 2, fileBytes: 256 * 1024, totalBytes: 512 * 1024 },
      });
      const inspect = (entries: BoundDirectoryEntry[]) => {
        if (entries.some((entry) => entry.kind !== 'file')) return undefined;
        const names = new Set(entries.map((entry) => entry.name));
        if (
          !names.has('skill.json') ||
          [...names].some(
            (name) => name !== 'skill.json' && name !== 'SKILL.md',
          )
        )
          return undefined;
        const configEntry = entries.find(
          (entry) => entry.name === 'skill.json',
        );
        const bodyEntry = entries.find((entry) => entry.name === 'SKILL.md');
        if (configEntry?.kind !== 'file') return undefined;
        let config: Record<string, unknown>;
        try {
          config = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(configEntry.bytes),
          ) as Record<string, unknown>;
        } catch {
          return undefined;
        }
        if (
          config.name !== expectedIdentity.name ||
          config.origin !== 'migrated-playbook' ||
          !Array.isArray(config.legacyIds) ||
          config.legacyIds.length !== 1 ||
          config.legacyIds[0] !== expectedIdentity.legacyId
        )
          return undefined;
        return {
          configBytes: configEntry.bytes,
          body: bodyEntry?.kind === 'file' ? bodyEntry.bytes : undefined,
        };
      };
      const checked = inspect(initial);
      if (!checked) {
        return {
          success: false,
          repaired: false,
          message: 'Interrupted package identity or contents are unavailable',
        };
      }
      const canonicalBody = Buffer.from(publication.skillMarkdown, 'utf8');
      let repaired = false;
      let finalDirectory = expectedDirectory;
      if (checked.body) {
        if (!checked.body.equals(canonicalBody)) {
          return {
            success: false,
            repaired: false,
            message:
              'Interrupted package body does not match the canonical publication',
          };
        }
      } else {
        const result = await publishBoundDirectoryFileExclusive({
          directory: skillDir,
          expected: expectedDirectory,
          name: 'SKILL.md',
          bytes: canonicalBody,
          maxBytes: 256 * 1024,
          beforePublishForTest: options.beforePublishForTest,
          afterPublishForTest: options.afterPublishForTest,
        });
        finalDirectory = result.identity;
        if (result.result === 'exists') {
          const raced = inspect(
            await enumerateBoundDirectory({
              directory: skillDir,
              expected: result.identity,
              limits: {
                entries: 2,
                fileBytes: 256 * 1024,
                totalBytes: 512 * 1024,
              },
            }),
          );
          if (!raced?.body?.equals(canonicalBody)) {
            return {
              success: false,
              repaired: false,
              message:
                'Interrupted package body appeared with noncanonical bytes',
            };
          }
        } else repaired = true;
      }
      const final = inspect(
        await enumerateBoundDirectory({
          directory: skillDir,
          expected: finalDirectory,
          limits: {
            entries: 2,
            fileBytes: 256 * 1024,
            totalBytes: 512 * 1024,
          },
        }),
      );
      if (
        !final?.configBytes.equals(checked.configBytes) ||
        !final.body?.equals(canonicalBody)
      ) {
        return {
          success: false,
          repaired: false,
          message: 'Interrupted package changed during repair',
        };
      }
      await this.discoverSkills(projectHomeDir, projectSlug);
      return {
        success: true,
        repaired,
        message: repaired
          ? `Completed interrupted skill '${expectedIdentity.name}'`
          : `Interrupted skill '${expectedIdentity.name}' was already complete`,
      };
    } catch {
      return {
        success: false,
        repaired: false,
        message: 'Interrupted package could not be safely revalidated',
      };
    }
  }

  /**
   * Conditional publication for externally discovered imports. The caller
   * supplies the target identity, but cannot race another Station process
   * into replacing its Skill: both the check and normal SkillService writer
   * run under the target's mutation capability.
   */
  async createLocalSkillIfAbsent(
    input: EditableSkillInput,
    projectHomeDir: string,
    projectSlug?: string,
  ): Promise<{ success: boolean; message: string }> {
    return this.withLocalSkillMutation(
      [input.name],
      projectHomeDir,
      projectSlug,
      async () => {
        const target = this.resolveSkillDir(
          projectHomeDir,
          input.name,
          projectSlug,
        );
        await mkdir(dirname(target), { recursive: true });
        if (existsSync(target) || this.hasSkill(input.name)) {
          return {
            success: false,
            message: `Skill '${input.name}' already exists`,
          };
        }
        return this.createLocalSkillOwned(input, projectHomeDir, projectSlug);
      },
    );
  }

  /**
   * The skills a LOCAL write may clash with: everything Station owns a
   * directory for, and nothing a source serves in place. See
   * `createLocalSkill` for why in-place names cannot refuse a local write.
   */
  private localWriteClashCandidates(): SkillListing[] {
    return this.listSkills().filter((skill) => !skill.servedInPlace);
  }

  async updateLocalSkill(
    name: string,
    updates: Partial<EditableSkillInput>,
    projectHomeDir: string,
    projectSlug?: string,
  ): Promise<{ success: boolean; message: string }> {
    // A rename touches both namespace identities. Acquire in path order before
    // reading either so two opposing renames cannot deadlock or overwrite.
    return this.withLocalSkillMutation(
      [name, updates.name ?? name],
      projectHomeDir,
      projectSlug,
      () =>
        this.updateLocalSkillOwned(name, updates, projectHomeDir, projectSlug),
    );
  }

  private async updateLocalSkillOwned(
    name: string,
    updates: Partial<EditableSkillInput>,
    projectHomeDir: string,
    projectSlug?: string,
  ): Promise<{ success: boolean; message: string }> {
    // A rename is a create under a new name: the same seam, the same refusal.
    if (updates.name !== undefined) assertSafeSkillName(updates.name);
    const current = await this.getSkill(name);
    const skillDir = this.resolveSkillDir(projectHomeDir, name, projectSlug);
    const skillPath = join(skillDir, 'SKILL.md');
    let preservedFrontmatter: string[] = [];
    if (existsSync(skillPath)) {
      const source = await readFile(skillPath, 'utf-8');
      try {
        parseFrontmatter(source);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Cannot update ${name}: frontmatter parse failed: ${detail}`,
        );
      }
      preservedFrontmatter = preservedFrontmatterLines(source);
    }
    // Declarations, never `current.variables` — that is the derived set.
    const declared = await this.loadDeclaredMetadata(name, skillPath);
    const next: EditableSkillInput = {
      name: updates.name ?? current.name,
      description: updates.description ?? current.description,
      body: updates.body ?? current.body ?? '',
      tags: updates.tags ?? current.tags,
      category: updates.category ?? current.category,
      agent: updates.agent ?? current.agent,
      global: updates.global ?? current.global,
      provenance: updates.provenance ?? current.provenance,
      command: updates.command ?? declared.command,
      variables: updates.variables ?? declared.variables,
      legacyIds: updates.legacyIds ?? readSkillLegacyIds(current.legacyIds),
      origin: updates.origin ?? readSkillOrigin(current.origin),
    };
    // The EFFECTIVE command after this write, not the submitted fragment: a
    // rename changes the derived command word even when the request carries no
    // `command` at all, and the route could not see that (review delta-2
    // finding (b) — renaming `alpha` to `beta` silently took a package's
    // `/beta`). Asserted here so every caller of the service is covered.
    assertSkillCommandAllowed(
      next.name,
      next.command,
      this.localWriteClashCandidates(),
      // Exclude by the skill's CURRENT identity, not the new name — a rename
      // must still see a different skill that already carries the new name.
      name,
    );
    // A rename MOVES the package. Writing `SKILL.md` under the old directory
    // while saving `skill.json` under the new name left the skill in two
    // places at once — the body under `alpha`, an install record under
    // `gamma` pointing back at `alpha`, and uninstalling `gamma` removing
    // neither. (Pre-existing on origin/main, not introduced by this branch;
    // fixed here because this branch made rename reachable and refusable.)
    const nextDir = this.resolveSkillDir(
      projectHomeDir,
      next.name,
      projectSlug,
    );
    if (nextDir !== skillDir) {
      if (existsSync(nextDir)) {
        throw new Error(
          `Cannot rename ${name} to ${next.name}: a skill directory already exists at ${nextDir}`,
        );
      }
      if (existsSync(skillDir)) {
        await mkdir(dirname(nextDir), { recursive: true });
        await rename(skillDir, nextDir);
      }
      // No `deleteSkill(name)`: the move took `skill.json` with the package,
      // so the old name has no residue to remove. Deleting by the old name
      // here would `rm -rf` whatever now sits at that path.
    }
    const nextPath = join(nextDir, 'SKILL.md');
    await mkdir(nextDir, { recursive: true });
    await writeFile(
      nextPath,
      serializeSkillMarkdown(next, preservedFrontmatter),
      'utf-8',
    );
    await this.configLoader.saveSkill(next.name, {
      ...current,
      name: next.name,
      description: next.description,
      source: 'local',
      path: nextDir,
      body: next.body,
      tags: next.tags,
      category: next.category,
      agent: next.agent,
      global: next.global,
      provenance: next.provenance,
      command: next.command,
      variables: next.variables,
      legacyIds: next.legacyIds,
      origin: next.origin,
    });
    await this.discoverSkills(projectHomeDir, projectSlug);
    return { success: true, message: `Updated ${next.name}` };
  }

  async installSkill(
    name: string,
    projectHomeDir: string,
    projectSlug?: string,
  ): Promise<{ success: boolean; message: string }> {
    skillOps.add(1, { operation: 'install' });
    const { getSkillRegistryProviders } = await import(
      '../../providers/registries/registry.js'
    );
    // `installSkillFromRegistry` owns the capability itself.  Do not add an
    // outer lock here: file capabilities are non-reentrant by design.
    return installSkillFromRegistry({
      name,
      projectHomeDir,
      projectSlug,
      configLoader: this.configLoader,
      providers: getSkillRegistryProviders(),
      rediscover: async () => this.discoverSkills(projectHomeDir, projectSlug),
    });
  }

  async removeSkill(
    name: string,
    projectHomeDir: string,
    projectSlug?: string,
  ): Promise<{ success: boolean; message: string }> {
    return this.withLocalSkillMutation(
      [name],
      projectHomeDir,
      projectSlug,
      () => this.removeSkillOwned(name, projectHomeDir, projectSlug),
    );
  }

  private async removeSkillOwned(
    name: string,
    projectHomeDir: string,
    projectSlug?: string,
  ): Promise<{ success: boolean; message: string }> {
    skillOps.add(1, { operation: 'remove' });
    return removeInstalledSkill({
      name,
      projectHomeDir,
      projectSlug,
      rediscover: async () => this.discoverSkills(projectHomeDir, projectSlug),
    });
  }

  /** Canonical on-disk revision used by conditional setup-import rollback. */
  async localSkillRevision(
    name: string,
    projectHomeDir: string,
    projectSlug?: string,
  ): Promise<string> {
    return this.withLocalSkillMutation(
      [name],
      projectHomeDir,
      projectSlug,
      () => this.localSkillRevisionOwned(name, projectHomeDir, projectSlug),
    );
  }

  private async localSkillRevisionOwned(
    name: string,
    projectHomeDir: string,
    projectSlug?: string,
  ): Promise<string> {
    return localSkillRevisionFromDirectory(
      this.resolveSkillDir(projectHomeDir, name, projectSlug),
    );
  }

  /** Compare-and-delete: a changed Skill is retained for operator repair. */
  async removeSkillIfRevision(
    name: string,
    expectedRevision: string,
    projectHomeDir: string,
    projectSlug?: string,
  ): Promise<{ removed: boolean; conflict: boolean }> {
    return this.withLocalSkillMutation(
      [name],
      projectHomeDir,
      projectSlug,
      async () => {
        let current: string;
        try {
          current = await this.localSkillRevisionOwned(
            name,
            projectHomeDir,
            projectSlug,
          );
        } catch {
          return { removed: false, conflict: true };
        }
        if (current !== expectedRevision)
          return { removed: false, conflict: true };
        const result = await this.removeSkillOwned(
          name,
          projectHomeDir,
          projectSlug,
        );
        return { removed: result.success, conflict: !result.success };
      },
    );
  }

  getSkillCount(): number {
    return this.registry.size;
  }

  // ── Private helpers ────────────────────────────────────

  /** The canonical source a skill location belongs to, if any. */
  private canonicalSourceFor(
    location: string | undefined,
  ): CanonicalSkillSource | null {
    if (!location) return null;
    return (
      this.canonicalSources.find((source) =>
        location.startsWith(source.root),
      ) ?? null
    );
  }

  private getScriptToolDefs(
    skill: ResolvedSkill,
  ): Array<{ name: string; description: string; path: string }> {
    return skill.resources
      .filter(
        (r) =>
          r.path.startsWith('scripts/') && SCRIPT_EXTS.has(extname(r.path)),
      )
      .map((r) => ({
        name: `${skill.name}/${r.name}`,
        description: `Script from ${skill.name} skill: ${r.name}`,
        path: r.path,
      }));
  }

  private getAllowedTools(skill: ResolvedSkill): string | undefined {
    const location = skill.location;
    if (!location || !existsSync(location)) return undefined;
    try {
      const content = readFileSync(location, 'utf-8');
      const { metadata } = parseFrontmatter(content);
      return metadata['allowed-tools'] || undefined;
    } catch (e) {
      this.logger.debug('Failed to parse skill frontmatter for allowed-tools', {
        location,
        error: e,
      });
      return undefined;
    }
  }

  /** Delegates to the one resolver every writer shares (see its docblock). */
  private resolveSkillDir(
    projectHomeDir: string,
    name: string,
    projectSlug?: string,
  ) {
    return resolveSkillDirectory(projectHomeDir, name, projectSlug);
  }

  /**
   * Universal local Skill mutation authority. Every filesystem writer,
   * conditional reader and revision proof goes through this seam.  A rename
   * owns both identities in canonical path order, so it is safe across
   * Station processes without relying on a process-local mutex.
   */
  private async withLocalSkillMutation<T>(
    names: string[],
    projectHomeDir: string,
    projectSlug: string | undefined,
    effect: () => Promise<T>,
  ): Promise<T> {
    return withLocalSkillMutation(names, projectHomeDir, projectSlug, effect);
  }
}
