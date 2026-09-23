/**
 * `POST /api/plugins/validate` — an authoring check for a plugin that is not
 * installed (#2323 S1).
 *
 * An agent writing a plugin needs to know whether Station will accept it
 * before a person is asked to install it. This route answers with the same
 * checks the install preview runs (manifest read and format dispatch, the
 * prompt-file safety scan, contribution conflicts, Workspace Pane catalog
 * conflicts), reported as diagnostics an author can act on.
 *
 * Three properties matter, and each is structural rather than a convention:
 *
 * 1. **It cannot become the first half of an install.** `POST /install`
 *    takes the operator's decision about specific bytes: a content digest, a
 *    grant revision, the permission set. This response carries no digest, no
 *    grant or registry revision, and no installation revision, so nothing it
 *    returns can be echoed into `/install` as a decision nobody made (the
 *    reason `install_plugin` refuses: `station-control-platform-tools.ts`).
 * 2. **It writes nothing under the plugins directory.** The source is staged
 *    in a fresh directory under the OS temp root, never `<home>/plugins`, and
 *    that directory is removed on every exit path. `/preview` stages inside
 *    `<home>/plugins`; this route deliberately does not.
 * 3. **It never builds.** A build runs `npm install` and writes `dist/`
 *    inside the tree it builds. Doing that to the author's own folder is a
 *    side effect nobody asked for, and doing it to the staged copy needs the
 *    network. The response says so (`bundle.checked: false`) instead of
 *    implying the bundle was proved. It does check the declared entrypoint
 *    exists inside the package, because the install build fails on a
 *    missing one before esbuild runs.
 *
 * It is also deliberately stricter than `/preview` in one place: an Agent
 * Plugins manifest whose `io.kontourai.station` extension fails its schema
 * still loads (portable skills and MCP servers survive), but Station
 * contributes none of its panes. `/preview` reports that as `valid: true`.
 * For an author, a pane that silently never appears is the defect, so it is
 * an error here.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
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
  readPluginManifestFileWithFormat,
} from '../../services/plugins/plugin-manifest-loader.js';
import {
  getPermissionTier,
  requiredPermissionsForManifest,
} from '../../services/plugins/plugin-permissions.js';
import {
  detectPluginConflicts,
  detectWorkspacePaneCatalogConflicts,
  fetchPluginSource,
} from '../../services/plugins/plugin-source.js';
import type { Logger } from '../../utils/logger.js';
import {
  errorMessage,
  getBody,
  pluginValidateSchema,
  validate,
} from '../schemas/schemas.js';

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
  /** Test seam: where staging directories are created. Defaults to the OS temp root. */
  stagingRoot?: () => string;
}

const BUNDLE_NOT_CHECKED =
  'Validation does not build. Station builds the bundle when a person installs the plugin; a build error is reported then.';

const VALIDATE_NOTE =
  'Validation only. Nothing was installed, staged under Station, or built. A person installs a plugin from Plugins → Install plugin (or `station plugin install <source>`) after reviewing its preview and permissions.';

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

  // Outside `pluginsDir` by construction: a fresh private directory under
  // the OS temp root. `fetchPluginSource` names its own randomised child
  // inside whatever root it is handed.
  const stagingRoot = await mkdtemp(
    join(deps.stagingRoot?.() ?? tmpdir(), 'station-plugin-validate-'),
  );
  try {
    const fetched = await fetchPluginSource(source, stagingRoot, deps.logger);
    if ('error' in fetched) {
      diagnostics.push({
        level: 'error',
        code: 'source-unavailable',
        message: fetched.error,
      });
      return finish();
    }
    const stagedDir = fetched.tempDir;
    // Loader messages name the file they read, which is the staged copy.
    // Rewrite that to a package-relative path so the author sees their own
    // layout rather than a temp directory.
    const tidy = (message: string) =>
      message.replaceAll(stagedDir, '<plugin root>');

    let loaded: Awaited<ReturnType<typeof readPluginManifestFileWithFormat>>;
    try {
      loaded = await readPluginManifestFileWithFormat(
        join(stagedDir, 'plugin.json'),
      );
    } catch (error) {
      const thrown = manifestErrorDiagnostic(error, tidy);
      diagnostics.push(
        thrown,
        // The loader throws only the first report; keep the rest (and the
        // warnings) without repeating the one it already carried.
        ...agentPluginReports(stagedDir).filter(
          (report) => !thrown.message.includes(report.message),
        ),
      );
      return finish();
    }
    const { manifest, format } = loaded;

    const reports =
      format === 'agent-plugin-1.0' ? agentPluginReports(stagedDir) : [];
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

    const blocked = scanPluginPromptFileSafety(stagedDir, manifest.name);
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

    const entrypoint = manifest.entrypoint
      ? checkEntrypoint(stagedDir, manifest.entrypoint)
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
      !existsSync(join(stagedDir, 'dist', 'bundle.js'))
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
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
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
function agentPluginReports(stagedDir: string): PluginValidateDiagnostic[] {
  let candidate: unknown;
  try {
    candidate = JSON.parse(
      readFileSync(join(stagedDir, 'plugin.json'), 'utf8'),
    );
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
  stagedDir: string,
  entrypoint: string,
): { path: string; present: boolean } {
  const root = resolve(stagedDir);
  const target = resolve(root, entrypoint);
  const inside = target !== root && target.startsWith(`${root}${sep}`);
  const present = inside && existsSync(target) && statSync(target).isFile();
  return {
    path: inside ? relative(root, target).split(sep).join('/') : entrypoint,
    present,
  };
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
