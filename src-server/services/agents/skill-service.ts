import type { PluginActivationComposition } from '../plugins/plugin-activation-composition.js';
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
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import type {
  GuidanceAsset,
  SkillCommand,
  SkillOrigin,
  SkillOutcome,
  SkillProvenance,
  SkillStats,
  SkillVariable,
  SkillWriteRefusal,
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
  validateSkillContent,
} from 'agent-skills-ts-sdk';
import type { ConfigLoader, SkillConfig } from '../../domain/config-loader.js';
import { skillRecordClaimsName } from '../../domain/config-loader-storage.js';
import type { SkillPackageDirectoryCondition } from '../../domain/skill-paths.js';
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
  assertSkillPackageDirectory,
  readSkillCommand,
  readSkillLegacyIds,
  readSkillOrigin,
  readSkillVariables,
  resolveSkillDirectory,
  serializeSkillMarkdown,
  skillPackageDirectoryReport,
  skillsRootDir,
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
 * Accepted limitation (archive#2684 review round 2): unknown-key blocks keep
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
  sourceCurrent?: () => boolean;
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
  /**
   * May Station write this package — `isSkillWritable`'s answer, projected.
   *
   * Required, because a reader with no decision cannot offer to save: an
   * absent field is the shape a client would have to guess at, and every guess
   * available to it (`source`, `origin`, `servedInPlace`) answers a DIFFERENT
   * question (#1655).
   */
  writable: boolean;
  /** Why `writable` is false; absent when it is true. */
  writeRefusal?: SkillWriteRefusal;
}

/**
 * What a remove answers, with WHY it refused where the reason changes how a
 * caller must respond. `not-owned` is a package Station does not own — the
 * skill exists and the request is understood, which is a different answer from
 * a name nothing knows.
 */
export interface SkillRemovalResult {
  success: boolean;
  message: string;
  reason?: 'not-owned';
}

/**
 * `getSkill`'s answer: the install record, plus what the declarations on disk
 * actually DO and — when they could not be read at all — why.
 *
 * `source` is OPTIONAL here where `SkillConfigRecord` makes it required (and
 * `installedAt` is optional there for the same reason), because a package can
 * be discovered without ever having been installed — a `SKILL.md` authored by hand, or dropped into a workspace — and
 * for that package nothing states where it came from or when it arrived
 * (#1614). The alternative was answering `'local'`, which is a value nothing
 * derives asserted about an install that never happened. Absent says the true
 * thing; `installRecordDiagnostic` says why it is absent.
 */
export interface SkillDetail extends Omit<SkillConfig, 'source'> {
  /** Absent when no install record claims this package. */
  source?: SkillConfig['source'];
  commandDiagnostic?: string;
  /** Present only when `command`/`variables` did not come from `SKILL.md`. */
  declarationsDiagnostic?: string;
  /**
   * Why this answer carries no install record, when it carries none.
   *
   * A SEPARATE field from `declarationsDiagnostic`, deliberately: the two facts
   * are independent and co-occur. A package can lack an install record AND have
   * its `command`/`variables` come from somewhere other than its `SKILL.md`, and
   * one field cannot say both without the name becoming a lie for one of them.
   */
  installRecordDiagnostic?: string;
  /** `isSkillWritable`'s answer, projected — see `SkillListing.writable`. */
  writable: boolean;
  /** Why `writable` is false; absent when it is true. */
  writeRefusal?: SkillWriteRefusal;
}

/**
 * A detail read before writability is projected onto it.
 *
 * `getSkill` answers from four different places (a served-in-place source, a
 * canonical package, the install record alone, and parsed frontmatter) and the
 * projection must reach all four. Naming the undecorated shape lets ONE exit
 * decorate, so a fifth answer cannot be added that forgets to.
 */
type SkillDetailBody = Omit<SkillDetail, 'writable' | 'writeRefusal'>;

/**
 * The writability rule's answer in BOTH shapes its callers need, from one call.
 *
 * `refusal` is the published projection: a reason code plus prose Station owns,
 * with the author-controlled path in its own field. `messageFragment` is the
 * lowercase clause the write path slots into its own sentence, kept verbatim so
 * that path's messages do not change.
 *
 * They travel together rather than being derived from each other, because the
 * alternative is a caller parsing the other's prose to recover a fact the rule
 * already knew. Nothing projects `messageFragment` into a read model: the read
 * models take `.refusal`, explicitly.
 */
interface PackageOwnershipRefusal {
  refusal: SkillWriteRefusal;
  messageFragment: string;
}

/**
 * Which condition a refusal SPEAKS ABOUT when several hold at once.
 *
 * The floor reports every condition; this decides which one the reader is told
 * about, and the ordering is a claim about REMEDIES rather than about severity.
 * Read it as "which of these must be fixed first, and is fixing it something
 * this reader can actually do":
 *
 * 1. `unsafe-name` — renaming the skill is always possible and always
 *    necessary, and nothing else can succeed until it happens: the resolver
 *    refuses on the name before it looks at anything else, so advising an
 *    install here advises something guaranteed to fail (review M1). The
 *    assertion has always had this order; an earlier draft of THIS mapping
 *    inverted it.
 * 2. `unreadable` — the path cannot be followed, so no claim about which root
 *    holds the package is safe to make.
 * 3. `outside-writable-root` — where it sits is the problem, which outranks
 *    what it is called: "rename the directory" changes nothing for a package in
 *    a root Station will never write.
 * 4. `name-mismatch` — reached only once the package is somewhere Station
 *    writes and its path is readable, which is exactly what its remedy assumes.
 *
 * NOT a fallthrough. An earlier draft ended in an unconditional `return` for
 * the name mismatch, so a fifth condition added to the union would have been
 * published as one — silently, with a remedy telling the reader to rename a
 * directory, and no test able to see it. That is the defect this projection
 * exists to prevent, in the mechanism that prevents it. The `satisfies` below
 * makes the next addition a compile error instead.
 *
 * The residual it does NOT close: nothing forces a new condition to take a NEW
 * reason code. Reusing `served-in-place` or `canonical-package` compiles and
 * keeps the uniqueness test green, because that test ranges only over
 * `SKILL_REFUSAL_STATEMENT` while those two codes are emitted inline in
 * `packageOwnershipRefusal` further DOWN this file — so the collision happens
 * somewhere the test cannot see. (Reuse WITHIN the record is caught: the codes
 * there would no longer be distinct.)
 *
 * What makes that worse than an unknown code: `SkillsView` already defends
 * against a code it does not recognise — `Object.hasOwn` misses, the remedy is
 * dropped, and the reader gets the description alone. Reuse defeats exactly
 * that guard, because the code IS recognised: `hasOwn` hits, and a remedy
 * written for a different condition renders with the same confidence as a
 * right one. The safety net is not merely absent here, it is the thing being
 * stepped around. Review rounds 8-9.
 */
const SKILL_CONDITION_PRECEDENCE = [
  'unsafe-name',
  'unreadable',
  'outside-writable-root',
  'name-mismatch',
] as const satisfies readonly SkillPackageDirectoryCondition[];

