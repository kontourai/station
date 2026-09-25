/**
 * Classification completeness for the station-control tool surface
 * (S3 item 4): every tool the REAL MCP server registers must be explicitly
 * classified read-only or mutating in runtime-control-tools.ts. A new tool
 * that ships unclassified fails here (and would be gated as mutating by the
 * fail-safe default until classified).
 */

import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, test } from 'vitest';

import {
  bareControlToolName,
  classifyControlTool,
  isClassifiedControlTool,
  SC_MUTATING_TOOLS,
  SC_READ_ONLY_TOOLS,
} from '../../runtime/tools/runtime-control-tools.js';
import { registerAgentTools } from '../station-control-agent-tools.js';
import { registerBoardTools } from '../station-control-board-tools.js';
import { registerCatalogTools } from '../station-control-catalog-tools.js';
import { StationControlToolRegistry } from '../station-control-mcp-server.js';
import { registerNotifyTools } from '../station-control-notify-tools.js';
import { registerOperationsTools } from '../station-control-operations-tools.js';
import { registerPlatformTools } from '../station-control-platform-tools.js';

function registeredToolNames(): string[] {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const registry = new StationControlToolRegistry(server);
  registerAgentTools(registry);
  registerBoardTools(registry);
  registerCatalogTools(registry);
  registerOperationsTools(registry);
  registerPlatformTools(registry);
  registerNotifyTools(registry);
  const registeredTools = (server as unknown as Record<string, unknown>)
    ._registeredTools as Record<string, unknown> | undefined;
  expect(registeredTools).toBeDefined();
  return Object.keys(registeredTools as Record<string, unknown>);
}

describe('station-control tool classification', () => {
  test('every registered tool is explicitly classified', () => {
    const names = registeredToolNames();
    expect(names.length).toBeGreaterThan(30);
    const unclassified = names.filter((name) => !isClassifiedControlTool(name));
    expect(unclassified).toEqual([]);
  });

  test('read-only and mutating sets partition the surface', () => {
    const names = registeredToolNames();
    const readOnly = names.filter(
      (name) => classifyControlTool(name) === 'read-only',
    );
    const mutating = names.filter(
      (name) => classifyControlTool(name) === 'mutating',
    );
    expect(readOnly.length + mutating.length).toBe(names.length);
    // Spot-check the contract: CRUD/install/dispatch are mutating. Most
    // list/get/navigate/status tools are read-only; delegation discovery is
    // gated because selecting an SSH environment may reconnect it.
    expect(mutating).toEqual(
      expect.arrayContaining([
        'create_agent',
        'update_agent',
        'delete_agent',
        'install_skill',
        'install_registry_integration',
        'install_plugin',
        // #2323 S5: they record a proposal (a durable write), so they are
        // not auto-approved as readers.
        'propose_plugin_install',
        'update_plugin',
        'remove_plugin',
        'add_job',
        'run_job',
        'update_config',
        'send_message',
        'list_delegation_targets',
        'list_delegated_tasks',
        'delegate_task',
        'get_task',
        'get_task_events',
        'continue_task',
        'respond_to_task_request',
        'interrupt_task',
        'update_skill',
        'track_skill_run',
        'record_skill_outcome',
        'run_independent_review',
      ]),
    );
    expect(readOnly).toEqual(
      expect.arrayContaining([
        'list_agents',
        'get_agent',
        'list_delegation_environments',
        'system_status',
        'navigate_to',
        'get_config',
        'get_review_request',
        'list_review_receipts',
        'get_review_receipt',
        'list_projects',
        // #2323 S1: validation reads the folder in place, writes nothing and
        // returns nothing an install can consume, so it needs no
        // platform-mutation approval.
        'validate_plugin',
        // #2584: writes one rate-limited inbox record; an approval prompt
        // would wait for the away user it is trying to reach.
        'notify_user',
      ]),
    );
  });

  test('no tool is listed as both read-only and mutating', () => {
    // `classifyControlTool` checks the read-only set first, so a name in both
    // lists would silently classify read-only (auto-approved). Pin the lists
    // themselves, not the classifier's answer.
    const mutating = new Set(SC_MUTATING_TOOLS);
    expect(SC_READ_ONLY_TOOLS.filter((tool) => mutating.has(tool))).toEqual([]);
    expect(SC_READ_ONLY_TOOLS.length).toBeGreaterThan(10);
    expect(SC_MUTATING_TOOLS.length).toBeGreaterThan(10);
  });

  test('classification handles loader-prefixed names', () => {
    expect(classifyControlTool('station-control_create_agent')).toBe(
      'mutating',
    );
    expect(classifyControlTool('stationControl_create_agent')).toBe('mutating');
    expect(classifyControlTool('station-control_list_agents')).toBe(
      'read-only',
    );
    expect(bareControlToolName('stationControl_list_agents')).toBe(
      'list_agents',
    );
  });

  test('unknown station-control tool names classify as mutating (fail-safe)', () => {
    expect(classifyControlTool('station-control_brand_new_tool')).toBe(
      'mutating',
    );
    expect(isClassifiedControlTool('station-control_brand_new_tool')).toBe(
      false,
    );
  });

  test('SC_READ_ONLY_TOOLS (auto-approve list) stays prefixed and read-only', () => {
    for (const name of SC_READ_ONLY_TOOLS) {
      expect(name.startsWith('station-control_')).toBe(true);
      expect(classifyControlTool(name)).toBe('read-only');
    }
  });
});
