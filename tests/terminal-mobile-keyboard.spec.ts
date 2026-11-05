import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { type CDPSession, devices, type Locator } from '@playwright/test';
import { PNG } from 'pngjs';
import {
  type AuthenticatedE2ERequest,
  expect,
  test,
} from './helpers/authenticated-request';
import { selectCodingPane } from './helpers/coding-stack';

/**
 * #3994: typing into the Coding terminal from a phone. Android keyboards
 * (Gboard on Chrome, recorded on a real emulator) do not send what a desktop
 * keyboard does: each letter is a keydown with keyCode 229 and then a
 * `beforeinput insertText`, and the Send/Enter and Backspace keys are keydowns
 * whose `key` is set and whose `code` is empty. The terminal encoded keys by
 * `code` alone, so Send typed nothing and the command never ran ("sending a
 * terminal message didn't work"), and it cancelled each insertion, so the
 * keyboard believed the field held text it did not and its deletes were lost.
 *
 * This drives that event shape through the browser's own input pipeline (CDP
 * `Input.insertText` is an IME commit with no key press) into a real shell on
 * a real isolated Station, and reads what the shell printed back from the
 * server's terminal journal. Then a second shell's tab hides the first, as
 * switching apps does: the hidden view gives its WebGL context back, and
 * shown again it must draw the same screen rather than a blank one.
 */

const { defaultBrowserType: _defaultBrowserType, ...pixel } =
  devices['Pixel 7'];
test.use({ ...pixel, reducedMotion: 'reduce' });

declare global {
  interface Window {
    __terminalHaptics?: number;
  }
}

const SLUG = `e2e-terminal-mobile-keyboard-${process.pid}`;

interface TerminalSessionRecord {
  terminalId: string;
  status: string;
}

async function terminalSessions(request: AuthenticatedE2ERequest) {
  const response = await request.get(`/api/projects/${SLUG}/terminal-sessions`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { data: TerminalSessionRecord[] };
  return body.data;
}

/** What the shell wrote, as text: escape sequences and carriage returns out. */
async function shellOutput(request: AuthenticatedE2ERequest, id: string) {
  const response = await request.get(
    `/api/projects/${SLUG}/terminal-sessions/${id}?fromSeq=0`,
  );
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    data: { journal: { records: { data: string }[] } };
  };
  const text = body.data.journal.records.map((record) => record.data).join('');
  return stripVTControlCharacters(text).replace(/\r/g, '');
}

/**
 * How much of a capture is drawn: pixels clearly off its most common colour
 * (the background). Text on screen is thousands; a blank or cursor-only
 * screen, what a view that lost its WebGL context drew, is next to none.
 * Counted rather than compared byte for byte, since a restored context may
 * rasterize the same text with sub-pixel differences.
 */
function ink(capture: Buffer) {
  const { data } = PNG.sync.read(capture);
  const counts = new Map<number, number>();
  for (let i = 0; i < data.length; i += 4) {
    const rgb = (data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!;
    counts.set(rgb, (counts.get(rgb) ?? 0) + 1);
  }
  const background = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
  let drawn = 0;
  for (let i = 0; i < data.length; i += 4) {
    const distance =
      Math.abs(data[i]! - ((background >> 16) & 0xff)) +
      Math.abs(data[i + 1]! - ((background >> 8) & 0xff)) +
      Math.abs(data[i + 2]! - (background & 0xff));
    if (distance > 96) drawn += 1;
  }
  return drawn;
}

/** One letter the way Gboard commits it: keydown 229, then the text. */
async function softType(cdp: CDPSession, text: string) {
  for (const char of text) {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Unidentified',
      windowsVirtualKeyCode: 229,
    });
    await cdp.send('Input.insertText', { text: char });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Unidentified',
      windowsVirtualKeyCode: 229,
    });
  }
}

