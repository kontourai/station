/**
 * Phase 4 portability helpers.
 *
 * Ownership boundary:
 * - canonical Station config remains the source of truth
 * - portability models are derived projections only
 */

import type {
  AgentsMdPortabilityDocument,
  AppConfig,
  ExportableAppConfig,
  GuidanceAgentExport,
  GuidanceWorkspaceExport,
  NormalizedMcpConfig,
  PortabilityImportLedgerEntry,
  PortabilityLoss,
  ToolDef,
} from '@kontourai/station-contracts';
import { isSafeToolServerId } from '@kontourai/station-contracts/tool';

const APP_CONFIG_GUIDANCE_KEYS = [
  'systemPrompt',
  'templateVariables',
  'approvalGuardian',
] as const satisfies ReadonlyArray<keyof ExportableAppConfig>;

const STATION_RENDERED_START = '<!-- STATION:RENDERED:START -->';
const STATION_RENDERED_END = '<!-- STATION:RENDERED:END -->';
const STATION_EXPORT_START = '<!-- STATION:EXPORT:START -->';
const STATION_EXPORT_END = '<!-- STATION:EXPORT:END -->';
const STATION_JSON_FENCE = '```json';
const STATION_JSON_END = '```';

export interface BuildAgentsMdDocumentInput {
  appConfig: AppConfig;
  agents: GuidanceAgentExport[];
  integrations: ToolDef[];
  generatedAt?: string;
}

export interface ParseAgentsMdResult {
  document: AgentsMdPortabilityDocument;
  unmatchedProse: string | null;
  warnings: PortabilityLoss[];
}

export interface ImportApplicationPlan {
  appConfig: ExportableAppConfig;
  agents: GuidanceAgentExport[];
  integrations: ToolDef[];
  ledgerEntry: PortabilityImportLedgerEntry;
}

export interface ClaudeDesktopConfig {
  mcpServers: Record<
    string,
    {
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      requiredEnvNames?: string[];
      url?: string;
    }
  >;
}

export interface ParseClaudeDesktopConfigResult {
  integrations: ToolDef[];
  losses: PortabilityLoss[];
}

export function buildGuidanceWorkspace(
  appConfig: AppConfig,
): GuidanceWorkspaceExport {
  const workspace: GuidanceWorkspaceExport = {};
  for (const key of APP_CONFIG_GUIDANCE_KEYS) {
    if (key === 'systemPrompt' && appConfig.systemPrompt !== undefined) {
      workspace.systemPrompt = structuredClone(appConfig.systemPrompt);
    }
    if (
      key === 'templateVariables' &&
      appConfig.templateVariables !== undefined
    ) {
      workspace.templateVariables = structuredClone(
        appConfig.templateVariables,
      );
    }
    if (
      key === 'approvalGuardian' &&
      appConfig.approvalGuardian !== undefined
    ) {
      workspace.approvalGuardian = structuredClone(appConfig.approvalGuardian);
    }
  }
  return workspace;
}

export function collectGuidanceLosses(appConfig: AppConfig): PortabilityLoss[] {
  return Object.entries(appConfig)
    .filter(([key, value]) => {
      if (value === undefined) return false;
      return !APP_CONFIG_GUIDANCE_KEYS.includes(
        key as (typeof APP_CONFIG_GUIDANCE_KEYS)[number],
      );
    })
    .map(([key]) => ({
      code: 'omitted-field' as const,
      scope: 'app-config' as const,
      path: key,
      message: `AGENTS.md export omits app config field '${key}' because it is outside the Phase 4a guidance projection.`,
      severity: 'warning' as const,
    }));
}

