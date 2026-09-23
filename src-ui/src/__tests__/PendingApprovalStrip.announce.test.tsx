/**
 * @vitest-environment jsdom
 *
 * #2344: a request that joins the "Approvals waiting on you" strip is
 * announced to screen-reader users through a polite live region, once.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PendingApprovalStrip } from '../components/chat/PendingApprovalStrip';
import type { PendingApprovalRequest } from '../hooks/orchestration/pendingRequestRows';

/** The shape `unansweredApprovalRequests` builds for the strip. */
function request(
  requestId: string,
  toolName: string | undefined,
  title = 'Allow tool',
): PendingApprovalRequest {
  return {
    type: 'tool-invocation',
    toolCallId: `request:${requestId}`,
    ...(toolName ? { toolName } : { name: title }),
    state: 'awaiting-approval',
    needsApproval: true,
    approvalId: requestId,
    approvalThreadId: 'child-thread',
    approvalEventId: `evt-${requestId}`,
  };
}

const onApprove = vi.fn(async () => 'answered' as const);

function strip(requests: PendingApprovalRequest[]) {
  return <PendingApprovalStrip requests={requests} onApprove={onApprove} />;
}

/** The polite live region, which must be in the DOM before anything waits. */
function liveRegion() {
  const region = screen.getByRole('status', {
    name: 'Approval announcements',
  });
  expect(region.getAttribute('aria-live')).toBe('polite');
  return region;
}

afterEach(cleanup);

describe('PendingApprovalStrip announcements (#2344)', () => {
  test('the live region exists while nothing waits, and says nothing', () => {
    render(strip([]));
    expect(liveRegion().textContent).toBe('');
    expect(
      screen.queryByRole('region', { name: 'Approvals waiting on you' }),
    ).toBeNull();
  });

  test('a newly pending request is announced once, not on every re-render', () => {
    const { rerender } = render(strip([]));
    rerender(strip([request('req-1', 'Bash')]));
    expect(liveRegion().textContent).toBe('Approval needed: Bash');
    const announced = liveRegion().firstElementChild;

    // A new array holding the same request: nothing new to say, and the
    // announced node is left alone (a replaced node is re-read).
    rerender(strip([request('req-1', 'Bash')]));
    rerender(strip([request('req-1', 'Bash')]));
    expect(liveRegion().firstElementChild).toBe(announced);
    expect(liveRegion().textContent).toBe('Approval needed: Bash');
  });

  test('a second request is announced by itself; the first is not repeated', () => {
    const { rerender } = render(strip([]));
    rerender(strip([request('req-1', 'Bash')]));
    rerender(
      strip([
        request('req-1', 'Bash'),
        request('req-2', 'mcp__station-control__list_agents'),
      ]),
    );
    expect(liveRegion().textContent).toBe(
      'Approval needed: station-control.list_agents',
    );
  });

  test('two requests for the same tool in a row are both heard', () => {
    const { rerender } = render(strip([]));
    rerender(strip([request('req-1', 'Bash')]));
    const first = liveRegion().firstElementChild;
    rerender(strip([]));
    rerender(strip([request('req-2', 'Bash')]));
    // Same words, but a new node: an unchanged text node is not re-read.
    expect(liveRegion().textContent).toBe('Approval needed: Bash');
    expect(liveRegion().firstElementChild).not.toBe(first);
  });

  test('requests that arrive together are announced together', () => {
    const { rerender } = render(strip([]));
    rerender(
      strip([
        request('req-1', 'Bash'),
        request('req-2', undefined, 'rm -rf x'),
      ]),
    );
    expect(liveRegion().textContent).toBe('2 approvals needed: Bash, rm -rf x');
  });

  test('requests already waiting when the strip mounts are not announced', () => {
    // Opening a chat, loading history, or a remount: nothing new arrived.
    const { rerender } = render(
      strip([request('req-1', 'Bash'), request('req-2', 'Write')]),
    );
    expect(liveRegion().textContent).toBe('');
    rerender(strip([request('req-1', 'Bash'), request('req-2', 'Write')]));
    expect(liveRegion().textContent).toBe('');

    // One that arrives after the mount is.
    rerender(
      strip([
        request('req-1', 'Bash'),
        request('req-2', 'Write'),
        request('req-3', 'Edit'),
      ]),
    );
    expect(liveRegion().textContent).toBe('Approval needed: Edit');
  });

  test('requests the event window loads before it settles are not announced', () => {
    const settle = (requests: PendingApprovalRequest[], settled: boolean) => (
      <PendingApprovalStrip
        requests={requests}
        settled={settled}
        onApprove={onApprove}
      />
    );
    const { rerender } = render(settle([], false));
    rerender(settle([request('req-1', 'Bash')], false));
    expect(liveRegion().textContent).toBe('');
    // The render that settles the window still carries history.
    rerender(
      settle([request('req-1', 'Bash'), request('req-2', 'Write')], true),
    );
    expect(liveRegion().textContent).toBe('');
    rerender(
      settle(
        [
          request('req-1', 'Bash'),
          request('req-2', 'Write'),
          request('req-3', 'Edit'),
        ],
        true,
      ),
    );
    expect(liveRegion().textContent).toBe('Approval needed: Edit');
  });
});
