import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  readIntegrationOrigin,
  recordIntegrationOrigin,
} from '../integration-origin.js';

const tempDir = trackTempDirs();

describe('integration installation provenance', () => {
  test('retains registry origin for the installed executable and withholds it after execution configuration changes', () => {
    const home = tempDir('tool-origin-');
    const def: ToolDef = {
      id: 'reports',
      kind: 'mcp',
      transport: 'stdio',
      command: 'node',
      args: ['server.mjs'],
    };
    recordIntegrationOrigin(home, def, {
      kind: 'registry',
      registryName: 'Company catalog',
      itemId: 'reports',
      version: '1.0.0',
      location:
        'https://name:secret@registry.example.test/reports?token=private',
    });
    expect(readIntegrationOrigin(home, def)).toEqual({
      kind: 'registry',
      registryName: 'Company catalog',
      itemId: 'reports',
      version: '1.0.0',
      location: 'https://registry.example.test/reports',
    });
    expect(
      readIntegrationOrigin(home, { ...def, args: ['another-server.mjs'] }),
    ).toEqual({ kind: 'unavailable' });
    expect(
      readIntegrationOrigin(home, {
        ...def,
        env: { NODE_OPTIONS: '--import=changed.mjs' },
      }),
    ).toEqual({ kind: 'unavailable' });
    expect(
      readFileSync(join(home, 'integrations/reports/origin.json'), 'utf8'),
    ).not.toMatch(/secret|private/);
    writeFileSync(join(home, 'integrations/reports/origin.json'), '{bad');
    expect(readIntegrationOrigin(home, def)).toEqual({ kind: 'unavailable' });
  });
});
