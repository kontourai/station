/**
 * `POST /api/plugins/validate` — an authoring check for a plugin that is not
 * installed (#2323 S1).
 *
 * An agent writing a plugin needs to know whether Station will accept it
 * before a person is asked to install it. This route runs a SUBSET of the
 * install preview's checks — manifest read and format dispatch, the
 * prompt-file safety scan, contribution conflicts, Workspace Pane catalog
 * conflicts — and reports them as diagnostics an author can act on. It does
 * NOT resolve dependencies (that reaches registry providers) and does not
 * derive the consent basis; a manifest that declares dependencies gets a
 * `dependencies-not-checked` warning rather than a silent pass.
 *
 * Four properties matter, and each is structural rather than a convention:
 *
 * 1. **Local folders only.** The source must be an absolute path to a folder
 *    on this host. A git or other URL is refused before anything is fetched:
 *    the agent tool that calls this is auto-approved as read-only, and a
 *    clone would be network egress (with the user's SSH keys) on an agent's
 *    say-so. A person checks a git source with the install preview.
 * 2. **It cannot become the first half of an install.** `POST /install`
 *    takes the operator's decision about specific bytes: a content digest, a
 *    grant revision, the permission set. This response carries no digest, no
 *    grant or registry revision, and no installation revision, so nothing it
 *    returns can be echoed into `/install` as a decision nobody made (the
 *    reason `install_plugin` refuses: `station-control-platform-tools.ts`).
 * 3. **It writes nothing.** The folder is read in place: no staging copy,
 *    nothing under `<home>/plugins`. `plugin.json` must be a regular file
 *    (not a symlink, FIFO or device) and is read with a byte cap, so the
 *    route can neither echo a file the manifest points at nor block on one.
 * 4. **It never builds.** A build runs `npm install` and writes `dist/`
 *    inside the tree it builds, which is a side effect on the author's own
 *    folder nobody asked for. The response says so (`bundle.checked: false`)
 *    instead of implying the bundle was proved. It does check that the
 *    declared entrypoint resolves (after symlinks) to a file inside the
 *    package, because the install build fails on a missing one.
 *
 * It is also deliberately stricter than `/preview` in one place: an Agent
 * Plugins manifest whose `io.kontourai.station` extension fails its schema
 * still loads (portable skills and MCP servers survive), but Station
 * contributes none of its panes. `/preview` reports that as `valid: true`.
 * For an author, a pane that silently never appears is the defect, so it is
 * an error here.
 */
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type {
  ConflictInfo,
  PluginComponent,
  PluginManifest,
} from '@kontourai/station-contracts/plugin';
import {
  type AgentPluginManifestReport,
  parseAgentPluginManifest,
} from '@kontourai/station-shared/agent-plugin-manifest';
import type { Hono } from 'hono';
import { isContextSafetyError } from '../../services/orchestration/context-safety.js';
import { scanPluginPromptFileSafety } from '../../services/plugins/plugin-command-skill-source.js';
import {
  PluginManifestValidationError,
  parsePluginManifestDocumentWithFormat,
} from '../../services/plugins/plugin-manifest-loader.js';
import {
  getPermissionTier,
  requiredPermissionsForManifest,
} from '../../services/plugins/plugin-permissions.js';
import {
  detectPluginConflicts,
  detectWorkspacePaneCatalogConflicts,
} from '../../services/plugins/plugin-source.js';
import type { Logger } from '../../utils/logger.js';
import {
  errorMessage,
  getBody,
  pluginValidateSchema,
  validate,
} from '../schemas/schemas.js';

/** Far above any real manifest; low enough that a hostile file cannot stall the route. */
export const PLUGIN_VALIDATE_MANIFEST_MAX_BYTES = 1024 * 1024;

export interface PluginValidateDiagnostic {
  level: 'error' | 'warning';
  code: string;
  message: string;
  /** Where in the package the problem is, when the check knows. */
  component?: string;
  /** Context-safety findings, for a blocked manifest or prompt file. */
  findings?: unknown[];
}

