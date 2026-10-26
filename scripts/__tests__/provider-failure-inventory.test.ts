import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import ts from 'typescript-api';
import { describe, expect, it } from 'vitest';
import { PROVIDER_FAILURE_KINDS } from '../../packages/contracts/src/provider-failure.js';

const root = resolve(import.meta.dirname, '../..');
const exclusions = {
  'src-server/runtime/conversation/runtime-event-log.ts:EventHistoryLimitError.code':
    [
      'event_history_limit_exceeded',
      'Monitoring history read budget; surfaced as HTTP 413, not provider execution.',
    ],
  'packages/contracts/src/agent-identity.ts:ReservedStationIdentityError.code':
    [
      'STATION_ID_RESERVED',
      'Reserved agent identity configuration, not provider execution.',
    ],
  'packages/contracts/src/layout.ts:InvalidLayoutOwnerError.code': [
    'INVALID_LAYOUT_OWNER',
    'Layout ownership validation.',
  ],
  'packages/contracts/src/layout.ts:RetiredLayoutKeyError.code': [
    'RETIRED_LAYOUT_KEY',
    'Layout compatibility validation.',
  ],
  'packages/contracts/src/layout.ts:InvalidLayoutDeclarationError.code': [
    'INVALID_LAYOUT_DECLARATION',
    'Layout presentation declaration validation.',
  ],
  'src-server/services/plugins/plugin-install-trust-recording.ts:PluginInstallTrustRefused.code':
    [
      'plugin-install-trust-refused',
      'Plugin install trust admission, before any provider runs.',
    ],
  'src-server/services/plugins/plugin-install-trust-store.ts:PluginTrustRecordNewerError.code':
    [
      'plugin-trust-record-newer',
      'Plugin install trust record versioning, before any provider runs.',
    ],
  'src-server/security/coding-authority.ts:WORKING_DIRECTORY_NOT_GRANTED_CODE':
    [
      'working-directory-not-granted',
      'Caller directory authority, before engine admission.',
    ],
  'src-server/security/coding-authority.ts:COMMAND_NOT_GRANTED_CODE': [
    'command-not-granted',
    'Caller command authority, before engine admission.',
  ],
  'src-server/services/flow/unreachable-gate-diagnostic.ts:UNREACHABLE_GATE_CLAIMS_CODE':
    [
      'flow.unreachable-gate-claims',
      'Flow evidence-governance warning, not provider execution.',
    ],
  'src-server/services/orchestration/dispatch-cwd-admission.ts:MOVED_CODE': [
    'station_control_out_of_scope',
    'Caller workspace containment authority.',
  ],
  'src-server/routes/chat/agent-conversation-title.ts:AGENT_TITLE_PERSON_TITLE_CODE':
    ['person_title', 'Preserve a person-authored title; no engine failure.'],
  'src-server/routes/chat/agent-conversation-title.ts:AGENT_TITLE_RUNTIME_UNSUPPORTED_CODE':
    [
      'runtime_title_unsupported',
      'Optional title capability; no failed turn or start.',
    ],
  'src-server/domain/agent-registry.ts:DefaultAgentMutationError.code': [
    'DEFAULT_AGENT_MUTATION_FORBIDDEN',
    'Agent configuration and connection binding mutation, not turn execution.',
  ],
  'src-server/domain/agent-registry.ts:ReservedAgentIdentityError.code': [
    'AGENT_ID_RESERVED',
    'Agent configuration and connection binding mutation, not turn execution.',
  ],
  'src-server/domain/agent-registry.ts:EngineConnectionBindingCollisionError.code':
    [
      'ENGINE_CONNECTION_BINDING_COLLISION',
      'Agent configuration and connection binding mutation, not turn execution.',
    ],
  'src-server/domain/agent-registry.ts:DeclinedEngineConnectionError.code': [
    'ENGINE_CONNECTION_DECLINED',
    'Agent configuration and connection binding mutation, not turn execution.',
  ],
  'src-server/domain/agent-workflow-errors.ts:WorkflowInvalidError.code': [
    'workflow_invalid',
    'Workflow configuration CRUD and content validation.',
  ],
  'src-server/domain/agent-workflow-errors.ts:WorkflowNotFoundError.code': [
    'workflow_not_found',
    'Workflow configuration CRUD and content validation.',
  ],
  'src-server/domain/agent-workflow-errors.ts:WorkflowExistsError.code': [
    'workflow_exists',
    'Workflow configuration CRUD and content validation.',
  ],
  'src-server/domain/agent-workflow-errors.ts:WorkflowUnsafeContentError.code':
    [
      'workflow_unsafe_content',
      'Workflow configuration CRUD and content validation.',
    ],
  'src-server/domain/config-loader-agents.ts:AgentConfigNotFoundError.code': [
    'AGENT_CONFIG_NOT_FOUND',
    'Installed agent configuration availability before provider admission.',
  ],
  'src-server/domain/config-loader-agents.ts:PluginAgentInvocationUnavailableError.code':
    [
      'plugin_agent_invocation_unavailable',
      'Installed agent configuration availability before provider admission.',
    ],
  'src-server/domain/project-file-transactions.ts:FileStorageConflictError.code':
    ['file_storage_conflict', 'Project file transaction/storage failure.'],
  'src-server/domain/project-file-transactions.ts:FileStorageNotFoundError.code':
    ['file_storage_not_found', 'Project file transaction/storage failure.'],
  'src-server/domain/project-file-transactions.ts:FileStorageUnavailableError.code':
    ['file_storage_unavailable', 'Project file transaction/storage failure.'],
  'src-server/domain/project-identity-record.ts:ProjectIdentityValidationError.code':
    ['project_identity_invalid', 'Project identity record validation.'],
  'src-server/domain/pty-adapter.ts:PtyUnavailableError.code': [
    'PTY_UNAVAILABLE',
    'Interactive terminal capability, not provider execution.',
  ],
  'src-server/knowledge-store/errors.ts:MissingEvidenceError.code': [
    'MISSING_EVIDENCE',
    'Knowledge evidence lookup or store mutation.',
  ],
  'src-server/knowledge-store/errors.ts:KnowledgeRecordNotFoundError.code': [
    'NOT_FOUND',
    'Knowledge evidence lookup or store mutation.',
  ],
  'src-server/knowledge-store/errors.ts:AmbiguousIdError.code': [
    'AMBIGUOUS_ID',
    'Knowledge evidence lookup or store mutation.',
  ],
  'src-server/knowledge-store/errors.ts:SlugConflictError.code': [
    'SLUG_CONFLICT',
    'Knowledge evidence lookup or store mutation.',
  ],
  'src-server/knowledge-store/errors.ts:ReadOnlyStoreError.code': [
    'READ_ONLY',
    'Knowledge evidence lookup or store mutation.',
  ],
  'src-server/providers/registries/json-manifest-registry.ts:RegistrySourceConfinementError.code':
    [
      'REGISTRY_SOURCE_NOT_CONFINED',
      'Registry installation provenance/format, not provider execution.',
    ],
  'src-server/providers/registries/registry-install-aliases.ts:RegistryInstallAliasFormatError.code':
    [
      'REGISTRY_INSTALL_ALIASES_REGENERATION_REQUIRED',
      'Registry installation provenance/format, not provider execution.',
    ],
  'src-server/routes/agents/native-invocation.ts:NativeInvocationIndeterminateError.code':
    [
      'native_invocation_indeterminate',
      'Native Agent API invocation outcome, separate from engine turn delivery.',
    ],
  'src-server/routes/agents/native-invocation.ts:NativeInvocationPartialError.code':
    [
      'native_invocation_partial',
      'Native Agent API invocation outcome, separate from engine turn delivery.',
    ],
  'src-server/routes/agents/native-invocation.ts:NativeInvocationStorageUnavailableError.code':
    [
      'native_invocation_storage_unavailable',
      'Native Agent API invocation outcome, separate from engine turn delivery.',
    ],
  'src-server/routes/chat/conversation-message-reader.ts:ConversationLineageTooLongError.code':
    ['conversation_lineage_too_long', 'Conversation lineage read bound.'],
  'src-server/runtime/agents/delegation.ts:DelegationDepthLimitError.code': [
    'delegation_depth_exceeded',
    'Delegation lineage policy/admission, not provider turn execution.',
  ],
  'src-server/runtime/agents/request-delegation.ts:DelegationLineageUnavailableError.code':
    [
      'delegation_lineage_unavailable',
      'Delegation lineage policy/admission, not provider turn execution.',
    ],
  'src-server/runtime/bootstrap/hosted-persistence-boundary.ts:HostedPersistenceBoundaryError.code':
    [
      'HOSTED_PERSISTENCE_BOUNDARY_REJECTED',
      'Hosted persistence bootstrap policy.',
    ],
  'src-server/services/agents/agent-service.ts:UnknownEngineIdentityError.code':
    ['UNKNOWN_ENGINE_IDENTITY', 'Agent engine configuration validation.'],
  'src-server/services/agents/agent-service.ts:StationEngineIsAppSettingError.code':
    ['STATION_ENGINE_IS_APP_SETTING', 'Agent engine configuration validation.'],
  'src-server/services/automation/automation-store.ts:AutomationPolicyUnavailableError.code':
    ['policy_unavailable', 'Automation policy or definition validation.'],
  'src-server/services/automation/automation-store.ts:AutomationValidationError.code':
    ['invalid_automation', 'Automation policy or definition validation.'],
  'src-server/services/devices/device-shares.ts:DeviceHostBusyError.code': [
    'device-host-busy',
    'Device host sharing contention.',
  ],
  'src-server/services/execution-target/execution-target-resolver.ts:ExecutionWorkspaceOutsideProjectError.code':
    [
      'execution_workspace_outside_project',
      'Project workspace containment authority before provider admission.',
    ],
  'src-server/services/layouts/personal-layout-service.ts:PersonalLayoutConflictError.code':
    ['PERSONAL_LAYOUT_EXISTS', 'Personal layout mutation conflict.'],
  'src-server/services/orchestration/delegation-attempt-claim-store.ts:DelegationAttemptPendingError.code':
    [
      'delegation_attempt_pending',
      'Delegation attempt idempotency claim state, not an engine failure.',
    ],
  'src-server/services/orchestration/delegation-attempt-claim-store.ts:DelegationAttemptExistsError.code':
    [
      'delegation_attempt_exists',
      'Delegation attempt idempotency claim state, not an engine failure.',
    ],
  'src-server/services/orchestration/delegation-attempt-claim-store.ts:DelegationAttemptConflictError.code':
    [
      'delegation_attempt_conflict',
      'Delegation attempt idempotency claim state, not an engine failure.',
    ],
  'src-server/services/orchestration/event-store.ts:TurnDigestLineageTooLongError.code':
    [
      'session_digest_lineage_too_long',
      'Event-store integrity or digest lineage read bound.',
    ],
  'src-server/services/orchestration/event-store.ts:EventStoreIntegrityError.code':
    [
      'STATION_EVENT_STORE_CORRUPT',
      'Event-store integrity or digest lineage read bound.',
    ],
  'src-server/services/orchestration/native-memory-continuity.ts:NativeMemoryContinuityUnavailableError.code':
    [
      'native_memory_continuity_unavailable',
      'Native memory continuity preparation, not provider execution.',
    ],
  'src-server/services/orchestration/orchestration-service.ts:DraftDiscardRefusedError.code':
    ['not_a_draft', 'Draft lifecycle operation, not a failed turn or start.'],
  'src-server/services/orchestration/orchestration-service.ts:DraftDiscardBusyError.code':
    ['draft_busy', 'Draft lifecycle operation, not a failed turn or start.'],
  'src-server/services/orchestration/orchestration-service.ts:DraftDiscardedError.code':
    [
      'draft_discarded',
      'Draft lifecycle operation, not a failed turn or start.',
    ],
  'src-server/services/orchestration/session-digest.ts:DigestTurnTooLargeError.code':
    ['session_digest_turn_too_large', 'Digest projection size bound.'],
  'src-server/services/plugins/plugin-installation-service.ts:PluginInstallationPending.code':
    [
      'plugin-projection-pending',
      'Plugin lifecycle, policy or visibility mutation.',
    ],
  'src-server/services/plugins/plugin-lifecycle-proposals.ts:PluginProposalLimitError.code':
    ['proposal-limit', 'Plugin lifecycle, policy or visibility mutation.'],
  'src-server/services/plugins/plugin-lifecycle-proposals.ts:PluginProposalNotFoundError.code':
    ['proposal-not-found', 'Plugin lifecycle, policy or visibility mutation.'],
  'src-server/services/plugins/plugin-lifecycle-proposals.ts:PluginProposalNotOpenError.code':
    ['proposal-not-open', 'Plugin lifecycle, policy or visibility mutation.'],
  'src-server/services/plugins/plugin-permissions.ts:PluginGrantMutationSupersededError.code':
    [
      'plugin_grant_mutation_superseded',
      'Plugin lifecycle, policy or visibility mutation.',
    ],
  'src-server/services/plugins/plugin-visibility-service.ts:PluginVisibilityInputError.code':
    [
      'PLUGIN_VISIBILITY_INVALID_TARGET',
      'Plugin lifecycle, policy or visibility mutation.',
    ],
  'src-server/services/projects/project-service.ts:ProjectWorktreeDirectoryError.code':
    [
      'project_worktree_directory_invalid',
      'Project repository configuration/provisioning validation.',
    ],
  'src-server/services/projects/worktree-provisioning-service.ts:WorktreeRepositoryConfigError.code':
    [
      'repository-config-refused',
      'Project repository configuration/provisioning validation.',
    ],
  'src-server/services/scheduling/scheduler-ledger.ts:SchedulerStorageUnavailableError.code':
    [
      'SCHEDULER_STORAGE_UNAVAILABLE',
      'Scheduler ledger persistence integrity.',
    ],
  'src-server/services/scheduling/scheduler-ledger.ts:SchedulerStorageCorruptError.code':
    ['SCHEDULER_STORAGE_CORRUPT', 'Scheduler ledger persistence integrity.'],
  'src-server/tools/station-control-delegation.ts:DelegatedInputRequestChangedError.code':
    [
      'input_request_changed',
      'Delegation input-request binding validation before provider dispatch.',
    ],
  'src-server/tools/station-control-delegation.ts:DelegatedInputBindingModelChangeError.code':
    [
      'input_binding_model_change',
      'Delegation input-request binding validation before provider dispatch.',
    ],
  'src-server/tools/station-control-delegation.ts:DelegatedInputBindingUnsupportedError.code':
    [
      'input_binding_unsupported',
      'Delegation input-request binding validation before provider dispatch.',
    ],
  'src-server/tools/station-control-shared.ts:StationControlCallerRequiredError.code':
    ['station_control_caller_required', 'Station Control caller authority.'],
  'src-server/utils/sqlite-wal.ts:WalJournalModeUnavailableError.code': [
    'WAL_JOURNAL_MODE_UNAVAILABLE',
    'SQLite storage setup, not provider execution.',
  ],
} as const;