export function normalizeMcpToolDef(def: ToolDef): {
  normalized: NormalizedMcpConfig | null;
  losses: PortabilityLoss[];
} {
  if (def.kind !== 'mcp') {
    return {
      normalized: null,
      losses: [
        {
          code: 'unsupported-kind',
          scope: 'integration',
          path: def.id,
          message: `Integration '${def.id}' is not MCP-based and cannot be exported in the AGENTS.md portability foundation.`,
          severity: 'warning',
        },
      ],
    };
  }

  const losses: PortabilityLoss[] = [];
  const transport = def.transport ?? (def.command ? 'stdio' : undefined);

  if (!transport || !['stdio', 'sse', 'streamable-http'].includes(transport)) {
    return {
      normalized: null,
      losses: [
        {
          code: 'unsupported-transport',
          scope: 'integration',
          path: `${def.id}.transport`,
          message: `Integration '${def.id}' uses unsupported transport '${def.transport ?? 'unknown'}' for portability export.`,
          severity: 'warning',
        },
      ],
    };
  }

  if (def.permissions || def.builtinPolicy || def.healthCheck) {
    losses.push({
      code: 'unsupported-config',
      scope: 'integration',
      path: def.id,
      message: `Integration '${def.id}' includes runtime-only settings that are omitted from the portable MCP projection.`,
      severity: 'warning',
    });
  }

  if (def.icon) {
    losses.push({
      code: 'omitted-field',
      scope: 'integration',
      path: `${def.id}.icon`,
      message: `Integration '${def.id}' declares a manifest icon that is omitted from the AGENTS.md export (the export format is unchanged this slice).`,
      severity: 'warning',
    });
  }

  const normalizedTransport = transport as NormalizedMcpConfig['transport'];
  const requiredEnvNames = [
    ...new Set([
      ...(def.requiredEnvNames ?? []),
      ...Object.keys(def.env ?? {}),
      ...(def.storedEnvNames ?? []),
      ...Object.keys(def.secretEnvRefs ?? {}),
    ]),
  ].sort();

  return {
    normalized: {
      id: def.id,
      displayName: def.displayName,
      description: def.description,
      transport: normalizedTransport,
      command: def.command,
      args: def.args ? [...def.args] : undefined,
      endpoint: def.endpoint,
      // A binding has no portable authority. Ordinary legacy env is retained
      // only when the caller explicitly chose its existing include-secrets
      // export path; a binding-backed overlap is always reduced to a hint.
      env: hasSecretEnvRefs(def)
        ? undefined
        : def.env
          ? { ...def.env }
          : undefined,
      requiredEnvNames: requiredEnvNames.length ? requiredEnvNames : undefined,
      exposedTools: def.exposedTools ? [...def.exposedTools] : undefined,
      timeouts: def.timeouts ? { ...def.timeouts } : undefined,
    },
    losses,
  };
}

function hasSecretEnvRefs(def: ToolDef): boolean {
  return Boolean(def.secretEnvRefs && Object.keys(def.secretEnvRefs).length);
}

export function denormalizeMcpConfig(normalized: NormalizedMcpConfig): ToolDef {
  return {
    id: normalized.id,
    kind: 'mcp',
    displayName: normalized.displayName,
    description: normalized.description,
    transport: normalized.transport,
    command: normalized.command,
    args: normalized.args ? [...normalized.args] : undefined,
    endpoint: normalized.endpoint,
    env: normalized.env ? { ...normalized.env } : undefined,
    requiredEnvNames: normalized.requiredEnvNames
      ? [...normalized.requiredEnvNames]
      : undefined,
    exposedTools: normalized.exposedTools
      ? [...normalized.exposedTools]
      : undefined,
    timeouts: normalized.timeouts ? { ...normalized.timeouts } : undefined,
  };
}

export function buildAgentsMdDocument(
  input: BuildAgentsMdDocumentInput,
): AgentsMdPortabilityDocument {
  const losses = collectGuidanceLosses(input.appConfig);
  const integrations: NormalizedMcpConfig[] = [];

  for (const def of input.integrations) {
    const result = normalizeMcpToolDef(def);
    losses.push(...result.losses);
    if (result.normalized) integrations.push(result.normalized);
  }

  return {
    kind: 'station-agents-md',
    version: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    guidance: {
      workspace: buildGuidanceWorkspace(input.appConfig),
      agents: input.agents.map((agent) => ({
        slug: agent.slug,
        spec: structuredClone(agent.spec),
      })),
      integrations,
    },
    losses,
  };
}

export function serializeAgentsMd(
  document: AgentsMdPortabilityDocument,
): string {
  const payload = JSON.stringify(document, null, 2);
  const lines = [
    STATION_RENDERED_START,
    '',
    '# AGENTS.md',
    '',
    'Generated by Station portability export.',
    '',
    '',
    '## Workspace Guidance',
    '',
    renderWorkspaceGuidance(document.guidance.workspace),
    '',
    '## Managed Agents',
    '',
    renderAgentGuidance(document.guidance.agents),
    '',
    '## MCP Tool Expectations',
    '',
    renderIntegrations(document.guidance.integrations),
    '',
    '## Loss Report',
    '',
    renderLosses(document.losses),
    '',
    STATION_RENDERED_END,
    '',
    STATION_EXPORT_START,
    STATION_JSON_FENCE,
    payload,
    STATION_JSON_END,
    STATION_EXPORT_END,
    '',
  ];

  return lines.join('\n');
}

