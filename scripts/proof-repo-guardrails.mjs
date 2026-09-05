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

const terminalService = readRequiredSource(
  '../src-server/services/terminal/terminal-service.ts',
);
if (!terminalService.includes('./terminal-shells')) {
  errors.push(
    'TerminalService must delegate shell resolution to terminal-shells.ts.',
  );
}
if (!terminalService.includes('./terminal-subprocess-state')) {
  errors.push(
    'TerminalService must delegate subprocess polling to terminal-subprocess-state.ts.',
  );
}
for (const retiredInlineTerminalSnippet of [
  'interface ShellCandidate {',
  'private resolveShell()',
  "{ shell: '/bin/zsh', args: ['-o', 'nopromptsp'] }",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source-expectation string deliberately contains an interpolation
  '`powershell -NoProfile -Command "Get-Process -Id ${entry.pid} -ErrorAction SilentlyContinue"`',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source-expectation string deliberately contains an interpolation
  '`pgrep -P ${entry.pid}`',
]) {
  if (terminalService.includes(retiredInlineTerminalSnippet)) {
    errors.push(
      `TerminalService must not inline terminal shell resolution helper ${retiredInlineTerminalSnippet}.`,
    );
  }
}

const terminalShells = readRequiredSource(
  '../src-server/services/terminal/terminal-shells.ts',
);
for (const requiredTerminalShellHelper of [
  'export interface ShellCandidate',
  'export function resolveTerminalShellCandidates',
  "{ shell: '/bin/zsh', args: ['-o', 'nopromptsp'] }",
]) {
  if (!terminalShells.includes(requiredTerminalShellHelper)) {
    errors.push(
      `terminal-shells.ts must include ${requiredTerminalShellHelper}.`,
    );
  }
}

const terminalSubprocessState = readRequiredSource(
  '../src-server/services/terminal/terminal-subprocess-state.ts',
);
for (const requiredTerminalHelper of [
  'export function pollTerminalSubprocessActivity',
  'function detectWindowsSubprocesses',
  'function detectUnixSubprocesses',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source-expectation string deliberately contains an interpolation
  'Get-Process -Id ${pid}',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source-expectation string deliberately contains an interpolation
  'pgrep -P ${pid}',
]) {
  if (!terminalSubprocessState.includes(requiredTerminalHelper)) {
    errors.push(
      `terminal-subprocess-state.ts must include ${requiredTerminalHelper}.`,
    );
  }
}

const systemRuntime = readRequiredSource(
  '../packages/sdk/src/query-domains/systemRuntime.ts',
);
if (!systemRuntime.includes('./systemRuntimeRequests')) {
  errors.push(
    'systemRuntime.ts must import request helpers from systemRuntimeRequests.ts.',
  );
}
if (systemRuntime.includes('await fetch(')) {
  errors.push(
    'systemRuntime.ts must not inline HTTP transport after extracting systemRuntimeRequests.ts.',
  );
}
for (const retiredInlineSystemRuntimeSnippet of [
  'async function requestSystemStatus(',
  'async function requestCoreUpdateStatus(',
  'export async function fetchAuthStatus(',
  'export async function renewAuth(',
  'export async function verifyBedrockConnection(',
  'export async function fetchMonitoringStats(',
  'export async function fetchMonitoringMetrics(',
  'export async function fetchMonitoringEvents(',
  'export async function fetchBranding(',
  'export async function fetchServerCapabilities(',
  'mutationFn: async () => {',
]) {
  if (systemRuntime.includes(retiredInlineSystemRuntimeSnippet)) {
    errors.push(
      `systemRuntime.ts must not inline extracted transport helper ${retiredInlineSystemRuntimeSnippet}.`,
    );
  }
}

const systemRuntimeRequests = readRequiredSource(
  '../packages/sdk/src/query-domains/systemRuntimeRequests.ts',
);
for (const requiredSystemRuntimeHelper of [
  'export async function fetchAuthStatus',
  'export async function renewAuth',
  'export async function verifyBedrockConnection',
  'export async function requestSystemStatus',
  'export async function fetchMonitoringStats',
  'export async function fetchMonitoringMetrics',
  'export async function fetchMonitoringEvents',
  'export async function fetchBranding',
  'export async function requestCoreUpdateStatus',
  'export async function applyCoreUpdate',
  'export async function fetchServerCapabilities',
]) {
  if (!systemRuntimeRequests.includes(requiredSystemRuntimeHelper)) {
    errors.push(
      `systemRuntimeRequests.ts must include ${requiredSystemRuntimeHelper}.`,
    );
  }
}

const catalog = readRequiredSource(
  '../packages/sdk/src/query-domains/catalog.ts',
);
if (!catalog.includes('./catalogRequests')) {
  errors.push(
    'catalog.ts must import request helpers from catalogRequests.ts.',
  );
}
if (catalog.includes('fetch(')) {
  errors.push(
    'catalog.ts must not inline HTTP transport after extracting catalogRequests.ts.',
  );
}
for (const retiredInlineCatalogSnippet of [
  'async function fetchRegistryItems<',
  'async function requestPlaybook<',
  'async function requestIntegration<',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source-expectation string deliberately contains an interpolation
  'const response = await fetch(`${apiBase}/api/playbooks`',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source-expectation string deliberately contains an interpolation
  'const response = await fetch(`${apiBase}/integrations`',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source-expectation string deliberately contains an interpolation
  'const response = await fetch(`${apiBase}/api/registry/${tab}${suffix}`',
]) {
  if (catalog.includes(retiredInlineCatalogSnippet)) {
    errors.push(
      `catalog.ts must not inline extracted catalog transport helper ${retiredInlineCatalogSnippet}.`,
    );
  }
}

