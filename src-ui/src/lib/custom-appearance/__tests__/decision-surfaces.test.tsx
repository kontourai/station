/** @vitest-environment jsdom */

import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { DecisionButtons } from '../../../components/chat/InputRequestDecision';
import { InputRequestUrlCard } from '../../../components/chat/InputRequestUrlCard';
import { PermissionRequestModal } from '../../../components/modals/PermissionRequestModal';
import { ProposedChangeDetail } from '../../../components/review/ProposedChangeDetail';
import {
  decisionSurfaceMounted,
  holdDecisionSurface,
  mountedDecisionSurfaces,
} from '../decision-surfaces';

/**
 * Registration is proven by rendering an owner and reading the registry, here
 * for owners that render without app context, and in each owner's own suite
 * otherwise (ApprovalModeChip, AgentSchedule, AttentionCard, ReviewLayout,
 * TerminalRunNotes, NeedsInputReply, ExactRequestInline, NotificationContainer
 * decision-surface, AccountPreferencesSection, AgentEditorApprovalDefault,
 * MemoryReview, PeopleSection). There is deliberately no test comparing
 * `DECISION_SURFACES` to a copied list: that only re-states the constant.
 * Owners not rendered anywhere are listed in docs/decisions/custom-appearance.md.
 */

afterEach(() => {
  expect(decisionSurfaceMounted()).toBe(false);
});

describe('decision surfaces', () => {
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
