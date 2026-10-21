// @vitest-environment jsdom

/**
 * station#3413 part B: a Session row shows what the Session says it is on.
 * The app's `WorkClaimsProvider` reads the Station's claims (`GET
 * /api/orchestration/work-claims`, answered here at the SDK's `getJson` seam
 * with the body the route produces) and the row draws one chip for its own
 * Session's claims only.
 */

import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FOLD_FIXTURES,
  FOLD_SESSION_CREATED_AT,
} from '../../../../../tests/helpers/session-summary-fold-fixtures';
import { WorkClaimsProvider } from '../../../contexts/WorkClaimsContext';
import { buildOrchestrationItems } from '../../../views/home/home-view-model';
import { buildWorkFacts } from '../../../views/home/work-facts';
import { InboxRow } from '../../chat-dock/ChatDockInboxRows';

const API_BASE = 'http://station.test';

vi.mock('../../../contexts/ApiBaseContext', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../contexts/ApiBaseContext')
  >()),
  useHostRequestAuthorityScope: () => ({
    apiBase: API_BASE,
    authorityKey: 'test-authority',
  }),
}));

const claimsBody = vi.hoisted(() => ({ current: [] as unknown[] }));
const requested = vi.hoisted(() => [] as string[]);
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  getJson: vi.fn(async (url: string) => {
    requested.push(url);
    // Every other read a row makes is answered as unavailable.
    if (!url.endsWith('/api/orchestration/work-claims'))
      return new Response(JSON.stringify({ success: false }), { status: 404 });
    return new Response(
      JSON.stringify({ success: true, data: { claims: claimsBody.current } }),
      { status: 200 },
    );
  }),
}));

const NOW = Date.parse('2026-09-30T10:01:15.000Z');

function rowItem() {
  const summary: OrchestrationSessionSummary = {
    provider: 'claude',
    threadId: 'T',
    status: 'running',
    createdAt: FOLD_SESSION_CREATED_AT,
    controlMode: 'station-owned',
    answerability: { answerable: true },
    isLoaded: true,
    isPersisted: true,
    eventCount: 2,
    displayTitle: 'Migrate sessions table',
    projectSlug: 'station',
    ...FOLD_FIXTURES.runningTool.summary,
    updatedAt: '2026-09-30T10:00:15.000Z',
  };
  const items = buildOrchestrationItems([summary], []);
  return {
    item: items[0]!,
    facts: buildWorkFacts({ items, sessions: [summary] }).get(items[0]!.id),
  };
}

/** A claim exactly as `workClaimView` answers it. */
const claim = (over: Record<string, unknown>) => ({
  claimId: `claim_${Math.random()}`,
  sessionId: 'T',
  scope: { kind: 'project', id: 'project-id' },
  claimedAt: '2026-09-30T10:00:00.000Z',
  renewedAt: '2026-09-30T10:00:00.000Z',
  expiresAt: '2026-09-30T10:30:00.000Z',
  ...over,
});

function renderRow() {
  const { item, facts } = rowItem();
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <WorkClaimsProvider>
        <InboxRow
          item={item}
          facts={facts}
          isCurrent={false}
          isSnoozed={false}
          isOpenChat={false}
          now={NOW}
          onActivate={vi.fn()}
          hoverCard={false}
        />
      </WorkClaimsProvider>
    </QueryClientProvider>,
  );
}

describe('a Session row shows its claims (#3413 B)', () => {
  afterEach(() => {
    cleanup();
    requested.length = 0;
    claimsBody.current = [];
  });

  it('draws one chip for the Session’s own claims, the newest first, with the note on hover', async () => {
    claimsBody.current = [
      claim({
        workItemRef: 'kontourai/station#3413',
        note: 'writing the claim tests',
      }),
      claim({ paths: ['src/a.ts', 'src/b.ts'] }),
      // Another Session's claim is not this row's.
      claim({ sessionId: 'OTHER', workItemRef: 'OTHER-CLAIM' }),
    ];
    renderRow();
    const chip = await screen.findByText('On kontourai/station#3413 +1');
    const chipElement = chip.closest('[data-chip="claim"]') as HTMLElement;
    expect(chipElement).not.toBeNull();
    expect(chipElement.title.split('\n')).toEqual([
      expect.stringMatching(
        /^Claimed: kontourai\/station#3413 — writing the claim tests \(until .+\)$/,
      ),
      expect.stringMatching(/^Claimed: src\/a\.ts \+1 \(until .+\)$/),
    ]);
    expect(
      within(screen.getByTestId('inbox-row')).queryByText(/OTHER-CLAIM/),
    ).toBeNull();
    expect(requested).toContain(`${API_BASE}/api/orchestration/work-claims`);
  });

  it('a Session claimed through its conversation shows the claim; none draws no chip', async () => {
    claimsBody.current = [
      claim({
        sessionId: 'T:session:old',
        conversationId: 'T',
        workItemRef: '#9',
      }),
    ];
    const view = renderRow();
    expect(await screen.findByText('On #9')).toBeDefined();
    view.unmount();
    claimsBody.current = [];
    renderRow();
    // The read answered: the row has no claim chip line for it.
    await vi.waitFor(() =>
      expect(
        requested.filter((url) => url.endsWith('/work-claims')).length,
      ).toBeGreaterThanOrEqual(2),
    );
    expect(document.querySelector('[data-chip="claim"]')).toBeNull();
  });
});
