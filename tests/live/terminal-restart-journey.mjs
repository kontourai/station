/**
 * The terminal's restart journey against a real isolated Station on this
 * checkout, in a real browser:
 *
 *   node tests/live/terminal-restart-journey.mjs --out <dir>
 *
 * Opens a shell in the Coding terminal, starts a program that prints a
 * numbered line every half second, reloads the page and restarts the server
 * (`station restart`, a supervisor handoff) while it runs, then checks the
 * same shell (same PID) is still attached and every line reached the journal
 * and the screen. It then stops Station altogether and starts it again: the
 * shell is restored under the same id with a new PID, in the same directory,
 * below a "restored after restart" divider, with the earlier output above it.
 *
 * Reads what the terminal renders through its screen reader mirror
 * (Settings › Appearance › Terminal screen reader mode, switched on through
 * the Settings page). The shell is the platform default: cmd.exe on Windows,
 * /bin/sh elsewhere. Uses its own temp home and ports 41850/41860; it never
 * touches another instance. Writes results.json and screenshots to <dir>.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import {
  apiOk,
  pairBrowser,
  poll,
  runStation,
  startTempHomeInstance,
} from './helpers/station-instance.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const INSTANCE = 'terminal-restart-journey';
const SERVER_PORT = 41850;
const UI_PORT = 41860;
const TICKS = 40;
const windows = process.platform === 'win32';

const { values } = parseArgs({ options: { out: { type: 'string' } } });
if (!values.out) throw new Error('--out <dir> is required');
const out = resolve(values.out);
mkdirSync(out, { recursive: true });

// The platform's own default shell, not the developer's: Git Bash and MSYS
// export a SHELL path no Windows process can start.
const env = { ...process.env };
delete env.SHELL;
// Markers the shell prints but its typed echo does not contain.
const print = (left, right) =>
  windows ? `echo ${left}^${right}` : `printf '%s%s\\n' '${left}' '${right}'`;
const pwd = windows ? 'cd' : 'pwd';
const enter = '\r';

const home = mkdtempSync(join(tmpdir(), 'station-terminal-journey-'));
const repo = mkdtempSync(join(tmpdir(), 'station-terminal-journey-repo-'));
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
    node: process.version,
  },
  steps: [],
  passed: false,
};
const step = (name, detail = {}) => {
  results.steps.push({ name, at: new Date().toISOString(), ...detail });
  console.log(`✓ ${name}`, Object.keys(detail).length ? detail : '');
};
const check = (condition, message, detail) => {
  if (!condition)
    throw new Error(`${message}${detail ? `: ${JSON.stringify(detail)}` : ''}`);
};

const station = await startTempHomeInstance({
  root: ROOT,
  instance: INSTANCE,
  serverPort: SERVER_PORT,
  uiPort: UI_PORT,
  home,
  logPath: join(out, 'station.log'),
  env,
});
step('isolated Station started', {
  home,
  serverPort: SERVER_PORT,
  uiPort: UI_PORT,
});
const browser = await chromium.launch();
results.environment.chromium = browser.version();
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  await page.addInitScript(() =>
    localStorage.setItem('station:onboarding-setup-dismissed', '1'),
  );
  const pair = () =>
    pairBrowser(page, {
      root: ROOT,
      instance: INSTANCE,
      serverPort: SERVER_PORT,
      uiOrigin: station.uiOrigin,
    });
  await pair();
  step('browser paired');

  // A person's path to the mirror: Settings › Appearance.
  await page.goto(
    `${station.uiOrigin}/settings?view=appearance&highlight=terminal-screen-reader`,
    { waitUntil: 'load' },
  );
  const screenReader = page.getByRole('switch', {
    name: 'Terminal screen reader mode',
  });
  await screenReader.waitFor({ timeout: 60_000 });
  if ((await screenReader.getAttribute('aria-checked')) !== 'true')
    await screenReader.click();
  await poll('screen reader mode on', 10_000, async () => {
    return (await screenReader.getAttribute('aria-checked')) === 'true';
  });
  step('terminal screen reader mode switched on in Settings');

  const slug = 'terminal-journey';
  await apiOk(page, 'POST', '/api/projects', {
    name: 'Terminal Journey',
    slug,
    workingDirectory: repo,
  });
  const applied = await apiOk(
    page,
    'POST',
    `/api/projects/${slug}/layouts/apply`,
    { layoutId: 'builtin:coding' },
  );
  const layoutSlug = applied.data?.slug;
  check(layoutSlug, 'Coding layout did not apply');

  const liveTerminal = page
    .locator(
      '.station-terminal[data-state="ready"]:not([inert] *):not([aria-hidden="true"] *)',
    )
    .filter({ visible: true })
    .first();
  const terminalInput = liveTerminal.getByRole('textbox', {
    name: 'Terminal input',
  });
  const mirror = liveTerminal.locator('.station-terminal__mirror');
  // Rows join without separators, so text a row wrapped stays whole.
  const screen = async () => (await mirror.textContent()) ?? '';
  const onScreen = (text, timeoutMs = 60_000) =>
    poll(`"${text}" on screen`, timeoutMs, async () =>
      (await screen()).includes(text),
    );
  const openTerminal = async () => {
    await page.goto(
      `${station.uiOrigin}/projects/${slug}/layouts/${layoutSlug}`,
      { waitUntil: 'load' },
    );
    // A view whose panel is already open adopts the binding's shell. The
    // Views rail button toggles the panel, so click it only when no shell
    // is shown: clicking an open panel that is still loading closes it.
    const shown = await liveTerminal.waitFor({ timeout: 30_000 }).then(
      () => true,
      () => false,
    );
    if (!shown) {
      const newTerminal = page
        .getByTitle('New terminal')
        .filter({ visible: true })
        .first();
      const panelOpen = await newTerminal.waitFor({ timeout: 10_000 }).then(
        () => true,
        () => false,
      );
      if (!panelOpen)
        await page
          .getByRole('navigation', { name: 'Views' })
          .getByRole('button', { name: /^Terminal(,|$)/ })
          .first()
          .click();
      await newTerminal.waitFor({ timeout: 120_000 });
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
        await page
          .getByRole('dialog', { name: 'New terminal' })
          .getByRole('button', { name: /Shell/ })
          .click({ timeout: 30_000 });
      }
      await liveTerminal.waitFor({ timeout: 120_000 });
    }
    await terminalInput.waitFor({ state: 'attached', timeout: 120_000 });
    await mirror.waitFor({ state: 'attached', timeout: 60_000 });
  };
  const type = async (text) => {
    await terminalInput.focus();
    await page.keyboard.type(text);
  };
  const shells = async () =>
    (await apiOk(page, 'GET', `/api/projects/${slug}/terminal-sessions`)).data;
  const journalText = async (terminalId) =>
    (
      await apiOk(
        page,
        'GET',
        `/api/projects/${slug}/terminal-sessions/${terminalId}`,
      )
    ).data;
  const shot = (name) => page.screenshot({ path: join(out, `${name}.png`) });

  await openTerminal();
  // The list names the shells; a session read carries its PID.
  const [listed] = await shells();
  check(listed?.status === 'running', 'no running shell', listed);
  const { terminalId } = listed;
  const { pid } = await journalText(terminalId);
  check(Number.isInteger(pid), 'the shell has no pid', { pid });
  step('shell opened in the Coding terminal', { terminalId, pid });

  await type(`${print('journey-', 'before')}${enter}`);
  await onScreen('journey-before');
  step('typed command output rendered');

  // A program that keeps printing through the reload and the restart.
  writeFileSync(
    join(repo, 'ticks.js'),
    `let n=0;const t=setInterval(()=>{n++;console.log('tick-'+n);if(n===${TICKS}){clearInterval(t);console.log('ticks-'+'done')}},500)`,
  );
  await type(`"${process.execPath}" ticks.js${enter}`);
  await onScreen('tick-2');

  await page.reload({ waitUntil: 'load' });
  await openTerminal();
  await onScreen('tick-');
  const afterReload = await journalText(terminalId);
  check(afterReload?.pid === pid, 'reload changed the shell', afterReload);
  step('page reloaded: same shell attached', { pid: afterReload.pid });
  await shot('after-reload');

  const restarted = await runStation(
    ROOT,
    ['restart', `--instance=${INSTANCE}`],
    {
      timeoutMs: 10 * 60_000,
      env,
    },
  );
  writeFileSync(join(out, 'station-restart.txt'), restarted.output);
  check(restarted.code === 0, `station restart exited ${restarted.code}`);
  step('server restarted (station restart: supervisor handoff)');

  await onScreen('ticks-done', 120_000);
  const afterRestart = await journalText(terminalId);
  check(
    afterRestart?.pid === pid,
    'server restart changed the shell',
    afterRestart,
  );
  const replay = await journalText(terminalId);
  const text = replay.journal.records.map((r) => r.data).join('');
  const seqs = replay.journal.records.map((r) => r.seq);
  const missing = [];
  const duplicated = [];
  for (let n = 1; n <= TICKS; n++) {
    const found = text.match(new RegExp(`tick-${n}(?!\\d)`, 'g'))?.length ?? 0;
    if (found === 0) missing.push(n);
    if (found > 1) duplicated.push(n);
  }
  const contiguous = seqs.every(
    (seq, index) => index === 0 || seq === seqs[index - 1] + 1,
  );
  check(missing.length === 0, 'output lost across the restart', { missing });
  check(contiguous, 'journal sequence has a gap');
  step('same shell after server restart, no lost output', {
    pid: afterRestart.pid,
    ticks: TICKS,
    missing,
    repaintedTicks: duplicated,
    records: seqs.length,
    firstSeq: seqs[0],
    lastSeq: seqs.at(-1),
  });
  await shot('after-server-restart');

  await type(`${print('journey-', 'after')}${enter}`);
  await onScreen('journey-after');

  // Stop the supervisor too: the shell's host is gone, so it is restored.
  const stopped = await station.stop();
  check(stopped.code === 0, 'station stop failed');
  step('Station stopped (supervisor and shell host gone)');
  const startedAgain = await runStation(
    ROOT,
    [
      'start',
      `--instance=${INSTANCE}`,
      `--base=${home}`,
      `--port=${SERVER_PORT}`,
      `--ui-port=${UI_PORT}`,
      `--log=${join(out, 'station-second.log')}`,
    ],
    { timeoutMs: 20 * 60_000, env },
  );
  check(startedAgain.code === 0, `station start exited ${startedAgain.code}`);
  await poll('UI to serve / again', 120_000, async () => {
    const response = await fetch(`http://127.0.0.1:${UI_PORT}/`);
    return response.ok;
  });
  step('Station started again on the same home');

  await pair();
  await openTerminal();
  await onScreen('restored after restart', 120_000);
  const restored = await journalText(terminalId);
  check(restored?.status === 'running', 'shell not restored', restored);
  check(restored.pid !== pid, 'restored shell kept the old pid', restored);
  check(restored.restoredAt, 'no restoredAt', restored);
  await type(`${print('journey-', 'restored')}${enter}`);
  await onScreen('journey-restored');
  await type(`${pwd}${enter}`);
  await onScreen(repo.split(/[\\/]/).at(-1));
  const restoredJournal = (await journalText(terminalId)).journal.records
    .map((r) => r.data)
    .join('');
  const divider = restoredJournal.indexOf('restored after restart');
  check(
    restoredJournal.indexOf('journey-after') >= 0 &&
      restoredJournal.indexOf('journey-after') < divider,
    'earlier output is not above the divider',
  );
  check(
    restoredJournal.indexOf('ticks-done') < divider &&
      restoredJournal.lastIndexOf('tick-1') < divider,
    'the ticking program ran again after restore',
  );
  step(
    'restored after host restart: same id, new pid, same directory, divider',
    {
      terminalId: restored.terminalId,
      oldPid: pid,
      newPid: restored.pid,
      restoredAt: restored.restoredAt,
      cwd: restored.cwd,
    },
  );
  await shot('after-restore');
  results.passed = true;
} catch (error) {
  results.error = String(error?.stack ?? error);
  console.error(error);
  process.exitCode = 1;
} finally {
  writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2));
  await browser.close();
  await station.stop();
}
