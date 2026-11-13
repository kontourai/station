/**
 * Gemini CLI's sign-in methods as Station offers them. The built-in
 * descriptor applies through the real registry lookup, and the handshake is
 * Gemini CLI's own `initialize` answer, so this runs on every platform where
 * the fake-agent process tests do not.
 */
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { BUILTIN_ACP_ENGINES } from '../../../providers/llm/builtin-acp-engines.js';
import {
  clearAll,
  registerACPConnectionRegistryProvider,
} from '../../../providers/registries/registry.js';
import { EngineSignInService } from '../engine-sign-in.js';

/**
 * `authMethods` exactly as gemini-cli's `initialize` builds them
 * (google-gemini/gemini-cli packages/cli/src/acp/acpRpcDispatcher.ts @
 * 4ed06ed0ddc523a6d356a4ad35ddfea331041888, v0.68.0; the ids are
 * `AuthType` in packages/core/src/core/contentGenerator.ts).
 */
const GEMINI_AUTH_METHODS = [
  {
    id: 'oauth-personal',
    name: 'Log in with Google',
    description: 'Log in with your Google account',
  },
  {
    id: 'gemini-api-key',
    name: 'Gemini API key',
    description: 'Use an API key with Gemini Developer API',
    _meta: { 'api-key': { provider: 'google' } },
  },
  {
    id: 'vertex-ai',
    name: 'Vertex AI',
    description: 'Use an API key with Vertex AI GenAI API',
  },
  {
    id: 'gateway',
    name: 'AI API Gateway',
    description: 'Use a custom AI API Gateway',
    _meta: { gateway: { protocol: 'google', restartRequired: 'false' } },
  },
];

function geminiHandshake() {
  return {
    start: async () => ({
      protocolVersion: 1,
      agentInfo: { name: 'gemini-cli', title: 'Gemini CLI', version: '0.68.0' },
      agentCapabilities: { loadSession: true },
      authMethods: GEMINI_AUTH_METHODS,
    }),
    destroy: async () => undefined,
  };
}

const gemini: ACPConnectionConfig = {
  id: 'gemini',
  name: 'Gemini CLI',
  command: 'gemini',
  args: ['--acp'],
  enabled: true,
};

beforeEach(() => {
  registerACPConnectionRegistryProvider(
    { listAvailable: () => BUILTIN_ACP_ENGINES.map((entry) => ({ ...entry })) },
    'builtin-acp-connections',
    true,
  );
});
afterEach(() => clearAll());

describe('Gemini CLI sign-in', () => {
  test('offers neither the Google login nor the key method the key field replaces', async () => {
    const service = new EngineSignInService({
      terminal: null,
      processFactory: () => geminiHandshake() as never,
    });
    await service.refreshMethods(gemini);
    expect(
      service.methodsView(gemini).methods?.map((method) => method.id),
    ).toEqual(['vertex-ai', 'gateway']);
  });

  test('refuses to run the Google login when asked for it by id', async () => {
    const service = new EngineSignInService({
      terminal: null,
      processFactory: () => geminiHandshake() as never,
    });
    await service.refreshMethods(gemini);
    await expect(service.startAgent(gemini, 'oauth-personal')).rejects.toThrow(
      'does not offer',
    );
  });
});
