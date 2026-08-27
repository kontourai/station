import { isSafeToolServerCredentialKey } from '@kontourai/station-contracts/tool';
import { describe, expect, test } from 'vitest';
import { validator } from '../validator.js';

describe('canonical tool schema credential names', () => {
  const base = { id: 'schema-proof', kind: 'mcp' as const };

  test.each(['', '__proto__', 'constructor', 'prototype'])(
    'rejects runtime-invalid credential name %j on every credential-name surface',
    (name) => {
      expect(isSafeToolServerCredentialKey(name)).toBe(false);
      for (const candidate of [
        { ...base, env: { [name]: 'secret' } },
        { ...base, secretEnv: { [name]: 'secret' } },
        { ...base, storedEnvNames: [name] },
        { ...base, requiredEnvNames: [name] },
        { ...base, removeSecretEnvKeys: [name] },
      ]) {
        expect(validator.tryValidateToolDef(candidate).valid).toBe(false);
      }
    },
  );

  test('accepts the same structural credential names as the runtime store', () => {
    const name = 'vendor.token/path';
    expect(isSafeToolServerCredentialKey(name)).toBe(true);
    expect(
      validator.tryValidateToolDef({
        ...base,
        env: { [name]: 'secret' },
        storedEnvNames: [name],
      }).valid,
    ).toBe(true);
  });

  test('admits bounded internal binding references without widening public credential names', () => {
    expect(
      validator.tryValidateToolDef({
        ...base,
        secretEnvRefs: { TOKEN: 'github-token' },
      }).valid,
    ).toBe(true);
    expect(
      validator.tryValidateToolDef({
        ...base,
        secretEnvRefs: { 'not a process env': 'github-token' },
      }).valid,
    ).toBe(false);
    expect(
      validator.tryValidateToolDef({
        ...base,
        secretEnvRefs: { TOKEN: 'not_a_binding_id' },
      }).valid,
    ).toBe(false);
  });
});
