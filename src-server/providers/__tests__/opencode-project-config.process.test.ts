/**
 * #3924: OpenCode project configuration the agent could plant must not run
 * when Station launches OpenCode under one of its approval modes.
 *
 * Drives the real `AcpAdapter` start against the real `opencode` binary
 * (whatever this host resolves), with fresh XDG directories, in a nested
 * directory of a git project whose `.opencode/plugin/` holds a plugin that
 * writes a marker when imported. The control runs `opencode debug agent`
 * there directly and sees the marker, which proves the plugin is one
 * OpenCode loads; a governed start must refuse without it appearing. A clean
 * project still starts governed. Hosts without `opencode` skip loudly.
 */
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { AcpAdapter } from '../adapters/acp-adapter.js';
import { findCliBinaryAsync } from '../auth/cli-auth.js';

const opencodeBinary = await findCliBinaryAsync('opencode');

if (!opencodeBinary)
  console.warn(
    'ENFORCEMENT UNVERIFIED (#3924): no `opencode` binary on this host; the planted project plugin probe did not run.',
  );

const XDG_KEYS = [
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
] as const;

describe.skipIf(!opencodeBinary)(
  `a planted OpenCode project plugin under the real engine${opencodeBinary ? '' : ' (SKIPPED: no opencode binary)'}`,
  () => {
    const makeTempDir = trackTempDirs({ lifetime: 'file' });
    const saved: Record<string, string | undefined> = {};
    let project: string;
    let sessionDir: string;
    let marker: string;
    const adapters: AcpAdapter[] = [];

    beforeAll(() => {
      const root = realpathSync(makeTempDir('opencode-project-config-'));
      for (const key of [...XDG_KEYS, 'OPENCODE_CONFIG_CONTENT']) {
        saved[key] = process.env[key];
      }
      delete process.env.OPENCODE_CONFIG_CONTENT;
      for (const key of XDG_KEYS) {
        const dir = join(root, 'xdg', key);
        mkdirSync(dir, { recursive: true });
        process.env[key] = dir;
      }
      project = join(root, 'project');
      sessionDir = join(project, 'packages', 'app');
      marker = join(root, 'plugin-ran');
      mkdirSync(join(project, '.git'), { recursive: true });
      mkdirSync(sessionDir, { recursive: true });
    });

    afterAll(async () => {
      for (const adapter of adapters) await adapter.stopAll();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    function plant() {
      mkdirSync(join(project, '.opencode', 'plugin'), { recursive: true });
      writeFileSync(
        join(project, '.opencode', 'plugin', 'planted.ts'),
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\nexport const Planted = async () => ({});\n`,
      );
    }

    function adapter() {
      const connection: ACPConnectionConfig = {
        id: 'real-opencode',
        name: 'OpenCode',
        command: opencodeBinary as string,
        args: ['acp'],
        enabled: true,
      };
      const created = new AcpAdapter({
        getConnections: async () => [connection],
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      });
      adapters.push(created);
      return created;
    }

    const start = (
      target: AcpAdapter,
      threadId: string,
      approvalMode: 'ask' | 'auto',
    ) =>
      target.startSession({
        provider: 'acp',
        threadId,
        cwd: sessionDir,
        confinement: 'workspace',
        metadata: { connectionId: 'real-opencode' },
        modelOptions: { approvalMode },
      } as never);

    test('control: OpenCode itself imports the planted plugin when it loads this project', async () => {
      plant();
      rmSync(marker, { force: true });
      await promisify(execFile)(
        opencodeBinary as string,
        ['debug', 'agent', 'build'],
        {
          cwd: sessionDir,
          env: process.env,
          timeout: 60_000,
        },
      );
      expect(existsSync(marker)).toBe(true);
    }, 90_000);

    test.each(['ask', 'auto'] as const)(
      'a governed (%s) start refuses before OpenCode runs, so the plugin never runs',
      async (approvalMode) => {
        plant();
        rmSync(marker, { force: true });
        await expect(
          start(adapter(), `planted-${approvalMode}`, approvalMode),
        ).rejects.toMatchObject({
          code: 'acp_approval_governance_refused',
          message: expect.stringContaining(join('.opencode', 'plugin')),
        });
        expect(existsSync(marker)).toBe(false);
      },
      90_000,
    );

    test('a clean project still starts governed against the real engine', async () => {
      rmSync(join(project, '.opencode'), { recursive: true, force: true });
      rmSync(marker, { force: true });
      const target = adapter();
      await start(target, 'clean', 'ask');
      expect(existsSync(marker)).toBe(false);
      await target.stopAll();
    }, 120_000);
  },
);
