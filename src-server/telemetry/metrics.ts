/**
 * OTel metric instruments and tracer for Station.
 * Safe to import even when no SDK is configured — all instruments become no-ops.
 */

import { metrics, trace } from '@opentelemetry/api';

const meter = metrics.getMeter('station');

export const tracer = trace.getTracer('station');

export const chatRequests = meter.createCounter('station.chat.requests', {
  description: 'Total chat requests',
});
/** Additive durable conversation-to-execution-session lineage mutations. */
export const conversationSessionLineageMutations = meter.createCounter(
  'station.conversation_session_lineage.mutations',
  { description: 'Conversation/session lineage mutations by bounded outcome' },
);
/** Durable conversation-continuation reservations, never provider content. */
export const conversationContinuationOutcomes = meter.createCounter(
  'station.conversation.continuation.outcomes',
  {
    description:
      'Conversation continuation resolution by bounded durable outcome',
  },
);
/** Starter Work correlation outcomes; local OTel only, never product usage telemetry. */
export const starterWorkBindings = meter.createCounter(
  'station.starter_work.bindings',
  {
    description: 'Starter Work correlation operations by bounded outcome',
  },
);

/** Shared text-state protocol actions, with bounded operation and outcome tags. */
export const sharedWorkingStateOperations = meter.createCounter(
  'station.shared_working_state.operations',
  { description: 'Shared working-state protocol operations by outcome' },
);

/** Durable platform-action envelope outcomes; attributes are closed and content-free. */
export const actionOperationOutcomes = meter.createCounter(
  'station.action_operations.outcomes',
  {
    description: 'Durable platform action operation outcomes by bounded action',
  },
);

/** Durable project/task room operations; attributes are closed and content-free. */
export const projectTaskRoomHistoryOperations = meter.createCounter(
  'station.project_task_room_history.operations',
  { description: 'Project/task room history operations by bounded outcome' },
);
export const projectTaskRoomHistoryDuration = meter.createHistogram(
  'station.project_task_room_history.duration',
  {
    description: 'Project/task room operation duration by bounded outcome',
    unit: 'ms',
  },
);
export const projectTaskRoomHistoryPageRecords = meter.createHistogram(
  'station.project_task_room_history.page_records',
  { description: 'Project/task room replay page size by bounded outcome' },
);

/** Immutable revision freeze, resolution, and portable recovery outcomes. */
export const revisionEvidenceOutcomes = meter.createCounter(
  'station.revision_evidence.outcomes',
  { description: 'Revision-bound evidence operations by bounded outcome' },
);

/** Direct product-usage telemetry delivery health, by bounded outcome. */
export const usageTelemetryOutcomes = meter.createCounter(
  'station.usage_telemetry.outcomes',
  { description: 'Usage telemetry delivery and drop outcomes' },
);

export const tokensInput = meter.createCounter('station.tokens.input', {
  description: 'Input tokens consumed',
});

export const tokensOutput = meter.createCounter('station.tokens.output', {
  description: 'Output tokens consumed',
});

export const toolCalls = meter.createCounter('station.tool.calls', {
  description: 'Tool INVOCATIONS by an agent (attributes: tool, plugin)',
});
/** ACP redraw supervisor actions with a closed, content-free outcome tag. */
export const acpToolUpdateSupervisorOperations = meter.createCounter(
  'station.acp.tool_update_supervisor.operations',
  { description: 'Bounded ACP tool update supervision by outcome' },
);
/** ACP redraw/update outcomes; attributes are the supervisor's closed vocabulary only. */
export const acpToolUpdateSupervisorUpdates = meter.createCounter(
  'station.acp.tool_update_supervisor.updates',
  { description: 'ACP tool redraw supervision updates by bounded outcome' },
);
/** Bounded material accounted by the ACP redraw supervisor, never content. */
export const acpToolUpdateSupervisorBytes = meter.createCounter(
  'station.acp.tool_update_supervisor.bytes',
  { description: 'ACP tool redraw bytes by retained or omitted outcome' },
);
/** Distribution of retained data per bounded ACP tool-call projection. */
export const acpToolUpdateSupervisorRetainedBytes = meter.createHistogram(
  'station.acp.tool_update_supervisor.retained_bytes',
  { description: 'Retained bytes in a bounded ACP tool-call projection' },
);
/**
 * Management operations on tool DEFINITIONS — add/remove/list/reconnect.
 * Split out of `station.tool.calls` (archive#3077), which counted both, so
 * any dashboard summing it added "times a tool ran" to "times someone edited
 * a tool definition" and could only tell them apart by which attribute
 * happened to be present.
 */
export const toolDefinitionOps = meter.createCounter(
  'station.tool.definitions.operations',
  { description: 'Tool definition management operations (attribute: op)' },
);

/** Secret-binding authority operations with closed, content-free attributes. */
export const secretBindingOperations = meter.createCounter(
  'station.secret_binding.operations',
  {
    description:
      'Secret-binding metadata and resolution operations by bounded operation and outcome',
  },
);
export const toolServerLifecycle = meter.createCounter(
  'station.tool_server.lifecycle',
  {
    description: 'Tool server enable and disable operations',
  },
);
export const toolServerProbes = meter.createCounter(
  'station.tool_server.probes',
  {
    description: 'Tool server probe outcomes',
  },
);
export const toolServerCredentialWrites = meter.createCounter(
  'station.tool_server.credential_writes',
  { description: 'Tool server credential writes by operation' },
);
export const pullRequestOps = meter.createCounter(
  'station.pull_request.operations',
  { description: 'Pull request operations by action and repository' },
);

export const reviewEvidenceOperations = meter.createCounter(
  'station.review_evidence.operations',
  { description: 'Independent review evidence operations by outcome' },
);

export const reviewEvidenceDuration = meter.createHistogram(
  'station.review_evidence.duration',
  {
    description: 'Independent review evidence operation duration',
    unit: 'ms',
  },
);

/**
 * archive#1834: tool executions denied by the `beforeToolCall` gate. The
 * `reason` attribute is a closed vocabulary (stale_generation /
 * delegated_tool_blocked / policy_config_protection / guardian_denied /
 * delegation_deny_approvals / user_denied / unattended_grant_denied /
 * no_approval_channel / policy_evaluation_failed); tool names are deliberately
 * not an attribute.
 */
export const toolDenials = meter.createCounter('station.tool.denials', {
  description: 'Tool executions denied by the beforeToolCall gate, by reason',
});

export const integrationIconAssetReads = meter.createCounter(
  'station.integration_icon_asset.reads',
  { description: 'Local integration icon resolutions by safe outcome' },
);

/** Bounded Workspace Pane resolver outcomes; see the catalog route sink. */
export const workspacePaneAvailabilityResolutions = meter.createCounter(
  'station.workspace_pane.availability_resolutions',
  {
    description:
      'Workspace Pane availability resolutions by bounded descriptor, state, and reason code',
  },
);

export const uiBlockEmitted = meter.createCounter('station.ui_block.emitted', {
  description:
    'Chat-native UIBlocks emitted by the render_component builtin tool (by type)',
});

export const chatDuration = meter.createHistogram('station.chat.duration', {
  description: 'Chat request duration',
  unit: 'ms',
});

export const toolDuration = meter.createHistogram('station.tool.duration', {
  description: 'Tool execution duration',
  unit: 'ms',
});

export const chatErrors = meter.createCounter('station.chat.errors', {
  description: 'Total chat errors',
});

/**
 * archive#2807: prompts refused by the chat input size bound at the
 * validate() boundary, by bounded `reason` (`over_limit` |
 * `unrecognized_shape`). The refusal otherwise surfaces only as an
 * undifferentiated 400; this observes how often the bound fires so the
 * 200k limit can be tuned from data instead of guesswork.
 */
export const chatInputLimitRefusals = meter.createCounter(
  'station.chat.input_limit.refusals',
  {
    description: 'Prompts refused by the chat input size bound, by reason',
  },
);

/** Gateway lifecycle and ingress authorization outcomes. No external ids are tags. */
export const discordGatewayEvents = meter.createCounter(
  'station.discord.gateway_events',
  {
    description:
      'Discord gateway lifecycle and authorization outcomes by bounded outcome',
  },
);

/** Inbound webhook admission outcomes. Attributes are a closed reason vocabulary. */
export const inboundWebhookRequests = meter.createCounter(
  'station.webhooks.inbound_requests',
  {
    description: 'Inbound webhook requests by bounded admission outcome',
  },
);

// archive#2649: per-turn context-injection transparency. `blocks` counts
// injected context blocks by kind (attribute `block`); the histogram records
// the turn's TOTAL approximate injected tokens (utf8 bytes / 4 of the real
// injected strings — an estimate by construction, see
// chat-context-injection.ts), including 0 for turns Station injected nothing
// into, so the distribution covers every dispatched Station-engine turn.
export const chatContextInjectionBlocks = meter.createCounter(
  'station.chat.context_injection.blocks',
  { description: 'Context blocks injected into chat turns, by kind' },
);

export const chatContextInjectionTokens = meter.createHistogram(
  'station.chat.context_injection.approx_tokens',
  {
    description:
      'Approximate injected-context tokens per chat turn (bytes/4 estimate)',
  },
);

export const contextTokens = meter.createCounter('station.tokens.context', {
  description: 'Fixed context tokens per request (system prompt + MCP tools)',
});

export const costEstimated = meter.createCounter('station.cost.estimated', {
  description: 'Estimated cost in USD',
});

export const modelDispatchReceipts = meter.createCounter(
  'station.model.dispatch.receipts',
  { description: 'Terminal model dispatch receipts persisted by outcome' },
);

export const diagnosticsBundlesGenerated = meter.createCounter(
  'station.diagnostics.bundle.generated',
  { description: 'Diagnostics bundles generated successfully' },
);

export const diagnosticsBundleErrors = meter.createCounter(
  'station.diagnostics.bundle.error',
  { description: 'Diagnostics bundle generation failures' },
);

export const lifecycleService = meter.createCounter(
  'station.lifecycle.service',
  {
    description: 'Station boots managed by a user service',
  },
);

