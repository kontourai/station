import { createHash } from 'node:crypto';
import {
  accessSync,
  type Dirent,
  existsSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_PLUGIN_MANIFEST_SCHEMA_1_0,
  AGENT_PLUGIN_MCP_SCHEMA_1_0,
  type AgentPluginManifestV1,
  STATION_AGENT_PLUGIN_EXTENSION_ID,
  type StationAgentPluginExtensionV1,
} from '@kontourai/station-contracts/agent-plugin';
import { isCanonicalPluginId } from '@kontourai/station-contracts/plugin';
import type {
  SkillExperienceDefinitionV1,
  SkillExperienceIdentityV1,
  SkillExperienceInventoryV1,
} from '@kontourai/station-contracts/skill-experience';
import type { ToolDef, ToolMetadata } from '@kontourai/station-contracts/tool';
import { parseAgentPluginManifest } from '@kontourai/station-shared/agent-plugin-manifest';
import {
  bindMCPDefinitionAdmission,
  MCPLocalCustodyError,
} from '@kontourai/station-shared/mcp';
import { readValidatedSkillExperiences } from '@kontourai/station-shared/skill-experience-author';
import {
  frontmatterToProperties,
  parseFrontmatter,
  validateSkillContent,
} from 'agent-skills-ts-sdk';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import { isRecord } from '../../utils/is-record.js';
import type { CanonicalSkillSource } from '../flow/flow-agents-skills-source.js';
import { assertSafeContextText } from '../orchestration/context-safety.js';
import type { PackageMcpAdmissionJournal } from './package-mcp-admission.js';
import {
  computePluginContentDigest,
  computePluginContentDigestAsync,
  withPluginContentLock,
} from './plugin-content-integrity.js';
import {
  localManagedPluginAliases,
  PluginIncarnationError,
  resolveInstalledPluginRoot,
  resolvePluginMaterialization,
} from './plugin-incarnation.js';
import { withPluginPermissionInvocation } from './plugin-permissions.js';

const MAX_CONFIGURATION_BYTES = 2 * 1024 * 1024;
const WINDOWS_RESERVED_ENV = new Set(['plugin_root', 'plugin_data']);
const PLUGIN_DATA_PLACEHOLDER = '$' + '{PLUGIN_DATA}';
const HTTP_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

type AgentPluginLoadReportCode =
  | 'component-invalid'
  | 'duplicate-plugin-name'
  | 'manifest-invalid'
  | 'mcp-invalid'
  | 'mcp-server-invalid'
  | 'mcp-transport-unsupported'
  | 'skill-invalid'
  | 'station-extension-invalid'
  | 'unknown-manifest-field';

export interface AgentPluginLoadReport {
  level: 'warning' | 'error';
  code: AgentPluginLoadReportCode;
  pluginRoot: string;
  component?: string;
  message: string;
}

interface LoadedAgentPluginSkill {
  name: string;
  directory: string;
  manifestPath: string;
}

interface LoadedAgentPlugin {
  root: string;
  dataRoot: string;
  manifest: AgentPluginManifestV1;
  stationExtension?: StationAgentPluginExtensionV1;
  /** Contained Station namespace directory; semantics remain namespace-owned. */
  stationExtensionRoot?: string;
  skills: LoadedAgentPluginSkill[];
  tools: ToolDef[];
  reports: AgentPluginLoadReport[];
}

import {
  type PluginActivationComposition,
  pluginActivationCompositionPermit,
} from './plugin-activation-composition.js';

interface AgentPluginLoaderOptions {
  /** Station's runtime home, which owns installed packages and persistent data. */
  projectHomeDir: string;
  /** Injectable for tests and packaged distributions; schemas are never fetched. */
  schemaRoot?: string;
  /** Test/packaging seam for locating schemas relative to the server module. */
  schemaModuleUrl?: string;
  report?: (report: AgentPluginLoadReport) => void;
  journal?: () => PackageMcpAdmissionJournal;
  /** Explicit owner-only composition capability; never used by public readers. */
  composition?: PluginActivationComposition;
}

type AgentPluginLoadOutcome =
  | { ok: true; plugin: LoadedAgentPlugin }
  | { ok: false; reports: AgentPluginLoadReport[] };

interface AgentPluginValidators {
  manifest: ValidateFunction;
  mcpServer: ValidateFunction;
  stationExtension: ValidateFunction;
}

const validatorCache = new Map<string, AgentPluginValidators>();

/** Source modules and bundled dist-server assets both sit beside a shipped schemas tree. */
function resolveAgentPluginSchemaRoot(
  moduleUrl: string = import.meta.url,
): string {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const candidates = [
    join(moduleDir, '..', 'schemas', 'agent-plugins'),
    join(moduleDir, '..', '..', '..', 'schemas', 'agent-plugins'),
  ];
  const found = candidates.find((candidate) =>
    existsSync(join(candidate, '1.0.0', 'plugin.schema.json')),
  );
  if (!found) {
    throw new Error('Vendored Agent Plugins schemas are unavailable');
  }
  return realpathSync(found);
}

function validatorsFor(schemaRoot: string): AgentPluginValidators {
  const cached = validatorCache.get(schemaRoot);
  if (cached) return cached;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const manifestSchema = JSON.parse(
    readBoundedRegularFile(join(schemaRoot, '1.0.0', 'plugin.schema.json')),
  );
  const mcpSchema = JSON.parse(
    readBoundedRegularFile(join(schemaRoot, '1.0.0', 'mcp.schema.json')),
  );
  const stationSchema = JSON.parse(
    readBoundedRegularFile(
      join(schemaRoot, 'io.kontourai.station-1.0.schema.json'),
    ),
  );
  ajv.addSchema(mcpSchema);
  const compiled = {
    manifest: ajv.compile(manifestSchema),
    mcpServer: ajv.compile({
      $ref: `${AGENT_PLUGIN_MCP_SCHEMA_1_0}#/$defs/server`,
    }),
    stationExtension: ajv.compile(stationSchema),
  } satisfies AgentPluginValidators;
  validatorCache.set(schemaRoot, compiled);
  return compiled;
}

