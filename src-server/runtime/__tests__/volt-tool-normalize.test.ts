import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { describe, expect, test } from 'vitest';
import { toVoltAgentTool } from '../frameworks/voltagent-adapter.js';
import { createBuiltinTool } from '../mcp/mcp-manager.js';
import {
  createNativeOutputGrantAuthority,
  currentNativeOutputCallScope,
  runWithNativeOutputTurnContext,
} from '../native-output-turn-grant.js';
import { createBuiltinVendedToolDef } from '../tools/vended-tool-compat.js';
import type { ITool } from '../types.js';

// Regression guard for the tool-forwarding fix: VoltAgent only forwards tools
// to the model when they register as base tools, which requires a real `Tool`
// instance (`type === 'user-defined'` + methods like `isClientSide()`). Station's
// hand-rolled builtin tools are plain objects, so they were silently dropped from
// the model request. `toVoltAgentTool` wraps them; this test locks that in.

describe('toVoltAgentTool', () => {
  test('binds only Volt execute options toolContext.callId into the native scope', async () => {
    const authority = createNativeOutputGrantAuthority();
    const grant = authority.issue(
      {
        threadId: 'session-a',
        turnId: 'turn-a',
        adapterId: 'station-agent',
        principal: { ...humanPrincipal('test', 'owner-a', 'Owner A') },
        configurationLease: { revision: 1 },
      },
      { isCurrent: () => true },
    )!;
    const wrapped = toVoltAgentTool({
      id: 'native',
      name: 'native',
      parameters: {},
      execute: () => currentNativeOutputCallScope(),
    } as never) as {
      execute(input: unknown, options: unknown): Promise<unknown>;
    };

    const scope = await runWithNativeOutputTurnContext(
      { grant, authority },
      () => wrapped.execute({}, { toolContext: { callId: 'volt-real-id' } }),
    );
    expect(authority.admit(scope as never)).toMatchObject({
      callId: 'volt-real-id',
    });
    expect(
      await runWithNativeOutputTurnContext({ grant, authority }, () =>
        wrapped.execute({}, { toolContext: {} }),
      ),
    ).toBeUndefined();
  });

  test('wraps a hand-rolled builtin (plain object) into a real VoltAgent Tool', () => {
    const plain = createBuiltinTool(
      'agent-x',
      createBuiltinVendedToolDef('render-component')!,
      { warn: () => {} } as never,
    )!;
    // Precondition: the raw builtin is NOT yet a VoltAgent base tool.
    expect((plain as { type?: string }).type).toBeUndefined();

    const wrapped = toVoltAgentTool(plain as never) as {
      type?: string;
      name: string;
      isClientSide?: () => boolean;
      execute?: unknown;
    };
    // VoltAgent's ToolManager keys off these to register + forward the tool.
    expect(wrapped.type).toBe('user-defined');
    expect(wrapped.name).toBe('render_component');
    expect(typeof wrapped.isClientSide).toBe('function');
    expect(wrapped.isClientSide?.()).toBe(false); // has a server-side execute
    expect(typeof wrapped.execute).toBe('function');
  });

  test('preserves a provider tool identity/metadata while its real execute call id gains the native scope', async () => {
    const authority = createNativeOutputGrantAuthority();
    const grant = authority.issue(
      {
        threadId: 'provider-session',
        turnId: 'provider-turn',
        adapterId: 'station-agent',
        principal: { ...humanPrincipal('test', 'owner-a', 'Owner A') },
        configurationLease: { revision: 1 },
      },
      { isCurrent: () => true },
    )!;
    const mcpLike: ITool & {
      type: 'user-defined';
      _meta: { 'ui/resourceUri': string };
      ui: { resourceUri: string };
    } = {
      type: 'user-defined',
      name: 'mcp_tool',
      _meta: { 'ui/resourceUri': 'ui://x' },
      ui: { resourceUri: 'ui://x' },
      execute: async () => currentNativeOutputCallScope(),
    };
    const adapted = toVoltAgentTool(mcpLike);
    expect(adapted).toBe(mcpLike);
    expect(mcpLike._meta).toEqual({ 'ui/resourceUri': 'ui://x' });
    expect(mcpLike.ui).toEqual({ resourceUri: 'ui://x' });
    const scope = await runWithNativeOutputTurnContext(
      { grant, authority },
      () =>
        mcpLike.execute({}, { toolContext: { callId: 'volt-provider-id' } }),
    );
    expect(authority.admit(scope as never)).toMatchObject({
      callId: 'volt-provider-id',
    });
  });
});
