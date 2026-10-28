import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../config-loader.js';
import {
  readStoredIntegrations,
  recordCopiedIntegrations,
  saveIntegrationConfig,
} from '../config-loader-storage.js';

/**
 * #3483: untrusted-content receipts are owned by the locked storage writer,
 * so every integration writer (ConfigLoader, a plugin's required-tool
 * install, a plugin's copied integrations) keeps history, drops forged
 * receipts and records a changed classification.
 */
const makeTempDir = trackTempDirs();
const def: ToolDef = {
  id: 'mail',
  kind: 'mcp',
  transport: 'streamable-http',
  endpoint: 'https://mail.example.test/mcp',
};
const FORGED = [{ at: '2000-01-01T00:00:00.000Z', by: 'forged' }];
const stored = (home: string) =>
  JSON.parse(
    readFileSync(
      join(home, 'integrations', 'mail', 'integration.json'),
      'utf8',
    ),
  ) as ToolDef;

describe('integration untrusted-content receipts', () => {
  test('a direct storage write (required-tool install) drops forged receipts and records the classification', async () => {
    const home = makeTempDir('station-receipts-');
    await saveIntegrationConfig(home, 'mail', {
      ...def,
      contentTrust: 'untrusted',
      untrustedContentChanges: FORGED,
    });
    expect(stored(home).untrustedContentChanges).toEqual([
      { at: expect.any(String), contentTrust: 'untrusted' },
    ]);
  });

  test('a plugin copy keeps the history it replaces and records a flipped classification', async () => {
    const home = makeTempDir('station-receipts-');
    await saveIntegrationConfig(home, 'mail', {
      ...def,
      contentTrust: 'untrusted',
    });
    const before = stored(home).untrustedContentChanges;
    const replaced = readStoredIntegrations(home, ['mail', 'absent']);
    // The copy overwrites the file with the plugin's own bytes: forged
    // receipts and the classification flipped off.
    writeFileSync(
      join(home, 'integrations', 'mail', 'integration.json'),
      JSON.stringify({
        ...def,
        contentTrust: 'trusted',
        untrustedContentChanges: FORGED,
      }),
    );
    await recordCopiedIntegrations(home, ['mail'], replaced);
    expect(stored(home).untrustedContentChanges).toEqual([
      ...before!,
      { at: expect.any(String), contentTrust: 'trusted' },
    ]);
  });

  test('concurrent saves through the loader keep every receipt', async () => {
    const home = makeTempDir('station-receipts-');
    const loader = new ConfigLoader({ projectHomeDir: home });
    await loader.saveIntegration('mail', { ...def, contentTrust: 'untrusted' });
    await Promise.all([
      loader.saveIntegration(
        'mail',
        {
          ...def,
          contentTrust: 'untrusted',
          untrustedContentPermissions: { default: 'deny' },
        },
        { changedBy: 'person-1' },
      ),
      loader.saveIntegration(
        'mail',
        { ...def, contentTrust: 'trusted' },
        { changedBy: 'person-2' },
      ),
    ]);
    const changes = stored(home).untrustedContentChanges ?? [];
    expect(changes).toHaveLength(3);
    expect(
      changes
        .map((change) => change.by)
        .slice(1)
        .sort(),
    ).toEqual(['person-1', 'person-2']);
  });
});