export function parseAgentsMd(text: string): ParseAgentsMdResult {
  const exportStart = text.indexOf(STATION_EXPORT_START);
  const afterExportStart =
    exportStart === -1 ? -1 : exportStart + STATION_EXPORT_START.length;
  const jsonFenceStart =
    afterExportStart === -1
      ? -1
      : text.indexOf(STATION_JSON_FENCE, afterExportStart);
  const afterJsonFence =
    jsonFenceStart === -1 ? -1 : jsonFenceStart + STATION_JSON_FENCE.length;
  let jsonEnd = -1;
  let exportEnd = -1;

  // A payload can legitimately contain ``` inside a JSON string. Scan the
  // export body once, retaining the latest fence and whether only whitespace
  // followed it. At each terminator this is exactly the old grammar's
  // candidate check, without re-searching a shrinking suffix for every fence.
  if (afterJsonFence !== -1) {
    let cursor = afterJsonFence;
    let latestFence = -1;
    let onlyWhitespaceAfterFence = false;

    while (cursor < text.length) {
      const nextExportEnd = text.indexOf(STATION_EXPORT_END, cursor);
      const scanEnd = nextExportEnd === -1 ? text.length : nextExportEnd;

      while (cursor < scanEnd) {
        if (text.startsWith(STATION_JSON_END, cursor)) {
          latestFence = cursor;
          onlyWhitespaceAfterFence = true;
          cursor += STATION_JSON_END.length;
          continue;
        }
        if (latestFence !== -1 && !/\s/.test(text[cursor]!)) {
          onlyWhitespaceAfterFence = false;
        }
        cursor += 1;
      }

      if (nextExportEnd === -1) break;
      if (latestFence !== -1 && onlyWhitespaceAfterFence) {
        jsonEnd = latestFence;
        exportEnd = nextExportEnd;
        break;
      }
      cursor = nextExportEnd + STATION_EXPORT_END.length;
    }
  }

  if (
    exportStart === -1 ||
    jsonFenceStart === -1 ||
    text.slice(afterExportStart, jsonFenceStart).trim().length > 0 ||
    jsonEnd === -1 ||
    exportEnd === -1
  ) {
    throw new Error(
      'No Station export block found in AGENTS.md. Phase 4a import currently supports Station-exported AGENTS.md files only.',
    );
  }

  const document = JSON.parse(
    text.slice(jsonFenceStart + STATION_JSON_FENCE.length, jsonEnd).trim(),
  ) as AgentsMdPortabilityDocument;
  for (const integration of document.guidance?.integrations ?? []) {
    if (Object.hasOwn(integration as object, 'secretEnvRefs')) {
      throw new Error('Portable imports cannot contain secretEnvRefs.');
    }
  }
  const withoutExportBlock =
    text.slice(0, exportStart) +
    text.slice(exportEnd + STATION_EXPORT_END.length);
  const renderedStart = withoutExportBlock.indexOf(STATION_RENDERED_START);
  const renderedEnd =
    renderedStart === -1
      ? -1
      : withoutExportBlock.indexOf(
          STATION_RENDERED_END,
          renderedStart + STATION_RENDERED_START.length,
        );
  const unmatchedProse =
    renderedStart === -1 || renderedEnd === -1
      ? withoutExportBlock.trim()
      : (
          withoutExportBlock.slice(0, renderedStart) +
          withoutExportBlock.slice(renderedEnd + STATION_RENDERED_END.length)
        ).trim();
  const warnings = [...document.losses];

  if (unmatchedProse) {
    warnings.push({
      code: 'ambiguous-prose',
      scope: 'document',
      path: 'AGENTS.md',
      message:
        'AGENTS.md contains prose outside the structured Station export block. It will be preserved as imported notes instead of being treated as canonical config.',
      severity: 'warning',
    });
  }

  return {
    document,
    unmatchedProse: unmatchedProse || null,
    warnings,
  };
}

export function buildAgentsMdImportPlan(input: {
  sourcePath: string;
  parsed: ParseAgentsMdResult;
  importedAt?: string;
  notesPath?: string;
}): ImportApplicationPlan {
  const importedAt = input.importedAt ?? new Date().toISOString();

  return {
    appConfig: structuredClone(input.parsed.document.guidance.workspace),
    agents: input.parsed.document.guidance.agents.map((agent) => ({
      slug: agent.slug,
      spec: structuredClone(agent.spec),
    })),
    integrations:
      input.parsed.document.guidance.integrations.map(denormalizeMcpConfig),
    ledgerEntry: {
      id: createLedgerId(importedAt),
      sourceFormat: 'agents-md',
      importedAt,
      sourcePath: input.sourcePath,
      degradedFields: input.parsed.warnings,
      notesPath: input.notesPath,
      applied: {
        appConfigUpdated:
          Object.keys(input.parsed.document.guidance.workspace).length > 0,
        agentSlugs: input.parsed.document.guidance.agents.map(
          (agent) => agent.slug,
        ),
        integrationIds: input.parsed.document.guidance.integrations.map(
          (integration) => integration.id,
        ),
      },
    },
  };
}