export interface PluginValidateResult {
  /** True when no diagnostic is an error. */
  valid: boolean;
  source: string;
  format?: 'legacy' | 'agent-plugin-1.0';
  plugin?: {
    name: string;
    version: string;
    displayName?: string;
    description?: string;
  };
  diagnostics: PluginValidateDiagnostic[];
  components: PluginComponent[];
  conflicts: ConflictInfo[];
  /**
   * What an install will ask a person to approve. Informational: it is not a
   * consent basis, and `/install` refuses it without the digest of reviewed
   * bytes, which this route never computes.
   */
  permissions?: {
    required: string[];
    tiers: Array<{ permission: string; tier: string }>;
  };
  entrypoint?: { path: string; present: boolean };
  bundle: { checked: false; reason: string };
  note: string;
}

interface PluginValidateRouteDeps {
  agentsDir: string;
  logger: Logger;
  pluginsDir: string;
  projectHomeDir: string;
}

const BUNDLE_NOT_CHECKED =
  'Validation does not build. Station builds the bundle when a person installs the plugin; a build error is reported then.';

const VALIDATE_NOTE =
  'Validation only. Nothing was installed, copied, or built, and dependencies were not resolved. A person installs a plugin from Plugins → Install plugin (or `station plugin install <source>`) after reviewing its preview and permissions.';

const REMOTE_SOURCE_REFUSED =
  'validate checks local folders; to check a git source, a person can run the install preview (Plugins → Install plugin).';

export function registerPluginValidateRoutes(
  app: Hono,
  deps: PluginValidateRouteDeps,
): void {
  app.post('/validate', validate(pluginValidateSchema), async (c) => {
    const { source } = getBody(c) as { source: string };
    const result = await validatePluginSource(source, deps);
    return c.json(result);
  });
}

/**
 * A URL, an scp-style `user@host:path`, or anything else that names a
 * remote. Checked before the path test so the refusal says why.
 */
function looksRemote(source: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(source) ||
    /^[^/\\\s]+@[^/\\\s]+:/.test(source)
  );
}

type ManifestRead =
  | { ok: true; raw: string }
  | { ok: false; diagnostic: PluginValidateDiagnostic };

/**
 * Reads `plugin.json` only if it is a regular file, never following a
 * symlink, and never more than the cap. A symlink could point at any file
 * this user can read (and the loader would echo its fields back); a FIFO
 * would block the read forever; a device could stream without end.
 */
function readManifestBounded(dir: string): ManifestRead {
  const path = join(dir, 'plugin.json');
  const refuse = (code: string, message: string): ManifestRead => ({
    ok: false,
    diagnostic: { level: 'error', code, component: 'plugin.json', message },
  });
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(path);
  } catch {
    return refuse(
      'manifest-missing',
      'Not a valid plugin: plugin.json not found in the folder.',
    );
  }
  if (info.isSymbolicLink()) {
    return refuse(
      'manifest-not-regular-file',
      'plugin.json is a symlink. Station reads the manifest from the plugin folder itself; replace the link with the file.',
    );
  }
  if (!info.isFile()) {
    return refuse(
      'manifest-not-regular-file',
      'plugin.json is not a regular file.',
    );
  }
  if (info.size > PLUGIN_VALIDATE_MANIFEST_MAX_BYTES) {
    return refuse(
      'manifest-too-large',
      `plugin.json is larger than ${PLUGIN_VALIDATE_MANIFEST_MAX_BYTES} bytes.`,
    );
  }
  // Read through the descriptor and re-check what was opened, so a swap
  // between lstat and open cannot turn this into a read of something else,
  // and cap the read itself rather than trusting the size. The open itself
  // is non-blocking and refuses a symlink: a synchronous open of a FIFO
  // blocks the whole server thread, which no timeout above this can undo.
  // (Both flags are POSIX; on Windows they are absent and read as 0.)
  const fd = openSync(
    path,
    constants.O_RDONLY |
      (constants.O_NONBLOCK ?? 0) |
      (constants.O_NOFOLLOW ?? 0),
  );
  try {
    if (!fstatSync(fd).isFile()) {
      return refuse(
        'manifest-not-regular-file',
        'plugin.json is not a regular file.',
      );
    }
    const buffer = Buffer.alloc(PLUGIN_VALIDATE_MANIFEST_MAX_BYTES + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > PLUGIN_VALIDATE_MANIFEST_MAX_BYTES) {
        return refuse(
          'manifest-too-large',
          `plugin.json is larger than ${PLUGIN_VALIDATE_MANIFEST_MAX_BYTES} bytes.`,
        );
      }
    }
    return { ok: true, raw: buffer.subarray(0, length).toString('utf8') };
  } finally {
    closeSync(fd);
  }
}

