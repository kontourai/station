/**
 * E2E: agent editor pixel geometry, in a real browser (archive#4521 items
 * 3/4 — the "Agent actions" popover's anchoring, and the header title's
 * truncation).
 *
 * WHY THIS EXISTS AND NOT ONLY A UNIT TEST. jsdom performs no layout — the
 * component-level suite (`AgentsViewEditorPane.readiness-notice.test.tsx`)
 * can only prove the right CSS classes and the right prop are wired; it
 * cannot prove the popover panel actually PAINTS beside its trigger rather
 * than centered mid-screen, or that shortening the caution chip to
 * `agentReadinessCompactState`'s "Not set up" actually FREES enough width
 * for the agent name to render unclipped ("Stati…" was a real pixel
 * measurement of the FULL sentence, not a missing class). Only a real
 * browser can measure that.
 *
 * The subject is the REAL `ResponsiveDialogSurface`, `DetailHeader`,
 * `EngineChip` and `AgentReadinessCell` components, bundled from source with
 * esbuild and mounted in Chromium against the REAL, unmodified CSS files
 * from disk (`editor-layout.css`'s new `agent-actions-overlay`/
 * `agent-actions-panel` rules, `DetailHeader.css`, `EngineChip.css`,
 * `AgentReadinessCell.css`, plus the Console Kit's `StatusBadge` styles the
 * caution chip renders through) — the same technique
 * `banner-stack-bound.spec.ts` and `dialog-return-focus.spec.ts` use to run
 * real source, real CSS, inside a page with no server. Only the surrounding
 * harness markup (a stand-in for `AgentsViewEditorPane`'s own JSX, copied
 * verbatim from it) is synthetic.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { build } from 'esbuild';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CSS_PATHS = [
  'src-ui/src/tokens.css',
  'node_modules/@kontourai/ui/tokens/tokens.css',
  'node_modules/@kontourai/ui/react/styles.css',
  'src-ui/src/index.css',
  'src-ui/src/views/editor-layout.css',
  'src-ui/src/components/DetailHeader.css',
  'src-ui/src/components/badges/EngineChip.css',
  'src-ui/src/components/AgentReadinessCell.css',
].map((relative) => join(REPO_ROOT, relative));

type Scenario = 'popover' | 'title-with-badge' | 'title-with-compact-badge';

const HARNESS_SOURCE = `
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from './src-ui/src/components/ResponsiveDialogSurface';
import { DetailHeader } from './src-ui/src/components/DetailHeader';
import { EngineChip } from './src-ui/src/components/badges/EngineChip';
import { AgentReadinessCell } from './src-ui/src/components/AgentReadinessCell';

/**
 * archive#4521 item 3: the exact "Agent actions" trigger + popover JSX from
 * \`AgentsViewEditorPane\`, copied verbatim (including the
 * \`overlayClassName="agent-actions-overlay" panelClassName="agent-actions-panel"\`
 * wiring this fix added), inside a sticky header at the TOP of a tall page —
 * the real position the trigger sits at.
 */
function PopoverHarness() {
  const [showOverflow, setShowOverflow] = useState(false);
  const overflowTriggerRef = useRef(null);
  return (
    <div id="page" style={{ height: '2400px' }}>
      <div
        className="detail-header"
        style={{ position: 'sticky', top: 0, background: '#fff' }}
      >
        <div className="detail-header__left">
          <div className="detail-header__identity">
            <div className="detail-header__title-row">
              <h2 className="detail-header__title">Station</h2>
            </div>
          </div>
        </div>
        <div className="detail-header__actions">
          <button
            ref={overflowTriggerRef}
            type="button"
            className="editor-btn"
            aria-haspopup="menu"
            aria-expanded={showOverflow}
            onClick={() => setShowOverflow(true)}
          >
            More actions
          </button>
          {showOverflow && (
            <ResponsiveDialogSurface
              ariaLabel="Agent actions"
              onClose={() => setShowOverflow(false)}
              historyMode="none"
              returnFocusTarget={overflowTriggerRef.current}
              anchorRef={overflowTriggerRef}
              overlayClassName="agent-actions-overlay"
              panelClassName="agent-actions-panel"
            >
              <ResponsiveDialogHeader
                title="Agent actions"
                closeLabel="Close agent actions"
                onClose={() => setShowOverflow(false)}
              />
              <div role="menu">
                <button type="button" role="menuitem">Duplicate</button>
                <button type="button" role="menuitem">Delete</button>
              </div>
            </ResponsiveDialogSurface>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * archive#4521 items 1/4: the real \`DetailHeader\` with the real
 * \`titleAccessory\` \`AgentsViewEditorPane\` builds — \`compact\` toggles the
 * SAME prop the real pane always passes now, reproducing the uncompacted
 * header (the badge speaking the full server sentence) against the
 * current one (\`AgentReadinessCell\`'s own \`compact\` form, "Not set up") in
 * the same harness. Both scenarios render the chip — the design ruling that
 * replaced dropping it entirely was that a caution row must still read
 * caution at a glance; what changed is only how much TEXT it carries.
 */
function TitleHarness({ compact }) {
  const agent = {
    slug: 'station',
    name: 'Station',
    available: false,
    unavailableReason: 'No enabled LLM provider connection is configured.',
    unavailableFix: { kind: 'model-connection' },
  };
  return (
    <DetailHeader
      title="Station"
      titleAccessory={
        <>
          <EngineChip engine={{ name: 'Station' }} />
          <AgentReadinessCell agent={agent} part="status" compact={compact} />
        </>
      }
    >
      <button type="button" className="editor-btn">Chat</button>
      <button type="button" className="editor-btn">More actions</button>
      <button
        type="button"
        className="editor-btn editor-btn--primary agent-editor__save-btn"
      >
        Save Changes
      </button>
    </DetailHeader>
  );
}

const scenario = window.__scenario;
const root = document.getElementById('root');
if (scenario === 'popover') {
  createRoot(root).render(<PopoverHarness />);
} else {
  createRoot(root).render(
    <TitleHarness compact={scenario === 'title-with-compact-badge'} />,
  );
}
`;

let harnessScript = '';

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: HARNESS_SOURCE,
      resolveDir: REPO_ROOT,
      loader: 'tsx',
    },
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.css': 'empty' },
    write: false,
    platform: 'browser',
  });
  harnessScript = result.outputFiles[0].text;
  // A bundle that silently resolved to nothing would make every assertion
  // below vacuous.
  expect(harnessScript).toContain('agent-actions-overlay');
});

