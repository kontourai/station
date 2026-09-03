import { createHash } from 'node:crypto';
import {
  accessSync,
  existsSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  AGENT_PLUGIN_MANIFEST_SCHEMA_1_0,
  AGENT_PLUGIN_MCP_SCHEMA_1_0,
  type AgentPluginManifestV1,
  STATION_AGENT_PLUGIN_EXTENSION_ID,
  type StationAgentPluginExtensionV1,
} from '@kontourai/station-contracts/agent-plugin';
import { isCanonicalPluginId } from '@kontourai/station-contracts/plugin';
import type { ToolDef, ToolMetadata } from '@kontourai/station-contracts/tool';
import {
  frontmatterToProperties,
  parseFrontmatter,
  validateSkillContent,
} from 'agent-skills-ts-sdk';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import { isReservedObjectKey } from '../../utils/reserved-object-keys.js';
import type { CanonicalSkillSource } from '../flow/flow-agents-skills-source.js';

const MAX_CONFIGURATION_BYTES = 2 * 1024 * 1024;
const CORE_MANIFEST_FIELDS = new Set([
  '$schema',
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'extensions',
]);
const RETIRED_STATION_ROOT_FIELDS = new Set(['layout', 'layouts']);
const WINDOWS_RESERVED_ENV = new Set(['plugin_root', 'plugin_data']);
const PLUGIN_DATA_PLACEHOLDER = '$' + '{PLUGIN_DATA}';
const HTTP_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export type AgentPluginLoadReportCode =
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

export interface LoadedAgentPluginSkill {
  name: string;
  directory: string;
  manifestPath: string;
}

export interface LoadedAgentPlugin {
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

export interface AgentPluginLoaderOptions {
  /** Station's runtime home, which owns installed packages and persistent data. */
  projectHomeDir: string;
  /** Injectable for tests and packaged distributions; schemas are never fetched. */
  schemaRoot?: string;
  report?: (report: AgentPluginLoadReport) => void;
}

export interface AgentPluginLoadOptions {
  /** False for staged install validation; persistent data is never created pre-consent. */
  provisionData?: boolean;
  /** Already-read manifest bytes at a caller-owned containment boundary. */
  manifestDocument?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return (
    rel === '' ||
    (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  );
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
  const target = resolve(candidate);
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
  private readonly pluginDataDir: string;
  private readonly reportSink?: (report: AgentPluginLoadReport) => void;
  private readonly validateManifest: ValidateFunction;
  private readonly validateMcpServer: ValidateFunction;
  private readonly validateStationExtension: ValidateFunction;

  constructor(options: AgentPluginLoaderOptions) {
    this.projectHomeDir = resolve(options.projectHomeDir);
    this.pluginsDir = join(this.projectHomeDir, 'plugins');
    this.pluginDataDir = join(this.projectHomeDir, 'agent-plugin-data');
    this.reportSink = options.report;
    const schemaRoot = resolve(
      options.schemaRoot ?? join(process.cwd(), 'schemas', 'agent-plugins'),
    );
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
    this.validateManifest = ajv.compile(manifestSchema);
    this.validateMcpServer = ajv.compile({
      $ref: `${AGENT_PLUGIN_MCP_SCHEMA_1_0}#/$defs/server`,
    });
    this.validateStationExtension = ajv.compile(stationSchema);
  }

  loadPackage(
    pluginRoot: string,
    options: AgentPluginLoadOptions = {},
  ): LoadedAgentPlugin | null {
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
      return null;
    }

    const manifestPath = join(root, 'plugin.json');
    let rawManifest: unknown = options.manifestDocument;
    if (rawManifest === undefined) {
      try {
        const resolvedManifest = realpathSync(manifestPath);
        if (!isInside(root, resolvedManifest)) {
          throw new Error('plugin.json resolves outside the plugin root');
        }
        rawManifest = JSON.parse(readBoundedRegularFile(resolvedManifest));
      } catch (error) {
        this.emit(reports, {
          level: 'error',
          code: 'manifest-invalid',
          pluginRoot: root,
          component: 'plugin.json',
          message: `Plugin manifest is invalid: ${String(error)}`,
        });
        return null;
      }
    }

    const parsed = this.parseManifest(root, rawManifest, reports);
    if (!parsed) return null;
    const { manifest, stationExtension } = parsed;
    const stationExtensionRoot = this.discoverStationExtensionDirectory(
      root,
      reports,
    );
    const dataRoot = join(this.pluginDataDir, manifest.name);
    const skills = this.discoverSkills(root, reports);
    const tools = this.discoverMcp(
      root,
      dataRoot,
      manifest,
      reports,
      options.provisionData !== false,
    );
    return {
      root,
      dataRoot,
      manifest,
      ...(stationExtension ? { stationExtension } : {}),
      ...(stationExtensionRoot ? { stationExtensionRoot } : {}),
      skills,
      tools,
      reports,
    };
  }

