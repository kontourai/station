// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildStationSessionInventoryMcpAppResource } from '../session-inventory-mcp-app';
import { renderSessionInventoryDom } from '../session-inventory-dom';
import { buildSessionInventoryViewModel } from '../session-inventory-view';

const projection: any = {
  version: 'station.session-inventory/v1',
  scope: { kind: 'whole-session', sessionId: 'session' },
  groups: [
    {
      id: 'inputs',
      owner: { owner: 'thread', id: 'inputs' },
      state: 'available',
      count: { kind: 'exact', value: 1 },
      gaps: [],
      items: [
        {
          kind: 'thread-authored-input',
          key: 'input',
          owner: { owner: 'thread', id: 'input' },
          relations: ['observed-during'],
          sessionId: 'session',
          eventId: 'event',
          turnId: 'turn',
          inputKind: 'message',
          attachmentDescriptors: [],
        },
      ],
    },
  ],
};
for (const id of [
  'sources',
  'execution',
  'decisions',
  'outputs',
  'verification-delivery',
  'live-now',
  'kept',
  'attention',
  'resources',
])
  projection.groups.push({
    id,
    owner: { owner: 'station', id },
    state: 'empty',
    count: { kind: 'exact', value: 0 },
    gaps: [],
    items: [],
  });

describe('portable Session inventory MCP App', () => {
  test('keeps compact/full keys and counts identical while rendering inert hostile content', () => {
    projection.groups[0].items[0].attachmentDescriptors = [
      {
        kind: 'attachment',
        name: 'https://host/<script>\u202e',
        mediaType: 'text/html',
        length: 1,
      },
    ];
    const selection = { scope: projection.scope, groupId: 'inputs' as const };
    const compact = buildSessionInventoryViewModel(
      projection,
      selection,
      'compact',
    );
    const full = buildSessionInventoryViewModel(projection, selection, 'full');
    expect(compact.groups.map((group) => [group.key, group.count])).toEqual(
      full.groups.map((group) => [group.key, group.count]),
    );
    const root = document.createElement('section');
    renderSessionInventoryDom(root, compact);
    expect(root.querySelectorAll('a,img,script')).toHaveLength(0);
  });

  test('emits a bounded React-free browser resource and keeps capability/page calls opaque', () => {
    const resource = buildStationSessionInventoryMcpAppResource();
    expect(Buffer.byteLength(resource.text)).toBeLessThanOrEqual(480 * 1024);
    expect(resource.text).not.toMatch(/react|node:|surface-trust-panel/i);
    const source = readFileSync(
      join(import.meta.dirname, '..', 'session-inventory-mcp-app.browser.ts'),
      'utf8',
    );
    expect(source).toContain("name: 'get_session_inventory'");
    expect(source).toContain("operation: 'page'");
    expect(source).toContain("'station.session-inventory-app/v1'");
    expect(source).toContain(
      'buildBasisPanelViewModel(current.projection.basis)',
    );
    expect(source).not.toMatch(/fetch\(|<a|createElement\('a'/);
  });
});
