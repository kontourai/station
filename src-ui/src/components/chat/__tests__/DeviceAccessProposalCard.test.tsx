// @vitest-environment jsdom
import type { DeviceAccessProposal } from '@kontourai/station-contracts/device-toolchain';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import {
  authorizeScope,
  click,
  renderInQueryClient,
} from '../../../workspace-panes/__tests__/deviceWorkspacePaneHarness';
import { ConversationConnectionProvider } from '../../conversation/ConversationConnectionContext';
import { ToolCallDisplay } from '../ToolCallDisplay';

const SCOPE = {
  apiBase: 'http://device-approval.test',
  authorityKey: 'operator',
  isCurrent: () => true,
};
const ID = '8d3ebdcf-2169-48ca-973c-00145b44a7a1';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setClientCredentialResolver(undefined);
});

test.each([
  ['Allow and install', 'approve', 'approved', 'codex'],
  ['Decline', 'decline', 'declined', 'mcp'],
] as const)(
  'the chat card submits %s only after the operator clicks',
  async (label, decision, settled, engine) => {
    authorizeScope(SCOPE);
    const proposal: DeviceAccessProposal = {
      id: ID,
      state: 'pending',
      version: '0.21.12',
      expiresAt: Date.now() + 60_000,
    };
    const decisions: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          `${SCOPE.apiBase}/api/mobile-devices/toolchain/agent-access-proposals/${ID}`,
        );
        if (init?.method === 'POST') {
          decisions.push(JSON.parse(String(init.body)));
          proposal.state = settled;
        }
        return Response.json({ success: true, data: proposal });
      }),
    );
    const text = JSON.stringify({ ok: true, proposal });
    renderInQueryClient(
      <ConversationConnectionProvider
        value={{ apiBase: SCOPE.apiBase, requestScope: SCOPE }}
      >
        <ToolCallDisplay
          toolCall={{
            type: 'tool-invocation',
            toolName:
              engine === 'codex'
                ? 'request_device_agent_access'
                : 'station-control/request_device_agent_access',
            output:
              engine === 'codex'
                ? [{ type: 'inputText', text }]
                : { content: [{ type: 'text', text }] },
          }}
        />
      </ConversationConnectionProvider>,
    );
    const button = await screen.findByRole('button', { name: label });
    expect(
      screen.getByText(
        /control simulators and emulators.*agent-device 0\.21\.12 from npm/,
      ),
    ).toBeTruthy();
    expect(decisions).toEqual([]);
    await click(button);
    expect(await screen.findByText(`Device access ${settled}`)).toBeTruthy();
    expect(decisions).toEqual([{ decision }]);
  },
);