export async function validatePluginSource(
  source: string,
  deps: PluginValidateRouteDeps,
): Promise<PluginValidateResult> {
  const diagnostics: PluginValidateDiagnostic[] = [];
  const base = {
    source,
    diagnostics,
    components: [] as PluginComponent[],
    conflicts: [] as ConflictInfo[],
    bundle: { checked: false as const, reason: BUNDLE_NOT_CHECKED },
    note: VALIDATE_NOTE,
  };
  const finish = (
    extra: Partial<PluginValidateResult> = {},
  ): PluginValidateResult => ({
    ...base,
    ...extra,
    valid: !diagnostics.some((entry) => entry.level === 'error'),
  });

  if (looksRemote(source)) {
    diagnostics.push({
      level: 'error',
      code: 'remote-source-refused',
      message: REMOTE_SOURCE_REFUSED,
    });
    return finish();
  }
  if (!isAbsolute(source)) {
    diagnostics.push({
      level: 'error',
      code: 'source-not-absolute',
      message:
        'Pass the absolute path of the plugin folder (the folder that contains plugin.json).',
    });
    return finish();
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(source).isDirectory();
  } catch {}
  if (!isDirectory) {
    diagnostics.push({
      level: 'error',
      code: 'source-unavailable',
      message: `Source not found or not a folder: ${source}`,
    });
    return finish();
  }

  try {
    const pluginDir = source;
    // Loader messages name the file they read; show the author a
    // package-relative path instead.
    const tidy = (message: string) =>
      message.replaceAll(pluginDir, '<plugin root>');

    const read = readManifestBounded(pluginDir);
    if (!read.ok) {
      diagnostics.push(read.diagnostic);
      return finish();
    }

    let loaded: ReturnType<typeof parsePluginManifestDocumentWithFormat>;
    try {
      loaded = parsePluginManifestDocumentWithFormat(
        read.raw,
        join(pluginDir, 'plugin.json'),
      );
    } catch (error) {
      // The loader throws only the first Agent Plugins report, and path
      // redaction can rewrite its text, so a text comparison cannot dedupe
      // it. When the parser's own reports carry an error, they are the same
      // failure with its location: use them instead of the thrown message.
      const reports = agentPluginReports(read.raw);
      diagnostics.push(
        ...(reports.some((report) => report.level === 'error')
          ? reports
          : [manifestErrorDiagnostic(error, tidy), ...reports]),
      );
      return finish();
    }
    const { manifest, format } = loaded;

    const reports =
      format === 'agent-plugin-1.0' ? agentPluginReports(read.raw) : [];
    if (loaded.stationExtension?.status === 'disabled') {
      // The loader's reason for a schema failure is generic; the parser's
      // report names the failing location. Fold both into one error.
      const schemaDetail = reports.find(
        (report) => report.code === 'station-extension-invalid',
      )?.message;
      diagnostics.push({
        level: 'error',
        code: 'station-extension-disabled',
        component: 'plugin.json#extensions.io.kontourai.station',
        message: `Station would disable this plugin's io.kontourai.station extension, so none of its panes, capabilities or permissions would take effect: ${tidy(loaded.stationExtension.reason ?? 'unknown reason')}${schemaDetail ? ` (${schemaDetail})` : ''}`,
      });
    }
    diagnostics.push(
      ...reports.filter(
        (report) => report.code !== 'station-extension-invalid',
      ),
    );

    const blocked = scanPluginPromptFileSafety(pluginDir, manifest.name);
    for (const file of blocked) {
      diagnostics.push({
        level: 'error',
        code: 'unsafe-prompt-file',
        component: tidy(file.file),
        message: `Prompt file '${tidy(file.file)}' contains content Station blocks from agent context; install would refuse this plugin.`,
        findings: file.findings,
      });
    }

    const conflicts = [
      ...detectPluginConflicts(
        manifest,
        deps.agentsDir,
        deps.pluginsDir,
        deps.logger,
      ),
      ...detectWorkspacePaneCatalogConflicts(manifest, deps.projectHomeDir),
    ];
    for (const conflict of conflicts) {
      diagnostics.push(
        conflict.type === 'pane'
          ? {
              level: 'error',
              code: 'pane-conflict',
              component: conflict.id,
              message: `Workspace Pane '${conflict.id}' is already declared by '${conflict.existingSource ?? 'another contributor'}'; install would refuse it. Choose a different pane id.`,
            }
          : {
              level: 'warning',
              code: `${conflict.type}-conflict`,
              component: conflict.id,
              message: `${conflict.type} '${conflict.id}' already exists (${conflict.existingSource ?? 'installed'}); the person installing will have to skip or replace it.`,
            },
      );
    }
    diagnostics.push(...paneAuthoringWarnings(manifest));
    if (manifest.dependencies?.length) {
      diagnostics.push({
        level: 'warning',
        code: 'dependencies-not-checked',
        component: 'plugin.json#dependencies',
        message: `This plugin declares dependencies (${manifest.dependencies.map((dependency) => dependency.id).join(', ')}). Validation does not resolve them; the install preview does, and refuses one it cannot find.`,
      });
    }

    const entrypoint = manifest.entrypoint
      ? checkEntrypoint(pluginDir, manifest.entrypoint)
      : undefined;
    if (entrypoint && !entrypoint.present) {
      diagnostics.push({
        level: 'error',
        code: 'entrypoint-missing',
        component: 'plugin.json#entrypoint',
        message: `Entrypoint '${entrypoint.path}' is not a file inside the plugin; the install build would fail.`,
      });
    }
    // Without an entrypoint the install builds nothing and serves whatever
    // `dist/bundle.js` the package already carries; with neither, a
    // plugin-component pane has no component to render.
    if (
      !manifest.entrypoint &&
      manifest.workspacePanes?.length &&
      !existsSync(join(pluginDir, 'dist', 'bundle.js'))
    ) {
      const componentPanes = manifest.workspacePanes.filter(
        (pane) => pane.renderer.kind === 'plugin-component',
      );
      if (componentPanes.length > 0) {
        diagnostics.push({
          level: 'error',
          code: 'entrypoint-required',
          component: 'plugin.json#entrypoint',
          message:
            'A plugin-component pane renders a component from the plugin bundle, so the manifest needs an entrypoint (for example "./src/index.tsx") that exports `components`.',
        });
      }
    }

    const required = [...requiredPermissionsForManifest(manifest)].sort();
    return finish({
      format,
      plugin: {
        name: manifest.name,
        version: manifest.version,
        ...(manifest.displayName ? { displayName: manifest.displayName } : {}),
        ...(manifest.description ? { description: manifest.description } : {}),
      },
      components: summarizeContributions(
        manifest,
        conflicts,
        deps.projectHomeDir,
      ),
      conflicts,
      permissions: {
        required,
        tiers: required.map((permission) => ({
          permission,
          tier: getPermissionTier(permission),
        })),
      },
      ...(entrypoint ? { entrypoint } : {}),
    });
  } catch (error) {
    diagnostics.push(
      isContextSafetyError(error)
        ? {
            level: 'error',
            code: 'unsafe-context',
            message: error.message,
            findings: error.findings,
          }
        : {
            level: 'error',
            code: 'validation-failed',
            message: `Station could not finish validating this plugin: ${errorMessage(error)}`,
          },
    );
    return finish();
  }
}

