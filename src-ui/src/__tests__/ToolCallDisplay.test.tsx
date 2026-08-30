/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ToolCallDisplay } from '../components/chat/ToolCallDisplay';

// archive#3091 / archive#3117: the rendered end of the carrying seam. `ToolCallData`
// here is exactly the flat `tool-invocation` shape the LIVE orchestration
// path produces (`handleToolCompletedEvent`, src-ui/src/hooks/orchestration/
// streamHandlers.ts) and the durable rehydration projection reconstructs
// (`runtime-event-projection.ts`) — these props are not a fabricated
// shortcut, they mirror what actually reaches this component both live and
// after a reload. (Previously cited ToolLifecycleHandler.test.ts, which
// tested a handler with no production caller — see archive#3117.)

describe('ToolCallDisplay — policy-denied state (station#3091, #3117)', () => {
  test('renders a distinct, labelled "Blocked by Station" badge naming the reason', () => {
    const reason =
      "Tool 'write_file' was blocked by the config-protection policy: writes require review";
    render(
      <ToolCallDisplay
        toolCall={{
          type: 'tool-invocation',
          toolCallId: 't1',
          toolName: 'write_file',
          approvalStatus: 'policy-denied',
          error: reason,
        }}
      />,
    );

    const badge = screen.getByText('Blocked by Station');
    expect(badge).toBeTruthy();
    expect(badge.className).toContain('tool-call__status-badge--warning');
    // The reason is surfaced in the expandable error details section, the
    // same mechanism every tool error already uses. The collapsed row itself
    // is the disclosure button (archive#2652 redesign).
    fireEvent.click(document.querySelector('button.tool-call__line')!);
    expect(screen.getByText(reason)).toBeTruthy();
  });

  test('policy-denied and user-denied render visually and semantically distinct badges', () => {
    const { unmount } = render(
      <ToolCallDisplay
        toolCall={{
          type: 'tool-invocation',
          toolCallId: 't1',
          toolName: 'write_file',
          approvalStatus: 'policy-denied',
          error: 'blocked by policy',
        }}
      />,
    );
    const policyBadge = screen.getByText('Blocked by Station');
    expect(screen.queryByText('User denied')).toBe(null);
    unmount();

    render(
      <ToolCallDisplay
        toolCall={{
          type: 'tool-invocation',
          toolCallId: 't2',
          toolName: 'write_file',
          approvalStatus: 'user-denied',
        }}
      />,
    );
    const userBadge = screen.getByText('User denied');
    expect(screen.queryByText('Blocked by Station')).toBe(null);

    // Different label text and different modifier class — not the same
    // rendering with different words.
    expect(userBadge.className).not.toBe(policyBadge.className);
    expect(userBadge.className).toContain('tool-call__status-badge--error');
  });

  test('user-denied behaviour is unchanged (station#3091 does not weaken it)', () => {
    render(
      <ToolCallDisplay
        toolCall={{
          type: 'tool-invocation',
          toolCallId: 't1',
          toolName: 'fs_write',
          approvalStatus: 'user-denied',
        }}
      />,
    );

    const badge = screen.getByText('User denied');
    expect(badge.className).toBe(
      'tool-call__status-badge tool-call__status-badge--error',
    );
  });

  // Negative control: a call with genuinely unknown approval state (no
  // approvalStatus at all — the ordinary, ungated case) renders no badge.
  test('a call with no approvalStatus renders no approval badge', () => {
    render(
      <ToolCallDisplay
        toolCall={{
          type: 'tool-invocation',
          toolCallId: 't1',
          toolName: 'read_file',
          result: { ok: true },
        }}
      />,
    );

    expect(screen.queryByText('Blocked by Station')).toBe(null);
    expect(screen.queryByText('User denied')).toBe(null);
    expect(screen.queryByText('User approved')).toBe(null);
    expect(screen.queryByText('Auto-approved')).toBe(null);
  });

  // archive#3113: an ordinary (non-policy) failed tool call — `error` set,
  // no `approvalStatus` at all. Negative control for the marker AND the
  // positive assertion for archive#3113's "renders as failed" AC: a visible
  // "Failed" flag WITHOUT expanding (archive#2652 redesign — a reader must
  // never have to open a row to learn the call went wrong), no success
  // claim, and no policy-denied badge (an ordinary failure must never read
  // as a policy verdict it never received).
  test('an ordinary failed tool call (error set, no approvalStatus) shows a collapsed Failed flag and no policy badge', () => {
    render(
      <ToolCallDisplay
        toolCall={{
          type: 'tool-invocation',
          toolCallId: 't1',
          toolName: 'write_file',
          error: 'Tool call failed.',
        }}
      />,
    );

    expect(screen.queryByText('Blocked by Station')).toBe(null);
    const failedFlag = screen.getByText('Failed');
    expect(failedFlag.className).toContain('tool-call__status-badge--error');
    // Visible in the COLLAPSED row: no details panel is open.
    expect(document.querySelector('.tool-call__details')).toBe(null);
    expect(screen.queryByText('Success')).toBe(null);
  });
});

