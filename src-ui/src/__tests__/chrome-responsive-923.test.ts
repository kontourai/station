import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const ui = join(process.cwd(), 'src-ui', 'src');
const activeIdentity = readFileSync(
  join(ui, 'components', 'chat-dock', 'ChatDockActiveIdentity.tsx'),
  'utf8',
);
const occupantPicker = readFileSync(
  join(ui, 'workspace-panes', 'DockOccupantPicker.tsx'),
  'utf8',
);
const detailHeaderCss = readFileSync(
  join(ui, 'components', 'DetailHeader.css'),
  'utf8',
);
const sidebarHeader = readFileSync(
  join(ui, 'components', 'project-sidebar', 'ProjectSidebarHeader.tsx'),
  'utf8',
);

describe('station#923 responsive chrome contract', () => {
  test('Copy ID stays a quiet 44px utility at narrow and mid widths', () => {
    expect(activeIdentity).toContain('minWidth: 44');
    expect(activeIdentity).toContain('minHeight: 44');
    expect(activeIdentity).toContain("fontSize: 'var(--text-xs)'");
    expect(activeIdentity).toContain('chat-dock__icon-btn');
  });

  test('shared detail chrome owns an explicit tablet action row', () => {
    expect(detailHeaderCss).toContain(
      '@media (min-width: 769px) and (max-width: 1180px)',
    );
    expect(detailHeaderCss).toContain('flex-basis: 100%');
    expect(detailHeaderCss).toContain('min-height: 44px');
  });

  test('the channel lockup stacks independently of the logo', () => {
    expect(sidebarHeader).toContain("flexDirection: 'column'");
    expect(sidebarHeader).toContain("alignItems: 'flex-start'");
    expect(sidebarHeader).toContain('marginTop: 2');
  });

  test('the Chat picker caret shares the label centerline', () => {
    expect(occupantPicker).toContain("display: 'inline-flex'");
    expect(occupantPicker).toContain("alignItems: 'center'");
    expect(occupantPicker).toContain('lineHeight: 1');
  });
});
