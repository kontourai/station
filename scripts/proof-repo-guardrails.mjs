import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateRepoStandards, loadRepoStandards } from '@kontourai/veritas';
import { collectCiWorkflowGovernanceFindings } from './ci-workflow-governance.mjs';
import { gitLsFiles } from './lib/ratchet-utils.mjs';
import {
  collectPaneHostCompositionFindings,
  createRequiredSourceReader,
} from './repo-guardrail-source.mjs';
import { collectRouteErrorEgressFindings } from './route-error-egress-gate.mjs';

const workflowDir = new URL('../.github/workflows/', import.meta.url);
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const trackedRepoStandardsPath = new URL(
  '../.veritas/repo-standards/default.repo-standards.json',
  import.meta.url,
);

const MISSING_SOURCE_PREFIX = 'Missing required guardrail source: ';

const errors = [];
const hasRawFetchCall = (source) => /(?<![\w$])fetch\s*\(/.test(source);
const readRequiredSource = createRequiredSourceReader({
  baseUrl: import.meta.url,
  reportMissing: (relativePath) => {
    errors.push(`${MISSING_SOURCE_PREFIX}${relativePath}.`);
  },
});

/**
 * Reads a required source that must parse as JSON. A bare
 * `JSON.parse(readRequiredSource(...))` reintroduces exactly the defect this
 * proof was repaired for: the reader reports the missing path and returns '',
 * and `JSON.parse('')` then throws before the aggregate verdict is printed.
 * Absence and malformation are both findings, and callers get an empty object
 * so the guardrails reading it fail loudly on their own terms.
 */
function readRequiredJson(relativePath) {
  const source = readRequiredSource(relativePath);
  if (source === '') return {};
  try {
    return JSON.parse(source);
  } catch (error) {
    errors.push(
      `Required guardrail source ${relativePath} is not valid JSON: ${error.message}`,
    );
    return {};
  }
}

function listSourceFiles(directory) {
  const entries = readdirSync(new URL(`../${directory}`, import.meta.url), {
    withFileTypes: true,
  });
  const files = [];
  for (const entry of entries) {
    if (
      entry.name === 'dist' ||
      entry.name === 'node_modules' ||
      entry.name === '__tests__'
    ) {
      continue;
    }
    const relativePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(relativePath));
      continue;
    }
    if (
      /\.(cts|mts|ts|tsx)$/.test(entry.name) &&
      !/\.test\./.test(entry.name)
    ) {
      files.push(relativePath);
    }
  }
  return files;
}

for (const artifact of [
  'packages/contracts/src/provider.js',
  'packages/contracts/src/provider.d.ts',
]) {
  if (existsSync(new URL(`../${artifact}`, import.meta.url))) {
    errors.push(
      `Contracts source must not contain generated artifact ${artifact}.`,
    );
  }
}

if (!existsSync(trackedRepoStandardsPath)) {
  errors.push(
    'Missing required Veritas standards file: .veritas/repo-standards/default.repo-standards.json',
  );
} else {
  const repoStandards = loadRepoStandards(trackedRepoStandardsPath);
  const [artifactsRule] = evaluateRepoStandards(
    repoStandards,
    { rootDir: repoRoot },
    { ruleIds: ['required-station-governance-artifacts'] },
  );

  if (!artifactsRule?.implemented) {
    errors.push(
      'required-station-governance-artifacts must be executable through Veritas.',
    );
  } else {
    for (const finding of artifactsRule.findings) {
      errors.push(
        `Missing required Veritas governance file: ${finding.artifact}`,
      );
    }
  }
}

const ciWorkflowPath = new URL('../.github/workflows/ci.yml', import.meta.url);
errors.push(
  ...collectCiWorkflowGovernanceFindings({
    ciWorkflowPath: fileURLToPath(ciWorkflowPath),
  }),
);

// The helper checks workflow presence, verdict-bearing continuations, and the
// exact readiness step before this legacy proof examines source boundaries.
const packageJson = readRequiredJson('../package.json');
for (const scriptName of ['proof:repo-guardrails', 'ci:fast', 'ci:extended']) {
  if (typeof packageJson.scripts?.[scriptName] !== 'string') {
    errors.push(`package.json is missing required script: ${scriptName}`);
  }
}

for (const relativePath of [
  ...listSourceFiles('packages/cli'),
  ...listSourceFiles('packages/connect'),
  ...listSourceFiles('packages/contracts'),
  ...listSourceFiles('packages/sdk'),
  ...listSourceFiles('src-server'),
  ...listSourceFiles('src-ui'),
]) {
  const fileContents = readFileSync(
    new URL(`../${relativePath}`, import.meta.url),
    'utf8',
  );
  if (fileContents.includes("from '@kontourai/station-shared'")) {
    errors.push(
      `${relativePath} must import shared helpers from explicit subpaths instead of the @kontourai/station-shared root.`,
    );
  }
}