export const bootRecordsWritten = meter.createCounter(
  'station.system.boot_records_written',
  {
    description: 'Durable Station boot records written',
  },
);

export const bootPayloadServed = meter.createCounter(
  'station.boot.payload_served',
  {
    description: 'Boot payload envelopes served',
  },
);
export const bootPayloadSectionErrors = meter.createCounter(
  'station.boot.payload_section_errors',
  {
    description: 'Boot payload section failures by section',
  },
);

/**
 * Delay between a periodic monotonic timer's expected and observed wake-up.
 * This records main-thread/event-loop stalls that can make an otherwise-live
 * Station miss its own health probes.
 */
export const runtimeEventLoopLag = meter.createHistogram(
  'station.runtime.event_loop_lag',
  {
    description: 'Observed event-loop scheduling lag',
    unit: 'ms',
  },
);

// ── Plugins ──
export const pluginInstalls = meter.createCounter('station.plugin.installs', {
  description: 'Plugin install events',
});
export const pluginUninstalls = meter.createCounter(
  'station.plugin.uninstalls',
  {
    description: 'Plugin uninstall events',
  },
);
export const pluginUpdates = meter.createCounter('station.plugin.updates', {
  description: 'Plugin update events',
});
export const pluginSettingsUpdates = meter.createCounter(
  'station.plugin.settings_updates',
  {
    description: 'Plugin settings update events',
  },
);
export const pluginServerRequests = meter.createCounter(
  'station.plugin.server_requests',
  {
    description: 'Plugin server-module request events',
  },
);
export const pluginServerRequestDuration = meter.createHistogram(
  'station.plugin.server_request_duration',
  {
    description: 'Plugin server-module request duration in milliseconds',
    unit: 'ms',
  },
);
export const pluginGrantsStoreCorruption = meter.createCounter(
  'station.plugin.grants_store_corruption',
  {
    description:
      'Permission grants store unreadable/corrupt/ill-shaped events surfaced fail-closed (by store)',
  },
);
export const pluginEventSubscriptionOperations = meter.createCounter(
  'station.plugin.event_subscription_operations',
  {
    description:
      'Plugin operational-event subscription lifecycle and dispatch outcomes',
  },
);

/**
 * Mutations of the persistent exact-tool grants used by unattended
 * principals. Resolver-side grant use is intentionally recorded separately
 * when it lands, so a mutation cannot be mistaken for an authorization use.
 */
export const unattendedGrantOperations = meter.createCounter(
  'station.unattended_grant.operations',
  { description: 'Unattended exact-tool grant mutations by operation' },
);

/** Fired standing grants, deliberately labeled only by the closed principal kind. */
export const unattendedGrantUses = meter.createCounter('station.tool.grants', {
  description:
    'Unattended exact-tool grants used to authorize a tool, by principal kind',
});

/** Fail-closed unreadable/corrupt unattended-grant store lookups. */
export const unattendedGrantStoreUnavailable = meter.createCounter(
  'station.tool.grant_store_unavailable',
  {
    description:
      'Unattended grant-store lookup failures denied, by principal kind',
  },
);

export const routingDecision = meter.createCounter('station.routing.decision', {
  description:
    'Smart routing decisions by plugin, selected model tier, reason, and secondary-model use',
});

// ── CRUD operations ──
export const agentOps = meter.createCounter('station.agent.operations', {
  description: 'Agent CRUD operations',
});
export const projectOps = meter.createCounter('station.project.operations', {
  description: 'Project CRUD operations',
});
export const projectPaneCatalogDuration = meter.createHistogram(
  'station.project.pane_catalog.duration',
  {
    description:
      'Workspace Pane catalog request duration in milliseconds by outcome',
    unit: 'ms',
  },
);

// archive#1499: portable project identity (docs/design/portable-project-identity.md).
export const projectManifestBackfills = meter.createCounter(
  'station.project_manifest.backfills',
  {
    description:
      'Project manifest sidecar exclusive-create attempts by outcome (created / adopted-existing / unavailable / failed); an adopted-existing point also carries adopted=identical|divergent, naming whether the record it adopted agreed with the derivation it discarded',
  },
);

export const projectResourceResolutions = meter.createCounter(
  'station.project_resource.resolutions',
  {
    description: 'resolveProjectResource outcomes by resolution state',
  },
);

// archive#1502: the user-visible resolution surface. These count the
// ROUTE, not the resolution — `projectResourceResolutions` above already fires
// inside the resolver, and re-counting its states here would double-count every
// state the route happens to be the caller for. Attributes are bounded to the
// posture/outcome vocabularies and NEVER carry a path, slug, or remote.
export const projectResolutionRouteRequests = meter.createCounter(
  'station.project_resource.route_requests',
  {
    description:
      'GET /api/projects/:slug/resolution outcomes by bounded outcome (the ProjectResolutionView posture, or not-found / failed)',
  },
);

export const projectBindingOperations = meter.createCounter(
  'station.project_binding.operations',
  {
    description:
      'Explicit operator binding actions by op and bounded outcome (bound, or the refusal code); a refusal wrote nothing. `re-derive-failed` is counted IN ADDITION to `bound`: the row was written and only the follow-up re-read failed',
  },
);

// archive#1501: the migration shadow. THREE outcomes justify flipping
// a seam onto `resolveProjectResource` — `agree`, and (since archive#1594)
// `agree-unverified` and `agree-drifted`, where both sides name the same
// directory but the resolver could only offer the weaker `unverifiedPath`
// observation. They are counted separately on purpose: archive#1501's gate asks for
// the `stale` leg specifically, and a `drifted` sample must not stand in for
// it. `outcome=conflated-unbound` is a FAIL-OPEN tripwire that must read zero
// before the flip. `outcome=disabled` means the kill switch is set and NOTHING
// was compared, which is deliberately not the same silence as agreement.
export const projectResourceShadowComparisons = meter.createCounter(
  'station.project_resource.shadow_comparisons',
  {
    description:
      'Baseline-vs-resolveProjectResource comparisons at a workingDirectory seam, by seam, provider, baseline outcome, and agreement outcome',
  },
);

export const surveyFlowReviewDiscoveries = meter.createCounter(
  'station.survey_flow_review.discoveries',
  { description: 'Survey review work discovery outcomes and item counts' },
);

export const surveyFlowReviewContinuations = meter.createCounter(
  'station.survey_flow_review.continuations',
  { description: 'Survey-backed Flow gate continuation outcomes' },
);

/** A project whose sessions file could not be read for the aggregate (archive#3322). */
export const surveyFlowReviewUnavailableProjects = meter.createCounter(
  'station.survey_flow_review.project_unavailable',
  {
    description:
      'Projects excluded from the Survey flow-review aggregate, by reason',
  },
);
export const promptOps = meter.createCounter('station.prompt.operations', {
  description: 'Prompt CRUD operations',
});

// ── Providers ──
export const providerOps = meter.createCounter('station.provider.operations', {
  description: 'Provider register/remove/health events',
});

export const connectionQuotaReads = meter.createCounter(
  'station.connection_quota.reads',
  { description: 'Provider quota reads by bounded outcome' },
);

/** Bounded recovery lifecycle only; attributes deliberately exclude content and identity. */
export const connectionRecoveryOutcomes = meter.createCounter(
  'station.connection_recovery.outcomes',
  {
    description:
      'Connection recovery outcomes by bounded provider-neutral classification',
  },
);

/**
 * Credential-profile application lifecycle. Attributes are deliberately
 * bounded: source, capability, outcome, scope, and reason only.
 */
export const credentialProfileApplication = meter.createCounter(
  'station.credential_profile.application',
  {
    description:
      'Credential profile application attempts by source, capability, outcome, scope, and bounded reason',
  },
);

export const deviceSessionExchanges = meter.createCounter(
  'station.device_session.exchanges',
  {
    description: 'Paired browser-session exchange outcomes',
  },
);

export const devicePairingRequests = meter.createCounter(
  'station.device_pairing.requests',
  {
    description:
      'Device pairing requests by source and outcome; never includes device or network identity',
  },
);

/**
 * Compatibility contract advertised to an unauthenticated client. Attributes
 * are the two contract integers only — constants for a given build, so this
 * carries no per-device cardinality and no network identity, while still
 * making a fleet's version spread legible when hosts are scraped together.
 */
export const clientCompatHandshakes = meter.createCounter(
  'station.client_compat.handshakes',
  {
    description:
      'Public compatibility handshakes served, by advertised contract versions',
  },
);

export const deviceSessionAuthorizations = meter.createCounter(
  'station.device_session.authorizations',
  {
    description: 'Paired browser-session authorization outcomes',
  },
);

export const providerCatalogOps = meter.createCounter(
  'station.provider.catalog.operations',
  {
    description:
      'Provider runtime catalog discovery events by source and built-in model use',
  },
);

export const providerCatalogModelCount = meter.createHistogram(
  'station.provider.catalog.models',
  { description: 'Models returned by a provider runtime catalog discovery' },
);

export const providerCatalogBuiltInModelCount = meter.createHistogram(
  'station.provider.catalog.builtin_models',
  {
    description:
      'Built-in models available during provider runtime catalog discovery',
  },
);

export const modelInventoryRefreshTotal = meter.createCounter(
  'station.model_inventory.refresh.total',
  {
    description: 'Normalized launchable-model inventory refresh outcomes',
  },
);

export const modelInventoryResponseTotal = meter.createCounter(
  'station.model_inventory.response.total',
  {
    description: 'Launchable-model inventory response outcomes',
  },
);

export const modelInventoryModelCount = meter.createHistogram(
  'station.model_inventory.models',
  { description: 'Models projected by a launchable-model inventory refresh' },
);

export const fleetContributionManifestTotal = meter.createCounter(
  'station.fleet_contribution.manifest.total',
  {
    description:
      'Fleet contributed-subset manifest projections, by participation state (station#1398)',
  },
);

export const fleetContributionModelCount = meter.createHistogram(
  'station.fleet_contribution.models',
  {
    description: 'Models offered by a fleet contributed-subset manifest',
  },
);