interface AgentPluginLoadOptions {
  /** False for staged install validation; persistent data is never created pre-consent. */
  provisionData?: boolean;
  /** Already-read manifest bytes at a caller-owned containment boundary. */
  manifestDocument?: unknown;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return (
    rel === '' ||
    (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  );
}

function resolveAgentPluginDataDirectory(
  projectHomeDir: string,
  pluginName: string,
  { provision = false }: { provision?: boolean } = {},
): { root: string; directory: string } {
  if (!isCanonicalPluginId(pluginName)) {
    throw new Error('Agent Plugin data identity is invalid');
  }
  const requestedHome = resolve(projectHomeDir);
  const home = realpathSync(requestedHome);
  if (!statSync(home).isDirectory()) {
    throw new Error('Station home is not a real directory');
  }
  const requestedRoot = join(home, 'agent-plugin-data');
  let rootInfo = lstatSync(requestedRoot, { throwIfNoEntry: false });
  if (rootInfo?.isSymbolicLink()) {
    throw new Error('Agent Plugin data root must not be a symbolic link');
  }
  if (!rootInfo && provision) {
    mkdirSync(requestedRoot, { mode: 0o700 });
    rootInfo = lstatSync(requestedRoot);
  }
  if (rootInfo && !rootInfo.isDirectory()) {
    throw new Error('Agent Plugin data root must be a directory');
  }
  const root = rootInfo ? realpathSync(requestedRoot) : requestedRoot;
  if (!isInside(home, root)) {
    throw new Error('Agent Plugin data root escapes Station home');
  }

  const requestedDirectory = join(root, pluginName);
  let directoryInfo = lstatSync(requestedDirectory, {
    throwIfNoEntry: false,
  });
  if (directoryInfo?.isSymbolicLink()) {
    throw new Error('Agent Plugin data directory must not be a symbolic link');
  }
  if (!directoryInfo && provision) {
    if (!rootInfo) {
      throw new Error('Agent Plugin data root is unavailable');
    }
    mkdirSync(requestedDirectory, { mode: 0o700 });
    directoryInfo = lstatSync(requestedDirectory);
  }
  if (directoryInfo && !directoryInfo.isDirectory()) {
    throw new Error('Agent Plugin data directory must be a directory');
  }
  const directory = directoryInfo
    ? realpathSync(requestedDirectory)
    : requestedDirectory;
  if (!isInside(root, directory)) {
    throw new Error('Agent Plugin data directory escapes its root');
  }
  return { root, directory };
}

function readBoundedRegularFile(path: string): string {
  const info = statSync(path);
  if (!info.isFile()) throw new Error('expected a regular file');
  if (info.size > MAX_CONFIGURATION_BYTES) {
    throw new Error(`file exceeds ${MAX_CONFIGURATION_BYTES} bytes`);
  }
  return readFileSync(path, 'utf8');
}

function singlePassExpand(
  value: string,
  pluginRoot: string,
  pluginData: string,
): string {
  return value.replace(/\$\{(PLUGIN_ROOT|PLUGIN_DATA)\}/g, (_, name) =>
    name === 'PLUGIN_ROOT' ? pluginRoot : pluginData,
  );
}

function resolveContainedPath(root: string, candidate: string): string {
  const resolvedRoot = realpathSync(root);
  // Absolute placeholder expansions remain absolute; a `./` value is
  // plugin-relative by specification and must not inherit Station's process
  // cwd. `resolve(root, absolute)` preserves the absolute value.
  const target = resolve(resolvedRoot, candidate);
  if (!isInside(resolvedRoot, target)) throw new Error('path escapes its root');

  // A not-yet-created PLUGIN_DATA child is valid. Prove its nearest existing
  // ancestor instead, so an intervening symlink still cannot redirect it.
  let existing = target;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error('path has no existing ancestor');
    existing = parent;
  }
  const resolvedExisting = realpathSync(existing);
  if (!isInside(resolvedRoot, resolvedExisting)) {
    throw new Error('path resolves outside its root');
  }
  if (existsSync(target)) {
    const resolvedTarget = realpathSync(target);
    if (!isInside(resolvedRoot, resolvedTarget)) {
      throw new Error('path resolves outside its root');
    }
    return resolvedTarget;
  }
  return target;
}

function safeRemoteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username ||
      url.password ||
      url.hash
    ) {
      return false;
    }
    if (url.protocol === 'https:') return true;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '[::1]' || host === '::1') return true;
    const octets = host.split('.').map(Number);
    return (
      octets.length === 4 &&
      octets.every(
        (part) => Number.isInteger(part) && part >= 0 && part <= 255,
      ) &&
      octets[0] === 127
    );
  } catch {
    return false;
  }
}

function validLiteralHeaders(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  const names = new Set<string>();
  for (const [name, headerValue] of Object.entries(value)) {
    const folded = name.toLowerCase();
    if (
      typeof headerValue !== 'string' ||
      !HTTP_HEADER_NAME.test(name) ||
      names.has(folded) ||
      /[\r\n]/.test(headerValue)
    ) {
      return false;
    }
    names.add(folded);
    try {
      new Headers([[name, headerValue]]);
    } catch {
      return false;
    }
  }
  return true;
}

function toolId(pluginName: string, serverName: string): string {
  const digest = createHash('sha256')
    .update(`${pluginName}\0${serverName}`)
    .digest('hex')
    .slice(0, 24);
  return `agent-plugin-${digest}`;
}

