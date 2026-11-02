/**
 * Visual and performance evidence for the Ghostty TerminalView in the Coding
 * terminal pane, against a real isolated Station on this checkout:
 *
 *   node tests/live/terminal-view-visual.mjs --out <dir> [--first-only]
 *
 * Screenshots the terminal at 390 and 1440 px in light and dark (bottom panel,
 * with and without a selection, the right dock at 1440, and the dock round
 * trip back to the lower panel), then measures keystroke-to-glyph latency
 * (median and p95) and the page frame rate over 10 s of a five-million-line
 * flood. Writes the PNGs and results.json (revision, machine and load,
 * per-shot layout, round-trip checks, latencies, frames) to <dir>. The shell is bash with a fixed prompt, so no
 * user, host or path is captured. Uses its own temp home and ports
 * 41810-41813 and 41820; it never touches another instance. Measure on an
 * otherwise idle machine: the numbers include whatever else it is doing.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import {
  arch,
  cpus,
  loadavg,
  platform,
  release,
  tmpdir,
  totalmem,
} from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import {
  apiOk,
  pairBrowser,
  startTempHomeInstance,
} from './helpers/station-instance.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const INSTANCE = 'terminal-view-visual';
const SERVER_PORT = 41810;
const UI_PORT = 41820;
const ESC = '\u001b';

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    // Stop after the first screenshot, to diagnose layout quickly.
    'first-only': { type: 'boolean' },
  },
});
if (!values.out) throw new Error('--out <dir> is required');
const out = resolve(values.out);
mkdirSync(out, { recursive: true });

const station = await startTempHomeInstance({
  root: ROOT,
  instance: INSTANCE,
  serverPort: SERVER_PORT,
  uiPort: UI_PORT,
  logPath: join(out, 'station.log'),
  // One known shell everywhere, so the commands below are plain POSIX.
  env: {
    ...process.env,
    SHELL:
      process.platform === 'win32'
        ? 'C:\\Program Files\\Git\\bin\\bash.exe'
        : '/bin/bash',
  },
});
const browser = await chromium.launch();
// Measurements mean little without the revision and machine they came from.
const results = {
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT })
    .toString()
    .trim(),
  uncommittedChanges:
    execFileSync('git', ['status', '--porcelain'], { cwd: ROOT })
      .toString()
      .trim() !== '',
  environment: {
    platform: `${platform()} ${release()} ${arch()}`,
    cpus: `${cpus().length} × ${cpus()[0]?.model ?? 'unknown'}`,
    memoryGiB: Math.round(totalmem() / 2 ** 30),
    loadAverage: loadavg(),
    node: process.version,
    chromium: browser.version(),
  },
  screenshots: [],
  layout: {},
  latencyMs: [],
  latency: null,
  flood: null,
  roundTrip: [],
};
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  await page.addInitScript(() =>
    localStorage.setItem('station:onboarding-setup-dismissed', '1'),
  );
  await pairBrowser(page, {
    root: ROOT,
    instance: INSTANCE,
    serverPort: SERVER_PORT,
    uiOrigin: station.uiOrigin,
  });

  const repo = mkdtempSync(join(tmpdir(), 'terminal-visual-repo-'));
  const slug = 'terminal-visual';
  await apiOk(page, 'POST', '/api/projects', {
    name: 'Terminal Visual',
    slug,
    workingDirectory: repo,
  });
  const applied = await apiOk(
    page,
    'POST',
    `/api/projects/${slug}/layouts/apply`,
    {
      layoutId: 'builtin:coding',
    },
  );
  const layoutSlug = applied.data?.slug;
  if (!layoutSlug) throw new Error('Coding layout did not apply');

  // The live terminal: a docked Terminal replaces the lower panel's, an
  // inactive one sits in an inert, hidden container, and a put-away dock
  // region keeps its view mounted with no box.
  const liveTerminal = page
    .locator(
      '.station-terminal[data-state="ready"]:not([inert] *):not([aria-hidden="true"] *)',
    )
    .filter({ visible: true })
    .first();
  const terminalInput = liveTerminal.getByRole('textbox', {
    name: 'Terminal input',
  });
  // The same path a person takes: the Views rail (behind the tool picker on
  // a phone) selects Terminal; a Project with no shell yet offers New terminal.
  const openTerminal = async () => {
    await page.goto(
      `${station.uiOrigin}/projects/${slug}/layouts/${layoutSlug}`,
      {
        waitUntil: 'load',
      },
    );
    const mobile = await page.evaluate(
      () => window.matchMedia('(max-width: 767px)').matches,
    );
    if (mobile)
      await page
        .getByRole('button', { name: /^Switch tool, current:/ })
        .click();
    const terminalView = page
      .getByRole('navigation', { name: 'Views' })
      .getByRole('button', { name: /^Terminal(,|$)/ })
      .first();
    // On desktop the rail button toggles the lower panel; an earlier pass
    // may have left it open, and clicking would close it.
    const alreadyOpen =
      !mobile &&
      (await page
        .getByTitle('New terminal')
        .filter({ visible: true })
        .first()
        .waitFor({ timeout: 10_000 })
        .then(
          () => true,
          () => false,
        ));
    if (!alreadyOpen) await terminalView.click();
    const newTerminal = page
      .getByTitle('New terminal')
      .filter({ visible: true })
      .first();
    await newTerminal.waitFor({ timeout: 120_000 });
    // A Project's first shell may still be attaching; only create one when
    // none appears.
    const existing = await page
      .locator('.station-terminal')
      .first()
      .waitFor({ timeout: 30_000 })
      .then(
        () => true,
        () => false,
      );
    if (!existing) {
      await newTerminal.click();
      const picker = page.getByRole('dialog', { name: 'New terminal' });
      const shell = picker.getByRole('button', { name: /Shell/ });
      try {
        await shell.click({ timeout: 30_000 });
      } catch (error) {
        await page.screenshot({ path: join(out, 'debug-picker.png') });
        writeFileSync(
          join(out, 'debug-picker.txt'),
          await page.locator('body').ariaSnapshot(),
        );
        throw error;
      }
    }
    await liveTerminal.waitFor({ timeout: 120_000 });
    await terminalInput.waitFor({ state: 'attached', timeout: 120_000 });
  };
  // Where the terminal and its ancestors sit, to judge fill and overflow.
  const layoutOf = () =>
    liveTerminal.evaluate((root) => {
      const box = (el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return {
          el: `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`,
          top: Math.round(r.top),
          height: Math.round(r.height),
          width: Math.round(r.width),
          display: style.display,
          flex: style.flex,
          minHeight: style.minHeight,
          maxHeight: style.maxHeight,
          flexDirection: style.flexDirection,
          inline: el.getAttribute('style'),
        };
      };
      const chain = [];
      for (let el = root; el && el !== document.body; el = el.parentElement)
        chain.push(box(el));
      return {
        chain,
        parts: [...root.querySelectorAll('canvas, [class*="__"]')]
          .slice(0, 12)
          .map(box),
        viewport: { width: innerWidth, height: innerHeight },
        // What fills the bottom of the window, under the terminal.
        bottom: document
          .elementsFromPoint(innerWidth / 2, innerHeight - 40)
          .slice(0, 8)
          .map(box),
      };
    });
  const type = async (text) => {
    await terminalInput.focus();
    await page.keyboard.type(text);
  };
  // A fixed prompt, so no user, host or path from this machine is captured.
  const neutralPrompt = async () => {
    // Prompt tools (starship and the like) rewrite PS1 from PROMPT_COMMAND.
    await type("unset PROMPT_COMMAND; PS1='station> '; clear\r");
    await page.waitForTimeout(1000);
  };
  // Escape bytes cannot be typed (Escape is a key), so the showcase is a file
  // the shell prints: its bytes reach the PTY exactly as program output does.
  // Box drawing, blocks, Powerline separators, ANSI colours and a coloured
  // prompt line (the pale-green case on light).
  writeFileSync(
    join(repo, 'showcase.txt'),
    [
      `${ESC}[32mstation@host${ESC}[0m:${ESC}[34m~/repo${ESC}[0m$ ls`,
      '┌──┬──┐ ╔══╗ ▁▂▃▄▅▆▇█ ░▒▓',
      `│ok│  │ ║  ║ ${ESC}[42;30m main ${ESC}[0m${ESC}[32m\ue0b0${ESC}[0m ${ESC}[44;37m src \ue0b4${ESC}[0m`,
      '└──┴──┘ ╚══╝ ╭──╮ ╰──╯',
      `${ESC}[31mred ${ESC}[33myellow ${ESC}[32mgreen ${ESC}[35mmagenta ${ESC}[36mcyan ${ESC}[90mbright-black${ESC}[0m`,
      `${ESC}[1mbold${ESC}[0m ${ESC}[3mitalic${ESC}[0m ${ESC}[4munderline${ESC}[0m ${ESC}[7minverse${ESC}[0m`,
      '',
    ].join('\r\n'),
  );
  const showcase = async () => {
    await type('cat showcase.txt\r');
    await page.waitForTimeout(1500);
  };

  // The theme is an account preference: the app re-applies it over a
  // hand-set data-theme, so set it where the app reads it.
  const setTheme = (theme) =>
    apiOk(page, 'PATCH', '/api/me/preferences', { theme });

  for (const theme of ['light', 'dark']) {
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await setTheme(theme);
      await openTerminal();
      await page.evaluate(
        (t) => document.documentElement.setAttribute('data-theme', t),
        theme,
      );
      await neutralPrompt();
      await showcase();
      const path = join(out, `terminal-${theme}-${width}-bottom.png`);
      await page.screenshot({ path });
      results.screenshots.push(path);
      results.layout[`${theme}-${width}-bottom`] = await layoutOf();
      // Selection highlight over the same rows.
      await page.keyboard.press(
        process.platform === 'darwin' ? 'Meta+A' : 'Control+Shift+A',
      );
      await page.waitForTimeout(500);
      const selected = join(out, `terminal-${theme}-${width}-selected.png`);
      await page.screenshot({ path: selected });
      results.screenshots.push(selected);
      if (values['first-only'])
        throw new Error('stopped after the first screenshot');
    }
  }

  // Right dock at 1440 in both themes.
  for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await setTheme(theme);
    await openTerminal();
    // The person's path: the Right region toggle, then Terminal in its
    // chooser (the Coding lower panel yields to a docked Terminal).
    const right = page.getByRole('button', {
      name: 'Right region',
      exact: true,
    });
    if (
      (await page.locator('.chat-dock--right .station-terminal').count()) === 0
    ) {
      if ((await right.getAttribute('aria-pressed')) !== 'true')
        await right.click();
      await page
        .getByRole('list', { name: 'Add to Right region' })
        .getByRole('button', { name: /^Terminal( |$)/ })
        .click();
    }
    await page.locator('.chat-dock--right .station-terminal').first().waitFor({
      timeout: 120_000,
    });
    await page.evaluate(
      (t) => document.documentElement.setAttribute('data-theme', t),
      theme,
    );
    await neutralPrompt();
    await showcase();
    const path = join(out, `terminal-${theme}-1440-right.png`);
    await page.screenshot({ path });
    results.screenshots.push(path);
  }

  // The dock round trip, both ways a person brings the Terminal back to the
  // lower panel: the Views rail (moves it), and putting the Right region
  // away (its view stays mounted, hidden, on the same session). Each must
  // fill the panel, stay connected, and echo what is typed.
  const right = page.getByRole('button', { name: 'Right region', exact: true });
  const dockRight = async () => {
    if ((await right.getAttribute('aria-pressed')) !== 'true')
      await right.click();
    await page
      .getByRole('list', { name: 'Add to Right region' })
      .getByRole('button', { name: /^Terminal( |$)/ })
      .click();
    await page
      .locator('.chat-dock--right .station-terminal[data-state="ready"]')
      .first()
      .waitFor({ timeout: 60_000 });
  };
  const lowerTerminal = page
    .locator('.coding-workbench__lower .station-terminal[data-state="ready"]')
    .filter({ visible: true })
    .first();
  const roundTrip = async (variant) => {
    await lowerTerminal.waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1500);
    const input = lowerTerminal.getByRole('textbox', {
      name: 'Terminal input',
    });
    const before = await input.evaluate((el) => el.style.left);
    await input.focus();
    await page.keyboard.type(`echo back-${variant}`);
    await page.waitForTimeout(1500);
    const path = join(out, `terminal-dark-1440-roundtrip-${variant}.png`);
    await page.screenshot({ path });
    results.screenshots.push(path);
    results.roundTrip.push({
      variant,
      terminalHeight: Math.round((await lowerTerminal.boundingBox()).height),
      notice: await page
        .locator('.coding-workbench__lower .coding-terminal-connection')
        .filter({ visible: true })
        .allTextContents(),
      echoed: (await input.evaluate((el) => el.style.left)) !== before,
    });
    await page.keyboard.press('Control+U');
  };
  // Docked right from the loop above: back through the rail.
  await page
    .getByRole('navigation', { name: 'Views' })
    .getByRole('button', { name: /^Terminal(,|$)/ })
    .first()
    .click();
  await roundTrip('rail');
  await dockRight();
  await right.click();
  await roundTrip('region-hidden');

  // Keystroke to glyph. The hidden input is positioned at the cursor cell
  // after each drawn frame, so from the page's own keydown until its `left`
  // changes is input -> shell echo -> emulator -> drawn cursor. Both ends are
  // stamped in the page, so the driver's round trip is not counted.
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTerminal();
  await type('clear\r');
  await page.waitForTimeout(1000);
  for (let i = 0; i < 30; i += 1) {
    // Arm before typing: an unawaited evaluate can land after the keystroke,
    // and then it waits for a keydown that already happened.
    await terminalInput.evaluate((input) => {
      window.__terminalEcho = new Promise((done, fail) => {
        const left = input.style.left;
        const armed = performance.now();
        let pressed = 0;
        input.addEventListener(
          'keydown',
          () => {
            pressed = performance.now();
          },
          { capture: true, once: true },
        );
        const check = () => {
          if (pressed && input.style.left !== left)
            done(performance.now() - pressed);
          else if (pressed && performance.now() - pressed > 5000)
            fail(new Error('no glyph within 5 s'));
          else if (!pressed && performance.now() - armed > 10000)
            fail(new Error('no keydown on the terminal input within 10 s'));
          else requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      });
    });
    await page.keyboard.type(String.fromCharCode(97 + (i % 26)));
    const echoed = await page.evaluate(() => window.__terminalEcho);
    results.latencyMs.push(Math.round(echoed * 10) / 10);
  }
  await page.keyboard.press('Control+U');
  {
    const sorted = [...results.latencyMs].sort((a, b) => a - b);
    // Nearest rank: the value at or below which that share of samples fall.
    const rank = (p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
    results.latency = {
      samples: sorted.length,
      medianMs: rank(0.5),
      p95Ms: rank(0.95),
      minMs: sorted[0],
      maxMs: sorted[sorted.length - 1],
    };
  }

  // Flood: the page's frames per second over a 10 s window while the shell
  // prints five million lines. The flood touches a file when it ends, so the
  // results say whether it outlasted the window.
  const floodWindowMs = 10_000;
  const floodDone = join(repo, 'flood-done');
  const floodStart = Date.now();
  await type('seq 1 5000000; touch flood-done\r');
  results.flood = await page.evaluate(
    (windowMs) =>
      new Promise((done) => {
        const perSecond = [];
        let frames = 0;
        let maxGap = 0;
        const start = performance.now();
        let last = start;
        const tick = (now) => {
          frames += 1;
          maxGap = Math.max(maxGap, now - last);
          last = now;
          const second = Math.floor((now - start) / 1000);
          perSecond[second] = (perSecond[second] ?? 0) + 1;
          if (now - start < windowMs) requestAnimationFrame(tick);
          else
            done({
              frames,
              seconds: (now - start) / 1000,
              framesPerSecond: frames / ((now - start) / 1000),
              perSecond: perSecond.slice(0, windowMs / 1000),
              maxFrameGapMs: Math.round(maxGap),
            });
        };
        requestAnimationFrame(tick);
      }),
    floodWindowMs,
  );
  results.flood.lines = 5_000_000;
  results.flood.outlastedWindow = !existsSync(floodDone);
  while (!existsSync(floodDone) && Date.now() - floodStart < 300_000)
    await page.waitForTimeout(500);
  results.flood.floodSeconds = existsSync(floodDone)
    ? (Date.now() - floodStart) / 1000
    : null;
  results.environment.loadAverageAfter = loadavg();
} finally {
  writeFileSync(
    join(out, 'results.json'),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  await browser.close();
  await station.stop();
}
console.log(JSON.stringify(results, null, 2));
