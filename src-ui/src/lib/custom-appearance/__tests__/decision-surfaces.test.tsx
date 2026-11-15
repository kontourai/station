/** @vitest-environment jsdom */

import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { DecisionButtons } from '../../../components/chat/InputRequestDecision';
import { InputRequestUrlCard } from '../../../components/chat/InputRequestUrlCard';
import { PermissionRequestModal } from '../../../components/modals/PermissionRequestModal';
import { ProposedChangeDetail } from '../../../components/review/ProposedChangeDetail';
import {
  DECISION_SURFACES,
  decisionSurfaceMounted,
  holdDecisionSurface,
  mountedDecisionSurfaces,
} from '../decision-surfaces';

/**
 * The decision surfaces, pinned here independently of the registry: removing
 * an owner from `DECISION_SURFACES` (or adding one) must change this list on
 * purpose. Each row names the component that registers it; the rows marked
 * `rendered` are also mounted below (or, for the attention owners, in their
 * own suites), which is what proves the owner registers. The others are
 * registered by a one-line hook call that no test mounts yet (the decision
 * record lists them as not verified by a render).
 */
const PINNED: readonly [string, string][] = [
  ['tool-approval-decision', 'InputRequestDecision (rendered)'],
  ['input-request-card', 'InputRequestCard'],
  ['input-request-url-card', 'InputRequestUrlCard (rendered)'],
  ['exact-request-decision', 'ExactRequestInline (rendered in its suite)'],
  ['request-inspection-dialog', 'RequestInspectionDialog'],
  ['attention-approval-actions', 'AttentionCard ApprovalActions'],
  ['permission-request-modal', 'PermissionRequestModal (rendered)'],
  ['mcp-tool-call-approval', 'MCPToolUIFrame'],
  ['approval-toast', 'NotificationContainer'],
  ['peer-request-decision', 'AttentionCard PeerRequestDecisionActions'],
  ['needs-input-reply', 'NeedsInputReply (rendered in its suite)'],
  ['tool-requests-panel', 'ToolRequestsPanel'],
  ['terminal-run-decision', 'TerminalRunNotes (rendered in its suite)'],
  ['plugin-install-preview', 'InstallPreviewModal'],
  ['plugin-update-confirm', 'PluginModalStack'],
  ['extensions-access-consent', 'useStationExtensionsAccess'],
  ['integration-trust-review', 'IntegrationTrustReview'],
  [
    'device-pairing-review',
    'AttentionCard DevicePairingActions (rendered in its suite)',
  ],
  ['relay-device-enrollment', 'RelayOperatorPanel'],
  ['relay-route-key-approval', 'RelayRouteKeyApproval'],
  ['browser-station-trust', 'BrowserStationTrustApproval'],
  ['share-answer-pairing', 'ShareAnswerPairingPrompt'],
  ['task-sharing', 'ProjectTaskSharingControl'],
  ['account-sharing', 'AccountSharingSection'],
  ['usage-sharing-prompt', 'UsageSharingPrompt'],
  [
    'job-proposal',
    'AgentScheduleNotes JobProposalCard (rendered in its suite)',
  ],
  [
    'automation-proposal',
    'AgentScheduleNotes AutomationProposalCard (rendered in its suite)',
  ],
  [
    'check-back-approval',
    'AgentScheduleNotes CheckBackApprovalCard (rendered in its suite)',
  ],
  [
    'proposed-change',
    'ProposedChangeDetail (rendered), ReviewLayout (rendered in its suite), AttentionCard',
  ],
  ['gate-exception', 'AttentionCard AcceptExceptionDialog'],
];

afterEach(() => {
  expect(decisionSurfaceMounted()).toBe(false);
});

describe('decision surfaces', () => {
  test('the registry is exactly the pinned list', () => {
    expect([...DECISION_SURFACES]).toEqual(PINNED.map(([id]) => id));
  });

  test('a hold is counted per mount and released once', () => {
    const a = holdDecisionSurface('job-proposal');
    const b = holdDecisionSurface('job-proposal');
    expect(mountedDecisionSurfaces()).toEqual(['job-proposal', 'job-proposal']);
    a();
    a();
    expect(mountedDecisionSurfaces()).toEqual(['job-proposal']);
    b();
  });

  const owners: [string, () => ReactElement][] = [
    [
      'permission-request-modal',
      () => (
        <PermissionRequestModal
          request={{ pluginName: 'demo', permissions: [] }}
          onApprove={() => undefined}
          onDeny={() => undefined}
        />
      ),
    ],
    [
      'tool-approval-decision',
      () => (
        <DecisionButtons
          body={{
            kind: 'decision',
            options: [
              { id: 'deny', label: 'Deny', effect: 'deny', scope: 'once' },
              {
                id: 'once',
                label: 'Allow once',
                effect: 'allow',
                scope: 'once',
              },
            ],
          }}
          busy={false}
          onChoose={() => undefined}
        />
      ),
    ],
    [
      'input-request-url-card',
      () => (
        <InputRequestUrlCard
          request={
            {
              schema: 'station.input-request/v1',
              source: 'mcp:remote',
              requester: 'remote',
              message: 'Sign in.',
              body: {
                kind: 'url',
                url: 'https://auth.example.com/',
                purpose: 'mcp-sign-in',
              },
            } as never
          }
          onRespond={async () => undefined}
        />
      ),
    ],
    [
      'proposed-change',
      () => (
        <ProposedChangeDetail
          change={
            {
              id: 'c1',
              status: 'pending',
              changeType: 'modify',
              contentKind: 'text',
              path: 'README.md',
              projectId: 'demo',
              sessionId: 's1',
              sourceRuntime: 'fixture',
              createdAt: '2026-01-01T00:00:00.000Z',
              baseSnapshot: 'before',
              proposedSnapshot: 'after',
            } as never
          }
          pending={false}
          onApprove={() => undefined}
          onReject={() => undefined}
        />
      ),
    ],
  ];

  test.each(owners)(
    '%s registers while mounted and releases on unmount',
    (id, element) => {
      const view = render(element());
      expect(mountedDecisionSurfaces()).toContain(id);
      view.unmount();
      expect(mountedDecisionSurfaces()).not.toContain(id);
    },
  );
});