/**
 * A failure-isolated Agent Plugins 1.0 consumer and live Station source.
 * Every catalog read re-reads installed package bytes; no skill or ToolDef is
 * copied into Station-owned configuration.
 */
export class AgentPluginLoader {
  private readonly projectHomeDir: string;
  private readonly pluginsDir: string;
  private readonly reportSink?: (report: AgentPluginLoadReport) => void;
  private readonly validateManifest: ValidateFunction;
  private readonly validateMcpServer: ValidateFunction;
  private readonly validateStationExtension: ValidateFunction;

  constructor(private readonly options: AgentPluginLoaderOptions) {
    this.projectHomeDir = realpathSync(resolve(options.projectHomeDir));
    this.pluginsDir = join(this.projectHomeDir, 'plugins');
    this.reportSink = options.report;
    const schemaRoot = options.schemaRoot
      ? realpathSync(resolve(options.schemaRoot))
      : resolveAgentPluginSchemaRoot(options.schemaModuleUrl);
    const validators = validatorsFor(schemaRoot);
    this.validateManifest = validators.manifest;
    this.validateMcpServer = validators.mcpServer;
    this.validateStationExtension = validators.stationExtension;
  }

  private selectedRoot(
    pluginId: string,
    purpose: 'execution' | 'legacy-scan-exclusion' = 'execution',
  ) {
    const journal = this.options.journal?.();
    if (journal) {
      const current = journal.currentInstallation(pluginId);
      if (current.state === 'unavailable')
        throw new MCPLocalCustodyError('stale');
      if (
        purpose === 'execution' &&
        current.state === 'observed' &&
        !journal.admissionOpen(current.installation) &&
        !pluginActivationCompositionPermit(
          this.options.composition,
          journal,
          pluginId,
        )
      )
        throw new MCPLocalCustodyError('stale');
      if (
        current.state === 'observed' &&
        current.installation.materialization
      ) {
        const selected = resolvePluginMaterialization(
          this.pluginsDir,
          pluginId,
          current.installation.materialization,
        );
        if (selected.dataScope !== current.installation.dataScope)
          throw new MCPLocalCustodyError('stale');
        return selected;
      }
      const fallback = resolveInstalledPluginRoot(this.pluginsDir, pluginId);
      return fallback?.kind === 'incarnation' ? null : fallback;
    }
    return resolveInstalledPluginRoot(this.pluginsDir, pluginId);
  }

  admitsPluginAgent(
    pluginId: string,
    generation: string | undefined,
    composition?: PluginActivationComposition,
  ): boolean {
    try {
      const journal = this.options.journal?.();
      if (!journal) return false;
      const selected = journal.currentInstallation(pluginId);
      if (selected.state !== 'observed')
        return (
          selected.state === 'not-observed' &&
          generation === undefined &&
          resolveInstalledPluginRoot(this.pluginsDir, pluginId)?.kind ===
            'legacy'
        );
      if (generation !== selected.installation.incarnation) return false;
      if (
        !journal.admissionOpen(selected.installation) &&
        !pluginActivationCompositionPermit(composition, journal, pluginId)
      )
        return false;
      const root = resolvePluginMaterialization(
        this.pluginsDir,
        pluginId,
        selected.installation.materialization!,
      );
      return (
        root.dataScope === selected.installation.dataScope &&
        computePluginContentDigest(
          dirname(root.packageRoot),
          basename(root.packageRoot),
        ) === selected.installation.contentDigest
      );
    } catch {
      return false;
    }
  }

  loadPackage(
    pluginRoot: string,
    options: AgentPluginLoadOptions = {},
  ): LoadedAgentPlugin | null {
    const outcome = this.loadPackageResult(pluginRoot, options);
    return outcome.ok ? outcome.plugin : null;
  }

