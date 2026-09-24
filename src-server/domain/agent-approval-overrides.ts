/**
 * #2436 (owner decision): who set a plugin-contributed Agent's default
 * approval posture.
 *
 * A plugin's `agent.json` is copied into `<home>/agents/<slug>/` at install
 * and re-copied, whole directory, on every update. So two things cannot live
 * there: a value the plugin must not be able to forge (the plugin ships the
 * directory), and an operator choice that must survive an update (the
 * directory is replaced). Both are answered by keeping the operator's choice
 * OUTSIDE the plugin-owned directory, in this Station-owned file at the home
 * root, which no plugin install or update writes:
 *
 *   <home>/agent-approval-overrides.json
 *   { "version": 1, "agents": { "<slug>": { "plugin": "<name>", "approvalMode": "never" } } }
 *
 * The only writer is `AgentService.updateAgent`, behind the Agent route's
 * full-access gate (operator in person, or `approval:full-access`). An entry
 * is honoured only while the Agent is still owned by the SAME plugin it was
 * set for, so another plugin later contributing that slug does not inherit
 * it. The plugin's own declared value stays in `agent.json`, and its `never`
 * is never applied (a plugin installs at the operate tier).
 *
 * Effective default of a plugin-owned Agent: the operator's override if one
 * is recorded for this plugin, else the plugin's declared value unless it is
 * full access. Agents that are not plugin-owned are written only through the
 * gated routes, so their `agent.json` value is taken as is.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type ApprovalMode,
  isApprovalMode,
} from '@kontourai/station-contracts/provider';
import { pluginAgentOwner } from './plugin-agent-ownership.js';

const OVERRIDES_FILE = 'agent-approval-overrides.json';

interface OverrideEntry {
  plugin: string;
  approvalMode: ApprovalMode;
}

interface OverridesDocument {
  version: 1;
  agents: Record<string, OverrideEntry>;
}

function overridesPath(projectHomeDir: string): string {
  return join(projectHomeDir, OVERRIDES_FILE);
}

function readOverrides(projectHomeDir: string): OverridesDocument {
  const path = overridesPath(projectHomeDir);
  if (!existsSync(path)) return { version: 1, agents: {} };
  // An unreadable or corrupt file is an error, not "no override": a caller
  // that treated it as absent could fall back to a looser posture than the
  // operator chose. It propagates and fails the start.
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as OverridesDocument;
  const agents: Record<string, OverrideEntry> = {};
  for (const [slug, entry] of Object.entries(parsed?.agents ?? {})) {
    if (
      entry &&
      typeof entry.plugin === 'string' &&
      isApprovalMode(entry.approvalMode)
    )
      agents[slug] = { plugin: entry.plugin, approvalMode: entry.approvalMode };
  }
  return { version: 1, agents };
}

/** The plugin that owns this Agent's directory, or `null`. */
export function agentPluginOwner(
  projectHomeDir: string,
  slug: string,
): string | null {
  return pluginAgentOwner(join(projectHomeDir, 'agents', slug));
}

/**
 * The effective default of a plugin-owned Agent owned by `plugin`, given the
 * value its own `agent.json` declares.
 */
export function effectivePluginAgentApprovalMode(
  projectHomeDir: string,
  slug: string,
  plugin: string,
  declared: unknown,
): ApprovalMode | undefined {
  const override = readOverrides(projectHomeDir).agents[slug];
  if (override && override.plugin === plugin) return override.approvalMode;
  return isApprovalMode(declared) && declared !== 'never'
    ? declared
    : undefined;
}

/**
 * `spec` with `execution.approvalMode` replaced by its effective value when
 * the Agent is plugin-owned. The read seam every consumer goes through
 * (`loadAgentConfig`, `capturePluginAgentInvocation`), so the chip, the
 * editor, the write gate and the session start all see one value.
 */
export function withEffectiveAgentApprovalMode<
  T extends { execution?: { approvalMode?: ApprovalMode } },
>(projectHomeDir: string, slug: string, spec: T): T {
  const plugin = agentPluginOwner(projectHomeDir, slug);
  if (!plugin) return spec;
  const effective = effectivePluginAgentApprovalMode(
    projectHomeDir,
    slug,
    plugin,
    spec.execution?.approvalMode,
  );
  const { approvalMode: _declared, ...execution } = spec.execution ?? {};
  return {
    ...spec,
    ...(spec.execution || effective
      ? {
          execution: {
            ...execution,
            ...(effective ? { approvalMode: effective } : {}),
          },
        }
      : {}),
  };
}

/**
 * Record the operator's choice for a plugin-owned Agent. The caller has
 * passed the full-access gate and holds the Agent identity lock.
 * `undefined` removes the override, so the plugin's declared value (never
 * full access) applies again.
 */
export function writeAgentApprovalOverride(
  projectHomeDir: string,
  slug: string,
  plugin: string,
  approvalMode: ApprovalMode | undefined,
): void {
  const document = readOverrides(projectHomeDir);
  if (approvalMode === undefined) delete document.agents[slug];
  else document.agents[slug] = { plugin, approvalMode };
  const path = overridesPath(projectHomeDir);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify(document, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  renameSync(temporary, path);
}

/**
 * The default approval posture a plugin-owned Agent's own `agent.json`
 * declares, as stored (no override applied). Writers keep it untouched: it
 * is the plugin's, and a plugin update replaces it.
 */
export function storedAgentApprovalMode(
  projectHomeDir: string,
  slug: string,
): ApprovalMode | undefined {
  const path = join(projectHomeDir, 'agents', slug, 'agent.json');
  const declared = (
    JSON.parse(readFileSync(path, 'utf-8')) as {
      execution?: { approvalMode?: unknown };
    }
  ).execution?.approvalMode;
  return isApprovalMode(declared) ? declared : undefined;
}