export const fleetInferenceCompletionTotal = meter.createCounter(
  'station.fleet_inference.completions.total',
  {
    description:
      'Fleet inference completion attempts, by outcome and refusal code or stop reason (station#1398)',
  },
);

export const fleetInferenceGeneratedCharacters = meter.createHistogram(
  'station.fleet_inference.generated_characters',
  {
    description: 'Characters generated by a served fleet inference completion',
  },
);

export const fleetInferenceLatency = meter.createHistogram(
  'station.fleet_inference.latency_ms',
  {
    description: 'Wall-clock duration of a served fleet inference completion',
  },
);

export const fleetInferenceManifestReadTotal = meter.createCounter(
  'station.fleet_inference.manifest_reads.total',
  {
    description:
      'Authenticated peer reads of this Station fleet contribution manifest, by participation state',
  },
);

export const fleetRoutingReceiptsTotal = meter.createCounter(
  'station.fleet_routing.receipts.total',
  {
    description:
      'Fleet routing receipt envelopes written by this Station, by Dispatch terminal outcome (station#1398 slice 3)',
  },
);

export const fleetRoutingCandidatesTotal = meter.createCounter(
  'station.fleet_routing.candidates.total',
  {
    description:
      'Fleet (peer-attested) candidates present in a receipted routing decision',
  },
);

export const fleetRoutingExclusionsTotal = meter.createCounter(
  'station.fleet_routing.exclusions.total',
  {
    description:
      'Named reasons a fleet capability did not route, by exclusion code (station#1398 §4.5)',
  },
);

export const fleetServeReceiptsTotal = meter.createCounter(
  'station.fleet_inference.serve_receipts.total',
  {
    description:
      'Serve-side fleet inference receipts written by this Station, by outcome (station#1398 slice 3)',
  },
);

export const fleetServeReceiptFailures = meter.createCounter(
  'station.fleet_inference.serve_receipt_failures.total',
  {
    description:
      'Serve-side fleet inference receipts this Station FAILED to write — the completion happened but is unrecorded (station#1398 slice 3)',
  },
);

export const fleetProbeObservations = meter.createCounter(
  'station.fleet_routing.probe_observations.total',
  {
    description:
      'Bounded consumer-verified probe completions this Station ran against a peer, by status (station#1398 slice 5)',
  },
);

export const fleetProbeFailures = meter.createCounter(
  'station.fleet_routing.probe_failures.total',
  {
    description:
      "Consumer-verified probes that FAILED, by the peer's own refusal code or the transport failure (station#1398 slice 5)",
  },
);

export const fleetProbeDeferrals = meter.createCounter(
  'station.fleet_routing.probe_deferrals.total',
  {
    description:
      'Consumer-verified probes NOT scheduled because a bound was already reached, by reason — a candidate stays peer-attested for that pass (station#1398 slice 5)',
  },
);

export const fleetRoutingReceiptFailures = meter.createCounter(
  'station.fleet_routing.receipt_failures.total',
  {
    description:
      'Fleet routing decisions this Station FAILED to receipt, by reason (station#1398 slice 3)',
  },
);

export const fleetRoutingCorrelationEvents = meter.createCounter(
  'station.fleet_routing.correlation.total',
  {
    description:
      'Authorized turn to fleet-receipt correlation decisions, by bounded phase and outcome',
  },
);

export const modelInventoryDiagnosticCount = meter.createHistogram(
  'station.model_inventory.diagnostics',
  {
    description:
      'Diagnostics projected by a launchable-model inventory refresh',
  },
);

export const modelInventoryRefreshDuration = meter.createHistogram(
  'station.model_inventory.refresh.duration',
  {
    description: 'Launchable-model inventory refresh duration',
    unit: 'ms',
  },
);

export const adapterRegistration = meter.createCounter(
  'station.adapter.registration',
  {
    description:
      'Runtime provider adapter registration outcomes by source and adapter id',
  },
);

export const adapterReadiness = meter.createCounter(
  'station.adapter.readiness',
  {
    description:
      'Runtime provider adapter readiness checks by provider and runtime state',
  },
);

export const startupDefaultSelection = meter.createCounter(
  'station.startup.default_selection',
  {
    description:
      'Startup default provider/runtime selection decisions for first-run readiness',
  },
);

export const chatStartGate = meter.createCounter('station.chat.start_gate', {
  description:
    'Chat session start gate outcomes by agent/runtime class and reason',
});

/**
 * archive#1011: where an engine session was told to launch. `outcome=inherited`
 * means Station supplied no cwd and the engine took the server process's
 * directory — expected for an unbound chat, and the signal to watch if it
 * ever reappears for a project-bound one.
 */
export const sessionCwdResolution = meter.createCounter(
  'station.chat.session_cwd_resolution',
  {
    description:
      'Session working-directory resolution outcomes by provider, source, and reason',
  },
);

export const adapterSessionStartDuration = meter.createHistogram(
  'station.adapter.session_start_duration',
  {
    description: 'Provider adapter session start duration',
    unit: 'ms',
  },
);

export const adapterTurnDuration = meter.createHistogram(
  'station.adapter.turn_duration',
  {
    description: 'Provider adapter turn duration',
    unit: 'ms',
  },
);

export const chatAttachmentsDispatched = meter.createCounter(
  'station.chat.attachments_dispatched',
  {
    description:
      'Validated chat attachments successfully dispatched to provider adapters',
  },
);

export const chatAttachmentBytesDispatched = meter.createCounter(
  'station.chat.attachment_bytes_dispatched',
  {
    description:
      'Validated chat attachment bytes successfully dispatched to provider adapters',
    unit: 'By',
  },
);

export const attachmentBlobOperations = meter.createCounter(
  'station.chat.attachment_blob_operations',
  {
    description:
      'Attachment blob store calls by operation (write/read/reclaim) and outcome',
  },
);

export const attachmentBlobBytesStored = meter.createCounter(
  'station.chat.attachment_blob_bytes_stored',
  {
    description:
      'Attachment bytes newly written to the blob store, excluding content-addressed deduplication hits',
    unit: 'By',
  },
);

export const attachmentBlobBytesReclaimed = meter.createCounter(
  'station.chat.attachment_blob_bytes_reclaimed',
  {
    description: 'Attachment blob bytes removed by retention',
    unit: 'By',
  },
);

export const attachmentBytesStripped = meter.createCounter(
  'station.chat.attachment_bytes_stripped',
  {
    description:
      'Attachment data-URL bytes kept out of a persisted event payload by replacing them with a blob reference',
    unit: 'By',
  },
);

export const attachmentBlobRequests = meter.createCounter(
  'station.chat.attachment_blob_requests',
  {
    description:
      'GET /api/attachments requests by outcome (served/not_found/rejected)',
  },
);

export const attachmentReplayRefusals = meter.createCounter(
  'station.chat.attachment_replay_refusals',
  {
    description:
      "Recovery replays refused because a recorded turn's attachment bytes could no longer be resolved",
  },
);

export const orchestrationCommandsDispatched = meter.createCounter(
  'station.orchestration.commands_dispatched',
  {
    description: 'Orchestration commands routed to provider adapters',
  },
);

export const orchestrationSteerDispatches = meter.createCounter(
  'station.orchestration.steer_dispatches',
  {
    description:
      'Mid-turn steer dispatch outcomes at the orchestration capability gate',
  },
);

/**
 * archive#2959: a turn that produced no observed progress event (streamed
 * content chunk, tool lifecycle event, or session state transition) within
 * its agent's declared turn-stall window. Counted at detection time,
 * independent of whether the ensuing cooperative-stop settles cooperatively
 * or forced — this is a stall-detection signal, not a stop-outcome signal
 * (`station.session.transition.total` already covers the latter).
 */
export const orchestrationTurnStallDetections = meter.createCounter(
  'station.orchestration.turn_stall_detections',
  {
    description:
      'Turns detected as stalled (no observed progress within the agent turn-stall window)',
  },
);

/** Content-free model launch decisions emitted at shared dispatch. */
export const modelLaunchResolutionTotal = meter.createCounter(
  'station.model_launch.resolution.total',
  {
    description:
      'Model launch-plan resolution and override outcomes by bounded capability attributes',
  },
);

/**
 * archive#1224 (offline): a `sendTurn` dispatch carrying a
 * `clientTurnId` that already has a claim recorded for its thread — either
 * already resolved (`outcome: 'hit'`) or still in flight from a concurrent
 * dispatch (`outcome: 'hit_inflight'`) — so `adapter.sendTurn` was NOT
 * called a second time. See `TurnDeduplicator.claim`.
 */
export const orchestrationTurnDedup = meter.createCounter(
  'station.orchestration.turn_dedup',
  {
    description:
      'sendTurn dispatches deduped by clientTurnId instead of re-executing',
  },
);

export const turnDedupClaims = meter.createCounter(
  'station.turn_dedup.claims',
  {
    description: 'Durably recorded turn idempotency claim outcomes',
  },
);

/**
 * archive#1224 (offline): a `/chat` request carrying a
 * `clientTurnId` already claimed for a prior request — see
 * `chat-turn-dedup.ts`. Mirrors `orchestrationTurnDedup` for the direct
 * (non-orchestration) send path.
 */
export const chatTurnDedup = meter.createCounter('station.chat.turn_dedup', {
  description:
    'Chat requests deduped by clientTurnId instead of re-running the agent',
});

export const orchestrationEventsPersisted = meter.createCounter(
  'station.orchestration.events_persisted',
  {
    description: 'Canonical orchestration events written to the event store',
  },
);

/**
 * How often a bounded session-window read hands a client less than the stored
 * event, by which budget fired (archive#3386). The per-event marker tells ONE
 * reader what happened to ONE event; this is the only way to know whether the
 * 4 KB per-event ceiling is a rare edge or a routine amputation of restored
 * transcripts — and neither ceiling can be tuned honestly without it.
 */
export const orchestrationEventWindowElisions = meter.createCounter(
  'station.orchestration.event_window_elisions',
  {
    description:
      'Events a bounded window read returned with payload withheld, by reason (byte_limit/output_limit)',
  },
);

