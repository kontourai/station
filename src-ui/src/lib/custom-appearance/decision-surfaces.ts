/**
 * Decision surfaces: UI where a person grants authority (approves a tool
 * call or permission, answers an agent's request, consents to a plugin,
 * pairs a device, reviews what is shared). While any is mounted, custom CSS
 * is switched off, so CSS an agent wrote cannot disguise, reorder or overlay
 * the control it would need the person to press
 * (docs/decisions/custom-appearance.md). The validated palette stays.
 *
 * Each owner calls {@link useDecisionSurface} with its id from
 * {@link DECISION_SURFACES}. Over-suspending costs convenience (custom CSS is
 * paused and a preview cannot be kept while any owner is mounted);
 * under-suspending is the failure, so a surface that might show a decision
 * registers whenever it might.
 */
import { useLayoutEffect } from 'react';

/** Every owner, by id. A test pins this list and renders each owner it can. */
export const DECISION_SURFACES = [
  // Tool, permission and input approvals
  'tool-approval-decision', // InputRequestDecision: DecisionButtons, DecisionActionRow
  'input-request-card', // InputRequestCard
  'input-request-url-card', // InputRequestUrlCard
  'exact-request-decision', // ExactRequestInline: ExactRequestDecisionRow
  'request-inspection-dialog', // RequestInspectionDialog
  'attention-approval-actions', // AttentionCard: ApprovalActions
  'permission-request-modal', // PermissionRequestModal
  'mcp-tool-call-approval', // MCPToolUIFrame: pending call confirm
  'approval-toast', // NotificationContainer: any notification with actions
  // Task and agent requests
  'peer-request-decision', // AttentionCard: PeerRequestDecisionActions
  'needs-input-reply', // NeedsInputReply
  'tool-requests-panel', // ToolRequestsPanel
  'terminal-run-decision', // TerminalRunNotes
  // Plugins and extensions
  'plugin-install-preview', // InstallPreviewModal
  'plugin-update-confirm', // PluginModalStack: update confirm
  'extensions-access-consent', // useStationExtensionsAccess confirm
  'integration-trust-review', // IntegrationTrustReview
  // Pairing and devices
  'device-pairing-review', // AttentionCard: DevicePairingActions
  'relay-device-enrollment', // RelayOperatorPanel: OperatorPanel, InviteDeviceDialog
  'relay-route-key-approval', // RelayRouteKeyApproval
  'browser-station-trust', // BrowserStationTrustApproval
  'share-answer-pairing', // ShareAnswerPairingPrompt
  // Sharing review
  'task-sharing', // ProjectTaskSharingControl
  'account-sharing', // AccountSharingSection: SharingControls
  'usage-sharing-prompt', // UsageSharingPrompt
  // Agent proposals
  'job-proposal', // AgentScheduleNotes: JobProposalCard
  'automation-proposal', // AgentScheduleNotes: AutomationProposalCard
  'check-back-approval', // AgentScheduleNotes: CheckBackApprovalCard
  'proposed-change', // ProposedChangeDetail, AttentionCard ProposedChangeActions, ReviewLayout
  'gate-exception', // AttentionCard: AcceptExceptionDialog
  // Standing grants a person sets
  'approval-mode', // ComposerModeSheet: approval mode and the full-access confirm
  'device-agent-control', // DeviceSetupWizard: allow agents to control devices
  'people-roles', // PeopleSection: roles and admin changes
  'integration-trust-settings', // IntegrationTrustSection
  'integration-editor', // IntegrationEditorPanel: allow render UI and trust controls
  'acp-session-mode', // AcpSessionModeSheet: applies an engine mode at once
  'account-approval-defaults', // AccountPreferencesSection: default approval modes
  'agent-approval-default', // AgentEditorApprovalDefault
  'memory-review', // MemoryReview: remember / don't remember
  'device-shares', // DeviceShares: sharing devices with Projects
  'access-tokens', // OwnAccessTokensPanel: personal access tokens
] as const;

export type DecisionSurfaceId = (typeof DECISION_SURFACES)[number];

const mounted = new Map<symbol, DecisionSurfaceId>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Register a mounted decision surface. Returns its release. */
export function holdDecisionSurface(id: DecisionSurfaceId): () => void {
  const token = Symbol(id);
  mounted.set(token, id);
  notify();
  return () => {
    if (mounted.delete(token)) notify();
  };
}

/** The ids mounted now, one entry per mount. */
export function mountedDecisionSurfaces(): DecisionSurfaceId[] {
  return [...mounted.values()];
}

export function decisionSurfaceMounted(): boolean {
  return mounted.size > 0;
}

export function subscribeDecisionSurfaces(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Hold custom CSS off while this component shows a decision. `active` lets
 * an owner that is always mounted register only while a decision is
 * pending. A layout effect, so the sheet is off before the browser paints
 * the decision; the release runs on unmount and when `active` turns false.
 */
export function useDecisionSurface(id: DecisionSurfaceId, active = true): void {
  useLayoutEffect(
    () => (active ? holdDecisionSurface(id) : undefined),
    [id, active],
  );
}