/** A named soft key: `key` set, `code` empty, as Android Chrome sends it. */
async function softKey(cdp: CDPSession, key: 'Enter' | 'Backspace') {
  const keyCode = key === 'Enter' ? 13 : 8;
  for (const type of ['rawKeyDown', 'keyUp'] as const)
    await cdp.send('Input.dispatchKeyEvent', {
      type,
      key,
      code: '',
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    });
}

async function openShell(page: import('@playwright/test').Page) {
  await page.goto(`/projects/${SLUG}/layouts/coding`);
  await selectCodingPane(page, 'Terminal');
  const terminal = page
    .locator(
      '.station-terminal[data-state="ready"]:not([inert] *):not([aria-hidden="true"] *)',
    )
    .filter({ visible: true })
    .first();
  // A Project's first shell opens by itself once the server says it has none.
  const opened = await terminal
    .waitFor({ timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  if (!opened) {
    await page.getByTitle('New terminal').filter({ visible: true }).click();
    await page
      .getByRole('dialog', { name: 'New terminal' })
      .getByRole('button', { name: /Shell/ })
      .click();
  }
  await expect(terminal).toBeVisible({ timeout: 60_000 });
  return terminal;
}

test.describe('Coding terminal on a phone keyboard', () => {
  let workspace = '';

  test.afterEach(async ({ authenticatedRequest }) => {
    for (const session of await terminalSessions(authenticatedRequest).catch(
      () => [],
    ))
      await authenticatedRequest.delete(
        `/api/projects/${SLUG}/terminal-sessions/${session.terminalId}`,
      );
    const removed = await authenticatedRequest.delete(`/api/projects/${SLUG}`);
    expect(removed.ok() || removed.status() === 404).toBe(true);
    if (workspace) rmSync(workspace, { recursive: true, force: true });
    workspace = '';
  });

  test('runs what the soft keyboard types, deletes with its Backspace, and redraws a shell shown again', async ({
    page,
    authenticatedRequest,
  }) => {
    test.setTimeout(180_000);
    workspace = mkdtempSync(join(tmpdir(), 'station-terminal-mobile-'));
    const created = await authenticatedRequest.post('/api/projects', {
      data: {
        slug: SLUG,
        name: 'Terminal Mobile Keyboard',
        workingDirectory: workspace,
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const layout = await authenticatedRequest.post(
      `/api/projects/${SLUG}/layouts/apply`,
      { data: { layoutId: 'builtin:coding' } },
    );
    expect(layout.ok()).toBe(true);

    // Count the haptic tick a long touch gives when it starts a selection.
    await page.addInitScript(() => {
      window.__terminalHaptics = 0;
      navigator.vibrate = () => {
        window.__terminalHaptics = (window.__terminalHaptics ?? 0) + 1;
        return true;
      };
    });
    const terminal: Locator = await openShell(page);
    const input = terminal.getByRole('textbox', { name: 'Terminal input' });
    // A tap on the screen focuses the input, which raises the soft keyboard.
    await terminal.locator('canvas').tap();
    await expect(input).toBeFocused();
    const [session] = await terminalSessions(authenticatedRequest);
    if (!session) throw new Error('the Project has no shell');
    const cdp = await page.context().newCDPSession(page);

    const token = `mt${Date.now().toString(36)}`;
    await softType(cdp, `echo ${token}xy`);
    // The keyboard's insertions stay in the field it edits; when they were
    // cancelled, the keyboard's later deletes found nothing and were lost.
    await expect(input).toHaveValue(`echo ${token}xy`);
    await softKey(cdp, 'Backspace');
    await softKey(cdp, 'Backspace');
    await softKey(cdp, 'Enter');
    // The command ran: its output is a line of its own, without what was
    // deleted. Before the fix Send wrote nothing and nothing ran.
    await expect
      .poll(
        async () =>
          (await shellOutput(authenticatedRequest, session.terminalId))
            .split('\n')
            .map((line) => line.trim()),
        { timeout: 30_000 },
      )
      .toContain(token);
    expect(
      (await shellOutput(authenticatedRequest, session.terminalId))
        .split('\n')
        .map((line) => line.trim()),
    ).not.toContain(`${token}xy`);
    await expect(input).toHaveValue('');

    // A second shell's tab hides this one; a hidden view gives its WebGL
    // context back, as it does when the phone switches apps. Shown again, it
    // must draw the same screen, not a blank one.
    await expect(terminal).toHaveAttribute('data-renderer', 'webgl2');
    const first = page.getByRole('tabpanel', { name: 'Shell 1' });
    const canvas = first.locator('.station-terminal canvas');
    // Unfocused, so the cursor is drawn as an outline in both captures.
    await input.blur();
    await expect(input).not.toBeFocused();
    // Settled: the redraw after the blur has landed.
    let shown = ink(await canvas.screenshot());
    await expect
      .poll(async () => {
        const next = ink(await canvas.screenshot());
        const settled = Math.abs(next - shown) <= shown * 0.01;
        shown = next;
        return settled;
      })
      .toBe(true);
    // The command, its output and two prompts are on screen.
    expect(shown).toBeGreaterThan(500);
    const drawsTheSameScreen = async () => {
      // A tapped tab may focus its terminal: compare with the outline cursor.
      await page.evaluate(() =>
        (document.activeElement as HTMLElement | null)?.blur(),
      );
      const now = ink(await canvas.screenshot());
      return now > shown * 0.9 && now < shown * 1.1;
    };
    await page.getByRole('button', { name: 'New terminal', exact: true }).tap();
    const tabs = page.getByRole('tablist', { name: 'Terminal tabs' });
    // A Project with package scripts offers them beside Shell; this one has
    // none, so New terminal opens a shell. Either way the next tab is Shell 2.
    const pickShell = page
      .getByRole('dialog', { name: 'New terminal' })
      .getByRole('button', { name: /Shell/ });
    const secondTab = tabs.getByRole('tab', { name: 'Shell 2' });
    await expect(pickShell.or(secondTab)).toBeVisible();
    if (await pickShell.isVisible()) await pickShell.tap();
    await expect(secondTab).toHaveAttribute('aria-selected', 'true');
    await expect(
      page
        .getByRole('tabpanel', { name: 'Shell 2' })
        .locator('.station-terminal[data-state="ready"]'),
    ).toBeVisible({ timeout: 60_000 });
    await tabs.getByRole('tab', { name: 'Shell 1' }).tap();
    await expect.poll(drawsTheSameScreen, { timeout: 15_000 }).toBe(true);

    // Closing the second shell leaves the first, still drawn.
    await page
      .getByRole('button', { name: 'Close Shell 2', exact: true })
      .tap();
    await expect(tabs.getByRole('tab')).toHaveCount(1);
    await expect.poll(drawsTheSameScreen).toBe(true);

    // A long touch on the output selects the word under it, and the menu
    // offers it to chat. Ghostty refused the selection gesture's options, so
    // the long press stopped the terminal ("could not start") instead.
    const box = await canvas.boundingBox();
    if (!box) throw new Error('the terminal has no box');
    const touch = { x: box.x + 40, y: box.y + box.height * 0.12 };
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [touch],
    });
    // The phone buzzes when a held touch starts selecting.
    await expect
      .poll(() => page.evaluate(() => window.__terminalHaptics ?? 0))
      .toBeGreaterThan(0);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
    await expect(first.locator('.station-terminal')).toHaveAttribute(
      'data-state',
      'ready',
    );
    await terminal.getByRole('textbox', { name: 'Terminal input' }).focus();
    await page.keyboard.press('Shift+F10');
    const menu = page.getByRole('menu', { name: 'Terminal actions' });
    await expect(menu.getByRole('menuitem', { name: 'Copy' })).toBeEnabled();
    await expect(
      menu.getByRole('menuitem', { name: 'Add to chat' }),
    ).toBeEnabled();
  });
});