export const orchestrationStoreQuarantineDispositions = meter.createCounter(
  'station.orchestration.store_quarantine_dispositions',
  {
    description:
      'Boot-time dispositions of a recorded orchestration-store corruption, by outcome (station#3217)',
  },
);

/**
 * How often corruption is actually observed in the field. With the per-boot
 * integrity check removed (archive#3219), reactive classification is the only
 * detection path, and this counter is the evidence of what it finds. Without
 * it, the only honest answer to "is reactive detection enough?" is that
 * nobody knows.
 */
export const orchestrationStoreCorruptionObserved = meter.createCounter(
  'station.orchestration.store_corruption_observed',
  {
    description:
      'Store corruption classified from a real SQLite verdict, by errcode and source (query | scheduled-probe)',
  },
);

/**
 * SQLITE_BUSY observed against the orchestration event store from the adapter
 * event stream (archive#3304). Distinct from corruption: the file is healthy,
 * another connection — typically a second Station process sharing the home —
 * holds a lock longer than the busy budget.
 */
export const orchestrationStoreContentionObserved = meter.createCounter(
  'station.orchestration.store_contention_observed',
  {
    description:
      'Orchestration event store lock contention surfaced to a consumer, by site',
  },
);

export const delegatedTasks = meter.createCounter(
  'station.orchestration.delegated_tasks',
  {
    description:
      'Resumable tasks delegated through Station Control by target and environment kind',
  },
);

export const delegatedTaskFollowUps = meter.createCounter(
  'station.orchestration.delegated_task_follow_ups',
  {
    description:
      'Follow-up turns sent to resumable delegated tasks by target and environment kind',
  },
);

export const delegatedTaskRequestResponses = meter.createCounter(
  'station.orchestration.delegated_task_request_responses',
  {
    description:
      'Responses to delegated task requests by target, environment kind, and decision',
  },
);

export const delegatedTaskInterrupts = meter.createCounter(
  'station.orchestration.delegated_task_interrupts',
  {
    description:
      'Interrupts requested for resumable delegated tasks by target and environment kind',
  },
);

export const orchestrationEventPersistDuration = meter.createHistogram(
  'station.orchestration.event_persist_duration',
  {
    description: 'Canonical orchestration event persistence duration',
    unit: 'ms',
  },
);

// ── Event-stream sequence-cursor resume (archive#1092) ──
export const orchestrationStreamResumeDecisions = meter.createCounter(
  'station.orchestration.stream_resume_decisions',
  {
    description:
      'Orchestration /events reconnect decisions (replay vs snapshot) by reason',
  },
);

export const orchestrationStreamResumeGap = meter.createHistogram(
  'station.orchestration.stream_resume_gap',
  {
    description:
      'Sequence gap between a reconnecting client Last-Event-ID cursor and the current head',
  },
);

/**
 * archive#1848: how long a `/api/orchestration/events` SSE connection actually
 * stayed open, recorded once per connection when it ends, by `scope`
 * (`thread`/`all`).
 *
 * This is the observable the route was missing. `streamSSE` returns its
 * Response as soon as the headers and body stream exist, so the request-log
 * line (`runtime-http.ts`) can only ever report time-to-headers — a
 * connection held open for an hour and one that failed instantly both log a
 * single-digit millisecond duration, and archive#1848 was diagnosed as "the endpoint
 * answers and closes in 0-2ms" from exactly that reading. A duration recorded
 * at teardown is the only place the difference exists.
 */
export const orchestrationStreamDuration = meter.createHistogram(
  'station.orchestration.stream_duration',
  {
    description:
      'How long an orchestration /events SSE connection stayed open, recorded at disconnect, by scope',
    unit: 'ms',
  },
);

// ── Per-thread session-owner cache (archive#1120) ──
/**
 * Lookups against the bounded per-thread `threadId -> ownerUserId` cache
 * that backs the `/events` SSE route's `canUserReadSession` authorization
 * gate, by outcome: `hit` (no store read needed), `miss` (fell through to
 * a full `eventStore.listEvents` read), `invalidated` (a subsequent
 * `session.started`/`session.configured` event evicted a cached owner),
 * `evicted` (bounded-size LRU eviction).
 */
export const sessionOwnerCacheOps = meter.createCounter(
  'station.orchestration.session_owner_cache_ops',
  {
    description:
      'Per-thread session-owner cache lookups on the /events authorization gate, by outcome',
  },
);

// ── Coalesced event fan-out (archive#1093 Part B) ──
/**
 * Per-dispatch coalesce ratio (events-in vs work-out) for a
 * `KeyedCoalescingWorker` consumer wired onto the orchestration event
 * fan-out path. Recorded once per handler invocation with the number of
 * raw events merged into that single dispatch (1 = no coalescing occurred
 * for that dispatch; N = a burst of N events collapsed into one downstream
 * operation). `consumer` names the integration point (e.g. `console_bridge`).
 */
// Review fix (LOW, archive#1093 Part B fix round): no separate
// burst-size counter alongside this — a histogram's Sum/Count
// aggregations already give any backend the same running total and
// dispatch count a parallel counter would have provided.
export const orchestrationCoalesceRatio = meter.createHistogram(
  'station.orchestration.coalesce_ratio',
  {
    description:
      'Raw orchestration events merged into a single downstream dispatch by a KeyedCoalescingWorker consumer on the event fan-out path, by consumer',
  },
);

// ── Attached external-session follow ──
export const attachedSessionDiscovery = meter.createCounter(
  'station.attached_sessions.discovery',
  {
    description:
      'Bounded attached-session discovery outcomes by provider and fixed reason',
  },
);

export const attachedSessionScanDuration = meter.createHistogram(
  'station.attached_sessions.scan_duration_ms',
  {
    description: 'Bounded attached-session source scan duration',
    unit: 'ms',
  },
);

export const attachedSessionEventsImported = meter.createCounter(
  'station.attached_sessions.events_imported',
  {
    description:
      'Canonical attached-session events imported by provider and method',
  },
);

export const attachedSessionProjectAttribution = meter.createCounter(
  'station.attached_sessions.project_attribution',
  {
    description:
      'Attached-session project attribution outcomes by source and fixed state (attributed, ambiguous, unattributed)',
  },
);

export const attachedSessionMutationRejected = meter.createCounter(
  'station.attached_sessions.mutation_rejected',
  {
    description:
      'Attached-session mutations rejected by Station ownership, by command type and fixed source',
  },
);

// ── Worktree isolation ──
export const worktreeProvisionTotal = meter.createCounter(
  'station.worktree.provision.total',
  {
    description:
      'Worktree isolation provisioning attempts by provider and outcome',
  },
);

export const worktreeProvisionDuration = meter.createHistogram(
  'station.worktree.provision.duration_ms',
  {
    description: 'Worktree isolation provisioning duration in milliseconds',
    unit: 'ms',
  },
);

export const worktreeCleanupTotal = meter.createCounter(
  'station.worktree.cleanup.total',
  {
    description:
      'Worktree isolation cleanup decisions and outcomes by policy and terminal state',
  },
);

export const worktreeConflictPreventedTotal = meter.createCounter(
  'station.worktree.conflict_prevented.total',
  {
    description:
      'Potential shared-workspace conflicts prevented before worktree provisioning',
  },
);

// ── Session lifecycle ──
export const sessionTransitions = meter.createCounter(
  'station.session.transition.total',
  {
    description:
      'Session lifecycle transition validation and emission outcomes',
  },
);

export const sessionStateDuration = meter.createHistogram(
  'station.session.state.duration_ms',
  {
    description: 'Time spent in a session lifecycle state',
    unit: 'ms',
  },
);

export const sessionBackgroundTasks = meter.createCounter(
  'station.session.background_tasks',
  {
    description:
      'Provider background task/subagent settles surfaced to the chat (attrs: provider, status)',
  },
);

export const sessionActivityEvents = meter.createCounter(
  'station.session.activity_events',
  {
    description:
      'Provider activity signals mapped to canonical events (attrs: provider, kind)',
  },
);

export const uiSessionBoardActions = meter.createCounter(
  'station.ui.session_board.action.total',
  {
    description: 'Session board user action outcomes',
  },
);

export const uiSessionBoardLoadDuration = meter.createHistogram(
  'station.ui.session_board.load_ms',
  {
    description: 'Session board load duration',
    unit: 'ms',
  },
);

/** Personal spatial-board owner resolution, with no reference identity tags. */
export const spatialBoardResolutionOutcomes = meter.createCounter(
  'station.spatial_board.resolution.outcomes',
  { description: 'Spatial board owner resolution outcomes by kind and state' },
);
export const spatialBoardResolutionDuration = meter.createHistogram(
  'station.spatial_board.resolution.duration',
  { description: 'Spatial board owner resolution duration', unit: 'ms' },
);
/** Revisioned Board writes; labels deliberately exclude pin and owner identity. */
export const spatialBoardMutationOutcomes = meter.createCounter(
  'station.spatial_board.mutation.outcomes',
  { description: 'Spatial board mutation outcomes by operation' },
);

// ── Task graph ──
export const taskDispatchTotal = meter.createCounter(
  'station.task.dispatch.total',
  {
    description:
      'Task dispatch attempts by outcome, runtime kind, and source surface',
  },
);

export const taskDispatchStartLatencyMs = meter.createHistogram(
  'station.task.dispatch.start_latency_ms',
  {
    description: 'Task dispatch start latency in milliseconds',
    unit: 'ms',
  },
);

// Dispatch-as-claim (roadmap archive#584, part of epic archive#580, S4): AssignmentProvider
// claim/release outcomes, distinct from `taskDispatchTotal` (which only
// carries the dispatch-level 'blocked' outcome) — this counter also covers
// 'unavailable' (CLI missing/degraded) and 'released'/'skipped' outcomes
// that never touch the dispatch counter at all.
export const taskAssignmentClaimTotal = meter.createCounter(
  'station.task.assignment_claim.total',
  {
    description:
      'AssignmentProvider claim/release attempts by operation and outcome',
  },
);