  /** Tagged result retains precise rejection reports for direct callers. */
  loadPackageResult(
    pluginRoot: string,
    options: AgentPluginLoadOptions = {},
  ): AgentPluginLoadOutcome {
    const reports: AgentPluginLoadReport[] = [];
    let root: string;
    try {
      root = realpathSync(resolve(pluginRoot));
      if (!statSync(root).isDirectory())
        throw new Error('plugin root is not a directory');
    } catch (error) {
      this.emit(reports, {
        level: 'error',
        code: 'manifest-invalid',
        pluginRoot: resolve(pluginRoot),
        message: `Plugin root is unavailable: ${String(error)}`,
      });
      return { ok: false, reports };
    }

    const manifestPath = join(root, 'plugin.json');
    let rawManifest: unknown = options.manifestDocument;
    if (rawManifest === undefined) {
      try {
        const resolvedManifest = realpathSync(manifestPath);
        if (!isInside(root, resolvedManifest)) {
          throw new Error('plugin.json resolves outside the plugin root');
        }
        const manifestText = readBoundedRegularFile(resolvedManifest);
        assertSafeContextText(manifestText, {
          profile: 'hidden-only',
          source: 'Agent Plugin manifest',
        });
        rawManifest = JSON.parse(manifestText);
      } catch (error) {
        this.emit(reports, {
          level: 'error',
          code: 'manifest-invalid',
          pluginRoot: root,
          component: 'plugin.json',
          message: `Plugin manifest is invalid: ${String(error)}`,
        });
        return { ok: false, reports };
      }
    }

    const parsed = this.parseManifest(root, rawManifest, reports);
    if (!parsed) return { ok: false, reports };
    const { manifest, stationExtension } = parsed;
    const stationExtensionRoot = this.discoverStationExtensionDirectory(
      root,
      reports,
    );
    let dataRoot: string;
    try {
      const installed = existsSync(this.pluginsDir)
        ? this.selectedRoot(manifest.name)
        : null;
      if (
        installed?.kind === 'incarnation' &&
        installed.packageRoot === root &&
        this.options.journal
      ) {
        const selected = this.options
          .journal()
          .currentInstallation(manifest.name);
        if (
          selected.state !== 'observed' ||
          !this.admitsPluginAgent(
            manifest.name,
            selected.installation.incarnation,
            this.options.composition,
          )
        )
          throw new Error('Selected Plugin content is not admitted');
      }
      dataRoot =
        installed?.kind === 'incarnation' && installed.packageRoot === root
          ? installed.dataRoot!
          : resolveAgentPluginDataDirectory(this.projectHomeDir, manifest.name)
              .directory;
    } catch (error) {
      this.emit(reports, {
        level: 'error',
        code: 'component-invalid',
        pluginRoot: root,
        component: 'PLUGIN_DATA',
        message: `Agent Plugin data is unavailable: ${String(error)}`,
      });
      return { ok: false, reports };
    }
    const skills = this.discoverSkills(root, reports);
    const tools = this.discoverMcp(
      root,
      dataRoot,
      manifest,
      reports,
      options.provisionData !== false,
    );
    if (existsSync(this.pluginsDir)) {
      const installed = this.selectedRoot(manifest.name);
      if (installed?.packageRoot === root) {
        for (const tool of tools)
          bindMCPDefinitionAdmission(tool, (purpose) => {
            if (installed.kind !== 'incarnation')
              throw new PluginIncarnationError('migration-required');
            const journal = this.options.journal?.();
            const current = journal?.currentInstallation(manifest.name);
            if (
              !journal ||
              current?.state !== 'observed' ||
              current.installation.materialization !== installed.generation ||
              current.installation.dataScope !== installed.dataScope ||
              this.selectedRoot(manifest.name)?.generation !==
                installed.generation
            )
              throw new MCPLocalCustodyError('stale');
            if (
              computePluginContentDigest(
                dirname(root),
                root.split(sep).at(-1)!,
              ) !== current.installation.contentDigest
            )
              throw new MCPLocalCustodyError('stale');
            const activationPermit = journal.admissionOpen(current.installation)
              ? undefined
              : pluginActivationCompositionPermit(
                  this.options.composition,
                  journal,
                  manifest.name,
                );
            const reserved = activationPermit
              ? journal.reserveActivation(activationPermit, purpose)
              : journal.reserve(current.installation, purpose);
            if (reserved.state !== 'reserved')
              throw new MCPLocalCustodyError('stale');
            const shared = reserved.claim;
            const isCurrent = () => {
              try {
                return (
                  shared.isCurrent() &&
                  this.selectedRoot(manifest.name)?.generation ===
                    installed.generation
                );
              } catch {
                return false;
              }
            };
            return {
              isCurrent,
              enter() {
                if (
                  !isCurrent() ||
                  shared.enterEffectBoundary().state !== 'applied'
                )
                  throw new MCPLocalCustodyError('stale');
              },
              settle(started) {
                const result = started
                  ? shared.observeLocalSettlement()
                  : shared.releaseNotStarted();
                if (result.state !== 'applied' && result.state !== 'stale')
                  throw new MCPLocalCustodyError('failed');
              },
            };
          });
      }
    }
    return {
      ok: true,
      plugin: {
        root,
        dataRoot,
        manifest,
        ...(stationExtension ? { stationExtension } : {}),
        ...(stationExtensionRoot ? { stationExtensionRoot } : {}),
        skills,
        tools,
        reports,
      },
    };
  }

  listInstalled(): LoadedAgentPlugin[] {
    const loaded: LoadedAgentPlugin[] = [];
    const names = new Set<string>();
    for (const {
      directoryName,
      root: candidateRoot,
    } of this.recognizedInstalledPackageRoots()) {
      const plugin = this.loadPackage(candidateRoot);
      if (!plugin) continue;
      if (plugin.manifest.name !== directoryName) {
        this.emit(plugin.reports, {
          level: 'error',
          code: 'manifest-invalid',
          pluginRoot: plugin.root,
          component: 'plugin.json',
          message: 'Installed plugin directory does not match manifest name',
        });
        continue;
      }
      if (names.has(plugin.manifest.name)) {
        this.emit(plugin.reports, {
          level: 'error',
          code: 'duplicate-plugin-name',
          pluginRoot: plugin.root,
          message: 'Another installed Agent Plugin has the same manifest name',
        });
        continue;
      }
      names.add(plugin.manifest.name);
      loaded.push(plugin);
    }
    return loaded;
  }