function manifestErrorDiagnostic(
  error: unknown,
  tidy: (message: string) => string,
): PluginValidateDiagnostic {
  if (isContextSafetyError(error)) {
    return {
      level: 'error',
      code: 'unsafe-manifest',
      component: 'plugin.json',
      message: tidy(error.message),
      findings: error.findings,
    };
  }
  if (error instanceof PluginManifestValidationError) {
    return {
      level: 'error',
      code: error.code,
      component: 'plugin.json',
      message: tidy(error.message),
    };
  }
  if (error instanceof SyntaxError) {
    return {
      level: 'error',
      code: 'manifest-not-json',
      component: 'plugin.json',
      message: `plugin.json is not valid JSON: ${error.message}`,
    };
  }
  return {
    level: 'error',
    code: 'invalid-manifest',
    component: 'plugin.json',
    message: tidy(errorMessage(error)),
  };
}

/**
 * The Agent Plugins parser's own reports. The loader keeps only the first
 * failure and turns a Station-extension schema failure into a generic
 * "disabled" reason; the reports carry the location, and warnings (unknown
 * root fields) the loader never surfaces at all.
 */
function agentPluginReports(raw: string): PluginValidateDiagnostic[] {
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return [];
  }
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    typeof (candidate as { $schema?: unknown }).$schema !== 'string' ||
    !(candidate as { $schema: string }).$schema.startsWith(
      'https://agent-plugins.org/schemas/',
    )
  ) {
    return [];
  }
  const reports: AgentPluginManifestReport[] = [];
  parseAgentPluginManifest(candidate, (report) => reports.push(report));
  return reports.map((report) => ({
    level: report.level,
    code: report.code,
    message: report.message,
    ...(report.component ? { component: report.component } : {}),
  }));
}