export const graphLinkCreatedTotal = meter.createCounter(
  'station.graph.link.created.total',
  {
    description:
      'Relation graph link creation outcomes by relation type and source',
  },
);

export const graphQueryTotal = meter.createCounter(
  'station.graph.query.total',
  {
    description:
      'Relation graph query operations by query type and result bucket',
  },
);

export const taskWorkspaceBindingTotal = meter.createCounter(
  'station.task.workspace.binding.total',
  {
    description:
      'Task workspace binding capture outcomes by bounded source surface',
  },
);

export const taskReferenceCreatedTotal = meter.createCounter(
  'station.task.reference.created.total',
  {
    description:
      'Task reference creation outcomes by reference kind and bounded source surface',
  },
);

/** Exact answer resolution outcomes; never label Session, Task, or turn ids. */
export const taskTurnReferenceResolutionTotal = meter.createCounter(
  'station.task.turn_reference.resolution.total',
  {
    description:
      'Authorized exact Task-answer resolution outcomes by bounded operation and outcome',
  },
);

export const taskWorkspaceOpenTotal = meter.createCounter(
  'station.task.workspace.open.total',
  {
    description:
      'Task workspace opens by binding availability and bounded source surface',
  },
);

// ── Notifications ──
export const notificationOps = meter.createCounter(
  'station.notification.operations',
  {
    description: 'Notification schedule/deliver/dismiss events',
  },
);
export const approvalInboxOps = meter.createCounter(
  'station.approval_inbox.operations',
  {
    description: 'Approval inbox open/resolve/action events',
  },
);
export const attentionProjectionLoads = meter.createCounter(
  'station.attention_projection.loads',
  { description: 'Attention projection reads' },
);
export const attentionProjectionResults = meter.createHistogram(
  'station.attention_projection.results',
  { description: 'Attention items returned per projection read' },
);
export const attentionGateScanDuration = meter.createHistogram(
  'station.attention.gate_scan',
  {
    description:
      'Bounded Flow gate scan duration folded into the attention projection (non-terminal, Flow-bound sessions only)',
    unit: 'ms',
  },
);
export const attentionRequestEvidenceScanDuration = meter.createHistogram(
  'station.attention.request_evidence_scan',
  {
    description:
      'Bounded open request.opened lookup duration for needs_input/review_pending attention items (station#1185): resolves the request evidence behind the lifecycle flag, cached per-thread',
    unit: 'ms',
  },
);
export const approvalGuardianOps = meter.createCounter(
  'station.approval_guardian.operations',
  {
    description:
      'Guardian review requests and decisions for approval-bound tools',
  },
);
export const reviewProposals = meter.createCounter(
  'station.review.proposal.total',
  {
    description: 'AI-proposed review artifacts created for human review',
  },
);
export const reviewDecisions = meter.createCounter(
  'station.review.decision.total',
  {
    description: 'Human or system decisions on proposed changes',
  },
);
export const reviewTimeToDecision = meter.createHistogram(
  'station.review.time_to_decision_ms',
  {
    description: 'Elapsed time from proposed change creation to decision',
    unit: 'ms',
  },
);
export const reviewQueueDepthSamples = meter.createCounter(
  'station.review.queue.depth.sample',
  {
    description: 'Sampled pending review queue depth',
  },
);
export const reviewCommentsCreated = meter.createCounter(
  'station.review.comments.created',
  {
    description: 'Inline diff review comments created',
  },
);
export const reviewCommentsDeleted = meter.createCounter(
  'station.review.comments.deleted',
  {
    description: 'Inline diff review comments deleted',
  },
);
export const reviewCommentsListed = meter.createCounter(
  'station.review.comments.listed',
  {
    description: 'Cross-project diff review comment listings (review queue)',
  },
);

// ── Context Safety ──
export const contextSafetyScans = meter.createCounter(
  'station.context_safety.scans',
  {
    description: 'Context safety scan operations',
  },
);
export const contextSafetyFindings = meter.createCounter(
  'station.context_safety.findings',
  {
    description: 'Context safety findings by rule and severity',
  },
);

// ── Scheduler ──
export const schedulerJobRuns = meter.createCounter(
  'station.scheduler.job.runs',
  {
    description: 'Scheduler job executions',
  },
);
export const schedulerJobDuration = meter.createHistogram(
  'station.scheduler.job.duration',
  {
    description: 'Scheduler job execution duration',
    unit: 'ms',
  },
);
export const schedulerConcurrencyDeferrals = meter.createCounter(
  'station.scheduler.concurrency.deferrals',
  {
    description:
      'Automatic scheduler occurrences deferred by the invocation ceiling',
  },
);
export const schedulerHealthy = meter.createObservableGauge(
  'station.scheduler.healthy',
  { description: 'Scheduler heartbeat health (1=healthy, 0=unhealthy)' },
);

// ── MCP lifecycle ──
export const mcpLifecycle = meter.createCounter('station.mcp.lifecycle', {
  description: 'MCP connection lifecycle events',
});
export const toolServerOAuth = meter.createCounter(
  'station.tool_server.oauth.total',
  { description: 'Tool-server OAuth lifecycle outcomes' },
);
export const mcpNegotiations = meter.createCounter(
  'station.mcp.negotiation.total',
  {
    description:
      'MCP protocol negotiation outcomes by era, version, compatibility-path use, and error class',
  },
);
export const mcpNegotiationDuration = meter.createHistogram(
  'station.mcp.negotiation.duration',
  {
    description: 'MCP connection negotiation and initial discovery duration',
    unit: 'ms',
  },
);
export const mcpUiResolveTotal = meter.createCounter(
  'station.mcp_ui.resolve.total',
  {
    description: 'MCP UI layout resolver outcomes by server, tool, and status',
  },
);
export const mcpUiResourceReadTotal = meter.createCounter(
  'station.mcp_ui.resource_read.total',
  {
    description: 'MCP UI resource-read proxy outcomes by server and result',
  },
);
export const mcpUiToolCallTotal = meter.createCounter(
  'station.mcp_ui.tool_call.total',
  {
    description: 'MCP UI tool-call proxy outcomes by server and result',
  },
);
export const mcpUiFrameServeTotal = meter.createCounter(
  'station.mcp_ui.frame_serve.total',
  {
    description: 'Dedicated MCP-UI frame-origin serve outcomes by result',
  },
);
export const mcpUiToolCallRequestOpened = meter.createCounter(
  'station.mcp_ui.tool_call_request.opened',
  {
    description:
      'MCP-UI tool calls gated through an inbox approval, by server and tool',
  },
);
export const mcpUiToolCallRequestResolved = meter.createCounter(
  'station.mcp_ui.tool_call_request.resolved',
  {
    description:
      'Resolved MCP-UI tool-call approvals by server, tool, and decision',
  },
);
export const mcpUiToolCallEvidenceAttached = meter.createCounter(
  'station.mcp_ui.tool_call_evidence.attached',
  {
    description:
      'MCP-UI tool-call results attached as Flow evidence by server, tool, gate',
  },
);
export const mcpUiRenderPermissionChecks = meter.createCounter(
  'station.mcp_ui.render_permission.checks',
  {
    description:
      'Per-server MCP-UI render permission checks, by server and revoked state',
  },
);
export const mcpUiRenderPermissionRevokes = meter.createCounter(
  'station.mcp_ui.render_permission.revokes',
  { description: 'Per-server MCP-UI render permission revocations, by server' },
);
export const mcpUiRenderPermissionAllows = meter.createCounter(
  'station.mcp_ui.render_permission.allows',
  {
    description: 'Per-server MCP-UI render permission (re-)allows, by server',
  },
);

// archive#1195 (epic archive#1191 slice C): the wire-safe station-control MCP
// delivery to Codex — the token-minting/auth boundary and the wire-channel
// delivery itself are separate concerns, each with their own counter.
export const stationControlMcpTokenMinted = meter.createCounter(
  'station.mcp.station_control_http.token_minted',
  {
    description:
      'station-control HTTP/SSE MCP tokens minted, by whether this mint replaced an already-live token for the same session',
  },
);
export const stationControlMcpHttpAuth = meter.createCounter(
  'station.mcp.station_control_http.auth',
  {
    description:
      'station-control HTTP/SSE MCP endpoint auth outcomes (accepted/rejected/loopback_denied)',
  },
);
/** Bounded execution-context propagation only; deliberately excludes identity. */
export const tenantExecutionContextOutcomes = meter.createCounter(
  'station.tenant_execution_context.outcomes',
  {
    description:
      'Hosted tenant execution-context validation and propagation by bounded operation, source, outcome, and reason',
  },
);
/** Fixed, privacy-safe dimensions for tenant execution propagation telemetry. */
export const TENANT_EXECUTION_CONTEXT_OPERATION = [
  'bind',
  'dispatch',
  'start',
  'continue',
  'relay',
  'station_control',
  'background',
] as const;
export type TenantExecutionContextOperation =
  (typeof TENANT_EXECUTION_CONTEXT_OPERATION)[number];
export const TENANT_EXECUTION_CONTEXT_SOURCE = [
  'none',
  'request',
  'session',
  'operator',
  'aggregate',
] as const;
export type TenantExecutionContextSource =
  (typeof TENANT_EXECUTION_CONTEXT_SOURCE)[number];
export const TENANT_EXECUTION_CONTEXT_OUTCOME = [
  'accepted',
  'rejected',
  'skipped',
] as const;
export type TenantExecutionContextOutcome =
  (typeof TENANT_EXECUTION_CONTEXT_OUTCOME)[number];
export const TENANT_EXECUTION_CONTEXT_REASON = [
  'none',
  'missing',
  'unknown',
  'mismatch',
  'aggregate_safe',
  'personal_mode',
] as const;
export type TenantExecutionContextReason =
  (typeof TENANT_EXECUTION_CONTEXT_REASON)[number];
