import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

// The production Run setup and approval picker, opened from their real
// triggers in a chat column that has panes on both sides, as on a wide
// desktop window.
const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {DialogHistoryHostBoundary} from './src-ui/src/components/DialogHistoryHost';
import {AccountPreferencesContext} from './src-ui/src/contexts/AccountPreferencesContext';
import {ComposerRunControl} from './src-ui/src/components/ComposerRunControl';
import {ApprovalModeChip} from './src-ui/src/components/badges/ApprovalModeChip';
import {ENGINE_CAPABILITY_MATRICES} from '@kontourai/station-contracts/engine-capability-matrix';
const account = {status:'account', saving:false, retrying:false, waitingForConnection:false, error:false, conflict:false, save(){}, retry(){}, data:{values:{}}};
function Host() {
  return <div style={{display:'flex',height:'100vh',background:'var(--bg-secondary)'}}>
    <aside style={{flex:'0 0 30%',borderRight:'1px solid var(--border-primary)'}}>Inbox</aside>
    <main style={{flex:'1 1 auto',display:'flex',flexDirection:'column',justifyContent:'flex-end',minWidth:0}}>
      <div className="chat-input" data-popover-boundary="" data-testid="composer"
        style={{display:'flex',justifyContent:'flex-end',padding:12,border:'1px solid var(--border-primary)'}}>
        {/* The trigger at the column's trailing edge, as in the composer's
            toolbar: a panel aligned to its left would overrun the column. */}
        <div style={{width:200,marginLeft:'auto'}}>
        <ComposerRunControl label="Claude Code · Opus 5.5" icon={null}>
          <ApprovalModeChip engineConnectionId="claude"
            toolPolicyDelivery={ENGINE_CAPABILITY_MATRICES.claude.toolPolicy}
            sessionOverride="never" lastAppliedApprovalMode="never" onChange={()=>{}} />
        </ComposerRunControl>
        </div>
      </div>
    </main>
    <aside data-testid="right-panel" style={{flex:'0 0 22%',borderLeft:'1px solid var(--border-primary)'}}>Agents</aside>
  </div>;
}
createRoot(document.getElementById('root')).render(
  <DialogHistoryHostBoundary><AccountPreferencesContext.Provider value={account}><Host/></AccountPreferencesContext.Provider></DialogHistoryHostBoundary>);
