import { readFileSync } from 'node:fs';
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

  const overlaps = (body: string) => keys(body, 'hit-target:overlap:');
  const bar =
    '<div style="position:fixed;top:0;left:0;right:0;height:50px;background:#fff;z-index:2"><button class="bar-action" aria-label="Menu" style="width:44px;height:44px">M</button></div>';

  it('does not judge controls inside a closed, clipping details', async () => {
    expect(
      await keys(
        '<details class="more" style="overflow:hidden"><summary style="display:block;width:120px;height:44px">More</summary><div style="height:40px"></div><button class="inner-action" aria-label="Inner" style="display:block;width:30px;height:30px">Inner</button></details>',
        'hit-target:',
      ),
    ).toEqual([]);
  });

  it('still judges controls in content-visibility: auto content below the fold', async () => {
    expect(
      await keys(
        '<div style="height:3000px"></div><div style="content-visibility:auto;contain-intrinsic-size:auto 100px"><button class="deferred-action" aria-label="Deferred" style="width:30px;height:30px">D</button></div>',
        'hit-target:small:',
      ),
    ).toEqual(['hit-target:small:button.deferred-action[Deferred]']);
  });

  it('reports content scrolled under a fixed header: scroll position is not credited', async () => {
    // Scrolling back up would separate them, but modelling scroll clearance
    // kept hiding real defects, so the audit stays conservative.
    expect(
      await overlaps(
        `${bar}<div style="height:130px"></div><button class="under-choice" aria-label="Choice" style="display:block;width:200px;height:44px;margin-top:10px">Choice</button><div style="height:2000px"></div><script>scrollTo(0, 100)</script>`,
      ),
    ).toEqual([
      'hit-target:overlap:button.bar-action[Menu] / button.under-choice[Choice]',
    ]);
  });

  it('clears content behind a modal sheet that covers its centre', async () => {
    expect(
      await overlaps(
        '<div role="dialog" aria-modal="true" style="position:fixed;left:0;top:0;width:300px;height:60px"><button class="sheet-action" aria-label="New chat" style="width:300px;height:60px">New chat</button></div><textarea class="page-input" aria-label="Page input" style="display:block;width:300px;height:60px"></textarea>',
      ),
    ).toEqual([]);
  });

  it('clears content whose lower edge runs under the expanded dock sheet', async () => {
    // The hosted renderer's home composer: the textarea's centre is visible
    // above the dock, its bottom edge sits behind the dock header's buttons.
    expect(
      await overlaps(
        '<div style="height:380px"></div><textarea class="composer" aria-label="What would you like done?" style="display:block;width:330px;height:120px;margin-left:30px"></textarea><section class="chat-dock" style="position:fixed;left:0;right:0;top:465px;bottom:0;background:#111"><button class="dock-new" aria-label="New chat" style="width:60px;height:50px;margin-left:300px">N</button></section>',
      ),
    ).toEqual([]);
  });

  // Accepted decision: a sheet clears content partly under it, including
  // the non-modal expanded chat dock; the visible part stays tappable.
  const content = (top: number) =>
    `<div style="height:${top}px"></div><button class="content-act" aria-label="Content act" style="display:block;width:390px;height:44px">C</button><div style="height:2000px"></div>`;

  it('A2h: clears content whose lower 20 of 44px run under the expanded dock', async () => {
    expect(
      await overlaps(
        `${content(441)}<section class="chat-dock" style="position:fixed;left:0;right:0;top:465px;bottom:0;z-index:5;background:#111"><button class="dock-new" aria-label="New chat" style="width:390px;height:50px">N</button></section>`,
      ),
    ).toEqual([]);
  });

  it('A1d: clears content under a showModal() dialog', async () => {
    expect(
      await overlaps(
        `${content(758)}<dialog id="d" style="position:fixed;margin:0;inset:800px 0 0 0;max-width:none;max-height:none;width:auto;height:auto;padding:0;border:0"><button class="sheet-close" aria-label="Sheet close" style="width:390px;height:44px">X</button></dialog><script>document.getElementById("d").showModal()</script>`,
      ),
    ).toEqual([]);
  });

  it('clears content behind the expanded chat dock sheet', async () => {
    expect(
      await overlaps(
        '<section class="chat-dock" style="position:fixed;left:0;top:0;width:300px;height:60px"><button class="dock-action" aria-label="New chat" style="width:300px;height:60px">New chat</button></section><textarea class="page-input" aria-label="Page input" style="display:block;width:300px;height:60px"></textarea>',
      ),
    ).toEqual([]);
  });

  // Must stay reported: each is a control a user cannot reach or press.
  const reported: Record<string, [string, string]> = {
    'a collapsed chat dock bar over the last control at max scroll': [
      '<div style="height:790px"></div><button class="tech-details" aria-label="Technical details" style="display:block;width:390px;height:44px">Technical details</button><section class="chat-dock is-collapsed" style="position:fixed;left:0;right:0;bottom:0;height:44px"><button class="dock-bar" aria-label="Chat" style="width:390px;height:44px">Chat</button></section>',
      'hit-target:overlap:button.tech-details[Technical details] / button.dock-bar[Chat]',
    ],
    'F1: a fixed bottom bar button over a primary control, page cannot scroll':
      [
        '<div style="height:780px"></div><button class="primary-submit" aria-label="Submit order" style="display:block;width:390px;height:44px">Submit</button><div style="position:fixed;left:0;right:0;bottom:0;height:60px;z-index:2"><button class="bar-save" aria-label="Bar save" style="width:390px;height:60px">Bar</button></div>',
        'hit-target:overlap:button.primary-submit[Submit order] / button.bar-save[Bar save]',
      ],
    "F3: a fixed header over a scrolling page's first row": [
      '<div style="position:fixed;top:0;left:0;right:0;height:56px;z-index:2;background:#fff"><button class="hdr-menu" aria-label="Menu" style="width:390px;height:56px">M</button></div><button class="first-row" aria-label="First row" style="display:block;width:390px;height:44px;margin-top:30px">First</button><div style="height:2000px"></div>',
      'hit-target:overlap:button.hdr-menu[Menu] / button.first-row[First row]',
    ],
    'F4: a page that scrolls 8px with its last control 30px under a bar': [
      '<div style="height:776px"></div><button class="last-row" aria-label="Last row" style="display:block;width:390px;height:76px">Last</button><div style="position:fixed;left:0;right:0;bottom:0;height:30px;z-index:2"><button class="bar-save" aria-label="Bar save" style="width:390px;height:30px">Bar</button></div>',
      'hit-target:overlap:button.last-row[Last row] / button.bar-save[Bar save]',
    ],
    "F5: a sticky header over a pane's first row at scrollTop 0": [
      '<div style="height:600px;overflow:auto"><div style="position:sticky;top:0;height:50px;z-index:2"><button class="sticky-filter" aria-label="Filter" style="width:390px;height:50px">F</button></div><button class="row-one" aria-label="Row one" style="display:block;width:390px;height:44px;margin-top:-30px;position:relative">Row</button><div style="height:2000px"></div></div>',
      'hit-target:overlap:button.sticky-filter[Filter] / button.row-one[Row one]',
    ],
    'F6: a control in a non-scrolling region under a fixed button': [
      '<div style="height:300px;overflow:hidden"><button class="pane-act" aria-label="Pane act" style="display:block;width:200px;height:44px;margin-top:20px">Act</button></div><div style="position:fixed;top:0;left:0;width:150px;height:50px;z-index:2"><button class="dock-new" aria-label="Dock new" style="width:150px;height:50px">N</button></div><div style="height:2000px"></div>',
      'hit-target:overlap:button.pane-act[Pane act] / button.dock-new[Dock new]',
    ],
    'F7: two pinned controls overlapping': [
      '<div style="position:fixed;top:0;left:0"><button class="fx-a" aria-label="Fx A" style="width:60px;height:60px">A</button></div><div style="position:fixed;top:20px;left:20px"><button class="fx-b" aria-label="Fx B" style="width:60px;height:60px">B</button></div>',
      'hit-target:overlap:button.fx-a[Fx A] / button.fx-b[Fx B]',
    ],
    'a pinned control whose centre a modal sheet covers': [
      '<div style="position:fixed;left:0;top:0"><button class="toolbar-action" aria-label="Toolbar" style="width:300px;height:60px">T</button></div><div role="dialog" aria-modal="true" style="position:fixed;left:0;top:0;width:300px;height:60px"><button class="sheet-action" aria-label="New chat" style="width:300px;height:60px">New chat</button></div>',
      'hit-target:overlap:button.toolbar-action[Toolbar] / button.sheet-action[New chat]',
    ],
    'B2: the last control at max page scroll under a 60px bottom bar': [
      '<div style="height:2000px"></div><button class="last-row" aria-label="Last row" style="display:block;width:390px;height:44px">Last</button><div style="position:fixed;left:0;right:0;bottom:0;height:60px;z-index:2"><button class="bar-save" aria-label="Bar save" style="width:390px;height:60px">Bar</button></div><script>scrollTo(0, 99999)</script>',
      'hit-target:overlap:button.last-row[Last row] / button.bar-save[Bar save]',
    ],
    'B2b: the same at max pane scroll': [
      '<div id="p" style="height:844px;overflow:auto"><div style="height:2000px"></div><button class="last-row" aria-label="Last row" style="display:block;width:390px;height:44px">Last</button></div><div style="position:fixed;left:0;right:0;bottom:0;height:60px;z-index:2"><button class="bar-save" aria-label="Bar save" style="width:390px;height:60px">Bar</button></div><script>document.getElementById("p").scrollTop=99999</script>',
      'hit-target:overlap:button.last-row[Last row] / button.bar-save[Bar save]',
    ],
    'B3: a column-reverse scroller at its natural bottom under a 60px bar': [
      '<div style="height:844px;overflow:auto;display:flex;flex-direction:column-reverse"><button class="last-row" aria-label="Last row" style="flex:none;display:block;width:390px;height:44px">Last</button><div style="flex:none;height:2000px"></div></div><div style="position:fixed;left:0;right:0;bottom:0;height:60px;z-index:2"><button class="bar-save" aria-label="Bar save" style="width:390px;height:60px">Bar</button></div>',
      'hit-target:overlap:button.last-row[Last row] / button.bar-save[Bar save]',
    ],
    'B3b: a column-reverse scroller under a 30px bar': [
      '<div style="height:844px;overflow:auto;display:flex;flex-direction:column-reverse"><button class="last-row" aria-label="Last row" style="flex:none;display:block;width:390px;height:44px">Last</button><div style="flex:none;height:2000px"></div></div><div style="position:fixed;left:0;right:0;bottom:0;height:30px;z-index:2"><button class="bar-save" aria-label="Bar save" style="width:390px;height:30px">Bar</button></div>',
      'hit-target:overlap:button.last-row[Last row] / button.bar-save[Bar save]',
    ],
    'B4: a fixed control inside a scroller, under another fixed control': [
      '<div style="height:844px;overflow:auto"><div style="height:2000px"></div><div style="position:fixed;left:0;top:0"><button class="fx-a" aria-label="Fx A" style="width:60px;height:60px">A</button></div></div><div style="position:fixed;top:20px;left:20px"><button class="fx-b" aria-label="Fx B" style="width:60px;height:60px">B</button></div>',
      'hit-target:overlap:button.fx-a[Fx A] / button.fx-b[Fx B]',
    ],
    'B5: two sticky controls overlapping in one scroller': [
      '<div style="height:600px;overflow:auto"><div style="position:sticky;top:0;height:0;z-index:2"><button class="st-a" aria-label="St A" style="width:60px;height:60px">A</button></div><div style="position:sticky;top:20px;height:0;margin-left:20px;z-index:3"><button class="st-b" aria-label="St B" style="width:60px;height:60px">B</button></div><div style="height:2000px"></div></div>',
      'hit-target:overlap:button.st-a[St A] / button.st-b[St B]',
    ],
    "B6: a layer covering the scroller's whole visible area": [
      '<div style="height:744px"></div><div style="height:100px;overflow:auto"><button class="pane-row" aria-label="Pane row" style="display:block;width:390px;height:44px">R</button><div style="height:400px"></div></div><div style="position:fixed;left:0;right:0;bottom:0;height:100px;z-index:2"><button class="bar-save" aria-label="Bar save" style="width:390px;height:100px">Bar</button></div>',
      'hit-target:overlap:button.pane-row[Pane row] / button.bar-save[Bar save]',
    ],
    'N5c: a clipped scroller taller than its clip, at max scroll, under a bar':
      [
        '<div style="height:844px;overflow:hidden"><div style="height:500px"></div><div id="i" style="height:1000px;overflow:auto"><div style="height:1000px"></div><button class="last-row" aria-label="Last row" style="display:block;width:390px;height:44px">Last</button><div style="height:666px"></div></div></div><div style="position:fixed;left:0;right:0;bottom:0;height:60px;z-index:2"><button class="bar-save" aria-label="Bar save" style="width:390px;height:60px">Bar</button></div><script>{const i=document.getElementById("i");i.scrollTop=99999;window.__dbg={st:i.scrollTop,max:i.scrollHeight-i.clientHeight}}</script>',
        'hit-target:overlap:button.last-row[Last row] / button.bar-save[Bar save]',
      ],
    'N7: an un-stuck sticky header over a row in the same scroller': [
      '<div style="height:600px;overflow:auto"><div style="height:300px"></div><div style="position:sticky;top:0;height:50px;z-index:2"><button class="sec-hdr" aria-label="Sec hdr" style="width:390px;height:50px">H</button></div><button class="row-x" aria-label="Row x" style="display:block;width:390px;height:44px;margin-top:-30px;position:relative">Row</button><div style="height:2000px"></div></div>',
      'hit-target:overlap:button.sec-hdr[Sec hdr] / button.row-x[Row x]',
    ],
    'B4m: a fixed control inside a mid-scrolled pane, under another fixed control':
      [
        '<div id="p" style="height:844px;overflow:auto"><div style="height:2000px"></div><div style="position:fixed;left:0;top:0"><button class="fx-a" aria-label="Fx A" style="width:60px;height:60px">A</button></div></div><div style="position:fixed;top:20px;left:20px"><button class="fx-b" aria-label="Fx B" style="width:60px;height:60px">B</button></div><script>document.getElementById("p").scrollTop=500</script>',
        'hit-target:overlap:button.fx-a[Fx A] / button.fx-b[Fx B]',
      ],
    'content whose lower edge runs under a fixed bar that is not a sheet': [
      '<div style="height:380px"></div><textarea class="composer" aria-label="What would you like done?" style="display:block;width:330px;height:120px;margin-left:30px"></textarea><section class="chat-dock is-collapsed" style="position:fixed;left:0;right:0;top:465px;height:60px;background:#111"><button class="dock-new" aria-label="New chat" style="width:60px;height:50px;margin-left:300px">N</button></section>',
      'hit-target:overlap:textarea.composer[What would you like done?] / button.dock-new[New chat]',
    ],
    'A6: a collapsed dock covering the lower 20 of 44px': [
      '<div style="height:441px"></div><button class="content-act" aria-label="Content act" style="display:block;width:390px;height:44px">C</button><div style="height:2000px"></div><section class="chat-dock is-collapsed" style="position:fixed;left:0;right:0;top:465px;height:60px;z-index:5;background:#111"><button class="dock-new" aria-label="New chat" style="width:390px;height:50px">N</button></section>',
      'hit-target:overlap:button.content-act[Content act] / button.dock-new[New chat]',
    ],
    'A1n: a non-modal dialog.show() over a 2px sliver': [
      '<div style="height:758px"></div><button class="content-act" aria-label="Content act" style="display:block;width:390px;height:44px">C</button><div style="height:2000px"></div><dialog id="d" style="position:fixed;margin:0;inset:800px 0 0 0;max-width:none;max-height:none;width:auto;height:auto;padding:0;border:0;z-index:5"><button class="sheet-close" aria-label="Sheet close" style="width:390px;height:44px">X</button></dialog><script>document.getElementById("d").show()</script>',
      'hit-target:overlap:button.content-act[Content act] / button.sheet-close[Sheet close]',
    ],
    'two overlapping content controls': [
      '<button class="first-action" aria-label="First" style="display:block;width:60px;height:60px">1</button><button class="second-action" aria-label="Second" style="display:block;width:60px;height:60px;margin-top:-20px;margin-left:20px;position:relative">2</button><div style="height:2000px"></div>',
      'hit-target:overlap:button.first-action[First] / button.second-action[Second]',
    ],
  };
  for (const [name, [body, key]] of Object.entries(reported))
    it(`still reports ${name}`, async () => {
      expect(await overlaps(body)).toEqual([key]);
    });

  it('measures a select like any other control', async () => {
    expect(
      await keys(
        '<label for="tone">Alert sound</label><select id="tone" name="tone" style="width:120px;height:38px"><option>Chime</option></select>',
        'hit-target:small:',
      ),
    ).toEqual(['hit-target:small:select[name=tone][Alert sound]']);
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

describe('settings notification controls on a phone', {
  timeout: 60_000,
}, () => {
  // The real stylesheet, so the shared narrow-width floor and the component
  // rule meet exactly as they do in the app. In the gallery most of these
  // sit in a closed disclosure and are not measured; here every one is.
  const css = readFileSync('src-ui/src/views/SettingsView.css', 'utf8');

  it('gives every notification select and time input a 44px target at 390px', async () => {
    const row = (label: string, control: string) =>
      `<label class="settings__notification-sound"><span>${label}</span>${control}</label>`;
    const select = '<select><option>Default</option></select>';
    await page.setContent(
      `<!doctype html><html lang="en"><head><style>${css}</style></head><body><div class="settings"><fieldset class="settings__notification-sounds"><div class="settings__notification-sounds-grid">${[
        'Agent notifications',
        'Station local UI: interrupt for',
        'Approval requests sound',
        'Completed turns sound',
        'Failed turns sound',
        'Job failures sound',
        'Missed jobs sound',
        'Pairing requests sound',
        'Scheduler health sound',
        'Stopped turns sound',
      ]
        .map((label) => row(label, select))
        .join(
          '',
        )}${row('Quiet hours start', '<input type="time">')}</div></fieldset></div></body></html>`,
    );
    const controls = page.locator(
      '.settings__notification-sound > :is(select, input[type="time"])',
    );
    const heights: number[] = [];
    for (let i = 0; i < (await controls.count()); i += 1)
      heights.push((await controls.nth(i).boundingBox())?.height ?? 0);
    expect(heights).toHaveLength(11);
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(43.99);
  });
});