export function tenantExecutionContextAttributes(input: {
  operation: TenantExecutionContextOperation;
  source: TenantExecutionContextSource;
  outcome: TenantExecutionContextOutcome;
  reason: TenantExecutionContextReason;
}) {
  // Project only this closed vocabulary. This is deliberately not `return
  // input`: callers that accidentally pass a wider object through `any` must
  // not turn tenant/host/session content into a metric dimension.
  const { operation, source, outcome, reason } = input;
  return { operation, source, outcome, reason };
}
export const codexToolServersDelivered = meter.createCounter(
  'station.codex.tool_servers.delivered',
  {
    description:
      'Codex mcp_servers -c config overrides delivered per session, by transport',
  },
);

// ── Flow (gate engine) ──
export const flowRunsStarted = meter.createCounter('station.flow.run.started', {
  description: 'Flow runs started by definition id',
});
export const flowEvidenceAttached = meter.createCounter(
  'station.flow.evidence.attached',
  {
    description: 'Flow evidence attachments by kind and gate',
  },
);
export const flowEvidenceAutoSuperseded = meter.createCounter(
  'station.flow.evidence.auto_superseded',
  {
    description:
      'Prior failed Flow evidence entries auto-superseded by a command-evidence retry, by gate',
  },
);
export const flowGateEvaluations = meter.createCounter(
  'station.flow.gate.evaluations',
  {
    description:
      'Flow gate evaluation outcomes by gate and status (pass/block/route-back/wait)',
  },
);
export const flowRunLocationDiagnostics = meter.createCounter(
  'station.flow.run_location.diagnostics',
  {
    description:
      'Flow run-location diagnostics raised while enumerating runs, by code and severity — the run directories Flow skipped rather than listed',
  },
);
export const flowExceptionsAccepted = meter.createCounter(
  'station.flow.exception.accepted',
  {
    description: 'Flow gate exceptions accepted by gate',
  },
);
export const flowReportsGenerated = meter.createCounter(
  'station.flow.report.generated',
  {
    description: 'Flow run reports generated by format',
  },
);
export const flowSessionGateChecks = meter.createCounter(
  'station.flow.session.gate_checks',
  {
    description:
      'Flow completion gate checks on orchestration sessions by verdict (pass/route-back/block/wait)',
  },
);
export const flowToolEvidenceSpooled = meter.createCounter(
  'station.flow.tool_evidence.spooled',
  {
    description:
      'Tool-call command outputs spooled for flow command-evidence auto-attach, by tool',
  },
);
export const flowToolEvidenceAttached = meter.createCounter(
  'station.flow.tool_evidence.attached',
  {
    description:
      'Spooled tool-call command evidence auto-attached to flow gates, by gate, claim_type, and status (pass/fail)',
  },
);

// ── Agent policy (Flow Agents canonical hooks, S3) ──
export const policyChecks = meter.createCounter('station.policy.checks', {
  description:
    'Flow Agents policy checks by policy class (config-protection/quality-gate/workflow-steering/stop-goal-fit), outcome, engine, and runtime kind',
});

// ── Platform-mutation gate (gated station-control mutations, S3) ──
export const platformMutations = meter.createCounter(
  'station.platform.mutations',
  {
    description:
      'Agent-driven station-control platform mutations in policy-opted workspaces by tool, outcome (allowed/warned/blocked/failed), and run_bound flag',
  },
);

// ── Workflow sidecars (Flow Agents durable task state, S3) ──
export const workflowSidecarBindings = meter.createCounter(
  'station.workflow.sidecar.bindings',
  {
    description:
      'Session -> task-slug sidecar bindings at session start, by resumed flag and runtime kind (the cross-runtime resume signal)',
  },
);
export const workflowSidecarTransitions = meter.createCounter(
  'station.workflow.sidecar.transitions',
  {
    description:
      'Workflow sidecar state.json transitions by trigger (session-start/gate-verdict/completion/manual) and resulting status',
  },
);

// ── Work-item provider seam (roadmap archive#583, part of epic archive#580, S3) ──
export const workItemProviderListTotal = meter.createCounter(
  'station.work_item_provider.list.total',
  {
    description:
      'Work-item provider seam listWorkItems calls by provider_kind (local/flow-agents-github) and outcome (available/unavailable/error)',
  },
);

// ── Console bridge (Kontour Console event emission, S4) ──
export const consoleEmissions = meter.createCounter(
  'station.console.emissions',
  {
    description:
      'Console event record deliveries by sink (hub/file) and outcome (accepted/failed/skipped)',
  },
);

// ── Canonical skills (Flow Agents skills source, S3) ──
export const canonicalSkillsDiscovered = meter.createCounter(
  'station.skills.canonical.discovered',
  {
    description:
      'Canonical skills discovered from external skill sources (e.g. the installed @kontourai/flow-agents package), by source label',
  },
);

export const flowRunConsoleProjections = meter.createCounter(
  'station.flow.console.projections',
  {
    description:
      'Flow run console projections built for the run console surface, by status (ok/error)',
  },
);
export const flowLayoutInits = meter.createCounter(
  'station.flow.layout.inits',
  {
    description:
      'Flow layout scaffolds (ensureFlowLayout) from the coding side-panel setup CTA, by outcome (created/already-initialized/error)',
  },
);

// ── Surface trust bundles (project trust surfaces) ──
export const trustBundleLists = meter.createCounter(
  'station.trust.bundle.lists',
  {
    description:
      'Trust bundle directory scans for a project, by source presence (workspace/station-home/both/none)',
  },
);
export const trustBundleReads = meter.createCounter(
  'station.trust.bundle.reads',
  {
    description:
      'Trust bundle reads resolved into trust reports, by outcome (report/invalid/not-found)',
  },
);

// ── Veritas (merge readiness) ──
export const veritasReadinessRuns = meter.createCounter(
  'station.veritas.readiness.runs',
  {
    description:
      'Veritas readiness runs by status (ready/not-ready/error/not-configured) and source (cli/cache)',
  },
);
export const veritasReadinessDuration = meter.createHistogram(
  'station.veritas.readiness.duration',
  {
    description: 'Veritas readiness CLI run duration',
    unit: 'ms',
  },
);
export const veritasReadinessInits = meter.createCounter(
  'station.veritas.readiness.inits',
  {
    description:
      'Veritas workspace inits (veritas init) from the coding side-panel setup CTA, by outcome (created/already-initialized/no-cli/error)',
  },
);

// ── Knowledge ──
export const knowledgeOps = meter.createCounter(
  'station.knowledge.operations',
  {
    description: 'Knowledge query/index operations',
  },
);

// ── Knowledge Store (K2) ──
export const knowledgeStoreRootOps = meter.createCounter(
  'station.knowledge.root.operations',
  {
    description:
      'KnowledgeStoreProvider root registry operations, by op (create/remove/list) and scope (personal/project)',
  },
);
export const knowledgeStoreRecordOps = meter.createCounter(
  'station.knowledge.record.operations',
  {
    description:
      'KnowledgeStoreAdapter record mutation operations, by op (create/update/link/propose/apply/reject/supersede/retire) and adapterId',
  },
);
export const knowledgeStoreTransactionOps = meter.createCounter(
  'station.knowledge.store.transactions',
  {
    description:
      'File-backed knowledge store transaction outcomes, including recovery and conflicts',
  },
);

/**
 * archive#1879: the `conversation-store` read-only projection adapter's own
 * usage counter — distinct from `knowledgeStoreRecordOps` above because that
 * instrument only ever fires for a Station-driven MUTATION
 * (`knowledge-store-provider.ts`'s `wrapWithChangeEvents`), and this adapter's
 * entire surface is reads plus rejected mutations. `op` is `'list'` | `'get'`
 * for a successful read (with `leg`: `'session'` | `'file'` | `'none'` naming
 * which conversation source answered it), or the attempted mutation verb with
 * `outcome: 'read_only_rejected'` for a rejected write.
 */
export const conversationStoreReadOps = meter.createCounter(
  'station.knowledge.conversation_store.reads',
  {
    description:
      'conversation-store read-only adapter operations, by op (list/get/create/update/link/propose/apply/reject/supersede/retire), leg (session/file/none) on reads, and outcome (read_only_rejected) on rejected mutations',
  },
);

// ── Knowledge Index (K3) ──
export const knowledgeIndexOps = meter.createCounter(
  'station.knowledge.index.operations',
  {
    description:
      'KnowledgeIndexProvider operations, by op (upsert/search/removeByRecord/removeRoot/rebuildRoot) and rootId',
  },
);
export const knowledgeIndexRebuildDuration = meter.createHistogram(
  'station.knowledge.index.rebuild.duration',
  {
    description: 'KnowledgeIndexProvider rebuildRoot duration',
    unit: 'ms',
  },
);

// ── Knowledge Migration (K3) ──
export const knowledgeMigrationOps = meter.createCounter(
  'station.knowledge.migration.operations',
  {
    description:
      'Pre-index knowledge migration operations, by op (read/write/noop) and outcome',
  },
);

// ── Feedback ──
export const feedbackOps = meter.createCounter('station.feedback.operations', {
  description: 'Feedback submission events',
});

// ── Tool Approvals ──
export const approvalOps = meter.createCounter('station.approval.operations', {
  description: 'Tool approval request/approve/deny events',
});
export const approvalDuration = meter.createHistogram(
  'station.approval.duration',
  {
    description: 'Time from approval request to decision',
    unit: 'ms',
  },
);

// ── Terminal ──
export const terminalOps = meter.createCounter('station.terminal.operations', {
  description: 'Terminal session lifecycle events',
});

// ── ACP ──
export const acpOps = meter.createCounter('station.acp.operations', {
  description: 'ACP connection lifecycle events',
});
export const acpPassthroughSessions = meter.createCounter(
  'station.acp.passthrough_sessions',
  {
    description:
      'ACP sessions started with Station tool servers passed through as MCP servers (docs/design/connections-onboarding.md §5)',
  },
);

// ── archive#895 wave B: ACP session resume (session/load) ──
export const acpResumeSessions = meter.createCounter(
  'station.acp.resume_sessions',
  {
    description:
      "ACP sessions resumed via session/load with Station tool servers re-delivered (#895; attrs: connectionId, outcome: 'loaded'|'load-unsupported')",
  },
);