`;

test('the approval picker replaces Run setup and stays inside the chat column on a wide window', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(fixture);
  try {
    await page.addStyleTag({
      content:
        resolveCssImports(resolve(import.meta.dirname, '../index.css')) +
        resolveCssImports(
          resolve(import.meta.dirname, '../components/chat/chat.css'),
        ),
    });
    const out = resolve('.kontourai/shell-chrome');
    mkdirSync(out, { recursive: true });
    const shots: Array<[number, 'dark' | 'light']> = [
      [2000, 'dark'],
      [1440, 'dark'],
      [1440, 'light'],
      [390, 'dark'],
    ];
    for (const [width, theme] of shots) {
      await page.evaluate(
        (value) => document.documentElement.setAttribute('data-theme', value),
        theme,
      );
      await page.setViewportSize({ width, height: 1100 });
      await page.getByTestId('run-setup-trigger').click();
      const runSetup = page.getByRole('dialog', {
        name: 'Agent & model',
      });
      await runSetup.waitFor();
      const approval = runSetup.getByRole('button', {
        name: /^Approval mode:.*Full access/,
      });
      const mark = await approval
        .locator('.composer-choice__safety')
        .boundingBox();
      const label = await approval
        .locator('.chat-input__chip-stack')
        .boundingBox();
      expect(mark).not.toBeNull();
      expect(label).not.toBeNull();
      expect(mark!.x + mark!.width).toBeLessThanOrEqual(label!.x);
      await approval.click({ force: width === 390 });
      const sheet = page.getByRole('dialog', { name: 'Approval mode' });
      await sheet.getByRole('radiogroup').waitFor();
      await page.evaluate(() =>
        Promise.all(document.getAnimations().map((a) => a.finished)),
      );
      await page.screenshot({ path: `${out}/approval-${width}-${theme}.png` });
      if (width >= 1440) {
        const geometry = await page.evaluate(() => {
          const box = (el: Element) => el.getBoundingClientRect();
          const run = document.querySelector('.composer-run-panel')!;
          const sheetPanel = document.querySelector('.composer-mode-sheet')!;
          const composer = document.querySelector('[data-testid="composer"]')!;
          const option = [
            ...document.querySelectorAll('.composer-mode-sheet__option'),
          ];
          const centre = (el: Element) => {
            const r = box(el);
            return r.top + r.height / 2;
          };
          return {
            runVisibility: getComputedStyle(run).visibility,
            sheet: box(sheetPanel).toJSON(),
            composer: box(composer).toJSON(),
            glyphOffsets: option.map((row) =>
              Math.abs(
                centre(
                  row.querySelector('.composer-mode-sheet__option-glyph')!,
                ) - centre(row.querySelector('strong')!),
              ),
            ),
            checkboxBox: box(
              document.querySelector(
                '.composer-mode-sheet__save-default .cb__box',
              )!,
            ).toJSON(),
            checkboxRow: box(
              document.querySelector('.composer-mode-sheet__save-default')!,
            ).toJSON(),
          };
        });
        const where = `${width}px ${theme}`;
        // One surface: Run setup is hidden while the picker is open.
        expect(geometry.runVisibility, where).toBe('hidden');
        // Inside the chat column, not over the panes beside it.
        expect(geometry.sheet.left, where).toBeGreaterThanOrEqual(
          geometry.composer.left - 0.5,
        );
        expect(geometry.sheet.right, where).toBeLessThanOrEqual(
          geometry.composer.right + 0.5,
        );
        expect(geometry.sheet.width, where).toBeLessThanOrEqual(340);
        // Each option's icon sits on its title's line.
        for (const offset of geometry.glyphOffsets)
          expect(offset, where).toBeLessThanOrEqual(2);
        // A real checkbox, on a row tall enough to hit.
        expect(geometry.checkboxBox.width, where).toBe(18);
        expect(geometry.checkboxRow.height, where).toBeGreaterThanOrEqual(36);
      }
      // Escape goes back to Run setup, with focus on the chip it opened from,
      // so a second Escape closes Run setup too.
      await page.keyboard.press('Escape');
      await sheet.waitFor({ state: 'hidden' });
      await expect
        .poll(() =>
          page.evaluate(() =>
            document.activeElement?.getAttribute('aria-label')?.slice(0, 14),
          ),
        )
        .toBe('Approval mode:');
      await page.keyboard.press('Escape');
      await page
        .getByRole('dialog', { name: 'Agent & model' })
        .waitFor({ state: 'hidden' });
    }
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
  // Four renders of a real bundle; slow on a loaded host.
}, 120_000);

test('the Codex reviewer disclosure is visible and keyboard-accessible in the approval sheet', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(`
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {DialogHistoryHostBoundary} from './src-ui/src/components/DialogHistoryHost';
    import {ApprovalModeChip} from './src-ui/src/components/badges/ApprovalModeChip';
    createRoot(document.getElementById('root')).render(
      <DialogHistoryHostBoundary><ApprovalModeChip engineConnectionId="codex"
        sessionOverride="ask" lastAppliedApprovalMode="ask"
        reportedApprovalReviewer="automatic" onChange={()=>{}} />
      </DialogHistoryHostBoundary>);
  `);
  try {
    await page.addStyleTag({
      content: resolveCssImports(resolve(import.meta.dirname, '../index.css')),
    });
    const output = resolve('.kontourai/shell-chrome');
    mkdirSync(output, { recursive: true });
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ['dark', 'light']) {
        await page.evaluate(
          (value) => document.documentElement.setAttribute('data-theme', value),
          theme,
        );
        const trigger = page.getByRole('button', {
          name: /^Approval mode:.*Automatic/,
        });
        await trigger.press('Enter');
        const sheet = page.getByRole('dialog', { name: 'Approval mode' });
        const disclosure = sheet.getByText(
          'Codex approval reviewer: Automatic.',
        );
        await disclosure.waitFor({ state: 'visible' });
        await page.evaluate(() =>
          Promise.all(
            document.getAnimations().map((animation) => animation.finished),
          ),
        );
        const box = await disclosure.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        await page.screenshot({
          path: `${output}/codex-reviewer-${width}-${theme}.png`,
        });
        await page.keyboard.press('Escape');
        await sheet.waitFor({ state: 'hidden' });
        await expect
          .poll(() =>
            trigger.evaluate((element) => element === document.activeElement),
          )
          .toBe(true);
      }
    }
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