/**
 * Every condition must be RANKED, not merely have a statement.
 *
 * `satisfies` above only proves each entry is a real condition; it does not
 * prove the list is complete, and an unranked condition would make
 * `worstSkillPackageCondition` return `undefined` for a non-empty condition set
 * — which this caller reads as "writable". So the hole the exhaustive `Record`s
 * below close for the PROSE was open here for the DECISION, and it failed
 * toward a grant. Found by adding a fifth condition and watching the statements
 * fail to compile while the ranking silently accepted it.
 */
type UnrankedCondition = Exclude<
  SkillPackageDirectoryCondition,
  (typeof SKILL_CONDITION_PRECEDENCE)[number]
>;
const _everyConditionIsRanked: UnrankedCondition extends never
  ? true
  : ['unranked skill package condition', UnrankedCondition] = true;
void _everyConditionIsRanked;

export function worstSkillPackageCondition(
  conditions: readonly SkillPackageDirectoryCondition[],
): SkillPackageDirectoryCondition | undefined {
  const held = new Set(conditions);
  return SKILL_CONDITION_PRECEDENCE.find((candidate) => held.has(candidate));
}

/** What Station SAYS about each condition — prose it owns, no author text. */
export const SKILL_REFUSAL_STATEMENT = {
  'unsafe-name': {
    reason: 'unresolvable-name',
    detail:
      'Its name cannot be used as a directory name, so Station cannot work out where it would write this package.',
  },
  unreadable: {
    reason: 'containment-unreadable',
    detail:
      'Where a write to it would land could not be determined, so Station will not write it.',
  },
  'outside-writable-root': {
    reason: 'outside-writable-root',
    detail: 'Station does not write the directory this package resolves to.',
  },
  'name-mismatch': {
    reason: 'directory-name-mismatch',
    detail:
      "The package discovery found for it sits in a directory whose name is not this skill's name.",
  },
} as const satisfies Record<
  SkillPackageDirectoryCondition,
  Pick<SkillWriteRefusal, 'reason' | 'detail'>
>;

/** The clause the write path slots into its own sentence, kept verbatim. */
const SKILL_REFUSAL_FRAGMENT = {
  'unsafe-name': (_name: string, _directory: string) =>
    'its name cannot be used as a directory name, so Station cannot work out where it would write this package',
  unreadable: (_name: string, directory: string) =>
    `the package Station found for it at ${directory} could not be read, so where a write would land is unknown`,
  'outside-writable-root': (_name: string, directory: string) =>
    `it is served from ${directory}, which is not a skills root Station writes`,
  'name-mismatch': (name: string, directory: string) =>
    `the package discovery found for it is ${directory}, whose directory name is not '${name}'`,
} as const satisfies Record<
  SkillPackageDirectoryCondition,
  (name: string, directory: string) => string
