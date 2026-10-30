import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { installRegistryIntegration } from '../../services/plugins/install-registry-integration.js';
import {
  FileSecretBindingAdministration,
  SecretBindingIntegrationService,
} from '../../services/secrets/secret-binding-administration.js';
import { ConfigLoader } from '../config-loader.js';
import {
  isReservedIntegrationSidecarName,
  readIntegrationInstanceId,
} from '../config-loader-storage.js';

/**
 * #4279 round 2: the OAuth client-secret invariants live in the storage
 * writer every path shares, so writers that call ConfigLoader directly
 * (registry install and import) cannot move a bound secret to another
 * authorization server or endpoint.
 */

const makeTempDir = trackTempDirs();
const HONEST = 'https://accounts.honest.example';
const ATTACKER = 'https://attacker-as.example';
const ID = 'mail';

const remote = (extra: Partial<ToolDef> = {}): ToolDef => ({
  id: ID,
  kind: 'mcp',
  transport: 'streamable-http',
  endpoint: 'https://mcp.honest.example/mcp',
  ...extra,
});

async function boundIntegration() {
  const home = makeTempDir('station-oauth-invariants-');
  const loader = new ConfigLoader({ projectHomeDir: home });
  await loader.saveIntegration(
    ID,
    remote({ oauthClient: { clientId: 'client-a', issuer: HONEST } }),
  );
  const bindings = new FileSecretBindingAdministration(home, {
    environment: { MAIL_SECRET: 'never-read-here' },
  });
  const created = await bindings.create({
    id: 'mail-secret',
    name: 'Mail client secret',
    authRef: { env: 'MAIL_SECRET' },
  });
  const outcome = await new SecretBindingIntegrationService(
    bindings,
    loader,
  ).bindOAuthClientSecret({
    id: created.id,
    integrationId: ID,
    expectedRevision: created.revision,
  });
  expect(outcome.outcome).toBe('complete');
  const path = join(home, 'integrations', ID, 'integration.json');
  return { home, loader, path, bytes: () => readFileSync(path, 'utf8') };
}

const registryInstalling = (definition: ToolDef) =>
  ({
    installWithDefinition: async () => ({
      result: { success: true },
      definition,
      origin: { kind: 'registry', registryId: 'team' },
    }),
  }) as unknown as Parameters<typeof installRegistryIntegration>[0];

describe('a bound OAuth client secret pins its issuer and endpoint for every writer', () => {
  test.each([
    {
      label: 'a new issuer',
      next: remote({
        oauthClient: {
          clientId: 'client-a',
          issuer: ATTACKER,
          clientSecretRef: 'mail-secret',
        },
      }),
      message: "changing the client's authorization server",
    },
    {
      label: 'a new endpoint',
      next: remote({
        endpoint: 'https://mcp.attacker.example/mcp',
        oauthClient: {
          clientId: 'client-a',
          issuer: HONEST,
          clientSecretRef: 'mail-secret',
        },
      }),
      message: 'changing the integration endpoint',
    },
    {
      label: 'another binding',
      next: remote({
        oauthClient: {
          clientId: 'client-a',
          issuer: HONEST,
          clientSecretRef: 'other-secret',
        },
      }),
      message: 'only through the operator binding API',
    },
  ])(
    'a direct ConfigLoader save with $label keeping the reference is refused',
    async ({ next, message }) => {
      const { loader, bytes } = await boundIntegration();
      const before = bytes();
      await expect(loader.saveIntegration(ID, next)).rejects.toThrow(message);
      await expect(loader.updateIntegration(ID, () => next)).rejects.toThrow(
        message,
      );
      expect(bytes()).toBe(before);
    },
  );

  test('dropping the reference is always allowed', async () => {
    const { loader } = await boundIntegration();
    await loader.saveIntegration(
      ID,
      remote({ oauthClient: { clientId: 'client-a', issuer: ATTACKER } }),
    );
    expect((await loader.loadIntegration(ID)).oauthClient).toEqual({
      clientId: 'client-a',
      issuer: ATTACKER,
    });
  });

  test('no definition is created already bound, and a pre-registered client needs an issuer', async () => {
    const home = makeTempDir('station-oauth-invariants-');
    const loader = new ConfigLoader({ projectHomeDir: home });
    await expect(
      loader.saveIntegration(
        ID,
        remote({
          oauthClient: {
            clientId: 'client-a',
            issuer: HONEST,
            clientSecretRef: 'mail-secret',
          },
        }),
      ),
    ).rejects.toThrow('only through the operator binding API');
    await expect(
      loader.saveIntegration(ID, remote({ oauthClient: { clientId: 'c' } })),
    ).rejects.toThrow("needs its authorization server's issuer");
  });

  test('the registry install helper refuses to replace a bound source, even one naming the same binding', async () => {
    const { loader, bytes } = await boundIntegration();
    const before = bytes();
    const result = await installRegistryIntegration(
      registryInstalling(
        remote({
          endpoint: 'https://mcp.attacker.example/mcp',
          oauthClient: {
            clientId: 'client-a',
            issuer: ATTACKER,
            clientSecretRef: 'mail-secret',
          },
        }),
      ),
      loader,
      ID,
      'team',
    );
    expect(result.success).toBe(false);
    expect(bytes()).toBe(before);
  });

  test('a registry definition never authors a client-secret reference', async () => {
    const home = makeTempDir('station-oauth-invariants-');
    const loader = new ConfigLoader({ projectHomeDir: home });
    const result = await installRegistryIntegration(
      registryInstalling(
        remote({
          oauthClient: {
            clientId: 'client-a',
            issuer: HONEST,
            clientSecretRef: 'mail-secret',
          },
        }),
      ),
      loader,
      ID,
      'team',
    );
    expect(result.success).toBe(true);
    expect((await loader.loadIntegration(ID)).oauthClient).toEqual({
      clientId: 'client-a',
      issuer: HONEST,
    });
  });
});

describe("Station's integration sidecars cannot be supplied under another spelling", () => {
  test.each([
    ['.station-instance', true],
    ['.STATION-INSTANCE', true],
    ['.Station-OAuth-Issuer', true],
    // Fullwidth letters and dot fold to the same name under NFKC.
    ['．station-instance', true],
    ['.ｓｔａｔｉｏｎ-oauth-issuer', true],
    ['.station-instance.bak', false],
    ['station-instance', false],
    ['integration.json', false],
  ])('%s reserved: %s', (name, reserved) => {
    expect(isReservedIntegrationSidecarName(name)).toBe(reserved);
  });

  test('a differently cased sidecar on disk is not trusted, and the writer replaces it with its own', async () => {
    const home = makeTempDir('station-oauth-sidecar-case-');
    const loader = new ConfigLoader({ projectHomeDir: home });
    await loader.saveIntegration(ID, remote());
    const dir = join(home, 'integrations', ID);
    const real = readFileSync(join(dir, '.station-instance'), 'utf8');
    rmSync(join(dir, '.station-instance'));
    const forged = '0f6c2d8e-6a51-4b7e-9d1c-2f3a4b5c6d7e';
    writeFileSync(join(dir, '.STATION-INSTANCE'), forged);
    expect(readIntegrationInstanceId(home, ID)).toBeUndefined();

    const minted = await loader.integrationInstanceId(ID);
    expect(minted).not.toBe(forged);
    expect(minted).not.toBe(real);
    expect(readdirSync(dir).filter(isReservedIntegrationSidecarName)).toEqual([
      '.station-instance',
    ]);
    expect(readIntegrationInstanceId(home, ID)).toBe(minted);
  });
});
