// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest';
import {
  BOOT_INTERNAL_SECRET_ENV_KEYS,
  childProcessEnvironment,
  scrubBootInternalSecrets,
} from '../child-process-environment.js';
import { INTERNAL_API_TOKEN_ENV } from '../internal-api-token.js';

const UI_BOOTSTRAP_TOKEN_ENV = 'STATION_UI_BOOTSTRAP_TOKEN';

describe('childProcessEnvironment', () => {
  const priorToken = process.env[INTERNAL_API_TOKEN_ENV];
  const priorBootstrap = process.env[UI_BOOTSTRAP_TOKEN_ENV];

  afterEach(() => {
    if (priorToken === undefined) delete process.env[INTERNAL_API_TOKEN_ENV];
    else process.env[INTERNAL_API_TOKEN_ENV] = priorToken;
    if (priorBootstrap === undefined)
      delete process.env[UI_BOOTSTRAP_TOKEN_ENV];
    else process.env[UI_BOOTSTRAP_TOKEN_ENV] = priorBootstrap;
  });

  it('enumerates the boot-internal secrets lifecycle injects', () => {
    expect([...BOOT_INTERNAL_SECRET_ENV_KEYS]).toEqual([
      INTERNAL_API_TOKEN_ENV,
      UI_BOOTSTRAP_TOKEN_ENV,
    ]);
  });

  it('scrubs the internal API token and UI-bootstrap token from a copy', () => {
    process.env[INTERNAL_API_TOKEN_ENV] = 'server-internal-token';
    process.env[UI_BOOTSTRAP_TOKEN_ENV] = 'server-bootstrap-token';
    const env = childProcessEnvironment({ KEEP: 'yes' });
    expect(env.KEEP).toBe('yes');
    expect(env).not.toHaveProperty(INTERNAL_API_TOKEN_ENV);
    expect(env).not.toHaveProperty(UI_BOOTSTRAP_TOKEN_ENV);
    expect(process.env[INTERNAL_API_TOKEN_ENV]).toBe('server-internal-token');
  });

  it('does not let extra re-inject a boot-internal secret', () => {
    const env = childProcessEnvironment({
      [INTERNAL_API_TOKEN_ENV]: 'injected-from-child-request',
      [UI_BOOTSTRAP_TOKEN_ENV]: 'injected-bootstrap',
    });
    expect(
      env,
      'STATION_INTERNAL_API_TOKEN survived childProcessEnvironment',
    ).not.toHaveProperty(INTERNAL_API_TOKEN_ENV);
    expect(env).not.toHaveProperty(UI_BOOTSTRAP_TOKEN_ENV);
  });

  it('scrubBootInternalSecrets copies and deletes without touching the source', () => {
    const source = {
      SAFE: '1',
      [INTERNAL_API_TOKEN_ENV]: 'secret',
    };
    const scrubbed = scrubBootInternalSecrets(source);
    expect(scrubbed.SAFE).toBe('1');
    expect(scrubbed).not.toHaveProperty(INTERNAL_API_TOKEN_ENV);
    expect(source[INTERNAL_API_TOKEN_ENV]).toBe('secret');
  });
});