>;

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
  private readonly canonicalSourceProvider: (
    composition?: PluginActivationComposition,
  ) => CanonicalSkillSource[];
  private activeCanonicalSources: CanonicalSkillSource[] = [];
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
  /**
   * The scope the LAST discovery actually ran with.
   *
   * NOT a claim about which project is "active": nothing in the runtime knows
   * that. The only slug it can offer is `getActiveRuntimeProjectSlug`
   * (`listProjects()[0]?.slug` — the first project, not a chosen one), which is
   * precisely the input #1619 refused to thread into writes. This is a memory
   * of a real prior event: the roots the registry currently holds were scanned
   * with these arguments, so a write that re-discovers afterwards can restore
   * the same view instead of silently narrowing it.
   */
  private lastDiscoveryScope?: {
    projectHomeDir: string;
    projectSlug?: string;
  };

  constructor(
    private configLoader: ConfigLoader,
    private logger: {
      info: (...a: any[]) => void;
      warn: (...a: any[]) => void;
      debug: (...a: any[]) => void;
    },
    options: {
      canonicalSources?:
        | CanonicalSkillSource[]
        | ((
            composition?: PluginActivationComposition,
          ) => CanonicalSkillSource[]);
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
    const canonicalSources = options.canonicalSources;
    this.canonicalSourceProvider =
      typeof canonicalSources === 'function'
        ? canonicalSources
        : () => canonicalSources ?? [];
    this.pluginCommandSource = options.pluginCommandSource;
    this.usage =
      options.usage ??
      new SkillUsageService(() => this.configLoader.getProjectHomeDir());
  }

  // ── Discovery ──────────────────────────────────────────

  async discoverSkills(
    projectHomeDir: string,
    projectSlug?: string,
    composition?: PluginActivationComposition,
  ): Promise<void> {
    const start = Date.now();
    // Recorded BEFORE the scan, because it describes the arguments this
    // discovery runs with rather than its outcome.
    this.lastDiscoveryScope = { projectHomeDir, projectSlug };
    this.registry.clear();
    this.activeCanonicalSources = this.canonicalSourceProvider(composition);

    // Canonical package sources scan FIRST so locally installed or
    // project-scoped skills override a canonical skill on name collision
    // (later registrations win in the registry map).
    for (const source of this.activeCanonicalSources) {
      const before = this.registry.size;
      // Agent Plugin sources also carry package ownership for the legacy-scan
      // exclusion below. A recognized package without a skills directory is
      // a valid empty source, not an unreadable canonical source warning.
      if (
        source.excludeOnly ||
        (!existsSync(source.root) && source.origin === 'plugin')
      ) {
        continue;
      }
      try {
        await this.scanDirectory(source.root, 0, {
          maxDepth: source.immediateOnly ? 0 : 4,
          validateAgentSkills: source.validateAgentSkills === true,
          containmentRoot: source.containmentRoot,
          sourceCurrent: source.isCurrent,
        });
      } catch (e) {
        this.logger.warn('Canonical skill source scan failed', {
          source: source.label,
          root: source.root,
          error: e,
        });
      }
      canonicalSkillsDiscovered.add(this.registry.size - before, {
        source: source.label.startsWith('agent-plugin:')
          ? 'agent-plugin'
          : source.label,
      });
    }

    const dirs = [
      // The machine root through the same builder as the project one below: it
      // takes no slug so building it by hand was harmless, and it contradicted
      // the principle the comment there states (delta review 4, nit).
      skillsRootDir(projectHomeDir),
      join(projectHomeDir, 'plugins'),
    ];
    if (projectSlug) {
      // Through the BUILDER, which validates the slug (#1619, delta review 3
      // L4). Building the same path by hand here meant the read path took a
      // slug every write path refuses, so a traversal slug made discovery scan
      // outside the home. A no-op for every valid slug.
      dirs.unshift(skillsRootDir(projectHomeDir, projectSlug));
    }

    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      await this.scanDirectory(dir, 0, {
        excludedRoots: new Set([
          join(projectHomeDir, 'plugins', '.generations'),
          join(projectHomeDir, 'plugins', '.data'),
          ...this.activeCanonicalSources
            .filter((source) => source.origin === 'plugin')
            .map((source) => dirname(source.root)),
        ]),
      });
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

  private async scanDirectory(
    dir: string,
    depth = 0,
    options: {
      maxDepth?: number;
      validateAgentSkills?: boolean;
      containmentRoot?: string;
      excludedRoots?: ReadonlySet<string>;
      sourceCurrent?: () => boolean;
    } = {},
  ): Promise<void> {
    if (depth > (options.maxDepth ?? 4)) return;
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;

      const entryDir = join(dir, entry.name);
      if (options.excludedRoots) {
        let excluded = options.excludedRoots.has(entryDir);
        if (!excluded) {
          try {
            excluded = options.excludedRoots.has(await realpath(entryDir));
          } catch {
            // The ordinary scan below owns reporting unreadable directories.
          }
        }
        if (excluded) continue;
      }

      const skillMdPath = join(entryDir, 'SKILL.md');
      if (existsSync(skillMdPath)) {
        try {
          let readableSkillPath = skillMdPath;
          if (options.containmentRoot) {
            const containedRoot = await realpath(options.containmentRoot);
            const containedDirectory = await realpath(entryDir);
            const containedManifest = await realpath(skillMdPath);
            for (const [label, candidate] of [
              ['skill directory', containedDirectory],
              ['SKILL.md', containedManifest],
            ] as const) {
              const rel = relative(containedRoot, candidate);
              if (
                rel === '..' ||
                rel.startsWith(`..${sep}`) ||
                isAbsolute(rel)
              ) {
                throw new Error(`${label} resolves outside its package`);
              }
            }
            const manifestInfo = await lstat(containedManifest);
            if (!manifestInfo.isFile()) {
              throw new Error('SKILL.md does not resolve to a regular file');
            }
            readableSkillPath = containedManifest;
          }
          const content = await readFile(readableSkillPath, 'utf-8');
          // One parse, two readers: the spec properties the SDK models, and
          // the raw frontmatter map that carries Station's own `command`/
          // `variables` declarations.
          const { metadata, body } = parseFrontmatter(content);
          const properties = frontmatterToProperties(metadata);
          if (options.validateAgentSkills) {
            const errors = validateSkillContent(content);
            if (errors.length) throw new Error(errors.join('; '));
            if (properties.name !== entry.name) {
              throw new Error(
                'Agent Skill name must match its immediate parent directory',
              );
            }
          }
          const frontmatter = metadata as unknown as Record<string, unknown>;

          const links = extractResourceLinks(body);
          const resources: SkillResource[] = [];
          for (const link of links) {
            const resourcePath = join(entryDir, link.path);
            if (existsSync(resourcePath)) {
              if (options.containmentRoot) {
                const containedRoot = await realpath(options.containmentRoot);
                const containedResource = await realpath(resourcePath);
                const rel = relative(containedRoot, containedResource);
                if (
                  rel === '..' ||
                  rel.startsWith(`..${sep}`) ||
                  isAbsolute(rel)
                ) {
                  this.logger.warn('Skipped out-of-package skill resource', {
                    path: resourcePath,
                  });
                  continue;
                }
              }
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
            location: readableSkillPath,
            sourceCurrent: options.sourceCurrent,
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
        await this.scanDirectory(entryDir, depth + 1, options);
      }
    }
  }

  // ── Prompt Generation (Tier 1) ─────────────────────────

  getSkillCatalogPrompt(skillNames?: string[]): string {
    if (this.registry.size === 0) return '';
    if (skillNames !== undefined && skillNames.length === 0) return '';

    const allSkills = Array.from(this.registry.values()).filter(
      (skill) => skill.sourceCurrent?.() !== false,
    );
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
    const allSkills = Array.from(this.registry.values()).filter(
      (skill) => skill.sourceCurrent?.() !== false,
    );
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
        const result = handleSkillRead(
          skills.filter((skill) => skill.sourceCurrent?.() !== false),
          {
            name: input.name,
            resource: input.resource,
          },
        );
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
    // Resolved ONCE for the whole listing rather than per row: the writability
    // rule reads the filesystem (`resolveSkillDirectory` follows the skills
    // root through `realpathSync`), and every row would otherwise re-resolve
    // the same home.
    const projectHomeDir = this.projectHomeDir();
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
        ...this.writabilityAgainstHome(s.name, projectHomeDir),
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
    return Array.from(this.registry.values())
      .filter((skill) => skill.sourceCurrent?.() !== false)
      .map((skill) => {
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
            origin: canonical.origin ?? ('package' as const),
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
          const skillJsonPath = this.installRecordPath(skill.location);
          if (existsSync(skillJsonPath)) {
            try {
              const config = JSON.parse(readFileSync(skillJsonPath, 'utf-8'));
              // THE SAME rule the detail read applies: a record answers only for
              // the name it claims. Without this the listing reported another
              // skill's source, version and provenance for a copied-and-renamed
              // package — and fed its `legacyIds` into `rebuildLegacyIdIndex`,
              // so that skill's ids resolved here (#1614, and the same class as
              // #1602's disowned-record case).
              if (skillRecordClaimsName(config, skill.name)) {
                source = config.source;
                path = config.path;
                version = config.version ?? version;
                provenance = config.provenance;
                legacyIds = readSkillLegacyIds(config.legacyIds);
                recordedOrigin = readSkillOrigin(config.origin);
              }
            } catch {}
          }
          // The directory the package was FOUND in, when no record states one. A
          // path is a fact about a package that exists, so the listing and the
          // detail (which derives the same fallback) cannot disagree about where
          // a recordless package sits.
          path ??= dirname(skill.location);
        }
        return {
          skill,
          origin:
            this.recordedOriginAgainstPath(recordedOrigin, skill.location) ??
            this.deriveOrigin(skill.location, source),
          install: { version, source, path, provenance, legacyIds },
        };
      });
  }

  /**
   * A recorded origin, checked against the root the package actually sits in.
   *
   * `user` and `project` are the two WRITABLE roots and differ only in SCOPE —
   * and the scope IS the root, so for that pair the path is the authority and a
   * recorded `user` yields to a location under `<home>/projects`. Every
   * `skill.json` written before `project` existed records `user` for a
   * project-scoped package, and `updateLocalSkill` faithfully preserves it, so
   * without this correction every skill already on disk in a workspace would
   * read as "This machine" forever (#1582 D6, review M1).
   *
   * Every other recorded origin stands. `registry`/`plugin`/`package`/
   * `migrated-playbook` record where a skill CAME FROM, which is a fact about
   * its history that no path can restate — a registry install living in the
   * project root is still a registry install.
   *
   * `undefined` in, `undefined` out: this corrects a record, it does not invent
   * one. The read sites fall through to `deriveOrigin` exactly as before.
   */
  private recordedOriginAgainstPath(
    recorded: SkillOrigin | undefined,
    location: string | undefined,
  ): SkillOrigin | undefined {
    if (recorded !== 'user') return recorded;
    return this.deriveOrigin(location, undefined) === 'project'
      ? 'project'
      : 'user';
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
    /** The home to read the roots off; the ambient one when a caller has none. */
    projectHomeDir?: string,
  ): SkillOrigin | undefined {
    if (location) {
      const canonical = this.canonicalSourceFor(location);
      if (canonical) return canonical.origin ?? 'package';
    }
    if (location) {
      const home = projectHomeDir ?? this.projectHomeDir();
      const pluginsRoot = join(home, 'plugins');
      if (location.startsWith(pluginsRoot)) return 'plugin';
      // `discoverSkills` scans exactly one project-scoped root,
      // `<home>/projects/<slug>/skills`, so a location under `<home>/projects`
      // IS workspace-scoped — no slug needed to read that off the path. This
      // sits before the `source` fallthrough because a project skill's
      // `skill.json` records `source: 'local'` just like a machine one, and
      // that is what used to collapse the two into `user` (#1582 D6).
      if (home && location.startsWith(join(home, 'projects') + sep))
        return 'project';
      // …and its pair. `user` and `project` differ ONLY in which writable root
      // holds the package (`recordedOriginAgainstPath` says exactly that), so
      // the machine root reads as `user` for the same reason the project root
      // reads as `project`. Without this, only the project half was derivable
      // from a path and a package with no record — which is every hand-authored
      // one — reported no origin at all in `<home>/skills` while its workspace
      // twin reported `project` (#1614). A record's own `source` still answers
      // below for everything discovery never found.
      if (home && location.startsWith(join(home, 'skills') + sep))
        return 'user';
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
  isSkillWritable(name: string, projectHomeDir: string): boolean {
    return this.packageOwnershipRefusal(name, projectHomeDir) === undefined;
  }

  /**
   * THE writability rule, in the shape a message needs: the reason a package is
   * not Station's to write, or `undefined` when it is.
   *
   * `isSkillWritable` is this same rule as a boolean, for the route. One rule,
   * two shapes — a second copy of it is how two callers end up disagreeing.
   *
   * It asks WHICH ROOT holds the package, not whether its name resolves to one
   * particular directory. That comparison answered "not writable" for every
   * workspace package, because the directory it compared against was derived
   * from a slug the caller did not have (#1619).
   *
   * The floor is `skillPackageDirectoryReport`, which names every condition that
   * holds; this picks the one to speak about. Messages are no longer carried
   * through from the floor verbatim — that shape could only say ONE thing, so
   * three distinct conditions arrived wearing the same explanation. Each
   * condition now has a statement Station owns and a remedy keyed to its reason
   * code, and `SKILL_CONDITION_PRECEDENCE` records why the ordering is what it
   * is: a refusal must speak about the thing the reader has to fix first, and
   * has to be able to fix at all.
   */
  private packageOwnershipRefusal(
    name: string,
    projectHomeDir: string,
  ): PackageOwnershipRefusal | undefined {
    const registered = this.registry.get(name);
    // A source whose generation has been retired is not a writability answer
    // either way: nothing about the package can be trusted until discovery
    // re-registers it, so refuse the question rather than answer it stale.
    if (registered?.sourceCurrent?.() === false)
      throw new Error('Skill source generation is no longer active');
    if (!registered?.location) return undefined;
    const directory = dirname(registered.location);
    if (registered.provided)
      return {
        messageFragment: `it is served in place from ${directory}, which Station does not own`,
        refusal: {
          reason: 'served-in-place',
          detail:
            'A plugin serves it in place, from a directory Station does not own.',
          packageDirectory: directory,
        },
      };
    if (this.canonicalSourceFor(registered.location))
      return {
        messageFragment: `it is served from the package at ${directory}, which Station does not own`,
        refusal: {
          reason: 'canonical-package',
          detail: 'It is served from a package that ships read-only.',
          packageDirectory: directory,
        },
      };
    // The floor's OWN verdict, threaded out rather than re-derived. It
    // distinguishes four conditions and an earlier draft collapsed three of
    // them into "not a skills root Station writes", which published a false
    // explanation twice over (review H1): a dangling link INSIDE a writable
    // root was told it sat outside one and to install itself, and a name that
    // can never be a directory name was told the same. Reading the conditions
    // is the only way the projection can say which refusal this is without
    // parsing the floor's prose.
    //
    // PRECEDENCE IS THIS CALLER'S, and deliberately not the assert's. Where the
    // package sits outranks what its directory is called, because "rename the
    // directory" is unfollowable advice for a package in a root Station will
    // never write — the rename would change nothing (review M2). So
    // `directory-name-mismatch` is published only once containment has
    // succeeded, which is exactly what its docblock claims about it.
    const report = skillPackageDirectoryReport(projectHomeDir, name, directory);
    const condition = worstSkillPackageCondition(report.conditions);
    if (!condition) return undefined;
    return {
      messageFragment: SKILL_REFUSAL_FRAGMENT[condition](name, directory),
      refusal: {
        ...SKILL_REFUSAL_STATEMENT[condition],
        packageDirectory: directory,
      },
    };
  }

  /**
   * The writability decision as the read models carry it, resolved the way the
   * ROUTE resolves it.
   *
   * `this.projectHomeDir()` is `configLoader.getProjectHomeDir()` — the very
   * call `createSkillRoutes`' `getProjectHomeDir` closure makes, on the same
   * `ConfigLoader` instance (`runtime-service-bootstrap.ts` hands both the
   * same one). A second resolution of the project root would be the same
   * defect this projection exists to remove, one layer up.
   *
   * There is no scope to omit or thread: the rule takes a name and a home and
   * asks which root holds the package, so the projection and the enforcement
   * cannot be handed different arguments.
   */
  private skillWritability(name: string): {
    writable: boolean;
    writeRefusal?: SkillWriteRefusal;
  } {
    return this.writabilityAgainstHome(name, this.projectHomeDir());
  }

  /**
   * `skillWritability` with the home resolved once, for a whole listing.
   *
   * The hoist is the ONLY thing saved across rows, and it is the part that was
   * worth saving: `projectHomeDir()` resolves the skills root through
   * `realpathSync`, and every row would otherwise redo it. The decision itself
   * is recomputed per row on purpose. A memo lived here briefly and was
   * deleted: the registry is keyed by name, so one listing never asks about the
   * same name twice and it could not fire — a trip-wire throwing on any hit ran
   * 173 tests across seven suites without one. What it did carry was a
   * parameter a future caller could thread into the write gate, which is
   * exactly how the round-one defect happened.
   *
   * MEASURED after deleting it, and stated PER ROW because that is the durable
   * fact: 36-50us per row, WARM (25 runs after 5 warm-ups, median), and linear
   * — per-row cost held within a few percent across 50, 100 and 200 rows, so
   * the total is just that times the row count.
   *
   * The root the packages sit in moves it by about a third, and the direction is
   * worth recording because it is not the one the mechanism suggests: rows in
   * the WRITABLE root measured slower (44-50us) than rows outside it (36-37us),
   * though both reach `resolveSkillDir`. Not chased further — the number is a
   * scale check, not a budget.
   *
   * A bare total is what NOT to write here. The memo's own docblock claimed
   * ~8.3ms for the writability portion with no fixture, no row count and no
   * cache state named, and a "5ms for 100 packages" replacement repeats the
   * defect at a different magnitude.
   *
   * There is no scope to keep in lockstep. The rule takes a name and a home and
   * asks which root holds the package, so this projection and the write gate
   * cannot be handed different arguments and cannot answer different questions.
   * An earlier draft of this comment predicted the opposite — that a sibling
   * change would thread a slug — which was a claim about another branch stated
   * as fact, and it was wrong. A comment describes the tree it ships on.
   */
  private writabilityAgainstHome(
    name: string,
    projectHomeDir: string,
  ): { writable: boolean; writeRefusal?: SkillWriteRefusal } {
    const writeRefusal = this.packageOwnershipRefusal(
      name,
      projectHomeDir,
    )?.refusal;
    return writeRefusal
      ? { writable: false, writeRefusal }
      : { writable: true };
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
    if (
      this.registry.get(nameOrLegacyId)?.sourceCurrent?.() !== false &&
      this.registry.has(nameOrLegacyId)
    )
      return nameOrLegacyId;
    const indexed = this.legacyIdIndex.get(nameOrLegacyId);
    return indexed !== undefined &&
      this.registry.has(indexed) &&
      this.registry.get(indexed)?.sourceCurrent?.() !== false
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
    return Array.from(this.registry.values())
      .filter((skill) => skill.sourceCurrent?.() !== false)
      .map((skill) =>
        skillToGuidanceAsset({
          id: skill.name,
          name: skill.name,
          description: skill.description,
          installed: true,
          installedVersion: (() => {
            if (!skill.location) return undefined;
            const metaPath = join(
              dirname(skill.location),
              '.station-meta.json',
            );
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
    // ONE decoration site for four answers. The writability projection is a
    // fact about the PACKAGE, not about which of the four reads found it, so
    // deciding it here rather than inside each branch is also the only shape
    // in which the four cannot disagree.
    return {
      ...(await this.readSkillDetail(name)),
      ...this.skillWritability(name),
    };
  }

  private async readSkillDetail(name: string): Promise<SkillDetailBody> {
    // Canonical package skills have no installed config record — serve them
    // straight from the registry (read-only, content from the package).
    const registered = this.registry.get(name);
    if (registered?.sourceCurrent?.() === false)
      throw new Error('Skill source generation is no longer active');
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
        // No install date: a source serves this file in place, and nothing
        // installed it. `''` used to stand in for that, which is a value
        // pretending to be one.
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
        // Shipped with the package, never installed into this home.
        version: canonical.version,
        path: dirname(registered.location),
        body: registered.body,
        origin: canonical.origin ?? 'package',
        ...(resolved.command ? { command: resolved.command } : {}),
        ...(resolved.commandDiagnostic
          ? { commandDiagnostic: resolved.commandDiagnostic }
          : {}),
        ...(variables.length > 0 ? { variables } : {}),
      };
    }
    // A package DISCOVERY found answers from its own directory; a name
    // discovery never saw can only be the install record resolved by name,
    // which is `configLoader`'s derivation and throws when there is none.
    const located = registered?.location;
    const { record, absence } = located
      ? await this.loadInstallRecord(name, located)
      : { record: await this.configLoader.loadSkill(name), absence: undefined };
    // THE PACKAGE ON DISK IS AN ANSWER, WITH OR WITHOUT A RECORD (#1614).
    // `listSkills()` has always answered for a discovered package that nothing
    // installed — deriving `origin` from its location and leaving the install
    // fields undefined — while this read threw `Skill '<name>' not found` for
    // the same name, so the pane 404'd on a skill the list showed. The identity
    // fields stay ABSENT rather than invented; `installRecordDiagnostic` says
    // which absence this is.
    const config: SkillConfig | undefined = record;
    // The body DISCOVERY found, when it found one. `config.path` is the
    // record's own claim about where its package sits, which is the right
    // answer only when there is nothing better — a record whose path has gone
    // stale, or which never carried one, is not the authority on where the
    // file is (and a project-scoped record written by an older build carries a
    // path nobody re-derives). Same directory as the record above, so the two
    // halves of this answer cannot come from two different packages.
    const skillPath = located ?? join((config as SkillConfig).path, 'SKILL.md');
    if (!config && !existsSync(skillPath)) {
      // Neither a record nor a body: there is nothing left to answer FROM. The
      // registry entry is a memory of a file that has since gone.
      throw new Error(`Skill '${name}' not found`);
    }
    if (!existsSync(skillPath)) {
      // The mirror is the ONLY thing left to read, so say so. A silent
      // fallback is what let a `command` deleted from SKILL.md keep answering
      // from a stale install record while the listing said it was gone
      // (review finding 5).
      return this.fromInstallRecordOnly(
        config as SkillConfig,
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
        // The record's fields when there is one; `name` and `path` are derived
        // from the package itself when there is not, because both are facts
        // about a directory that exists rather than claims a record makes.
        ...config,
        name: config?.name ?? name,
        path: config?.path ?? dirname(skillPath),
        body,
        description: properties.description ?? config?.description,
        tags: Array.isArray(frontmatter.tags)
          ? (frontmatter.tags as string[])
          : config?.tags,
        category:
          typeof frontmatter.category === 'string'
            ? frontmatter.category
            : config?.category,
        agent:
          typeof frontmatter.agent === 'string'
            ? frontmatter.agent
            : config?.agent,
        global:
          typeof frontmatter.global === 'boolean'
            ? frontmatter.global
            : config?.global,
        provenance: config?.provenance,
        command: resolved.command,
        commandDiagnostic: resolved.commandDiagnostic,
        variables: variables.length > 0 ? variables : undefined,
        legacyIds: readSkillLegacyIds(config?.legacyIds),
        origin:
          this.recordedOriginAgainstPath(
            readSkillOrigin(config?.origin),
            skillPath,
          ) ?? this.deriveOrigin(skillPath, config?.source),
        ...(absence
          ? {
              installRecordDiagnostic: `Shown from the package on disk: ${absence}, so its source, version, install date and provenance are unknown.`,
            }
          : {}),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (!config) {
        // No record to fall back to and a body that will not parse: there is
        // nothing this read can answer FROM. Say which failure it was rather
        // than reporting the package as absent, which it is not.
        throw new Error(
          `Skill '${name}' could not be read: no install record sits beside it and ${skillPath} could not be parsed (${reason})`,
        );
      }
      return this.fromInstallRecordOnly(
        config,
        `SKILL.md at ${skillPath} could not be parsed (${reason}); command and variables are shown from the install record and may be stale`,
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
  ): SkillDetailBody {
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
      if (registered?.sourceCurrent?.() === false)
        throw new Error('Skill source generation is no longer active');
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
    // A create's directory is name-derived: there is no discovered package to
    // read one from, and `resolveSkillDirectory` owns that derivation.
    const directory = this.resolveSkillDir(
      projectHomeDir,
      input.name,
      projectSlug,
    );
    return this.withLocalSkillMutation([directory], () =>
      this.createLocalSkillOwned(input, projectHomeDir, directory, projectSlug),
    );
  }

  /** The create half of the local-Skill capability.  Never call unlocked. */
  private async createLocalSkillOwned(
    input: EditableSkillInput,
    projectHomeDir: string,
    /** Resolved and LOCKED by the caller — never re-derived here (review M1). */
    skillDir: string,
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
    // The directory this create resolved and LOCKED, not a second derivation of
    // it. They agree by construction today, so this is benign — but the
    // parameter's own docblock says the directory is never re-derived here, and
    // that sentence has to be true: a future caller handing in a rename
    // destination or a discovered directory would write the body to one place
    // while the record's `path` and `origin` describe another, which is the
    // split-package shape #1619 exists to close (delta review F1).
    const publication = this.projectLocalSkillPublicationAt(
      input,
      projectHomeDir,
      skillDir,
    );
    try {
      // These are the exact two canonical byte sequences projected above.
      // ConfigLoader's local save format is the same stable JSON encoder.
      //
      // Both into `skillDir`, the directory this create just made. The
      // name-addressed save resolves `<home>/skills/<name>` with no slug, so a
      // SCOPED create wrote the body into the project directory and the record
      // into the machine root — the split package #1619's second finding
      // names, and the one shape the read cannot reconcile because each half
      // says the other is somewhere else.
      await this.configLoader.saveSkillIn(skillDir, publication.config);
      await writeFile(
        join(skillDir, 'SKILL.md'),
        publication.skillMarkdown,
        'utf-8',
      );
    } catch (error) {
      // The record is intentionally first, but it is not a committed Skill
      // until its body is durable.  Under this capability no other local
      // writer can observe/reuse the directory while exact compensation runs.
      // Compensation removes the directory this create made, for the same
      // reason the writes went into it.
      try {
        await this.configLoader.deleteSkillAt(input.name, skillDir);
      } catch (compensationError) {
        throw new SkillPublicationIndeterminateError(compensationError);
      }
      throw error;
    }
    await this.rediscoverAfterWrite(projectHomeDir, projectSlug);
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
    return this.projectLocalSkillPublicationAt(
      input,
      projectHomeDir,
      this.resolveSkillDir(projectHomeDir, input.name, projectSlug),
    );
  }

  /**
   * The same projection for a caller that has already RESOLVED the package
   * directory — the interrupted-package repair, which is handed the directory
   * its lock was taken on and must describe that one rather than re-derive a
   * second (review M1).
   *
   * `origin` follows the directory: it is the root that makes a package a
   * workspace one, and stamping `user` while writing into
   * `<home>/projects/<slug>/skills` made the recorded origin (which outranks
   * the path derivation on read) contradict the path (#1582 D6).
   */
  projectLocalSkillPublicationAt(
    input: EditableSkillInput,
    /**
     * The home `skillDir` belongs to. Passed rather than read off the loader:
     * every caller agrees with the ambient home today, and a projection that
     * depends on ambient state instead of its own argument is the defect one
     * refactor away (delta review).
     */
    projectHomeDir: string,
    skillDir: string,
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
      // Derived from the directory this package is written to, which is the
      // only thing that decides whether it is a workspace package.
      origin:
        stableInput.origin ??
        this.deriveOrigin(
          join(skillDir, 'SKILL.md'),
          'local',
          projectHomeDir,
        ) ??
        'user',
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
    // NAME-DERIVED, deliberately, and this is the one seam where that is the
    // right answer. An interrupted package has no `SKILL.md` — that is what
    // makes it interrupted — so discovery never registers it, and resolving
    // through the registry hands back whatever OTHER package owns the name:
    // the repair then reads a directory it did not write, reports "identity or
    // contents are unavailable", and the half-written package is permanently
    // unrepairable (delta review, reproduced). The package was created at a
    // name-derived path, so the repair resolves the same way it was written.
    const directory = this.resolveSkillDir(
      projectHomeDir,
      expectedIdentity.name,
      projectSlug,
    );
    return this.withLocalSkillMutation([directory], () =>
      this.completeInterruptedLocalSkillPackageOwned(
        input,
        expectedIdentity,
        projectHomeDir,
        directory,
        options,
      ),
    );
  }

  private async completeInterruptedLocalSkillPackageOwned(
    input: EditableSkillInput,
    expectedIdentity: InterruptedLocalSkillPackageIdentity,
    projectHomeDir: string,
    /** Resolved and LOCKED by the caller — never re-derived here (review M1). */
    skillDir: string,
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
    // The projection describes the package at `skillDir`, so it is given that
    // directory rather than a slug it would re-derive one from.
    const publication = this.projectLocalSkillPublicationAt(
      input,
      projectHomeDir,
      skillDir,
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
      await this.rediscoverAfterWrite(projectHomeDir);
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
      [this.resolveSkillDir(projectHomeDir, input.name, projectSlug)],
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
        return this.createLocalSkillOwned(
          input,
          projectHomeDir,
          target,
          projectSlug,
        );
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
    // reading either so two opposing renames cannot deadlock or overwrite —
    // and acquire the DIRECTORIES this write will touch, which for a workspace
    // package are in its own root rather than the machine one (#1619).
    const directory = this.packageDirectoryFor(
      name,
      projectHomeDir,
      projectSlug,
    );
    const nextName = updates.name ?? name;
    return this.withLocalSkillMutation(
      nextName === name
        ? [directory]
        : [
            directory,
            this.renameTargetDirectory(directory, nextName, projectHomeDir),
          ],
      () =>
        this.updateLocalSkillOwned(
          name,
          updates,
          projectHomeDir,
          directory,
          projectSlug,
        ),
    );
  }

  private async updateLocalSkillOwned(
    name: string,
    updates: Partial<EditableSkillInput>,
    projectHomeDir: string,
    /** Resolved and LOCKED by the caller — never re-derived here (review M1). */
    skillDir: string,
    projectSlug?: string,
  ): Promise<{ success: boolean; message: string }> {
    // A rename is a create under a new name: the same seam, the same refusal.
    if (updates.name !== undefined) assertSafeSkillName(updates.name);
    // WRITABILITY FIRST, then the directory. A root Station does not own is
    // refused for EVERY field rather than only when the request declares a
    // command: that is what `isSkillWritable`'s docblock has always said
    // ("those must be installed into the workspace before they can be
    // edited"), and a description edit used to quietly publish a shadow
    // package into the workspace instead. The predicate is shared with the
    // route rather than restated, so one rule cannot drift into two answers —
    // and it has to run before the resolution below, which REFUSES such a
    // directory by throwing rather than by answering.
    //
    // Read the registry entry here rather than inside the message: a package
    // with no discovered location is writable by definition, so this condition
    // is exactly the predicate's own — with no unreachable "or else" to
    // describe a case it cannot produce.
    //
    // `messageFragment`, not the projected refusal: this path states the reason
    // in a sentence and the read models state it in a code plus prose that
    // carries no author-controlled text. Same rule, same call, two shapes —
    // which is the point. (The fragment does interpolate paths and the name;
    // that is pre-existing and tracked in #1681, not introduced here.)
    const refusal = this.packageOwnershipRefusal(name, projectHomeDir);
    if (refusal) {
      return {
        success: false,
        message: `Cannot edit '${name}': ${refusal.messageFragment}.`,
      };
    }
    const current = await this.getSkill(name);
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
    // A rename MOVES the package, so the destination is resolved BEFORE the
    // record is built: the origin below is a fact about where this write lands.
    const nextName = updates.name ?? current.name;
    const nextDir = this.renameTargetDirectory(
      skillDir,
      nextName,
      projectHomeDir,
    );
    const nextPath = join(nextDir, 'SKILL.md');
    const next: EditableSkillInput = {
      name: nextName,
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
      // Corrected on the way BACK to disk too, so a workspace package stops
      // carrying a stale `user` the moment anything edits it. Nothing more is
      // claimed here: `current.origin` is ALREADY the resolved value (`getSkill`
      // folds `recorded ?? derived`), so a record with no origin of its own has
      // long been written one on update — pre-existing, unchanged, and not
      // something this line can be read as preventing. All it adds is
      // `user` -> `project` (delta-review L2).
      //
      // Against the DESTINATION, not the path the read came from: `user` and
      // `project` differ only in which root the package sits in, so the only
      // path that can say which one this record will be true of is the one it
      // is being written to. The guard above means the two share a root today;
      // deriving it from `nextPath` keeps that a property of the code rather
      // than an assumption about a caller.
      origin:
        updates.origin ??
        this.recordedOriginAgainstPath(
          readSkillOrigin(current.origin),
          nextPath,
        ),
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
    if (nextDir !== skillDir) {
      // A NAME, not just a directory. `existsSync(nextDir)` only sees this
      // root, so renaming onto a canonical package's or a plugin's name — which
      // lives somewhere else entirely — passed it, and because `<home>/skills`
      // is scanned last the local package then took the name and the one it
      // shadowed vanished from the listing. `createLocalSkill` has refused
      // exactly this since it was written (`hasSkill(input.name)`); a rename is
      // a create under a new name, so it refuses the same way (review round 2,
      // M2).
      if (this.hasSkill(next.name)) {
        return {
          success: false,
          message: `Cannot rename ${name} to ${next.name}: a skill called '${next.name}' already exists`,
        };
      }
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
    await mkdir(nextDir, { recursive: true });
    await writeFile(
      nextPath,
      serializeSkillMarkdown(next, preservedFrontmatter),
      'utf-8',
    );
    // Into the package's OWN directory, so the record and the body cannot end
    // up in different roots (#1619): `configLoader.saveSkill` resolves the
    // directory from the name and no slug, which for a workspace package put
    // `skill.json` in `<home>/skills/<name>` while `SKILL.md` stayed in the
    // project — one package in two places, each half describing the other.
    await this.configLoader.saveSkillIn(nextDir, {
      ...current,
      name: next.name,
      description: next.description,
      source: 'local',
      // `installedAt` is deliberately NOT restated here: `...current` already
      // carries it, including its absence for a package nobody installed. The
      // rule this write follows is that it never invents one — the moment a
      // record is written is a fact about the record, not about a package that
      // predates it — and the way to follow that rule is to not write the
      // field at all.
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
    await this.rediscoverAfterWrite(projectHomeDir, projectSlug);
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
      rediscover: async () =>
        this.rediscoverAfterWrite(projectHomeDir, projectSlug),
    });
  }

  async removeSkill(
    name: string,
    projectHomeDir: string,
    projectSlug?: string,
  ): Promise<SkillRemovalResult> {
    const directory = this.packageDirectoryFor(
      name,
      projectHomeDir,
      projectSlug,
    );
    return this.withLocalSkillMutation([directory], () =>
      this.removeSkillOwned(name, projectHomeDir, directory, projectSlug),
    );
  }

  private async removeSkillOwned(
    name: string,
    projectHomeDir: string,
    /** Resolved and LOCKED by the caller — never re-derived here (review H1). */
    directory: string,
    projectSlug?: string,
  ): Promise<SkillRemovalResult> {
    skillOps.add(1, { operation: 'remove' });
    // A remove deletes a package TREE, so a package Station does not own must
    // not be one of them. `packageDirectoryFor` already guarantees that — it
    // never answers with a foreign root — so what is left for this refusal is
    // to SAY so, and only when there is nothing of ours to remove instead.
    //
    // That last clause is a regression fixed (review M2). A plugin package
    // sharing a name overwrites the registry entry for the user's own
    // `<home>/skills/<name>`, and refusing on the registry entry alone meant a
    // user could not delete their own skill, with a message blaming a plugin
    // they may never have heard of. Discovery's precedence is left exactly as
    // it is — which body activates is a different question with its own rules
    // — and the remove simply looks at whether a package of ours is there.
    //
    // The two callers deliberately differ on this existence check: an EDIT
    // refuses whenever the package Station found is not one it owns, while a
    // remove additionally asks whether a package of ours is sitting at the
    // name-derived path. The measured consequence is a case-differing
    // directory: on a case-insensitive volume `<home>/skills/Alpha` makes
    // `existsSync` true for `alpha`, so an edit refuses it and a remove
    // deletes it; on a case-sensitive volume both refuse. That asymmetry is
    // the price of not blocking a user from deleting their own package, and it
    // is recorded rather than papered over.
    const refusal = this.packageOwnershipRefusal(name, projectHomeDir);
    if (refusal && !existsSync(directory)) {
      return {
        success: false,
        // STRUCTURED, not a message a caller has to parse: the route maps this
        // to 409, and deriving that from the prose meant any rewording
        // silently reverted every ownership refusal to a false 404 (delta
        // review).
        reason: 'not-owned',
        message: `Cannot remove '${name}': ${refusal.messageFragment}.`,
      };
    }
    return removeInstalledSkill({
      name,
      projectHomeDir,
      targetDir: directory,
      rediscover: async () =>
        this.rediscoverAfterWrite(projectHomeDir, projectSlug),
    });
  }

  /** Canonical on-disk revision used by conditional setup-import rollback. */
  async localSkillRevision(
    name: string,
    projectHomeDir: string,
    projectSlug?: string,
  ): Promise<string> {
    const directory = this.packageDirectoryFor(
      name,
      projectHomeDir,
      projectSlug,
    );
    return this.withLocalSkillMutation([directory], () =>
      localSkillRevisionFromDirectory(directory),
    );
  }

  /**
   * Compare-and-delete: a changed Skill is retained for operator repair.
   *
   * ONE resolution, threaded. This verified `resolveSkillDir(home, name, slug)`
   * — name-derived — and then called a remove that resolved through
   * `packageDirectoryFor`, so it digested one tree and deleted another whenever
   * those disagreed: a machine package whose frontmatter name differs from its
   * directory (discovery keys on the frontmatter name) plus a discovered
   * package genuinely of that name elsewhere is enough. Setup-import's rollback
   * then recorded a successful compensation for a tree it never verified, and a
   * package it never created was gone (review H1).
   *
   * Resolving once also makes the lock and the write the SAME read of a
   * registry `discoverSkills` mutates without holding it (review M1): two
   * independent reads could name two directories, and the one that got locked
   * was not necessarily the one that got deleted.
   */
  async removeSkillIfRevision(
    name: string,
    expectedRevision: string,
    projectHomeDir: string,
    projectSlug?: string,
  ): Promise<{ removed: boolean; conflict: boolean }> {
    const directory = this.packageDirectoryFor(
      name,
      projectHomeDir,
      projectSlug,
    );
    return this.withLocalSkillMutation([directory], async () => {
      let current: string;
      try {
        current = await localSkillRevisionFromDirectory(directory);
      } catch {
        return { removed: false, conflict: true };
      }
      if (current !== expectedRevision)
        return { removed: false, conflict: true };
      const result = await this.removeSkillOwned(
        name,
        projectHomeDir,
        directory,
      );
      return { removed: result.success, conflict: !result.success };
    });
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
      this.activeCanonicalSources.find((source) => {
        const rel = relative(source.root, location);
        return (
          rel === '' ||
          (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
        );
      }) ?? null
    );
  }

  /**
   * Re-discover after a write, in the scope the registry was BUILT with.
   *
   * `discoverSkills` clears the registry and re-scans exactly the roots its
   * arguments name, so a write that re-discovered with the caller's slug —
   * `undefined` from every route (`routes/agents/skills.ts`) — dropped the
   * project root for everyone. After any skill PUT, workspace skills vanished
   * from the listing until something else re-discovered with a slug, and the
   * unscoped-update refusal became non-deterministic: the second PUT on the
   * same package answered "not found" because the registry no longer held it
   * (#1619).
   *
   * A caller that names a scope still wins — it knows something this does not.
   * The remembered scope only applies to the same home it was recorded for.
   */
  private async rediscoverAfterWrite(
    projectHomeDir: string,
    projectSlug?: string,
  ): Promise<void> {
    const remembered = this.lastDiscoveryScope;
    const slug =
      projectSlug ??
      (remembered?.projectHomeDir === projectHomeDir
        ? remembered.projectSlug
        : undefined);
    await this.discoverSkills(projectHomeDir, slug);
  }

  /** THE one place a discovered skill's install record is located: beside its body. */
  private installRecordPath(location: string): string {
    return join(dirname(location), 'skill.json');
  }

  /**
   * The install record behind a DETAIL read, resolved from where discovery
   * found the skill rather than re-derived from its name.
   *
   * `configLoader.loadSkill(name)` resolves `<home>/skills/<name>` with no
   * project slug (`loadSkillConfig` -> `resolveSkillDirectory(home, name)`),
   * so a skill that lives only under `<home>/projects/<slug>/skills/<name>`
   * never reached its own record: `getSkill` threw `Skill '<name>' not found`
   * for a name `listSkills()` shows, and the detail pane 404'd (#1602). The
   * registry already holds the location the discovery walk used, and
   * `skillRecords()` reads the record from exactly that directory — this is
   * the same read through the same `installRecordPath`, so the listing and the
   * detail cannot disagree about which record a name has.
   *
   * PRECEDENCE IS DISCOVERY'S, UNCHANGED. `discoverSkills` scans the project
   * root first and `<home>/skills` after it, and a later registration wins the
   * name, so a skill present in both roots resolves to the machine-wide
   * package here exactly as it does in the listing.
   *
   * The name never becomes a path here: `location` came from scanning the
   * filesystem, not from a caller. A skill discovery never saw at all — its
   * `SKILL.md` is missing, so this answer is the record alone — still resolves
   * through `configLoader`, which asserts the name and owns that derivation.
   */
  private async loadInstallRecord(
    name: string,
    location: string,
  ): Promise<{ record?: SkillConfig; absence?: string }> {
    const recordPath = this.installRecordPath(location);
    if (!existsSync(recordPath)) {
      return {
        absence: `no install record sits beside this package at ${dirname(location)}`,
      };
    }
    const record = JSON.parse(
      await readFile(recordPath, 'utf-8'),
    ) as SkillConfig;
    // A record answers only for the name it CLAIMS — the same rule
    // `loadSkillConfig` applies to the record it resolves by path, shared
    // rather than restated (see its docblock for what a disowned record hands
    // a caller). A disowned record is not this package's record, and saying
    // WHICH of the two absences this is costs one string.
    if (skillRecordClaimsName(record, name)) return { record };
    return {
      absence: `the install record at ${recordPath} claims '${String(record.name)}', not '${name}'`,
    };
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
   * THE directory a write touches: the one DISCOVERY found the package in.
   *
   * The read has resolved a package from its discovered location since #1602;
   * the write kept deriving `<skills root>/<name>` from the name plus a
   * `projectSlug` no route passes (`routes/agents/skills.ts`), and the only
   * slug the runtime could offer is `listProjects()[0]?.slug` — the first
   * project, not a chosen one. So a write either refused a workspace package or
   * wrote a second one into the machine root. Reading the directory off the
   * registry removes the guess entirely: the package a write edits is the
   * package the read answered from, in whichever root it lives.
   *
   * A package discovery never found has no location to read, so a CREATE (and
   * anything naming a package that does not exist yet) still derives its
   * directory from the name — there is nothing else to derive it from, and
   * `resolveSkillDirectory` owns that derivation and its guarantees.
   *
   * `assertSkillPackageDirectory` re-asserts those guarantees on the registry's
   * directory, because a path that did not come from the resolver has not been
   * through them.
   */
  private packageDirectoryFor(
    name: string,
    projectHomeDir: string,
    projectSlug?: string,
  ): string {
    const location = this.registry.get(name)?.location;
    // A package Station may not write (a canonical package's, a plugin's) is
    // refused by the caller, with a message, before anything is written — so
    // this must ANSWER for it rather than throw, or the refusal never gets to
    // speak. What it answers is the name-derived directory, which is exactly
    // the one that write would have touched, and which nothing then touches.
    if (!location || !this.isSkillWritable(name, projectHomeDir)) {
      return this.resolveSkillDir(projectHomeDir, name, projectSlug);
    }
    const directory = dirname(location);
    // Defence, not the decision: `isSkillWritable` has already made this
    // assertion pass. It is restated here so the guarantee lives at the
    // resolver a writer reads, not only inside a predicate it happens to call.
    assertSkillPackageDirectory(projectHomeDir, name, directory);
    return directory;
  }

  /**
   * The directory a package would MOVE to under a new name: its sibling in the
   * root it already lives in. A rename does not change which root owns a
   * package, so this is derived from the current package's own parent rather
   * than from a slug.
   */
  private renameTargetDirectory(
    currentDirectory: string,
    nextName: string,
    projectHomeDir: string,
  ): string {
    const directory = join(dirname(currentDirectory), nextName);
    assertSkillPackageDirectory(projectHomeDir, nextName, directory);
    return directory;
  }

  /**
   * Universal local Skill mutation authority. Every filesystem writer,
   * conditional reader and revision proof goes through this seam.  A rename
   * owns both identities in canonical path order, so it is safe across
   * Station processes without relying on a process-local mutex.
   */
  private async withLocalSkillMutation<T>(
    directories: string[],
    effect: () => Promise<T>,
  ): Promise<T> {
    return withLocalSkillMutation(directories, effect);
  }
}
