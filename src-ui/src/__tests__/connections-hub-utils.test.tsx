import { describe, expect, it } from 'vitest';
import {
  describeConnection,
  getConnectionStatusClass,
  getProviderIcon,
} from '../views/connections-hub/utils';

describe('connections-hub utils', () => {
  it('describes missing prerequisites', () => {
    expect(
      describeConnection({
        id: 'bedrock',
        kind: 'agent',
        type: 'bedrock',
        name: 'Bedrock',
        enabled: true,
        capabilities: [],
        status: 'missing_prerequisites',
        prerequisites: [
          {
            id: 'aws-credentials',
            name: 'AWS credentials',
            description: '',
            status: 'missing',
            category: 'required',
          },
          {
            id: 'region',
            name: 'Region',
            description: '',
            status: 'error',
            category: 'required',
          },
        ],
        config: {},
      }),
    ).toContain('AWS credentials');
  });

  it('describes a fully-ready acp connection with an empty string', () => {
    expect(
      describeConnection({
        id: 'kiro',
        kind: 'agent',
        type: 'acp',
        name: 'Kiro',
        enabled: true,
        capabilities: [],
        status: 'ready',
        prerequisites: [
          {
            id: 'acp-connection',
            name: 'Kiro',
            description: '',
            status: 'installed',
            category: 'optional',
          },
        ],
        config: {},
      }),
    ).toBe('');
  });

  it('returns stable status and provider fallbacks', () => {
    expect(getConnectionStatusClass('ready')).toBe('ready');
    expect(getConnectionStatusClass('unknown')).toBe('warn');
    expect(getProviderIcon('unknown')).toBeTypeOf('function');
  });
});
