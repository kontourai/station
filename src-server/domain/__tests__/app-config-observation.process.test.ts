import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test.skipIf(process.platform === 'win32')(
  'replacing app.json with a FIFO immediately before open refuses without blocking',
  { timeout: 10_000 },
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-config-fifo-'));
    mkdirSync(join(home, 'config'));
    writeFileSync(
      join(home, 'config', 'app.json'),
      '{"defaultModel":"preserve"}',
    );
    const child = spawn(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        fileURLToPath(
          new URL(
            './fixtures/app-config-observation-process.ts',
            import.meta.url,
          ),
        ),
        home,
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.resume();
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      const [code, signal] = await once(child, 'exit');
      expect({ code, signal }).toEqual({ code: 0, signal: null });
      expect(JSON.parse(stdout)).toEqual({
        swapped: true,
        refused: true,
        originalRetained: true,
      });
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
      rmSync(home, { recursive: true, force: true });
    }
  },
);
