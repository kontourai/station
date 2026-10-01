import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { BrowserCodeLoginManager } from '../browser-code-login.js';

const makeTempDir = trackTempDirs();
const managers: BrowserCodeLoginManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) m.close();
});
test('the CLI receives the browser code privately and only verified auth completes sign-in', async () => {
  const dir = makeTempDir('browser-login-test-');
  const script = `import{writeFileSync}from'node:fs';import{join}from'node:path';console.log('If the browser did not open: https://claude.com/cai/oauth/authorize?state=STATE&code_challenge=CHALLENGE');console.log('Paste code here if prompted >');process.stdin.once('data',chunk=>{if(chunk.toString().trim()!=='AUTH#STATE')process.exit(2);writeFileSync(join(process.env.CLAUDE_CONFIG_DIR,'verified'),'yes');process.exit(0);});`;
  const manager = new BrowserCodeLoginManager({
    env: async () => process.env,
    spawn: (command, args, options) => {
      expect(command).toBe('claude');
      expect(args).toEqual(['auth', 'login', '--claudeai']);
      return spawn(process.execPath, ['--input-type=module', '-e', script], {
        ...options,
        windowsHide: true,
      });
    },
    verify: async (_engine, profile) => {
      try {
        await readFile(join(profile, 'verified'));
        return { state: 'authenticated' };
      } catch {
        return { state: 'unauthenticated' };
      }
    },
    capabilities: async () => ({
      engine: 'claude',
      observedAt: new Date().toISOString(),
      evidence: [
        {
          mechanism: 'browser-code',
          argument: '--claudeai',
          observedCommand: ['claude', 'auth', 'login', '--help'],
          observedMatch: '--claudeai',
        },
      ],
    }),
  });
  managers.push(manager);
  await manager.start(dir, () => true);
  await vi.waitFor(() => expect(manager.get(dir)?.phase).toBe('awaiting-code'));
  expect(() => manager.submit(dir, 'AUTH#STATE', () => false)).toThrow(
    'no longer accepting',
  );
  manager.submit(dir, 'AUTH#STATE', () => true);
  await vi.waitFor(() => expect(manager.get(dir)?.phase).toBe('completed'));
  expect(JSON.stringify(manager.get(dir))).not.toContain('AUTH#STATE');
});
