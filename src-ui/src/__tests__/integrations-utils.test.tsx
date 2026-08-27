/**
 * @vitest-environment jsdom
 */

import type { IntegrationViewModel } from '@kontourai/station-sdk';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, test } from 'vitest';
import {
  filterIntegrationItems,
  formForSelectedIntegration,
  formToMcpJson,
  parseMcpJson,
} from '../views/integrations/utils';

const baseIntegration: IntegrationViewModel = {
  id: 'docs',
  kind: 'mcp',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@example/server'],
  env: { TOKEN: 'abc' },
  displayName: 'Docs Server',
  description: 'Searches docs',
  connected: true,
  enabled: true,
  probe: {
    ok: true,
    toolCount: 2,
    checkedAt: '2026-08-14T18:00:00.000Z',
  },
};

describe('integrations utils', () => {
  test('never renders a prior secret-bearing form for a changed selection', () => {
    expect(formForSelectedIntegration('other', baseIntegration)).toBeNull();
    expect(formForSelectedIntegration('docs', baseIntegration)).toBe(
      baseIntegration,
    );
  });

  test('formToMcpJson serializes stdio integration config', () => {
    expect(formToMcpJson(baseIntegration)).toContain('"mcpServers"');
    expect(formToMcpJson(baseIntegration)).toContain('"command": "npx"');
    expect(formToMcpJson(baseIntegration)).toContain('"TOKEN": "abc"');
  });

  test('parseMcpJson parses mcpServers config back into an integration form', () => {
    const result = parseMcpJson(
      '{\n  "mcpServers": {\n    "docs": {\n      "command": "npx",\n      "args": ["-y", "@example/server"],\n      "env": { "TOKEN": "abc" }\n    }\n  }\n}',
      null,
    );

    expect(result).toEqual({
      error: null,
      form: {
        id: 'docs',
        kind: 'mcp',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@example/server'],
        endpoint: '',
        displayName: 'docs',
        description: '',
        env: { TOKEN: 'abc' },
      },
    });
  });

  test('a redacted raw JSON round-trip keeps env omitted instead of clearing stored secrets', () => {
    const redacted: IntegrationViewModel = {
      ...baseIntegration,
      env: undefined,
      requiresEnvSecrets: true,
    };

    const result = parseMcpJson(formToMcpJson(redacted), redacted);

    expect(result.error).toBeNull();
    expect(result.form).not.toHaveProperty('env');
  });

  test('filterIntegrationItems filters by display name and description', () => {
    const items = filterIntegrationItems(
      [
        baseIntegration,
        {
          ...baseIntegration,
          id: 'db',
          displayName: 'Database Server',
          description: 'Accesses postgres',
          connected: false,
        },
      ],
      'postgres',
    );

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('db');
  });

  test('filterIntegrationItems keeps connectivity visible alongside the new glyph icon', () => {
    const [connectedItem] = filterIntegrationItems([baseIntegration], '');
    const { container: connectedContainer } = render(
      connectedItem.icon as ReactElement,
    );
    expect(
      connectedContainer.querySelector('.status-dot--connected'),
    ).toBeTruthy();
    // The glyph (manifest icon absent for baseIntegration) still renders
    // deterministic initials, not just the bare status dot.
    expect(connectedContainer.textContent).toBe('DS');

    const [disconnectedItem] = filterIntegrationItems(
      [
        {
          ...baseIntegration,
          connected: false,
          probe: {
            ok: false,
            error: 'connection refused',
            toolCount: 0,
            checkedAt: '2026-08-14T18:00:00.000Z',
          },
        },
      ],
      '',
    );
    const { container: disconnectedContainer } = render(
      disconnectedItem.icon as ReactElement,
    );
    expect(
      disconnectedContainer.querySelector('.status-dot--disconnected'),
    ).toBeTruthy();
  });

  test('names disabled, failed, and never-probed health without fabricating green', () => {
    const items = filterIntegrationItems(
      [
        { ...baseIntegration, id: 'disabled', enabled: false },
        {
          ...baseIntegration,
          id: 'failed',
          probe: {
            ok: false,
            error: 'verbatim failure',
            toolCount: 0,
            checkedAt: '2026-08-14T18:00:00.000Z',
          },
        },
        { ...baseIntegration, id: 'unknown', probe: undefined },
      ],
      '',
    );
    expect(items.map((item) => item.subtitle)).toEqual([
      'Disabled · Searches docs',
      'Needs attention · verbatim failure · Searches docs',
      'Never probed · Searches docs',
    ]);
  });

  test('filterIntegrationItems renders the manifest icon over initials when declared', () => {
    const [item] = filterIntegrationItems(
      [{ ...baseIntegration, icon: '📋' }],
      '',
    );
    const { container } = render(item.icon as ReactElement);
    expect(container.textContent).toBe('📋');
  });
});