  listInstalled(): LoadedAgentPlugin[] {
    if (!existsSync(this.pluginsDir)) return [];
    const loaded: LoadedAgentPlugin[] = [];
    const names = new Set<string>();
    for (const entry of readdirSync(this.pluginsDir, {
      withFileTypes: true,
    }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || !isCanonicalPluginId(entry.name)) continue;
      const candidateRoot = join(this.pluginsDir, entry.name);
      if (!this.hasAgentPluginSchema(candidateRoot)) continue;
      const plugin = this.loadPackage(candidateRoot);
      if (!plugin) continue;
      if (plugin.manifest.name !== entry.name) {
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

  skillSources(): CanonicalSkillSource[] {
    return this.listInstalled().flatMap((plugin) =>
      plugin.skills.length
        ? [
            {
              root: join(plugin.root, 'skills'),
              label: `agent-plugin:${plugin.manifest.name}` as const,
              version: plugin.manifest.version,
              origin: 'plugin' as const,
              immediateOnly: true,
              validateAgentSkills: true,
              containmentRoot: plugin.root,
            },
          ]
        : [],
    );
  }

  loadIntegration(id: string): ToolDef | undefined {
    for (const plugin of this.listInstalled()) {
      const found = plugin.tools.find((tool) => tool.id === id);
      if (found) return found;
    }
    return undefined;
  }

  listIntegrations(): ToolMetadata[] {
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
  ): {
    manifest: AgentPluginManifestV1;
    stationExtension?: StationAgentPluginExtensionV1;
  } | null {
    if (!isRecord(value)) {
      this.manifestError(root, reports, 'Plugin manifest must be an object');
      return null;
    }
    if (value.$schema !== AGENT_PLUGIN_MANIFEST_SCHEMA_1_0) {
      this.manifestError(
        root,
        reports,
        'Plugin manifest has a missing or unsupported $schema',
      );
      return null;
    }
    for (const retired of RETIRED_STATION_ROOT_FIELDS) {
      if (Object.hasOwn(value, retired)) {
        this.manifestError(
          root,
          reports,
          `Plugin manifest uses retired Station root field '${retired}'`,
        );
        return null;
      }
    }

    const core: Record<string, unknown> = {};
    for (const [key, fieldValue] of Object.entries(value)) {
      if (!CORE_MANIFEST_FIELDS.has(key)) {
        this.emit(reports, {
          level: 'warning',
          code: 'unknown-manifest-field',
          pluginRoot: root,
          component: 'plugin.json',
          message: `Unknown plugin manifest field '${key}' was ignored`,
        });
      } else if (key !== 'extensions') {
        core[key] = fieldValue;
      }
    }
    if (!this.validateManifest(core)) {
      this.manifestError(
        root,
        reports,
        `Plugin manifest does not satisfy Agent Plugins 1.0: ${this.validateManifest.errors?.[0]?.instancePath || 'root'}`,
      );
      return null;
    }
    if (isReservedObjectKey(core.name as string)) {
      this.manifestError(
        root,
        reports,
        'Plugin manifest name is temporarily unsupported by Station object-key stores',
      );
      return null;
    }

    let stationExtension: StationAgentPluginExtensionV1 | undefined;
    if (value.extensions !== undefined && !isRecord(value.extensions)) {
      this.emit(reports, {
        level: 'warning',
        code: 'manifest-invalid',
        pluginRoot: root,
        component: 'plugin.json#extensions',
        message: 'Non-object extensions field was ignored',
      });
    } else if (isRecord(value.extensions)) {
      const station = value.extensions[STATION_AGENT_PLUGIN_EXTENSION_ID];
      if (station !== undefined) {
        if (!this.validateStationExtension(station)) {
          this.emit(reports, {
            level: 'warning',
            code: 'station-extension-invalid',
            pluginRoot: root,
            component: `plugin.json#extensions.${STATION_AGENT_PLUGIN_EXTENSION_ID}`,
            message: 'Invalid Station extension was disabled',
          });
        } else {
          stationExtension = station as StationAgentPluginExtensionV1;
        }
      }
    }

    return {
      // Extension namespaces are not portable manifest authority. The one
      // implemented namespace is returned separately only after validation;
      // all others stay deliberately opaque and unprojected.
      manifest: core as unknown as AgentPluginManifestV1,
      ...(stationExtension ? { stationExtension } : {}),
    };
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

    const skills: LoadedAgentPluginSkill[] = [];
    for (const entry of readdirSync(resolvedSkillsRoot, {
      withFileTypes: true,
    }).sort((a, b) => a.name.localeCompare(b.name))) {
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
          mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
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

  private manifestError(
    pluginRoot: string,
    reports: AgentPluginLoadReport[],
    message: string,
  ): void {
    this.emit(reports, {
      level: 'error',
      code: 'manifest-invalid',
      pluginRoot,
      component: 'plugin.json',
      message,
    });
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
