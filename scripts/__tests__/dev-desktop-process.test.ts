import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { runDesktopDevProcesses } from '../dev-desktop.mjs';

async function waitForFixturePid(
  path: string,
  poll = () => new Promise<void>((resolve) => setTimeout(resolve, 25)),
) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const marker = await readFile(path, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const value = marker.trim();
    if (value) {
      const pid = Number(value);
      if (!/^[1-9]\d*$/.test(value) || pid <= 1 || pid > 0x7fffffff)
        throw new Error(`Invalid fixture PID in ${path}`);
      return pid;
    }
    await poll();
  }
  throw new Error(`Fixture did not publish its PID in ${path}`);
}

test('an empty fixture marker waits for a published PID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'station-desktop-marker-'));
  const marker = join(root, 'child.pid');
  try {
    await writeFile(marker, '');
    await expect(
      waitForFixturePid(marker, () => writeFile(marker, '12345')),
    ).resolves.toBe(12345);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
    import {writeFileSync, existsSync, renameSync} from 'node:fs';
    import {fileURLToPath} from 'node:url';
    const name = process.argv[2];
    const isChild = process.argv[3] === 'child';
    if (!isChild)
      spawn(process.execPath, [fileURLToPath(import.meta.url), name, 'child'], {stdio:'ignore',windowsHide:true});
    const marker = name + (isChild ? '.child' : '.parent');
    writeFileSync(marker+'.tmp', String(process.pid));
    renameSync(marker+'.tmp', marker);
    if (isChild) setInterval(()=>{},1000);
    else setInterval(()=>{if(existsSync(name+'.exit'))process.exit(0);},25);
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
          async (name) => ({
            name,
            pid: await waitForFixturePid(join(root, name)),
          }),
        ),
      );
      if (trigger === 'child-exit')
        await writeFile(join(root, 'tauri.exit'), 'exit');
      else signals.emit(trigger);
      expect(await execution).toBe(
        trigger === 'SIGINT' ? 130 : trigger === 'SIGTERM' ? 143 : 0,
      );
      for (const { name, pid } of pids)
        expect(() => process.kill(pid, 0), `${name} PID ${pid}`).toThrow(
          expect.objectContaining({ code: 'ESRCH' }),
        );
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
