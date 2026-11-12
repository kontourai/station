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

  test('filterIntegrationItems shows status as a badge beside the glyph, never as a bare dot', () => {
    const [item] = filterIntegrationItems([baseIntegration], '');
    const { container: icon } = render(item.icon as ReactElement);
    // The glyph (manifest icon absent for baseIntegration) renders
    // deterministic initials; status is no longer a dot on it.
    expect(icon.textContent).toBe('DS');
    expect(icon.querySelector('.status-dot')).toBeNull();
    const { container: badge } = render(item.badge as ReactElement);
    expect(badge.querySelector('.resource-status__badge')?.textContent).toBe(
      'Ready',
    );
  });

  test('names disabled, failed, sign-in and never-probed status without fabricating green', () => {
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
        {
          ...baseIntegration,
          id: 'oauth',
          transport: 'streamable-http',
          probe: {
            ok: false,
            toolCount: 0,
            checkedAt: '2026-08-14T18:00:00.000Z',
            authorization: { state: 'awaiting-operator-consent' },
          },
        },
        { ...baseIntegration, id: 'unknown', probe: undefined },
      ],
      '',
    );
    const labels = items.map(
      (item) =>
        render(item.badge as ReactElement).container.querySelector(
          '.resource-status__badge',
        )?.textContent,
    );
    expect(labels).toEqual([
      'Disabled',
      'Check failed',
      'Sign in required',
      'Saved — not verified',
    ]);
    // The failure reason travels with the badge, read once.
    expect(
      render(items[1]!.badge as ReactElement).container.textContent,
    ).toContain('verbatim failure');
  });

  test('rows carry tool count, last probe and how many select the server', () => {
    const counts: Record<string, number> = { docs: 2, db: 0 };
    const items = filterIntegrationItems(
      [
        baseIntegration,
        { ...baseIntegration, id: 'db' },
        { ...baseIntegration, id: 'x' },
      ],
      '',
      (id) => counts[id] ?? null,
    );
    expect(items.map((item) => item.subtitle)).toEqual([
      `2 tools, checked ${new Date('2026-08-14T18:00:00.000Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · Used by 2`,
      expect.stringMatching(/ · Not used yet$/),
      // Unknown (loading, failed or withheld): no used-by claim at all.
      expect.not.stringMatching(/Used by|Not used/),
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
