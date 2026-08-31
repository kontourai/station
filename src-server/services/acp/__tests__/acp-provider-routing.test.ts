import { describe, expect, test, vi } from 'vitest';
import {
  ACPProcess,
  ACPProviderRoutingUnsupportedError,
  ACPRequiredProviderDisableError,
  observeACPProviderRouting,
} from '../acp-process.js';

describe('ACP unstable provider routing (#944)', () => {
  test('does not call providers/list when initialize omitted the capability', async () => {
    const unstable_listProviders = vi
      .fn()
      .mockRejectedValue(new Error('must never execute'));

    await expect(
      observeACPProviderRouting({ unstable_listProviders } as never, {
        protocolVersion: 1,
        agentCapabilities: {},
      }),
    ).resolves.toBeUndefined();
    expect(unstable_listProviders).not.toHaveBeenCalled();
  });

  test('calls providers/list for an advertised empty capability and preserves observed empty', async () => {
    const unstable_listProviders = vi.fn().mockResolvedValue({ providers: [] });

    await expect(
      observeACPProviderRouting({ unstable_listProviders } as never, {
        protocolVersion: 1,
        agentCapabilities: { providers: {} },
      }),
    ).resolves.toEqual([]);
    expect(unstable_listProviders).toHaveBeenCalledOnce();
  });

  test('executes and surfaces a providers/list rejection after advertisement', async () => {
    const unstable_listProviders = vi
      .fn()
      .mockRejectedValue(new Error('provider catalogue refused'));

    await expect(
      observeACPProviderRouting({ unstable_listProviders } as never, {
        protocolVersion: 1,
        agentCapabilities: { providers: {} },
      }),
    ).rejects.toThrow('provider catalogue refused');
    expect(unstable_listProviders).toHaveBeenCalledOnce();
  });

  test('refuses providers/set before transport when capability is absent', async () => {
    const unstable_setProvider = vi.fn();
    const process = new ACPProcess({
      command: 'unused',
      cwd: '/tmp',
      createClient: () => ({}) as never,
      logger: {},
    });
    Object.assign(process as unknown as Record<string, unknown>, {
      connection: { unstable_setProvider },
      _initResult: { protocolVersion: 1, agentCapabilities: {} },
    });

    await expect(
      process.setProvider({
        providerId: 'main',
        apiType: 'openai',
        baseUrl: 'https://openrouter.ai/api/v1',
        headers: {},
      }),
    ).rejects.toBeInstanceOf(ACPProviderRoutingUnsupportedError);
    expect(unstable_setProvider).not.toHaveBeenCalled();
  });

  test('executes the required-provider disable refusal before transport', async () => {
    const unstable_disableProvider = vi.fn();
    const process = new ACPProcess({
      command: 'unused',
      cwd: '/tmp',
      createClient: () => ({}) as never,
      logger: {},
    });
    Object.assign(process as unknown as Record<string, unknown>, {
      connection: { unstable_disableProvider },
      _initResult: {
        protocolVersion: 1,
        agentCapabilities: { providers: {} },
        providerRouting: [
          { providerId: 'main', supported: ['openai'], required: true },
        ],
      },
    });

    await expect(process.disableProvider('main')).rejects.toBeInstanceOf(
      ACPRequiredProviderDisableError,
    );
    expect(unstable_disableProvider).not.toHaveBeenCalled();
  });

  test('refuses an unadvertised protocol before providers/set transport', async () => {
    const unstable_setProvider = vi.fn();
    const process = new ACPProcess({
      command: 'unused',
      cwd: '/tmp',
      createClient: () => ({}) as never,
      logger: {},
    });
    Object.assign(process as unknown as Record<string, unknown>, {
      connection: { unstable_setProvider },
      _initResult: {
        protocolVersion: 1,
        agentCapabilities: { providers: {} },
        providerRouting: [
          { providerId: 'main', supported: ['openai'], required: false },
        ],
      },
    });

    await expect(
      process.setProvider({
        providerId: 'main',
        apiType: 'opneai',
        baseUrl: 'https://openrouter.ai/api/v1',
      }),
    ).rejects.toMatchObject({
      code: 'protocol_unsupported',
    });
    expect(unstable_setProvider).not.toHaveBeenCalled();
  });

  test('forwards an observed unknown protocol identifier losslessly', async () => {
    const unstable_setProvider = vi.fn().mockResolvedValue({});
    const process = new ACPProcess({
      command: 'unused',
      cwd: '/tmp',
      createClient: () => ({}) as never,
      logger: {},
    });
    Object.assign(process as unknown as Record<string, unknown>, {
      connection: { unstable_setProvider },
      _initResult: {
        protocolVersion: 1,
        agentCapabilities: { providers: {} },
        providerRouting: [
          { providerId: 'main', supported: ['_ollama'], required: false },
        ],
      },
    });
    const request = {
      providerId: 'main',
      apiType: '_ollama',
      baseUrl: 'https://ollama.example/v1',
    };

    await expect(process.setProvider(request)).resolves.toEqual({});
    expect(unstable_setProvider).toHaveBeenCalledWith(request);
  });
});