const terminalSubprocessState = readRequiredSource(
  '../src-server/services/terminal/terminal-subprocess-state.ts',
);
if (
  !/\bexecFile\s*\(\s*['"]pgrep['"]\s*,\s*\[\s*['"]-P['"]\s*,\s*String\s*\(\s*pid\s*\)\s*\]/.test(
    terminalSubprocessState,
  )
) {
  errors.push(
    "terminal-subprocess-state.ts must probe Unix children asynchronously with execFile('pgrep', ['-P', String(pid)]).",
  );
}
if (/\bexecSync\s*\(\s*['"`]\s*pgrep\b/.test(terminalSubprocessState)) {
  errors.push(
    'terminal-subprocess-state.ts must not synchronously probe Unix children with execSync.',
  );
}

const systemRuntime = readRequiredSource(
  '../packages/sdk/src/query-domains/systemRuntime.ts',
);
if (systemRuntime.includes('await fetch(')) {
  errors.push(
    'systemRuntime.ts must not inline HTTP transport after extracting systemRuntimeRequests.ts.',
  );
}

const catalog = readRequiredSource(
  '../packages/sdk/src/query-domains/catalog.ts',
);
if (catalog.includes('fetch(')) {
  errors.push(
    'catalog.ts must not inline HTTP transport after extracting catalogRequests.ts.',
  );
}

const catalogRequests = readRequiredSource(
  '../packages/sdk/src/query-domains/catalogRequests.ts',
);
// The Playbooks SDK surface was DELETED with the Playbooks UI: skills own the
// one query/CRUD/import surface. These snippets pin the deletion; the server
// routes they used to call are gone too (slice 4), so a reintroduced fetcher
// would target nothing.
for (const retiredPlaybookTransport of [
  'export async function fetchPlaybooks',
  'export async function requestPlaybookRun',
  'export async function requestPlaybookOutcome',
  'export async function requestPlaybook',
]) {
  if (catalogRequests.includes(retiredPlaybookTransport)) {
    errors.push(
      `catalogRequests.ts must stay deleted of playbook transport ${retiredPlaybookTransport}: playbooks are skills.`,
    );
  }
}
for (const retiredPlaybookHook of [
  'export function usePlaybooksQuery(',
  'export function usePromptsQuery(',
  'export function useCreatePlaybookMutation(',
  'export function useUpdatePlaybookMutation(',
  'export function useDeletePlaybookMutation(',
  'export function useConvertPlaybookToSkillMutation(',
  'export function useTrackPlaybookRunMutation(',
  'export function useRecordPlaybookOutcomeMutation(',
  'export function useImportPlaybooksMutation(',
  'export function useConvertSkillToPlaybookMutation(',
]) {
  if (catalog.includes(retiredPlaybookHook)) {
    errors.push(
      `catalog.ts must stay deleted of playbook hook ${retiredPlaybookHook}: playbooks are skills.`,
    );
  }
}
const skillsQueryDomain = readRequiredSource(
  '../packages/sdk/src/query-domains/skills.ts',
);
if (skillsQueryDomain.includes('useConvertSkillToPlaybookMutation')) {
  errors.push(
    'skills.ts must stay deleted of useConvertSkillToPlaybookMutation: nothing converts into the retired concept.',
  );
}

// The Playbooks surface was DELETED: every playbook is a skill, and the Skills
// views carry what it used to. These guardrails follow the surface rather than
// the noun: the view that absorbed it must not carry the retired surface back.
const skillsView = readRequiredSource('../src-ui/src/views/SkillsView.tsx');
if (skillsView.includes('fetch(')) {
  errors.push('SkillsView must not issue raw fetch() calls.');
}
for (const retiredInlineSkillsSnippet of [
  'interface PlaybookForm {',
  '<PromptRunModal',
  '<ImportPromptsModal',
  'GuidanceConversionModal',
]) {
  if (skillsView.includes(retiredInlineSkillsSnippet)) {
    errors.push(
      `SkillsView must not carry retired playbook surface ${retiredInlineSkillsSnippet}.`,
    );
  }
}

const skillViewUtils = readRequiredSource(
  '../src-ui/src/views/skills/skill-view-utils.ts',
);
for (const [label, source] of [
  [
    'skills/SkillCommandSection.tsx',
    readRequiredSource('../src-ui/src/views/skills/SkillCommandSection.tsx'),
  ],
  ['skills/skill-view-utils.ts', skillViewUtils],
]) {
  if (!source.includes('@kontourai/station-contracts/skill-')) {
    errors.push(
      `${label} must derive command words and template variables through the shared skill contracts.`,
    );
  }
}

// The Playbooks surface was DELETED: every playbook is a skill. Rather than
// pinning each retired file by name (a list that can drift as the deletion
// recedes into history), this bans the noun from src-ui PATHS outright: no
// tracked file under the UI tree may be named for the retired concept, so a
// revival under any new filename fails too.
for (const trackedPath of gitLsFiles(['src-ui/src'])) {
  if (/playbook/i.test(trackedPath)) {
    errors.push(
      `${trackedPath} must stay deleted: playbooks are skills — no UI path names the retired concept.`,
    );
  }
}
for (const retiredNonPlaybookSurface of [
  '../src-ui/src/views/GuidanceConversionModal.tsx',
  '../src-ui/src/components/modals/ImportPromptsModal.tsx',
  '../src-ui/src/components/modals/PromptRunModal.tsx',
]) {
  if (existsSync(new URL(retiredNonPlaybookSurface, import.meta.url))) {
    errors.push(
      `${retiredNonPlaybookSurface} must stay deleted: its surface moved into Skills.`,
    );
  }
}

const promptsViewPath = new URL(
  '../src-ui/src/views/PromptsView.tsx',
  import.meta.url,
);
if (existsSync(promptsViewPath)) {
  errors.push('Legacy PromptsView must be removed after playbook convergence.');
}

const registryView = readRequiredSource('../src-ui/src/views/RegistryView.tsx');
if (registryView.includes('fetch(')) {
  errors.push('RegistryView must not issue raw fetch() calls.');
}
if (!registryView.includes('useRegistryItemsQuery')) {
  errors.push('RegistryView must use SDK registry query hooks.');
}

const integrationsView = readRequiredSource(
  '../src-ui/src/views/IntegrationsView.tsx',
);
if (integrationsView.includes('fetch(')) {
  errors.push('IntegrationsView must not issue raw fetch() calls.');
}
if (!integrationsView.includes('useIntegrationsQuery')) {
  errors.push('IntegrationsView must use shared SDK integration hooks.');
}

const projectsContext = readRequiredSource(
  '../src-ui/src/contexts/ProjectsContext.tsx',
);
if (projectsContext.includes('fetch(')) {
  errors.push('ProjectsContext must not issue raw fetch() calls.');
}
if (!projectsContext.includes('useProjectsQuery')) {
  errors.push('ProjectsContext must use shared SDK project hooks.');
}

const configContext = readRequiredSource(
  '../src-ui/src/contexts/ConfigContext.tsx',
);
if (hasRawFetchCall(configContext)) {
  errors.push('ConfigContext must not issue raw fetch() calls.');
}
if (!configContext.includes('useUpdateConfigMutation')) {
  errors.push('ConfigContext must use the shared SDK config mutation hook.');
}

const agentsContext = readRequiredSource(
  '../src-ui/src/contexts/AgentsContext.tsx',
);
if (hasRawFetchCall(agentsContext)) {
  errors.push('AgentsContext must not issue raw fetch() calls.');
}
for (const requiredHook of [
  'useAgentsQuery',
  // Either create-mutation variant satisfies the intent (the shared SDK
  // hook, never raw fetch): the Detailed variant is the same mutation
  // preserving the create envelope's warnings (station#3027 Enable).
  ['useCreateAgentDetailedMutation', 'useCreateAgentMutation'],
  'useUpdateAgentMutation',
  'useDeleteAgentMutation',
]) {
  const candidates = Array.isArray(requiredHook)
    ? requiredHook
    : [requiredHook];
  if (!candidates.some((hook) => agentsContext.includes(hook))) {
    errors.push(`AgentsContext must use ${candidates.join(' or ')}.`);
  }
}

const authContext = readRequiredSource(
  '../src-ui/src/contexts/AuthContext.tsx',
);
if (authContext.includes('fetch(')) {
  errors.push('AuthContext must not issue raw fetch() calls.');
}
for (const requiredHook of ['useAuthStatusQuery', 'useRenewAuthMutation']) {
  if (!authContext.includes(requiredHook)) {
    errors.push(`AuthContext must use ${requiredHook}.`);
  }
}

const analyticsContext = readRequiredSource(
  '../src-ui/src/contexts/AnalyticsContext.tsx',
);
if (analyticsContext.includes('fetch(')) {
  errors.push('AnalyticsContext must not issue raw fetch() calls.');
}
if (!analyticsContext.includes('useAnalyticsRescanMutation')) {
  errors.push(
    'AnalyticsContext must use the shared analytics rescan mutation.',
  );
}

const feedbackService = readRequiredSource(
  '../src-server/services/feedback/feedback-service.ts',
);
if (!feedbackService.includes('./feedback-analysis.js')) {
  errors.push(
    'feedback-service.ts must delegate analysis helpers to feedback-analysis.ts.',
  );
}
for (const retiredInlineFeedbackSnippet of [
  'function escapeXml(',
  'function escapeAttr(',
  'function extractJson(',
  'const ratingsXml = pending',
  'const liked = analyzed',
  'const prompt = `You are aggregating user feedback to identify patterns.',
]) {
  if (feedbackService.includes(retiredInlineFeedbackSnippet)) {
    errors.push(
      `feedback-service.ts must not inline extracted feedback helper ${retiredInlineFeedbackSnippet}.`,
    );
  }
}

const feedbackAnalysis = readRequiredSource(
  '../src-server/services/feedback/feedback-analysis.ts',
);
for (const requiredHelper of [
  'export async function runMiniFeedbackAnalysis',
  'export async function runFullFeedbackAnalysis',
]) {
  if (!feedbackAnalysis.includes(requiredHelper)) {
    errors.push(`feedback-analysis.ts must include ${requiredHelper}.`);
  }
}

const monitoringContext = readRequiredSource(
  '../src-ui/src/contexts/MonitoringContext.tsx',
);
if (monitoringContext.includes('fetch(')) {
  errors.push('MonitoringContext must not issue raw fetch() calls.');
}
for (const requiredHook of [
  'fetchMonitoringEventWindow',
  'useMonitoringStatsQuery',
]) {
  if (!monitoringContext.includes(requiredHook)) {
    errors.push(`MonitoringContext must use ${requiredHook}.`);
  }
}

const sharedIndex = readRequiredSource('../packages/shared/src/index.ts');
if (!sharedIndex.includes("export * from './types.js';")) {
  errors.push(
    'packages/shared/src/index.ts must re-export the dedicated shared types module.',
  );
}
for (const retiredSharedRootExport of [
  "export * from './parsers.js';",
  "export * from './git.js';",
  "export * from './build.js';",
]) {
  if (sharedIndex.includes(retiredSharedRootExport)) {
    errors.push(
      `packages/shared/src/index.ts must not re-export ${retiredSharedRootExport}.`,
    );
  }
}

const orchestrationServiceTest = readRequiredSource(
  '../src-server/services/orchestration/__tests__/orchestration-service.test.ts',
);
if (orchestrationServiceTest.includes('../../providers/types.js')) {
  errors.push(
    'src-server/services/orchestration/__tests__/orchestration-service.test.ts must import provider interfaces directly, not ../../providers/types.js.',
  );
}

const themingGuide = readRequiredSource('../docs/guides/theming.md');
if (themingGuide.includes('../providers/types.js')) {
  errors.push(
    'docs/guides/theming.md must reference ../providers/provider-interfaces.js instead of ../providers/types.js.',
  );
}
for (const legacyType of [
  'export interface PluginManifest',
  'export interface AgentSpec',
  'export interface ConnectionConfig',
  'export interface AppConfig',
]) {
  if (sharedIndex.includes(legacyType)) {
    errors.push(
      'packages/shared/src/index.ts must not inline the large shared type surface.',
    );
    break;
  }
}

const sharedTypes = readRequiredSource('../packages/shared/src/types.ts');
for (const contractExport of [
  '@kontourai/station-contracts/acp',
  '@kontourai/station-contracts/agent',
  '@kontourai/station-contracts/auth',
  '@kontourai/station-contracts/catalog',
  '@kontourai/station-contracts/config',
  '@kontourai/station-contracts/knowledge',
  '@kontourai/station-contracts/layout',
  '@kontourai/station-contracts/notification',
  '@kontourai/station-contracts/plugin',
  '@kontourai/station-contracts/project',
  '@kontourai/station-contracts/runtime',
  '@kontourai/station-contracts/scheduler',
  '@kontourai/station-contracts/tool',
]) {
  if (!sharedTypes.includes(contractExport)) {
    errors.push(
      `packages/shared/src/types.ts must re-export ${contractExport}.`,
    );
  }
}
if (!sharedTypes.includes('BUILTIN_KNOWLEDGE_NAMESPACES')) {
  errors.push(
    'packages/shared/src/types.ts must re-export BUILTIN_KNOWLEDGE_NAMESPACES from contracts.',
  );
}
for (const legacySharedDeclaration of [
  'export interface AgentSpec',
  'export interface AgentExecutionConfig',
  'export interface Playbook',
  'export interface Prompt',
  'export interface Skill',
  'export interface PluginManifest',
  'export interface PluginOverrides',
  'export interface ProjectConfig',
  'export interface ConnectionConfig',
  'export interface ToolDef',
  'export interface ProviderConnectionConfig',
  'export interface KnowledgeNamespaceConfig',
  'export interface LayoutConfig',
  'export interface LayoutMetadata',
  'export interface LayoutAction',
  'export interface LayoutTab',
  'export interface LayoutPrompt',
  'export interface LayoutTemplate',
  'export interface LayoutDefinition',
  'export interface LayoutDefinitionMetadata',
  'export interface AuthStatus',
  'export interface ACPConnectionConfig',
  'export interface ACPConfig',
  'export interface RenewResult',
  'export interface UserIdentity',
  'export interface UserDetailVM',
  'export interface AppConfig',
  'export interface TemplateVariable',
  'export interface ToolCallResponse',
  'export interface AgentInvokeResponse',
  'export interface WorkflowMetadata',
  'export interface SessionMetadata',
  'export interface MemoryEvent',
  'export interface ConversationStats',
  'export enum AgentSwitchState',
  'export const BUILTIN_KNOWLEDGE_NAMESPACES',
]) {
  if (sharedTypes.includes(legacySharedDeclaration)) {
    errors.push(
      `packages/shared/src/types.ts must not inline ${legacySharedDeclaration}.`,
    );
  }
}

const contractsKnowledge = readRequiredSource(
  '../packages/contracts/src/knowledge.ts',
);
if (!contractsKnowledge.includes('export const BUILTIN_KNOWLEDGE_NAMESPACES')) {
  errors.push(
    'packages/contracts/src/knowledge.ts must own BUILTIN_KNOWLEDGE_NAMESPACES.',
  );
}

const contractsLayout = readRequiredSource(
  '../packages/contracts/src/layout.ts',
);
for (const retiredLayoutTypeName of [
  'StandaloneLayoutConfig',
  'StandaloneLayoutMetadata',
]) {
  if (contractsLayout.includes(retiredLayoutTypeName)) {
    errors.push(
      `packages/contracts/src/layout.ts must not retain retired layout type ${retiredLayoutTypeName}.`,
    );
  }
}

const sdkTsconfig = readRequiredSource('../packages/sdk/tsconfig.json');
if (!sdkTsconfig.includes('"moduleResolution": "bundler"')) {
  errors.push('packages/sdk/tsconfig.json must use bundler moduleResolution.');
}

for (const [relativePath, requiredImport] of [
  [
    '../packages/sdk/src/query-domains/catalog.ts',
    '@kontourai/station-contracts/catalog',
  ],
  [
    '../packages/sdk/src/query-domains/systemRuntime.ts',
    '@kontourai/station-contracts/auth',
  ],
  [
    '../packages/sdk/src/notifications/index.ts',
    '@kontourai/station-contracts/notification',
  ],
  [
    '../packages/cli/src/commands/helpers.ts',
    '@kontourai/station-contracts/plugin',
  ],
  [
    '../packages/cli/src/commands/install.ts',
    '@kontourai/station-contracts/plugin',
  ],
  [
    '../packages/cli/src/dev/registry.ts',
    '@kontourai/station-contracts/layout',
  ],
  [
    '../packages/sdk/src/query-domains/plugin-types.ts',
    '@kontourai/station-contracts/plugin',
  ],
  [
    '../packages/sdk/src/types/index.ts',
    '@kontourai/station-contracts/runtime',
  ],
  [
    '../packages/sdk/src/query-domains/workspaceConnections.ts',
    '@kontourai/station-contracts/tool',
  ],
  // station#3879: `acpWorkspace.ts` is the ACP workspace/filesystem-browse
  // query domain, and `contracts/catalog` is now Skills and guidance-asset
  // types after the Playbooks merge. Re-pointing this would invent a
  // dependency the domain does not have.
  [
    '../src-server/providers/resolver.ts',
    '@kontourai/station-contracts/plugin',
  ],
  ['../src-server/routes/system/auth.ts', '@kontourai/station-contracts/auth'],
  [
    '../src-server/routes/connections/acp.ts',
    '@kontourai/station-contracts/acp',
  ],
  [
    '../src-server/routes/projects/projects.ts',
    '@kontourai/station-contracts/plugin',
  ],
  [
    '../src-server/providers/adapters/acp-adapter.ts',
    '@kontourai/station-contracts/acp',
  ],
  [
    '../src-server/services/acp/acp-manager.ts',
    '@kontourai/station-contracts/acp',
  ],
  [
    '../src-server/services/acp/acp-probe.ts',
    '@kontourai/station-contracts/acp',
  ],
  [
    '../src-server/services/agents/agent-service.ts',
    '@kontourai/station-contracts/agent',
  ],
  // station#3879: prompt-scanner.ts is DELETED. The prompts vocabulary went
  // with the Playbooks -> Skills merge and has no alias (AGENTS.md), so this
  // required source can never exist again — and the baseline deliberately
  // cannot absorb a missing source, by design.
  [
    '../src-server/services/knowledge/knowledge-service.ts',
    '@kontourai/station-contracts/knowledge',
  ],
  [
    '../src-server/services/projects/project-service.ts',
    '@kontourai/station-contracts/knowledge',
  ],
  [
    '../src-server/services/projects/layout-service.ts',
    '@kontourai/station-contracts/runtime',
  ],
  [
    '../src-server/services/plugins/mcp-service.ts',
    '@kontourai/station-contracts/tool',
  ],
  [
    '../src-server/services/notifications/notification-service.ts',
    '@kontourai/station-contracts/notification',
  ],
  [
    '../src-server/services/connections/connection-service.ts',
    '@kontourai/station-contracts/acp',
  ],
  [
    '../src-server/services/connections/connection-service.ts',
    '@kontourai/station-contracts/tool',
  ],
  [
    '../src-server/services/connections/provider-service.ts',
    '@kontourai/station-contracts/config',
  ],
  [
    '../src-server/routes/connections/bedrock.ts',
    '@kontourai/station-contracts/config',
  ],
  ['../src-server/domain/config-loader.ts', '@kontourai/station-contracts/acp'],
  [
    '../src-server/routes/agents/enriched-agents.ts',
    '@kontourai/station-contracts/agent',
  ],
  [
    '../src-server/routes/chat/conversations.ts',
    '@kontourai/station-contracts/config',
  ],
  [
    '../src-server/routes/agents/invoke.ts',
    '@kontourai/station-contracts/agent',
  ],
  [
    '../src-server/domain/file-storage-adapter.ts',
    '@kontourai/station-contracts/layout',
  ],
  [
    '../src-server/domain/storage-adapter.ts',
    '@kontourai/station-contracts/layout',
  ],
  [
    '../src-server/providers/llm/bedrock.ts',
    '@kontourai/station-contracts/config',
  ],
  [
    '../src-server/providers/llm/defaults.ts',
    '@kontourai/station-contracts/tool',
  ],
  [
    '../src-server/providers/registries/json-manifest-registry.ts',
    '@kontourai/station-contracts/tool',
  ],
  [
    '../src-server/runtime/agents/agent-hooks.ts',
    '@kontourai/station-contracts/agent',
  ],
  [
    '../src-server/runtime/conversation/conversation-manager.ts',
    '@kontourai/station-contracts/config',
  ],
  [
    '../src-server/runtime/mcp/mcp-manager.ts',
    '@kontourai/station-contracts/tool',
  ],
  [
    '../src-server/runtime/conversation/stream-orchestrator.ts',
    '@kontourai/station-contracts/agent',
  ],
  [
    '../src-server/runtime/frameworks/strands-adapter.ts',
    '@kontourai/station-contracts/agent',
  ],
  [
    '../src-server/routes/agents/templates.ts',
    '@kontourai/station-contracts/layout',
  ],
  [
    '../src-server/runtime/bootstrap/station-runtime.ts',
    '@kontourai/station-contracts/config',
  ],
  ['../src-server/runtime/types.ts', '@kontourai/station-contracts/config'],
  [
    '../src-server/runtime/frameworks/voltagent-adapter.ts',
    '@kontourai/station-contracts/agent',
  ],
  ['../src-ui/src/types.ts', '@kontourai/station-contracts/config'],
  ['../src-ui/src/types.ts', '@kontourai/station-contracts/runtime'],
  [
    '../src-ui/src/hooks/useScheduler.ts',
    '@kontourai/station-contracts/scheduler',
  ],
  ['../src-ui/src/utils/execution.ts', '@kontourai/station-contracts/tool'],
  [
    '../src-ui/src/contexts/scheduler-job-dialog-store.ts',
    '@kontourai/station-contracts/scheduler',
  ],
  [
    '../src-ui/src/components/scheduler/JobFormModal.tsx',
    '@kontourai/station-contracts/scheduler',
  ],
]) {
  const fileContents = readRequiredSource(relativePath);
  if (!fileContents.includes(requiredImport)) {
    errors.push(
      `${relativePath} must import contract types from ${requiredImport}.`,
    );
  }
  if (
    relativePath !== '../src-server/routes/plugins/plugins.ts' &&
    relativePath !== '../src-server/services/knowledge/knowledge-service.ts' &&
    relativePath !== '../packages/cli/src/commands/helpers.ts' &&
    relativePath !== '../packages/cli/src/commands/install.ts' &&
    relativePath !== '../packages/cli/src/dev/server.ts' &&
    fileContents.includes("from '@kontourai/station-shared'")
  ) {
    errors.push(
      `${relativePath} must not import contract-owned types from @kontourai/station-shared.`,
    );
  }
}

const acpBridge = readRequiredSource(
  '../src-server/services/acp/acp-bridge.ts',
);
for (const retiredInlineHandler of [
  'export class ACPConnection',
  'export class ACPManager',
  './acp-connection.js',
]) {
  if (acpBridge.includes(retiredInlineHandler)) {
    errors.push(
      `acp-bridge.ts must not retain retired ACP connection behavior ${retiredInlineHandler}.`,
    );
  }
}

const acpAdapter = readRequiredSource(
  '../src-server/providers/adapters/acp-adapter.ts',
);
for (const retiredAdapterSnippet of [
  './acp-connection.js',
  'new ACPConnection(',
  'activeWriter',
  'streamACPChatResponse(',
]) {
  if (acpAdapter.includes(retiredAdapterSnippet)) {
    errors.push(
      `acp-adapter.ts must not restore retired ACP chat path ${retiredAdapterSnippet}.`,
    );
  }
}

const acpManager = readRequiredSource(
  '../src-server/services/acp/acp-manager.ts',
);
for (const retiredManagerSnippet of [
  './acp-connection.js',
  'new ACPConnection(',
  'getOrCreateACPManagerSession(',
  'activeSessions: this.sessions.size',
]) {
  if (acpManager.includes(retiredManagerSnippet)) {
    errors.push(
      `acp-manager.ts must remain probe-only and must not include ${retiredManagerSnippet}.`,
    );
  }
}

const acpManagerView = readRequiredSource(
  '../src-server/services/acp/acp-manager-view.ts',
);
for (const retiredSyntheticAgentHelper of [
  'getACPManagerVirtualAgents',
  'toAcpAgentSlug',
]) {
  if (
    acpManager.includes(retiredSyntheticAgentHelper) ||
    acpManagerView.includes(retiredSyntheticAgentHelper)
  ) {
    errors.push(
      `ACP registry authority must not retain synthetic Agent helper ${retiredSyntheticAgentHelper}.`,
    );
  }
}

const strandsToolLoader = readRequiredSource(
  '../src-server/runtime/frameworks/strands-tool-loader.ts',
);
for (const retiredLoaderSnippet of [
  'new McpClient({',
  'new StdioClientTransport(',
]) {
  if (strandsToolLoader.includes(retiredLoaderSnippet)) {
    errors.push(
      `strands-tool-loader.ts must not construct MCP clients directly (${retiredLoaderSnippet}); the custody owner does.`,
    );
  }
}

for (const [relativePath, requiredImport] of [
  [
    '../src-server/services/connections/provider-service.ts',
    '../../providers/llm/model-provider-types.js',
  ],
  [
    '../src-server/services/knowledge/knowledge-service.ts',
    '../../providers/llm/model-provider-types.js',
  ],
  // station#3879: prompt-service.ts is DELETED, same merge as prompt-scanner.
  [
    '../src-server/services/notifications/notification-service.ts',
    '../providers/provider-interfaces.js',
  ],
  [
    '../src-server/services/orchestration/orchestration-service.ts',
    '../providers/provider-interfaces.js',
  ],
  [
    '../src-server/services/orchestration/orchestration-service.ts',
    '../providers/provider-contracts.js',
  ],
  // station#3879: prompt-scanner.ts is DELETED. The prompts vocabulary went
  // with the Playbooks -> Skills merge and has no alias (AGENTS.md), so this
  // required source can never exist again — and the baseline deliberately
  // cannot absorb a missing source, by design.
  [
    '../src-server/services/scheduling/scheduler-service.ts',
    '../providers/provider-interfaces.js',
  ],
  // template-service.ts is DELETED: nothing outside its own test imported it.
  [
    '../src-server/services/scheduling/builtin-scheduler.ts',
    '../providers/provider-interfaces.js',
  ],
  [
    '../src-server/services/scheduling/builtin-scheduler.ts',
    '../providers/provider-contracts.js',
  ],
  [
    '../src-server/providers/connection-factories.ts',
    './llm/model-provider-types.js',
  ],
  [
    '../src-server/providers/llm/bedrock-llm-provider.ts',
    './model-provider-types.js',
  ],
  [
    '../src-server/providers/llm/bedrock-embedding-provider.ts',
    './model-provider-types.js',
  ],
  [
    '../src-server/providers/lancedb-provider.ts',
    './llm/model-provider-types.js',
  ],
  [
    '../src-server/providers/llm/ollama-provider.ts',
    './model-provider-types.js',
  ],
  [
    '../src-server/providers/llm/openai-compat-provider.ts',
    './model-provider-types.js',
  ],
  [
    '../src-server/providers/registries/github-skill-registry.ts',
    './provider-interfaces.js',
  ],
  ['../src-server/providers/llm/defaults.ts', './provider-interfaces.js'],
  [
    '../src-server/providers/registries/json-manifest-registry.ts',
    './provider-interfaces.js',
  ],
  [
    '../src-server/providers/registries/registry.ts',
    './provider-interfaces.js',
  ],
  [
    '../src-server/providers/registries/registry.ts',
    './integration-registry-provider.js',
  ],
  ['../src-server/providers/resolver.ts', './provider-interfaces.js'],
]) {
  const fileContents = readRequiredSource(relativePath);
  if (!fileContents.includes(requiredImport)) {
    errors.push(`${relativePath} must import from ${requiredImport}.`);
  }
}

const sdkTypesIndex = readRequiredSource('../packages/sdk/src/types/index.ts');
if (!sdkTypesIndex.includes('@kontourai/station-contracts/layout')) {
  errors.push(
    'packages/sdk/src/types/index.ts must import layout types from @kontourai/station-contracts/layout.',
  );
}

for (const deletedPath of [
  '../packages/shared/src/notifications.ts',
  '../packages/shared/src/scheduler.ts',
  '../src-server/domain/types.ts',
  '../src-server/providers/types.ts',
]) {
  if (existsSync(new URL(deletedPath, import.meta.url))) {
    errors.push(
      `${deletedPath.replace('../', '')} must be removed after contract extraction.`,
    );
  }
}

const domainConfigLoader = readRequiredSource(
  '../src-server/domain/config-loader.ts',
);
for (const requiredImport of [
  '@kontourai/station-contracts/config',
  '@kontourai/station-contracts/tool',
]) {
  if (!domainConfigLoader.includes(requiredImport)) {
    errors.push(
      `src-server/domain/config-loader.ts must import from ${requiredImport}.`,
    );
  }
}
if (domainConfigLoader.includes('./types.js')) {
  errors.push(
    'src-server/domain/config-loader.ts must not import from ./types.js.',
  );
}

const domainValidator = readRequiredSource('../src-server/domain/validator.ts');
for (const requiredImport of [
  '@kontourai/station-contracts/agent',
  '@kontourai/station-contracts/config',
  '@kontourai/station-contracts/tool',
]) {
  if (!domainValidator.includes(requiredImport)) {
    errors.push(
      `src-server/domain/validator.ts must import from ${requiredImport}.`,
    );
  }
}
if (domainValidator.includes('./types.js')) {
  errors.push(
    'src-server/domain/validator.ts must not import from ./types.js.',
  );
}

const sdkQueries = readRequiredSource('../packages/sdk/src/queries.ts');
const sdkIndex = readRequiredSource('../packages/sdk/src/index.ts');
const sdkApi = readRequiredSource('../packages/sdk/src/api.ts');
const sdkPluginsDomain = readRequiredSource(
  '../packages/sdk/src/query-domains/plugins.ts',
);
for (const domainExport of [
  './query-domains/agentAdmin',
  './query-domains/acpWorkspace',
  './query-domains/analytics',
  './query-domains/catalog',
  './query-domains/chatRuntime',
  './query-domains/plugins',
  './query-domains/projectData',
  './query-domains/scheduler',
  './query-domains/skills',
  './query-domains/systemRuntime',
  './query-domains/workspace',
]) {
  if (!sdkQueries.includes(domainExport)) {
    errors.push(`packages/sdk/src/queries.ts must re-export ${domainExport}.`);
  }
}
for (const retiredLayoutExport of [
  'useLayoutQuery',
  'useLayoutsQuery',
  'fetchLayouts',
]) {
  if (sdkQueries.includes(retiredLayoutExport)) {
    errors.push(
      `packages/sdk/src/queries.ts must not re-export retired standalone layout helper ${retiredLayoutExport}.`,
    );
  }
  if (sdkIndex.includes(retiredLayoutExport)) {
    errors.push(
      `packages/sdk/src/index.ts must not re-export retired standalone layout helper ${retiredLayoutExport}.`,
    );
  }
}
for (const requiredPluginDomainExport of [
  "export * from './plugin-types';",
  "export * from './plugin-queries';",
  "export * from './plugin-mutations';",
]) {
  if (!sdkPluginsDomain.includes(requiredPluginDomainExport)) {
    errors.push(
      `packages/sdk/src/query-domains/plugins.ts must re-export ${requiredPluginDomainExport}.`,
    );
  }
}
if (sdkApi.includes('export async function fetchLayouts(')) {
  errors.push(
    'packages/sdk/src/api.ts must not expose the retired fetchLayouts helper.',
  );
}
for (const requiredExport of [
  "export * from './api-core';",
  "export * from './api-agent-runtime';",
  "export * from './api-knowledge';",
]) {
  if (!sdkApi.includes(requiredExport)) {
    errors.push(`packages/sdk/src/api.ts must re-export ${requiredExport}.`);
  }
}

const sdkChatRuntime = readRequiredSource(
  '../packages/sdk/src/query-domains/chatRuntime.ts',
);
for (const requiredExport of [
  "export * from './chatRuntimeTypes';",
  "export * from './chatRuntimeOrchestration';",
  "export * from './chatRuntimeConversations';",
  "export * from './chatRuntimeStream';",
  "export * from './chatRuntimeCoding';",
  "export * from './chatRuntimeDevice';",
]) {
  if (!sdkChatRuntime.includes(requiredExport)) {
    errors.push(
      `packages/sdk/src/query-domains/chatRuntime.ts must re-export ${requiredExport}.`,
    );
  }
}

const sdkWorkspace = readRequiredSource(
  '../packages/sdk/src/query-domains/workspace.ts',
);
for (const requiredExport of [
  "export * from './workspaceConnections';",
  "export * from './workspaceProjects';",
  "export * from './workspaceWorkflows';",
]) {
  if (!sdkWorkspace.includes(requiredExport)) {
    errors.push(
      `packages/sdk/src/query-domains/workspace.ts must re-export ${requiredExport}.`,
    );
  }
}

const sdkWorkspaceConnections = readRequiredSource(
  '../packages/sdk/src/query-domains/workspaceConnections.ts',
);
for (const retiredGenericEngineSurface of [
  'export interface ConnectionMutationInput',
  'export interface ConnectionSmokeInput',
  'export function useSaveConnectionMutation',
  'export function useDeleteConnectionMutation',
  'export function useTestConnectionMutation',
  'export function useSmokeConnectionMutation',
]) {
  if (sdkWorkspaceConnections.includes(retiredGenericEngineSurface)) {
    errors.push(
      `workspaceConnections.ts must keep model and Agent namespaces separate; remove ${retiredGenericEngineSurface}.`,
    );
  }
}

const sdkHooksBarrel = readRequiredSource('../packages/sdk/src/hooks.ts');
for (const requiredExport of [
  "export * from './hooks/context';",
  "export * from './hooks/knowledge';",
  "export * from './hooks/operations';",
]) {
  if (!sdkHooksBarrel.includes(requiredExport)) {
    errors.push(`packages/sdk/src/hooks.ts must re-export ${requiredExport}.`);
  }
}

const sdkHookModules = new Map([
  [
    'packages/sdk/src/hooks/context.ts',
    [
      'export function useSDK()',
      'export function useAgents()',
      'export function useLaunchChat()',
      'export function useDockState()',
      'export function useWorkflows(',
    ],
  ],
  [
    'packages/sdk/src/hooks/knowledge.ts',
    [
      'export function useKnowledgeNamespaces(',
      'export function useKnowledgeDocs(',
      'export function useKnowledgeSearch(',
    ],
  ],
  [
    'packages/sdk/src/hooks/operations.ts',
    [
      'export function useNotifications()',
      'export function useSendToChat(',
      'export function useUserLookup(',
      'export function useServerFetch()',
    ],
  ],
]);
for (const [relativePath, requiredSnippets] of sdkHookModules) {
  const hookModule = readRequiredSource(`../${relativePath}`);
  for (const requiredSnippet of requiredSnippets) {
    if (!hookModule.includes(requiredSnippet)) {
      errors.push(`${relativePath} must include ${requiredSnippet}.`);
    }
  }
}

for (const legacySdkDeclaration of [
  'export interface OrchestrationProviderSummary',
  'export type OrchestrationCommandInput =',
  'export interface AgentTemplate',
  'export interface SystemStatus',
  'export interface AuthStatusData',
  'export interface MonitoringStatsData',
  'export interface BrandingData',
  'export interface CoreUpdateStatus',
  'export async function fetchUsageStats(',
  'export async function fetchInsights(',
  'export async function fetchFeedbackRatings(',
  'export interface ACPConnectionInfo',
  'export interface AcpSlashCommandDescriptor',
  'export interface FileSystemBrowseEntry',
  'export interface FileSystemBrowseResult',
  'export interface GlobalKnowledgeStatus',
  'export interface ConnectionMutationInput',
  'export interface ConnectionTestResult',
  'export interface AvailableProjectLayout',
  'export interface WorkflowFile',
  'export interface IntegrationViewModel',
  'export type RegistryCatalogTab =',
  'export interface PluginSettingField',
  'export interface PluginSettingsData',
  'export interface PluginChangelogEntry',
  'export interface PluginChangelogData',
  'export interface PluginProviderDetail',
  'export interface AgentHealthStatus',
  'export function useConversationsQuery(',
  'export async function createAgent(',
  'export async function updateAgent(',
  'export async function deleteAgent(',
  'export async function submitToolApproval(',
  'export function useUserQuery(',
  'export function useAgentsQuery(',
  'export function useCreateAgentMutation(',
  'export function useUpdateAgentMutation(',
  'export function useDeleteAgentMutation(',
  'export function useAgentQuery(',
  'export function useAgentTemplatesQuery(',
  'export function useModelsQuery(',
  'export function useAgentToolsQuery(',
  'export function useModelCapabilitiesQuery(',
  'export function useConfigQuery(',
  'export function useUpdateConfigMutation(',
  'export function useStatsQuery(',
  'export function useInvokeAgent(',
  'export function useAgentInvokeMutation(',
  'export function useLayoutQuery(',
  'export function useLayoutsQuery(',
  'export function useProjectsQuery(',
  'export function useProjectQuery(',
  'export function useConnectionsQuery(',
  'export function useModelConnectionsQuery(',
  'export function useRuntimeConnectionsQuery(',
  'export function useConnectionQuery(',
  'export function useSaveConnectionMutation(',
  'export function useDeleteConnectionMutation(',
  'export function useTestConnectionMutation(',
  'export function useGlobalKnowledgeStatusQuery(',
  'export function useTestVectorDbConnectionMutation(',
  'export function useProjectLayoutsQuery(',
  'export function useProjectLayoutQuery(',
  'export function useAvailableProjectLayoutsQuery(',
  'export function useDeleteProjectLayoutMutation(',
  'export function useAgentWorkflowsQuery(',
  'export function useWorkflowContentQuery(',
  'export function useCreateWorkflowMutation(',
  'export function useUpdateWorkflowMutation(',
  'export function useDeleteWorkflowMutation(',
  'export function useCreateProjectMutation(',
  'export function useCreateProjectLayoutMutation(',
  'export function useUpdateProjectMutation(',
  'export function useDeleteProjectMutation(',
  'export function useCreateLayoutMutation(',
  'export function useGitStatusQuery(',
  'export function useGitLogQuery(',
  'export function useKnowledgeNamespacesQuery(',
  'export function useKnowledgeDocsQuery(',
  'export function useKnowledgeSearchQuery(',
  'export function useKnowledgeSaveMutation(',
  'export function useKnowledgeDeleteMutation(',
  'export function useKnowledgeBulkDeleteMutation(',
  'export function useKnowledgeStatusQuery(',
  'export function useKnowledgeDocContentQuery(',
  'export function useKnowledgeScanMutation(',
  'export function useKnowledgeTreeQuery(',
  'export function useKnowledgeFilteredQuery(',
  'export function useKnowledgeUpdateMutation(',
  'export function useProjectConversationsQuery(',
  'export function useSystemStatusQuery(',
  'export function useMonitoringStatsQuery(',
  'export function useBrandingQuery(',
  'export function useTemplatesQuery(',
  'export function useFileSystemBrowseQuery(',
  'export function usePromptQuery(',
  'export function useACPConnectionsQuery(',
  'export function usePlaybooksQuery(',
  'export function usePromptsQuery(',
  'export function useRegistryItemsQuery(',
  'export function useInstalledRegistryItemsQuery(',
  'export function useCreatePlaybookMutation(',
  'export function useUpdatePlaybookMutation(',
  'export function useDeletePlaybookMutation(',
  'export function useImportPlaybooksMutation(',
  'export function useIntegrationsQuery(',
  'export function useIntegrationQuery(',
  'export function useSaveIntegrationMutation(',
  'export function useDeleteIntegrationMutation(',
  'export function useReconnectIntegrationMutation(',
  'export function useRegistryIntegrationsQuery(',
  'export function useRegistryIntegrationActionMutation(',
  'export function usePluginsQuery(',
  'export function usePluginSettingsQuery(',
  'export function usePluginInstallMutation(',
  'export function useReloadPluginsMutation(',
  'async function schedulerFetch<',
  'async function schedulerMutate(',
  'export function useSchedulerJobs(',
  'export function useSchedulerProviders(',
  'export function useSchedulerStats(',
  'export function useSchedulerStatus(',
  'export function useJobLogs(',
  'export function usePreviewSchedule(',
  'export function useRunJob(',
  'export function useToggleJob(',
  'export function useDeleteJob(',
  'export function useEditJob(',
  'export function useAddJob(',
  'export function useFetchRunOutput(',
  'export function useOpenArtifact(',
  'export function useUsageQuery(',
  'export function useInsightsQuery(',
  'export function useFeedbackRatingsQuery(',
  'export function useSkillsQuery(',
  'export function useRegistrySkillsQuery(',
  'export function useInstallSkillMutation(',
  'export function useUninstallSkillMutation(',
  'export function useUpdateSkillMutation(',
  'export function useSkillContentQuery(',
]) {
  if (sdkQueries.includes(legacySdkDeclaration)) {
    errors.push(
      `packages/sdk/src/queries.ts must not inline ${legacySdkDeclaration}.`,
    );
  }
}

const activeChatsContext = readRequiredSource(
  '../src-ui/src/contexts/ActiveChatsContext.tsx',
);
if (activeChatsContext.includes('/conversations')) {
  errors.push(
    'ActiveChatsContext must use shared conversation helpers instead of fetching conversations directly.',
  );
}

const foregroundDispatch = readRequiredSource(
  '../src-ui/src/lib/foregroundMessageDispatch.ts',
);
if (
  !foregroundDispatch.includes('@kontourai/station-sdk/client') ||
  !foregroundDispatch.includes('sendExecutionMessage(')
) {
  errors.push(
    'Foreground dispatch must use the portable SDK execution request.',
  );
}

const chatDock = readRequiredSource(
  '../src-ui/src/components/chat-dock/ChatDock.tsx',
);
if (chatDock.includes('/api/conversations/')) {
  errors.push('ChatDock must use a shared conversation lookup helper.');
}
errors.push(
  ...collectPaneHostCompositionFindings({
    projectLayoutRenderer: readRequiredSource(
      '../src-ui/src/app-shell/ProjectLayoutRenderer.tsx',
    ),
    builtinWorkspacePaneRegistry: readRequiredSource(
      '../src-ui/src/workspace-panes/builtinWorkspacePaneRegistry.tsx',
    ),
  }),
);

const codingLayoutFileTree = readRequiredSource(
  '../src-ui/src/components/coding-layout/FileTreePanel.tsx',
);
if (!codingLayoutFileTree.includes('useCodingFilesQuery')) {
  errors.push('FileTreePanel must use useCodingFilesQuery.');
}

const codingLayoutDiff = readRequiredSource(
  '../src-ui/src/components/coding-layout/DiffPanel.tsx',
);
if (!codingLayoutDiff.includes('useCodingDiffQuery')) {
  errors.push('DiffPanel must use useCodingDiffQuery.');
}

const codingLayoutFileContent = readRequiredSource(
  '../src-ui/src/components/coding-layout/FileContentViewer.tsx',
);
// #2412: every coding read names its Project, so the viewer reads through
// the Project-bound FilePreviewPane (its own SDK query) rather than a
// path-only coding read. It must never fetch on its own.
if (
  !codingLayoutFileContent.includes('FilePreviewPane') ||
  /\bfetch\(/.test(codingLayoutFileContent)
) {
  errors.push(
    'FileContentViewer must read through the Project-bound FilePreviewPane and never fetch directly.',
  );
}

const terminalPanel = readRequiredSource(
  '../src-ui/src/components/coding-layout/TerminalPanel.tsx',
);
if (terminalPanel.includes('/api/system/terminal-port')) {
  errors.push('TerminalPanel must use the shared terminal port helper.');
}
if (terminalPanel.includes('/api/coding/exec')) {
  errors.push('TerminalPanel must use the shared coding exec helper.');
}
for (const requiredHelper of ['fetchTerminalPort', 'executeCodingCommand']) {
  if (!terminalPanel.includes(requiredHelper)) {
    errors.push(`TerminalPanel must use ${requiredHelper}.`);
  }
}

const pushNotifications = readRequiredSource(
  '../src-ui/src/hooks/usePushNotifications.ts',
);
if (
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source-expectation string deliberately contains an interpolation
  pushNotifications.includes('fetch(`${apiBase}/api/system/vapid-public-key`)')
) {
  errors.push('usePushNotifications must use the shared VAPID key helper.');
}
if (
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source-expectation string deliberately contains an interpolation
  pushNotifications.includes('fetch(`${apiBase}/api/system/push-subscribe`')
) {
  errors.push(
    'usePushNotifications must use the shared push subscribe helper.',
  );
}
if (
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source-expectation string deliberately contains an interpolation
  pushNotifications.includes('fetch(`${apiBase}/api/system/push-unsubscribe`')
) {
  errors.push(
    'usePushNotifications must use the shared push unsubscribe helper.',
  );
}
for (const requiredHelper of [
  'fetchVapidPublicKey',
  'subscribePushNotifications',
  'unsubscribePushNotifications',
]) {
  if (!pushNotifications.includes(requiredHelper)) {
    errors.push(`usePushNotifications must use ${requiredHelper}.`);
  }
}

const voiceSession = readRequiredSource(
  '../src-ui/src/hooks/useVoiceSession.ts',
);
if (voiceSession.includes('/api/voice/sessions')) {
  errors.push('useVoiceSession must use the shared voice session helper.');
}

const newChatModal = readRequiredSource(
  '../src-ui/src/components/modals/NewChatModal.tsx',
);
if (newChatModal.includes('/api/connections/runtimes')) {
  errors.push('NewChatModal must use shared SDK runtime connection queries.');
}
if (newChatModal.includes('/api/projects/')) {
  errors.push('NewChatModal must use shared SDK project queries.');
}

const agentEditorForm = readRequiredSource(
  '../src-ui/src/views/AgentEditorForm.tsx',
);
if (agentEditorForm.includes('/api/connections/runtimes')) {
  errors.push(
    'AgentEditorForm must use shared SDK runtime connection queries.',
  );
}
if (agentEditorForm.includes('/api/connections/models')) {
  errors.push('AgentEditorForm must use shared SDK model connection queries.');
}

const headerView = readRequiredSource(
  '../src-ui/src/components/header/Header.tsx',
);
if (headerView.includes('/api/connections/runtimes')) {
  errors.push('Header must use shared SDK runtime connection queries.');
}

const agentConnectionView = readRequiredSource(
  '../src-ui/src/views/AgentConnectionView.tsx',
);
if (hasRawFetchCall(agentConnectionView)) {
  errors.push('AgentConnectionView must not issue raw fetch() calls.');
}
for (const requiredHook of [
  'useEngineConnectionsQuery',
  'useAgentConnectionQuery',
  'useDeleteAgentConnectionMutation',
  'useSaveAgentConnectionMutation',
  'useTestAgentConnectionMutation',
]) {
  if (!agentConnectionView.includes(requiredHook)) {
    errors.push(
      `AgentConnectionView must use shared SDK hook ${requiredHook}.`,
    );
  }
}

const providerSettingsView = readRequiredSource(
  '../src-ui/src/views/ProviderSettingsView.tsx',
);
if (providerSettingsView.includes('fetch(')) {
  errors.push('ProviderSettingsView must not issue raw fetch() calls.');
}
if (!providerSettingsView.includes('useModelConnectionsQuery')) {
  errors.push(
    'ProviderSettingsView must use shared SDK model connection hooks.',
  );
}

const knowledgeConnectionView = readRequiredSource(
  '../src-ui/src/views/KnowledgeConnectionView.tsx',
);
if (knowledgeConnectionView.includes('fetch(')) {
  errors.push('KnowledgeConnectionView must not issue raw fetch() calls.');
}
if (!knowledgeConnectionView.includes('useGlobalKnowledgeStatusQuery')) {
  errors.push(
    'KnowledgeConnectionView must use shared SDK knowledge and connection hooks.',
  );
}

const connectionsHubView = readRequiredSource(
  '../src-ui/src/views/ConnectionsHub.tsx',
);
if (connectionsHubView.includes('fetch(')) {
  errors.push('ConnectionsHub must not issue raw fetch() calls.');
}
// station#3879: `ConnectionsHub` is no longer a page. #3733 turned it into a
// resolver that renders `null` and redirects to whichever section needs
// attention, so it has no UI to delegate and no connection list to query. The
// derivation it DOES own is asserted instead — it must ask the same signals
// hook the rail's warn dots ask, which is the defect its own docblock
// records (its private copy read `/api/connections` raw and ignored
// Knowledge, so the rail and this resolver disagreed about where to go).
if (!connectionsHubView.includes('useConnectionSectionSignals')) {
  errors.push(
    'ConnectionsHub must resolve its destination through the shared connection-section signals.',
  );
}

const systemStatusHook = readRequiredSource(
  '../src-ui/src/hooks/useSystemStatus.ts',
);
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal source-expectation string deliberately contains an interpolation
if (systemStatusHook.includes('fetch(`${apiBase}/api/system/status`)')) {
  errors.push(
    'useSystemStatus must read system status through shared SDK queries.',
  );
}
if (!systemStatusHook.includes('useSystemStatusForApiBaseQuery')) {
  errors.push(
    'useSystemStatus must delegate to the shared SDK system status query.',
  );
}

const serverCapabilitiesHook = readRequiredSource(
  '../src-ui/src/hooks/useServerCapabilities.ts',
);
if (
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source-expectation string deliberately contains an interpolation
  serverCapabilitiesHook.includes('fetch(`${apiBase}/api/system/capabilities`)')
) {
  errors.push(
    'useServerCapabilities must read capabilities through shared SDK queries.',
  );
}
if (!serverCapabilitiesHook.includes('useServerCapabilitiesQuery')) {
  errors.push(
    'useServerCapabilities must use the shared SDK capabilities query.',
  );
}

const gitStatusHook = readRequiredSource('../src-ui/src/hooks/useGitStatus.ts');
if (gitStatusHook.includes('fetch(')) {
  errors.push('useGitStatus must not issue raw fetch() calls.');
}
for (const requiredHook of ['useGitStatusQuery', 'useGitLogQuery']) {
  if (!gitStatusHook.includes(requiredHook)) {
    errors.push(`useGitStatus must use ${requiredHook}.`);
  }
}

const aiEnrichHook = readRequiredSource('../src-ui/src/hooks/useAIEnrich.ts');
if (aiEnrichHook.includes('fetch(')) {
  errors.push('useAIEnrich must not issue raw fetch() calls.');
}
if (!aiEnrichHook.includes('invoke(')) {
  errors.push('useAIEnrich must use the shared SDK invoke helper.');
}

const brandingHook = readRequiredSource('../src-ui/src/hooks/useBranding.ts');
if (brandingHook.includes('fetch(')) {
  errors.push('useBranding must not issue raw fetch() calls.');
}
if (!brandingHook.includes('useBrandingQuery')) {
  errors.push('useBranding must use the shared branding query.');
}

const recentAgentsHook = readRequiredSource(
  '../src-ui/src/hooks/useRecentAgents.ts',
);
if (recentAgentsHook.includes('fetch(')) {
  errors.push('useRecentAgents must not issue raw fetch() calls.');
}
if (!recentAgentsHook.includes('telemetry.track')) {
  errors.push('useRecentAgents must use shared telemetry tracking.');
}

const toolApprovalHook = readRequiredSource(
  '../src-ui/src/hooks/useToolApproval.ts',
);
if (toolApprovalHook.includes('fetch(')) {
  errors.push('useToolApproval must not issue raw fetch() calls.');
}
if (!toolApprovalHook.includes('submitToolApproval')) {
  errors.push('useToolApproval must use the shared tool approval helper.');
}

const sessionPickerModal = readRequiredSource(
  '../src-ui/src/components/modals/SessionPickerModal.tsx',
);
if (sessionPickerModal.includes('fetch(')) {
  errors.push('SessionPickerModal must not issue raw fetch() calls.');
}
if (!sessionPickerModal.includes('useConversationInventoryQuery')) {
  errors.push(
    'SessionPickerModal must use the shared conversation fetch helper.',
  );
}

const onboardingGate = readRequiredSource(
  '../src-ui/src/components/OnboardingGate.tsx',
);
if (onboardingGate.includes('/api/system/status')) {
  errors.push('OnboardingGate must not issue direct system status checks.');
}

const connectionBannerSource = readRequiredSource(
  '../src-ui/src/components/notifications/ConnectionBannerSource.tsx',
);
if (connectionBannerSource.includes('/api/system/status')) {
  errors.push(
    'ConnectionBannerSource must not issue direct system status checks.',
  );
}

const projectSettingsView = readRequiredSource(
  '../src-ui/src/views/ProjectSettingsView.tsx',
);
if (projectSettingsView.includes('fetch(')) {
  errors.push('ProjectSettingsView must not issue raw fetch() calls.');
}
if (
  !projectSettingsView.includes('useProjectQuery') &&
  !projectSettingsView.includes('useScopedProjectQuery')
) {
  errors.push('ProjectSettingsView must use shared SDK project hooks.');
}

const newProjectModal = readRequiredSource(
  '../src-ui/src/components/modals/NewProjectModal.tsx',
);
if (newProjectModal.includes('fetch(')) {
  errors.push('NewProjectModal must not issue raw fetch() calls.');
}
for (const requiredHook of [
  'useNewProjectModalState',
  'NewProjectModalContent',
]) {
  if (!newProjectModal.includes(requiredHook)) {
    errors.push(`NewProjectModal must use shared SDK hook ${requiredHook}.`);
  }
}

const settingsView = readRequiredSource('../src-ui/src/views/SettingsView.tsx');
if (settingsView.includes('fetch(')) {
  errors.push('SettingsView must not issue raw fetch() calls.');
}
if (!settingsView.includes('useConfigProvenanceQuery')) {
  errors.push('SettingsView must use the shared config provenance query.');
}

const environmentStatusView = readRequiredSource(
  '../src-ui/src/views/settings/EnvironmentStatus.tsx',
);
if (!environmentStatusView.includes('useSystemStatusForApiBaseQuery')) {
  errors.push('EnvironmentStatus must use useSystemStatusForApiBaseQuery.');
}

const coreUpdateCheckView = readRequiredSource(
  '../src-ui/src/views/settings/CoreUpdateCheck.tsx',
);
for (const requiredHook of [
  'useCoreUpdateStatusQuery',
  'useApplyCoreUpdateMutation',
]) {
  if (!coreUpdateCheckView.includes(requiredHook)) {
    errors.push(`CoreUpdateCheck must use shared system hook ${requiredHook}.`);
  }
}

const pluginManagementView = readRequiredSource(
  '../src-ui/src/views/PluginManagementView.tsx',
);
if (pluginManagementView.includes('fetch(')) {
  errors.push('PluginManagementView must not issue raw fetch() calls.');
}
for (const requiredHook of [
  'usePluginManagementViewModel',
  "onNavigate({ type: 'registry', tab: 'plugins' })",
]) {
  if (!pluginManagementView.includes(requiredHook)) {
    errors.push(
      `PluginManagementView must use shared SDK helper ${requiredHook}.`,
    );
  }
}

// #1014: FolderPickerModal.tsx (plugin management's own folder-browser
// wrapper) was deleted — PluginModalStack now renders the shared
// FolderBrowserModal directly, which is what actually issues the browse
// query. The guarantee below moves with the code rather than disappearing
// with the file it used to name.
const folderBrowserModal = readRequiredSource(
  '../src-ui/src/components/modals/FolderBrowserModal.tsx',
);
if (!folderBrowserModal.includes('useFileSystemBrowseQuery')) {
  errors.push('FolderBrowserModal must use useFileSystemBrowseQuery.');
}

const installPreviewModal = readRequiredSource(
  '../src-ui/src/views/plugin-management/InstallPreviewModal.tsx',
);
if (!installPreviewModal.includes('previewData.dependencies')) {
  errors.push('InstallPreviewModal must render dependency preview details.');
}

const layoutAssignmentModal = readRequiredSource(
  '../src-ui/src/views/plugin-management/LayoutAssignmentModal.tsx',
);
if (!layoutAssignmentModal.includes('selectedProjects.size')) {
  errors.push(
    'LayoutAssignmentModal must render selected project assignment state.',
  );
}

const agentsView = readRequiredSource('../src-ui/src/views/AgentsView.tsx');
if (agentsView.includes('fetch(')) {
  errors.push('AgentsView must not issue raw fetch() calls.');
}

const agentsViewModel = readRequiredSource(
  '../src-ui/src/views/agent-editor/useAgentsViewModel.ts',
);
for (const requiredHook of [
  'useAgentQuery',
  // station#3879: the view model no longer reads agent templates. The SDK
  // hook still exists for other callers; this file is not one of them.
  'useAgentToolsQuery',
  'useIntegrationsQuery',
  'useSkillsQuery',
]) {
  if (!agentsViewModel.includes(requiredHook)) {
    errors.push(
      `useAgentsViewModel.ts must use shared SDK hook ${requiredHook}.`,
    );
  }
}

const layoutView = readRequiredSource('../src-ui/src/views/LayoutView.tsx');
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal source-expectation string deliberately contains an interpolation
if (layoutView.includes('/api/projects/${projectSlug}/layouts/${layoutSlug}')) {
  errors.push('LayoutView must not fetch project layouts directly.');
}
if (layoutView.includes('/api/prompts/')) {
  errors.push('LayoutView must not fetch prompt content directly.');
}
if (!layoutView.includes('useProjectLayoutQuery')) {
  errors.push('LayoutView must use the shared SDK project layout hook.');
}
for (const retiredLayoutViewPattern of [
  'useLayoutQuery',
  'useLayoutsQuery',
  'setStandaloneLayout',
  'EmptyLayoutOnboarding',
]) {
  if (layoutView.includes(retiredLayoutViewPattern)) {
    errors.push(
      `LayoutView must not retain standalone-layout code path: ${retiredLayoutViewPattern}.`,
    );
  }
}

const appView = readRequiredSource('../src-ui/src/App.tsx');
if (appView.includes('standalone-layout')) {
  errors.push('App must not expose standalone layout routes or views.');
}
if (appView.includes("'/layouts'") || appView.includes('"/layouts"')) {
  errors.push('App must not retain legacy /layouts route handling.');
}
if (appView.includes('LayoutsView')) {
  errors.push(
    'App must not mount the legacy standalone layouts management view.',
  );
}
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal source-expectation string deliberately contains an interpolation
if (appView.includes('/api/projects/${projectSlug}/layouts/${layoutSlug}')) {
  errors.push('App must not fetch project layout configs directly.');
}

const projectLayoutRendererView = readRequiredSource(
  '../src-ui/src/app-shell/ProjectLayoutRenderer.tsx',
);
if (!projectLayoutRendererView.includes('useProjectLayoutQuery')) {
  errors.push(
    'ProjectLayoutRenderer must use the shared SDK project layout hook.',
  );
}

const runtimeFile = readRequiredSource(
  '../src-server/runtime/bootstrap/station-runtime.ts',
);
if (runtimeFile.includes("app.route('/layouts'")) {
  errors.push('Runtime must not register legacy standalone /layouts routes.');
}

const pluginRoutes = readRequiredSource(
  '../src-server/routes/plugins/plugins.ts',
);
for (const legacyHelper of [
  'async function fetchSource',
  'function detectConflicts',
  'async function resolveDependencies',
  'async function installDependency',
  'async function getGitInfo',
  'function extractPluginName',
  'async function loadProviders',
  'function resolvePluginBundle',
  'async function buildPlugin',
  'async function proxyFetch',
]) {
  if (pluginRoutes.includes(legacyHelper)) {
    errors.push(
      `Plugin routes must not inline legacy helper: ${legacyHelper}.`,
    );
  }
}

const navigationTypes = readRequiredSource('../src-ui/src/types.ts');
for (const retiredView of [
  'standalone-layout',
  "type: 'layouts'",
  'layout-new',
  'layout-edit',
]) {
  if (navigationTypes.includes(retiredView)) {
    errors.push(
      `NavigationView must not include retired standalone layout view: ${retiredView}`,
    );
  }
}

const mainEntry = readRequiredSource('../src-ui/src/main.tsx');
if (mainEntry.includes('LayoutsProvider')) {
  errors.push('main.tsx must not mount the retired LayoutsProvider.');
}

const pathAutocomplete = readRequiredSource(
  '../src-ui/src/components/PathAutocomplete.tsx',
);
if (pathAutocomplete.includes('fetch(')) {
  errors.push('PathAutocomplete must not issue raw fetch() calls.');
}
if (!pathAutocomplete.includes('useFileSystemBrowseQuery')) {
  errors.push('PathAutocomplete must use the shared filesystem browse query.');
}

const slashCommandsHook = readRequiredSource(
  '../src-ui/src/hooks/useSlashCommands.ts',
);
if (slashCommandsHook.includes('fetch(')) {
  errors.push('useSlashCommands must not issue raw fetch() calls.');
}
for (const requiredHelper of ['useProviderCommandsQuery']) {
  if (!slashCommandsHook.includes(requiredHelper)) {
    errors.push(
      `useSlashCommands must use shared ACP command helper ${requiredHelper}.`,
    );
  }
}

const sessionManagementViewModel = readRequiredSource(
  '../src-ui/src/hooks/useSessionManagementViewModel.ts',
);
if (sessionManagementViewModel.includes('fetch(')) {
  errors.push(
    'useSessionManagementViewModel must not issue raw fetch() calls.',
  );
}
if (!sessionManagementViewModel.includes('useConversationInventoryQuery')) {
  errors.push(
    'useSessionManagementViewModel must use shared conversation query factories.',
  );
}

const sessionManagementMenu = readRequiredSource(
  '../src-ui/src/hooks/useSessionManagementMenu.ts',
);
if (sessionManagementMenu.includes('fetch(')) {
  errors.push('useSessionManagementMenu must not issue raw fetch() calls.');
}
for (const requiredHelper of [
  'useRenameConversationMutation',
  'useDeleteConversationMutation',
]) {
  if (!sessionManagementMenu.includes(requiredHelper)) {
    errors.push(
      `useSessionManagementMenu must use shared conversation helper ${requiredHelper}.`,
    );
  }
}

const acpConnectionsHook = readRequiredSource(
  '../src-ui/src/hooks/useACPConnections.ts',
);
if (acpConnectionsHook.includes('fetch(')) {
  errors.push('useACPConnections must not issue raw fetch() calls.');
}
if (!acpConnectionsHook.includes('useACPConnectionsQuery')) {
  errors.push(
    'useACPConnections must delegate to the shared SDK ACP connections query.',
  );
}

const acpConnectionsSection = readRequiredSource(
  '../src-ui/src/components/acp-connections/ACPConnectionsSection.tsx',
);
if (acpConnectionsSection.includes('fetch(')) {
  errors.push('ACPConnectionsSection must not issue raw fetch() calls.');
}
for (const requiredHelper of [
  'useCreateACPConnectionMutation',
  'useUpdateACPConnectionMutation',
  'useDeleteACPConnectionMutation',
  'useReconnectACPConnectionMutation',
]) {
  if (!acpConnectionsSection.includes(requiredHelper)) {
    errors.push(
      `ACPConnectionsSection must use shared ACP helper ${requiredHelper}.`,
    );
  }
}

const usageStatsPanel = readRequiredSource(
  '../src-ui/src/components/usage-stats/UsageStatsPanel.tsx',
);
// A raw fetch CALL, not any identifier containing the substring: the
// previous `includes('fetch(')` matched react-query's `refetch()` the moment
// #3093 wired a retry button, failing the proof over code the rule was never
// about. `window.fetch(` / `globalThis.fetch(` stay caught (a dot is not an
// identifier character); `refetch(`/`prefetch(` do not.
if (hasRawFetchCall(usageStatsPanel)) {
  errors.push('UsageStatsPanel must not issue raw fetch() calls.');
}

const insightsDashboard = readRequiredSource(
  '../src-ui/src/components/monitoring/InsightsDashboard.tsx',
);
if (hasRawFetchCall(insightsDashboard)) {
  errors.push('InsightsDashboard must not issue raw fetch() calls.');
}
for (const requiredHook of [
  'useAnalyzeFeedbackMutation',
  'useClearFeedbackAnalysisMutation',
  'useDeleteFeedbackRatingMutation',
]) {
  if (!insightsDashboard.includes(requiredHook)) {
    errors.push(`InsightsDashboard must use ${requiredHook}.`);
  }
}

const monitoringView = readRequiredSource(
  '../src-ui/src/views/MonitoringView.tsx',
);
if (monitoringView.includes('fetch(')) {
  errors.push('MonitoringView must not issue raw fetch() calls.');
}
if (!monitoringView.includes('useOrchestrationSessionsQuery')) {
  errors.push('MonitoringView must use the shared session diagnostics query.');
}

const activeChatsStoreSource = readRequiredSource(
  '../src-ui/src/contexts/active-chats-store.ts',
);
if (activeChatsStoreSource.includes('./ConversationsContext')) {
  errors.push(
    'active-chats-store.ts must not depend directly on ConversationsContext.',
  );
}

const messageBubble = readRequiredSource(
  '../src-ui/src/components/chat/MessageBubble.tsx',
);
if (messageBubble.includes('fetch(')) {
  errors.push('MessageBubble must not issue raw fetch() calls.');
}
const messageBubbleUtils = readRequiredSource(
  '../src-ui/src/components/chat/message-bubble/utils.ts',
);
// #1536 B5: `getModelDisplayName` was a private table of five Claude 3 ids
// that answered "Custom" for everything newer, so a row running claude-opus-5
// named it "Custom" while Home named the same session "Opus 5". The assertion
// that has to hold now is the DELEGATION that replaced it: this module names
// no model itself, it asks the one shared identity rule. The same ban applies
// to MessageBubble, so the table cannot grow back one level up either.
//
// Delta review DL6: the import check is a regex rather than an exact string, so
// adding a second symbol to that import statement cannot silently retire this
// assertion; and a `const getModelDisplayName =` is the same table under an
// expression, so it is refused too.
if (/\bgetModelDisplayName\b/.test(messageBubble)) {
  errors.push(
    'MessageBubble must not declare or call getModelDisplayName; use modelIdentityLabel.',
  );
}
if (
  /function\s+getModelDisplayName\s*\(/.test(messageBubbleUtils) ||
  /const\s+getModelDisplayName\s*=/.test(messageBubbleUtils)
) {
  errors.push(
    'message-bubble/utils.ts must not re-declare getModelDisplayName; use modelIdentityLabel.',
  );
} else if (
  !/import\s*\{[^}]*\bmodelIdentityLabel\b[^}]*\}\s*from\s*'\.\.\/\.\.\/\.\.\/utils\/modelCapabilities'/.test(
    messageBubbleUtils,
  )
) {
  errors.push(
    'message-bubble/utils.ts must resolve model names through modelIdentityLabel.',
  );
}

/**
 * #1536 D8 delta review DM2: every availability surface reads
 * `createStationEngineAvailabilityReader`, never `resolveManagedAvailabilityReason`
 * directly. Six callers built that call themselves and had drifted — three onto
 * the app config the process BOOTED with, one of those also dropping the
 * check-gated connection receipts, and `/chat` last of all — so fixing the
 * default model connection at runtime cleared the picker and the inbox while
 * chat went on refusing until restart. A hand-rolled call cannot come back
 * green; the reader's own module is where the call belongs.
 */
for (const availabilityConsumer of [
  '../src-server/runtime/routes/runtime-routes.ts',
  '../src-server/routes/chat/chat.ts',
]) {
  const source = readRequiredSource(availabilityConsumer);
  if (/\bresolveManagedAvailabilityReason\s*\(/.test(source)) {
    errors.push(
      `${availabilityConsumer} must resolve Agent availability through createStationEngineAvailabilityReader, not resolveManagedAvailabilityReason directly.`,
    );
  }
}
const messageBubbleRating = readRequiredSource(
  '../src-ui/src/components/chat/message-bubble/MessageRating.tsx',
);
for (const requiredHook of [
  'useFeedbackRatingsQuery',
  'useSaveFeedbackRatingMutation',
  'useDeleteFeedbackRatingMutation',
]) {
  if (!messageBubbleRating.includes(requiredHook)) {
    errors.push(`MessageRating.tsx must use ${requiredHook}.`);
  }
}

const stationControlServer = readRequiredSource(
  '../src-server/tools/station-control-mcp-server.ts',
);
for (const requiredRegistration of [
  'registerAgentTools(registry);',
  'registerCatalogTools(registry);',
  'registerOperationsTools(registry);',
  'registerPlatformTools(registry);',
]) {
  if (!stationControlServer.includes(requiredRegistration)) {
    errors.push(
      `station-control-mcp-server.ts must include ${requiredRegistration}.`,
    );
  }
}

for (const [relativePath, requiredExports] of [
  [
    '../src-server/tools/station-control-agent-tools.ts',
    [
      'export function registerAgentTools',
      "'list_agents'",
      "'list_conversations'",
    ],
  ],
  [
    '../src-server/tools/station-control-catalog-tools.ts',
    // station#3879: `list_prompts` is deleted with the `*_prompt` tools;
    // `list_skills` is the surviving verb and stays asserted.
    ['export function registerCatalogTools', "'list_skills'"],
  ],
  [
    '../src-server/tools/station-control-operations-tools.ts',
    [
      'export function registerOperationsTools',
      'SCHEDULER_OPERATOR_SURFACE.list.mcp',
      "'send_message'",
      "'get_usage'",
    ],
  ],
  [
    '../src-server/tools/station-control-platform-tools.ts',
    [
      'export function registerPlatformTools',
      "'list_integrations'",
      "'list_plugins'",
      "'create_provider'",
    ],
  ],
]) {
  const fileContents = readRequiredSource(relativePath);
  for (const requiredExport of requiredExports) {
    if (!fileContents.includes(requiredExport)) {
      errors.push(`${relativePath} must include ${requiredExport}.`);
    }
  }
}

for (const deletedPath of [
  '../src-ui/src/views/LayoutsView.tsx',
  '../src-ui/src/views/LayoutEditorView.tsx',
  '../src-ui/src/contexts/LayoutsContext.tsx',
  '../src-ui/src/contexts/WorkflowsContext.tsx',
]) {
  if (existsSync(new URL(deletedPath, import.meta.url))) {
    errors.push(
      `${deletedPath.replace('../', '')} must be removed after standalone layout retirement.`,
    );
  }
}

const externalActionPattern =
  /^\s*-\s+uses:\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([^\s#]+)\s*$/gm;
const fullCommitShaPattern = /^[0-9a-f]{40}$/;
for (const fileName of readdirSync(workflowDir)) {
  if (!fileName.endsWith('.yml')) {
    continue;
  }

  const relativePath = join('.github/workflows', fileName);
  const contents = readFileSync(
    new URL(`../${relativePath}`, import.meta.url),
    'utf8',
  );
  let match;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic RegExp.exec loop
  while ((match = externalActionPattern.exec(contents)) !== null) {
    const [, actionName, ref] = match;
    if (!fullCommitShaPattern.test(ref)) {
      errors.push(
        `${relativePath} uses unpinned action ${actionName}@${ref}. Pin to a full commit SHA.`,
      );
    }
  }
}

errors.push(...collectRouteErrorEgressFindings({ rootDir: repoRoot }));

// station#2299: this proof crashed with an uncaught ENOENT on a retired source
// before evaluating anything, so 104 violations accumulated unseen. Every read
// now reports a missing source as a structured finding instead of throwing,
// which made them visible. They are recorded by exact message in
// `proof-repo-guardrails-baseline.json`, and a baselined message that no
// longer occurs is itself a failure telling you to delete the entry.
//
// What this does and does not prove (independent review of #2299). Every
// assertion in this file is a boolean over one (source, snippet) pair, so a
// violation's identity IS its message. The baseline therefore freezes the set
// of failing guardrail identities: a guardrail that starts failing is caught.
// It does not count instances, so a SECOND forbidden occurrence of an
// already-baselined snippet in the same source — or moving the existing one
// elsewhere in that file — produces the same single message and is absorbed.
// Making that distinguishable means rewriting the assertions themselves, not
// the baseline; the burn-down (#2765) removes the entries instead.
const baseline = readRequiredJson('./proof-repo-guardrails-baseline.json');
// A missing source may never be baselined. When a required source is absent
// the reader returns '', which makes every negative assertion about that file
// (`must not include X`, `must stay deleted of X`) vacuously true — they only
// fail on a match.
// The `Missing required guardrail source` finding is therefore the ONLY thing
// still holding those guardrails up, and baselining it would absorb both
// halves at once: the file's absence excused, and every negative assertion
// about it silently passing. That is precisely the shape of the defect this
// proof was repaired for, so it is refused rather than documented.
const baselinedMissingSources = (baseline.knownViolations ?? []).filter(
  (known) => known.startsWith(MISSING_SOURCE_PREFIX),
);
if (baselinedMissingSources.length > 0) {
  console.error(
    'Repo guardrail proof refused: a missing guardrail source may never be baselined.\n',
  );
  for (const entry of baselinedMissingSources) {
    console.error(`- ${entry}`);
  }
  console.error(
    '\nRestore the source or re-specify the guardrails that read it; do not record its absence.',
  );
  process.exit(1);
}

const knownViolations = new Set(baseline.knownViolations ?? []);
const observed = new Set(errors);

const newViolations = errors.filter((error) => !knownViolations.has(error));
const resolvedViolations = [...knownViolations].filter(
  (known) => !observed.has(known),
);

if (newViolations.length > 0 || resolvedViolations.length > 0) {
  console.error('Repo guardrail proof failed:\n');
  for (const error of newViolations) {
    console.error(`- ${error}`);
  }
  if (resolvedViolations.length > 0) {
    console.error(
      `\n${resolvedViolations.length} baselined violation(s) no longer occur. Delete them from scripts/proof-repo-guardrails-baseline.json:\n`,
    );
    for (const resolved of resolvedViolations) {
      console.error(`- ${resolved}`);
    }
  }
  process.exit(1);
}

if (knownViolations.size > 0) {
  console.log(
    `Repo guardrail proof passed with ${knownViolations.size} baselined violation(s) outstanding (station#2299 burn-down). No new violations.`,
  );
} else {
  console.log('Repo guardrail proof passed.');
}
