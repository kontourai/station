import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const ui = join(process.cwd(), 'src-ui', 'src');
const activeIdentity = readFileSync(
  join(ui, 'components', 'chat-dock', 'ChatDockActiveIdentity.tsx'),
  'utf8',
);
const indexCss = readFileSync(join(ui, 'index.css'), 'utf8');
const chatCss = readFileSync(
  join(ui, 'components', 'chat', 'chat.css'),
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
   * quiet-utility geometry is the shared `.menu-row` treatment now — #1552 D4
   * consolidated the shell's four menu vocabularies onto one row class, of which
   * the retired `.dock-placement-menu__item` was one — instead of a control with
   * its own inline dimensions.
   *
   * 32px is that family's FINE-pointer row. The 44px this control owed a finger
   * is a coarse-pointer rule, and it lives in `components/chat/chat.css` rather
   * than the entry sheet for a reason worth recording: `useIsMobile.test.tsx`
   * requires every coarse query in index.css to spell `MOBILE_MEDIA_QUERY`
   * byte-for-byte so the hook and the stylesheet cannot disagree on the
   * breakpoint, and that condition (≤768px, or short-and-coarse) does not
   * describe the 1180px tablet that reaches this menu by touch. chat.css is not
   * bound by that rule and already carries `(pointer: coarse)` touch-target
   * queries (archive#3344). The class is doubled there so it wins on specificity
   * rather than on sheet order. Since D4 that one rule reaches every menu in the
   * shell rather than only the dock's.
   */
  test('the Copy thread ID control keeps a quiet shared-row geometry in its new home', () => {
    const rowRule = /\.menu-row\s*\{([^}]*)\}/.exec(indexCss)?.[1];
    expect(rowRule).toBeDefined();
    expect(rowRule).toMatch(/min-height:\s*32px/);
    expect(rowRule).toMatch(/font:\s*inherit/);
    // The finger's floor, under a coarse query, with the doubled class that
    // makes it independent of which sheet the bundler emits last.
    const coarse =
      /@media \(max-width: 768px\), \(pointer: coarse\) \{\s*\.menu-row\.menu-row\s*\{([^}]*)\}/.exec(
        chatCss,
      )?.[1];
    expect(coarse, 'the coarse-pointer 44px floor in chat.css').toBeDefined();
    expect(coarse).toMatch(/min-height:\s*44px/);
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
});
