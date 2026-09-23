/**
 * `station-browser` (#90 D14, N2): its own narrow server, and every tool
 * that reads or drives a page — `browser_snapshot` and `browser_wait_for`
 * included — is sensitive: nothing Station auto-approves by default lets
 * one through without the operator's approval.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, test } from 'vitest';
import { SC_READ_ONLY_TOOLS } from '../../runtime/tools/runtime-control-tools.js';
import { isAutoApprovedExternalTool } from '../../runtime/tools/tool-approval.js';
import { createStationBrowserMcpServer } from '../station-browser-mcp-server.js';
import {
  classifyStationBrowserTool,
  STATION_BROWSER_MCP_SERVER_ID,
} from '../station-browser-policy.js';
import { createStationControlMcpServer } from '../station-control-mcp-server.js';

const registered = (server: McpServer) =>
  Object.keys(
    (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools,
  ).sort();

const BROWSER_TOOLS = [
  'browser_click',
  'browser_evaluate',
  'browser_navigate',
  'browser_open',
  'browser_press',
  'browser_resize',
  'browser_scroll',
  'browser_snapshot',
  'browser_status',
  'browser_type',
  'browser_wait_for',
];

describe('station-browser', () => {
  test('is its own server with the browser tools only; station-control serves none of them', () => {
    expect(STATION_BROWSER_MCP_SERVER_ID).toBe('station-browser');
    expect(registered(createStationBrowserMcpServer())).toEqual(BROWSER_TOOLS);
    expect(
      registered(createStationControlMcpServer()).filter((name) =>
        name.startsWith('browser_'),
      ),
    ).toEqual([]);
  });

  test('only browser_status is read-only; snapshot and wait_for are sensitive like every page action', () => {
    expect(
      BROWSER_TOOLS.filter(
        (tool) => classifyStationBrowserTool(tool) === 'read-only',
      ),
    ).toEqual(['browser_status']);
    expect(classifyStationBrowserTool('browser_snapshot')).toBe('sensitive');
    expect(classifyStationBrowserTool('browser_wait_for')).toBe('sensitive');
    expect(classifyStationBrowserTool('browser_click')).toBe('sensitive');
  });

  test("the default agent's auto-approve list approves no station-browser tool", () => {
    for (const tool of BROWSER_TOOLS)
      expect(
        isAutoApprovedExternalTool(
          `mcp__station-browser__${tool}`,
          [...SC_READ_ONLY_TOOLS],
          [],
          'authentic',
        ),
      ).toBe(false);
  });
});
