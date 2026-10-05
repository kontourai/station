/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { ToolCallDisplay } from '../../ToolCallDisplay';
import { splitToolCallRuns } from '../../tool-call-runs';
import {
  describeStationControlCall,
  hasStationControlCallRow,
} from '../station-control-calls';

afterEach(cleanup);

const args = {
  sessionId: 'recipient',
  text: 'hello',
  mode: 'auto',
  requestKey: 'request-key-1',
};
const call = (extra: Record<string, unknown> = {}) => ({
  type: 'tool-invocation',
  toolCallId: 'c1',
  toolName: 'mcp__station-control__send_to_session',
  args,
  ...extra,
});

describe('which calls get the sent-to row', () => {
  test.each([
    'mcp__station-control__send_to_session',
    'station-control_send_to_session',
    'station-control.send_to_session',
    'station-control/send_to_session',
  ])('%s is Station Control’s send_to_session', (toolName) => {
    expect(hasStationControlCallRow(call({ toolName }))).toBe(true);
  });

  test('another server’s tool of the same name is not dressed up as a Session message', () => {
    expect(
      hasStationControlCallRow(
        call({ toolName: 'mcp__other-server__send_to_session' }),
      ),
    ).toBe(false);
    expect(
      hasStationControlCallRow(
        call({ toolName: 'send_to_session', server: 'other-server' }),
      ),
    ).toBe(false);
    // A bare name counts only with the call's own argument shape.
    expect(
      hasStationControlCallRow(
        call({ toolName: 'send_to_session', args: { to: 'someone' } }),
      ),
    ).toBe(false);
    expect(
      hasStationControlCallRow(call({ toolName: 'send_to_session' })),
    ).toBe(true);
    expect(hasStationControlCallRow(call({ toolName: 'send_message' }))).toBe(
      false,
    );
  });

  test('every send is its own run, never folded into a batch of other calls', () => {
    const read = { type: 'tool-invocation', toolCallId: 'r', toolName: 'read' };
    const blocks = splitToolCallRuns([
      read,
      call({ toolCallId: 'a' }),
      call({ toolCallId: 'b' }),
      read,
    ]);
    expect(
      blocks.map((block) =>
        block.type === 'tool-call-run' ? block.calls.length : 0,
      ),
    ).toEqual([1, 1, 1, 1]);
  });
});

describe('what the result says', () => {
  const answer = (body: unknown) => [
    { type: 'text', text: JSON.stringify(body, null, 2) },
  ];

  test.each([
    ['content blocks', (body: unknown) => answer(body)],
    ['the text itself', (body: unknown) => JSON.stringify(body, null, 2)],
    ['a content wrapper', (body: unknown) => ({ content: answer(body) })],
  ])('reads a started send out of %s', (_shape, wrap) => {
    expect(
      describeStationControlCall(
        call({
          result: wrap({
            success: true,
            data: { outcome: 'started', sessionId: 'resolved-session' },
          }),
        }),
      ),
    ).toMatchObject({
      outcome: 'started',
      targetSessionId: 'resolved-session',
      requestKey: 'request-key-1',
      text: 'hello',
    });
  });

  test('refusals, an unconfirmed delivery and a failed call are each said as what they are', () => {
    const outcome = (result: unknown, extra: Record<string, unknown> = {}) =>
      describeStationControlCall(call({ result, ...extra }))?.outcome;
    expect(outcome(answer({ success: false, code: 'no_active_turn' }))).toBe(
      'refused',
    );
    expect(
      outcome(answer({ success: false, code: 'delivery_indeterminate' })),
    ).toBe('unconfirmed');
    expect(outcome(undefined)).toBe('sending');
    expect(outcome(undefined, { state: 'error', error: 'boom' })).toBe(
      'refused',
    );
    // A result that is not the route's JSON is not claimed as a delivery.
    expect(outcome('some text')).toBe('unconfirmed');
  });
});

describe('a send waiting on a grant keeps its approval row', () => {
  test('so Allow and Deny are still there, and "Sent to" is not claimed yet', () => {
    render(
      <ToolCallDisplay
        toolCall={call({
          needsApproval: true,
          approvalId: 'approval-1',
          state: 'awaiting-approval',
        })}
        onApprove={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: 'Allow Once' })).toBeTruthy();
    expect(document.querySelector('.agent-outgoing')).toBeNull();
  });
});