async function mount(page: Page, scenario: Scenario) {
  await page.setContent(
    `<!doctype html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0">
<div id="root"></div>
</body>
</html>`,
  );
  for (const path of CSS_PATHS) {
    await page.addStyleTag({ path });
  }
  await page.evaluate((name) => {
    (window as unknown as { __scenario: string }).__scenario = name;
  }, scenario);
  await page.addScriptTag({ content: harnessScript });
}

/** The real bundled `.status`/`.tone-caution` StatusBadge, if mounted. */
function statusChip(page: Page) {
  return page.locator('.agent-readiness__status');
}

test.describe('the "Agent actions" popover anchors to its trigger (station#4521 item 3)', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('opens directly below the "More actions" button, not centered mid-screen', async ({
    page,
  }) => {
    await mount(page, 'popover');
    // Scroll the tall page so the sticky trigger sits well below the
    // viewport's own top edge — the failure mode this proves against is a
    // popover that renders relative to the VIEWPORT center rather than the
    // trigger's own position.
    await page.evaluate(() => window.scrollTo(0, 800));

    const trigger = page.getByRole('button', { name: 'More actions' });
    await expect(trigger).toBeVisible();
    const triggerBox = await trigger.boundingBox();
    expect(triggerBox, 'trigger has no box').not.toBeNull();

    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Agent actions' });
    await expect(dialog).toBeVisible();
    const panelBox = await dialog.boundingBox();
    expect(panelBox, 'popover panel has no box').not.toBeNull();

    // Anchored: the panel's own top sits at (or just below) the trigger's
    // bottom edge, not somewhere unrelated to it.
    expect(panelBox!.y).toBeGreaterThanOrEqual(
      triggerBox!.y + triggerBox!.height - 1,
    );
    expect(panelBox!.y).toBeLessThan(triggerBox!.y + triggerBox!.height + 40);

    // Not vertically centered in the viewport (900px tall — a centered
    // dialog, e.g. the un-anchored `Dialog`/`station-dialog` fallback this
    // popover used to render as, would land with its vertical midpoint near
    // y=450). The trigger sits near the top of the (scrolled) viewport, so
    // an anchored popover's midpoint must be well above that.
    const panelMidY = panelBox!.y + panelBox!.height / 2;
    expect(panelMidY).toBeLessThan(450 - 60);

    // Horizontally near the trigger too (clamped to the trigger's right
    // edge — not, say, centered on the viewport's horizontal midpoint).
    expect(
      Math.abs(
        panelBox!.x + panelBox!.width - (triggerBox!.x + triggerBox!.width),
      ),
    ).toBeLessThan(20);
  });
});

test.describe('the header title does not truncate once the caution chip is compacted (station#4521 items 1/4)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('WITH the long-reason badge (the pre-fix shape): the agent name clips', async ({
    page,
  }) => {
    await mount(page, 'title-with-badge');
    await expect(statusChip(page)).toBeVisible();
    expect(await statusChip(page).textContent()).toContain(
      'No enabled LLM provider',
    );
    const title = page.locator('.detail-header__title');
    await expect(title).toBeVisible();
    const overflow = await title.evaluate(
      (el) => el.scrollWidth > el.clientWidth,
    );
    expect(
      overflow,
      'the fixture must reproduce genuine clipping for the fixed case below to prove anything',
    ).toBe(true);
  });

  test('WITH the compact chip (the current header): the chip still reads caution, and "Station" renders in full', async ({
    page,
  }) => {
    await mount(page, 'title-with-compact-badge');
    // The design ruling this replaced "drop the chip entirely" with: the
    // chip still renders — just shortened — so a caution row still reads
    // caution at a glance.
    await expect(statusChip(page)).toBeVisible();
    expect(await statusChip(page).textContent()).toBe('Not set up');
    const title = page.locator('.detail-header__title');
    await expect(title).toBeVisible();
    await expect(title).toHaveText('Station');
    const overflow = await title.evaluate(
      (el) => el.scrollWidth > el.clientWidth,
    );
    expect(overflow, 'the agent name must not be clipped').toBe(false);
  });
});
