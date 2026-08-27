import type { KitObservabilityConformanceReport } from '@kontourai/flow-agents/kit-observability-conformance';
import { runKitObservabilityConformance } from '@kontourai/flow-agents/kit-observability-conformance';
import type {
  KitObservabilityContribution,
  KitObservabilityContributionLoadResult,
  KitObservabilityDiagnostic,
  KitObservabilityHostState,
  KitObservabilityNegotiation,
  KitObservabilityOperatorAction,
  KitObservabilityRecord,
} from '@kontourai/flow-agents/kit-observability-contract';
import {
  kitObservabilityDescriptorDigest,
  loadKitObservabilityContribution,
  negotiateKitObservabilityContribution,
  validateKitObservabilityRecord,
} from '@kontourai/flow-agents/kit-observability-contract';
import type { LayoutComponentRef } from '@kontourai/station-contracts/layout';

export const STATION_KIT_OBSERVABILITY_ADAPTER_VERSION = '1.0.0';
export type StationKitLifecycle = 'installed' | 'disabled' | 'uninstalled';

export interface StationKitProjectBinding {
  projectSlug: string;
  incarnation: number;
}

export interface StationMcpAppsBinding {
  serverId: string;
  toolName: string;
  resourceUri: string;
  mimeType: 'text/html;profile=mcp-app';
  visibility: readonly ('model' | 'app')[];
}

export type StationKitMcpAppsBindingResolver = (
  contribution: KitObservabilityContribution,
) => Promise<StationMcpAppsBinding | undefined>;

export interface StationKitHostInput {
  contribution: KitObservabilityContributionLoadResult;
  lifecycle: StationKitLifecycle;
  project?: StationKitProjectBinding;
  mcpApps?: StationMcpAppsBinding;
}

export interface StationKitStandardView {
  id: string;
  kind: 'standard-view';
  projection: string;
  schemaRef: string;
  readOnly: true;
}

export type StationKitDiagnostic =
  | KitObservabilityDiagnostic
  | { code: 'station_mcp_apps_binding_unavailable'; message: string };

export interface StationKitExperience {
  status: KitObservabilityNegotiation['status'];
  diagnostics: StationKitDiagnostic[];
  standardViews: StationKitStandardView[];
  mcpComponent?: Extract<LayoutComponentRef, { kind: 'mcp-tool-ui' }>;
  provenance?: KitObservabilityNegotiation['provenance'] & {
    adapter_version: typeof STATION_KIT_OBSERVABILITY_ADAPTER_VERSION;
    lifecycle: StationKitLifecycle;
    project_binding?: StationKitProjectBinding;
  };
}

export type StationKitMutationResult = {
  allowed: boolean;
  code: 'mutation_approved' | 'mutation_denied';
  reason: string;
  action?: KitObservabilityOperatorAction;
};

export interface StationKitMutationRequest {
  intent: KitObservabilityOperatorAction['intent'];
  approved: boolean;
}

export interface StationKitInstallation {
  contribution: KitObservabilityContributionLoadResult;
  directory?: string;
  lifecycle?: StationKitLifecycle;
  project?: Omit<StationKitProjectBinding, 'incarnation'>;
  mcpApps?: StationMcpAppsBinding;
}

export interface StationKitRegistryEntry {
  contributionRef: string;
  /** Exact public contribution snapshot used for this lifecycle incarnation. */
  contribution: KitObservabilityContribution;
  lifecycle: StationKitLifecycle;
  incarnation: number;
  experience: StationKitExperience;
}

export interface StationKitQuarantinedDiscovery {
  contributionRef: string;
  reason: 'duplicate_contribution_ref';
  directories: string[];
}

export interface StationKitLifecycleStoreOptions {
  statePath?: string;
  /** A Station-owned persistence seam, primarily for deterministic recovery tests. */
  store?: StationKitLifecycleStore;
  /** Cross-process mutation boundary; injectable only for fault tests. */
  acquireMutationLock?: (path: string) => Promise<() => Promise<void>>;
}

