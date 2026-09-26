/**
 * Classification completeness for the station-control tool surface
 * (S3 item 4, #2377 slice A): every tool the REAL MCP server registers has
 * exactly one entry in the station-control authority table
 * (`tools/station-control-policy.ts`), and the read-only / bounded-write /
 * mutating lists in runtime-control-tools.ts are derived from it. A new tool
 * that ships without an entry fails here (and would be gated as mutating by
 * the fail-safe default, and refused by the server guard, until it has one).
 */

import { describe, expect, test } from 'vitest';

import {
  bareControlToolName,
  classifyControlTool,
  isClassifiedControlTool,
  SC_AUTO_APPROVED_SIDE_EFFECT_TOOLS,
  SC_AUTO_APPROVED_TOOLS,
  SC_MUTATING_TOOLS,
  SC_READ_ONLY_TOOLS,
} from '../../runtime/tools/runtime-control-tools.js';
import { createStationControlMcpServer } from '../station-control-mcp-server.js';
import { STATION_CONTROL_TOOL_POLICY } from '../station-control-policy.js';

/**
 * The PRODUCTION server factory (every registrar it composes, including the
 * Basis and session-inventory MCP App tools the old hand list missed).
 */
function registeredToolNames(): string[] {
  const server = createStationControlMcpServer();
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

  test('the authority table names exactly the registered tools: none missing, none stale', () => {
    const registered = registeredToolNames().sort();
    expect(Object.keys(STATION_CONTROL_TOOL_POLICY).sort()).toEqual(registered);
    // The two hand-list defects #2377 found, pinned by name.
    for (const stale of ['list_layouts', 'get_layout'])
      expect(isClassifiedControlTool(stale)).toBe(false);
    for (const read of ['get_basis', 'get_task_basis', 'get_session_inventory'])
      expect(classifyControlTool(read)).toBe('read-only');
  });

  test('read-only, bounded-write and mutating sets partition the surface', () => {
    const names = registeredToolNames();
    const readOnly = names.filter(
      (name) => classifyControlTool(name) === 'read-only',
    );
    const boundedWrite = names.filter(
      (name) => classifyControlTool(name) === 'bounded-write',
    );
    const mutating = names.filter(
      (name) => classifyControlTool(name) === 'mutating',
    );
    expect(readOnly.length + boundedWrite.length + mutating.length).toBe(
      names.length,
    );
    // #2584: notify_user writes (one bounded inbox record), so it is not
    // labelled a reader; it is auto-approved as a bounded write.
    expect(boundedWrite).toEqual(['notify_user']);
    expect(SC_AUTO_APPROVED_TOOLS).toEqual([
      ...SC_READ_ONLY_TOOLS,
      'station-control_notify_user',
    ]);
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
      ]),
    );
  });

  test('no tool is listed in more than one of the three lists', () => {
    // `classifyControlTool` checks read-only, then bounded-write, then
    // mutating, so a name in two lists would silently take the first (more
    // permissive) class. Pin the lists themselves, not the classifier.
    const lists = [
      SC_READ_ONLY_TOOLS,
      SC_AUTO_APPROVED_SIDE_EFFECT_TOOLS,
      SC_MUTATING_TOOLS,
    ];
    const all = lists.flat();
    expect(new Set(all).size).toBe(all.length);
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