/**
 * Inbound (agent→client) ACP extension requests, by disposition.
 *
 * The `disposition` attribute is the ONLY attribute, and its value set is
 * closed: `answered` | `refused-no-handler` | `refused-credential-shaped`.
 * The method name is agent-controlled, so it is unbounded cardinality and
 * belongs in the log line the policy also emits, never here.
 *
 * This counter is corroboration, not the observability channel: like every
 * instrument in this file it is a no-op unless `OTEL_EXPORTER_OTLP_ENDPOINT`
 * is set, so on a default install it discards every write. The refusal log
 * in `acp-inbound-extension-policy.ts` is what makes a new inbound
 * dependency visible.
 */
export const acpInboundExtensionRequests = meter.createCounter(
  'station.acp.inbound_extension_requests',
  {
    description:
      "Inbound agent→client ACP extension requests by disposition ('answered' | 'refused-no-handler' | 'refused-credential-shaped'); see ADR 0013 Layer 1",
  },
);

/**
 * Outbound (client→agent) ACP extension REQUESTS by disposition — the `call()`
 * path only. Closed set: `not-declared` (declared-list gate refused the call),
 * `answered` (any JSON-RPC result, including a `{success: false}` envelope),
 * `unsupported` (`-32601`), `failed` (any other error). Notifications are a
 * distinct call type counted on `acpOutboundExtensionNotifications`.
 *
 * The method name is agent-controlled and unbounded; it never reaches this
 * counter (ADR 0013). Like every instrument here this is a no-op unless
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set; the channel's returned outcome (and
 * the `not-declared` receipt) is the primary surface, not this counter.
 */
export const acpOutboundExtensionRequests = meter.createCounter(
  'station.acp.outbound_extension_requests',
  {
    description:
      "Outbound client→agent ACP extension REQUESTS (call()) by disposition ('not-declared' | 'answered' | 'unsupported' | 'failed'); see ADR 0013 Layer 1",
  },
);

/**
 * Outbound (client→agent) ACP extension NOTIFICATIONS by disposition — the
 * `notify()` (fire-and-forget) path only. Closed set: `not-declared`
 * (declared-list gate refused the send), `sent` (delivered), `failed`
 * (transport error). Requests are counted on `acpOutboundExtensionRequests`.
 *
 * The method name is agent-controlled and unbounded; it never reaches this
 * counter (ADR 0013). Like every instrument here this is a no-op unless
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set; the channel's returned outcome is the
 * primary surface, not this counter.
 */
export const acpOutboundExtensionNotifications = meter.createCounter(
  'station.acp.outbound_extension_notifications',
  {
    description:
      "Outbound client→agent ACP extension NOTIFICATIONS (notify()) by disposition ('not-declared' | 'sent' | 'failed'); see ADR 0013 Layer 1",
  },
);

/**
 * archive#3441: a probe engine that survived its own destroy is retried on
 * the next probe cycle (archive#3422) rather than forgotten -- but retention
 * is bounded, so every terminal outcome of that retry loop is counted here.
 * Closed set: `reaped` (the kernel now agrees it is gone), `retained`
 * (still surviving, under the retry bound), `abandoned` (exceeded the retry
 * bound; Station stops paying the destroy cost for it, but does not kill it).
 *
 * `reaped` derives ONLY "this object's process is no longer at the pid it
 * spawned" (`!survivesCleanup()`, the same identity check `forceGroupKill()`
 * confirms against) -- it does not claim THIS cycle's own attempt is what
 * killed it. Two of its three recording sites (archive#3441 MEDIUM-1's
 * pre-signal identity check, and LOW-1's post-timeout catch-up) perform no
 * destroy or signal at all in the cycle that records it; the process was
 * already gone, most plausibly from an earlier cycle's SIGKILL that hadn't
 * been confirmed by the time that cycle's own confirm window closed.
 */
export const acpProbeCleanupRetention = meter.createCounter(
  'station.acp.probe_cleanup_retention',
  {
    description:
      "Outcome of an ACP probe engine's cleanup attempt, by outcome ('reaped' | 'retained' | 'abandoned'); station#3441. Fires once per probe cycle for EVERY probed engine, not only a retained survivor's retry -- a healthy connection that needed no retention still records 'reaped' each cycle, so a survivor rate must be read as retained/(reaped+retained), never retained/total.",
  },
);

// ── Claude Code skills materialization ──
export const claudeSkillsMaterializedSessions = meter.createCounter(
  'station.claude.skills_materialized_sessions',
  {
    description:
      'Claude Code sessions that materialized opted-in Station skills into .claude/skills/ (docs/design/connections-onboarding.md §5)',
  },
);

// ── archive#895 wave A: per-agent capability delivery ──
export const agentCapabilityUndelivered = meter.createCounter(
  'station.orchestration.agent_capability_undelivered',
  {
    description:
      'Agent-requested capabilities a session engine/channel could not deliver, receipted per docs/design/agent-engine-unification.md §5 (attrs: provider, capability, reason)',
  },
);

// ── archive#895 wave B: agent-authored system prompt delivery ──
export const agentSystemPromptSessions = meter.createCounter(
  'station.providers.agent_system_prompt_sessions',
  {
    description:
      "Sessions started with an agent-authored system prompt delivered to an external engine (docs/design/agent-engine-unification.md §4.1; attrs: provider, channel: 'flag')",
  },
);

// ── archive#896: app-home profiles (overlay model channel 2) ──
export const appHomeSessions = meter.createCounter(
  'station.providers.app_home_sessions',
  {
    description:
      "Sessions started with the connection's app-home profile applied vs the global engine config (docs/design/agent-engine-unification.md §6.1; attrs: provider, applied: 'profile'|'global')",
  },
);
export const appHomeImport = meter.createCounter(
  'station.providers.app_home_import',
  {
    description:
      "Explicit user-triggered imports of a global engine config snapshot into a Station-owned app-home profile (attrs: provider, outcome, credentials: 'included'|'excluded')",
  },
);
// archive#896 wave 2: bounded profile-GC mechanism — an explicit, user-triggered
// clear action (never a background job/watcher/timer).
export const appHomeCleared = meter.createCounter(
  'station.providers.app_home_cleared',
  {
    description:
      'Explicit user-triggered clears of a Station-owned app-home profile dir (attrs: provider)',
  },
);

// ── Phase 1 onboarding/core closeout ──
export const onboardingRecommendations = meter.createCounter(
  'station.onboarding.recommendation',
  {
    description:
      'Doctor and system-status onboarding recommendation outcomes by missing capability kind',
  },
);
export const controlActions = meter.createCounter('station.control.action', {
  description: 'station-control management action outcomes',
});

// ── Voice ──
export const voiceOps = meter.createCounter('station.voice.operations', {
  description: 'Voice session lifecycle events',
});
export const voiceSessionLifecycle = meter.createCounter(
  'station.voice.session.lifecycle',
  {
    description:
      'Provider-neutral Voice session lifecycle outcomes with bounded attributes',
  },
);

// ── Templates ──
export const templateOps = meter.createCounter('station.template.operations', {
  description: 'Template list/apply events',
});

// ── Conversations ──
export const conversationOps = meter.createCounter(
  'station.conversation.operations',
  {
    description: 'Conversation lifecycle events',
  },
);
/** Bounded command-palette transcript searches, by outcome only. */
export const conversationMessageSearches = meter.createCounter(
  'station.conversation.message_searches',
  { description: 'Indexed conversation message searches by outcome' },
);
export const chatTitleRegenerated = meter.createCounter(
  'station.chat.title_regenerated',
  { description: 'Conversation title regeneration outcomes' },
);

// ── Coding ──
export const codingOps = meter.createCounter('station.coding.operations', {
  description: 'Coding session events',
});

// ── Auth ──
export const authOps = meter.createCounter('station.auth.operations', {
  description: 'Auth lifecycle events',
});

/**
 * archive#514: authenticated mutation budget decisions (body-size and rate).
 * Attributes are a closed vocabulary — `outcome` (allowed/oversized/rate_limited),
 * `class` (standard/streaming), and `source` (bearer/session/loopback, the
 * authentication mode the budget principal was derived from) — and NEVER carry
 * a path, principal id, or method name (unbounded cardinality).
 *
 * `source` deliberately does NOT participate in the budget key: keying on it
 * let one credential draw two budgets by choosing a transport. It is an
 * observation about which authentication mode a decision applied to, which is
 * what makes Station's internal-token traffic exhausting its shared budget
 * distinguishable from one paired device. That distinction is the whole reason
 * the field is retained.
 *
 * Like every instrument here this is a no-op unless
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set, so the counter is corroboration; the
 * HTTP status (413/429) is the real signal.
 */
export const requestBudgetOutcomes = meter.createCounter(
  'station.request_budget.outcomes',
  {
    description:
      'Authenticated mutation budget decisions by bounded outcome and budget class',
  },
);

// ── File Tree ──
export const fileTreeOps = meter.createCounter('station.filetree.operations', {
  description: 'File tree browse events',
});

// ── Registry ──
export const registryOps = meter.createCounter('station.registry.operations', {
  description: 'Registry install/uninstall events',
});

// ── Skills ──
export const skillOps = meter.createCounter('station.skills.operations', {
  description: 'Skill CRUD operations',
});
export const skillDiscoveryDuration = meter.createHistogram(
  'station.skills.discovery_duration',
  {
    description: 'Skill discovery duration',
    unit: 'ms',
  },
);
export const skillDiscoveries = meter.createCounter(
  'station.skill.discoveries',
  {
    description: 'Skill discovery events',
  },
);
export const skillActivations = meter.createCounter(
  'station.skill.activations',
  {
    description: 'Skill activation events',
  },
);
export const skillActivationDuration = meter.createHistogram(
  'station.skill.activation.duration',
  {
    description: 'Skill activation duration',
    unit: 'ms',
  },
);

// ── Analytics ──
export const analyticsOps = meter.createCounter(
  'station.analytics.operations',
  {
    description: 'Analytics query events',
  },
);

// ── Bedrock ──
export const bedrockOps = meter.createCounter('station.bedrock.operations', {
  description: 'Bedrock model catalog events',
});

