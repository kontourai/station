// @vitest-environment jsdom
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
    // Re-grounded 2026-09-11 to the measured resource: the generated bundle
    // grew past the previous 480 KiB pin with #1562's honest basis panes and
    // the @kontourai/surface 3.2.0 bump (#1741). Exact cap: any growth reds
    // here and re-grounding is a conscious act (the #1207 precedent); the
    // runtime guard's last-line ceiling is 640 KiB.
    expect(Buffer.byteLength(resource.text)).toBeLessThanOrEqual(573_335);
    expect(resource.text).not.toMatch(/react|node:|surface-trust-panel/i);
    // The shipped app pages only through the opaque station-control tool
    // capability and never fetches or links on its own.
    expect(resource.text).toMatch(/name:\s*["']get_session_inventory["']/);
    expect(resource.text).toMatch(/operation:\s*["']page["']/);
    expect(resource.text).toContain('station.session-inventory-app/v1');
    expect(resource.text).not.toMatch(
      /<a[\s>]|\bfetch\(|createElement\(["']a["']\)/,
    );
    expect(resource.text).toContain("connect-src 'none'");
    expect(resource._meta.ui.csp.connectDomains).toEqual([]);
  });
});