// These reconstruct legacy observations or pass a predicate input; neither publishes an event.
const readerObjects = new Set([
  'src-server/services/connections/runtime-auth-health-monitor.ts:monitoredRuntimeEventFrom',
  'src-server/tools/station-control-delegation.ts:isDelegationTerminalEvent',
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__tests__' || entry.name === '__test-utils__')
      return [];
    const path = resolve(dir, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path)
      : /\.tsx?$/.test(path) && !/\.(test|spec)\.tsx?$/.test(path)
        ? [path]
        : [];
  });
}

function enclosingFunction(node: ts.Node, source: ts.SourceFile): string {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent))
      return parent.name?.getText(source) ?? '<anonymous>';
  }
  return '<module>';
}

const sources = ['packages/contracts/src', 'src-server']
  .flatMap((dir) => sourceFiles(resolve(root, dir)))
  .map((path) =>
    ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    ),
  );

describe('provider failure source boundaries', () => {
  it('maps every string diagnostic constant and class-field code, including new files', () => {
    const seenExclusions = new Set<string>();
    let count = 0;
    const unmapped: string[] = [];
    for (const source of sources) {
      const path = relative(root, source.fileName).split(sep).join('/');
      const visit = (node: ts.Node) => {
        const constant =
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          /_CODE$/.test(node.name.text);
        const classCode =
          ts.isPropertyDeclaration(node) &&
          (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) &&
          node.name.text === 'code';
        if (constant || classCode) {
          let value = node.initializer;
          while (
            value &&
            (ts.isAsExpression(value) ||
              ts.isSatisfiesExpression(value) ||
              ts.isParenthesizedExpression(value))
          )
            value = value.expression;
          if (value && ts.isStringLiteralLike(value)) {
            count++;
            const name = classCode
              ? `${node.parent.name?.text ?? '<anonymous>'}.code`
              : node.name.getText(source);
            const id = `${path}:${name}`;
            const excluded = (
              exclusions as Readonly<Record<string, readonly string[]>>
            )[id];
            if (excluded) {
              expect(value.text, id).toBe(excluded[0]);
              seenExclusions.add(id);
            } else {
              if (!Object.hasOwn(PROVIDER_FAILURE_KINDS, value.text))
                unmapped.push(
                  `${id} (${value.text}) has no failure-kind mapping`,
                );
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(unmapped).toEqual([]);
    expect(count).toBeGreaterThan(0);
    expect([...seenExclusions].sort()).toEqual(Object.keys(exclusions).sort());
  });

  it('maps delegation-file and stage refusal type unions independently of the map', () => {
    const unmapped: string[] = [];
    const declarations = new Set<string>();
    for (const source of sources) {
      const path = relative(root, source.fileName).split(sep).join('/');
      if (
        path !== 'packages/contracts/src/attachment-staging.ts' &&
        path !==
          'src-server/services/orchestration/attachment-staging-service.ts'
      )
        continue;
      const visit = (node: ts.Node) => {
        const codeType =
          ts.isTypeAliasDeclaration(node) && /RefusalCode$/.test(node.name.text)
            ? node.type
            : ts.isParameter(node) &&
                node.name.getText(source) === 'code' &&
                ts.isConstructorDeclaration(node.parent)
              ? node.type
              : undefined;
        if (codeType) {
          declarations.add(path);
          const literal = (type: ts.Node) => {
            if (
              ts.isLiteralTypeNode(type) &&
              ts.isStringLiteralLike(type.literal) &&
              !Object.hasOwn(PROVIDER_FAILURE_KINDS, type.literal.text)
            )
              unmapped.push(`${path}: ${type.literal.text}`);
            ts.forEachChild(type, literal);
          };
          literal(codeType);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(unmapped).toEqual([]);
    expect([...declarations].sort()).toEqual([
      'packages/contracts/src/attachment-staging.ts',
      'src-server/services/orchestration/attachment-staging-service.ts',
    ]);
  });

  it('requires an explicit strict write type at every server runtime.error construction', () => {
    const seenReaders = new Map<string, number>();
    let writers = 0;
    for (const source of sources.filter((source) =>
      source.fileName.startsWith(resolve(root, 'src-server')),
    )) {
      const visit = (node: ts.Node) => {
        if (
          ts.isObjectLiteralExpression(node) &&
          node.properties.some(
            (prop) =>
              ts.isPropertyAssignment(prop) &&
              prop.name.getText(source) === 'method' &&
              ts.isStringLiteralLike(prop.initializer) &&
              prop.initializer.text === 'runtime.error',
          )
        ) {
          const id = `${relative(root, source.fileName).split(sep).join('/')}:${enclosingFunction(node, source)}`;
          if (readerObjects.has(id))
            seenReaders.set(id, (seenReaders.get(id) ?? 0) + 1);
          else {
            writers++;
            expect(
              ts.isSatisfiesExpression(node.parent)
                ? node.parent.type.getText(source)
                : '',
              `${id} must satisfy the strict runtime-error write type`,
            ).toMatch(/^ProviderRuntimeError(Event|Body)$/);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(writers).toBeGreaterThan(0);
    expect([...seenReaders].sort()).toEqual(
      [...readerObjects].sort().map((id) => [id, 1]),
    );
  });

  it('rejects omitted metadata in the real writer type while allowing legacy readers', () => {
    const file = resolve(root, '__provider_failure_type_probe__.ts')
      .split(sep)
      .join('/');
    const base =
      "{ eventId:'e', provider:'codex', threadId:'t', createdAt:'2026-10-18T00:00:00Z', method:'runtime.error', severity:'error', message:'failed' }";
    const text = `import type { CanonicalRuntimeEvent, ProviderRuntimeEvent } from './packages/contracts/src/runtime-events';
const reader: CanonicalRuntimeEvent = ${base};
const writer: ProviderRuntimeEvent = ${base};
const complete: ProviderRuntimeEvent = { ...${base}, method: 'runtime.error', severity:'error', kind:'auth', retryable:false, failurePhase:'failed' };`;
    const options: ts.CompilerOptions = {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      types: [],
    };
    const host = ts.createCompilerHost(options);
    const getSource = host.getSourceFile.bind(host);
    host.getSourceFile = (name, language, onError, shouldCreate) =>
      name === file
        ? ts.createSourceFile(file, text, language, true)
        : getSource(name, language, onError, shouldCreate);
    const program = ts.createProgram([file], options, host);
    const source = program.getSourceFile(file);
    expect(source).toBeDefined();
    const diagnostics = program.getSemanticDiagnostics(source);
    expect(
      diagnostics.map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      ),
    ).toHaveLength(1);
    const message = ts.flattenDiagnosticMessageText(
      diagnostics[0].messageText,
      '\n',
    );
    expect(message).toContain('kind');
    expect(message).toContain('retryable');
    expect(message).toContain('failurePhase');
  });
});