// ── Config ──
export const configOps = meter.createCounter('station.config.operations', {
  description: 'App config read/write events',
});

export const configWatchRecovered = meter.createCounter(
  'station.config.watch_recovered',
  {
    description:
      'Config files the filesystem watcher never reported, recovered by the bounded post-ready reconciliation (attrs: event add/remove). Nonzero means the watcher arming gap fired in the wild.',
  },
);

export const configWatcherCloseDuration = meter.createHistogram(
  'station.config.watcher_close_duration_ms',
  {
    unit: 'ms',
    description:
      'Duration of the deferred config watcher close dispose() schedules (#956). A synchronous FSEvents teardown, moved off the app-quit path — recorded so the cost stays visible now that shutdown no longer pays it.',
  },
);

// ── SSE ──
export const sseOps = meter.createCounter('station.sse.operations', {
  description: 'SSE connection events',
});

// ── Insights ──
export const insightOps = meter.createCounter('station.insight.operations', {
  description: 'Insight query events',
});

// ── System ──
export const systemOps = meter.createCounter('station.system.operations', {
  description: 'System status/verify events',
});

export const sshEnvironmentOps = meter.createCounter(
  'station.ssh_environment.operations',
  {
    description:
      'SSH environment discovery, profile, connection, and recovery outcomes',
  },
);

export const sshEnvironmentConnectDuration = meter.createHistogram(
  'station.ssh_environment.duration',
  {
    description: 'SSH environment discovery and connection duration',
    unit: 'ms',
  },
);

// ── Web Push ──
export const webPushSubscriptions = meter.createCounter(
  'station.web_push.subscriptions',
  {
    description:
      'Web Push subscription lifecycle events by operation (subscribe/unsubscribe) and outcome',
  },
);
export const webPushSends = meter.createCounter('station.web_push.sends', {
  description:
    'Web Push send attempts by result (sent/gone/error), never includes payload or endpoint identity',
});

// ── Orchestration stream presence + push-on-completion (archive#1225) ──
/**
 * `/api/orchestration/events` connect/disconnect lifecycle, by op
 * (`connect`/`disconnect`) — backs `OrchestrationStreamPresence`'s
 * per-user live-subscriber count, which the push-on-completion gate below
 * queries to decide whether anyone is actually watching a session.
 */
export const orchestrationStreamPresenceOps = meter.createCounter(
  'station.orchestration.stream_presence_ops',
  {
    description:
      'Orchestration /events SSE connect/disconnect lifecycle events backing the per-user presence gate',
  },
);

/**
 * archive#4075 stage 3 slice 2: the bounded principal-roster retained
 * alongside the ref-counting above, by op (`retain`/`release`/`capacity`).
 * `capacity` is the operationally interesting signal — it fires only when
 * `OrchestrationStreamPresence`'s roster bound (mirroring
 * `ClientConnectionPresence`'s discipline) refused to track a NEW distinct
 * principal; it never means a real connection was refused (see that
 * class's docblock).
 */
export const orchestrationStreamPresenceRosterOps = meter.createCounter(
  'station.orchestration.stream_presence_roster_ops',
  {
    description:
      'Orchestration /events presence roster retain/release/capacity events, without principal identity',
  },
);

/** Aggregate-only lifecycle of paired-device primary event-stream presence. */
export const connectedClientPresenceOps = meter.createCounter(
  'station.connected_client_presence_ops',
  {
    description:
      'Paired-device event-stream presence lifecycle by operation, without device or session identity',
  },
);

/**
 * A turn's completion/abort notification-scheduling decision, by outcome
 * (`done`/`failed`, omitted for an `error` result) and gate result
 * (`scheduled` when nobody was watching, `skipped_connected` when the
 * owning user had a live stream open, `error` when the listener's own
 * defensive try/catch caught a throw — see `turn-completion-notifications.ts`).
 * Only a `scheduled` decision ever reaches `NotificationService.schedule`
 * (and, via the existing `wireWebPushDelivery` fan-out, a Web Push send).
 */
export const turnCompletionNotificationOps = meter.createCounter(
  'station.orchestration.turn_completion_notification_ops',
  {
    description:
      'Turn completion/failure push-notification scheduling decisions by outcome and gate result',
  },
);

/**
 * archive#2802: workspace checkpoint capture decisions at turn boundaries
 * (`baseline` on turn.started, `settle` on turn.completed/turn.aborted).
 * Outcome vocabulary mirrors the durable index records exactly —
 * `captured`, `not_applicable` (no project working directory),
 * `skipped` (typed repository reason such as unborn/detached HEAD, a
 * non-git directory, or a git timeout), `failed` (the capture layer
 * threw), and `duplicate` (a replayed boundary whose first observation
 * stands) — so a metric reading and the per-thread index records can never
 * disagree about what happened. See
 * `services/checkpoints/turn-checkpoint-capture.ts`.
 */
export const checkpointCaptureOps = meter.createCounter(
  'station.checkpoint.capture_ops',
  {
    description:
      'Workspace checkpoint capture decisions at turn boundaries by phase and outcome',
  },
);

/**
 * archive#1410: one data point per COMPLETED TURN, tagged with whether that
 * turn yielded a provenance envelope.
 *
 * Scoped to turn completion, not to message reads: counting per read made
 * the denominator "how often did a client refetch this transcript", so a
 * single well-correlated session polled fifty times swamped fifty
 * uncorrelated ones read once. Per turn, `absent` means exactly what it
 * sounds like — that engine's events could not be correlated into an
 * envelope — and the ratio is directly readable.
 */
export const turnProvenanceProjections = meter.createCounter(
  'station.orchestration.turn_provenance_projections',
  {
    description:
      'Completed turns by whether a turn provenance envelope could be assembled',
  },
);

// ── Answer shares (archive#1423) ──
/**
 * Deliberately carries `outcome` and nothing else. A share is a capability
 * over one specific turn, so a `sessionId`/`turnId`/`shareId` attribute would
 * put an identifier for a shared answer into a metrics pipeline that is
 * exported far more widely than the answer itself — the same privacy framing
 * `devicePairingRequests` uses for pairing sources.
 */
export const answerSharesMinted = meter.createCounter(
  'station.answer_share.minted',
  {
    description:
      'Answer-share mint attempts by outcome (minted / answer_not_found)',
  },
);

export const answerSharesRevoked = meter.createCounter(
  'station.answer_share.revoked',
  {
    description: 'Answer shares revoked by the operator',
  },
);

/**
 * The population that matters for the enumeration posture: a spike in
 * `share_not_found` is someone guessing tokens, and it is distinguishable
 * here precisely because the HTTP response deliberately is not.
 *
 * `answer_unavailable` and `content_digest_mismatch` (archive#1598) are one
 * HTTP refusal and two causes, separated here for the same reason: the wire
 * must not distinguish "the turn is gone" from "the shared words drifted",
 * and an operator must. Drift has a systemic cause — any change to the
 * projection the mint-time digest covers invalidates every recorded digest at
 * once — so without its own attribute a total outage is indistinguishable
 * from ordinary turn attrition.
 */
export const answerShareViews = meter.createCounter(
  'station.answer_share.views',
  {
    description:
      'Answer-share view attempts by outcome (served / share_not_found / share_revoked / share_expired / answer_unavailable / content_digest_mismatch)',
  },
);

/**
 * How often each channel-binding status is COMPUTED for a served share
 * (archive#1598). `status` is the only attribute, and the privacy rule above
 * is why: a `channelId`, `epoch`, `seq`, checkpoint digest, or share id here
 * would put an identifier for a shared answer — and for the channel it lives
 * in — into a metrics pipeline exported far more widely than the answer
 * itself. `channelId` is exactly the class that rule names.
 *
 * The population that matters is `coordinate_mismatch`: it is the only signal
 * that recorded bindings and served history have drifted apart, and drift
 * being VISIBLE is the reason the binding is recorded at mint rather than
 * derived at read.
 */
export const answerShareChannelStatuses = meter.createCounter(
  'station.answer_share.channel_status',
  {
    description:
      'Computed channel-binding status for served answer shares (reported_current / reported_superseded / not_in_channel / predates_channel_addressing / history_not_served / coordinate_mismatch)',
  },
);

// ── UI Commands ──
export const uiCommandOps = meter.createCounter(
  'station.uicommand.operations',
  {
    description: 'UI command execution events',
  },
);

// ── Logging (archive#1895) ──
export const serverLogStoreWriteErrors = meter.createCounter(
  'station.logs.store.write_errors',
  {
    description:
      'Server log store write failures (sink degraded to stdout-only)',
  },
);

export const serverLogStoreRetentionRemovedFiles = meter.createCounter(
  'station.logs.store.retention_removed_files',
  {
    description: 'Server log store files removed by age/size retention',
  },
);

export const serverLogsRead = meter.createCounter('station.logs.read', {
  description:
    'Server log read-path queries (station#1896 logging slice 2), by surface (route|tool)',
});

// archive#3677: the distinct-origin consent surface.
export const consentTransactionOps = meter.createCounter(
  'station.consent.transaction_ops',
  {
    description:
      'ConsentTransaction lifecycle outcomes (created|capacity|rate_limited|review_rendered) by target kind',
  },
);
export const consentDecisionOps = meter.createCounter(
  'station.consent.decision_ops',
  {
    description:
      'Consent-listener decision outcomes by result (approved|denied|refused) and refusal reason',
  },
);
export const consentListenerState = meter.createCounter(
  'station.consent.listener_state',
  {
    description:
      'Consent listener availability transitions (listening|unavailable)',
  },
);

export function registerObservableGauges(callbacks: {
  activeAgents: () => number;
  mcpConnections: () => number;
}): void {
  meter
    .createObservableGauge('station.agents.active', {
      description: 'Number of active agents',
    })
    .addCallback((obs) => obs.observe(callbacks.activeAgents()));

  meter
    .createObservableGauge('station.mcp.connections', {
      description: 'Number of MCP connections',
    })
    .addCallback((obs) => obs.observe(callbacks.mcpConnections()));
}
