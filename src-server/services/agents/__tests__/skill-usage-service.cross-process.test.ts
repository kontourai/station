/**
 * Cross-process serialization of the skill usage counters.
 *
 * Separate file, and classified `process-heavy` in
 * `scripts/vitest-resource-manifest.mjs`, because it spawns real child
 * processes: a same-process promise queue can never prove what review finding 1
 * was about — two Station servers sharing one home each reading `runs: 0` and
 * each writing `runs: 1`.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { SkillUsageService } from '../skill-usage-service.js';

let homeDir: string;
let service: SkillUsageService;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'skill-usage-xp-'));
  service = new SkillUsageService(() => homeDir);
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

/** A real second OS process, running the same TypeScript source. */
function runChild(
  script: string,
  args: string[],
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', script, ...args],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

test('two processes counting the same skill lose no increments', async () => {
  const script = join(homeDir, 'bump.mjs');
  writeFileSync(
    script,
    `import { SkillUsageService } from ${JSON.stringify(
      new URL('../skill-usage-service.ts', import.meta.url).href,
    )};
const service = new SkillUsageService(() => process.argv[2]);
for (let i = 0; i < Number(process.argv[3]); i += 1) {
  await service.trackRun('shared');
}
`,
    'utf-8',
  );

  const runs = 15;
  const [a, b] = await Promise.all([
    runChild(script, [homeDir, String(runs)]),
    runChild(script, [homeDir, String(runs)]),
  ]);
  expect(a.code, a.stderr).toBe(0);
  expect(b.code, b.stderr).toBe(0);

  // Without the on-disk mutation lock the two read-modify-writes interleave
  // and the total lands short of 2N.
  expect(service.statsFor('shared')?.runs).toBe(runs * 2);
}, 120_000);
