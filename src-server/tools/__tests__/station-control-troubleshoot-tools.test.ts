/**
 * #4470: the Station Assistant's troubleshooting tools. The draft tool's link
 * is parsed with `URL` so the template, field ids and redaction are asserted
 * on what GitHub would receive, not on string fragments.
 */
import {
  MAX_TROUBLESHOOT_ISSUE_URL_LENGTH,
  TROUBLESHOOT_REPORT_FIELD_IDS,
} from '@kontourai/station-contracts/troubleshoot';
import { TROUBLESHOOT_PLAYBOOK } from '@kontourai/station-shared/troubleshoot-playbook';
import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, test } from 'vitest';
import { asStationControlCaller } from '../../__test-utils__/station-control-caller-fixture.js';
import { SC_AUTO_APPROVED_TOOLS } from '../../runtime/tools/runtime-control-tools.js';
import { builtinStationAgentSpec } from '../../services/orchestration/session-agent-resolution.js';
import {
  StationControlToolRegistry,
  stationControlToolCatalog,
} from '../station-control-mcp-server.js';
import { registerTroubleshootTools } from '../station-control-troubleshoot-tools.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};
type ToolHandler = (...args: any[]) => Promise<ToolResult>;

function tools(): Record<string, ToolHandler> {
  const server = new McpServer({ name: 'troubleshoot-tools', version: '0' });
  registerTroubleshootTools(new StationControlToolRegistry(server));
  const registered = (
    server as unknown as {
      _registeredTools: Record<string, { handler: ToolHandler }>;
    }
  )._registeredTools;
  return asStationControlCaller(
    Object.fromEntries(
      Object.entries(registered).map(([name, tool]) => [name, tool.handler]),
    ),
  );
}

const body = (result: ToolResult) =>
  JSON.parse(result.content[0]!.text) as Record<string, any>;

const GITHUB_TOKEN = `ghp_${'q'.repeat(36)}`;

describe('draft_troubleshoot_report', () => {
  test('returns a redacted troubleshoot-report form link keyed by field id', async () => {
    const result = body(
      await tools().draft_troubleshoot_report({
        title: 'Chat stops after pairing',
        fields: {
          'user-impact': 'I cannot chat from my phone.',
          'observed-behavior': `Spinner forever; token ${GITHUB_TOKEN}`,
          diagnosis: 'Relay closed early.',
          'build-identity': '0.1.11-nightly.2489 (nightly)',
          'environment-details':
            'Log at /Users/alice/Library/Logs/station.log via http://10.0.0.5:3141/',
          'redacted-diagnostic': 'warn relay closed',
          'prior-issue': 'https://github.com/kontourai/station/issues/1',
          'remedy-applied': 'None',
          'diagnosed-by': 'Station troubleshooting playbook v2',
        },
      }),
    );
    const url = new URL(result.url);
    expect(url.origin).toBe('https://github.com');
    expect(url.pathname).toBe('/kontourai/station/issues/new');
    expect(url.searchParams.get('template')).toBe('troubleshoot-report.yml');
    expect(url.searchParams.get('title')).toBe('Chat stops after pairing');
    for (const id of TROUBLESHOOT_REPORT_FIELD_IDS)
      expect(url.searchParams.has(id)).toBe(true);
    expect([...url.searchParams.keys()].sort()).toEqual(
      ['template', 'title', ...TROUBLESHOOT_REPORT_FIELD_IDS].sort(),
    );
    expect(result.url).not.toContain(GITHUB_TOKEN);
    expect(url.searchParams.get('observed-behavior')).toContain('[REDACTED]');
    const environment = url.searchParams.get('environment-details')!;
    expect(environment).toContain('~/Library/Logs/station.log');
    expect(environment).not.toContain('alice');
    expect(environment).not.toContain('10.0.0.5');
    expect(url.searchParams.get('prior-issue')).toBe(
      'https://github.com/kontourai/station/issues/1',
    );
    expect(result.fields['observed-behavior']).toBe(
      url.searchParams.get('observed-behavior'),
    );
    expect(result.overflow).toEqual([]);
  });

  test('returns fields that do not fit the link separately and whole', async () => {
    const diagnostic = `start ${'line of log output\n'.repeat(600)}end`;
    const result = body(
      await tools().draft_troubleshoot_report({
        title: 'Large diagnostic',
        fields: {
          'user-impact': 'Blocked.',
          'redacted-diagnostic': diagnostic,
        },
      }),
    );
    expect(result.url.length).toBeLessThanOrEqual(
      MAX_TROUBLESHOOT_ISSUE_URL_LENGTH,
    );
    const url = new URL(result.url);
    expect(url.searchParams.get('user-impact')).toBe('Blocked.');
    expect(url.searchParams.has('redacted-diagnostic')).toBe(false);
    expect(result.included).toEqual(['user-impact']);
    expect(result.overflow).toEqual([
      { id: 'redacted-diagnostic', value: diagnostic },
    ]);
  });
});

describe('get_troubleshoot_playbook', () => {
  test('returns the bundled playbook', async () => {
    const result = body(await tools().get_troubleshoot_playbook({}));
    expect(result).toEqual({ version: 2, playbook: TROUBLESHOOT_PLAYBOOK });
  });
});

describe('Station Assistant delivery', () => {
  test('the production station-control catalog offers both tools to the built-in Station agent', () => {
    const names = stationControlToolCatalog().map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'get_troubleshoot_playbook',
        'draft_troubleshoot_report',
      ]),
    );
    const spec = builtinStationAgentSpec('station');
    expect(spec?.tools?.mcpServers).toContain('station-control');
    // No per-agent allowlist, so every catalogued station-control tool is
    // offered, and both read-only tools run without an approval prompt.
    expect(spec?.tools?.available).toBeUndefined();
    expect(spec?.tools?.autoApprove).toEqual(SC_AUTO_APPROVED_TOOLS);
    expect(SC_AUTO_APPROVED_TOOLS).toEqual(
      expect.arrayContaining([
        'station-control_get_troubleshoot_playbook',
        'station-control_draft_troubleshoot_report',
      ]),
    );
  });
});
