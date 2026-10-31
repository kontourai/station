import { describe, expect, test, vi } from 'vitest';
import {
  ACPProcess,
  ACPProviderRoutingUnsupportedError,
  ACPRequiredProviderDisableError,
  observeACPProviderRouting,
} from '../acp-process.js';

describe('ACP unstable provider routing (#944)', () => {
  test('does not call providers/list when initialize omitted the capability', async () => {
    const request = vi.fn().mockRejectedValue(new Error('must never execute'));

    await expect(
      observeACPProviderRouting({ request } as never, {
        protocolVersion: 1,
        agentCapabilities: {},
      }),
    ).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  test('calls providers/list for an advertised empty capability and preserves observed empty', async () => {
    const request = vi.fn().mockResolvedValue({ providers: [] });

    await expect(
      observeACPProviderRouting({ request } as never, {
        protocolVersion: 1,
        agentCapabilities: { providers: {} },
      }),
    ).resolves.toEqual([]);
    expect(request).toHaveBeenCalledOnce();
  });

  test('executes and surfaces a providers/list rejection after advertisement', async () => {
    const request = vi
      .fn()
      .mockRejectedValue(new Error('provider catalogue refused'));

    await expect(
      observeACPProviderRouting({ request } as never, {
        protocolVersion: 1,
        agentCapabilities: { providers: {} },
      }),
    ).rejects.toThrow('provider catalogue refused');
    expect(request).toHaveBeenCalledOnce();
  });

  test('refuses providers/set before transport when capability is absent', async () => {
    const request = vi.fn();
    const process = new ACPProcess({
      command: 'unused',
      cwd: '/tmp',
      createClient: () => ({}) as never,
      logger: {},
    });
    Object.assign(process as unknown as Record<string, unknown>, {
      connection: { request },
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
    expect(request).not.toHaveBeenCalled();
  });

  test('executes the required-provider disable refusal before transport', async () => {
    const request = vi.fn();
    const process = new ACPProcess({
      command: 'unused',
      cwd: '/tmp',
      createClient: () => ({}) as never,
      logger: {},
    });
    Object.assign(process as unknown as Record<string, unknown>, {
      connection: { request },
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
    expect(request).not.toHaveBeenCalled();
  });

  test('refuses an unadvertised protocol before providers/set transport', async () => {
    const request = vi.fn();
    const process = new ACPProcess({
      command: 'unused',
      cwd: '/tmp',
      createClient: () => ({}) as never,
      logger: {},
    });
    Object.assign(process as unknown as Record<string, unknown>, {
      connection: { request },
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
    expect(request).not.toHaveBeenCalled();
  });

  test('forwards an observed unknown protocol identifier losslessly', async () => {
    const request = vi.fn().mockResolvedValue({});
    const process = new ACPProcess({
      command: 'unused',
      cwd: '/tmp',
      createClient: () => ({}) as never,
      logger: {},
    });
    Object.assign(process as unknown as Record<string, unknown>, {
      connection: { request },
      _initResult: {
        protocolVersion: 1,
        agentCapabilities: { providers: {} },
        providerRouting: [
          { providerId: 'main', supported: ['_ollama'], required: false },
        ],
      },
    });
    const params = {
      providerId: 'main',
      apiType: '_ollama',
      baseUrl: 'https://ollama.example/v1',
    };

    await expect(process.setProvider(params)).resolves.toEqual({});
    expect(request).toHaveBeenCalledWith('providers/set', params);
  });
});
