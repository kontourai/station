import { beforeEach, describe, expect, test, vi } from 'vitest';

const fromIniProvider = vi.hoisted(() => vi.fn(() => Symbol('creds')));
const fromNodeProviderChainProvider = vi.hoisted(() =>
  vi.fn(() => Symbol('chain-creds')),
);
const fromIni = vi.hoisted(() => vi.fn(() => fromIniProvider));
const fromNodeProviderChain = vi.hoisted(() =>
  vi.fn(() => fromNodeProviderChainProvider),
);

vi.mock('@aws-sdk/credential-providers', () => ({
  fromIni,
  fromNodeProviderChain,
}));

import {
  bedrockAiSdkCredentials,
  bedrockClientAuth,
  bedrockStrandsCredentials,
} from '../bedrock-credentials.js';

describe('bedrockClientAuth', () => {
  beforeEach(() => {
    fromIni.mockClear();
    fromNodeProviderChain.mockClear();
  });

  test('chain mode (default) returns {} — the client default chain applies', () => {
    expect(bedrockClientAuth()).toEqual({});
    expect(bedrockClientAuth({ authMode: 'chain' })).toEqual({});
    expect(fromIni).not.toHaveBeenCalled();
  });

  test('profile mode resolves via fromIni with the profile name', () => {
    const result = bedrockClientAuth({ authMode: 'profile', profile: 'work' });

    expect(fromIni).toHaveBeenCalledWith({ profile: 'work' });
    expect(result).toEqual({ credentials: fromIniProvider });
  });

  // HIGH-2 (review fix round): a missing/empty required field must never
  // silently fall through to the default chain — it must throw.
  test('profile mode without a profile name throws instead of falling back to chain', () => {
    expect(() => bedrockClientAuth({ authMode: 'profile' })).toThrow(
      /no named AWS profile/i,
    );
    expect(() =>
      bedrockClientAuth({ authMode: 'profile', profile: '  ' }),
    ).toThrow(/no named AWS profile/i);
    expect(fromIni).not.toHaveBeenCalled();
  });

  test('api-key mode sets a bearer token and scheme preference', () => {
    const result = bedrockClientAuth({
      authMode: 'api-key',
      apiKey: 'bedrock-key-123',
    });

    expect(result).toEqual({
      token: { token: 'bedrock-key-123' },
      authSchemePreference: ['httpBearerAuth'],
    });
  });

  test('api-key mode without a key throws instead of falling back to chain', () => {
    expect(() => bedrockClientAuth({ authMode: 'api-key' })).toThrow(
      /no API key/i,
    );
    expect(() =>
      bedrockClientAuth({ authMode: 'api-key', apiKey: '  ' }),
    ).toThrow(/no API key/i);
  });

  test('an unrecognized authMode throws rather than defaulting to chain', () => {
    expect(() => bedrockClientAuth({ authMode: 'bogus' as never })).toThrow(
      /unrecognized authMode/i,
    );
  });

  test('never leaks a raw api key into a non-bearer field', () => {
    const result = bedrockClientAuth({
      authMode: 'api-key',
      apiKey: 'super-secret',
    });
    expect(JSON.stringify(result)).not.toContain('credentials');
  });
});

// HIGH-3 (review fix round): the Strands (@strands-agents/sdk BedrockModel)
// execution path previously ignored profile/api-key connections entirely.
describe('bedrockStrandsCredentials', () => {
  beforeEach(() => {
    fromIni.mockClear();
    fromNodeProviderChain.mockClear();
  });

  test('chain mode (default) returns {} — BedrockModel keeps its own default resolution', () => {
    expect(bedrockStrandsCredentials()).toEqual({});
    expect(fromNodeProviderChain).not.toHaveBeenCalled();
    expect(fromIni).not.toHaveBeenCalled();
  });

  test('profile mode threads SigV4 credentials via clientConfig.credentials', () => {
    const result = bedrockStrandsCredentials({
      authMode: 'profile',
      profile: 'work',
    });

    expect(fromIni).toHaveBeenCalledWith({ profile: 'work' });
    expect(result).toEqual({
      clientConfig: { credentials: fromIniProvider },
    });
  });

  test('profile mode without a profile name throws instead of falling back to chain', () => {
    expect(() => bedrockStrandsCredentials({ authMode: 'profile' })).toThrow(
      /no named AWS profile/i,
    );
    expect(fromIni).not.toHaveBeenCalled();
  });

  test('api-key mode returns the bare apiKey field BedrockModel accepts directly', () => {
    const result = bedrockStrandsCredentials({
      authMode: 'api-key',
      apiKey: 'bedrock-key-xyz',
    });
    expect(result).toEqual({ apiKey: 'bedrock-key-xyz' });
  });

  test('api-key mode without a key throws instead of falling back to chain', () => {
    expect(() => bedrockStrandsCredentials({ authMode: 'api-key' })).toThrow(
      /no API key/i,
    );
  });

  test('an unrecognized authMode throws rather than defaulting to chain', () => {
    expect(() =>
      bedrockStrandsCredentials({ authMode: 'bogus' as never }),
    ).toThrow(/unrecognized authMode/i);
  });
});

describe('bedrockAiSdkCredentials', () => {
  beforeEach(() => {
    fromIni.mockClear();
    fromNodeProviderChain.mockClear();
  });

  test('chain mode (default) uses the node provider chain — unchanged default behavior', () => {
    const result = bedrockAiSdkCredentials();
    expect(fromNodeProviderChain).toHaveBeenCalled();
    expect(result).toEqual({
      credentialProvider: fromNodeProviderChainProvider,
    });
  });

  test('profile mode resolves via fromIni with the profile name', () => {
    const result = bedrockAiSdkCredentials({
      authMode: 'profile',
      profile: 'personal',
    });

    expect(fromIni).toHaveBeenCalledWith({ profile: 'personal' });
    expect(result).toEqual({ credentialProvider: fromIniProvider });
  });

  test('profile mode without a name throws instead of falling back to the node provider chain', () => {
    expect(() => bedrockAiSdkCredentials({ authMode: 'profile' })).toThrow(
      /no named AWS profile/i,
    );
    expect(fromIni).not.toHaveBeenCalled();
  });

  test('api-key mode returns the bare apiKey field for createAmazonBedrock', () => {
    const result = bedrockAiSdkCredentials({
      authMode: 'api-key',
      apiKey: 'bedrock-key-abc',
    });
    expect(result).toEqual({ apiKey: 'bedrock-key-abc' });
  });

  test('api-key mode without a key throws instead of falling back to the node provider chain', () => {
    expect(() => bedrockAiSdkCredentials({ authMode: 'api-key' })).toThrow(
      /no API key/i,
    );
  });

  test('an unrecognized authMode throws rather than defaulting to chain', () => {
    expect(() =>
      bedrockAiSdkCredentials({ authMode: 'bogus' as never }),
    ).toThrow(/unrecognized authMode/i);
  });
});