export function buildClaudeDesktopConfig(input: { integrations: ToolDef[] }): {
  config: ClaudeDesktopConfig;
  losses: PortabilityLoss[];
} {
  const losses: PortabilityLoss[] = [];
  const mcpServers: ClaudeDesktopConfig['mcpServers'] = {};

  for (const integration of input.integrations) {
    const result = normalizeMcpToolDef(integration);
    losses.push(...result.losses);
    if (!result.normalized) {
      continue;
    }

    if (result.normalized.transport === 'stdio') {
      mcpServers[result.normalized.id] = {
        command: result.normalized.command,
        args: result.normalized.args,
        env: result.normalized.env,
        requiredEnvNames: result.normalized.requiredEnvNames,
      };
      continue;
    }

    if (
      result.normalized.transport === 'streamable-http' ||
      result.normalized.transport === 'sse'
    ) {
      mcpServers[result.normalized.id] = {
        url: result.normalized.endpoint,
      };
    }
  }

  return {
    config: { mcpServers },
    losses,
  };
}

export function serializeClaudeDesktopConfig(
  config: ClaudeDesktopConfig,
): string {
  return JSON.stringify(config, null, 2);
}

export function parseClaudeDesktopConfig(
  text: string,
): ParseClaudeDesktopConfigResult {
  const parsed = JSON.parse(text) as ClaudeDesktopConfig;
  const integrations: ToolDef[] = [];
  const losses: PortabilityLoss[] = [];

  for (const [id, value] of Object.entries(parsed.mcpServers || {})) {
    if (Object.hasOwn(value as object, 'secretEnvRefs')) {
      throw new Error('Portable imports cannot contain secretEnvRefs.');
    }
    if (!isSafeToolServerId(id)) {
      throw new Error(
        `Invalid Claude Desktop tool-server id ${JSON.stringify(id)}: ids must not be empty, '.', '..', dangerous object keys, or contain a path separator`,
      );
    }
    if (value.command) {
      integrations.push({
        id,
        kind: 'mcp',
        transport: 'stdio',
        command: value.command,
        args: value.args,
        env: value.env,
        requiredEnvNames: value.requiredEnvNames,
      });
      continue;
    }

    integrations.push({
      id,
      kind: 'mcp',
      transport: 'streamable-http',
      endpoint: value.url,
    });

    losses.push({
      code: 'degraded-field',
      scope: 'integration',
      path: `${id}.transport`,
      message: `Claude Desktop import cannot distinguish whether URL-based MCP server '${id}' originally used SSE or streamable-http; Station restores it as streamable-http.`,
      severity: 'warning',
    });
  }

  return { integrations, losses };
}

function renderWorkspaceGuidance(workspace: GuidanceWorkspaceExport): string {
  if (Object.keys(workspace).length === 0) {
    return '_No workspace guidance fields are currently set._';
  }

  return [
    workspace.systemPrompt
      ? `- **System prompt:** ${inlineCode(workspace.systemPrompt)}`
      : null,
    workspace.templateVariables
      ? `- **Template variables:** ${workspace.templateVariables.length}`
      : null,
    workspace.approvalGuardian
      ? `- **Approval guardian:** ${inlineCode(JSON.stringify(workspace.approvalGuardian))}`
      : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function renderAgentGuidance(agents: GuidanceAgentExport[]): string {
  if (agents.length === 0) {
    return '_No managed agents are currently configured._';
  }

  return agents
    .map(
      (agent) =>
        `### ${agent.slug}\n- **Name:** ${agent.spec.name}\n- **Prompt:** ${inlineCode(agent.spec.prompt)}\n- **MCP servers:** ${agent.spec.tools?.mcpServers?.join(', ') || 'none'}`,
    )
    .join('\n\n');
}

function renderIntegrations(integrations: NormalizedMcpConfig[]): string {
  if (integrations.length === 0) {
    return '_No MCP integrations are currently configured._';
  }

  return integrations
    .map(
      (integration) =>
        `- \`${integration.id}\` — ${integration.transport}${integration.command ? ` (${integration.command})` : integration.endpoint ? ` (${integration.endpoint})` : ''}${integration.requiredEnvNames?.length ? `; required environment variables (credentials not included): ${integration.requiredEnvNames.join(', ')}` : ''}`,
    )
    .join('\n');
}

function renderLosses(losses: PortabilityLoss[]): string {
  if (losses.length === 0) {
    return '- No known lossiness for the currently exported fields.';
  }

  return losses
    .map((loss) => `- [${loss.severity}] ${loss.path}: ${loss.message}`)
    .join('\n');
}

function inlineCode(value: string): string {
  return `\`${value.replaceAll('`', '\\`')}\``;
}

function createLedgerId(importedAt: string): string {
  return `agents-md-${importedAt.replaceAll(/[:.]/g, '-')}`;
}