describe('ToolCallDisplay — bounded result cost (station#330)', () => {
  test('renders a multi-MB object through a bounded head/tail projection and serializes it fully only on demand', () => {
    const result = {
      output: 'h'.repeat(2 * 1024 * 1024),
      end: 'SELECTABLE_END',
    };
    const stringify = vi.spyOn(JSON, 'stringify');
    render(
      <ToolCallDisplay
        toolCall={{
          type: 'tool-invocation',
          toolCallId: 'bounded-result',
          toolName: 'search_files',
          result,
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /search files/i }));
    const response = document.querySelector('.tool-call__code--scrollable')!;
    expect(response.textContent?.length).toBeLessThan(4_000);
    expect(response.textContent).toContain('2.0 MB withheld');
    expect(response.textContent).toContain('SELECTABLE_END');
    expect(stringify).not.toHaveBeenCalledWith(result, null, 2);

    fireEvent.click(screen.getByRole('button', { name: 'Show full result' }));
    expect(response.textContent?.length).toBeGreaterThan(2 * 1024 * 1024);
    expect(stringify).toHaveBeenCalledWith(result, null, 2);
  });

  test('mounting many tool cards adds no document listeners', () => {
    const warmup = render(<div />);
    warmup.unmount();
    const addDocumentListener = vi.spyOn(document, 'addEventListener');

    render(
      Array.from({ length: 50 }, (_, index) => (
        <ToolCallDisplay
          key={index}
          toolCall={{
            type: 'tool-invocation',
            toolCallId: `listener-${index}`,
            toolName: 'read_file',
            result: 'done',
          }}
        />
      )),
    );

    expect(addDocumentListener).not.toHaveBeenCalled();
  });
});

