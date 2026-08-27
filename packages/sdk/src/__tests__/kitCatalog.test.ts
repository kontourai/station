import { describe, expect, test } from 'vitest';
import {
  canMaterializeKitProjectLayout,
  type KitLayoutProjection,
  type KitRegistryEntry,
  materializeKitProjectLayout,
} from '../query-domains/catalog';

const entry: KitRegistryEntry = {
  contributionRef: 'knowledge/kit',
  lifecycle: 'installed',
  incarnation: 4,
  experience: {
    status: 'enabled',
    diagnostics: [],
    standardViews: [],
  },
};

const projection: KitLayoutProjection = {
  component: {
    kind: 'mcp-tool-ui',
    ref: 'knowledge-server/read-view',
    resourceUri: 'ui://knowledge/read-view',
    approvalPolicy: 'read-only',
  },
  standardViews: [
    {
      id: 'knowledge-summary',
      kind: 'standard-view',
      projection: 'summary',
      schemaRef: 'https://example.test/schema.json',
      readOnly: true,
    },
  ],
};

describe('portable Kit catalog materialization', () => {
  test('retains the exact MCP component and uses only the inert standard renderer', () => {
    const layout = materializeKitProjectLayout(entry, projection);

    expect(layout).toMatchObject({
      slug: 'kit-knowledge-kit-4',
      type: 'kit-observability',
      config: {
        kit: {
          contributionRef: 'knowledge/kit',
          incarnation: 4,
          standardViews: [
            {
              tabId: 'kit-standard-1',
              projection: 'summary',
              readOnly: true,
            },
          ],
        },
      },
    });
    expect(layout.config.tabs).toEqual([
      {
        id: 'kit-mcp-app',
        label: 'App view',
        description: 'Read-only Kit MCP app view.',
        component: projection.component,
      },
      {
        id: 'kit-standard-1',
        label: 'summary',
        description:
          'Read-only standard view (https://example.test/schema.json).',
        component: { kind: 'builtin-component', name: 'kit-standard-view' },
      },
    ]);
  });

  test('refuses disabled, unnegotiated, and viewless contributions', () => {
    expect(
      canMaterializeKitProjectLayout(
        { ...entry, lifecycle: 'disabled' },
        projection,
      ),
    ).toBe(false);
    expect(
      canMaterializeKitProjectLayout(
        { ...entry, experience: { ...entry.experience, status: 'disabled' } },
        projection,
      ),
    ).toBe(false);
    expect(canMaterializeKitProjectLayout(entry, { standardViews: [] })).toBe(
      false,
    );
  });
});
