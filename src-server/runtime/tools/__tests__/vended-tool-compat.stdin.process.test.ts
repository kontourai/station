/**
 * #776: the vended `bash` tool keeps one persistent shell per agent and
 * writes each command to its stdin. A ChildProcess 'error' listener does not
 * see stdin stream errors, so a write that meets a dead shell (EPIPE) was an
 * uncaught exception that ended the whole server, and the tool is
 * agent-invokable. These drive the real tool against a real bash.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  createBuiltinVendedTool,
  createBuiltinVendedToolDef,
} from '../vended-tool-compat.js';

type BashTool = {
  execute: (input: {
    mode: 'execute' | 'restart';
    command?: string;
    timeout?: number;
  }) => Promise<{ output: string; error: string }>;
};

let escaped: unknown[] = [];
const onUncaught = (error: unknown) => escaped.push(error);

beforeEach(() => {
  escaped = [];
  process.on('uncaughtException', onUncaught);
});

afterEach(() => {
  process.off('uncaughtException', onUncaught);
});

function bashTool(agentSlug: string): BashTool {
  const toolDef = createBuiltinVendedToolDef('bash');
  if (!toolDef) throw new Error('bash tool definition missing');
  const tool = createBuiltinVendedTool(agentSlug, toolDef);
  if (!tool?.execute) throw new Error('bash tool missing');
  return tool as unknown as BashTool;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe.skipIf(process.platform === 'win32')(
  'vended bash survives a shell that is gone before its stdin is written (#776)',
  () => {
    test('a shell that exits mid-write rejects that command, not the server', async () => {
      const tool = bashTool('agent-stdin-midwrite');
      // bash reads `exit 0` and exits while most of the 4 MiB command is
      // still queued behind the pipe buffer: the rest of the write meets a
      // pipe with no reader.
      const command = `exit 0\n: ${'x'.repeat(4 * 1024 * 1024)}`;
      await expect(
        tool.execute({ mode: 'execute', command, timeout: 10 }),
      ).rejects.toThrow();
      await settle();
      expect(escaped).toEqual([]);

      // The session recovers with a fresh shell.
      await expect(
        tool.execute({ mode: 'execute', command: 'echo alive' }),
      ).resolves.toMatchObject({ output: 'alive' });
      expect(escaped).toEqual([]);
    }, 20_000);

    test('a command sent after the shell exited, but before its streams closed, gets a fresh shell', async () => {
      const tool = bashTool('agent-stdin-exit-before-close');
      // The backgrounded sleep keeps bash's stdout open, so 'close' trails
      // bash's own exit by seconds. Its stdin is /dev/null, so nothing still
      // reads the old shell's stdin pipe.
      const exiting = tool
        .execute({
          mode: 'execute',
          command: 'sleep 2 </dev/null & exit 0',
          timeout: 10,
        })
        .then(
          () => 'resolved',
          (error: Error) => error.message,
        );
      await new Promise((resolve) => setTimeout(resolve, 500));

      await expect(
        tool.execute({ mode: 'execute', command: 'echo alive', timeout: 10 }),
      ).resolves.toMatchObject({ output: 'alive' });
      await expect(exiting).resolves.toMatch(/exited unexpectedly/);
      await settle();
      expect(escaped).toEqual([]);
    }, 20_000);
  },
);
