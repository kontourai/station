import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, test } from 'vitest';
import {
  AGENT_PLUGIN_MANIFEST_SCHEMA_1_0,
  AGENT_PLUGIN_MCP_SCHEMA_1_0,
  isAgentPluginName,
  STATION_AGENT_PLUGIN_EXTENSION_ID,
} from '../agent-plugin.js';
import { isCanonicalPluginId } from '../plugin.js';

describe('Agent Plugins 1.0 identity contract', () => {
  test('pins the published portable schemas and Station namespace', () => {
    expect(AGENT_PLUGIN_MANIFEST_SCHEMA_1_0).toBe(
      'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    );
    expect(AGENT_PLUGIN_MCP_SCHEMA_1_0).toBe(
      'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    );
    expect(STATION_AGENT_PLUGIN_EXTENSION_ID).toBe('io.kontourai.station');
  });

  test('uses the Agent Plugins name alphabet at Station storage boundaries', () => {
    for (const name of ['a', 'my-plugin', 'acme.tools', 'lint3r']) {
      expect(isAgentPluginName(name)).toBe(true);
      expect(isCanonicalPluginId(name)).toBe(true);
    }
    for (const name of [
      '',
      'My-Plugin',
      '-start',
      'end-',
      'has--double',
      'too.many..dots',
      'a'.repeat(65),
    ]) {
      expect(isAgentPluginName(name)).toBe(false);
      expect(isCanonicalPluginId(name)).toBe(false);
    }
  });

  test('keeps the Station namespace closed and rejects retired layout keys', () => {
    const schema = JSON.parse(
      readFileSync(
        new URL(
          '../../../../schemas/agent-plugins/io.kontourai.station-1.0.schema.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(
      schema,
    );
    expect(
      validate({
        schemaVersion: '1.0',
        title: 'Acme tools',
        permissions: ['network.fetch'],
        commands: [{ version: '1.0', id: 'acme.tools.open' }],
        dependencies: [{ name: 'acme.shared', version: '^1.0.0' }],
        secretReferences: [{ key: 'api-key', title: 'API key' }],
        workspacePanes: [{ version: '1.0', id: 'home' }],
        providers: [{ type: 'model', module: './provider.js' }],
      }),
    ).toBe(true);
    for (const retired of [
      { schemaVersion: '1.0', layout: {} },
      { schemaVersion: '1.0', layouts: [] },
      {
        schemaVersion: '1.0',
        providers: [
          { type: 'model', module: './provider.js', layout: 'legacy' },
        ],
      },
      {
        schemaVersion: '1.0',
        settings: [
          { key: 'retries', title: 'Retries', type: 'number', default: '3' },
        ],
      },
      {
        schemaVersion: '1.0',
        providers: [
          { type: 'model', module: './provider.js', moduel: './typo.js' },
        ],
      },
      {
        schemaVersion: '1.0',
        secretReferences: [
          { key: 'api-key', title: 'API key', value: 'plaintext' },
        ],
      },
    ]) {
      expect(validate(retired)).toBe(false);
    }
  });
});