export interface StationKitLifecycleStore {
  read(): unknown;
  write(value: unknown): void;
}

/** The immutable action identity presented to Station's approval boundary. */
export interface StationKitMutationCandidate {
  contributionRef: string;
  descriptorDigest: string;
  incarnation: number;
  action: KitObservabilityOperatorAction;
  target: unknown;
  actionDigest: string;
}

export interface StationKitRecordIdentity {
  contributionRef: string;
  descriptorDigest: string;
  evidenceMode: StationKitEvidenceMode;
  runId: string;
  recordId: string;
}

export type StationKitEvidenceMode = 'observational' | 'controlled';

export interface StationKitSourceRef {
  authority: 'flow' | 'surface' | 'runtime';
  ref: string;
}

export interface StationKitRecordIngestContext {
  evidenceMode: StationKitEvidenceMode;
  runId: string;
  sourceRefs: readonly StationKitSourceRef[];
  lifecycleAtIngest: StationKitLifecycle;
}

export type StationKitRecordIngestResult =
  | {
      status: 'accepted' | 'duplicate';
      identity: StationKitRecordIdentity;
      record: KitObservabilityRecord;
    }
  | {
      status: 'quarantined';
      identity: StationKitRecordIdentity;
      reason: string;
    };

export interface StationKitQuarantinedRecord {
  identity: StationKitRecordIdentity;
  reason: 'conflicting_replay';
  diagnostic: string;
}

export interface StationKitRecordReceipt {
  identity: StationKitRecordIdentity;
  record: KitObservabilityRecord;
  context: StationKitRecordIngestContext;
}

/** Public-contract adapter, record ingestion, and read-only presentation. */
export class StationKitObservabilityHost {
  #records = new Map<string, KitObservabilityRecord[]>();
  #recordFingerprints = new Map<string, string>();
  #recordsByIdentity = new Map<string, KitObservabilityRecord>();
  #recordReceipts = new Map<string, StationKitRecordReceipt>();
  #quarantinedRecords: StationKitQuarantinedRecord[] = [];

  constructor(
    private readonly host: Omit<
      KitObservabilityHostState,
      'installed' | 'enabled'
    >,
  ) {}

  discover(
    kitDirectory: string,
    manifest?: unknown,
  ): KitObservabilityContributionLoadResult {
    return loadKitObservabilityContribution(kitDirectory, manifest);
  }

  present(input: StationKitHostInput): StationKitExperience {
    const negotiation = negotiateKitObservabilityContribution(
      input.contribution,
      {
        ...this.host,
        installed: input.lifecycle !== 'uninstalled',
        enabled: input.lifecycle === 'installed',
      },
    );
    const contribution =
      input.contribution.status === 'supported'
        ? input.contribution.contribution
        : undefined;
    // Standard views are immutable declarations from the supported public
    // contribution. Negotiation controls whether their occurrences are
    // available, but must not erase their identity when a Kit is disabled or
    // physically removed during this registry incarnation.
    const standardViews = contribution
      ? Object.entries(contribution.spec.projections).map(
          ([projection, value]) => ({
            id: `kit-${contribution.metadata.name}-${projection}`,
            kind: 'standard-view' as const,
            projection,
            schemaRef: value!.schema_ref,
            readOnly: true as const,
          }),
        )
      : [];
    const mcpComponent =
      contribution &&
      negotiation.presentation?.kind === 'mcp_apps_resource_bridge'
        ? mcpComponentFor(negotiation, input.mcpApps)
        : undefined;
    return {
      status: negotiation.status,
      diagnostics: [
        ...negotiation.diagnostics,
        ...(negotiation.presentation?.kind === 'mcp_apps_resource_bridge' &&
        !mcpComponent
          ? [
              {
                code: 'station_mcp_apps_binding_unavailable' as const,
                message:
                  'Station has no matching pinned MCP Apps binding; using standard views.',
              },
            ]
          : []),
      ],
      standardViews,
      mcpComponent,
      provenance: negotiation.provenance && {
        ...negotiation.provenance,
        adapter_version: STATION_KIT_OBSERVABILITY_ADAPTER_VERSION,
        lifecycle: input.lifecycle,
        ...(input.project ? { project_binding: { ...input.project } } : {}),
      },
    };
  }

