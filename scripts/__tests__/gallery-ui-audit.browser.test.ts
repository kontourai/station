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

  const bar =
    '<div style="position:fixed;top:0;left:0;right:0;height:50px;background:#fff;z-index:2"><button class="bar-action" aria-label="Menu" style="width:44px;height:44px">M</button></div>';
  const under =
    '<div style="height:30px"></div><button class="under-choice" aria-label="Choice" style="display:block;width:200px;height:44px;margin-top:10px">Choice</button>';

  it('does not report content scrolled under a fixed bar as an overlap', async () => {
    expect(
      await keys(
        `${bar}${under}<div style="height:2000px"></div>`,
        'hit-target:overlap:',
      ),
    ).toEqual([]);
  });

  it('does not report content behind a fixed layer that covers its centre', async () => {
    // A docked panel over a page that cannot scroll: the page's control sits
    // behind the panel's header, so a press lands on the panel.
    expect(
      await keys(
        '<div style="position:fixed;left:0;right:0;top:0;bottom:0;background:#fff"><button class="dock-action" aria-label="New chat" style="width:120px;height:44px;margin-left:20px">New chat</button></div><textarea class="page-input" aria-label="Page input" style="display:block;width:300px;height:60px"></textarea>',
        'hit-target:overlap:',
      ),
    ).toEqual([]);
  });

  it('still reports a fixed bar over content that cannot scroll away', async () => {
    expect(await keys(`${bar}${under}`, 'hit-target:overlap:')).toEqual([
      'hit-target:overlap:button.bar-action[Menu] / button.under-choice[Choice]',
    ]);
  });

  it('still reports two overlapping content controls', async () => {
    expect(
      await keys(
        '<button class="first-action" aria-label="First" style="display:block;width:60px;height:60px">1</button><button class="second-action" aria-label="Second" style="display:block;width:60px;height:60px;margin-top:-20px;margin-left:20px;position:relative">2</button><div style="height:2000px"></div>',
        'hit-target:overlap:',
      ),
    ).toEqual([
      'hit-target:overlap:button.first-action[First] / button.second-action[Second]',
    ]);
  });

  it('tells two inputs apart by their label alone', async () => {
    // Same tag, same type, no name: only the label differs.
    expect(
      await keys(
        '<label for="bill">Billing email</label><input id="bill" type="text" style="width:30px;height:20px"><label for="ship">Shipping email</label><input id="ship" type="text" style="width:30px;height:20px">',
        'hit-target:small:',
      ),
    ).toEqual([
      'hit-target:small:input[type=text][Billing email]',
      'hit-target:small:input[type=text][Shipping email]',
    ]);
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
    // A select with nothing of its own is scoped by its classed ancestor.
    expect(
      await keys(
        '<div class="var-row"><select><option>a</option></select></div><div class="tier-row"><select><option>b</option></select></div>',
        'axe:select-name:',
      ),
    ).toEqual([
      'axe:select-name:div.tier-row select',
      'axe:select-name:div.var-row select',
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
