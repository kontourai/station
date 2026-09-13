import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { runDesktopDevProcesses } from '../dev-desktop.mjs';

async function waitForFile(path: string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, 'utf8');
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Fixture did not start');
}

test.each(['SIGINT', 'SIGTERM', 'child-exit'])(
  'desktop %s settles both launchers and their native descendants',
  async (trigger) => {
    const root = await mkdtemp(join(tmpdir(), 'station-desktop-tree-'));
    const signals = new EventEmitter();
    const fixture = join(root, 'launcher.mjs');
    await writeFile(
      fixture,
      `
    import {spawn} from 'node:child_process';
    import {writeFileSync, existsSync} from 'node:fs';
    const name = process.argv[2];
    const child = spawn(process.execPath, ['-e', "require('node:fs').writeFileSync(process.argv[1],String(process.pid)); setInterval(()=>{},1000)", name+'.child'], {stdio:'ignore',windowsHide:true});
    writeFileSync(name+'.parent',String(process.pid));
    setInterval(()=>{if(existsSync(name+'.exit'))process.exit(0);},25);
  `,
    );
    const execution = runDesktopDevProcesses(
      ['vite', 'tauri'].map((name) => ({
        executable: process.execPath,
        args: [fixture, join(root, name)],
        label: name,
      })),
      { cwd: root, env: process.env, signals },
    );
    try {
      const pids = await Promise.all(
        ['vite.parent', 'vite.child', 'tauri.parent', 'tauri.child'].map(
          async (name) => Number(await waitForFile(join(root, name))),
        ),
      );
      if (trigger === 'child-exit')
        await writeFile(join(root, 'tauri.exit'), 'exit');
      else signals.emit(trigger);
      expect(await execution).toBe(
        trigger === 'SIGINT' ? 130 : trigger === 'SIGTERM' ? 143 : 0,
      );
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      expect(signals.listenerCount('SIGINT')).toBe(0);
      expect(signals.listenerCount('SIGTERM')).toBe(0);
    } finally {
      signals.emit('SIGTERM');
      await execution;
      await rm(root, { recursive: true, force: true });
    }
  },
  25000,
);

test('a spawn failure is observable and still settles the sibling process', async () => {
  const signals = new EventEmitter();
  const result = await runDesktopDevProcesses(
    [
      {
        executable: process.execPath,
        args: ['-e', 'setInterval(()=>{},1000)'],
        label: 'sibling',
      },
      {
        executable: join(tmpdir(), 'station-deliberately-missing-executable'),
        args: [],
        label: 'missing',
      },
    ],
    { cwd: tmpdir(), env: process.env, signals },
  );
  expect(result).toBe(1);
  expect(signals.listenerCount('SIGTERM')).toBe(0);
}, 15000);