  retainRecord(
    value: unknown,
    contribution: KitObservabilityContribution,
    context: StationKitRecordIngestContext,
  ): KitObservabilityRecord {
    const result = this.ingestRecord(value, contribution, context);
    if (result.status === 'quarantined') {
      throw new Error(`Kit observability record quarantined: ${result.reason}`);
    }
    return snapshot(result.record);
  }

  ingestRecord(
    value: unknown,
    contribution: KitObservabilityContribution,
    context: StationKitRecordIngestContext,
  ): StationKitRecordIngestResult {
    validateIngestContext(context);
    const record = snapshot(
      validateKitObservabilityRecord(value, contribution),
    );
    const identity = recordIdentity(record, context);
    const key = recordIdentityKey(identity);
    // Console replay identity is the five-part key. Its first receipt is
    // evidence: changed record bytes OR changed Station provenance conflicts.
    const fingerprint = canonicalRecordFingerprint({ record, context });
    const existing = this.#recordFingerprints.get(key);
    if (existing !== undefined) {
      if (existing === fingerprint) {
        const stored = this.#recordsByIdentity.get(key);
        if (!stored)
          throw new Error('Kit observability record index is inconsistent');
        return {
          status: 'duplicate',
          identity: snapshot(identity),
          record: snapshot(stored),
        };
      }
      const quarantined: StationKitQuarantinedRecord = {
        identity: snapshot(identity),
        reason: 'conflicting_replay',
        diagnostic:
          'A different record or receipt provenance replayed an accepted Kit record identity.',
      };
      this.#quarantinedRecords.push(quarantined);
      return {
        status: 'quarantined',
        identity: snapshot(identity),
        reason: quarantined.diagnostic,
      };
    }
    const records = this.#records.get(identity.contributionRef) ?? [];
    records.push(record);
    this.#records.set(identity.contributionRef, records);
    this.#recordFingerprints.set(key, fingerprint);
    this.#recordsByIdentity.set(key, record);
    this.#recordReceipts.set(key, {
      identity: snapshot(identity),
      record: snapshot(record),
      context: snapshot(context),
    });
    return {
      status: 'accepted',
      identity: snapshot(identity),
      record: snapshot(record),
    };
  }

  canonicalRecords(contributionRef: string): readonly KitObservabilityRecord[] {
    return (this.#records.get(contributionRef) ?? []).map(snapshot);
  }

  quarantinedRecords(
    contributionRef?: string,
  ): readonly StationKitQuarantinedRecord[] {
    return this.#quarantinedRecords
      .filter(
        (entry) =>
          contributionRef === undefined ||
          entry.identity.contributionRef === contributionRef,
      )
      .map(snapshot);
  }

  recordReceipts(contributionRef?: string): readonly StationKitRecordReceipt[] {
    return [...this.#recordReceipts.values()]
      .filter(
        (entry) =>
          contributionRef === undefined ||
          entry.identity.contributionRef === contributionRef,
      )
      .map(snapshot);
  }

  requestMutation(
    contribution: KitObservabilityContribution,
    lifecycle: StationKitLifecycle,
    request?: StationKitMutationRequest,
  ): StationKitMutationResult {
    if (!request?.approved) {
      return {
        allowed: false,
        code: 'mutation_denied',
        reason:
          'Portable Kit observability contributions require a separate Station approval before an operator action can run.',
      };
    }
    const negotiation = negotiateKitObservabilityContribution(
      { status: 'supported', contribution, diagnostics: [] },
      {
        ...this.host,
        installed: lifecycle !== 'uninstalled',
        enabled: lifecycle === 'installed',
      },
    );
    const action = negotiation.navigation.available_operator_intents.find(
      (candidate) => candidate.intent === request.intent,
    );
    if (!action) {
      return {
        allowed: false,
        code: 'mutation_denied',
        reason:
          'The requested action is not declared by this contribution or Station lacks its required capability.',
      };
    }
    return {
      allowed: true,
      code: 'mutation_approved',
      reason:
        'Station approved the declared operator action; the Kit contribution remains read-only.',
      action: snapshot(action),
    };
  }

  runPublicConformance(): KitObservabilityConformanceReport {
    return runKitObservabilityConformance({
      negotiate: (contribution, host) =>
        negotiateKitObservabilityContribution(
          { status: 'supported', contribution, diagnostics: [] },
          host,
        ),
      validateRecord: validateKitObservabilityRecord,
      descriptorDigest: kitObservabilityDescriptorDigest,
    });
  }
}

function mcpComponentFor(
  negotiation: KitObservabilityNegotiation,
  binding: StationMcpAppsBinding | undefined,
): Extract<LayoutComponentRef, { kind: 'mcp-tool-ui' }> | undefined {
  if (negotiation.presentation?.kind !== 'mcp_apps_resource_bridge' || !binding)
    return undefined;
  const declared = negotiation.presentation;
  if (
    binding.resourceUri !== declared.resource.uri ||
    binding.mimeType !== declared.resource.mime_type ||
    binding.toolName !== declared.bridge.tool_name ||
    !sameVisibility(binding.visibility, declared.bridge.visibility)
  )
    return undefined;
  return {
    kind: 'mcp-tool-ui',
    ref: `${binding.serverId}/${binding.toolName}`,
    resourceUri: declared.resource.uri,
    approvalPolicy: 'read-only',
  };
}

function recordIdentity(
  record: KitObservabilityRecord,
  context: StationKitRecordIngestContext,
): StationKitRecordIdentity {
  return {
    contributionRef: record.spec.binding.contribution_ref,
    descriptorDigest: record.spec.binding.descriptor_digest,
    evidenceMode: context.evidenceMode,
    runId: context.runId,
    recordId: record.metadata.name,
  };
}

function recordIdentityKey(identity: StationKitRecordIdentity): string {
  return [
    identity.contributionRef,
    identity.descriptorDigest,
    identity.evidenceMode,
    identity.runId,
    identity.recordId,
  ].join('\u0000');
}

function validateIngestContext(context: StationKitRecordIngestContext): void {
  if (
    !['observational', 'controlled'].includes(context.evidenceMode) ||
    !context.runId.trim() ||
    context.runId.length > 256 ||
    !Array.isArray(context.sourceRefs) ||
    context.sourceRefs.length === 0 ||
    !['installed', 'disabled', 'uninstalled'].includes(
      context.lifecycleAtIngest,
    )
  )
    throw new Error('Kit observability ingest context is invalid');
  for (const source of context.sourceRefs) {
    if (
      !['flow', 'surface', 'runtime'].includes(source.authority) ||
      !source.ref.startsWith(`${source.authority}://`) ||
      hasUnsafeSourceCharacter(source.ref)
    )
      throw new Error('Kit observability source reference is invalid');
  }
}

function hasUnsafeSourceCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

function canonicalRecordFingerprint(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (Number.isFinite(value)) return JSON.stringify(value);
      break;
    case 'object':
      if (Array.isArray(value))
        return `[${value.map(canonicalRecordFingerprint).join(',')}]`;
      if (isPlainObject(value)) {
        return `{${Object.keys(value)
          .sort()
          .map(
            (key) =>
              `${JSON.stringify(key)}:${canonicalRecordFingerprint(value[key])}`,
          )
          .join(',')}}`;
      }
      break;
  }
  throw new Error(
    'Kit observability records must contain only JSON-compatible values',
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameVisibility(
  actual: readonly ('model' | 'app')[],
  expected: readonly ('model' | 'app')[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function snapshot<T>(value: T): T {
  return structuredClone(value);
}
