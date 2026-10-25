import { type Browser, chromium, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditGalleryScreen } from '../../tests/helpers/gallery-ui-audit';
import {
  HIT_TARGET_AUDIT,
  type HitTargetAudit,
} from '../../tests/helpers/hit-target-audit';

// The gallery's product assertions, run against fixture pages in a real
// Chromium: geometry needs layout, and the axe keys need axe's real selectors.

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  // AxeBuilder requires a page from an explicit context.
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  page = await context.newPage();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

async function render(body: string) {
  await page.setContent(
    `<!doctype html><html lang="en"><head><title>Fixture</title></head><body style="margin:0"><main><div id="root">${body}</div></main></body></html>`,
  );
}

const control = (name: string) =>
  `<button aria-label="${name}" style="display:block;width:60px;height:60px">${name}</button>`;

describe('hit-target audit scrollers', { timeout: 60_000 }, () => {
  async function unreachable(body: string) {
    await render(body);
    const audit = (await page.evaluate(HIT_TARGET_AUDIT)) as HitTargetAudit;
    return audit.unreachable;
  }

  it('A: a control below the fold of a scroller that scrolls is reachable', async () => {
    expect(
      await unreachable(
        `<div style="height:300px;overflow:hidden"><div style="height:300px;overflow:auto"><div style="height:1000px"></div>${control('Case A')}</div></div>`,
      ),
    ).toEqual([]);
  });

  it('B: a control past a hard clip is unreachable', async () => {
    expect(
      await unreachable(
        `<div style="height:100px;overflow:hidden"><div style="height:500px"></div>${control('Case B')}</div>`,
      ),
    ).toEqual(['Case B']);
  });

  it('C: an auto box that does not scroll, cut by an outer clip, hides its control', async () => {
    expect(
      await unreachable(
        `<div style="height:100px;overflow:hidden"><div style="overflow:auto"><div style="height:500px"></div>${control('Case C')}</div></div>`,
      ),
    ).toEqual(['Case C']);
  });

  it('D: a flex child that really scrolls lets its control scroll into view', async () => {
    expect(
      await unreachable(
        `<div style="display:flex;flex-direction:column;height:200px;overflow:hidden"><div style="flex:1;min-height:0;overflow:auto"><div style="height:600px"></div>${control('Case D')}</div></div>`,
      ),
    ).toEqual([]);
  });

  it('a scroller clipped away entirely leaves its controls unreachable', async () => {
    expect(
      await unreachable(
        `<div style="height:100px;overflow:hidden"><div style="height:200px"></div><div style="height:100px;overflow:auto"><div style="height:400px"></div>${control('Case E')}</div></div>`,
      ),
    ).toEqual(['Case E']);
  });
});

describe('gallery finding identities', { timeout: 60_000 }, () => {
  // Visible text missing from the accessible name: axe's
  // label-content-name-mismatch (serious), keyed by the gallery.
  const mismatch =
    '<button class="tool-chip" aria-label="Open the panel">Settings</button>';

  async function axeKeys(body: string) {
    await render(body);
    const audit = await auditGalleryScreen(page, 'fixture');
    return audit.findings
      .map(({ identity }) => identity)
      .filter((identity) => identity.startsWith('axe:'));
  }

  it('keys a finding by what the element is, not where axe found it', async () => {
    const alone = await axeKeys(`<section>${mismatch}</section>`);
    expect(alone).toEqual([
      'axe:label-content-name-mismatch:button.tool-chip[Open the panel]',
    ]);
    // An unrelated sibling before it, and a second instance elsewhere, move
    // axe's selector (`.tool-chip` -> `section > .tool-chip:nth-child(2)`).
    const crowded = await axeKeys(
      `<section><button class="tool-chip" aria-label="Other">Other</button>${mismatch}</section><aside>${mismatch}</aside>`,
    );
    expect(crowded).toEqual(alone);
  });

  it('masks React ids and counts in the anchor', async () => {
    const first = await axeKeys(
      '<span id="_r_d_-0-name">Run 3 checks</span><button aria-labelledby="_r_d_-0-name">Go</button>',
    );
    const renumbered = await axeKeys(
      '<p>unrelated</p><span id="_r_1f_-0-name">Run 12 checks</span><button aria-labelledby="_r_1f_-0-name">Go</button>',
    );
    expect(first).toEqual([
      'axe:label-content-name-mismatch:button[Run # checks]',
    ]);
    expect(renumbered).toEqual(first);
  });
});

describe('hit-target and overflow identities', { timeout: 60_000 }, () => {
  async function keys(body: string, prefix: string) {
    await render(body);
    const audit = await auditGalleryScreen(page, 'fixture');
    return audit.findings
      .map(({ identity }) => identity)
      .filter((identity) => identity.startsWith(prefix));
  }
  const tiny =
    '<button class="tiny-action" aria-label="Save draft 2" style="width:30px;height:30px">S</button>';
  const clipped =
    '<div style="height:40px;overflow:hidden"><div style="height:200px"></div><button class="buried-action" aria-label="Hidden action">H</button></div>';
  const wide =
    '<div class="wide-row" style="width:600px;height:20px">wide</div>';

  it('keys a small target by its anchor, unmoved by a sibling or a second instance', async () => {
    const alone = await keys(`<section>${tiny}</section>`, 'hit-target:small:');
    expect(alone).toEqual([
      'hit-target:small:button.tiny-action[Save draft #]',
    ]);
    expect(
      await keys(
        `<section><p>intro</p>${tiny}</section><aside style="margin-top:60px">${tiny}</aside>`,
        'hit-target:small:',
      ),
    ).toEqual(alone);
  });

  it('keys an unreachable control by its anchor', async () => {
    const alone = await keys(clipped, 'hit-target:unreachable:');
    expect(alone).toEqual([
      'hit-target:unreachable:button.buried-action[Hidden action]',
    ]);
    expect(
      await keys(`<p>intro</p>${clipped}`, 'hit-target:unreachable:'),
    ).toEqual(alone);
  });

  it('keys horizontal overflow by its anchor', async () => {
    const alone = await keys(`<section>${wide}</section>`, 'overflow:element:');
    expect(alone).toEqual(['overflow:element:div.wide-row']);
    expect(
      await keys(`<section><p>intro</p>${wide}</section>`, 'overflow:element:'),
    ).toEqual(alone);
  });

  it('tells unlabelled-looking form controls apart by type, name and label', async () => {
    expect(
      await keys(
        '<label for="email">Email</label><input id="email" type="email" name="email" style="width:30px;height:20px"><label>Phone <input type="tel" name="phone" style="width:30px;height:20px"></label>',
        'hit-target:small:',
      ),
    ).toEqual([
      'hit-target:small:input[type=email][name=email][Email]',
      'hit-target:small:input[type=tel][name=phone][Phone]',
    ]);
    // Two unnamed selects: each keyed by its own `name`, not one `select`.
    expect(
      await keys(
        '<select name="tier"><option>a</option></select><select name="region"><option>b</option></select>',
        'axe:select-name:',
      ),
    ).toEqual([
      'axe:select-name:select[name=region]',
      'axe:select-name:select[name=tier]',
    ]);
  });
});