describe('ToolCallDisplay — quiet activity row (station#2652 redesign)', () => {
  test('a settled successful call reads as one quiet verb-first line with no status noise', () => {
    render(
      <ToolCallDisplay
        toolCall={{
          type: 'tool-invocation',
          toolCallId: 't1',
          toolName: 'shell_exec',
          args: { command: 'npm run build:ui' },
          result: 'built',
          state: 'completed',
        }}
      />,
    );

    const row = screen.getByRole('button', { name: 'Ran npm run build:ui' });
    expect(row.getAttribute('aria-expanded')).toBe('false');
    // Success claims nothing collapsed — no badge, no raw internal state.
    expect(screen.queryByText('completed')).toBe(null);
    expect(screen.queryByText('Success')).toBe(null);
    expect(document.querySelector('.tool-call__pulse')).toBe(null);
  });

  test('expanding a settled call shows the truthful terminal status footer', () => {
    render(
      <ToolCallDisplay
        toolCall={{
          type: 'tool-invocation',
          toolCallId: 't1',
          toolName: 'shell_exec',
          args: { command: 'npm test' },
          result: 'ok',
          state: 'completed',
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Ran npm test' }));
    const footer = document.querySelector('.tool-call__status-footer');
    expect(footer?.textContent).toBe('✓ Success');
  });

  // archive#3690: this used `read_file`, whose past tense and bare
  // infinitive are both "Read" — so it could not tell a truthful label from an
  // overclaiming one. `shell_exec` discriminates ("Ran" vs "Run").
  test('an unresolved call (started, no terminal event) claims neither completion nor a terminal status', () => {
    render(
      <ToolCallDisplay
        toolCall={{
          type: 'tool-invocation',
          toolCallId: 't1',
          toolName: 'shell_exec',
          args: { command: 'npm test' },
          state: 'call',
        }}
      />,
    );

    // The transcript saw this call START and never saw it end. "Ran npm test"
    // would assert a completion nothing observed.
    const row = screen.getByRole('button', { name: /npm test/ });
    expect(document.querySelector('.tool-call__label')?.textContent).toBe(
      'Run npm test',
    );
    // …and it is not left looking like a settled success either: the row says
    // what is actually true about it.
    expect(screen.getByText('No result recorded')).toBeTruthy();

    fireEvent.click(row);
    // No terminal outcome was observed, so no status footer is invented.
    expect(document.querySelector('.tool-call__status-footer')).toBe(null);
    expect(screen.queryByText('Success')).toBe(null);
    expect(screen.queryByText('Failed')).toBe(null);
  });

  // The two claims the old `done` fallback made, each using `write_file` so
  // past tense and infinitive differ — a denial must never borrow the
  // completed verb.
  test('a user-denied call never claims the work happened', () => {
    render(
      <ToolCallDisplay
        toolCall={{
          type: 'tool-invocation',
          toolCallId: 't-denied',
          toolName: 'write_file',
          args: { path: '/tmp/config.json' },
          needsApproval: false,
          cancelled: true,
          approvalStatus: 'user-denied',
        }}
      />,
    );

    expect(document.querySelector('.tool-call__label')?.textContent).toBe(
      'Edit config.json',
    );
    expect(screen.getByText('User denied')).toBeTruthy();
    // The badge is the outcome; the verb must not contradict it.
    expect(screen.queryByText('Edited config.json')).toBe(null);
  });

  test('a Station-blocked call never claims the work happened', () => {
    render(
      <ToolCallDisplay
        toolCall={{
          type: 'tool-invocation',
          toolCallId: 't-policy',
          toolName: 'write_file',
          args: { path: '/tmp/config.json' },
          state: 'error',
          approvalStatus: 'policy-denied',
        }}
      />,
    );

    expect(document.querySelector('.tool-call__label')?.textContent).toBe(
      'Edit config.json',
    );
    expect(screen.getByText('Blocked by Station')).toBeTruthy();
  });

  test('a running call uses the progressive verb and a pulse, never a raw state string', () => {
    render(
      <ToolCallDisplay
        toolCall={{
          type: 'tool-invocation',
          toolCallId: 't1',
          toolName: 'shell_exec',
          args: { command: 'npm test' },
          state: 'running',
          progressMessage: 'running suite',
        }}
      />,
    );

    expect(screen.getByText('Running npm test')).toBeTruthy();
    expect(document.querySelector('.tool-call__pulse')).toBeTruthy();
    expect(screen.queryByText('running', { exact: true })).toBe(null);
    expect(screen.getByText('running suite')).toBeTruthy();
  });

  test('a cancelled call discloses Cancelled collapsed, distinct from Failed', () => {
    render(
      <ToolCallDisplay
        toolCall={{
          type: 'tool-invocation',
          toolCallId: 't1',
          toolName: 'shell_exec',
          args: { command: 'sleep 100' },
          state: 'cancelled',
        }}
      />,
    );

    expect(screen.getByText('Cancelled')).toBeTruthy();
    expect(screen.queryByText('Failed')).toBe(null);
  });

  test('a call awaiting approval is labelled as PROPOSED work, with its approval buttons inline', () => {
    const onApprove = vi.fn();
    render(
      <ToolCallDisplay
        toolCall={{
          type: 'tool-invocation',
          toolCallId: 't1',
          toolName: 'protected_write',
          args: { path: 'approved.txt' },
          needsApproval: true,
          approvalId: 'a1',
        }}
        onApprove={onApprove}
      />,
    );

    // Bare infinitive — past tense would claim work that has not happened.
    expect(screen.getByText('Edit approved.txt')).toBeTruthy();
    expect(screen.queryByText('Edited approved.txt')).toBe(null);
    fireEvent.click(screen.getByRole('button', { name: 'Allow Once' }));
    expect(onApprove).toHaveBeenCalledWith('once');
  });
});
