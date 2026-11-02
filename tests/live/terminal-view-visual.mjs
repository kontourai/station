/**
 * Visual and performance evidence for the Ghostty TerminalView in the Coding
 * terminal pane, against a real isolated Station on this checkout:
 *
 *   node tests/live/terminal-view-visual.mjs --out <dir> [--first-only]
 *
 * Screenshots the terminal at 390 and 1440 px in light and dark (bottom panel,
 * with and without a selection, and the right dock at 1440), then measures
 * keystroke-to-glyph latency and the frame rate while 200,000 lines print.
 * Writes the PNGs and results.json (revision, machine, per-shot layout,
 * latencies, frames) to <dir>. The shell is bash with a fixed prompt, so no
 * user, host or path is captured. Uses its own temp home and ports
 * 41810-41813 and 41820; it never touches another instance. Measure on an
 * otherwise idle machine: the numbers include whatever else it is doing.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
  flood: null,
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

  // The live terminal: a docked Terminal replaces the lower panel's, and an
  // inactive one sits in an inert, hidden container.
  const liveTerminal = page
    .locator(
      '.station-terminal[data-state="ready"]:not([inert] *):not([aria-hidden="true"] *)',
    )
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
    await page
      .getByRole('navigation', { name: 'Views' })
      .getByRole('button', { name: /^Terminal(,|$)/ })
      .first()
      .click();
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

  for (const theme of ['light', 'dark']) {
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.evaluate((t) => localStorage.setItem('theme', t), theme);
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
    await page.evaluate((t) => localStorage.setItem('theme', t), theme);
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

  // Back to the lower panel for the measurements.
  {
    const right = page.getByRole('button', {
      name: 'Right region',
      exact: true,
    });
    if ((await right.getAttribute('aria-pressed')) === 'true')
      await right.click();
  }

  // Keystroke to glyph. The hidden input is positioned at the cursor cell
  // after each drawn frame, so from the page's own keydown until its `left`
  // changes is input -> shell echo -> emulator -> drawn cursor. Both ends are
  // stamped in the page, so the driver's round trip is not counted.
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTerminal();
  await type('clear\r');
  await page.waitForTimeout(1000);
  for (let i = 0; i < 30; i += 1) {
    const echoed = terminalInput.evaluate(
      (input) =>
        new Promise((done, fail) => {
          const left = input.style.left;
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
            else requestAnimationFrame(check);
          };
          requestAnimationFrame(check);
        }),
    );
    await page.keyboard.type(String.fromCharCode(97 + (i % 26)));
    results.latencyMs.push(Math.round((await echoed) * 10) / 10);
  }
  await page.keyboard.press('Control+U');

  // Flood: count animation frames the page delivers while the shell prints.
  await type('yes | head -n 200000\r');
  results.flood = await page.evaluate(
    () =>
      new Promise((done) => {
        let frames = 0;
        const start = performance.now();
        const tick = () => {
          frames += 1;
          if (performance.now() - start < 5000) requestAnimationFrame(tick);
          else done({ frames, seconds: (performance.now() - start) / 1000 });
        };
        requestAnimationFrame(tick);
      }),
  );
} finally {
  writeFileSync(
    join(out, 'results.json'),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  await browser.close();
  await station.stop();
}
console.log(JSON.stringify(results, null, 2));
