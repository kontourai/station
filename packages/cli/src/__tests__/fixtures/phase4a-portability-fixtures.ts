export type PortabilityRoundTripDisposition =
  | 'preserved'
  | 'degraded'
  | 'ignored';

export interface PortabilityRoundTripExpectation {
  fieldId: string;
  domain:
    | 'workspace-guidance'
    | 'managed-agent-guidance'
    | 'mcp-tooling'
    | 'approval-delegation'
    | 'import-notes';
  exportSection: string;
  disposition: PortabilityRoundTripDisposition;
  lossReportCode?: string;
  importBehavior:
    | 'restore-to-canonical-config'
    | 'restore-as-note'
    | 'warn-and-ignore';
  rationale: string;
}

export interface PortabilityLossReportWarning {
  fieldId: string;
  code: string;
  severity: 'info' | 'warning';
  message: string;
  importBehavior:
    | 'restore-to-canonical-config'
    | 'restore-as-note'
    | 'warn-and-ignore';
}

export interface PortabilityLossReport {
  format: 'agents-md';
  version: 1;
  warnings: PortabilityLossReportWarning[];
}

export const phase4aAgentsExportRequiredSections = [
  'Station Workspace Guidance',
  'Station Managed-Agent Guidance',
  'Station MCP and Tool Expectations',
  'Station Portability Loss Report',
] as const;

export const phase4aRoundTripMatrix: PortabilityRoundTripExpectation[] = [
  {
    fieldId: 'workspace.guidance',
    domain: 'workspace-guidance',
    exportSection: 'Station Workspace Guidance',
    disposition: 'preserved',
    importBehavior: 'restore-to-canonical-config',
    rationale:
      'Structured workspace guidance is Station-owned and must round-trip without degradation.',
  },
  {
    fieldId: 'managedAgents.guidance',
    domain: 'managed-agent-guidance',
    exportSection: 'Station Managed-Agent Guidance',
    disposition: 'preserved',
    importBehavior: 'restore-to-canonical-config',
    rationale:
      'Managed-agent guidance is deterministic configuration and should restore directly into canonical agent config.',
  },
  {
    fieldId: 'mcp.expectations',
    domain: 'mcp-tooling',
    exportSection: 'Station MCP and Tool Expectations',
    disposition: 'preserved',
    importBehavior: 'restore-to-canonical-config',
    rationale:
      'Representable MCP and tool expectations belong in the structured export and must survive re-import.',
  },
  {
    fieldId: 'approval.policy',
    domain: 'approval-delegation',
    exportSection: 'Station MCP and Tool Expectations',
    disposition: 'degraded',
    lossReportCode: 'approval_policy_downgraded',
    importBehavior: 'restore-as-note',
    rationale:
      'Approval policy can be documented, but AGENTS.md cannot fully preserve runtime enforcement semantics.',
  },
  {
    fieldId: 'delegation.policy',
    domain: 'approval-delegation',
    exportSection: 'Station Managed-Agent Guidance',
    disposition: 'degraded',
    lossReportCode: 'delegation_policy_downgraded',
    importBehavior: 'restore-as-note',
    rationale:
      'Delegation policy is only partially representable in prose guidance and must round-trip with an explicit downgrade marker.',
  },
  {
    fieldId: 'prose.unstructuredNotes',
    domain: 'import-notes',
    exportSection: 'Station Workspace Guidance',
    disposition: 'degraded',
    lossReportCode: 'unstructured_prose_preserved_as_note',
    importBehavior: 'restore-as-note',
    rationale:
      'Free-form prose should be preserved for operators, but imported as notes rather than trusted config.',
  },
  {
    fieldId: 'prose.conflictsWithStructuredSection',
    domain: 'import-notes',
    exportSection: 'Station Workspace Guidance',
    disposition: 'ignored',
    lossReportCode: 'conflicting_prose_ignored',
    importBehavior: 'warn-and-ignore',
    rationale:
      'When prose contradicts a structured Station-owned section, the structured block wins and the conflict must be surfaced.',
  },
];

export const phase4aLossReportFixture: PortabilityLossReport = {
  format: 'agents-md',
  version: 1,
  warnings: [
    {
      fieldId: 'approval.policy',
      code: 'approval_policy_downgraded',
      severity: 'warning',
      message:
        'Approval policy is exported as guidance only and must be re-confirmed on import.',
      importBehavior: 'restore-as-note',
    },
    {
      fieldId: 'delegation.policy',
      code: 'delegation_policy_downgraded',
      severity: 'warning',
      message:
        'Delegation policy is only partially representable in AGENTS.md and is restored as imported notes.',
      importBehavior: 'restore-as-note',
    },
    {
      fieldId: 'prose.unstructuredNotes',
      code: 'unstructured_prose_preserved_as_note',
      severity: 'info',
      message:
        'Unstructured prose is preserved for review but not trusted as deterministic Station config.',
      importBehavior: 'restore-as-note',
    },
    {
      fieldId: 'prose.conflictsWithStructuredSection',
      code: 'conflicting_prose_ignored',
      severity: 'warning',
      message:
        'Conflicting prose is retained in import warnings, but the structured Station-owned section wins.',
      importBehavior: 'warn-and-ignore',
    },
  ],
};

export const phase4aAgentsMdFixture = `# AGENTS.md

## Station Workspace Guidance

- Default posture: use Station-owned structured sections as the import source of truth.
- Preserve any unmatched prose as imported notes.

<!-- station:workspace-guidance:start -->
\`\`\`yaml
version: 1
workspaceGuidance:
  defaultMode: solo
  notesPolicy: preserve-as-note
\`\`\`
<!-- station:workspace-guidance:end -->

## Station Managed-Agent Guidance

<!-- station:managed-agent-guidance:start -->
\`\`\`yaml
version: 1
managedAgents:
  assistant:
    guidance:
      promptStyle: concise
      reasoningEffort: high
\`\`\`
<!-- station:managed-agent-guidance:end -->

## Station MCP and Tool Expectations

<!-- station:mcp-tooling:start -->
\`\`\`yaml
version: 1
mcp:
  servers:
    github:
      enabled: true
toolExpectations:
  approvals:
    mode: guidance-only
\`\`\`
<!-- station:mcp-tooling:end -->

## Station Portability Loss Report

<!-- station:loss-report:start -->
\`\`\`json
${JSON.stringify(phase4aLossReportFixture, null, 2)}
\`\`\`
<!-- station:loss-report:end -->
`;