  async listSkillExperiences(): Promise<SkillExperienceInventoryV1> {
    const inventory: SkillExperienceInventoryV1 = {
      experiences: [],
      diagnostics: [],
    };
    const candidates = new Map(
      this.recognizedInstalledPackageRoots().map(({ directoryName, root }) => [
        directoryName,
        root,
      ]),
    );
    const selectedInstallations = this.options
      .journal?.()
      .selectedInstallations();
    if (selectedInstallations?.state === 'unavailable')
      throw new Error('Installed package inventory is unavailable.');
    if (selectedInstallations?.state === 'observed') {
      for (const installation of selectedInstallations.installations) {
        try {
          const root = this.selectedRoot(
            installation.pluginId,
            'legacy-scan-exclusion',
          );
          if (root) candidates.set(installation.pluginId, root.packageRoot);
          else
            inventory.diagnostics.push({
              pluginId: installation.pluginId,
              code: 'unavailable',
              message: 'The selected installed package source is unavailable.',
            });
        } catch (error) {
          inventory.diagnostics.push({
            pluginId: installation.pluginId,
            code: 'unavailable',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    for (const [directoryName, root] of candidates) {
      await withPluginContentLock(this.pluginsDir, directoryName, async () => {
        const reports: AgentPluginLoadReport[] = [];
        let declared = false;
        try {
          const raw: unknown = JSON.parse(
            readBoundedRegularFile(
              resolveContainedPath(root, join(root, 'plugin.json')),
            ),
          );
          if (isRecord(raw) && typeof raw.$schema !== 'string') {
            const selected = this.options
              .journal?.()
              .currentInstallation(directoryName);
            if (
              selected?.state === 'observed' &&
              (await computePluginContentDigestAsync(
                dirname(root),
                basename(root),
              )) !== selected.installation.contentDigest
            )
              inventory.diagnostics.push({
                pluginId: directoryName,
                code: 'unavailable',
                message:
                  'The selected installed package manifest changed from its admitted revision.',
              });
            return;
          }
          const parsed = this.parseManifest(root, raw, reports);
          if (!parsed?.stationExtension) {
            for (const report of reports.filter(
              (entry) =>
                entry.code === 'station-extension-invalid' ||
                entry.code === 'manifest-invalid',
            ))
              inventory.diagnostics.push({
                pluginId: directoryName,
                code: 'definition-invalid',
                message: report.message,
              });
            return;
          }
          const contributions = parsed.stationExtension.experiences ?? [];
          if (contributions.length === 0) return;
          declared = true;
          const journal = this.options.journal?.();
          const selected = journal?.currentInstallation(directoryName);
          const materialization =
            selected?.state === 'observed'
              ? selected.installation.materialization
              : undefined;
          if (
            parsed.manifest.name !== directoryName ||
            !parsed.manifest.version ||
            selected?.state !== 'observed' ||
            !materialization ||
            !selected.installation.dataScope ||
            !journal?.admissionOpen(selected.installation) ||
            this.selectedRoot(directoryName)?.packageRoot !== root
          ) {
            inventory.diagnostics.push({
              pluginId: directoryName,
              code: 'unavailable',
              message:
                'The installed package needs current activation before its experiences are available.',
            });
            return;
          }
          const installation = selected.installation;
          const contentDigest = await computePluginContentDigestAsync(
            dirname(root),
            basename(root),
          );
          if (!contentDigest || contentDigest !== installation.contentDigest) {
            inventory.diagnostics.push({
              pluginId: directoryName,
              code: 'unavailable',
              message:
                'Installed package bytes differ from the admitted revision; inspect and activate the package again.',
            });
            return;
          }
          const definitions = readValidatedSkillExperiences(
            root,
            parsed.manifest,
            parsed.stationExtension,
          );
          const current = journal.currentInstallation(directoryName);
          if (
            current.state !== 'observed' ||
            current.installation.incarnation !== installation.incarnation ||
            current.installation.materialization !==
              installation.materialization ||
            !journal.admissionOpen(current.installation) ||
            this.selectedRoot(directoryName)?.packageRoot !== root ||
            (await computePluginContentDigestAsync(
              dirname(root),
              basename(root),
            )) !== contentDigest
          ) {
            inventory.diagnostics.push({
              pluginId: directoryName,
              code: 'unavailable',
              message:
                'The installed package changed while its experiences were being read.',
            });
            return;
          }
          for (const definition of definitions) {
            const definitionDigest = createHash('sha256')
              .update(JSON.stringify(definition))
              .digest('hex');
            inventory.experiences.push({
              identity: {
                pluginId: directoryName,
                pluginVersion: parsed.manifest.version,
                experienceId: definition.id,
                incarnation: installation.incarnation,
                materialization,
                contentDigest,
                definitionDigest,
              },
              definition,
            });
          }
        } catch (error) {
          inventory.diagnostics.push({
            pluginId: directoryName,
            code: declared ? 'definition-invalid' : 'unavailable',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    }
    return inventory;
  }

  async withSkillExperience<T>(
    identity: SkillExperienceIdentityV1,
    effect: (
      definition: SkillExperienceDefinitionV1,
      entryContent: string,
    ) => Promise<T>,
    permission?: 'agents.invoke',
  ): Promise<T> {
    return withPluginContentLock(
      this.pluginsDir,
      identity.pluginId,
      async () => {
        const root = this.selectedRoot(identity.pluginId)?.packageRoot;
        const journal = this.options.journal?.();
        const current = journal?.currentInstallation(identity.pluginId);
        if (
          !root ||
          !journal ||
          current?.state !== 'observed' ||
          current.installation.incarnation !== identity.incarnation ||
          current.installation.materialization !== identity.materialization ||
          current.installation.contentDigest !== identity.contentDigest ||
          !journal.admissionOpen(current.installation) ||
          (await computePluginContentDigestAsync(
            dirname(root),
            basename(root),
          )) !== identity.contentDigest
        )
          throw new Error(
            'The selected Skill experience source is no longer available.',
          );
        const parsed = this.parseManifest(
          root,
          JSON.parse(
            readBoundedRegularFile(
              resolveContainedPath(root, join(root, 'plugin.json')),
            ),
          ),
          [],
        );
        if (
          !parsed?.stationExtension ||
          parsed.manifest.version !== identity.pluginVersion ||
          parsed.manifest.name !== identity.pluginId
        )
          throw new Error('The selected Skill experience package changed.');
        const definition = readValidatedSkillExperiences(
          root,
          parsed.manifest,
          parsed.stationExtension,
        ).find((value) => value.id === identity.experienceId);
        if (
          !definition ||
          createHash('sha256')
            .update(JSON.stringify(definition))
            .digest('hex') !== identity.definitionDigest
        )
          throw new Error('The selected Skill experience definition changed.');
        const entry =
          definition.skills.find(
            (skill) => skill.id === definition.entrySkillId,
          ) ??
          (definition.skills.length === 1 ? definition.skills[0] : undefined);
        if (!entry)
          throw new Error('This experience needs an explicit entry Skill.');
        const ordered: typeof definition.skills = [];
        const visited = new Set<string>();
        const collect = (skill: typeof entry) => {
          if (visited.has(skill.id)) return;
          visited.add(skill.id);
          for (const dependency of skill.dependsOn ?? []) {
            const source = definition.skills.find(
              (value) => value.id === dependency,
            );
            if (!source)
              throw new Error('A bundled dependency is unavailable.');
            collect(source);
          }
          ordered.push(skill);
        };
        collect(entry);
        const content =
          `Selected entry Skill: ${entry.name}. Package resource root (normal Agent/tool permissions still apply): ${root}.\n\n` +
          ordered
            .map(
              (skill) =>
                `Bundled Skill ${skill.name}:\n${readBoundedRegularFile(resolveContainedPath(root, join(root, skill.path)))}`,
            )
            .join('\n\n');
        if (Buffer.byteLength(content) > 128 * 1024)
          throw new Error(
            'The selected Skill and its bundled dependencies exceed the execution context bound.',
          );
        const reserved = journal.reserve(current.installation, 'app');
        if (reserved.state !== 'reserved')
          throw new Error('The Skill experience source is retiring.');
        let entered = false;
        try {
          if (
            !reserved.claim.isCurrent() ||
            this.selectedRoot(identity.pluginId)?.packageRoot !== root ||
            (await computePluginContentDigestAsync(
              dirname(root),
              basename(root),
            )) !== identity.contentDigest ||
            reserved.claim.enterEffectBoundary().state !== 'applied'
          )
            throw new Error(
              'The Skill experience source changed before dispatch.',
            );
          entered = true;
          const invoke = () => effect(definition, content);
          return await (permission
            ? withPluginPermissionInvocation(
                this.projectHomeDir,
                identity.pluginId,
                permission,
                invoke,
                {
                  pluginId: identity.pluginId,
                  generation: identity.incarnation,
                  digest: identity.contentDigest,
                  isCurrent: () => reserved.claim.isCurrent(),
                },
              )
            : invoke());
        } finally {
          if (entered) reserved.claim.observeLocalSettlement();
          else reserved.claim.releaseNotStarted();
        }
      },
    );
  }

  skillSources(
    composition?: PluginActivationComposition,
  ): CanonicalSkillSource[] {
    if (composition)
      return new AgentPluginLoader({
        ...this.options,
        composition,
      }).skillSources();
    const loadedByRoot = new Map(
      this.listInstalled().map((plugin) => [plugin.root, plugin] as const),
    );
    // Recognition owns exclusion independently of successful loading. A
    // fatally rejected package must not fall back into legacy recursive Skill
    // discovery, but it also must not contribute portable Skills.
    return this.recognizedInstalledPackageRoots().map(
      ({ directoryName, root }) => {
        const plugin = loadedByRoot.get(root);
        const journal = this.options.journal?.();
        const selectedAtCapture = journal?.currentInstallation(directoryName);
        return {
          root: join(root, 'skills'),
          isCurrent: () => {
            try {
              if (this.selectedRoot(directoryName)?.packageRoot !== root)
                return false;
              return (
                !journal ||
                (selectedAtCapture?.state === 'observed' &&
                  this.admitsPluginAgent(
                    directoryName,
                    selectedAtCapture.installation.incarnation,
                    this.options.composition,
                  ))
              );
            } catch {
              return false;
            }
          },
          ...(selectedAtCapture?.state === 'observed' &&
          selectedAtCapture.installation.materialization
            ? {
                packageRevision: {
                  incarnation: selectedAtCapture.installation.incarnation,
                  materialization:
                    selectedAtCapture.installation.materialization,
                  contentDigest: selectedAtCapture.installation.contentDigest,
                },
              }
            : {}),
          label: `agent-plugin:${directoryName}` as const,
          ...(plugin?.manifest.version
            ? { version: plugin.manifest.version }
            : {}),
          origin: 'plugin' as const,
          ...(plugin ? {} : { excludeOnly: true }),
          immediateOnly: true,
          validateAgentSkills: true,
          containmentRoot: root,
        };
      },
    );
  }

  private recognizedInstalledPackageRoots(): Array<{
    directoryName: string;
    root: string;
  }> {
    if (!existsSync(this.pluginsDir)) return [];
    const candidates = new Map<string, string>();
    const directories = [
      ...readdirSync(this.pluginsDir, { withFileTypes: true }),
      ...localManagedPluginAliases(this.pluginsDir).map((name) => ({
        name,
        isDirectory: () => false,
        isSymbolicLink: () => true,
      })),
    ];
    for (const entry of directories) {
      if (
        (!entry.isDirectory() && !entry.isSymbolicLink()) ||
        !isCanonicalPluginId(entry.name)
      )
        continue;
      try {
        const root = this.selectedRoot(entry.name, 'legacy-scan-exclusion');
        if (root && this.hasAgentPluginSchema(root.packageRoot))
          candidates.set(entry.name, root.packageRoot);
      } catch {
        /* Reported as unavailable by installed inventory. */
      }
    }
    const selected = this.options.journal?.().selectedInstallations();
    if (selected?.state === 'observed')
      for (const installation of selected.installations) {
        try {
          const root = this.selectedRoot(
            installation.pluginId,
            'legacy-scan-exclusion',
          );
          if (root && this.hasAgentPluginSchema(root.packageRoot))
            candidates.set(installation.pluginId, root.packageRoot);
        } catch {
          candidates.delete(installation.pluginId);
        }
      }
    return [...candidates]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([directoryName, root]) => ({ directoryName, root }));
  }

  loadIntegration(
    id: string,
    composition?: PluginActivationComposition,
  ): ToolDef | undefined {
    if (composition)
      return new AgentPluginLoader({
        ...this.options,
        composition,
      }).loadIntegration(id);
    for (const plugin of this.listInstalled()) {
      const found = plugin.tools.find((tool) => tool.id === id);
      if (found) return found;
    }
    return undefined;
  }

  listIntegrations(composition?: PluginActivationComposition): ToolMetadata[] {
    if (composition)
      return new AgentPluginLoader({
        ...this.options,
        composition,
      }).listIntegrations();
    return this.listInstalled().flatMap((plugin) =>
      plugin.tools.map((tool) => ({
        id: tool.id,
        kind: tool.kind,
        displayName: tool.displayName,
        transport: tool.transport,
        source: `agent-plugin:${plugin.manifest.name}`,
        enabled: true,
      })),
    );
  }

  private hasAgentPluginSchema(pluginRoot: string): boolean {
    try {
      const value = JSON.parse(
        readBoundedRegularFile(join(pluginRoot, 'plugin.json')),
      ) as Record<string, unknown>;
      return (
        typeof value?.$schema === 'string' &&
        value.$schema.startsWith('https://agent-plugins.org/schemas/')
      );
    } catch {
      return false;
    }
  }

  private parseManifest(
    root: string,
    value: unknown,
    reports: AgentPluginLoadReport[],
  ) {
    return parseAgentPluginManifest(
      value,
      (report) => this.emit(reports, { ...report, pluginRoot: root }),
      {
        manifest: this.validateManifest,
        stationExtension: this.validateStationExtension,
      },
    );
  }

  private discoverSkills(
    root: string,
    reports: AgentPluginLoadReport[],
  ): LoadedAgentPluginSkill[] {
    const skillsRoot = join(root, 'skills');
    if (!existsSync(skillsRoot)) return [];
    let resolvedSkillsRoot: string;
    try {
      resolvedSkillsRoot = realpathSync(skillsRoot);
      if (
        !isInside(root, resolvedSkillsRoot) ||
        !statSync(resolvedSkillsRoot).isDirectory()
      ) {
        throw new Error('skills does not resolve to a contained directory');
      }
    } catch (error) {
      this.emit(reports, {
        level: 'warning',
        code: 'component-invalid',
        pluginRoot: root,
        component: 'skills',
        message: `Skills component was disabled: ${String(error)}`,
      });
      return [];
    }

    let entries: Dirent[];
    try {
      entries = readdirSync(resolvedSkillsRoot, { withFileTypes: true }).sort(
        (a, b) => a.name.localeCompare(b.name),
      );
    } catch (error) {
      this.emit(reports, {
        level: 'warning',
        code: 'component-invalid',
        pluginRoot: root,
        component: 'skills',
        message: `Skills component was disabled: ${String(error)}`,
      });
      return [];
    }

    const skills: LoadedAgentPluginSkill[] = [];
    for (const entry of entries) {
      const directory = join(resolvedSkillsRoot, entry.name);
      try {
        if (!statSync(directory).isDirectory()) continue;
      } catch {
        continue;
      }
      const manifestPath = join(directory, 'SKILL.md');
      if (!existsSync(manifestPath)) continue;
      try {
        const resolvedDirectory = realpathSync(directory);
        const resolvedManifest = realpathSync(manifestPath);
        if (
          !isInside(root, resolvedDirectory) ||
          !isInside(root, resolvedManifest) ||
          !lstatSync(resolvedManifest).isFile()
        ) {
          throw new Error('skill resolves outside the plugin root');
        }
        const content = readBoundedRegularFile(resolvedManifest);
        const errors = validateSkillContent(content);
        if (errors.length) throw new Error(errors.join('; '));
        const properties = frontmatterToProperties(
          parseFrontmatter(content).metadata,
        );
        if (properties.name !== entry.name) {
          throw new Error(
            'skill name must match its immediate parent directory',
          );
        }
        skills.push({
          name: properties.name,
          directory: resolvedDirectory,
          manifestPath: resolvedManifest,
        });
      } catch (error) {
        this.emit(reports, {
          level: 'warning',
          code: 'skill-invalid',
          pluginRoot: root,
          component: `skills/${entry.name}/SKILL.md`,
          message: `Invalid skill was skipped: ${String(error)}`,
        });
      }
    }
    return skills;
  }

  private discoverStationExtensionDirectory(
    root: string,
    reports: AgentPluginLoadReport[],
  ): string | undefined {
    const extensionRoot = join(root, STATION_AGENT_PLUGIN_EXTENSION_ID);
    if (!existsSync(extensionRoot)) return undefined;
    try {
      const resolved = realpathSync(extensionRoot);
      if (!isInside(root, resolved) || !statSync(resolved).isDirectory()) {
        throw new Error('namespace path is not a contained directory');
      }
      return resolved;
    } catch (error) {
      this.emit(reports, {
        level: 'warning',
        code: 'station-extension-invalid',
        pluginRoot: root,
        component: STATION_AGENT_PLUGIN_EXTENSION_ID,
        message: `Station extension directory was ignored: ${String(error)}`,
      });
      return undefined;
    }
  }

  private discoverMcp(
    root: string,
    dataRoot: string,
    manifest: AgentPluginManifestV1,
    reports: AgentPluginLoadReport[],
    provisionData: boolean,
  ): ToolDef[] {
    const mcpPath = join(root, 'mcp.json');
    if (!existsSync(mcpPath)) return [];
    let value: unknown;
    try {
      const resolvedMcp = realpathSync(mcpPath);
      if (!isInside(root, resolvedMcp))
        throw new Error('mcp.json resolves outside the plugin root');
      value = JSON.parse(readBoundedRegularFile(resolvedMcp));
    } catch (error) {
      this.mcpError(
        root,
        reports,
        `MCP component is invalid: ${String(error)}`,
      );
      return [];
    }
    if (
      !isRecord(value) ||
      Object.keys(value).some(
        (key) => key !== '$schema' && key !== 'mcpServers',
      ) ||
      value.$schema !== AGENT_PLUGIN_MCP_SCHEMA_1_0 ||
      !isRecord(value.mcpServers)
    ) {
      this.mcpError(
        root,
        reports,
        'MCP component has invalid top-level fields or schema',
      );
      return [];
    }
    if (manifest.$schema !== AGENT_PLUGIN_MANIFEST_SCHEMA_1_0) {
      this.mcpError(
        root,
        reports,
        'MCP schema does not match plugin manifest schema',
      );
      return [];
    }

    const tools: ToolDef[] = [];
    for (const [serverName, server] of Object.entries(value.mcpServers).sort(
      ([a], [b]) => a.localeCompare(b),
    )) {
      if (!this.validateMcpServer(server)) {
        this.serverError(
          root,
          reports,
          serverName,
          'Server entry does not satisfy the closed MCP schema',
        );
        continue;
      }
      if (!isRecord(server)) continue;
      if (server.type === 'sse') {
        this.emit(reports, {
          level: 'warning',
          code: 'mcp-transport-unsupported',
          pluginRoot: root,
          component: `mcp.json#mcpServers.${serverName}`,
          message: 'SSE MCP transport is not supported; server was skipped',
        });
        continue;
      }
      try {
        const id = toolId(manifest.name, serverName);
        if (server.type === 'streamable-http') {
          if (typeof server.url !== 'string' || !safeRemoteUrl(server.url)) {
            throw new Error('remote URL must satisfy Agent Plugins URL rules');
          }
          if (
            server.headers !== undefined &&
            !validLiteralHeaders(server.headers)
          ) {
            throw new Error(
              'headers must be unique case-insensitive literal HTTP fields',
            );
          }
          tools.push({
            id,
            kind: 'mcp',
            enabled: true,
            displayName: `${serverName} (${manifest.name})`,
            transport: 'streamable-http',
            endpoint: server.url,
            ...(server.headers
              ? { headers: server.headers as Record<string, string> }
              : {}),
          });
          continue;
        }

        if (server.type !== 'stdio' || typeof server.command !== 'string') {
          throw new Error('unsupported MCP transport');
        }
        if (provisionData) {
          const installed = existsSync(this.pluginsDir)
            ? this.selectedRoot(manifest.name)
            : null;
          dataRoot =
            installed?.kind === 'incarnation' && installed.packageRoot === root
              ? installed.dataRoot!
              : resolveAgentPluginDataDirectory(
                  this.projectHomeDir,
                  manifest.name,
                  { provision: true },
                ).directory;
          accessSync(dataRoot, fsConstants.W_OK);
        }
        const resolvedData = provisionData
          ? realpathSync(dataRoot)
          : resolve(dataRoot);
        const resolvedRoot = realpathSync(root);
        let command = server.command;
        if (command.startsWith('./')) {
          command = resolveContainedPath(
            resolvedRoot,
            resolve(resolvedRoot, command),
          );
        } else if (
          command.includes('/') ||
          command.includes('\\') ||
          isAbsolute(command)
        ) {
          throw new Error(
            'stdio command must be one bare or plugin-relative token',
          );
        }
        const args = Array.isArray(server.args)
          ? server.args.map((arg) =>
              singlePassExpand(String(arg), resolvedRoot, resolvedData),
            )
          : undefined;
        const configuredEnv = isRecord(server.env)
          ? Object.fromEntries(
              Object.entries(server.env).map(([name, envValue]) => [
                name,
                singlePassExpand(String(envValue), resolvedRoot, resolvedData),
              ]),
            )
          : {};
        for (const name of Object.keys(configuredEnv)) {
          if (
            process.platform === 'win32' &&
            WINDOWS_RESERVED_ENV.has(name.toLowerCase())
          ) {
            delete configuredEnv[name];
          }
        }
        const env = {
          ...configuredEnv,
          PLUGIN_ROOT: resolvedRoot,
          PLUGIN_DATA: resolvedData,
        };
        let cwd = resolvedRoot;
        if (typeof server.cwd === 'string') {
          const expanded = singlePassExpand(
            server.cwd,
            resolvedRoot,
            resolvedData,
          );
          const containmentRoot = server.cwd.startsWith(PLUGIN_DATA_PLACEHOLDER)
            ? resolvedData
            : resolvedRoot;
          cwd =
            containmentRoot === resolvedData && !provisionData
              ? this.resolveUnprovisionedDataPath(resolvedData, expanded)
              : resolveContainedPath(containmentRoot, expanded);
        }
        tools.push({
          id,
          kind: 'mcp',
          enabled: true,
          displayName: `${serverName} (${manifest.name})`,
          transport: 'stdio',
          command,
          ...(args ? { args } : {}),
          env,
          cwd,
        });
      } catch (error) {
        this.serverError(root, reports, serverName, String(error));
      }
    }
    return tools;
  }

  private resolveUnprovisionedDataPath(
    root: string,
    candidate: string,
  ): string {
    const target = resolve(candidate);
    if (!isInside(root, target)) throw new Error('path escapes its root');
    return target;
  }

  private mcpError(
    pluginRoot: string,
    reports: AgentPluginLoadReport[],
    message: string,
  ): void {
    this.emit(reports, {
      level: 'warning',
      code: 'mcp-invalid',
      pluginRoot,
      component: 'mcp.json',
      message,
    });
  }

  private serverError(
    pluginRoot: string,
    reports: AgentPluginLoadReport[],
    serverName: string,
    message: string,
  ): void {
    this.emit(reports, {
      level: 'warning',
      code: 'mcp-server-invalid',
      pluginRoot,
      component: `mcp.json#mcpServers.${serverName}`,
      message: `Invalid MCP server was skipped: ${message}`,
    });
  }

  private emit(
    reports: AgentPluginLoadReport[],
    report: AgentPluginLoadReport,
  ): void {
    reports.push(report);
    this.reportSink?.(report);
  }
}
