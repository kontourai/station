/**
 * A client capability flag follows its handler through the real adapter:
 * with `_kiro/userInput` taken out of the reviewed table, the adapter
 * registers no handler for it, so `initialize` (as the fake engine records
 * it) no longer announces `_meta.kiro.userInput`, and the request, if the
 * engine sent it anyway, is refused rather than answered.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { AcpAdapter } from '../adapters/acp-adapter.js';
import { quietLogger } from './acp-engine-qualification-harness.js';

vi.mock(
  '../../services/acp/acp-inbound-extension-policy.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../services/acp/acp-inbound-extension-policy.js')
      >();
    return {
      ...actual,
      REVIEWED_INBOUND_EXTENSION_REQUESTS:
        actual.REVIEWED_INBOUND_EXTENSION_REQUESTS.filter(
          (entry) => entry.method !== '_kiro/userInput',
        ),
    };
  },
);

const FAKE_AGENT = fileURLToPath(
  new URL('./fixtures/fake-acp-agent.mjs', import.meta.url),
);
const PROFILE = fileURLToPath(
  new URL('./fixtures/acp-scripted-profiles/kiro-v3.json', import.meta.url),
);
const makeTempDir = trackTempDirs();
const adapters: AcpAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.stopAll()));
});

describe.skipIf(process.platform === 'win32')(
  'announced client capabilities follow the adapter’s handlers',
  () => {
    test('without a userInput handler, userInput is not announced; the others still are', async () => {
      const dir = makeTempDir('station-acp-kiro-announce-');
      const record = join(dir, 'record.jsonl');
      writeFileSync(record, '');
      const adapter = new AcpAdapter({
        getConnections: async () => [
          {
            id: 'kiro-under-test',
            name: 'Kiro',
            command: process.execPath,
            args: [FAKE_AGENT, '--engine-profile', PROFILE, '--record', record],
            enabled: true,
          },
        ],
        logger: quietLogger,
      });
      adapters.push(adapter);
      void (async () => {
        for await (const _event of adapter.streamEvents());
      })();
      await adapter.startSession({
        provider: 'acp',
        threadId: 'announce',
        cwd: dir,
        confinement: 'workspace',
        metadata: { connectionId: 'kiro-under-test' },
      } as never);
      const initialize = readFileSync(record, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((entry) => entry.method === 'initialize');
      expect(initialize?.clientMeta).toEqual({
        kiro: { openExternalUrl: true },
      });
    });
  },
);
