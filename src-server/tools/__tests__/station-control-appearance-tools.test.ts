import { parseAppearanceProposalReference } from '@kontourai/station-contracts/custom-appearance';
import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, expect, test, vi } from 'vitest';
import { asStationControlCaller } from '../../__test-utils__/station-control-caller-fixture.js';
import { registerAppearanceTools } from '../station-control-appearance-tools.js';
import { StationControlToolRegistry } from '../station-control-mcp-server.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test('propose_appearance forwards visual controls and returns the server-bound proposal without forwarding a supplied Session', async () => {
  vi.stubEnv('STATION_API_BASE', 'http://appearance-tool.test');
  const visual = { panelOpacity: 0.8, radius: 12, fontSize: 16 };
  const appearance = {
    version: 1,
    name: 'Seaside',
    palette: {},
    css: '',
    visual,
  };
  const proposal = {
    id: 'a'.repeat(64),
    appearance,
    sourceSessionId: 'verified-session',
    proposedAt: '2026-11-17T00:00:00Z',
  };
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: { revision: 'r2', active: null, proposal, renderReport: null },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
  );
  vi.stubGlobal('fetch', fetch);
  const server = new McpServer({
    name: 'appearance-tool-test',
    version: '0.0.0',
  });
  registerAppearanceTools(new StationControlToolRegistry(server));
  const tools = (
    server as unknown as {
      _registeredTools: Record<
        string,
        {
          handler: (
            args: unknown,
          ) => Promise<{ content: { type: string; text: string }[] }>;
        }
      >;
    }
  )._registeredTools;
  const handlers = asStationControlCaller({
    propose: tools.propose_appearance!.handler,
  });
  const result = await handlers.propose!({
    revision: 'r1',
    name: 'Seaside',
    visual,
    sourceSessionId: 'agent-forged-session',
  });
  const request = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(request[0]).toBe(
    'http://appearance-tool.test/api/me/appearance/proposal',
  );
  expect(JSON.parse(String(request[1].body))).toEqual({
    revision: 'r1',
    appearance,
  });
  expect(
    parseAppearanceProposalReference(
      'station-control/propose_appearance',
      result,
    ),
  ).toEqual({
    id: proposal.id,
    name: 'Seaside',
    sourceSessionId: 'verified-session',
  });
});