const catalogRequests = readRequiredSource(
  '../packages/sdk/src/query-domains/catalogRequests.ts',
);
for (const requiredCatalogHelper of [
  'export async function fetchRegistryItems',
  'export async function requestIntegration',
  'export async function requestRegistryIntegrationAction',
]) {
  if (!catalogRequests.includes(requiredCatalogHelper)) {
    errors.push(`catalogRequests.ts must include ${requiredCatalogHelper}.`);
  }
}
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
// the noun — they pin the same "delegate, do not inline" structure on the views
// that absorbed it, so the extraction cannot silently collapse back.
const skillsView = readRequiredSource('../src-ui/src/views/SkillsView.tsx');
if (skillsView.includes('fetch(')) {
  errors.push('SkillsView must not issue raw fetch() calls.');
}
for (const requiredImport of [
  './skills/SkillCommandSection',
  './skills/skill-view-utils',
  '../components/modals/SkillRunModal',
  '../components/modals/ImportSkillsModal',
]) {
  if (!skillsView.includes(requiredImport)) {
    errors.push(
      `SkillsView must delegate extracted UI/helpers to ${requiredImport}.`,
    );
  }
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
for (const requiredHelper of [
  'export interface SkillForm',
  'export const EMPTY_SKILL_FORM',
  'export function skillDetailToForm',
  'export function buildSkillPayload',
  'export function buildSkillListItems',
  'export function buildSkillFilename',
  'export function formatSkillStatsSummary',
]) {
  if (!skillViewUtils.includes(requiredHelper)) {
    errors.push(`skills/skill-view-utils.ts must include ${requiredHelper}.`);
  }
}
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

const cliInstallCommand = readRequiredSource(
  '../packages/cli/src/commands/install.ts',
);
// Install source/layout mutation moved behind the canonical server API. The
// CLI command retains only the registry configuration helper locally.
for (const requiredImport of ['./install-registry.js']) {
  if (!cliInstallCommand.includes(requiredImport)) {
    errors.push(
      `packages/cli/src/commands/install.ts must delegate through ${requiredImport}.`,
    );
  }
}
for (const retiredInlineInstallSnippet of [
  'function findInstalledLayoutProvider(',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source-expectation string deliberately contains an interpolation
  'console.log(`🔍 Previewing plugin from ${source}...`);',
  "const configPath = join(PROJECT_HOME, 'config.json');",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source-expectation string deliberately contains an interpolation
  'execSync(`curl -sf "${url}"`',
]) {
  if (cliInstallCommand.includes(retiredInlineInstallSnippet)) {
    errors.push(
      `packages/cli/src/commands/install.ts must not inline extracted install helper ${retiredInlineInstallSnippet}.`,
    );
  }
}

const cliInstallRegistry = readRequiredSource(
  '../packages/cli/src/commands/install-registry.ts',
);
for (const requiredHelper of [
  'export async function showOrSaveRegistry',
  'function readConfiguredRegistryUrl',
  'function saveRegistryUrl',
]) {
  if (!cliInstallRegistry.includes(requiredHelper)) {
    errors.push(`install-registry.ts must include ${requiredHelper}.`);
  }
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
for (const requiredImport of [
  './integrations/IntegrationEditorPanel',
  './integrations/DeleteIntegrationModal',
  './integrations/utils',
]) {
  if (!integrationsView.includes(requiredImport)) {
    errors.push(
      `IntegrationsView must delegate extracted UI to ${requiredImport}.`,
    );
  }
}
// station#3879: the inline `onNavigate({ type: 'registry', tab: 'integrations' })`
// went with #3733's one-hub rework — this view no longer offers registry
// discovery at all. The ROUTE is still real and still owned:
// `src-ui/src/__tests__/app-routing.test.ts` pins
// `getPathForView({ type: 'registry', tab: 'integrations' })`. Asserting a
// caller that no longer exists proved nothing about the thing that does.
for (const retiredInlineIntegrationsSnippet of [
  'function RegistryModal({',
  'const formToMcpJson = (form: IntegrationDef): string => {',
  'const parseMcpJson = (json: string): IntegrationDef | null => {',
  'className="plugins__confirm-overlay"',
  'className="integration__mode-tabs"',
]) {
  if (integrationsView.includes(retiredInlineIntegrationsSnippet)) {
    errors.push(
      `IntegrationsView must not inline extracted integrations UI ${retiredInlineIntegrationsSnippet}.`,
    );
  }
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
if (agentsContext.includes('fetch(')) {
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

const usageAggregator = readRequiredSource(
  '../src-server/analytics/usage-aggregator.ts',
);
if (!usageAggregator.includes('./usage-aggregator-state.js')) {
  errors.push(
    'usage-aggregator.ts must delegate state math to usage-aggregator-state.ts.',
  );
}
for (const retiredInlineUsageSnippet of [
  'private getEmptyStats(): UsageStats',
  'private updateDaily(',
  'private computeStreakStats(',
]) {
  if (usageAggregator.includes(retiredInlineUsageSnippet)) {
    errors.push(
      `usage-aggregator.ts must not inline extracted state helper ${retiredInlineUsageSnippet}.`,
    );
  }
}

const usageAggregatorState = readRequiredSource(
  '../src-server/analytics/usage-aggregator-state.ts',
);
for (const requiredHelper of [
  'export function createEmptyUsageStats',
  'function updateDailyUsage',
  'export function computeStreakStats',
  'export function applyMessageToUsageStats',
  'export function mergeRescannedUsageStats',
  'export function checkAchievement',
  'export function getAchievementProgress',
]) {
  if (!usageAggregatorState.includes(requiredHelper)) {
    errors.push(`usage-aggregator-state.ts must include ${requiredHelper}.`);
  }
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
  'export function extractJson',
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
  'fetchMonitoringEvents',
  'useMonitoringStatsQuery',
]) {
  if (!monitoringContext.includes(requiredHook)) {
    errors.push(`MonitoringContext must use ${requiredHook}.`);
  }
}

const eventEntry = readRequiredSource(
  '../src-ui/src/components/monitoring/EventEntry.tsx',
);
for (const requiredImport of [
  './event-entry/EventEntryHeader',
  './event-entry/EventEntrySections',
]) {
  if (!eventEntry.includes(requiredImport)) {
    errors.push(
      `EventEntry.tsx must delegate extracted monitoring UI to ${requiredImport}.`,
    );
  }
}
for (const retiredInlineEventEntrySnippet of [
  'function IntegrationBadges(',
  'function HealthChecksSection(',
  'function ToolResultSection(',
  'function UsageStatsSection(',
]) {
  if (eventEntry.includes(retiredInlineEventEntrySnippet)) {
    errors.push(
      `EventEntry.tsx must not inline extracted monitoring helper ${retiredInlineEventEntrySnippet}.`,
    );
  }
}

const eventEntryUtils = readRequiredSource(
  '../src-ui/src/components/monitoring/event-entry/utils.ts',
);
for (const requiredHelper of [
  'export function buildEventTimestampTitle',
  'export function buildToolInputDisplay',
  'export function getArtifactSummary',
  'export function getTotalChars',
  'export function getTotalTokens',
]) {
  if (!eventEntryUtils.includes(requiredHelper)) {
    errors.push(`event-entry/utils.ts must include ${requiredHelper}.`);
  }
}

const conversationsContext = readRequiredSource(
  '../src-ui/src/contexts/ConversationsContext.tsx',
);
for (const requiredImport of [
  './conversation-hooks',
  './conversations-store',
  './conversation-types',
]) {
  if (!conversationsContext.includes(requiredImport)) {
    errors.push(
      `ConversationsContext.tsx must delegate through ${requiredImport}.`,
    );
  }
}
for (const retiredInlineConversationSnippet of [
  'class ConversationsStore',
  'export function useMessages(',
  'export function useConversationActions()',
  'export function useConversationStatus(',
  'fetchConversationMessages',
  'deleteConversationRequest',
  'streamConversationTurn',
]) {
  if (conversationsContext.includes(retiredInlineConversationSnippet)) {
    errors.push(
      `ConversationsContext.tsx must not inline extracted conversation helper ${retiredInlineConversationSnippet}.`,
    );
  }
}

const conversationsStoreSource = readRequiredSource(
  '../src-ui/src/contexts/conversations-store.ts',
);
// `streamConversationTurn` is deliberately absent from this list. station#3296
// (1dbea22c8) removed the fully-wired but callerless direct-path send from
// conversations-store.ts, making ADR-0014's "deleted from both clients" claim
// true — and left this requirement behind, so the proof has asserted a symbol
// that exists nowhere in src-ui ever since. The paired
// `retiredInlineConversationSnippet` loop above still names it, and that half
// stays correct: nothing may re-inline it into ConversationsContext.tsx.
for (const requiredHelper of [
  'class ConversationsStore',
  'export const conversationsStore = new ConversationsStore();',
  'fetchConversationMessages',
  'deleteConversationRequest',
]) {
  if (!conversationsStoreSource.includes(requiredHelper)) {
    errors.push(`conversations-store.ts must include ${requiredHelper}.`);
  }
}

const conversationHooksSource = readRequiredSource(
  '../src-ui/src/contexts/conversation-hooks.ts',
);
for (const requiredHook of [
  'export function useConversations(',
  'export function useMessages(',
  'export function useConversationActions()',
  'export function useConversationStatus(',
]) {
  if (!conversationHooksSource.includes(requiredHook)) {
    errors.push(`conversation-hooks.ts must include ${requiredHook}.`);
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
if (
  !orchestrationServiceTest.includes('../../providers/provider-interfaces.js')
) {
  errors.push(
    'src-server/services/orchestration/__tests__/orchestration-service.test.ts must import IProviderAdapterRegistry from ../../providers/provider-interfaces.js.',
  );
}

const orchestrationService = readRequiredSource(
  '../src-server/services/orchestration/orchestration-service.ts',
);
for (const requiredHelper of [
  './orchestration-session-state.js',
  'resolveOrchestrationAdapterForThread({',
  'projectOrchestrationEventToReadModel({',
  'recoverOrchestrationSessions({',
  'trackOrchestrationSession({',
]) {
  if (!orchestrationService.includes(requiredHelper)) {
    errors.push(`orchestration-service.ts must include ${requiredHelper}.`);
  }
}
for (const retiredInlineOrchestrationSnippet of [
  'private async resolveAdapterForThread(',
  'private projectEventToReadModel(',
  'private mapSessionState(',
]) {
  if (orchestrationService.includes(retiredInlineOrchestrationSnippet)) {
    errors.push(
      `orchestration-service.ts must not inline extracted session-state logic ${retiredInlineOrchestrationSnippet}.`,
    );
  }
}

const orchestrationSessionState = readRequiredSource(
  '../src-server/services/orchestration/orchestration-session-state.ts',
);
for (const requiredHelper of [
  'export function trackOrchestrationSession',
  'export async function resolveOrchestrationAdapterForThread',
  'export function projectOrchestrationEventToReadModel',
  'export async function recoverOrchestrationSessions',
]) {
  if (!orchestrationSessionState.includes(requiredHelper)) {
    errors.push(
      `orchestration-session-state.ts must include ${requiredHelper}.`,
    );
  }
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
    '../src-ui/src/views/ScheduleView.tsx',
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

const acpBridgeTypes = readRequiredSource(
  '../src-server/services/acp/acp-bridge-types.ts',
);
for (const requiredType of [
  'export interface ManagedTerminal',
  'export interface ExtendedRequestPermissionRequest',
  'export interface ExtendedCreateTerminalRequest',
]) {
  if (!acpBridgeTypes.includes(requiredType)) {
    errors.push(`acp-bridge-types.ts must own ${requiredType}.`);
  }
}

const acpBridge = readRequiredSource(
  '../src-server/services/acp/acp-bridge.ts',
);
for (const requiredExport of [
  "export { ACPManager } from './acp-manager.js';",
]) {
  if (!acpBridge.includes(requiredExport)) {
    errors.push(
      `acp-bridge.ts must remain a compatibility barrel exporting ${requiredExport}.`,
    );
  }
}
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
for (const requiredHelper of [
  'export class AcpAdapter implements ProviderAdapterShape',
  'private readonly sessions = new Map<string, AcpSessionRecord>()',
  'private readonly startingSessionThreads = new Set<string>()',
  'createACPBridgeClient({',
  'new ACPProcess(opts)',
  'mapAcpSessionUpdate(',
  'mapAcpExtensionNotification(',
  'async startSession(',
  'async sendTurn(',
  'async interruptTurn(',
  'async respondToRequest(',
  'async stopSession(',
  'streamEvents(',
]) {
  if (!acpAdapter.includes(requiredHelper)) {
    errors.push(`acp-adapter.ts must include ${requiredHelper}.`);
  }
}
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

const acpAdapterEvents = readRequiredSource(
  '../src-server/providers/adapters/acp-adapter-events.ts',
);
for (const requiredHelper of [
  'export function mapAcpSessionUpdate',
  'export function mapAcpExtensionNotification',
  'export function mapAcpStopReasonToFinishReason',
  'export function mapAcpDecisionToOutcome',
  "method: 'content.text-delta'",
  "method: 'plan.updated'",
  "method: 'extension.notification'",
]) {
  if (!acpAdapterEvents.includes(requiredHelper)) {
    errors.push(`acp-adapter-events.ts must include ${requiredHelper}.`);
  }
}

// station#4221 moved ACP tool-call emission out of acp-adapter-events.ts and
// into the bounded supervisor. The REQUIREMENT is unchanged — ACP must still
// emit both canonical tool events — so this follows the code to its new home
// rather than being deleted, which would have retired the guarantee silently.
const acpToolUpdateSupervisor = readRequiredSource(
  '../src-server/providers/adapters/acp-tool-update-supervisor.ts',
);
for (const requiredHelper of [
  "method: 'tool.started'",
  "method: 'tool.completed'",
]) {
  if (!acpToolUpdateSupervisor.includes(requiredHelper)) {
    errors.push(
      `acp-tool-update-supervisor.ts must include ${requiredHelper}.`,
    );
  }
}

const knowledgeServiceSearch = readRequiredSource(
  '../src-server/services/knowledge/knowledge-service.ts',
);
for (const requiredHelper of [
  './knowledge-search.js',
  './knowledge-documents.js',
]) {
  if (!knowledgeServiceSearch.includes(requiredHelper)) {
    errors.push(`knowledge-service.ts must include ${requiredHelper}.`);
  }
}
for (const retiredInlineKnowledgeSnippet of [
  'const [queryVector] = await embeddingProvider.embed([query]);',
  'allResults.sort((a, b) => b.score - a.score);',
]) {
  if (knowledgeServiceSearch.includes(retiredInlineKnowledgeSnippet)) {
    errors.push(
      `knowledge-service.ts must not inline extracted search helper ${retiredInlineKnowledgeSnippet}.`,
    );
  }
}

const knowledgeSearch = readRequiredSource(
  '../src-server/services/knowledge/knowledge-search.ts',
);
for (const requiredHelper of [
  'export async function searchKnowledgeDocuments',
  "candidate.behavior === 'rag'",
  'allResults.sort((left, right) => right.score - left.score);',
]) {
  if (!knowledgeSearch.includes(requiredHelper)) {
    errors.push(`knowledge-search.ts must include ${requiredHelper}.`);
  }
}

const acpManager = readRequiredSource(
  '../src-server/services/acp/acp-manager.ts',
);
for (const requiredHelper of [
  'export class ACPManager',
  './acp-manager-orchestration.js',
  './acp-manager-view.js',
  'private probes = new Map<string, ACPProbe>()',
  'runACPManagerProbes({',
  'getACPManagerStatus(',
  '`providers/adapters/acp-adapter.ts`',
]) {
  if (!acpManager.includes(requiredHelper)) {
    errors.push(`acp-manager.ts must include ${requiredHelper}.`);
  }
}
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
for (const requiredHelper of [
  'export function getACPManagerStatus',
  'sessionId: null',
]) {
  if (!acpManagerView.includes(requiredHelper)) {
    errors.push(`acp-manager-view.ts must include ${requiredHelper}.`);
  }
}
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

const acpBridgeClient = readRequiredSource(
  '../src-server/services/acp/acp-bridge-client.ts',
);
for (const requiredHelper of [
  'export function createACPBridgeClient',
  'export async function handleACPBridgePermissionRequest',
  'export async function handleACPBridgeCreateTerminal',
  '@agentclientprotocol/sdk',
]) {
  if (!acpBridgeClient.includes(requiredHelper)) {
    errors.push(`acp-bridge-client.ts must include ${requiredHelper}.`);
  }
}

const acpProcess = readRequiredSource(
  '../src-server/services/acp/acp-process.ts',
);
for (const requiredHelper of [
  'export class ACPProcess extends EventEmitter',
  'detached: true',
  'protocolVersion: PROTOCOL_VERSION',
  'await (this.opts.terminateProcess ?? forceKillProcess)(proc)',
  'findCliBinaryAsync',
  'spawnOwnedChild',
]) {
  if (!acpProcess.includes(requiredHelper)) {
    errors.push(`acp-process.ts must include ${requiredHelper}.`);
  }
}

const acpManagerOrchestration = readRequiredSource(
  '../src-server/services/acp/acp-manager-orchestration.ts',
);
for (const requiredHelper of [
  'export async function runACPManagerProbes',
  'export async function addACPManagerConnection',
  'export async function removeACPManagerConnection',
  'export async function reconnectACPManagerConnection',
  'export async function shutdownACPManager',
  'if (sessions.size > 0) return',
  "throw new AggregateError(failures, 'ACP probe shutdown failed.')",
]) {
  if (!acpManagerOrchestration.includes(requiredHelper)) {
    errors.push(`acp-manager-orchestration.ts must include ${requiredHelper}.`);
  }
}

const stationRuntime = readRequiredSource(
  '../src-server/runtime/bootstrap/station-runtime.ts',
);
if (!stationRuntime.includes('../conversation/runtime-event-log.js')) {
  errors.push(
    'station-runtime.ts must delegate event log persistence to runtime-event-log.ts.',
  );
}
for (const retiredInlineRuntimeMethod of [
  'private getTodayEventLogPath(): string {',
  'private async queryEventsFromDisk(',
  'private async loadEventsFromDisk(): Promise<void> {',
  'private async persistEvent(event: any): Promise<void> {',
]) {
  if (stationRuntime.includes(retiredInlineRuntimeMethod)) {
    errors.push(
      `station-runtime.ts must not inline extracted event log method ${retiredInlineRuntimeMethod}.`,
    );
  }
}

const runtimeEventLog = readRequiredSource(
  '../src-server/runtime/conversation/runtime-event-log.ts',
);
const runtimeInitialize = readRequiredSource(
  '../src-server/runtime/bootstrap/runtime-initialize.ts',
);
for (const requiredHelper of [
  'export class RuntimeEventLog',
  'async queryEvents(',
  'async loadRecentEvents(): Promise<void>',
  'async persist(event: any): Promise<void>',
]) {
  if (!runtimeEventLog.includes(requiredHelper)) {
    errors.push(`runtime-event-log.ts must define ${requiredHelper}.`);
  }
}

if (
  !stationRuntime.includes('../plugins/runtime-plugin-assets.js') &&
  !runtimeInitialize.includes('../plugins/runtime-plugin-assets.js')
) {
  errors.push(
    'station-runtime.ts must delegate plugin asset loading orchestration to runtime-plugin-assets.ts.',
  );
}
for (const retiredInlinePluginSnippet of [
  "const pluginsDir = join(this.configLoader.getProjectHomeDir(), 'plugins');",
  "const { resolvePluginProviders } = await import('../providers/resolver.js');",
  "const { scanPromptDir } = await import('../services/prompt-scanner.js');",
]) {
  if (stationRuntime.includes(retiredInlinePluginSnippet)) {
    errors.push(
      `station-runtime.ts must not inline plugin-loading code ${retiredInlinePluginSnippet}.`,
    );
  }
}

const runtimePluginLoader = readRequiredSource(
  '../src-server/runtime/plugins/runtime-plugin-loader.ts',
);
for (const requiredHelper of [
  'export async function loadRuntimePluginPrompts',
  'export async function loadRuntimePluginProviders',
  '../providers/resolver.js',
  // station#3879: plugin-prompt-generation.ts is DELETED with the prompts
  // vocabulary. `loadRuntimePluginPrompts` above is the surviving seam and
  // stays asserted.
]) {
  if (!runtimePluginLoader.includes(requiredHelper)) {
    errors.push(
      `runtime-plugin-loader.ts must define or import ${requiredHelper}.`,
    );
  }
}

const runtimePluginAssets = readRequiredSource(
  '../src-server/runtime/plugins/runtime-plugin-assets.ts',
);
for (const requiredHelper of [
  'export async function loadRuntimePluginAssets',
  './runtime-plugin-loader.js',
  'await loadProviders({',
  'await loadPrompts({',
]) {
  if (!runtimePluginAssets.includes(requiredHelper)) {
    errors.push(`runtime-plugin-assets.ts must include ${requiredHelper}.`);
  }
}

if (!stationRuntime.includes('./runtime-health.js')) {
  errors.push(
    'station-runtime.ts must delegate health-check orchestration to runtime-health.ts.',
  );
}
if (
  !stationRuntime.includes('./runtime-background-tasks.js') &&
  !runtimeInitialize.includes('./runtime-background-tasks.js')
) {
  errors.push(
    'station-runtime.ts must delegate startup/background tasks to runtime-background-tasks.ts.',
  );
}
if (
  !stationRuntime.includes('../agents/runtime-default-agent.js') &&
  !runtimeInitialize.includes('../agents/runtime-default-agent.js')
) {
  errors.push(
    'station-runtime.ts must delegate default-agent bootstrapping to runtime-default-agent.ts.',
  );
}
if (!stationRuntime.includes('../agents/runtime-voice-agent.js')) {
  errors.push(
    'station-runtime.ts must delegate voice-agent bootstrapping to runtime-voice-agent.ts.',
  );
}
if (!stationRuntime.includes('../agents/runtime-context-builder.js')) {
  errors.push(
    'station-runtime.ts must delegate runtime context assembly to runtime-context-builder.ts.',
  );
}
if (!stationRuntime.includes('../agents/runtime-agent-builder.js')) {
  errors.push(
    'station-runtime.ts must delegate agent construction to runtime-agent-builder.ts.',
  );
}
if (!stationRuntime.includes('../agents/runtime-template-variables.js')) {
  errors.push(
    'station-runtime.ts must delegate template-variable expansion to runtime-template-variables.ts.',
  );
}
if (!stationRuntime.includes('../agents/runtime-agent-lifecycle.js')) {
  errors.push(
    'station-runtime.ts must delegate agent reload/switch lifecycle to runtime-agent-lifecycle.ts.',
  );
}
if (!stationRuntime.includes('../plugins/runtime-provider-resolution.js')) {
  errors.push(
    'station-runtime.ts must delegate framework model and provider resolution helpers to runtime-provider-resolution.ts.',
  );
}
if (!stationRuntime.includes('./runtime-service-bootstrap.js')) {
  errors.push(
    'station-runtime.ts must delegate constructor service bootstrap to runtime-service-bootstrap.ts.',
  );
}
if (!stationRuntime.includes('./runtime-shutdown.js')) {
  errors.push(
    'station-runtime.ts must delegate shutdown orchestration to runtime-shutdown.ts.',
  );
}
if (
  !stationRuntime.includes('./runtime-startup.js') &&
  !runtimeInitialize.includes('./runtime-startup.js')
) {
  errors.push(
    'station-runtime.ts must delegate startup preparation to runtime-startup.ts.',
  );
}
if (!stationRuntime.includes('../routes/runtime-routes.js')) {
  errors.push(
    'station-runtime.ts must delegate HTTP route composition to runtime-routes.ts.',
  );
}
if (
  !stationRuntime.includes('../agents/runtime-agent-registry.js') &&
  !runtimeInitialize.includes('../agents/runtime-agent-registry.js')
) {
  errors.push(
    'station-runtime.ts must delegate dynamic agent initialization to runtime-agent-registry.ts.',
  );
}
for (const retiredInlineRuntimeSnippet of [
  'const checks: Record<string, boolean> = {',
  'userId: getCachedUser().alias',
  'const rawSystemPrompt = this.appConfig.systemPrompt ||',
  'const bundle = await this.framework.createAgent(',
  'const builtInReplacements: Record<string, string> = {',
  'const customReplacements: Record<string, string> = {}',
  'app.onError((err, c) => {',
  "app.use('*', async (c, next) => {",
  'const allowed = process.env.ALLOWED_ORIGINS?.split',
  'You are Station Voice, a hands-free voice assistant.',
  "const selfIntegrationId = 'station-control';",
  'Failed to load station-control tools for default agent',
  'Plugin updates available',
  'const msUntilMidnight = () => {',
  'const projects = this.storageAdapter?.listProjects() || [];',
  'const activeProject = projects[0]?.slug;',
  'const overrides = await this.configLoader.loadPluginOverrides();',
  "overrides['aws-internal']?.settings?.disableDefaultSkillRegistries",
  'new UsageAggregator(',
  'await runStartupMigrations(this.configLoader.getProjectHomeDir());',
  'this.storageAdapter.listProviderConnections()',
  'Seeded default Bedrock provider connection',
  "app.route('/api/models', modelsRoute);",
  'createSystemRoutes(',
  'createPluginRoutes(',
  'createConversationRoutes(',
  'new SchedulerService(this.logger)',
  'new NotificationService(',
  'const currentSlugs = new Set(agentMetadataList.map((m) => m.slug));',
  "this.eventBus.emit('agents:changed', { count: agentMetadataList.length });",
  "const savedDefaultMeta = this.agentMetadataMap.get('default');",
  'this.agentMetadataMap = new Map(',
  'const activeProject = getActiveRuntimeProjectSlug(this.storageAdapter);',
  "this.logger.info('Switching agent', { from: 'current', to: targetSlug });",
  'new FileStorageAdapter(',
  'new AgentService(',
  'new SkillService(',
  'new MCPService(',
  'new LayoutService(',
  'new ProjectService(',
  'new ProviderService(',
  'new KnowledgeService(',
  'new FileTreeService(',
  'new NodePtyAdapter(',
  'new FileTerminalHistoryStore(',
  'new TerminalService(',
  'new TerminalWebSocketServer(',
  'new VoiceSessionService(',
  'new MonitoringEmitter(',
  'new ACPManager(',
  'new ConnectionService(',
  'new FeedbackService(',
  "this.logger.info('Shutting down Station Runtime...')",
  'await this.schedulerService.stop();',
  'await this.acpBridge.shutdown();',
  'await this.voiceService.stop();',
  'await this.terminalService.dispose();',
  "this.logger.info('Shutdown complete')",
  'private async createBedrockModel(',
  'private async loadPluginPrompts(): Promise<void>',
  'private async loadPluginProviders(): Promise<void>',
  'private resolveVectorDbProvider()',
  'private resolveEmbeddingProvider()',
]) {
  if (stationRuntime.includes(retiredInlineRuntimeSnippet)) {
    errors.push(
      `station-runtime.ts must not inline extracted runtime helper logic ${retiredInlineRuntimeSnippet}.`,
    );
  }
}

if (!stationRuntime.includes('./runtime-initialize.js')) {
  errors.push(
    'station-runtime.ts must delegate startup sequencing to runtime-initialize.ts.',
  );
}
for (const requiredHelper of [
  'export async function initializeRuntime',
  '../plugins/runtime-plugin-assets.js',
  './runtime-background-tasks.js',
  '../agents/runtime-default-agent.js',
  './runtime-startup.js',
  '../agents/runtime-agent-registry.js',
  '../tools/runtime-control-tools.js',
]) {
  if (!runtimeInitialize.includes(requiredHelper)) {
    errors.push(`runtime-initialize.ts must include ${requiredHelper}.`);
  }
}

const runtimeAgentRegistry = readRequiredSource(
  '../src-server/runtime/agents/runtime-agent-registry.ts',
);
for (const requiredHelper of [
  'export async function initializeRuntimeAgents',
  'export function replaceRuntimeAgentMetadataMap',
  "context.logger.info('Found agents'",
  'agentMetadataMap.clear()',
]) {
  if (!runtimeAgentRegistry.includes(requiredHelper)) {
    errors.push(`runtime-agent-registry.ts must include ${requiredHelper}.`);
  }
}

const runtimeServiceBootstrap = readRequiredSource(
  '../src-server/runtime/bootstrap/runtime-service-bootstrap.ts',
);
for (const requiredHelper of [
  'export function createRuntimeServiceBundle',
  'new FileStorageAdapter(',
  'new AgentService(',
  'new SkillService(',
  'new MCPService(',
  'new LayoutService(',
  'new ProjectService(',
  'new ProviderService(',
  'new KnowledgeService(',
  'new FileTreeService(',
  'new NodePtyAdapter(',
  'new FileTerminalHistoryStore(',
  'new TerminalService(',
  'new TerminalWebSocketServer(',
  'terminalWsServer,',
  'new VoiceSessionService(',
  'new MonitoringEmitter(',
  'new ACPManager(',
  'new ConnectionService(',
  'new FeedbackService(',
]) {
  if (!runtimeServiceBootstrap.includes(requiredHelper)) {
    errors.push(`runtime-service-bootstrap.ts must include ${requiredHelper}.`);
  }
}

const toolExecutor = readRequiredSource(
  '../src-server/runtime/tools/tool-executor.ts',
);
if (!toolExecutor.includes('./tool-approval.js')) {
  errors.push(
    'tool-executor.ts must delegate approval matching to tool-approval.ts.',
  );
}
for (const retiredInlineUsageSnippet of [
  'export async function calculateCost(',
  'export function calculateContextWindowPercentage(',
  'export function isAutoApproved(',
  'export function wrapToolWithElicitation(',
  "logger.info('[Usage Stats]'",
  "logger.info('[Token Breakdown]'",
  'await memory.updateConversation(',
  'otelContextTokens.add(',
  "logger.error('Failed to enrich message with model metadata'",
]) {
  if (toolExecutor.includes(retiredInlineUsageSnippet)) {
    errors.push(
      `tool-executor.ts must not inline shared usage helper ${retiredInlineUsageSnippet}.`,
    );
  }
}

const toolApproval = readRequiredSource(
  '../src-server/runtime/tools/tool-approval.ts',
);
for (const requiredHelper of ['export function isAutoApproved']) {
  if (!toolApproval.includes(requiredHelper)) {
    errors.push(`tool-approval.ts must include ${requiredHelper}.`);
  }
}

const toolExecutionUsage = readRequiredSource(
  '../src-server/runtime/tools/tool-execution-usage.ts',
);
for (const requiredHelper of [
  'export async function recordToolExecutionUsage',
  "logger.info('[Usage Stats]'",
  "logger.info('[Token Breakdown]'",
  'await memory.updateConversation(',
  'otelContextTokens.add(',
  "logger.error('Failed to enrich message with model metadata'",
]) {
  if (!toolExecutionUsage.includes(requiredHelper)) {
    errors.push(`tool-execution-usage.ts must include ${requiredHelper}.`);
  }
}

const agentHooks = readRequiredSource(
  '../src-server/runtime/agents/agent-hooks.ts',
);
if (!agentHooks.includes('../conversation/usage-stats.js')) {
  errors.push(
    'agent-hooks.ts must share runtime usage math through usage-stats.ts.',
  );
}
if (agentHooks.includes('async function calculateCost(')) {
  errors.push(
    'agent-hooks.ts must not inline calculateCost once usage-stats.ts exists.',
  );
}

const conversationManager = readRequiredSource(
  '../src-server/runtime/conversation/conversation-manager.ts',
);
if (!conversationManager.includes('./conversation-stats-view.js')) {
  errors.push(
    'conversation-manager.ts must delegate stats view shaping to conversation-stats-view.ts.',
  );
}
for (const retiredConversationSnippet of [
  'calculateContextWindowPercentage(',
  'getMessageTextContent',
  'const contextTokens = systemPromptTokens + mcpServerTokens;',
  'contextFilesTokens: 0',
]) {
  if (conversationManager.includes(retiredConversationSnippet)) {
    errors.push(
      `conversation-manager.ts must not inline extracted conversation stats helper ${retiredConversationSnippet}.`,
    );
  }
}

const conversationStatsView = readRequiredSource(
  '../src-server/runtime/conversation/conversation-stats-view.ts',
);
for (const requiredHelper of [
  'export function buildEmptyConversationStatsView',
  'export function resolveConversationUserMessageTokens',
  'export function buildConversationStatsView',
  'calculateContextWindowPercentage',
  'getMessageTextContent',
]) {
  if (!conversationStatsView.includes(requiredHelper)) {
    errors.push(`conversation-stats-view.ts must include ${requiredHelper}.`);
  }
}

const runtimeShutdown = readRequiredSource(
  '../src-server/runtime/bootstrap/runtime-shutdown.ts',
);
for (const requiredHelper of [
  'export async function shutdownRuntimeServices',
  "logger.info('Shutting down Station Runtime...')",
  "'schedulerService.stop'",
  'mcpConfigs.clear();',
  'activeAgents.clear();',
  "'acpBridge.shutdown'",
  "'voiceService.stop'",
  "'terminalService.dispose'",
  "logger.info('Shutdown complete')",
]) {
  if (!runtimeShutdown.includes(requiredHelper)) {
    errors.push(`runtime-shutdown.ts must include ${requiredHelper}.`);
  }
}

const runtimeProviderResolution = readRequiredSource(
  '../src-server/runtime/plugins/runtime-provider-resolution.ts',
);
for (const requiredHelper of [
  'export async function createRuntimeFrameworkModel',
  'export function resolveRuntimeVectorDbProvider',
  'export function resolveRuntimeEmbeddingProvider',
  '../providers/connection-factories.js',
  'options.framework.createModel(',
]) {
  if (!runtimeProviderResolution.includes(requiredHelper)) {
    errors.push(
      `runtime-provider-resolution.ts must include ${requiredHelper}.`,
    );
  }
}

const strandsAdapter = readRequiredSource(
  '../src-server/runtime/frameworks/strands-adapter.ts',
);
if (!strandsAdapter.includes('./strands-stream-events.js')) {
  errors.push(
    'strands-adapter.ts must delegate stream event mapping to strands-stream-events.ts.',
  );
}
if (
  !strandsAdapter.includes('./strands-message-sync.js') &&
  !strandsAdapter.includes('./strands-agent-hooks.js')
) {
  errors.push(
    'Strands message persistence sync must stay delegated out of strands-adapter.ts.',
  );
}
if (!strandsAdapter.includes('./strands-tool-loader.js')) {
  errors.push(
    'strands-adapter.ts must delegate MCP tool loading to strands-tool-loader.ts.',
  );
}
if (!strandsAdapter.includes('./strands-agent-hooks.js')) {
  errors.push(
    'strands-adapter.ts must delegate Strands hook wiring to strands-agent-hooks.ts.',
  );
}
for (const retiredInlineStrandsSnippet of [
  "if (event.type === 'modelStreamUpdateEvent') {",
  "if (event.type === 'toolResultEvent') {",
  'const existing = await memoryAdapter.getMessages(',
  'const delta = agentMessages.slice(existing?.length || 0);',
  'for (const block of msg.content || []) {',
  'strandsAgent.hooks.addCallback(BeforeToolCallEvent',
  'strandsAgent.hooks.addCallback(AfterToolCallEvent',
  'strandsAgent.hooks.addCallback(AfterInvocationEvent',
  'new McpClient({',
]) {
  if (strandsAdapter.includes(retiredInlineStrandsSnippet)) {
    errors.push(
      `strands-adapter.ts must not inline extracted Strands helper logic ${retiredInlineStrandsSnippet}.`,
    );
  }
}

const strandsStreamEvents = readRequiredSource(
  '../src-server/runtime/frameworks/strands-stream-events.ts',
);
for (const requiredHelper of [
  'export function mapStrandsStreamEvent',
  "if (event.type === 'modelStreamUpdateEvent') {",
  "if (event.type === 'toolResultEvent') {",
]) {
  if (!strandsStreamEvents.includes(requiredHelper)) {
    errors.push(`strands-stream-events.ts must include ${requiredHelper}.`);
  }
}

const strandsMessageSync = readRequiredSource(
  '../src-server/runtime/frameworks/strands-message-sync.ts',
);
for (const requiredHelper of [
  'export function mapStrandsContentBlocksToParts',
  'export async function syncStrandsMessagesToMemory',
  'const delta = agentMessages.slice(existing?.length || 0);',
  'await memoryAdapter.addMessage(',
]) {
  if (!strandsMessageSync.includes(requiredHelper)) {
    errors.push(`strands-message-sync.ts must include ${requiredHelper}.`);
  }
}

const strandsToolLoader = readRequiredSource(
  '../src-server/runtime/frameworks/strands-tool-loader.ts',
);
for (const requiredHelper of [
  'export function createStrandsFunctionTools',
  'export function applyStrandsAvailableToolFilter',
  'export async function loadStrandsTools',
  'export async function destroyStrandsAgentTools',
  // #1428 moved MCP client construction behind the local-connection custody
  // owner so a client cannot exist without a current custody claim. The
  // loader must obtain every client through that owner, never construct one.
  "from './strands-mcp-custody.js'",
  'createCustodiedStrandsClient(',
]) {
  if (!strandsToolLoader.includes(requiredHelper)) {
    errors.push(`strands-tool-loader.ts must include ${requiredHelper}.`);
  }
}
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

const strandsMcpCustody = readRequiredSource(
  '../src-server/runtime/frameworks/strands-mcp-custody.ts',
);
for (const requiredHelper of [
  'export function createCustodiedStrandsClient',
  'new StdioClientTransport(',
  'new McpClient({',
]) {
  if (!strandsMcpCustody.includes(requiredHelper)) {
    errors.push(`strands-mcp-custody.ts must include ${requiredHelper}.`);
  }
}

const strandsAgentHooks = readRequiredSource(
  '../src-server/runtime/frameworks/strands-agent-hooks.ts',
);
for (const requiredHelper of [
  'export function wireStrandsAgentHooks',
  'BeforeToolCallEvent',
  'AfterToolCallEvent',
  'AfterInvocationEvent',
  'syncStrandsMessagesToMemory',
]) {
  if (!strandsAgentHooks.includes(requiredHelper)) {
    errors.push(`strands-agent-hooks.ts must include ${requiredHelper}.`);
  }
}

const runtimeStartup = readRequiredSource(
  '../src-server/runtime/bootstrap/runtime-startup.ts',
);
for (const requiredHelper of [
  'export function getActiveRuntimeProjectSlug',
  'export function shouldRegisterRuntimeDefaultSkillRegistry',
  'export function initializeRuntimeUsageAggregator',
  'export async function seedRuntimeDefaultProviderConnection',
  'export async function prepareRuntimeStartup',
  "pluginOverrides['aws-internal']?.settings?.disableDefaultSkillRegistries",
  "type: 'bedrock'",
]) {
  if (!runtimeStartup.includes(requiredHelper)) {
    errors.push(`runtime-startup.ts must define or include ${requiredHelper}.`);
  }
}

const runtimeRoutes = readRequiredSource(
  '../src-server/runtime/routes/runtime-routes.ts',
);
for (const requiredHelper of [
  'export function configureRuntimeRoutes',
  '../bootstrap/runtime-http.js',
  './runtime-route-support.js',
  'createRuntimeSystemRouteDeps(context)',
  'configureRuntimeSupportServices(context, flowRunService)',
  'createPluginRoutes(',
  'createConversationRoutes(',
]) {
  if (!runtimeRoutes.includes(requiredHelper)) {
    errors.push(`runtime-routes.ts must define or include ${requiredHelper}.`);
  }
}
for (const retiredInlineRuntimeRoutesSnippet of [
  'const schedulerService = new SchedulerService(',
  'const notificationService = new NotificationService(',
  'context.providerService.listProviderConnections().map(',
]) {
  if (runtimeRoutes.includes(retiredInlineRuntimeRoutesSnippet)) {
    errors.push(
      `runtime-routes.ts must not inline extracted runtime support logic ${retiredInlineRuntimeRoutesSnippet}.`,
    );
  }
}

const runtimeRouteSupport = readRequiredSource(
  '../src-server/runtime/routes/runtime-route-support.ts',
);
for (const requiredHelper of [
  'export function createRuntimeSystemRouteDeps',
  'export function configureRuntimeSupportServices',
  'new SchedulerService(',
  'new NotificationService(',
  'getNotificationProviders()',
  'checkOllamaAvailability: context.checkOllamaAvailability',
]) {
  if (!runtimeRouteSupport.includes(requiredHelper)) {
    errors.push(
      `runtime-route-support.ts must define or include ${requiredHelper}.`,
    );
  }
}

const mcpManager = readRequiredSource(
  '../src-server/runtime/mcp/mcp-manager.ts',
);
for (const requiredHelper of [
  '../tools/mcp-tool-names.js',
  'normalizeLoadedMCPTools(',
  'matchMCPToolPattern(',
  'resolveOriginalToolName(',
  'resolveNormalizedToolName(',
]) {
  if (!mcpManager.includes(requiredHelper)) {
    errors.push(`mcp-manager.ts must include ${requiredHelper}.`);
  }
}
for (const retiredInlineMcpManagerSnippet of [
  'const normalized = normalizeToolName(tool.name);',
  'const parsed = parseToolName(tool.name);',
  "if (pattern.endsWith('_*')) {",
  "if (pattern.endsWith('/*')) {",
  'const mapping = toolNameMapping.get(normalizedName);',
  'return toolNameReverseMapping.get(originalName) || originalName;',
]) {
  if (mcpManager.includes(retiredInlineMcpManagerSnippet)) {
    errors.push(
      `mcp-manager.ts must not inline extracted MCP name helper logic ${retiredInlineMcpManagerSnippet}.`,
    );
  }
}

const mcpToolNames = readRequiredSource(
  '../src-server/runtime/tools/mcp-tool-names.ts',
);
for (const requiredHelper of [
  'export interface MCPToolNameMappingEntry',
  'export function normalizeLoadedMCPTools',
  'export function matchesToolPattern',
  'export function getOriginalToolName',
  'export function getNormalizedToolName',
  'normalizeToolName(',
  'parseToolName(',
]) {
  if (!mcpToolNames.includes(requiredHelper)) {
    errors.push(`mcp-tool-names.ts must define or include ${requiredHelper}.`);
  }
}

const runtimeHealth = readRequiredSource(
  '../src-server/runtime/bootstrap/runtime-health.ts',
);
for (const requiredHelper of [
  'export async function runRuntimeHealthChecks',
  'export async function startRuntimeHealthChecks',
  '../../routes/system/auth.js',
  'emitHealth(',
]) {
  if (!runtimeHealth.includes(requiredHelper)) {
    errors.push(`runtime-health.ts must include ${requiredHelper}.`);
  }
}

const runtimeHttp = readRequiredSource(
  '../src-server/runtime/bootstrap/runtime-http.ts',
);
for (const requiredHelper of [
  'export function configureRuntimeHttp',
  'export function resolveRuntimeCorsOrigin',
  "from 'hono/cors'",
  '../utils/auth-errors.js',
]) {
  if (!runtimeHttp.includes(requiredHelper)) {
    errors.push(`runtime-http.ts must include ${requiredHelper}.`);
  }
}

const runtimeContextBuilder = readRequiredSource(
  '../src-server/runtime/agents/runtime-context-builder.ts',
);
for (const requiredHelper of [
  'export function buildRuntimeContext',
  "import type { RuntimeContext } from '../types.js';",
]) {
  if (!runtimeContextBuilder.includes(requiredHelper)) {
    errors.push(`runtime-context-builder.ts must include ${requiredHelper}.`);
  }
}

const runtimeAgentBuilder = readRequiredSource(
  '../src-server/runtime/agents/runtime-agent-builder.ts',
);
for (const requiredHelper of [
  'export async function buildRuntimeAgentInstance',
  'createAgentHooks',
  'FileMemoryAdapter',
  'function applyRuntimeAgentBundle',
]) {
  if (!runtimeAgentBuilder.includes(requiredHelper)) {
    errors.push(`runtime-agent-builder.ts must include ${requiredHelper}.`);
  }
}

const runtimeAgentLifecycle = readRequiredSource(
  '../src-server/runtime/agents/runtime-agent-lifecycle.ts',
);
for (const requiredHelper of [
  'export async function reloadRuntimeAgents',
  'export async function reloadRuntimeSkillsAndAgents',
  'export async function switchRuntimeAgent',
  'getActiveRuntimeProjectSlug',
]) {
  if (!runtimeAgentLifecycle.includes(requiredHelper)) {
    errors.push(`runtime-agent-lifecycle.ts must include ${requiredHelper}.`);
  }
}

const runtimeTemplateVariables = readRequiredSource(
  '../src-server/runtime/agents/runtime-template-variables.ts',
);
for (const requiredHelper of [
  'export function replaceRuntimeTemplateVariables',
  '../../routes/system/auth.js',
  'function getBuiltInTemplateVariables',
  'function getCustomTemplateVariables',
]) {
  if (!runtimeTemplateVariables.includes(requiredHelper)) {
    errors.push(
      `runtime-template-variables.ts must include ${requiredHelper}.`,
    );
  }
}

const runtimeVoiceAgent = readRequiredSource(
  '../src-server/runtime/agents/runtime-voice-agent.ts',
);
for (const requiredHelper of [
  'export function createRuntimeVoiceAgentSpec',
  'export async function bootstrapRuntimeVoiceAgent',
  'const STATION_VOICE_PROMPT',
]) {
  if (!runtimeVoiceAgent.includes(requiredHelper)) {
    errors.push(`runtime-voice-agent.ts must include ${requiredHelper}.`);
  }
}

const runtimeDefaultAgent = readRequiredSource(
  '../src-server/runtime/agents/runtime-default-agent.ts',
);
for (const requiredHelper of [
  'export function createRuntimeSelfIntegration',
  'export async function bootstrapRuntimeDefaultAgent',
  "const selfIntegrationId = 'station-control';",
]) {
  if (!runtimeDefaultAgent.includes(requiredHelper)) {
    errors.push(`runtime-default-agent.ts must include ${requiredHelper}.`);
  }
}

const runtimeBackgroundTasks = readRequiredSource(
  '../src-server/runtime/bootstrap/runtime-background-tasks.ts',
);
for (const requiredHelper of [
  'export function mergeRuntimeACPConnections',
  'export function scheduleRuntimeDailyReload',
  'export function startRuntimeACPConnections',
  'export function scheduleRuntimePluginUpdateCheck',
]) {
  if (!runtimeBackgroundTasks.includes(requiredHelper)) {
    errors.push(`runtime-background-tasks.ts must include ${requiredHelper}.`);
  }
}

const knowledgeService = readRequiredSource(
  '../src-server/services/knowledge/knowledge-service.ts',
);
if (!knowledgeService.includes('./knowledge-context.js')) {
  errors.push(
    'knowledge-service.ts must delegate context/retrieval helpers to knowledge-context.ts.',
  );
}
if (!knowledgeService.includes('./knowledge-namespaces.js')) {
  errors.push(
    'knowledge-service.ts must delegate namespace/storage helpers to knowledge-namespaces.ts.',
  );
}
if (!knowledgeService.includes('./knowledge-filesystem.js')) {
  errors.push(
    'knowledge-service.ts must delegate filesystem/listing helpers to knowledge-filesystem.ts.',
  );
}
if (!knowledgeService.includes('./knowledge-documents.js')) {
  errors.push(
    'knowledge-service.ts must delegate document CRUD helpers to knowledge-documents.ts.',
  );
}
for (const retiredInlineKnowledgeSnippet of [
  'const relevant = results.filter((r) => r.score >= threshold);',
  'const sections: string[] = [];',
  'const byDoc = new Map<',
  'const seen = new Set<string>();',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source-expectation string deliberately contains an interpolation
  "throw new Error(`Cannot remove built-in namespace '${namespaceId}'`);",
  'const buildTree = (dir: string, relPath: string): KnowledgeTreeNode => {',
  'const allowedExts = extensions',
  'const filtered = this.applyPatterns(',
  'private applyPatterns(',
  'private collectFiles(',
  'const ns = knowledgeVectorNamespace(projectSlug, namespace);',
  'const fileContent = readKnowledgeFile(storageDir, filePath);',
  'const oldChunkIds = Array.from(',
]) {
  if (knowledgeService.includes(retiredInlineKnowledgeSnippet)) {
    errors.push(
      `knowledge-service.ts must not inline extracted knowledge helper logic ${retiredInlineKnowledgeSnippet}.`,
    );
  }
}

const knowledgeContext = readRequiredSource(
  '../src-server/services/knowledge/knowledge-context.ts',
);
for (const requiredHelper of [
  'export function buildKnowledgeRagContext',
  'export async function buildKnowledgeInjectContext',
  'export async function findKnowledgeDocumentNamespace',
  'readKnowledgeDocuments',
  'knowledgeVectorNamespace',
]) {
  if (!knowledgeContext.includes(requiredHelper)) {
    errors.push(`knowledge-context.ts must include ${requiredHelper}.`);
  }
}

const knowledgeNamespaces = readRequiredSource(
  '../src-server/services/knowledge/knowledge-namespaces.ts',
);
for (const requiredHelper of [
  'export function listKnowledgeNamespaces',
  'export function getKnowledgeNamespaceConfig',
  'export function resolveKnowledgeStorageDir',
  'export async function registerKnowledgeNamespace',
  'export async function removeKnowledgeNamespace',
  'export async function updateKnowledgeNamespace',
]) {
  if (!knowledgeNamespaces.includes(requiredHelper)) {
    errors.push(`knowledge-namespaces.ts must include ${requiredHelper}.`);
  }
}

const knowledgeDocuments = readRequiredSource(
  '../src-server/services/knowledge/knowledge-documents.ts',
);
for (const requiredHelper of [
  'export async function uploadKnowledgeDocument',
  'export async function deleteKnowledgeDocument',
  'export async function getKnowledgeDocumentContent',
  'export async function updateKnowledgeDocument',
  'knowledgeVectorNamespace(',
  'mutateKnowledgeDocuments(',
  'readKnowledgeDocuments(',
]) {
  if (!knowledgeDocuments.includes(requiredHelper)) {
    errors.push(`knowledge-documents.ts must include ${requiredHelper}.`);
  }
}

const knowledgeFilesystem = readRequiredSource(
  '../src-server/services/knowledge/knowledge-filesystem.ts',
);
if (!knowledgeFilesystem.includes('./knowledge-scan-utils.js')) {
  errors.push(
    'knowledge-filesystem.ts must delegate scan/filter helpers to knowledge-scan-utils.ts.',
  );
}
for (const requiredHelper of [
  'export async function listKnowledgeDocuments',
  'export async function buildKnowledgeDirectoryTree',
  'export async function scanKnowledgeDirectories',
  'matchesKnowledgeFilter',
  'collectKnowledgeFiles',
]) {
  if (!knowledgeFilesystem.includes(requiredHelper)) {
    errors.push(`knowledge-filesystem.ts must include ${requiredHelper}.`);
  }
}
for (const retiredKnowledgeFilesystemSnippet of [
  'const DEFAULT_EXTENSIONS = new Set([',
  'const SKIP_DIRS = new Set([',
  'function resolveKnowledgeScanPath(',
  'function normalizeExtension(',
  'function applyScanPatterns(',
  'function globMatch(',
  'function collectKnowledgeFiles(',
]) {
  if (knowledgeFilesystem.includes(retiredKnowledgeFilesystemSnippet)) {
    errors.push(
      `knowledge-filesystem.ts must not inline extracted scan helper ${retiredKnowledgeFilesystemSnippet}.`,
    );
  }
}

const knowledgeScanUtils = readRequiredSource(
  '../src-server/services/knowledge/knowledge-scan-utils.ts',
);
for (const requiredHelper of [
  'export function matchesKnowledgeFilter',
  'export async function resolveKnowledgeScanPath',
  'export function normalizeKnowledgeExtension',
  'export function applyKnowledgeScanPatterns',
  'export function collectKnowledgeFiles',
  'const DEFAULT_EXTENSIONS = new Set([',
]) {
  if (!knowledgeScanUtils.includes(requiredHelper)) {
    errors.push(`knowledge-scan-utils.ts must include ${requiredHelper}.`);
  }
}

const skillService = readRequiredSource(
  '../src-server/services/agents/skill-service.ts',
);
if (!skillService.includes('./skill-service-install.js')) {
  errors.push(
    'skill-service.ts must delegate registry install/remove helpers to skill-service-install.ts.',
  );
}
for (const retiredInlineSkillSnippet of [
  'const targetDir = projectSlug',
  "message: 'No skill registry configured'",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source-expectation string deliberately contains an interpolation
  'message: `No skill registry provider could install ${name}`',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source-expectation string deliberately contains an interpolation
  "message: `Skill '${name}' not found`",
  'await rm(targetDir, { recursive: true, force: true });',
]) {
  if (skillService.includes(retiredInlineSkillSnippet)) {
    errors.push(
      `skill-service.ts must not inline extracted skill install/remove logic ${retiredInlineSkillSnippet}.`,
    );
  }
}

const skillServiceInstall = readRequiredSource(
  '../src-server/services/agents/skill-service-install.ts',
);
for (const requiredHelper of [
  'export async function installSkillFromRegistry',
  'export async function removeInstalledSkill',
  'No skill registry configured',
  "source: 'registry'",
]) {
  if (!skillServiceInstall.includes(requiredHelper)) {
    errors.push(`skill-service-install.ts must include ${requiredHelper}.`);
  }
}

const memoryAdapter = readRequiredSource(
  '../src-server/adapters/file/memory-adapter.ts',
);
for (const requiredImport of [
  './memory-adapter-conversations.js',
  './memory-adapter-messages.js',
  './memory-adapter-paths.js',
  './memory-adapter-state.js',
]) {
  if (!memoryAdapter.includes(requiredImport)) {
    errors.push(
      `memory-adapter.ts must delegate extracted helpers to ${requiredImport}.`,
    );
  }
}
for (const requiredHelperCall of [
  'await addStoredMessage({',
  'await addStoredMessages({',
  'return readStoredMessages({',
  'await clearStoredMessages({',
  'await removeLastStoredMessage({',
]) {
  if (!memoryAdapter.includes(requiredHelperCall)) {
    errors.push(
      `memory-adapter.ts must delegate message operations through ${requiredHelperCall}.`,
    );
  }
}
for (const retiredInlineMemoryHelper of [
  'private applyQueryOptions(',
  'private serializeWorkflowState(',
  'private deserializeWorkflowState(',
  'private getAgentsDir(): string {',
  'private getConversationPath(',
  'private getMessagesPath(',
  'private sanitizeId(',
  'const legacyPath = join(',
  'const payload = {',
  'const dir = this.paths.getWorkflowStatesDir();',
  "state.status === 'suspended' &&",
]) {
  if (memoryAdapter.includes(retiredInlineMemoryHelper)) {
    errors.push(
      `memory-adapter.ts must not inline extracted helper ${retiredInlineMemoryHelper}.`,
    );
  }
}

const memoryAdapterMessages = readRequiredSource(
  '../src-server/adapters/file/memory-adapter-messages.ts',
);
for (const requiredHelper of [
  'export async function addStoredMessage',
  'export async function addStoredMessages',
  'export async function readStoredMessages',
  'export async function clearStoredMessages',
  'export async function removeLastStoredMessage',
]) {
  if (!memoryAdapterMessages.includes(requiredHelper)) {
    errors.push(`memory-adapter-messages.ts must include ${requiredHelper}.`);
  }
}

const memoryAdapterPaths = readRequiredSource(
  '../src-server/adapters/file/memory-adapter-paths.ts',
);
for (const requiredHelper of [
  'export class MemoryAdapterPaths',
  'getAgentsDir(): string',
  'getConversationPath(resourceId: string, conversationId: string): string',
  'getMessagesPath(resourceId: string, conversationId: string): string',
  'sanitizeId(id: string): string',
]) {
  if (!memoryAdapterPaths.includes(requiredHelper)) {
    errors.push(`memory-adapter-paths.ts must include ${requiredHelper}.`);
  }
}

const memoryAdapterConversations = readRequiredSource(
  '../src-server/adapters/file/memory-adapter-conversations.ts',
);
for (const requiredHelper of [
  'export function applyConversationQueryOptions',
  "const orderBy = options.orderBy ?? 'updated_at';",
  'return filtered.slice(offset, offset + limit);',
]) {
  if (!memoryAdapterConversations.includes(requiredHelper)) {
    errors.push(
      `memory-adapter-conversations.ts must include ${requiredHelper}.`,
    );
  }
}

const memoryAdapterWorkflows = readRequiredSource(
  '../src-server/adapters/file/memory-adapter-workflows.ts',
);
for (const requiredHelper of [
  'export type WorkflowStateJson',
  'export function serializeWorkflowState',
  'export function deserializeWorkflowState',
  'suspendedAt: suspension.suspendedAt.toISOString()',
]) {
  if (!memoryAdapterWorkflows.includes(requiredHelper)) {
    errors.push(`memory-adapter-workflows.ts must include ${requiredHelper}.`);
  }
}

const memoryAdapterState = readRequiredSource(
  '../src-server/adapters/file/memory-adapter-state.ts',
);
for (const requiredHelper of [
  'export async function getWorkingMemoryState',
  'export async function setWorkingMemoryState',
  'export async function deleteWorkingMemoryState',
  'export async function getWorkflowStateEntry',
  'export async function setWorkflowStateEntry',
  'export async function getSuspendedWorkflowStateEntries',
]) {
  if (!memoryAdapterState.includes(requiredHelper)) {
    errors.push(`memory-adapter-state.ts must include ${requiredHelper}.`);
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
  [
    '../src-server/services/plugins/template-service.ts',
    '../providers/provider-interfaces.js',
  ],
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

const builtinScheduler = readRequiredSource(
  '../src-server/services/scheduling/builtin-scheduler.ts',
);
for (const requiredHelper of [
  "from './scheduler-ledger.js'",
  "from './builtin-scheduler-execution.js'",
  'createSchedulerLedger',
  'executeSchedulerJobAttempt',
]) {
  if (!builtinScheduler.includes(requiredHelper)) {
    errors.push(
      `src-server/services/scheduling/builtin-scheduler.ts must include ${requiredHelper}.`,
    );
  }
}
for (const retiredInlineSchedulerSnippet of [
  "const DATA_DIR = join(resolveHomeDir(), 'scheduler');",
  "const JOBS_FILE = join(DATA_DIR, 'jobs.json');",
  "const LOGS_DIR = join(DATA_DIR, 'logs');",
  'const JOB_TIMEOUT = 10 * 60_000;',
  "event: 'job.completed'",
  "event: 'job.failed'",
  "event: 'job.retrying'",
]) {
  if (builtinScheduler.includes(retiredInlineSchedulerSnippet)) {
    errors.push(
      `src-server/services/scheduling/builtin-scheduler.ts must not inline extracted scheduler storage logic ${retiredInlineSchedulerSnippet}.`,
    );
  }
}

const schedulerLedger = readRequiredSource(
  '../src-server/services/scheduling/scheduler-ledger.ts',
);
for (const requiredHelper of [
  'export interface SchedulerLedger',
  'export function createSchedulerLedger',
  'export class SchedulerStorageUnavailableError',
  'scheduler_claims',
]) {
  if (!schedulerLedger.includes(requiredHelper)) {
    errors.push(
      `src-server/services/scheduling/scheduler-ledger.ts must include ${requiredHelper}.`,
    );
  }
}

const builtinSchedulerExecution = readRequiredSource(
  '../src-server/services/scheduling/builtin-scheduler-execution.ts',
);
for (const requiredHelper of [
  'export async function executeSchedulerJobAttempt',
  'const JOB_TIMEOUT = 10 * 60_000;',
  "event: 'job.completed'",
  "event: 'job.failed'",
  "outcome: recorded.kind === 'claimed' ? 'retrying' : 'not-invoked'",
]) {
  if (!builtinSchedulerExecution.includes(requiredHelper)) {
    errors.push(
      `src-server/services/scheduling/builtin-scheduler-execution.ts must include ${requiredHelper}.`,
    );
  }
}

const providerRegistry = readRequiredSource(
  '../src-server/providers/registries/registry.ts',
);
for (const retiredInlineProviderRegistrySnippet of [
  'function readDiskIntegrations(',
  'const diskItems = readDiskIntegrations();',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source-expectation string deliberately contains an interpolation
  'No provider could install command ${command}',
]) {
  if (providerRegistry.includes(retiredInlineProviderRegistrySnippet)) {
    errors.push(
      `src-server/providers/registries/registry.ts must not inline extracted integration registry logic ${retiredInlineProviderRegistrySnippet}.`,
    );
  }
}

const integrationRegistryProvider = readRequiredSource(
  '../src-server/providers/registries/integration-registry-provider.ts',
);
for (const requiredHelper of [
  'export async function readDiskIntegrations',
  'export function mergeRegistryItems',
  'export function createIntegrationRegistryProvider',
]) {
  if (!integrationRegistryProvider.includes(requiredHelper)) {
    errors.push(
      `src-server/providers/registries/integration-registry-provider.ts must include ${requiredHelper}.`,
    );
  }
}

const routeSchemas = readRequiredSource(
  '../src-server/routes/schemas/schemas.ts',
);
for (const requiredHelper of [
  "export * from './schema-definitions.js';",
  "export * from './schema-validation.js';",
]) {
  if (!routeSchemas.includes(requiredHelper)) {
    errors.push(
      `src-server/routes/schemas/schemas.ts must include ${requiredHelper}.`,
    );
  }
}
for (const retiredInlineSchemaSnippet of [
  'export const acpConnectionSchema = z.object({',
  'export function validate<T>(',
  'export function getBody(c: Context): any',
]) {
  if (routeSchemas.includes(retiredInlineSchemaSnippet)) {
    errors.push(
      `src-server/routes/schemas/schemas.ts must not inline extracted schema logic ${retiredInlineSchemaSnippet}.`,
    );
  }
}

const routeSchemaDefinitions = readRequiredSource(
  '../src-server/routes/schemas/schema-definitions.ts',
);
for (const requiredHelper of [
  "export * from './schema-definitions/runtime.js';",
  "export * from './schema-definitions/scheduler.js';",
  "export * from './schema-definitions/content.js';",
  "export * from './schema-definitions/system.js';",
]) {
  if (!routeSchemaDefinitions.includes(requiredHelper)) {
    errors.push(
      `src-server/routes/schemas/schema-definitions.ts must include ${requiredHelper}.`,
    );
  }
}
for (const retiredInlineSchemaDefinition of [
  'export const acpConnectionSchema',
  'export const pluginInstallSchema',
  'export const skillCreateSchema',
  "import { validateCron } from '../services/cron.js';",
]) {
  if (routeSchemaDefinitions.includes(retiredInlineSchemaDefinition)) {
    errors.push(
      `src-server/routes/schemas/schema-definitions.ts must not inline extracted schema logic ${retiredInlineSchemaDefinition}.`,
    );
  }
}

const routeRuntimeSchemas = readRequiredSource(
  '../src-server/routes/schemas/schema-definitions/runtime.ts',
);
for (const requiredHelper of [
  'export const acpConnectionSchema',
  'export const invokeSchema',
  'export const chatSchema',
  'export const providerSchema',
]) {
  if (!routeRuntimeSchemas.includes(requiredHelper)) {
    errors.push(
      `src-server/routes/schemas/schema-definitions/runtime.ts must include ${requiredHelper}.`,
    );
  }
}

const routeSchedulerSchemas = readRequiredSource(
  '../src-server/routes/schemas/schema-definitions/scheduler.ts',
);
for (const requiredHelper of [
  "import { validateSchedule } from '@kontourai/ephemeris';",
  'export const addJobSchema',
  'export const editJobSchema',
  'export const schedulerOpenSchema',
]) {
  if (!routeSchedulerSchemas.includes(requiredHelper)) {
    errors.push(
      `src-server/routes/schemas/schema-definitions/scheduler.ts must include ${requiredHelper}.`,
    );
  }
}

const routeContentSchemas = readRequiredSource(
  '../src-server/routes/schemas/schema-definitions/content.ts',
);
for (const requiredHelper of [
  // station#3879: no `promptCreateSchema` — `/api/prompts` is deleted with
  // no alias, and a payload naming `prompts` is now a schema REJECTION
  // (AGENTS.md). Asserting the schema exists would assert the opposite of
  // the contract.
  'export const projectCreateSchema',
  'export const agentCreateSchema',
  'export const templateCreateSchema',
]) {
  if (!routeContentSchemas.includes(requiredHelper)) {
    errors.push(
      `src-server/routes/schemas/schema-definitions/content.ts must include ${requiredHelper}.`,
    );
  }
}

const routeSystemSchemas = readRequiredSource(
  '../src-server/routes/schemas/schema-definitions/system.ts',
);
for (const requiredHelper of [
  'export const notificationCreateSchema',
  'export const pluginInstallSchema',
  'export const feedbackDeleteSchema',
  'export const skillCreateSchema',
]) {
  if (!routeSystemSchemas.includes(requiredHelper)) {
    errors.push(
      `src-server/routes/schemas/schema-definitions/system.ts must include ${requiredHelper}.`,
    );
  }
}

const routeSchemaValidation = readRequiredSource(
  '../src-server/routes/schemas/schema-validation.ts',
);
for (const requiredHelper of [
  'export function validate<T>(',
  'export function getBody(c: Context): any',
  'export function param(c: Context, name: string): string',
  'export function errorMessage(error: unknown): string',
]) {
  if (!routeSchemaValidation.includes(requiredHelper)) {
    errors.push(
      `src-server/routes/schemas/schema-validation.ts must include ${requiredHelper}.`,
    );
  }
}

const knowledgeRoute = readRequiredSource(
  '../src-server/routes/knowledge/knowledge.ts',
);
for (const requiredHelper of [
  './knowledge-document-routes.js',
  './knowledge-cross-project.js',
  'createKnowledgeDocumentRoutes(',
  'createCrossProjectKnowledgeRouteHandlers(',
]) {
  if (!knowledgeRoute.includes(requiredHelper)) {
    errors.push(
      `src-server/routes/knowledge/knowledge.ts must include ${requiredHelper}.`,
    );
  }
}
for (const retiredInlineKnowledgeSnippet of [
  'function knowledgeHandlers(',
  "app.get('/status', async (c) => {",
  "app.post('/search', validate(knowledgeSearchSchema), async (c) => {",
]) {
  if (knowledgeRoute.includes(retiredInlineKnowledgeSnippet)) {
    errors.push(
      `src-server/routes/knowledge/knowledge.ts must not inline extracted knowledge route logic ${retiredInlineKnowledgeSnippet}.`,
    );
  }
}

const knowledgeDocumentRoutes = readRequiredSource(
  '../src-server/routes/knowledge/knowledge-document-routes.ts',
);
for (const requiredHelper of [
  'export function createKnowledgeDocumentRoutes',
  'knowledgeBulkDeleteSchema',
  'knowledgeUploadSchema',
  "observeKnowledgeOperation('search')",
]) {
  if (!knowledgeDocumentRoutes.includes(requiredHelper)) {
    errors.push(
      `src-server/routes/knowledge/knowledge-document-routes.ts must include ${requiredHelper}.`,
    );
  }
}

const knowledgeCrossProjectRoutes = readRequiredSource(
  '../src-server/routes/knowledge/knowledge-cross-project.ts',
);
for (const requiredHelper of [
  'export function createCrossProjectKnowledgeRoutes',
  'providerService.listProviderConnections()',
  'knowledgeService.searchDocuments(',
  'storageAdapter.listProjects()',
]) {
  if (!knowledgeCrossProjectRoutes.includes(requiredHelper)) {
    errors.push(
      `src-server/routes/knowledge/knowledge-cross-project.ts must include ${requiredHelper}.`,
    );
  }
}

const invokeRoute = readRequiredSource('../src-server/routes/agents/invoke.ts');
for (const requiredHelper of [
  './invoke-agent.js',
  './invoke-global.js',
  'invokeAgent(',
  'invokeAgentTool(',
  'invokeGlobalPrompt(',
]) {
  if (!invokeRoute.includes(requiredHelper)) {
    errors.push(
      `src-server/routes/agents/invoke.ts must include ${requiredHelper}.`,
    );
  }
}
for (const retiredInlineInvokeSnippet of [
  'interface ToolResult {',
  'function unwrapMCPResult(',
  'const invokeModelId = model || ctx.appConfig.invokeModel;',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source-expectation string deliberately contains an interpolation
  'const tempConversationId = `invoke-${Date.now()}`;',
  'const filteredTools = toolIds.length > 0',
  'const toolResult = await (',
  ').execute(toolArgs);',
]) {
  if (invokeRoute.includes(retiredInlineInvokeSnippet)) {
    errors.push(
      `src-server/routes/agents/invoke.ts must not inline extracted invoke route logic ${retiredInlineInvokeSnippet}.`,
    );
  }
}

const invokeAgentRoute = readRequiredSource(
  '../src-server/routes/agents/invoke-agent.ts',
);
for (const requiredHelper of [
  'function unwrapMCPResult',
  'export async function invokeAgent',
  'export async function invokeAgentTool',
  'export function invokeErrorResponse',
  'ctx.activeAgents.get(',
  'ctx.getNormalizedToolName(',
  'Response.json(',
]) {
  if (!invokeAgentRoute.includes(requiredHelper)) {
    errors.push(
      `src-server/routes/agents/invoke-agent.ts must include ${requiredHelper}.`,
    );
  }
}

const invokeGlobalRoute = readRequiredSource(
  '../src-server/routes/agents/invoke-global.ts',
);
for (const requiredHelper of [
  'export async function invokeGlobalPrompt',
  'ctx.globalToolRegistry.get(id)',
  'ctx.framework.createTempAgent',
  'jsonSchema(schema)',
  'DEFAULT_SYSTEM_PROMPT',
]) {
  if (!invokeGlobalRoute.includes(requiredHelper)) {
    errors.push(
      `src-server/routes/agents/invoke-global.ts must include ${requiredHelper}.`,
    );
  }
}

const systemRoute = readRequiredSource('../src-server/routes/system/system.ts');
for (const requiredHelper of [
  './system-route-types.js',
  './system-status-routes.js',
  './system-update-routes.js',
  'createSystemStatusRoutes(deps)',
  'createSystemUpdateRoutes(deps, logger)',
]) {
  if (!systemRoute.includes(requiredHelper)) {
    errors.push(
      `src-server/routes/system/system.ts must include ${requiredHelper}.`,
    );
  }
}
for (const retiredInlineSystemSnippet of [
  'function normalizeConfiguredProviders(',
  'function buildCapabilityStates(',
  'function buildSystemRecommendation(',
  "app.get('/status', async (c) => {",
  "app.post('/verify-bedrock', async (c) => {",
  "app.get('/core-update', async (c) => {",
]) {
  if (systemRoute.includes(retiredInlineSystemSnippet)) {
    errors.push(
      `src-server/routes/system/system.ts must not inline extracted system route logic ${retiredInlineSystemSnippet}.`,
    );
  }
}

const systemStatusRoutes = readRequiredSource(
  '../src-server/routes/system/system-status-routes.ts',
);
for (const requiredHelper of [
  'export function createSystemStatusRoutes',
  'function normalizeConfiguredProviders(',
  'function buildCapabilityStates(',
  'function buildSystemRecommendation(',
  "app.get('/status', async (c) => {",
  "app.get('/capabilities', (c) => {",
  "app.get('/discover', (c) => {",
]) {
  if (!systemStatusRoutes.includes(requiredHelper)) {
    errors.push(
      `src-server/routes/system/system-status-routes.ts must include ${requiredHelper}.`,
    );
  }
}

const systemUpdateRoutes = readRequiredSource(
  '../src-server/routes/system/system-update-routes.ts',
);
for (const requiredHelper of [
  'export function createSystemUpdateRoutes',
  "app.post('/verify-bedrock', async (c) => {",
  "app.get('/core-update', async (c) => {",
  "app.post('/core-update', async (c) => {",
  // Git resolution moved behind install-provenance classification so desktop
  // bundles get an honest answer instead of "Not a git repository" (#1624).
  'resolveInstallProvenance(',
  "spawn(\n        '/bin/zsh'",
  'eligibility.installerPath',
  'windowsHide: true',
]) {
  if (!systemUpdateRoutes.includes(requiredHelper)) {
    errors.push(
      `src-server/routes/system/system-update-routes.ts must include ${requiredHelper}.`,
    );
  }
}

const installProvenance = readRequiredSource(
  '../src-server/routes/system/install-provenance.ts',
);
for (const requiredHelper of [
  'resolveGit = resolveGitInfo',
  'readNightlySourceStamp(',
]) {
  if (!installProvenance.includes(requiredHelper)) {
    errors.push(
      `src-server/routes/system/install-provenance.ts must include ${requiredHelper}.`,
    );
  }
}

const sdkTypesIndex = readRequiredSource('../packages/sdk/src/types/index.ts');
if (!sdkTypesIndex.includes('@kontourai/station-contracts/layout')) {
  errors.push(
    'packages/sdk/src/types/index.ts must import layout types from @kontourai/station-contracts/layout.',
  );
}

const cliDevServer = readRequiredSource('../packages/cli/src/dev/server.ts');
for (const requiredImport of [
  './bundles.js',
  './http.js',
  './mcp.js',
  './registry.js',
  './watchers.js',
  'ensureDevAssetBundles(INVOKED_CWD)',
  'createDevHttpServer({',
  'setupDevMcpManager({',
  'regenerateDevHTML({',
  'watchSourceChanges({',
  'watchConfigChanges({',
]) {
  if (!cliDevServer.includes(requiredImport)) {
    errors.push(
      `packages/cli/src/dev/server.ts must include ${requiredImport}.`,
    );
  }
}
for (const retiredInlineCliDevSnippet of [
  "import { execSync } from 'node:child_process';",
  'writeFileSync(',
  'serializeSDKMock',
  'import { generateDevHTML }',
  "const reactEntry = join(CWD, 'dist/.react-entry.mjs');",
  'const promptsSource = manifest.prompts?.source;',
  'const depRegistries: Record<string, any> = {};',
  'function readBody(',
  'const server = createServer(',
  'fsWatch(',
  'new MCPManager({',
  'resolvePluginIntegrations(',
]) {
  if (cliDevServer.includes(retiredInlineCliDevSnippet)) {
    errors.push(
      `packages/cli/src/dev/server.ts must not inline extracted dev-server logic ${retiredInlineCliDevSnippet}.`,
    );
  }
}

const cliLifecycle = readRequiredSource(
  '../packages/cli/src/commands/lifecycle.ts',
);
for (const requiredImport of [
  './lifecycle-doctor.js',
  'collectDoctorReport,',
]) {
  if (!cliLifecycle.includes(requiredImport)) {
    errors.push(
      `packages/cli/src/commands/lifecycle.ts must include ${requiredImport}.`,
    );
  }
}
for (const retiredLifecycleSnippet of [
  'function execVersion(',
  'async function detectOllama(',
  'function doctorStatusSymbol(',
  "const awsCredentialsPath = join(homedir(), '.aws', 'credentials');",
]) {
  if (cliLifecycle.includes(retiredLifecycleSnippet)) {
    errors.push(
      `packages/cli/src/commands/lifecycle.ts must not inline extracted doctor logic ${retiredLifecycleSnippet}.`,
    );
  }
}

const cliLifecycleDoctor = readRequiredSource(
  '../packages/cli/src/commands/lifecycle-doctor.ts',
);
for (const requiredHelper of [
  'export async function collectDoctorReport',
  'export async function doctor',
  "const awsCredentialsPath = join(homedir(), '.aws', 'credentials');",
  "label: 'Configured chat model connections'",
]) {
  if (!cliLifecycleDoctor.includes(requiredHelper)) {
    errors.push(
      `packages/cli/src/commands/lifecycle-doctor.ts must include ${requiredHelper}.`,
    );
  }
}

const cliDevHttp = readRequiredSource('../packages/cli/src/dev/http.ts');
for (const requiredHelper of [
  '@kontourai/station-contracts/runtime',
  'readJsonBody',
  'export function parseToolCallResponse',
  'export function createDevHttpServer',
  'createServer(async (req, res) => {',
]) {
  if (!cliDevHttp.includes(requiredHelper)) {
    errors.push(`packages/cli/src/dev/http.ts must include ${requiredHelper}.`);
  }
}

const cliDevWatchers = readRequiredSource(
  '../packages/cli/src/dev/watchers.ts',
);
for (const requiredHelper of [
  '@kontourai/station-contracts/plugin',
  'export function watchSourceChanges',
  'export function getConfigWatchTargets',
  'export function watchConfigChanges',
]) {
  if (!cliDevWatchers.includes(requiredHelper)) {
    errors.push(
      `packages/cli/src/dev/watchers.ts must include ${requiredHelper}.`,
    );
  }
}

const cliDevMcp = readRequiredSource('../packages/cli/src/dev/mcp.ts');
for (const requiredHelper of [
  'export async function setupDevMcpManager',
  'resolvePluginIntegrations',
  'new MCPManager({',
]) {
  if (!cliDevMcp.includes(requiredHelper)) {
    errors.push(`packages/cli/src/dev/mcp.ts must include ${requiredHelper}.`);
  }
}

const cliDevBundles = readRequiredSource('../packages/cli/src/dev/bundles.ts');
for (const requiredHelper of [
  'export function resolveDevBundlePaths',
  'export function ensureDevAssetBundles',
  'window.__station_sdk',
  'window.__station_ai_rq',
]) {
  if (!cliDevBundles.includes(requiredHelper)) {
    errors.push(
      `packages/cli/src/dev/bundles.ts must include ${requiredHelper}.`,
    );
  }
}

const cliDevRegistry = readRequiredSource(
  '../packages/cli/src/dev/registry.ts',
);
for (const requiredHelper of [
  'export function parsePromptMarkdown',
  'export function loadPromptEntries',
  'export function regenerateDevHTML',
  'serializeSDKMock',
  'generateDevHTML',
]) {
  if (!cliDevRegistry.includes(requiredHelper)) {
    errors.push(
      `packages/cli/src/dev/registry.ts must include ${requiredHelper}.`,
    );
  }
}

const cliDevTemplate = readRequiredSource(
  '../packages/cli/src/dev/template.ts',
);
for (const requiredHelper of [
  './template-scripts.js',
  './template-styles.js',
  'export interface DevTemplateOptions',
  'export function generateDevHTML',
  'buildThemeBootstrapScript()',
  'buildDevSharedRuntimeScript(sdkMockJs)',
  'buildDevAppScript({ pluginName, tabsJson, registryJson })',
  'buildReloadScript()',
]) {
  if (!cliDevTemplate.includes(requiredHelper)) {
    errors.push(
      `packages/cli/src/dev/template.ts must include ${requiredHelper}.`,
    );
  }
}
for (const retiredInlineCliTemplateSnippet of [
  '.dev-banner{',
  'window.__station_ai_shared = {',
  'function InfoPage(){',
  'function LayoutView(props){',
  "var es=new EventSource('/api/reload')",
]) {
  if (cliDevTemplate.includes(retiredInlineCliTemplateSnippet)) {
    errors.push(
      `packages/cli/src/dev/template.ts must not inline extracted template helper ${retiredInlineCliTemplateSnippet}.`,
    );
  }
}

const cliDevTemplateStyles = readRequiredSource(
  '../packages/cli/src/dev/template-styles.ts',
);
if (!cliDevTemplateStyles.includes('export const DEV_TEMPLATE_STYLES')) {
  errors.push(
    'packages/cli/src/dev/template-styles.ts must export DEV_TEMPLATE_STYLES.',
  );
}

const cliDevTemplateScripts = readRequiredSource(
  '../packages/cli/src/dev/template-scripts.ts',
);
for (const requiredHelper of [
  'export function buildThemeBootstrapScript',
  'export function buildDevSharedRuntimeScript',
  'export interface DevAppScriptOptions',
  'export function buildDevAppScript',
  'export function buildReloadScript',
]) {
  if (!cliDevTemplateScripts.includes(requiredHelper)) {
    errors.push(
      `packages/cli/src/dev/template-scripts.ts must include ${requiredHelper}.`,
    );
  }
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
  './config-loader-app.js',
  './config-loader-agents.js',
  './config-loader-storage.js',
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
for (const retiredInlineConfigLoaderSnippet of [
  'Agent references missing workflows in ui.workflowShortcuts',
  "const workflowsDir = join(this.projectHomeDir, 'agents', slug, 'workflows')",
  'return agents.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));',
  "const agentDir = join(this.projectHomeDir, 'agents', slug);",
  "const integrationsDir = join(this.projectHomeDir, 'integrations');",
  "const dir = join(this.projectHomeDir, 'skills');",
  "const path = join(this.projectHomeDir, 'config', 'acp.json');",
]) {
  if (domainConfigLoader.includes(retiredInlineConfigLoaderSnippet)) {
    errors.push(
      `src-server/domain/config-loader.ts must not inline extracted agent/workflow logic ${retiredInlineConfigLoaderSnippet}.`,
    );
  }
}

const domainConfigLoaderAgents = readRequiredSource(
  '../src-server/domain/config-loader-agents.ts',
);
for (const requiredHelper of [
  'export async function loadAgentConfig',
  'export async function saveAgentConfig',
  'export async function createAgentConfig',
  'export async function updateAgentConfig',
  'export async function listAgentConfigs',
  'export async function listAgentWorkflowMetadata',
  'export async function getAgentToolMap',
]) {
  if (!domainConfigLoaderAgents.includes(requiredHelper)) {
    errors.push(
      `src-server/domain/config-loader-agents.ts must include ${requiredHelper}.`,
    );
  }
}

const domainConfigLoaderApp = readRequiredSource(
  '../src-server/domain/config-loader-app.ts',
);
for (const requiredHelper of [
  'export const DEFAULT_SYSTEM_PROMPT',
  'export async function loadAppConfigFile',
  'export async function saveAppConfigFile',
  'export async function updateAppConfigFile',
  'function assertSafeAppConfig',
]) {
  if (!domainConfigLoaderApp.includes(requiredHelper)) {
    errors.push(
      `src-server/domain/config-loader-app.ts must include ${requiredHelper}.`,
    );
  }
}

const domainConfigLoaderStorage = readRequiredSource(
  '../src-server/domain/config-loader-storage.ts',
);
for (const requiredHelper of [
  'export async function loadIntegrationConfig',
  'export async function saveIntegrationConfig',
  'export async function listIntegrationMetadata',
  'export async function listSkillConfigs',
  'export async function loadACPConfigFile',
  'export async function saveACPConfigFile',
]) {
  if (!domainConfigLoaderStorage.includes(requiredHelper)) {
    errors.push(
      `src-server/domain/config-loader-storage.ts must include ${requiredHelper}.`,
    );
  }
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

const fileStorageAdapter = readRequiredSource(
  '../src-server/domain/file-storage-adapter.ts',
);
if (!fileStorageAdapter.includes('./file-storage-helpers.js')) {
  errors.push(
    'file-storage-adapter.ts must delegate shared filesystem helpers to file-storage-helpers.ts.',
  );
}
if (!fileStorageAdapter.includes('./file-storage-records.js')) {
  errors.push(
    'file-storage-adapter.ts must delegate collection CRUD helpers to file-storage-records.ts.',
  );
}
for (const retiredInlineStorageSnippet of [
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source-expectation string deliberately contains an interpolation
  'throw new Error(`Project not found for id: ${record.projectId}`);',
  "return JSON.parse(readFileSync(f, 'utf-8'));",
  "writeFileSync(f, JSON.stringify(records, null, 2), 'utf-8');",
  'records.sort((left, right) =>',
  'const found = this.readConversations(slug).find(',
  'const found = this.readDocuments(slug).find(',
]) {
  if (fileStorageAdapter.includes(retiredInlineStorageSnippet)) {
    errors.push(
      `file-storage-adapter.ts must not inline extracted storage helper ${retiredInlineStorageSnippet}.`,
    );
  }
}

// The JSON-file primitives moved to packages/shared/src/json-file-storage.ts
// (published so the CLI stops bundling server internals); the server module
// keeps the project-slug helpers and re-exports the rest.
const jsonFileStorage = readRequiredSource(
  '../packages/shared/src/json-file-storage.ts',
);
for (const requiredHelper of [
  'export function readJsonFile',
  'export async function writeJsonFile',
]) {
  if (!jsonFileStorage.includes(requiredHelper)) {
    errors.push(`json-file-storage.ts must include ${requiredHelper}.`);
  }
}
const fileStorageHelpers = readRequiredSource(
  '../src-server/domain/file-storage-helpers.ts',
);
for (const requiredHelper of [
  "export * from '@kontourai/station-shared/json-file-storage'",
  'export function listProjectSlugs',
  'export function resolveProjectSlugById',
]) {
  if (!fileStorageHelpers.includes(requiredHelper)) {
    errors.push(`file-storage-helpers.ts must include ${requiredHelper}.`);
  }
}

const fileStorageRecords = readRequiredSource(
  '../src-server/domain/file-storage-records.ts',
);
for (const requiredHelper of [
  'export function listStoredRecords',
  'export function saveStoredRecord',
  'export function deleteStoredRecord',
  'export function findStoredRecordAcrossProjects',
  'export function saveProjectScopedRecord',
  'export function deleteProjectScopedRecord',
  'export function listSortedConversations',
  'export function buildLayoutAgentReferences',
]) {
  if (!fileStorageRecords.includes(requiredHelper)) {
    errors.push(`file-storage-records.ts must include ${requiredHelper}.`);
  }
}

const sdkQueries = readRequiredSource('../packages/sdk/src/queries.ts');
const sdkIndex = readRequiredSource('../packages/sdk/src/index.ts');
const sdkApi = readRequiredSource('../packages/sdk/src/api.ts');
const sdkPluginsDomain = readRequiredSource(
  '../packages/sdk/src/query-domains/plugins.ts',
);
const sdkPluginTypes = readRequiredSource(
  '../packages/sdk/src/query-domains/plugin-types.ts',
);
const sdkPluginQueries = readRequiredSource(
  '../packages/sdk/src/query-domains/plugin-queries.ts',
);
const sdkPluginMutations = readRequiredSource(
  '../packages/sdk/src/query-domains/plugin-mutations.ts',
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
for (const retiredInlinePluginSnippet of [
  'async function requestPluginSettings(',
  'export async function reloadPlugins(',
  'export function usePluginInstallMutation()',
  'export interface PluginSettingsData',
]) {
  if (sdkPluginsDomain.includes(retiredInlinePluginSnippet)) {
    errors.push(
      `packages/sdk/src/query-domains/plugins.ts must not inline extracted plugin helper ${retiredInlinePluginSnippet}.`,
    );
  }
}
for (const requiredPluginTypeExport of [
  'export interface PluginSettingsData',
  'export interface PluginChangelogData',
  'export interface PluginProviderDetail',
  'export interface AgentHealthStatus',
]) {
  if (!sdkPluginTypes.includes(requiredPluginTypeExport)) {
    errors.push(`plugin-types.ts must include ${requiredPluginTypeExport}.`);
  }
}
for (const requiredPluginQueryExport of [
  'export async function requestAgentHealth',
  'export async function waitForAgentHealth',
  'export function usePluginsQuery',
  'export function useRegistryPluginsQuery',
]) {
  if (!sdkPluginQueries.includes(requiredPluginQueryExport)) {
    errors.push(`plugin-queries.ts must include ${requiredPluginQueryExport}.`);
  }
}
for (const retiredMutationSnippet of [
  'export function usePluginInstallMutation()',
  'export function useReloadPluginsMutation(',
]) {
  if (sdkPluginQueries.includes(retiredMutationSnippet)) {
    errors.push(
      `plugin-queries.ts must not inline mutation helper ${retiredMutationSnippet}.`,
    );
  }
}
for (const requiredPluginMutationExport of [
  'export async function reloadPlugins',
  'export function usePluginInstallMutation()',
  'export function usePluginSettingsMutation(',
  'export function useAddProjectLayoutFromPluginMutation(',
]) {
  if (!sdkPluginMutations.includes(requiredPluginMutationExport)) {
    errors.push(
      `plugin-mutations.ts must include ${requiredPluginMutationExport}.`,
    );
  }
}
for (const requiredPluginInvalidationHelper of [
  'function invalidatePluginQueries(',
  'function invalidatePluginGraphQueries(',
]) {
  if (!sdkPluginMutations.includes(requiredPluginInvalidationHelper)) {
    errors.push(
      `plugin-mutations.ts must keep shared invalidation helper ${requiredPluginInvalidationHelper}.`,
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
for (const retiredInlineApiSnippet of [
  'let _apiBase',
  'export interface SendMessageOptions',
  'export async function sendMessage(',
  'export async function streamMessage(',
  'export async function invokeAgent(',
  'export async function callTool(',
  'export async function invoke(',
  'function knowledgeBase(',
  'export async function fetchKnowledgeNamespaces(',
  'export async function fetchKnowledgeTree(',
  'export async function updateKnowledgeDoc(',
]) {
  if (sdkApi.includes(retiredInlineApiSnippet)) {
    errors.push(
      `packages/sdk/src/api.ts must not inline extracted API helper ${retiredInlineApiSnippet}.`,
    );
  }
}

const sdkApiCore = readRequiredSource('../packages/sdk/src/api-core.ts');
for (const requiredHelper of [
  'export function _setApiBase',
  'export function _setLayoutContext',
  'export function _resolveAgent',
  'export function _getPluginName',
  'export async function _getApiBase',
  // #1451 moved the implementation to client/plugin-headers.ts; api-core.ts
  // keeps the public re-export so every consumer path stays unchanged.
  "export { getPluginHeaders } from './client/plugin-headers';",
]) {
  if (!sdkApiCore.includes(requiredHelper)) {
    errors.push(`packages/sdk/src/api-core.ts must include ${requiredHelper}.`);
  }
}
const sdkPluginHeaders = readRequiredSource(
  '../packages/sdk/src/client/plugin-headers.ts',
);
// Presence only: the spoof-resistance of the header itself is a behavioural
// property, pinned by packages/sdk/src/__tests__/api-core-layout-context.test.ts,
// which a source scan cannot express without pretending to.
for (const requiredHelper of ['export function getPluginHeaders(']) {
  if (!sdkPluginHeaders.includes(requiredHelper)) {
    errors.push(
      `packages/sdk/src/client/plugin-headers.ts must include ${requiredHelper}.`,
    );
  }
}

const sdkApiAgentRuntime = readRequiredSource(
  '../packages/sdk/src/api-agent-runtime.ts',
);
for (const requiredHelper of [
  'export interface SendMessageOptions',
  'export interface StreamMessageOptions',
  'export interface InvokeOptions',
  'export async function sendMessage',
  'export async function streamMessage',
  'export async function invokeAgent',
  'export async function callTool',
  'export async function invoke',
  'export async function fetchAgents',
  'export async function fetchConversations',
  'export async function fetchConversationMessages',
  'export async function fetchConfig',
]) {
  if (!sdkApiAgentRuntime.includes(requiredHelper)) {
    errors.push(
      `packages/sdk/src/api-agent-runtime.ts must include ${requiredHelper}.`,
    );
  }
}

const sdkApiKnowledge = readRequiredSource(
  '../packages/sdk/src/api-knowledge.ts',
);
if (!sdkApiKnowledge.includes('./api-knowledge-utils')) {
  errors.push(
    'packages/sdk/src/api-knowledge.ts must delegate shared request helpers to api-knowledge-utils.ts.',
  );
}
for (const requiredHelper of [
  'export async function fetchKnowledgeNamespaces',
  'export async function fetchKnowledgeDocs',
  'export async function searchKnowledge',
  'export async function uploadKnowledge',
  'export async function deleteKnowledgeDoc',
  'export async function bulkDeleteKnowledgeDocs',
  'export async function fetchKnowledgeDocContent',
  'export async function fetchKnowledgeStatus',
  'export async function scanKnowledgeDirectory',
  'export async function fetchProjectConversations',
  'export async function addProjectLayoutFromPlugin',
  'export async function fetchAvailableLayouts',
  'export async function updateKnowledgeNamespace',
  'export async function fetchKnowledgeTree',
  'export async function fetchKnowledgeFiltered',
  'export async function updateKnowledgeDoc',
]) {
  if (!sdkApiKnowledge.includes(requiredHelper)) {
    errors.push(
      `packages/sdk/src/api-knowledge.ts must include ${requiredHelper}.`,
    );
  }
}
for (const retiredInlineKnowledgeApiSnippet of [
  'function knowledgeBase(',
  'new URLSearchParams()',
  "headers: getPluginHeaders({ 'Content-Type': 'application/json' })",
]) {
  if (sdkApiKnowledge.includes(retiredInlineKnowledgeApiSnippet)) {
    errors.push(
      `packages/sdk/src/api-knowledge.ts must not inline extracted knowledge API helper ${retiredInlineKnowledgeApiSnippet}.`,
    );
  }
}

const sdkApiKnowledgeUtils = readRequiredSource(
  '../packages/sdk/src/api-knowledge-utils.ts',
);
for (const requiredHelper of [
  'export function knowledgeBase',
  'export async function requestKnowledgeJson',
  'export function buildKnowledgeFilterQuery',
  'new URLSearchParams()',
  'headers: getPluginHeaders(',
]) {
  if (!sdkApiKnowledgeUtils.includes(requiredHelper)) {
    errors.push(
      `packages/sdk/src/api-knowledge-utils.ts must include ${requiredHelper}.`,
    );
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
for (const retiredInlineChatRuntimeSnippet of [
  'export interface CodingFileEntry',
  'export async function fetchCodingFiles(',
  'export async function fetchCodingDiff(',
  'export async function fetchCodingFileContent(',
  'export async function fetchTerminalPort(',
  'export async function executeCodingCommand(',
  'export async function fetchVapidPublicKey(',
  'export async function subscribePushNotifications(',
  'export async function unsubscribePushNotifications(',
  'export async function createVoiceSession(',
  'export interface ConversationSummary',
  'export interface ConversationLookup',
  'export interface ConversationMessagePart',
  'export interface ConversationMessage',
  'export interface ChatAttachmentInput',
  'export interface OrchestrationProviderSummary',
  'export type OrchestrationCommandInput =',
  'export async function fetchOrchestrationProviders(',
  'export async function dispatchOrchestrationCommand(',
  'export async function resolveOrchestrationRequest(',
  'export async function startOrchestrationSession(',
  'export async function sendOrchestrationTurn(',
  'export async function fetchAgentConversations(',
  'export async function renameConversation(',
  'export async function deleteConversation(',
  'export async function fetchConversationMessages(',
  'export async function fetchConversationById(',
  'export async function streamConversationTurn(',
  'export function useCodingFilesQuery(',
  'export function useCodingDiffQuery(',
  'export function useCodingFileContentQuery(',
  'export function useConversationsQuery(',
  'export function useOrchestrationProvidersQuery(',
  'export function useRenameConversationMutation(',
  'export function useDeleteConversationMutation(',
]) {
  if (sdkChatRuntime.includes(retiredInlineChatRuntimeSnippet)) {
    errors.push(
      `packages/sdk/src/query-domains/chatRuntime.ts must not inline extracted helper ${retiredInlineChatRuntimeSnippet}.`,
    );
  }
}

const sdkChatRuntimeTypes = readRequiredSource(
  '../packages/sdk/src/query-domains/chatRuntimeTypes.ts',
);
for (const requiredHelper of [
  'export type OrchestrationEngineId =',
  'export interface ConversationSummary',
  'export interface ConversationLookup',
  'export interface ConversationMessagePart',
  'export interface ConversationMessage',
  'export interface ChatAttachmentInput',
  'export interface OrchestrationProviderSummary',
  'export type OrchestrationCommandInput =',
]) {
  if (!sdkChatRuntimeTypes.includes(requiredHelper)) {
    errors.push(
      `packages/sdk/src/query-domains/chatRuntimeTypes.ts must include ${requiredHelper}.`,
    );
  }
}

const sdkChatRuntimeOrchestration = readRequiredSource(
  '../packages/sdk/src/query-domains/chatRuntimeOrchestration.ts',
);
for (const requiredHelper of [
  'export async function fetchOrchestrationProviders',
  'export async function dispatchOrchestrationCommand',
  'export async function resolveOrchestrationRequest',
  'export async function adoptOrchestrationSession',
  'export async function sendOrchestrationTurn',
  'export function useOrchestrationProvidersQuery',
]) {
  if (!sdkChatRuntimeOrchestration.includes(requiredHelper)) {
    errors.push(
      `packages/sdk/src/query-domains/chatRuntimeOrchestration.ts must include ${requiredHelper}.`,
    );
  }
}

const sdkChatRuntimeConversations = readRequiredSource(
  '../packages/sdk/src/query-domains/chatRuntimeConversations.ts',
);
for (const requiredHelper of [
  'export async function fetchAgentConversations',
  'export async function renameConversation',
  'export async function deleteConversation',
  'export async function fetchConversationMessages',
  'export async function fetchConversationById',
  'export function useConversationsQuery',
  'export function useRenameConversationMutation',
  'export function useDeleteConversationMutation',
  'mapConversationMessages',
]) {
  if (!sdkChatRuntimeConversations.includes(requiredHelper)) {
    errors.push(
      `packages/sdk/src/query-domains/chatRuntimeConversations.ts must include ${requiredHelper}.`,
    );
  }
}

const sdkChatRuntimeStream = readRequiredSource(
  '../packages/sdk/src/query-domains/chatRuntimeStream.ts',
);
for (const requiredHelper of [
  'export function mapConversationMessages',
  'export function buildConversationTurnInput',
  'export function buildConversationTurnPayload',
  'export async function streamConversationTurn',
]) {
  if (!sdkChatRuntimeStream.includes(requiredHelper)) {
    errors.push(
      `packages/sdk/src/query-domains/chatRuntimeStream.ts must include ${requiredHelper}.`,
    );
  }
}

const sdkChatRuntimeCoding = readRequiredSource(
  '../packages/sdk/src/query-domains/chatRuntimeCoding.ts',
);
for (const requiredHelper of [
  'export interface CodingFileEntry',
  'export async function fetchCodingFiles',
  'export async function fetchCodingDiff',
  'export async function fetchCodingFileContent',
  'export async function fetchTerminalPort',
  'export async function executeCodingCommand',
  'export function useCodingFilesQuery',
  'export function useCodingDiffQuery',
  'export function useCodingFileContentQuery',
]) {
  if (!sdkChatRuntimeCoding.includes(requiredHelper)) {
    errors.push(
      `packages/sdk/src/query-domains/chatRuntimeCoding.ts must include ${requiredHelper}.`,
    );
  }
}

const sdkChatRuntimeDevice = readRequiredSource(
  '../packages/sdk/src/query-domains/chatRuntimeDevice.ts',
);
for (const requiredHelper of [
  'export async function fetchVapidPublicKey',
  'export async function subscribePushNotifications',
  'export async function unsubscribePushNotifications',
  'export async function createVoiceSession',
]) {
  if (!sdkChatRuntimeDevice.includes(requiredHelper)) {
    errors.push(
      `packages/sdk/src/query-domains/chatRuntimeDevice.ts must include ${requiredHelper}.`,
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
for (const retiredInlineWorkspaceSnippet of [
  'export interface GlobalKnowledgeStatus',
  'export interface ConnectionMutationInput',
  'export interface ConnectionTestResult',
  'export type { LayoutCatalogItem as AvailableProjectLayout }',
  'export interface WorkflowFile',
  'export function useConnectionsQuery(',
  'export function useSaveConnectionMutation(',
  'export function useProjectLayoutsQuery(',
  'export function useCreateProjectMutation(',
  'export function useAgentWorkflowsQuery(',
  'export function useCreateWorkflowMutation(',
]) {
  if (sdkWorkspace.includes(retiredInlineWorkspaceSnippet)) {
    errors.push(
      `packages/sdk/src/query-domains/workspace.ts must not inline extracted helper ${retiredInlineWorkspaceSnippet}.`,
    );
  }
}

const sdkWorkspaceConnections = readRequiredSource(
  '../packages/sdk/src/query-domains/workspaceConnections.ts',
);
for (const requiredHelper of [
  'export interface GlobalKnowledgeStatus',
  'export interface ModelConnectionMutationInput',
  'export interface AgentConnectionMutationInput',
  'export interface ConnectionTestResult',
  'export function useConnectionsQuery',
  'export function useSaveModelConnectionMutation',
  'export function useSaveAgentConnectionMutation',
  'export function useTestAgentConnectionMutation',
  'export function useSmokeAgentConnectionMutation',
  'export function useGlobalKnowledgeStatusQuery',
  'export function useTestVectorDbConnectionMutation',
]) {
  if (!sdkWorkspaceConnections.includes(requiredHelper)) {
    errors.push(
      `packages/sdk/src/query-domains/workspaceConnections.ts must include ${requiredHelper}.`,
    );
  }
}
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

const sdkWorkspaceProjects = readRequiredSource(
  '../packages/sdk/src/query-domains/workspaceProjects.ts',
);
for (const requiredHelper of [
  'export type { LayoutCatalogItem as AvailableProjectLayout }',
  'export function useProjectsQuery',
  'export function useProjectLayoutsQuery',
  'export function useAvailableProjectLayoutsQuery',
  'export function useCreateProjectMutation',
  'export function useDeleteProjectMutation',
  'export function useCreateLayoutMutation',
]) {
  if (!sdkWorkspaceProjects.includes(requiredHelper)) {
    errors.push(
      `packages/sdk/src/query-domains/workspaceProjects.ts must include ${requiredHelper}.`,
    );
  }
}

const sdkWorkspaceWorkflows = readRequiredSource(
  '../packages/sdk/src/query-domains/workspaceWorkflows.ts',
);
for (const requiredHelper of [
  'import type { WorkflowMetadata }',
  'export function useAgentWorkflowsQuery',
  'export function useWorkflowContentQuery',
  'export function useCreateWorkflowMutation',
  'export function useDeleteWorkflowMutation',
]) {
  if (!sdkWorkspaceWorkflows.includes(requiredHelper)) {
    errors.push(
      `packages/sdk/src/query-domains/workspaceWorkflows.ts must include ${requiredHelper}.`,
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
for (const retiredHookSnippet of [
  'export function useNotifications() {',
  'export function useSendToChat(',
  'export function useUserLookup(',
  'export function useServerFetch() {',
  "import { useCallback, useContext, useEffect, useState } from 'react';",
]) {
  if (sdkHooksBarrel.includes(retiredHookSnippet)) {
    errors.push(
      `packages/sdk/src/hooks.ts must stay a thin barrel and not inline ${retiredHookSnippet}.`,
    );
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
if (!activeChatsContext.includes('../hooks/usePruneActiveChats')) {
  errors.push(
    'ActiveChatsContext must delegate pruning to usePruneActiveChats.',
  );
}

const orchestrationHook = readRequiredSource(
  '../src-ui/src/hooks/useOrchestration.ts',
);
for (const requiredHelper of [
  './orchestration/ensureOrchestrationEventStream',
  'sendExecutionMessageRequest',
  'useOrchestrationProvidersQuery',
]) {
  if (!orchestrationHook.includes(requiredHelper)) {
    errors.push(`useOrchestration must use ${requiredHelper}.`);
  }
}
for (const retiredInlineOrchestrationSnippet of [
  'type OrchestrationEvent =',
  'function upsertTextPart(',
  'function upsertToolPart(',
  'function finalizeAssistantTurn(',
  'async function resolveApproval(',
  'function handleEvent(',
  'const activeSources = new Map<string, EventSource>();',
]) {
  if (orchestrationHook.includes(retiredInlineOrchestrationSnippet)) {
    errors.push(
      `useOrchestration must not inline extracted orchestration helper ${retiredInlineOrchestrationSnippet}.`,
    );
  }
}

const orchestrationDirChecks = [
  [
    '../src-ui/src/hooks/orchestration/types.ts',
    ['export type OrchestrationEvent ='],
  ],
  [
    '../src-ui/src/hooks/orchestration/messageParts.ts',
    ['export function upsertTextPart', 'export function upsertToolPart'],
  ],
  [
    '../src-ui/src/hooks/orchestration/assistantTurn.ts',
    ['export function finalizeAssistantTurn'],
  ],
  [
    '../src-ui/src/hooks/orchestration/snapshotHandlers.ts',
    ['export function applyOrchestrationSnapshot'],
  ],
  [
    '../src-ui/src/hooks/orchestration/sessionHandlers.ts',
    [
      'export function handleSessionLifecycleEvent',
      'export function handleSessionStateChangedEvent',
      'export function handleSessionExitedEvent',
    ],
  ],
  [
    '../src-ui/src/hooks/orchestration/streamHandlers.ts',
    [
      'export function handleTextDeltaEvent',
      'export function handleReasoningDeltaEvent',
      'export function handleToolStartedEvent',
      'export function handleToolProgressEvent',
      'export function handleToolCompletedEvent',
    ],
  ],
  [
    '../src-ui/src/hooks/orchestration/approvalHandlers.ts',
    [
      'export function handleRequestOpenedEvent',
      'export function handleRequestResolvedEvent',
      'async function resolveApproval',
    ],
  ],
  [
    '../src-ui/src/hooks/orchestration/turnHandlers.ts',
    [
      'export function handleTurnStartedEvent',
      'export function handleTurnCompletedEvent',
      'export function handleTurnAbortedEvent',
      'export function handleRuntimeErrorEvent',
      'export function handleRuntimeWarningEvent',
    ],
  ],
  [
    '../src-ui/src/hooks/orchestration/eventHandlers.ts',
    ['export function handleOrchestrationEvent'],
  ],
  [
    '../src-ui/src/hooks/orchestration/ensureOrchestrationEventStream.ts',
    [
      'const activeSources = new Map<string, FetchSseConnection>();',
      'export function ensureOrchestrationEventStream',
    ],
  ],
];
for (const [relativePath, requiredHelpers] of orchestrationDirChecks) {
  const contents = readRequiredSource(relativePath);
  for (const requiredHelper of requiredHelpers) {
    if (!contents.includes(requiredHelper)) {
      errors.push(
        `${relativePath.replace('../', '')} must include ${requiredHelper}.`,
      );
    }
  }
}

const chatDock = readRequiredSource(
  '../src-ui/src/components/chat-dock/ChatDock.tsx',
);
if (chatDock.includes('/api/conversations/')) {
  errors.push('ChatDock must use a shared conversation lookup helper.');
}
for (const requiredHelper of [
  './ChatDockContentArea',
  './ChatDockModalStack',
  './ChatDockProjectContext',
  './useChatDockActiveChatSync',
  './useChatDockViewModel',
]) {
  if (!chatDock.includes(requiredHelper)) {
    errors.push(
      `ChatDock must delegate extracted UI/state helpers to ${requiredHelper}.`,
    );
  }
}
for (const retiredInlineChatDockSnippet of [
  'const triedChatRef = useRef<string | null>(null);',
  'fetchConversationById(activeChat, apiBase)',
  'function CwdBreadcrumb(',
  '<ConversationHistory',
  '<ChatSettingsPanel',
  '<SessionPickerModal',
  '<NewChatModal',
]) {
  if (chatDock.includes(retiredInlineChatDockSnippet)) {
    errors.push(
      `ChatDock must not inline extracted helper logic ${retiredInlineChatDockSnippet}.`,
    );
  }
}

const chatDockContentArea = readRequiredSource(
  '../src-ui/src/components/chat-dock/ChatDockContentArea.tsx',
);
for (const requiredHelper of [
  'export const ChatDockContentArea = memo(ChatDockContentAreaImpl)',
  'ConversationHistory',
  'ChatDockBody',
]) {
  if (!chatDockContentArea.includes(requiredHelper)) {
    errors.push(`ChatDockContentArea.tsx must include ${requiredHelper}.`);
  }
}

const chatDockModalStack = readRequiredSource(
  '../src-ui/src/components/chat-dock/ChatDockModalStack.tsx',
);
for (const requiredHelper of [
  'export function ChatDockModalStack',
  'ChatSettingsPanel',
  'NewChatModal',
  'SessionPickerModal',
]) {
  if (!chatDockModalStack.includes(requiredHelper)) {
    errors.push(`ChatDockModalStack.tsx must include ${requiredHelper}.`);
  }
}

const chatDockActiveChatSync = readRequiredSource(
  '../src-ui/src/components/chat-dock/useChatDockActiveChatSync.ts',
);
for (const requiredHelper of [
  'export function useChatDockActiveChatSync',
  'fetchConversationById',
  'useEffect',
]) {
  if (!chatDockActiveChatSync.includes(requiredHelper)) {
    errors.push(`useChatDockActiveChatSync.ts must include ${requiredHelper}.`);
  }
}

const chatDockUtils = readRequiredSource(
  '../src-ui/src/components/chat-dock/chat-dock-utils.ts',
);
if (!chatDockUtils.includes('export function splitWorkingDirectoryPath')) {
  errors.push('chat-dock-utils.ts must export splitWorkingDirectoryPath.');
}

// The coding shell's extracted sections must stay extracted. The shell that
// owns them is now the workspace pane host (station#2299): the retired
// `CodingLayout.tsx` was replaced by `builtinWorkspacePaneRegistry.tsx`, which
// composes each builtin coding pane, and the terminal surface delegates one
// level further through `CodingTerminalPane`. The invariant is the same one
// the retired assertion protected — the shell composes these sections rather
// than re-inlining their bodies — restated against the live composition.
const builtinWorkspacePaneRegistry = readRequiredSource(
  '../src-ui/src/workspace-panes/builtinWorkspacePaneRegistry.tsx',
);
for (const requiredImport of [
  '../components/coding-layout/BranchToolbar',
  '../components/coding-layout/CodingInspectorPanel',
  '../components/coding-layout/CodingTerminalPane',
  '../components/coding-layout/DiffPanel',
  '../components/coding-layout/FileTreePanel',
]) {
  if (!builtinWorkspacePaneRegistry.includes(requiredImport)) {
    errors.push(
      `builtinWorkspacePaneRegistry.tsx must delegate its coding panes to the extracted section ${requiredImport}.`,
    );
  }
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

const codingTerminalPane = readRequiredSource(
  '../src-ui/src/components/coding-layout/CodingTerminalPane.tsx',
);
for (const requiredImport of ['./CodingTerminalPanel', './NewTerminalModal']) {
  if (!codingTerminalPane.includes(requiredImport)) {
    errors.push(
      `CodingTerminalPane.tsx must delegate its terminal surface to the extracted section ${requiredImport}.`,
    );
  }
}

const cliInstall = readRequiredSource(
  '../packages/cli/src/commands/install.ts',
);
for (const retiredInlineInstallSnippet of [
  "const projectsDir = join(PROJECT_HOME, 'projects');",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source-expectation string deliberately contains an interpolation
  'console.log(`  ✓ Layout applied to project: ${targetProject}`);',
]) {
  if (cliInstall.includes(retiredInlineInstallSnippet)) {
    errors.push(
      `packages/cli/src/commands/install.ts must not inline extracted layout install logic ${retiredInlineInstallSnippet}.`,
    );
  }
}

// The anti-inlining half of the same invariant, restated against the pane
// host. Scoped claim: this catches the retired section bodies literally
// reappearing in the shell, which is what the original assertion guarded
// against. It is not a general proof that the pane host has grown no inline
// panel code — the registry owns its own wrappers (e.g. CodingFileBrowserPane)
// which could absorb behaviour without any of these declarations appearing.
for (const retiredInlineCodingSnippet of [
  'function FileTreeNode(',
  'function FileTreePanel(',
  'function DiffPanel(',
  'function FileContentViewer(',
  'function NewTerminalModal(',
  '<div className="coding-layout__terminal-bar">',
]) {
  if (builtinWorkspacePaneRegistry.includes(retiredInlineCodingSnippet)) {
    errors.push(
      `builtinWorkspacePaneRegistry.tsx must not inline extracted coding-layout UI ${retiredInlineCodingSnippet}.`,
    );
  }
}

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
if (!codingLayoutFileContent.includes('useCodingFileContentQuery')) {
  errors.push('FileContentViewer must use useCodingFileContentQuery.');
}

const codingLayoutTerminal = readRequiredSource(
  '../src-ui/src/components/coding-layout/CodingTerminalPanel.tsx',
);
for (const requiredImport of [
  '../acp-connections/ACPChatPanel',
  './TerminalPanel',
]) {
  if (!codingLayoutTerminal.includes(requiredImport)) {
    errors.push(
      `CodingTerminalPanel must render extracted terminal content via ${requiredImport}.`,
    );
  }
}

const codingLayoutUtils = readRequiredSource(
  '../src-ui/src/components/coding-layout/utils.ts',
);
if (!codingLayoutUtils.includes('export function buildNewTerminalItems')) {
  errors.push('coding-layout/utils.ts must export buildNewTerminalItems.');
}

const codingLayoutModal = readRequiredSource(
  '../src-ui/src/components/coding-layout/NewTerminalModal.tsx',
);
if (!codingLayoutModal.includes('buildNewTerminalItems')) {
  errors.push('NewTerminalModal must use buildNewTerminalItems.');
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
if (!voiceSession.includes('NovaVoiceSessionAdapter')) {
  errors.push('useVoiceSession must use the Nova voice session Adapter.');
}
if (!voiceSession.includes('../providers/voice/NovaVoiceSessionAdapter')) {
  errors.push(
    'useVoiceSession must delegate provider work to NovaVoiceSessionAdapter.',
  );
}
for (const retiredVoiceSnippet of [
  'function float32ToInt16(',
  'function downsample(',
  'function int16ToFloat32(',
  'function base64ToInt16(',
  'function int16ToBase64(',
]) {
  if (voiceSession.includes(retiredVoiceSnippet)) {
    errors.push(
      `useVoiceSession must not inline extracted audio helper ${retiredVoiceSnippet}.`,
    );
  }
}

const voiceSessionAudio = readRequiredSource(
  '../src-ui/src/hooks/voiceSessionAudio.ts',
);
for (const requiredVoiceHelper of [
  'export function float32ToInt16',
  'export function downsample',
  'export function int16ToFloat32',
  'export function base64ToInt16',
  'export function int16ToBase64',
]) {
  if (!voiceSessionAudio.includes(requiredVoiceHelper)) {
    errors.push(`voiceSessionAudio.ts must include ${requiredVoiceHelper}.`);
  }
}

const novaSonic = readRequiredSource(
  '../src-server/voice/providers/nova-sonic.ts',
);
if (!novaSonic.includes('./nova-sonic-events.js')) {
  errors.push(
    'nova-sonic.ts must delegate stream event parsing to nova-sonic-events.ts.',
  );
}
for (const retiredNovaSnippet of [
  "console.warn('[NovaSonic] Failed to parse response chunk:'",
  "this.emit('transcript'",
  "this.emit('audio', Buffer.from(event.audioOutput.content, 'base64'))",
  "this.emit('toolUse'",
]) {
  if (novaSonic.includes(retiredNovaSnippet)) {
    errors.push(
      `nova-sonic.ts must not inline extracted stream event helper ${retiredNovaSnippet}.`,
    );
  }
}

const novaSonicEvents = readRequiredSource(
  '../src-server/voice/providers/nova-sonic-events.ts',
);
for (const requiredNovaHelper of [
  'export function parseNovaSonicRawEvent',
  'export function processNovaSonicStreamEvent',
  "logger.warn('[NovaSonic] Failed to parse response chunk'",
  "effects.emit('transcript'",
  "effects.emit('toolUse'",
]) {
  if (!novaSonicEvents.includes(requiredNovaHelper)) {
    errors.push(`nova-sonic-events.ts must include ${requiredNovaHelper}.`);
  }
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
for (const requiredImport of [
  './agent-editor/AgentEditorBasicTab',
  './agent-editor/AgentEditorPromptTab',
  // station#3879: the engine question moved out of a tab and into
  // `AgentEditorEngineSelection`'s radio cards (#3721), and the advanced
  // section is now `AgentEditorModelOptionsSection`. Same responsibility,
  // same guardrail — the form still delegates rather than inlining.
  './agent-editor/AgentEditorEngineSelection',
  './agent-editor/AgentEditorModelOptionsSection',
  './agent-editor/AgentEditorCommandsTab',
  './agent-editor/AgentEditorToolsTab',
  './agent-editor/AgentEditorSkillsTab',
  './agent-editor/types',
  // No `AgentEditorConnectionTab`: there is no extracted connection module
  // any more. The form resolves the bound engine connection itself through
  // `useEngineConnectionsQuery`, so requiring an import here would require a
  // file nobody intends to write.
]) {
  if (!agentEditorForm.includes(requiredImport)) {
    errors.push(
      `AgentEditorForm must delegate extracted sections to ${requiredImport}.`,
    );
  }
}
for (const retiredInlineAgentEditorSnippet of [
  'function slugify(name: string)',
  'const { data: runtimeConnections = [] } =',
  'const enabledServers = new Set(form.tools.mcpServers);',
  'No skills enabled.',
  'Remove Guardrails',
]) {
  if (agentEditorForm.includes(retiredInlineAgentEditorSnippet)) {
    errors.push(
      `AgentEditorForm must not inline extracted editor logic ${retiredInlineAgentEditorSnippet}.`,
    );
  }
}

const agentEditorUtils = readRequiredSource(
  '../src-ui/src/views/agent-editor/utils.ts',
);
for (const requiredHelper of [
  'export function slugify',
  // station#3879: `buildDescriptionPrompt` no longer exists anywhere in
  // src-ui — the affordance it built copy for is gone.
  'export function buildSystemPromptPrompt',
  'export function removeIntegration',
  'export function toggleIntegrationToolEnabled',
  'export function toggleIntegrationToolAutoApprove',
]) {
  if (!agentEditorUtils.includes(requiredHelper)) {
    errors.push(`agent-editor/utils.ts must include ${requiredHelper}.`);
  }
}

const headerView = readRequiredSource(
  '../src-ui/src/components/header/Header.tsx',
);
if (headerView.includes('/api/connections/runtimes')) {
  errors.push('Header must use shared SDK runtime connection queries.');
}
for (const requiredImport of ['./HeaderActions', './useHeaderViewModel']) {
  if (!headerView.includes(requiredImport)) {
    errors.push(
      `Header.tsx must delegate extracted header logic to ${requiredImport}.`,
    );
  }
}
for (const retiredInlineHeaderSnippet of [
  'function getHelpPrompts(',
  '(currentView as any).projectSlug',
  '{showHelp && (',
  '{showOverflow && (',
  'const createChatSession = useCreateChatSession()',
  'const { activeConnection } = useConnections()',
  'checkServerHealth',
]) {
  if (headerView.includes(retiredInlineHeaderSnippet)) {
    errors.push(
      `Header.tsx must not inline extracted header logic ${retiredInlineHeaderSnippet}.`,
    );
  }
}
const headerUtils = readRequiredSource(
  '../src-ui/src/components/header/utils.ts',
);
for (const requiredHelper of [
  'export function getHelpPrompts',
  'export function getHeaderBreadcrumb',
]) {
  if (!headerUtils.includes(requiredHelper)) {
    errors.push(`header/utils.ts must include ${requiredHelper}.`);
  }
}

const headerActions = readRequiredSource(
  '../src-ui/src/components/header/HeaderActions.tsx',
);
for (const requiredHelper of [
  'export function HeaderActions',
  '@kontourai/station-connect',
  '../notifications/NotificationHistory',
  './HelpMenu',
  './OverflowMenu',
]) {
  if (!headerActions.includes(requiredHelper)) {
    errors.push(`HeaderActions.tsx must include ${requiredHelper}.`);
  }
}

const headerViewModel = readRequiredSource(
  '../src-ui/src/components/header/useHeaderViewModel.ts',
);
for (const requiredHelper of [
  'export function useHeaderViewModel',
  'useEngineConnectionsQuery',
  'useLaunchChat',
  'useNavigation',
  'getHelpPrompts',
  'getHeaderBreadcrumb',
]) {
  if (!headerViewModel.includes(requiredHelper)) {
    errors.push(`useHeaderViewModel.ts must include ${requiredHelper}.`);
  }
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
for (const requiredImport of [
  './provider-settings/ProviderConnectionForm',
  './provider-settings/ProviderStackOverview',
  './provider-settings/ProviderTypePicker',
  './provider-settings/types',
  './provider-settings/utils',
]) {
  if (!providerSettingsView.includes(requiredImport)) {
    errors.push(
      `ProviderSettingsView must delegate extracted provider sections to ${requiredImport}.`,
    );
  }
}
for (const retiredInlineProviderSnippet of [
  'const PROVIDER_TYPES:',
  'function capabilitiesForType(',
  'function defaultConfig(',
  'const typePicker = (',
  'const stackOverview = (',
  "{form.type === 'openai-compat' && (",
]) {
  if (providerSettingsView.includes(retiredInlineProviderSnippet)) {
    errors.push(
      `ProviderSettingsView must not inline extracted provider-settings logic ${retiredInlineProviderSnippet}.`,
    );
  }
}

const providerSettingsUtils = readRequiredSource(
  '../src-ui/src/views/provider-settings/utils.ts',
);
for (const requiredHelper of [
  'export function capabilitiesForType',
  'export function defaultConfig',
  'export function filterModelProviders',
  'export function describeProvider',
]) {
  if (!providerSettingsUtils.includes(requiredHelper)) {
    errors.push(`provider-settings/utils.ts must include ${requiredHelper}.`);
  }
}

const appShellView = readRequiredSource('../src-ui/src/App.tsx');
for (const requiredImport of [
  './app-shell/AppViewContent',
  './app-shell/routing',
]) {
  if (!appShellView.includes(requiredImport)) {
    errors.push(
      `App.tsx must delegate extracted app-shell logic to ${requiredImport}.`,
    );
  }
}
for (const retiredInlineAppSnippet of [
  'const layoutTypeRegistry:',
  'const renderViewContent = () => {',
  "if (path === '/agents' || path.startsWith('/agents/')) {",
  "if (path === '/connections/providers') {",
  "if (path === '/projects/new') {",
  'function ProjectLayoutRenderer(',
]) {
  if (appShellView.includes(retiredInlineAppSnippet)) {
    errors.push(
      `App.tsx must not inline extracted app-shell logic ${retiredInlineAppSnippet}.`,
    );
  }
}

const appRouting = readRequiredSource('../src-ui/src/app-shell/routing.ts');
for (const requiredHelper of [
  'export function resolveViewFromPath',
  'export function getPathForView',
]) {
  if (!appRouting.includes(requiredHelper)) {
    errors.push(`app-shell/routing.ts must include ${requiredHelper}.`);
  }
}

const appViewContent = readRequiredSource(
  '../src-ui/src/app-shell/AppViewContent.tsx',
);
for (const requiredImport of [
  '../views/AgentsView',
  '../views/ProviderSettingsView',
  './ProjectLayoutRenderer',
]) {
  if (!appViewContent.includes(requiredImport)) {
    errors.push(
      `AppViewContent must render extracted app views via ${requiredImport}.`,
    );
  }
}

const projectLayoutRenderer = readRequiredSource(
  '../src-ui/src/app-shell/ProjectLayoutRenderer.tsx',
);
if (!projectLayoutRenderer.includes('./layoutRegistry')) {
  errors.push('ProjectLayoutRenderer must use the extracted layout registry.');
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
for (const retiredInlineConnectionsHubSnippet of [
  'function IconCloud(',
  'function IconServer(',
  'function IconLink(',
  'function IconDatabase(',
  'function IconTool(',
  'function statusClass(',
  'function describeConnection(',
  'connections-hub__section-header',
]) {
  if (connectionsHubView.includes(retiredInlineConnectionsHubSnippet)) {
    errors.push(
      `ConnectionsHub must not inline extracted helper logic ${retiredInlineConnectionsHubSnippet}.`,
    );
  }
}

const connectionsHubUtils = readRequiredSource(
  '../src-ui/src/views/connections-hub/utils.tsx',
);
for (const requiredHelper of [
  'export function getProviderIcon',
  'export function getConnectionStatusClass',
  'export function describeConnection',
  // station#3879: `getConnectionTypeText` no longer exists in the repo.
  'export function IconDatabase',
  'export function IconTool',
]) {
  if (!connectionsHubUtils.includes(requiredHelper)) {
    errors.push(`connections-hub/utils.tsx must include ${requiredHelper}.`);
  }
}

const connectionsHubSection = readRequiredSource(
  '../src-ui/src/views/connections-hub/ConnectionsHubSection.tsx',
);
if (!connectionsHubSection.includes('export function ConnectionsHubSection')) {
  errors.push('ConnectionsHubSection.tsx must export ConnectionsHubSection.');
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
if (!onboardingGate.includes('../lib/serverHealth')) {
  errors.push('OnboardingGate must use the shared server health helper.');
}

const connectionBannerSource = readRequiredSource(
  '../src-ui/src/components/notifications/ConnectionBannerSource.tsx',
);
if (connectionBannerSource.includes('/api/system/status')) {
  errors.push(
    'ConnectionBannerSource must not issue direct system status checks.',
  );
}
if (!connectionBannerSource.includes('../lib/serverHealth')) {
  errors.push(
    'ConnectionBannerSource must use the shared server health helper.',
  );
}

const projectSettingsView = readRequiredSource(
  '../src-ui/src/views/ProjectSettingsView.tsx',
);
if (projectSettingsView.includes('fetch(')) {
  errors.push('ProjectSettingsView must not issue raw fetch() calls.');
}
if (!projectSettingsView.includes('useProjectQuery')) {
  errors.push('ProjectSettingsView must use shared SDK project hooks.');
}
for (const requiredImport of [
  './project-settings/AgentsSection',
  './project-settings/LayoutsSection',
  './project-settings/KnowledgeSection',
  './project-settings/types',
  './project-settings/utils',
]) {
  if (!projectSettingsView.includes(requiredImport)) {
    errors.push(
      `ProjectSettingsView must delegate extracted UI to ${requiredImport}.`,
    );
  }
}
for (const retiredInlineProjectSettingsSnippet of [
  'function AgentsSection({',
  'function LayoutsSection({',
  'function KnowledgeSection({',
  'interface DocMeta {',
  'interface KnowledgeStatus {',
  'const timeAgo = (iso: string) => {',
  'const f: ProjectForm = {',
]) {
  if (projectSettingsView.includes(retiredInlineProjectSettingsSnippet)) {
    errors.push(
      `ProjectSettingsView must not inline extracted project-settings logic ${retiredInlineProjectSettingsSnippet}.`,
    );
  }
}

const projectSettingsUtils = readRequiredSource(
  '../src-ui/src/views/project-settings/utils.ts',
);
for (const requiredHelper of [
  'export function buildProjectForm',
  'export function getKnowledgeTimeAgo',
]) {
  if (!projectSettingsUtils.includes(requiredHelper)) {
    errors.push(`project-settings/utils.ts must include ${requiredHelper}.`);
  }
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
for (const requiredImport of [
  './settings/EnvironmentStatus',
  './settings/VoiceFeaturesSection',
  './settings/AccentColorPicker',
  './settings/AgentDefaultsSection',
  './settings/StationConfigSection',
  './settings/SystemSection',
  './settings/settings-catalog',
  './settings/utils',
]) {
  if (!settingsView.includes(requiredImport)) {
    errors.push(`SettingsView must delegate section UI to ${requiredImport}.`);
  }
}
if (!settingsView.includes('useConfigProvenanceQuery')) {
  errors.push('SettingsView must use the shared config provenance query.');
}
for (const retiredInlineSettingsSnippet of [
  'const SECTION_TERMS: Record<string, string> = {',
  'const validationErrors: Record<string, string> = {};',
  '<Section icon="◆" title="AI & Models" id="section-ai">',
  '<Section icon="◇" title="Connection" id="section-connection">',
  '<Section icon="⚙" title="System" id="section-system">',
  'const LOCAL_KEYS = [',
]) {
  if (settingsView.includes(retiredInlineSettingsSnippet)) {
    errors.push(
      `SettingsView must not inline extracted settings logic ${retiredInlineSettingsSnippet}.`,
    );
  }
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

const settingsUtils = readRequiredSource(
  '../src-ui/src/views/settings/utils.ts',
);
for (const requiredHelper of [
  'export function getSettingsValidation',
  'export function isSettingsSectionVisible',
  "from './settings-search'",
]) {
  if (!settingsUtils.includes(requiredHelper)) {
    errors.push(`settings/utils.ts must include ${requiredHelper}.`);
  }
}

const pluginManagementView = readRequiredSource(
  '../src-ui/src/views/PluginManagementView.tsx',
);
if (pluginManagementView.includes('fetch(')) {
  errors.push('PluginManagementView must not issue raw fetch() calls.');
}
for (const requiredImport of [
  './plugin-management/PluginDetailPanel',
  './plugin-management/PluginEmptyState',
  './plugin-management/PluginModalStack',
  './plugin-management/usePluginManagementViewModel',
]) {
  if (!pluginManagementView.includes(requiredImport)) {
    errors.push(
      `PluginManagementView must delegate extracted UI to ${requiredImport}.`,
    );
  }
}
for (const retiredInlinePluginSnippet of [
  '<DetailHeader',
  'className="plugins__providers-toggle"',
  'overlayClassName="plugins__confirm-overlay"',
  'className="plugins__update-banner"',
  'className="plugins__settings-form"',
]) {
  if (pluginManagementView.includes(retiredInlinePluginSnippet)) {
    errors.push(
      `PluginManagementView must not inline extracted plugin-management UI ${retiredInlinePluginSnippet}.`,
    );
  }
}
for (const requiredHook of [
  'usePluginManagementViewModel',
  'PluginDetailPanel',
  'PluginEmptyState',
  'PluginModalStack',
  "onNavigate({ type: 'registry', tab: 'plugins' })",
]) {
  if (!pluginManagementView.includes(requiredHook)) {
    errors.push(
      `PluginManagementView must use shared SDK helper ${requiredHook}.`,
    );
  }
}
for (const retiredInlinePluginLogic of [
  'usePluginSettingsQuery',
  'usePluginChangelogQuery',
  'usePluginProvidersQuery',
  'usePluginSettingsMutation',
  'useReloadPluginsMutation',
  'useCreateProjectMutation',
  'useAddProjectLayoutFromPluginMutation',
  'waitForAgentHealth',
  'async function install(',
  'function updatePlugin(',
  'function remove(',
]) {
  if (pluginManagementView.includes(retiredInlinePluginLogic)) {
    errors.push(
      `PluginManagementView must not inline extracted plugin-management logic ${retiredInlinePluginLogic}.`,
    );
  }
}

const pluginManagementViewModel = readRequiredSource(
  '../src-ui/src/views/plugin-management/usePluginManagementViewModel.ts',
);
for (const requiredHelper of [
  'export function usePluginManagementViewModel',
  'usePluginSettingsQuery',
  'usePluginChangelogQuery',
  'usePluginProvidersQuery',
  'usePluginSettingsMutation',
  'useReloadPluginsMutation',
  'useCreateProjectMutation',
  'useAddProjectLayoutFromPluginMutation',
  'waitForAgentHealth',
  'toggleSetValue',
]) {
  if (!pluginManagementViewModel.includes(requiredHelper)) {
    errors.push(
      `plugin-management/usePluginManagementViewModel.ts must include ${requiredHelper}.`,
    );
  }
}

const pluginManagementUtils = readRequiredSource(
  '../src-ui/src/views/plugin-management/view-utils.ts',
);
for (const requiredHelper of [
  'export function filterPlugins',
  'export function buildPluginListItems',
  'export function slugifyProjectName',
  'export function toggleSetValue',
]) {
  if (!pluginManagementUtils.includes(requiredHelper)) {
    errors.push(
      `plugin-management/view-utils.ts must include ${requiredHelper}.`,
    );
  }
}

const pluginEmptyState = readRequiredSource(
  '../src-ui/src/views/plugin-management/PluginEmptyState.tsx',
);
if (!pluginEmptyState.includes('export function PluginEmptyState')) {
  errors.push('PluginEmptyState.tsx must export PluginEmptyState.');
}

const pluginDetailPanel = readRequiredSource(
  '../src-ui/src/views/plugin-management/PluginDetailPanel.tsx',
);
for (const requiredHelper of [
  'export function PluginDetailPanel',
  'PluginSettingFieldRow',
  'className="plugins__providers-toggle"',
]) {
  if (!pluginDetailPanel.includes(requiredHelper)) {
    errors.push(`PluginDetailPanel.tsx must include ${requiredHelper}.`);
  }
}

const pluginModalStack = readRequiredSource(
  '../src-ui/src/views/plugin-management/PluginModalStack.tsx',
);
for (const requiredHelper of [
  'export function PluginModalStack',
  'InstallPluginModal',
  'LayoutAssignmentModal',
  'overlayClassName="plugins__confirm-overlay"',
  // #1014: plugin management's folder picker is no longer its own component
  // (FolderPickerModal.tsx was deleted, a pure classNames adapter with one
  // consumer) — PluginModalStack renders the shared FolderBrowserModal
  // directly. This name must stay so plugin management cannot silently lose
  // its folder picker to a future edit.
  'FolderBrowserModal',
]) {
  if (!pluginModalStack.includes(requiredHelper)) {
    errors.push(`PluginModalStack.tsx must include ${requiredHelper}.`);
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

const installPluginModal = readRequiredSource(
  '../src-ui/src/views/plugin-management/InstallPluginModal.tsx',
);
if (!installPluginModal.includes('PathAutocomplete')) {
  errors.push(
    'InstallPluginModal must own the PathAutocomplete install input.',
  );
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
for (const requiredImport of ['./agent-editor/useAgentsViewModel']) {
  if (!agentsView.includes(requiredImport)) {
    errors.push(
      `AgentsView must delegate extracted helpers to ${requiredImport}.`,
    );
  }
}
for (const retiredInlineAgentSnippet of [
  'const EMPTY_FORM: AgentFormData = {',
  'function formFromAgent(agent: any): AgentFormData {',
  'function isDirty(form: AgentFormData, saved: AgentFormData): boolean {',
  'const grouped: Record<string, Tool[]> = {};',
  'const [form, setForm] = useState<AgentFormData>(() => createEmptyAgentForm());',
  'const [savedForm, setSavedForm] = useState<AgentFormData>(() =>',
  'const [isSaving, setIsSaving] = useState(false);',
  'const [validationErrors, setValidationErrors] = useState<',
  'async function handleSave() {',
  'async function handleDelete() {',
]) {
  if (agentsView.includes(retiredInlineAgentSnippet)) {
    errors.push(
      `AgentsView must not inline extracted agent helper ${retiredInlineAgentSnippet}.`,
    );
  }
}

const agentsViewModel = readRequiredSource(
  '../src-ui/src/views/agent-editor/useAgentsViewModel.ts',
);
for (const requiredHelper of [
  'export function useAgentsViewModel',
  'buildAgentPayload',
  'buildAgentsViewEmptyContent',
  'buildAgentsViewItems',
  'createEmptyAgentForm',
  'useUnsavedGuard',
]) {
  if (!agentsViewModel.includes(requiredHelper)) {
    errors.push(`useAgentsViewModel.ts must include ${requiredHelper}.`);
  }
}
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
if (!pluginRoutes.includes('./plugin-config-routes.js')) {
  errors.push(
    'Plugin routes must delegate settings and metadata handlers to plugin-config-routes.ts.',
  );
}
if (!pluginRoutes.includes('./plugin-lifecycle-routes.js')) {
  errors.push(
    'Plugin routes must delegate lifecycle handlers to plugin-lifecycle-routes.ts.',
  );
}
if (!pluginRoutes.includes('./plugin-install-routes.js')) {
  errors.push(
    'Plugin routes must delegate discovery/install handlers to plugin-install-routes.ts.',
  );
}
if (!pluginRoutes.includes('./plugin-public-routes.js')) {
  errors.push(
    'Plugin routes must delegate public bundle/fetch handlers to plugin-public-routes.ts.',
  );
}
if (!pluginRoutes.includes('./plugin-bundles.js')) {
  errors.push(
    'Plugin routes must delegate bundle/build helpers to plugin-bundles.ts.',
  );
}
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

const pluginConfigRoutes = readRequiredSource(
  '../src-server/routes/plugins/plugin-config-routes.ts',
);
for (const requiredHelper of [
  'export function registerPluginConfigRoutes',
  'pluginSettingsUpdates.add',
  "app.get('/:name/changelog'",
  "app.put('/:name/overrides'",
]) {
  if (!pluginConfigRoutes.includes(requiredHelper)) {
    errors.push(`plugin-config-routes.ts must include ${requiredHelper}.`);
  }
}

const pluginLifecycleRoutes = readRequiredSource(
  '../src-server/routes/plugins/plugin-lifecycle-routes.ts',
);
for (const requiredHelper of [
  'export function registerPluginLifecycleRoutes',
  "app.get('/check-updates'",
  "app.post('/:name/update'",
  "app.delete('/:name'",
  "app.post('/reload'",
]) {
  if (!pluginLifecycleRoutes.includes(requiredHelper)) {
    errors.push(`plugin-lifecycle-routes.ts must include ${requiredHelper}.`);
  }
}

const pluginInstallRoutes = readRequiredSource(
  '../src-server/routes/plugins/plugin-install-routes.ts',
);
for (const requiredHelper of [
  'export function registerPluginInstallRoutes',
  "app.get('/',",
  "app.post('/preview'",
  "app.post('/install'",
  './plugin-install-shared.js',
  './plugin-source.js',
  './plugin-bundles.js',
]) {
  if (!pluginInstallRoutes.includes(requiredHelper)) {
    errors.push(`plugin-install-routes.ts must include ${requiredHelper}.`);
  }
}

const pluginPublicRoutes = readRequiredSource(
  '../src-server/routes/plugins/plugin-public-routes.ts',
);
if (!pluginPublicRoutes.includes('./plugin-public-server.js')) {
  errors.push(
    'plugin-public-routes.ts must delegate server module request/context helpers to plugin-public-server.ts.',
  );
}
for (const requiredHelper of [
  'export function registerPluginPublicRoutes',
  "app.get('/:name/bundle.js'",
  "app.get('/:name/bundle.css'",
  "app.get('/:name/permissions'",
  "app.post('/:name/grant'",
  "app.post('/:name/fetch'",
  "app.post('/fetch'",
]) {
  if (!pluginPublicRoutes.includes(requiredHelper)) {
    errors.push(`plugin-public-routes.ts must include ${requiredHelper}.`);
  }
}
for (const retiredPluginPublicSnippet of [
  'function buildRequestContext(',
  'function createScopedRequest(',
  'async function readPluginManifest(',
  'async function readPluginSettings(',
  'async function loadPluginServerModule(',
]) {
  if (pluginPublicRoutes.includes(retiredPluginPublicSnippet)) {
    errors.push(
      `plugin-public-routes.ts must not inline extracted helper ${retiredPluginPublicSnippet}.`,
    );
  }
}

const pluginPublicServer = readRequiredSource(
  '../src-server/routes/plugins/plugin-public-server.ts',
);
for (const requiredHelper of [
  'export function buildPluginRequestContext',
  'export function createScopedPluginRequest',
  'export async function readPluginPublicManifest',
  'export async function readPluginServerSettings',
  'export async function loadPluginPublicServerModule',
]) {
  if (!pluginPublicServer.includes(requiredHelper)) {
    errors.push(`plugin-public-server.ts must include ${requiredHelper}.`);
  }
}

const pluginBundles = readRequiredSource(
  '../src-server/routes/plugins/plugin-bundles.ts',
);
for (const requiredHelper of [
  'export function resolvePluginBundle',
  'export async function buildPlugin',
  '@kontourai/station-shared/build',
]) {
  if (!pluginBundles.includes(requiredHelper)) {
    errors.push(`plugin-bundles.ts must include ${requiredHelper}.`);
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

const navigationContext = readRequiredSource(
  '../src-ui/src/contexts/NavigationContext.tsx',
);
for (const requiredImport of ['./navigation-store']) {
  if (!navigationContext.includes(requiredImport)) {
    errors.push(`NavigationContext.tsx must use ${requiredImport}.`);
  }
}
for (const retiredInlineNavigationSnippet of [
  'class NavigationStore',
  'const LAST_PROJECT_KEY =',
  'const LAST_PROJECT_LAYOUT_KEY =',
  'private parseUrl(): NavigationState',
  'private handlePopState = () =>',
  'export const navigationStore = new NavigationStore()',
]) {
  if (navigationContext.includes(retiredInlineNavigationSnippet)) {
    errors.push(
      `NavigationContext.tsx must not inline extracted navigation store helper ${retiredInlineNavigationSnippet}.`,
    );
  }
}

const navigationStoreFile = readRequiredSource(
  '../src-ui/src/contexts/navigation-store.ts',
);
for (const requiredHelper of [
  'export type NavigationState',
  'class NavigationStore',
  'export const navigationStore = new NavigationStore()',
  'LAST_PROJECT_KEY',
  'private parseUrl(): NavigationState',
]) {
  if (!navigationStoreFile.includes(requiredHelper)) {
    errors.push(`navigation-store.ts must include ${requiredHelper}.`);
  }
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
  './ACPConnectionCard',
  './ACPConnectionDetailModal',
  './ACPAddConnectionModal',
]) {
  if (!acpConnectionsSection.includes(requiredHelper)) {
    errors.push(
      `ACPConnectionsSection must use shared ACP helper ${requiredHelper}.`,
    );
  }
}
for (const retiredInlineAcpConnectionsSnippet of [
  'function ConnectionIcon(',
  'function ConnectionCard(',
  'function AddConnectionModal(',
  'function ConnectionDetailModal(',
  'const statusLabel = isUnavailable',
  'const sectionLabel: React.CSSProperties =',
]) {
  if (acpConnectionsSection.includes(retiredInlineAcpConnectionsSnippet)) {
    errors.push(
      `ACPConnectionsSection must not inline extracted ACP UI ${retiredInlineAcpConnectionsSnippet}.`,
    );
  }
}

const acpConnectionCard = readRequiredSource(
  '../src-ui/src/components/acp-connections/ACPConnectionCard.tsx',
);
for (const requiredHelper of [
  'export function ACPConnectionCard',
  './ConnectionIcon',
  './utils',
  '../modals/ConfirmModal',
]) {
  if (!acpConnectionCard.includes(requiredHelper)) {
    errors.push(`ACPConnectionCard.tsx must include ${requiredHelper}.`);
  }
}

const acpConnectionDetailModal = readRequiredSource(
  '../src-ui/src/components/acp-connections/ACPConnectionDetailModal.tsx',
);
for (const requiredHelper of [
  'export function ACPConnectionDetailModal',
  './ConnectionIcon',
  './utils',
]) {
  if (!acpConnectionDetailModal.includes(requiredHelper)) {
    errors.push(`ACPConnectionDetailModal.tsx must include ${requiredHelper}.`);
  }
}

const acpAddConnectionModal = readRequiredSource(
  '../src-ui/src/components/acp-connections/ACPAddConnectionModal.tsx',
);
if (!acpAddConnectionModal.includes('export function ACPAddConnectionModal')) {
  errors.push('ACPAddConnectionModal.tsx must export ACPAddConnectionModal.');
}

const acpConnectionUtils = readRequiredSource(
  '../src-ui/src/components/acp-connections/utils.ts',
);
if (
  !acpConnectionUtils.includes('export function getACPConnectionStatusView')
) {
  errors.push(
    'acp-connections/utils.ts must export getACPConnectionStatusView.',
  );
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
if (!usageStatsPanel.includes('useResetUsageStatsMutation')) {
  errors.push('UsageStatsPanel must use the shared usage reset mutation.');
}
for (const requiredImport of [
  './UsageSummaryCards',
  './UsageBreakdownSection',
  './UsageDrillDownModal',
  './utils',
]) {
  if (!usageStatsPanel.includes(requiredImport)) {
    errors.push(
      `UsageStatsPanel must delegate extracted UI to ${requiredImport}.`,
    );
  }
}
for (const retiredInlineUsageSnippet of [
  'function StatCard({',
  'function ModelRow({',
  'function AgentRow({',
  'function DrillDownModal({',
  'Object.entries(byModel',
  'Object.entries(byAgent',
  '? lifetime.totalCost / lifetime.totalMessages',
  ').totalConversations ??',
  ').totalSessions ??',
]) {
  if (usageStatsPanel.includes(retiredInlineUsageSnippet)) {
    errors.push(
      `UsageStatsPanel must not inline extracted usage-stats logic ${retiredInlineUsageSnippet}.`,
    );
  }
}

const usageStatsUtils = readRequiredSource(
  '../src-ui/src/components/usage-stats/utils.ts',
);
for (const requiredHelper of [
  'export function getAverageCostPerMessage',
  'export function getTotalUsageConversations',
  'export function getTopUsageEntries',
  'export function getUsageModelDisplayName',
  'export function getUsageAgentsForModel',
  'export function getAgentModelBreakdown',
]) {
  if (!usageStatsUtils.includes(requiredHelper)) {
    errors.push(`usage-stats/utils.ts must include ${requiredHelper}.`);
  }
}

const insightsDashboard = readRequiredSource(
  '../src-ui/src/components/monitoring/InsightsDashboard.tsx',
);
if (insightsDashboard.includes('fetch(')) {
  errors.push('InsightsDashboard must not issue raw fetch() calls.');
}
if (!insightsDashboard.includes('./insightsDashboardUtils')) {
  errors.push(
    'InsightsDashboard must delegate derived usage/feedback helpers to insightsDashboardUtils.ts.',
  );
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
for (const retiredInsightsSnippet of [
  'const maxHourly = Math.max(',
  'const topTools = Object.entries(data.toolUsage)',
  'const relativeTime = (iso?: string) => {',
  'const relativeIn = (iso?: string) => {',
]) {
  if (insightsDashboard.includes(retiredInsightsSnippet)) {
    errors.push(
      `InsightsDashboard must not inline extracted helper ${retiredInsightsSnippet}.`,
    );
  }
}

const insightsDashboardUtils = readRequiredSource(
  '../src-ui/src/components/monitoring/insightsDashboardUtils.ts',
);
for (const requiredHelper of [
  'export function getInsightsUsageView',
  'export function getHourlyBarStyle',
  'export function summarizeFeedbackRatings',
  'export function formatRelativePast',
  'export function formatRelativeFuture',
]) {
  if (!insightsDashboardUtils.includes(requiredHelper)) {
    errors.push(`insightsDashboardUtils.ts must include ${requiredHelper}.`);
  }
}

const metricsPanel = readRequiredSource(
  '../src-ui/src/components/monitoring/MetricsPanel.tsx',
);
if (metricsPanel.includes('fetch(')) {
  errors.push('MetricsPanel must not issue raw fetch() calls.');
}
if (!metricsPanel.includes('useMonitoringMetricsQuery')) {
  errors.push('MetricsPanel must use the shared monitoring metrics query.');
}

const monitoringView = readRequiredSource(
  '../src-ui/src/views/MonitoringView.tsx',
);
for (const requiredImport of [
  './MonitoringTimeControls',
  './MonitoringLogControls',
  './MonitoringErrorBoundary',
  './monitoring/MonitoringHeader',
  './monitoring/MonitoringLogStream',
  './monitoring/MonitoringSidebar',
  './monitoring/MonitoringActiveFilters',
  './monitoring/useMonitoringFilters',
  './monitoring/view-utils',
  './monitoring-time-range',
]) {
  if (!monitoringView.includes(requiredImport)) {
    errors.push(`MonitoringView must use ${requiredImport}.`);
  }
}
for (const retiredInlineMonitoringSnippet of [
  'const elapsed = Date.now() - startTime.getTime();',
  'RELATIVE_TIME_OPTIONS.map((option) => {',
  'className="time-filter-button"',
  'className="search-wrapper"',
  'className="monitoring-header"',
  'className="monitoring-sidebar"',
  'className="active-filters-inline"',
  'class MonitoringErrorBoundary extends Component',
  '<EventEntry',
  'const [selectedAgents, setSelectedAgents] = useState<string[]>([]);',
  'const [selectedConversation, setSelectedConversation] = useState<',
  'const [selectedToolCallId, setSelectedToolCallId] = useState<string | null>(',
  'const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);',
  'const [eventTypeFilter, setEventTypeFilter] = useState<string[]>(',
  'const syncFiltersFromQuery = (query: string) => {',
  'const toggleEventType = (group: string) => {',
]) {
  if (monitoringView.includes(retiredInlineMonitoringSnippet)) {
    errors.push(
      `MonitoringView must not inline extracted monitoring control logic ${retiredInlineMonitoringSnippet}.`,
    );
  }
}
if (!monitoringView.includes('isLoading,')) {
  errors.push('MonitoringView must read isLoading from useMonitoring.');
}

const monitoringLogStream = readRequiredSource(
  '../src-ui/src/views/monitoring/MonitoringLogStream.tsx',
);
for (const requiredHelper of [
  'export function MonitoringLogStream',
  'EventEntry',
  'monitoringEventIdentity',
]) {
  if (!monitoringLogStream.includes(requiredHelper)) {
    errors.push(`MonitoringLogStream.tsx must include ${requiredHelper}.`);
  }
}

const monitoringFiltersHook = readRequiredSource(
  '../src-ui/src/views/monitoring/useMonitoringFilters.ts',
);
for (const requiredHelper of [
  'export function useMonitoringFilters',
  'parseMonitoringSearchQuery',
  'EVENT_TYPE_GROUPS',
]) {
  if (!monitoringFiltersHook.includes(requiredHelper)) {
    errors.push(`useMonitoringFilters.ts must include ${requiredHelper}.`);
  }
}

const projectSidebar = readRequiredSource(
  '../src-ui/src/components/project-sidebar/ProjectSidebar.tsx',
);
for (const requiredImport of [
  './ProjectSidebarHeader',
  './ProjectSidebarNav',
  './ProjectSidebarRow',
  './useProjectSidebarState',
  './utils',
]) {
  if (!projectSidebar.includes(requiredImport)) {
    errors.push(`ProjectSidebar.tsx must use ${requiredImport}.`);
  }
}
for (const retiredInlineProjectSidebarSnippet of [
  'const NAV_ITEMS:',
  'function useIsMobile()',
  'function ProjectRow(',
  "const STORAGE_KEY = 'station-sidebar-collapsed';",
  'className="sidebar__header"',
  'className="sidebar__nav"',
]) {
  if (projectSidebar.includes(retiredInlineProjectSidebarSnippet)) {
    errors.push(
      `ProjectSidebar.tsx must not inline extracted sidebar helper ${retiredInlineProjectSidebarSnippet}.`,
    );
  }
}

const projectSidebarRow = readRequiredSource(
  '../src-ui/src/components/project-sidebar/ProjectSidebarRow.tsx',
);
for (const requiredHelper of [
  'export function ProjectSidebarRow',
  '@kontourai/station-sdk',
  '../../contexts/NavigationContext',
  '../icons/LayoutIcon',
]) {
  if (!projectSidebarRow.includes(requiredHelper)) {
    errors.push(`ProjectSidebarRow.tsx must include ${requiredHelper}.`);
  }
}

const projectSidebarHeader = readRequiredSource(
  '../src-ui/src/components/project-sidebar/ProjectSidebarHeader.tsx',
);
for (const requiredHelper of [
  'export function ProjectSidebarHeader',
  'sidebar__header',
  'sidebar__collapse-button',
]) {
  if (!projectSidebarHeader.includes(requiredHelper)) {
    errors.push(`ProjectSidebarHeader.tsx must include ${requiredHelper}.`);
  }
}

const projectSidebarNav = readRequiredSource(
  '../src-ui/src/components/project-sidebar/ProjectSidebarNav.tsx',
);
for (const requiredHelper of [
  'export function ProjectSidebarNav',
  './nav-items',
  'sidebar__nav',
  'sidebar__nav-btn',
]) {
  if (!projectSidebarNav.includes(requiredHelper)) {
    errors.push(`ProjectSidebarNav.tsx must include ${requiredHelper}.`);
  }
}

const projectSidebarState = readRequiredSource(
  '../src-ui/src/components/project-sidebar/useProjectSidebarState.ts',
);
for (const requiredHelper of [
  'export { useIsMobile }',
  'export function useProjectSidebarState',
  '../../contexts/DeviceSettingsContext',
  "window.addEventListener('toggle-sidebar'",
]) {
  if (!projectSidebarState.includes(requiredHelper)) {
    errors.push(`useProjectSidebarState.ts must include ${requiredHelper}.`);
  }
}

const projectSidebarUtils = readRequiredSource(
  '../src-ui/src/components/project-sidebar/utils.ts',
);
for (const requiredHelper of ['export function buildSidebarClassName']) {
  if (!projectSidebarUtils.includes(requiredHelper)) {
    errors.push(`project-sidebar/utils.ts must include ${requiredHelper}.`);
  }
}

const scheduleView = readRequiredSource('../src-ui/src/views/ScheduleView.tsx');
for (const requiredImport of [
  './schedule/ScheduleStats',
  './schedule/ScheduleEmptyState',
  './schedule/ScheduleJobsTable',
  './schedule/utils',
]) {
  if (!scheduleView.includes(requiredImport)) {
    errors.push(
      `ScheduleView must delegate extracted schedule UI to ${requiredImport}.`,
    );
  }
}
for (const retiredInlineScheduleSnippet of [
  'const statsMap = new Map<',
  'const utcHour = (localHour: number) => {',
  '<TableFilter',
  '<SortHeader',
  'className="schedule__starter-btn"',
  'className="schedule__table"',
  'className="schedule__stats"',
]) {
  if (scheduleView.includes(retiredInlineScheduleSnippet)) {
    errors.push(
      `ScheduleView must not inline extracted schedule UI ${retiredInlineScheduleSnippet}.`,
    );
  }
}

const scheduleUtils = readRequiredSource(
  '../src-ui/src/views/schedule/utils.ts',
);
for (const requiredHelper of [
  'export function getScheduleStatusTone',
  'export function getScheduleStatusLabel',
  'export function getScheduleStarterTemplates',
  'export function buildEnrichedSchedulerJobs',
]) {
  if (!scheduleUtils.includes(requiredHelper)) {
    errors.push(`schedule/utils.ts must include ${requiredHelper}.`);
  }
}

const monitoringViewUtils = readRequiredSource(
  '../src-ui/src/views/monitoring/view-utils.ts',
);
for (const requiredHelper of [
  'export function filterMonitoringEvents',
  'export function getHistoricalAgentSlugs',
  'export function getMonitoringAgentCountLabel',
  'export function getRunningConversations',
]) {
  if (!monitoringViewUtils.includes(requiredHelper)) {
    errors.push(`monitoring/view-utils.ts must include ${requiredHelper}.`);
  }
}

const monitoringHeader = readRequiredSource(
  '../src-ui/src/views/monitoring/MonitoringHeader.tsx',
);
if (!monitoringHeader.includes('export function MonitoringHeader')) {
  errors.push('MonitoringHeader.tsx must export MonitoringHeader.');
}

const monitoringSidebar = readRequiredSource(
  '../src-ui/src/views/monitoring/MonitoringSidebar.tsx',
);
for (const requiredHelper of [
  'export function MonitoringSidebar',
  'getMonitoringAgentCountLabel',
  'getRunningConversations',
]) {
  if (!monitoringSidebar.includes(requiredHelper)) {
    errors.push(`MonitoringSidebar.tsx must include ${requiredHelper}.`);
  }
}

const monitoringActiveFilters = readRequiredSource(
  '../src-ui/src/views/monitoring/MonitoringActiveFilters.tsx',
);
if (
  !monitoringActiveFilters.includes('export function MonitoringActiveFilters')
) {
  errors.push(
    'MonitoringActiveFilters.tsx must export MonitoringActiveFilters.',
  );
}

const monitoringErrorBoundary = readRequiredSource(
  '../src-ui/src/views/MonitoringErrorBoundary.tsx',
);
for (const requiredHelper of [
  'class MonitoringErrorBoundary extends Component',
  'export function MonitoringViewBoundary',
]) {
  if (!monitoringErrorBoundary.includes(requiredHelper)) {
    errors.push(`MonitoringErrorBoundary.tsx must include ${requiredHelper}.`);
  }
}

const monitoringTimeControls = readRequiredSource(
  '../src-ui/src/views/MonitoringTimeControls.tsx',
);
for (const requiredHelper of [
  'export function MonitoringTimeControls',
  'RELATIVE_TIME_OPTIONS.map((option) => {',
  'className="time-filter-button"',
  'live-mode-toggle',
]) {
  if (!monitoringTimeControls.includes(requiredHelper)) {
    errors.push(`MonitoringTimeControls.tsx must include ${requiredHelper}.`);
  }
}

const monitoringLogControls = readRequiredSource(
  '../src-ui/src/views/MonitoringLogControls.tsx',
);
for (const requiredHelper of [
  'export function MonitoringLogControls',
  'className="search-wrapper"',
  'className="autocomplete-dropdown"',
  'EVENT_TYPE_GROUPS',
]) {
  if (!monitoringLogControls.includes(requiredHelper)) {
    errors.push(`MonitoringLogControls.tsx must include ${requiredHelper}.`);
  }
}

const monitoringTimeRange = readRequiredSource(
  '../src-ui/src/views/monitoring-time-range.ts',
);
for (const requiredHelper of [
  'export function useMonitoringTimeRange',
  'export function getMonitoringElapsedLabel',
  'export function getMonitoringTimeLabel',
  'export function getMonitoringTimeSublabel',
  'export function toLocalDateTimeInput',
]) {
  if (!monitoringTimeRange.includes(requiredHelper)) {
    errors.push(`monitoring-time-range.ts must include ${requiredHelper}.`);
  }
}

const activeChatsContextSource = readRequiredSource(
  '../src-ui/src/contexts/ActiveChatsContext.tsx',
);
for (const requiredImport of [
  './active-chats-store',
  '../hooks/usePruneActiveChats',
]) {
  if (!activeChatsContextSource.includes(requiredImport)) {
    errors.push(`ActiveChatsContext must use ${requiredImport}.`);
  }
}
for (const retiredInlineActiveChatHook of [
  'export function useSendMessage',
  'export function useCancelMessage',
  'export function useCreateChatSession',
  'export function useOpenConversation',
  'export function useRehydrateSessions',
  'const { sendMessage: sendToServer, fetchMessages } = useConversationActions();',
]) {
  if (activeChatsContextSource.includes(retiredInlineActiveChatHook)) {
    errors.push(
      `ActiveChatsContext must not inline extracted session hook logic ${retiredInlineActiveChatHook}.`,
    );
  }
}

const activeChatsStoreSource = readRequiredSource(
  '../src-ui/src/contexts/active-chats-store.ts',
);
for (const requiredHelper of [
  'export class ActiveChatsStore',
  'export const activeChatsStore = new ActiveChatsStore();',
  'setBackendMessagesResolver(',
  'const backendConversationId = chat.conversationId ?? sessionId;',
]) {
  if (!activeChatsStoreSource.includes(requiredHelper)) {
    errors.push(`active-chats-store.ts must include ${requiredHelper}.`);
  }
}
if (activeChatsStoreSource.includes('./ConversationsContext')) {
  errors.push(
    'active-chats-store.ts must not depend directly on ConversationsContext.',
  );
}

const activeChatSessions = readRequiredSource(
  '../src-ui/src/hooks/useActiveChatSessions.ts',
);
for (const requiredHelper of [
  'export {',
  './useActiveChatSessionLifecycle',
  './useActiveChatSessionMessaging',
]) {
  if (!activeChatSessions.includes(requiredHelper)) {
    errors.push(`useActiveChatSessions.ts must include ${requiredHelper}.`);
  }
}
for (const retiredActiveChatSessionSnippet of [
  'export function usePruneActiveChats',
  'export function useSendMessage',
  'export function useCancelMessage',
  'export function useCreateChatSession',
  'export function useOpenConversation',
  'export function useLaunchChat',
  'export function useRehydrateSessions',
]) {
  if (activeChatSessions.includes(retiredActiveChatSessionSnippet)) {
    errors.push(
      `useActiveChatSessions.ts must stay a thin barrel and not inline ${retiredActiveChatSessionSnippet}.`,
    );
  }
}

const activeChatSessionLifecycle = readRequiredSource(
  '../src-ui/src/hooks/useActiveChatSessionLifecycle.ts',
);
for (const requiredHelper of [
  'export function useCreateChatSession',
  'export function useOpenConversation',
  'export function useLaunchChat',
  'export function useRehydrateSessions',
]) {
  if (!activeChatSessionLifecycle.includes(requiredHelper)) {
    errors.push(
      `useActiveChatSessionLifecycle.ts must include ${requiredHelper}.`,
    );
  }
}

const activeChatSessionMessaging = readRequiredSource(
  '../src-ui/src/hooks/useActiveChatSessionMessaging.ts',
);
for (const requiredHelper of [
  'export function useSendMessage',
  'export function useCancelMessage',
  '../lib/foregroundMessageDispatch',
  './useStreamingMessage',
]) {
  if (!activeChatSessionMessaging.includes(requiredHelper)) {
    errors.push(
      `useActiveChatSessionMessaging.ts must include ${requiredHelper}.`,
    );
  }
}

const projectPage = readRequiredSource('../src-ui/src/views/ProjectPage.tsx');
for (const requiredImport of [
  './project-page/ProjectPageHeader',
  './project-page/ProjectLayoutsSection',
  './project-page/ProjectKnowledgeSection',
  './project-page/ProjectConversationsSection',
]) {
  if (!projectPage.includes(requiredImport)) {
    errors.push(
      `ProjectPage must delegate extracted page sections to ${requiredImport}.`,
    );
  }
}
for (const retiredInlineProjectPageSnippet of [
  'function timeAgo(iso: string)',
  'const [selectedNs, setSelectedNs] = useState<string | null>(null);',
  'const [showScanDialog, setShowScanDialog] = useState(false);',
  'className="project-page__knowledge"',
  'className="project-page__conversation-list"',
]) {
  if (projectPage.includes(retiredInlineProjectPageSnippet)) {
    errors.push(
      `ProjectPage must not inline extracted project page logic ${retiredInlineProjectPageSnippet}.`,
    );
  }
}

const projectPageUtils = readRequiredSource(
  '../src-ui/src/views/project-page/utils.ts',
);
if (!projectPageUtils.includes('export function timeAgo')) {
  errors.push('project-page/utils.ts must include export function timeAgo.');
}

const projectKnowledgeSection = readRequiredSource(
  '../src-ui/src/views/project-page/ProjectKnowledgeSection.tsx',
);
for (const requiredHelper of [
  'export function ProjectKnowledgeSection',
  'useKnowledgeSearchQuery',
  'useKnowledgeDocContentQuery',
  'useKnowledgeScanMutation',
  './ProjectKnowledgeDocGroup',
  './ProjectKnowledgeNamespaceConfig',
  './ProjectKnowledgeRulesEditor',
  './ProjectKnowledgeScanModal',
  './ProjectKnowledgeViewerModal',
  'buildRulesContent',
  'splitKnowledgeDocs',
  'buildKnowledgeScanOptions',
]) {
  if (!projectKnowledgeSection.includes(requiredHelper)) {
    errors.push(`ProjectKnowledgeSection.tsx must include ${requiredHelper}.`);
  }
}
for (const retiredInlineProjectKnowledgeSnippet of [
  'function ProjectDocRow(',
  'className="project-page__rules-editor"',
  'className="project-page__doc-viewer"',
  'className="project-page__scan-warning"',
  'const filteredDocs = selectedNs',
  'const includePatterns = scanInclude',
]) {
  if (projectKnowledgeSection.includes(retiredInlineProjectKnowledgeSnippet)) {
    errors.push(
      `ProjectKnowledgeSection.tsx must not inline extracted project knowledge logic ${retiredInlineProjectKnowledgeSnippet}.`,
    );
  }
}

const projectPageUtilsExtended = readRequiredSource(
  '../src-ui/src/views/project-page/utils.ts',
);
for (const requiredHelper of [
  'export function timeAgo',
  'export function buildRulesContent',
  'export function splitKnowledgeDocs',
  'export function buildKnowledgeScanOptions',
]) {
  if (!projectPageUtilsExtended.includes(requiredHelper)) {
    errors.push(`project-page/utils.ts must include ${requiredHelper}.`);
  }
}

const messageBubble = readRequiredSource(
  '../src-ui/src/components/chat/MessageBubble.tsx',
);
if (messageBubble.includes('fetch(')) {
  errors.push('MessageBubble must not issue raw fetch() calls.');
}
for (const requiredImport of [
  './message-bubble/MessageContent',
  './message-bubble/MessageRating',
  './message-bubble/utils',
]) {
  if (!messageBubble.includes(requiredImport)) {
    errors.push(
      `MessageBubble must delegate extracted message bubble logic to ${requiredImport}.`,
    );
  }
}
for (const retiredInlineMessageBubbleSnippet of [
  'function MessageRating(',
  'function getModelDisplayName(',
  'useFeedbackRatingsQuery',
  'useSaveFeedbackRatingMutation',
  'useDeleteFeedbackRatingMutation',
  'remarkPlugins={[remarkGfm]}',
]) {
  if (messageBubble.includes(retiredInlineMessageBubbleSnippet)) {
    errors.push(
      `MessageBubble must not inline extracted message bubble logic ${retiredInlineMessageBubbleSnippet}.`,
    );
  }
}
const messageBubbleUtils = readRequiredSource(
  '../src-ui/src/components/chat/message-bubble/utils.ts',
);
// #1536 B5: `getModelDisplayName` was a private table of five Claude 3 ids
// that answered "Custom" for everything newer, so a row running claude-opus-5
// named it "Custom" while Home named the same session "Opus 5". The assertion
// that has to hold now is the DELEGATION that replaced it: this module names
// no model itself, it asks the one shared identity rule. The negative
// assertion above keeps the table from growing back inside MessageBubble.
//
// Delta review DL6: the import check is a regex rather than an exact string, so
// adding a second symbol to that import statement cannot silently retire this
// assertion; and a `const getModelDisplayName =` is the same table under an
// expression, so it is refused too.
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

const connectionManagerModalContent = readRequiredSource(
  '../packages/connect/src/react/ConnectionManagerModalContent.tsx',
);
for (const requiredImport of [
  './connection-manager-modal/ConnectionListPanel',
  './connection-manager-modal/ManualAddPanel',
]) {
  if (!connectionManagerModalContent.includes(requiredImport)) {
    errors.push(
      `ConnectionManagerModalContent.tsx must delegate extracted modal sections to ${requiredImport}.`,
    );
  }
}
for (const retiredInlineConnectionManagerSnippet of [
  'const inputStyle:',
  'const primaryBtnStyle:',
  'const secondaryBtnStyle:',
  'const iconBtnStyle:',
  '{connections.map((conn) =>',
]) {
  if (
    connectionManagerModalContent.includes(
      retiredInlineConnectionManagerSnippet,
    )
  ) {
    errors.push(
      `ConnectionManagerModalContent.tsx must not inline extracted modal logic ${retiredInlineConnectionManagerSnippet}.`,
    );
  }
}

const chatRoute = readRequiredSource('../src-server/routes/chat/chat.ts');
if (!chatRoute.includes('./chat-request-preparation.js')) {
  errors.push(
    'chat.ts must delegate request preparation to chat-request-preparation.ts.',
  );
}
if (!chatRoute.includes('./chat-model-override.js')) {
  errors.push(
    'chat.ts must delegate model-override agent resolution to chat-model-override.ts.',
  );
}
if (!chatRoute.includes('./chat-primary-stream.js')) {
  errors.push(
    'chat.ts must delegate primary agent streaming to chat-primary-stream.ts.',
  );
}
for (const retiredInlineChatSnippet of [
  'await ctx.providerService.resolveProvider({',
  'await ctx.knowledgeService.getInjectContext(',
  'await ctx.knowledgeService.getRAGContext(',
  'await ctx.knowledgeService.getRAGContextDetailed(',
  'const feedbackGuidelines = ctx.feedbackService.getBehaviorGuidelines();',
  'ctx.feedbackService.getBehaviorGuidelinesDetailed()',
  'const llmProvider = createLLMProviderFromConfig(resolvedProviderConn);',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source-expectation string deliberately contains an interpolation
  'const cacheKey = `${slug}:${modelOverride}`;',
  '<conversation_feedback>',
  'feedbackOps.add(negativeRatings.length',
  'const combinedContext =',
  "ctx.logger.info('Created agent with model override'",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source-expectation string deliberately contains an interpolation
  'operationContext.conversationId = `${operationContext.userId}:',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source-expectation string deliberately contains an interpolation
  'const traceId = `${operationContext.conversationId}:',
  'await conversationStorage.createConversation({',
  'ctx.monitoringEmitter.emitAgentStart({',
  'ctx.monitoringEmitter.emitAgentComplete({',
  'ctx.metricsLog.push({',
  'chatRequests.add(1, { agent: slug, plugin });',
  'return stream(c,',
]) {
  if (chatRoute.includes(retiredInlineChatSnippet)) {
    errors.push(
      `chat.ts must not inline extracted chat request preparation logic ${retiredInlineChatSnippet}.`,
    );
  }
}

const chatRequestPreparation = readRequiredSource(
  '../src-server/routes/chat/chat-request-preparation.ts',
);
for (const requiredHelper of [
  'export async function prepareChatRequest',
  'export function extractChatUserText',
  'ctx.providerService.resolveProvider({',
  'ctx.knowledgeService.getInjectContext(',
  'ctx.knowledgeService.getRAGContextDetailed(',
  'ctx.feedbackService.getBehaviorGuidelinesDetailed()',
]) {
  if (!chatRequestPreparation.includes(requiredHelper)) {
    errors.push(`chat-request-preparation.ts must include ${requiredHelper}.`);
  }
}

const chatModelOverride = readRequiredSource(
  '../src-server/routes/chat/chat-model-override.ts',
);
for (const requiredHelper of [
  'export async function resolveChatAgentModelOverride',
  'ctx.providerService.resolveModelForProvider',
  'ctx.framework.createModel',
  'ctx.activeAgents.set(cacheKey, resolvedAgent)',
]) {
  if (!chatModelOverride.includes(requiredHelper)) {
    errors.push(`chat-model-override.ts must include ${requiredHelper}.`);
  }
}

const chatContext = readRequiredSource(
  '../src-server/routes/chat/chat-context.ts',
);
for (const requiredHelper of [
  'export function injectConversationFeedbackContext',
  'export function applyCombinedContextToInput',
  '<conversation_feedback>',
  'feedbackOps.add(',
]) {
  if (!chatContext.includes(requiredHelper)) {
    errors.push(`chat-context.ts must include ${requiredHelper}.`);
  }
}

const chatPrimaryStream = readRequiredSource(
  '../src-server/routes/chat/chat-primary-stream.ts',
);
for (const requiredHelper of [
  'export function logDebugChatImages',
  'export function streamPrimaryAgentChat',
  './chat-context.js',
  './chat-persistence.js',
  './chat-lifecycle.js',
  // station#3879: was pinned to `return stream(c, async (streamWriter) => {`.
  // The handler is now a non-async arrow, so the exact-text assertion failed
  // while the invariant it exists for — this module, not chat.ts, owns the
  // streaming response — held throughout. Pinned to the call, not its
  // formatting. Its mirror in chat.ts (the negative below) is loosened the
  // same way, so the pair still says "here, not there".
  'return stream(c,',
]) {
  if (!chatPrimaryStream.includes(requiredHelper)) {
    errors.push(`chat-primary-stream.ts must include ${requiredHelper}.`);
  }
}

const chatPersistence = readRequiredSource(
  '../src-server/routes/chat/chat-persistence.ts',
);
for (const requiredHelper of [
  'export function createChatConversationId',
  'export function createChatTraceId',
  'export async function ensureChatConversation',
  'export async function persistUserTurnIfMissing',
  'deriveInitialConversationTitle',
  'extractChatUserText',
]) {
  if (!chatPersistence.includes(requiredHelper)) {
    errors.push(`chat-persistence.ts must include ${requiredHelper}.`);
  }
}

const chatLifecycle = readRequiredSource(
  '../src-server/routes/chat/chat-lifecycle.ts',
);
for (const requiredHelper of [
  'export function emitChatAgentStart',
  'export async function ensureChatAgentStatsInitialized',
  'export async function finalizeChatRequest',
  'ctx.monitoringEmitter.emitAgentComplete',
  'chatRequests.add(1, { agent: slug, plugin });',
]) {
  if (!chatLifecycle.includes(requiredHelper)) {
    errors.push(`chat-lifecycle.ts must include ${requiredHelper}.`);
  }
}

const codexAdapter = readRequiredSource(
  '../src-server/providers/adapters/codex-adapter.ts',
);
if (!codexAdapter.includes('./codex-adapter-events.js')) {
  errors.push(
    'codex-adapter.ts must delegate protocol/event mapping helpers to codex-adapter-events.ts.',
  );
}
for (const retiredInlineCodexHelper of [
  'function mapServerRequestToEvent(',
  'function buildApprovalResult(',
  'function deriveToolName(',
  'function deriveToolArguments(',
  'function deriveToolOutput(',
  'function extractToolError(',
  'function extractThread(',
  'function extractTurn(',
  "case 'thread/status/changed':",
  "case 'item/agentMessage/delta':",
  "case 'item/reasoning/textDelta':",
  "case 'thread/tokenUsage/updated':",
  "case 'item/started':",
  "case 'item/completed':",
  "case 'turn/completed':",
  "case 'error':",
  'private handleItemStarted(',
  'private handleItemCompleted(',
]) {
  if (codexAdapter.includes(retiredInlineCodexHelper)) {
    errors.push(
      `codex-adapter.ts must not inline extracted helper ${retiredInlineCodexHelper}.`,
    );
  }
}

const codexAdapterTransport = readRequiredSource(
  '../src-server/providers/adapters/codex-adapter-transport.ts',
);
for (const requiredHelper of [
  './codex-adapter-notifications.js',
  './codex-adapter-types.js',
  'export class CodexAdapterTransport',
  'export function createCodexSessionRecord',
  'handleCodexNotification({',
]) {
  if (!codexAdapterTransport.includes(requiredHelper)) {
    errors.push(`codex-adapter-transport.ts must include ${requiredHelper}.`);
  }
}

const codexAdapterEvents = readRequiredSource(
  '../src-server/providers/adapters/codex-adapter-events.ts',
);
for (const requiredHelper of [
  'export function mapServerRequestToEvent',
  'export function buildApprovalResult',
  'export function mapApprovalResolutionStatus',
  'export function deriveToolName',
  'export function deriveToolArguments',
  'export function deriveToolOutput',
  'export function extractThread',
  'export function extractTurn',
]) {
  if (!codexAdapterEvents.includes(requiredHelper)) {
    errors.push(`codex-adapter-events.ts must include ${requiredHelper}.`);
  }
}

const codexAdapterNotifications = readRequiredSource(
  '../src-server/providers/adapters/codex-adapter-notifications.ts',
);
for (const requiredHelper of [
  'export function handleCodexNotification',
  "case 'thread/status/changed':",
  "case 'item/started':",
  "case 'turn/completed':",
  "provider: 'codex'",
]) {
  if (!codexAdapterNotifications.includes(requiredHelper)) {
    errors.push(
      `codex-adapter-notifications.ts must include ${requiredHelper}.`,
    );
  }
}

const codexAdapterTypes = readRequiredSource(
  '../src-server/providers/adapters/codex-adapter-types.ts',
);
for (const requiredHelper of [
  'export interface CodexProcessLike',
  'export interface PendingRpcRequest',
  'export interface PendingApprovalRequest',
  'export interface CodexSessionRecord',
]) {
  if (!codexAdapterTypes.includes(requiredHelper)) {
    errors.push(`codex-adapter-types.ts must include ${requiredHelper}.`);
  }
}

const claudeAdapter = readRequiredSource(
  '../src-server/providers/adapters/claude-adapter.ts',
);
for (const requiredHelperImport of [
  './claude-adapter-events.js',
  './claude-adapter-queues.js',
]) {
  if (!claudeAdapter.includes(requiredHelperImport)) {
    errors.push(
      `claude-adapter.ts must delegate extracted helper logic to ${requiredHelperImport}.`,
    );
  }
}
for (const retiredInlineClaudeHelper of [
  'class AsyncEventQueue',
  'class AsyncUserMessageQueue',
  'private mapSessionState(',
  "message.type === 'system' &&",
  "message.type === 'stream_event'",
  "message.type === 'tool_progress'",
  "message.type === 'result'",
]) {
  if (claudeAdapter.includes(retiredInlineClaudeHelper)) {
    errors.push(
      `claude-adapter.ts must not inline extracted helper ${retiredInlineClaudeHelper}.`,
    );
  }
}

const claudeAdapterEvents = readRequiredSource(
  '../src-server/providers/adapters/claude-adapter-events.ts',
);
for (const requiredHelper of [
  'export function mapClaudeSdkMessage',
  'export function mapClaudeSessionState',
  "method: 'session.state-changed'",
  "method: 'content.text-delta'",
  "method: 'tool.progress'",
  "method: 'turn.completed'",
]) {
  if (!claudeAdapterEvents.includes(requiredHelper)) {
    errors.push(`claude-adapter-events.ts must include ${requiredHelper}.`);
  }
}

const claudeAdapterQueues = readRequiredSource(
  '../src-server/providers/adapters/claude-adapter-queues.ts',
);
for (const requiredHelper of [
  'export class AsyncEventQueue',
  'export class AsyncUserMessageQueue',
  'createDeferred<',
]) {
  if (!claudeAdapterQueues.includes(requiredHelper)) {
    errors.push(`claude-adapter-queues.ts must include ${requiredHelper}.`);
  }
}

const stationControlServer = readRequiredSource(
  '../src-server/tools/station-control-mcp-server.ts',
);
for (const requiredImport of [
  './station-control-agent-tools.js',
  './station-control-catalog-tools.js',
  './station-control-operations-tools.js',
  './station-control-platform-tools.js',
  'registerAgentTools(registry);',
  'registerCatalogTools(registry);',
  'registerOperationsTools(registry);',
  'registerPlatformTools(registry);',
]) {
  if (!stationControlServer.includes(requiredImport)) {
    errors.push(
      `station-control-mcp-server.ts must include ${requiredImport}.`,
    );
  }
}
for (const retiredInlineControlSnippet of [
  "server.tool('list_agents'",
  "server.tool('list_skills'",
  "server.tool('list_integrations'",
  "server.tool('list_jobs'",
  "server.tool('send_message'",
  "server.tool('list_plugins'",
  'const API = `http://localhost:',
  'async function api(path: string',
]) {
  if (stationControlServer.includes(retiredInlineControlSnippet)) {
    errors.push(
      `station-control-server.ts must not inline extracted control-server logic ${retiredInlineControlSnippet}.`,
    );
  }
}

const stationControlShared = readRequiredSource(
  '../src-server/tools/station-control-shared.ts',
);
for (const requiredHelper of [
  'export async function api',
  'export function resolveControlApiBase',
  'export function jsonToolResult',
  'export function buildAnalyticsUsagePath',
  'export function buildChatRequest',
  'export function createConversationId',
  'export function buildSentMessageResult',
  'export async function dispatchAgentMessage',
  'export async function navigateTo',
]) {
  if (!stationControlShared.includes(requiredHelper)) {
    errors.push(`station-control-shared.ts must include ${requiredHelper}.`);
  }
}
if (!stationControlShared.includes('env.STATION_API_BASE')) {
  errors.push(
    'station-control-shared.ts must prefer STATION_API_BASE over an implicit localhost default.',
  );
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
// the reader returns '', which makes that file's 155-strong family of negative
// `must not inline X` assertions vacuously true — they only fail on a match.
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
