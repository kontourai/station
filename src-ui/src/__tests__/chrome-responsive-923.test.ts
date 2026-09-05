import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const ui = join(process.cwd(), 'src-ui', 'src');
const activeIdentity = readFileSync(
  join(ui, 'components', 'chat-dock', 'ChatDockActiveIdentity.tsx'),
  'utf8',
);
const indexCss = readFileSync(join(ui, 'index.css'), 'utf8');
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
  /**
   * #923's subject MOVED. "Copy ID" was a 44px inline-styled button inside the
   * dock's identity row; #1536 F made it "Copy thread ID", a row of the header's
   * More menu, because in the bar it was competing with the conversation title
   * for the same pixels. So the contract is re-homed rather than deleted: the
   * quiet-utility geometry is the shared `.dock-placement-menu__item`
   * treatment now — one row family for every folded command in that bar,
   * instead of a control with its own inline dimensions.
   *
   * WHAT THIS DOES NOT CLAIM: 32px is a fine-pointer row, not a 44px touch
   * target. A phone renders `ChatDockMobileHeader` and its own overflow sheet,
   * so the finger case #923 sized for is not this menu — but a COARSE device
   * too wide to be mobile (a tablet in landscape) does reach these rows by
   * touch at 32px. That is a pre-existing property of this family (the dock
   * placement menu has always been 32px there) which #1536 F now shares with
   * six more commands, and it is left as a disclosed gap rather than closed
   * here: index.css may only carry `MOBILE_MEDIA_QUERY`'s exact condition
   * (`useIsMobile.test.tsx` computes that, deliberately, so component behaviour
   * and stylesheet cannot diverge on the breakpoint), and that condition does
   * not describe a 1180px tablet.
   */
  test('the Copy thread ID control keeps a quiet shared-row geometry in its new home', () => {
    const rowRule = /\.dock-placement-menu__item\s*\{([^}]*)\}/.exec(
      indexCss,
    )?.[1];
    expect(rowRule).toBeDefined();
    expect(rowRule).toMatch(/min-height:\s*32px/);
    expect(rowRule).toMatch(/font:\s*inherit/);
    // And the row really is where that control lives now.
    expect(
      readFileSync(
        join(ui, 'components', 'chat-dock', 'useDockCopyActions.ts'),
        'utf8',
      ),
    ).toContain("label: 'Copy thread ID'");
  });

  test('the identity row it left carries no bespoke inline-styled utility', () => {
    // The shape #923 was about: a one-off control sized by inline styles in the
    // middle of a row whose flexible element is the conversation title.
    expect(activeIdentity).not.toContain('minWidth: 44');
    expect(activeIdentity).not.toContain('minHeight: 44');
    expect(activeIdentity).not.toContain('Copy thread ID');
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
