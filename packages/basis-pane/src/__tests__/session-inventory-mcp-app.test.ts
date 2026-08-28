// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { renderSessionInventoryDom } from '../session-inventory-dom';
import { buildStationSessionInventoryMcpAppResource } from '../session-inventory-mcp-app';
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

  test('renders owner and derived Attention gaps plus owner-derived current/kept labels inertly', () => {
    projection.version = 'station.session-inventory/v2';
    projection.groups.splice(2, 0, {
      id: 'work-items',
      owner: { owner: 'station.session-work-items', id: 'v1' },
      state: 'empty',
      count: { kind: 'exact', value: 0 },
      items: [],
      gaps: [],
    });
    projection.groups[0].gaps = [{ kind: 'unavailable' }];
    projection.groups[0].items[0].attachmentDescriptors = [
      {
        kind: 'attachment',
        name: '<script>hostile gap witness</script>\u202e',
        mediaType: 'text/plain',
        length: 1,
      },
    ];
    const keptGroup = projection.groups.find(
      (group: any) => group.id === 'kept',
    )!;
    keptGroup.state = 'available';
    keptGroup.count = { kind: 'exact', value: 1 };
    keptGroup.items = [
      {
        kind: 'task-kept-result',
        key: 'kept-result',
        owner: { owner: 'task', id: 'fixture' },
        relations: ['kept-in-task'],
        taskId: 'task',
        provenanceSessionId: 'session',
        referenceId: 'result',
      },
    ];
    const model = buildSessionInventoryViewModel(
      projection,
      { scope: projection.scope, groupId: 'inputs' },
      'full',
    );
    const hostileGap = '<img src=x onerror=alert(1)>\u202e';
    const root = document.createElement('section');
    renderSessionInventoryDom(root, {
      ...model,
      groups: model.groups.map((group) =>
        group.id === 'inputs'
          ? { ...group, gaps: [...group.gaps, hostileGap] }
          : group,
      ),
    });
    expect(
      root.querySelector('[data-group-id="inputs"]')?.textContent,
    ).toContain('This owner is unavailable.');
    expect(root.textContent).toContain(
      'Authored message — Context from this Session; Current context',
    );
    expect(root.textContent).toContain(hostileGap);
    expect(root.querySelectorAll('a,img,script')).toHaveLength(0);
    const attention = document.createElement('section');
    renderSessionInventoryDom(
      attention,
      buildSessionInventoryViewModel(
        projection,
        { scope: projection.scope, groupId: 'attention' },
        'full',
      ),
    );
    expect(attention.textContent).toContain(
      'Some owner context needs attention.',
    );
    const kept = document.createElement('section');
    renderSessionInventoryDom(
      kept,
      buildSessionInventoryViewModel(
        projection,
        { scope: projection.scope, groupId: 'kept' },
        'full',
      ),
    );
    expect(kept.textContent).toContain(
      'Kept result — Context from this Session; Kept context',
    );
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
