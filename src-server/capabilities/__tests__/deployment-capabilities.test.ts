import { describe, expect, test } from 'vitest';
import { resolveDeploymentCapabilities } from '../deployment-capabilities.js';

describe('resolveDeploymentCapabilities', () => {
  test('keeps deployment capabilities unknown when no declaration is present', () => {
    expect(resolveDeploymentCapabilities({})).toEqual({
      features: {
        'web-push': { state: 'unknown' },
        scheduler: { state: 'unknown' },
      },
    });
  });

  test('uses only valid explicitly declared feature states', () => {
    expect(
      resolveDeploymentCapabilities({
        STATION_DEPLOYMENT_CAPABILITIES: JSON.stringify({
          'web-push': 'unsupported',
          scheduler: 'supported',
          future: 'supported',
        }),
      }),
    ).toEqual({
      features: {
        'web-push': { state: 'unsupported' },
        scheduler: { state: 'supported' },
      },
    });
  });

  test('fails closed when a deployment declaration is malformed', () => {
    expect(
      resolveDeploymentCapabilities({
        STATION_DEPLOYMENT_CAPABILITIES: '{not-json}',
      }),
    ).toEqual({
      features: {
        'web-push': { state: 'unknown' },
        scheduler: { state: 'unknown' },
      },
    });
  });

  test.each(['', '   ', '\n\t'])(
    'fails closed when a deployment declaration is explicitly empty (%j)',
    (declaration) => {
      expect(
        resolveDeploymentCapabilities({
          STATION_DEPLOYMENT_CAPABILITIES: declaration,
        }),
      ).toEqual({
        features: {
          'web-push': { state: 'unknown' },
          scheduler: { state: 'unknown' },
        },
      });
    },
  );
});