function checkEntrypoint(
  pluginDir: string,
  entrypoint: string,
): { path: string; present: boolean } {
  // Containment is decided on real paths, as the install build's
  // `assertRealPathInside` decides it: an entrypoint that is a symlink to a
  // file outside the package reads as present to a lexical check and then
  // fails the build.
  const root = realpathSync(pluginDir);
  const lexical = join(root, entrypoint);
  const lexicalInside = lexical.startsWith(`${root}${sep}`);
  const shown = lexicalInside
    ? relative(root, lexical).split(sep).join('/')
    : entrypoint;
  let target: string;
  try {
    target = realpathSync(lexical);
  } catch {
    return { path: shown, present: false };
  }
  const inside = target !== root && target.startsWith(`${root}${sep}`);
  let present = false;
  try {
    present = inside && statSync(target).isFile();
  } catch {}
  return { path: shown, present };
}

/**
 * Checks the install path does not make, for mistakes that surface only
 * when a person tries to place the pane.
 */
function paneAuthoringWarnings(
  manifest: PluginManifest,
): PluginValidateDiagnostic[] {
  const warnings: PluginValidateDiagnostic[] = [];
  const seen = new Map<string, string>();
  for (const pane of manifest.workspacePanes ?? []) {
    const previous = seen.get(pane.rendererId);
    if (previous !== undefined) {
      warnings.push({
        level: 'warning',
        code: 'duplicate-renderer-id',
        component: pane.id,
        message: `Workspace Pane '${pane.id}' reuses rendererId '${pane.rendererId}' from pane '${previous}'. Give each pane its own rendererId.`,
      });
    } else {
      seen.set(pane.rendererId, pane.id);
    }
  }
  return warnings;
}

/** The same contribution summary `/preview` shows, without its consent fields. */
function summarizeContributions(
  manifest: PluginManifest,
  conflicts: readonly ConflictInfo[],
  projectHomeDir: string,
): PluginComponent[] {
  const components: PluginComponent[] = [];
  const conflictFor = (type: ConflictInfo['type'], id: string) =>
    conflicts.find((entry) => entry.type === type && entry.id === id);
  for (const agent of manifest.agents ?? []) {
    components.push({
      type: 'agent',
      id: agent.slug,
      detail: agent.source,
      conflict: conflictFor('agent', agent.slug),
    });
  }
  if (manifest.layout) {
    components.push({
      type: 'layout',
      id: manifest.layout.slug,
      detail: manifest.layout.source,
      conflict: conflictFor('layout', manifest.layout.slug),
    });
  }
  for (const pane of manifest.workspacePanes ?? []) {
    components.push({
      type: 'pane',
      id: pane.id,
      detail: `${pane.renderer.kind}:${pane.rendererId}`,
      conflict: conflictFor('pane', pane.id),
      skippable: false,
    });
  }
  for (const provider of manifest.providers ?? []) {
    components.push({
      type: 'provider',
      id: provider.type,
      detail: provider.module,
    });
  }
  for (const toolId of manifest.integrations?.required ?? []) {
    const installed = existsSync(
      join(projectHomeDir, 'integrations', toolId, 'integration.json'),
    );
    components.push({
      type: 'tool',
      id: toolId,
      detail: installed ? 'already installed' : 'will install',
    });
  }
  return components;
}
