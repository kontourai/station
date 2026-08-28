import crypto from 'node:crypto';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  buildApprovalResult,
  deriveToolArguments,
  deriveToolName,
  deriveToolOutput,
  mapApprovalResolutionStatus,
  mapServerRequestToEvent,
  mapThreadStatusToState,
  mapToolCompletionStatus,
  mapTurnFinishReason,
} from '../adapters/codex-adapter-events.js';

describe('codex-adapter-events', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('maps approval requests into canonical request.opened events', () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      '11111111-1111-1111-1111-111111111111',
    );

    expect(
      mapServerRequestToEvent(
        'thread-1',
        'request-1',
        'item/commandExecution/requestApproval',
        {
          command: 'rm -rf tmp',
          reason: 'Needs approval',
        },
        '2026-01-01T00:00:00.000Z',
      ),
    ).toEqual({
      eventId: '11111111-1111-1111-1111-111111111111',
      provider: 'codex',
      threadId: 'thread-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      requestId: 'request-1',
      method: 'request.opened',
      requestType: 'approval',
      title: 'rm -rf tmp',
      description: 'Needs approval',
      payload: {
        command: 'rm -rf tmp',
        reason: 'Needs approval',
      },
    });
  });

  test('builds approval results and resolution statuses', () => {
    expect(
      buildApprovalResult(
        'item/permissions/requestApproval',
        { permissions: { fs: 'write' } },
        'acceptForSession',
      ),
    ).toEqual({
      permissions: { fs: 'write' },
      scope: 'session',
    });
    expect(
      buildApprovalResult('item/fileChange/requestApproval', {}, 'decline'),
    ).toEqual({ decision: 'decline' });

    expect(mapApprovalResolutionStatus('accept')).toBe('approved');
    expect(mapApprovalResolutionStatus('acceptForSession')).toBe('approved');
    expect(mapApprovalResolutionStatus('decline')).toBe('denied');
    expect(mapApprovalResolutionStatus('cancel')).toBe('cancelled');
  });

  // archive#1195: the app-server's own "may I invoke this MCP tool" gate
  // (and any real MCP `elicitation/create` request) rides this method —
  // before this ticket Codex had no toolServers delivery at all, so this
  // was never reachable and an unhandled request would auto-error, which
  // would have silently broken every station-control tool call.
  test('maps an MCP elicitation request (tool-call gate) into a canonical request.opened approval', () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      '22222222-2222-2222-2222-222222222222',
    );

    expect(
      mapServerRequestToEvent(
        'thread-1',
        'request-1',
        'mcpServer/elicitation/request',
        {
          serverName: 'station-control',
          threadId: 'thread-1',
          mode: 'form',
          message:
            'Allow the station-control MCP server to run tool "list_agents"?',
          requestedSchema: { type: 'object', properties: {} },
          _meta: {
            codex_approval_kind: 'mcp_tool_call',
            tool_title: 'List agents',
          },
        },
        '2026-01-01T00:00:00.000Z',
      ),
    ).toEqual({
      eventId: '22222222-2222-2222-2222-222222222222',
      provider: 'codex',
      threadId: 'thread-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      requestId: 'request-1',
      method: 'request.opened',
      requestType: 'approval',
      title: 'Allow station-control to run "List agents"',
      description:
        'Allow the station-control MCP server to run tool "list_agents"?',
      payload: {
        serverName: 'station-control',
        threadId: 'thread-1',
        mode: 'form',
        message:
          'Allow the station-control MCP server to run tool "list_agents"?',
        requestedSchema: { type: 'object', properties: {} },
        _meta: {
          codex_approval_kind: 'mcp_tool_call',
          tool_title: 'List agents',
        },
      },
    });
  });

  test('falls back to a generic title when no tool_title is present in an MCP elicitation request', () => {
    const event = mapServerRequestToEvent(
      'thread-1',
      'request-1',
      'mcpServer/elicitation/request',
      {
        serverName: 'a-third-party-server',
        mode: 'url',
        url: 'https://example.com',
      },
      '2026-01-01T00:00:00.000Z',
    );
    expect(event?.title).toBe('Allow a-third-party-server MCP request');
  });

  test('builds accept/decline/cancel responses for an MCP elicitation request (distinct from the decision-keyed approval shapes)', () => {
    expect(
      buildApprovalResult(
        'mcpServer/elicitation/request',
        { requestedSchema: { type: 'object', properties: {} } },
        'accept',
      ),
    ).toEqual({ action: 'accept' });
    expect(
      buildApprovalResult(
        'mcpServer/elicitation/request',
        { requestedSchema: { type: 'object', properties: {} } },
        'acceptForSession',
      ),
    ).toEqual({ action: 'accept' });
    expect(
      buildApprovalResult('mcpServer/elicitation/request', {}, 'decline'),
    ).toEqual({ action: 'decline' });
    expect(
      buildApprovalResult('mcpServer/elicitation/request', {}, 'cancel'),
    ).toEqual({ action: 'cancel' });
  });

  test('does not accept an MCP elicitation that requires user-supplied content', () => {
    expect(
      buildApprovalResult(
        'mcpServer/elicitation/request',
        {
          requestedSchema: {
            type: 'object',
            properties: { reason: { type: 'string' } },
            required: ['reason'],
          },
        },
        'accept',
      ),
    ).toEqual({ action: 'decline' });
  });

  test('derives tool names, arguments, and output from item payloads', () => {
    const commandItem = {
      type: 'commandExecution',
      command: 'ls',
      cwd: '/tmp/project',
      aggregatedOutput: 'file-a',
      exitCode: 0,
      durationMs: 12,
    };

    expect(deriveToolName(commandItem)).toBe('shell_exec');
    expect(deriveToolArguments(commandItem)).toEqual({
      command: 'ls',
      cwd: '/tmp/project',
    });
    expect(deriveToolOutput(commandItem)).toEqual({
      output: 'file-a',
      exitCode: 0,
      durationMs: 12,
    });
  });

  test('maps thread, turn, and tool completion states', () => {
    expect(mapThreadStatusToState({ type: 'active' })).toBe('running');
    expect(mapThreadStatusToState({ type: 'systemError' })).toBe('errored');
    expect(mapThreadStatusToState({ type: 'idle' })).toBe('idle');

    expect(mapTurnFinishReason('completed')).toBe('stop');
    expect(mapTurnFinishReason('interrupted')).toBe('cancelled');
    expect(mapTurnFinishReason('unknown')).toBe('other');

    expect(mapToolCompletionStatus('completed')).toBe('success');
    expect(mapToolCompletionStatus('declined')).toBe('cancelled');
    expect(mapToolCompletionStatus('failed')).toBe('error');
  });
});
