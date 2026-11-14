/**
 * The availability probe answers Kiro's `_kiro/terminal/shell_type` the way
 * the chat client does (`client.terminal-facts`). Kiro's agent service asks
 * it during `session/new`, and a -32601 there failed the probe's own
 * session/new, so a working v3 engine read as unavailable. Driven through
 * the real ACPProcess against the fake ACP agent with the recorded kiro-cli
 * v3 profile, which sends the request before it answers session/new.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ACPProbe } from '../acp-probe.js';
import { ACPProcess } from '../acp-process.js';

const FAKE_AGENT = fileURLToPath(
  new URL(
    '../../../providers/__tests__/fixtures/fake-acp-agent.mjs',
    import.meta.url,
  ),
);
const PROFILE = fileURLToPath(
  new URL(
    '../../../providers/__tests__/fixtures/acp-scripted-profiles/kiro-v3.json',
    import.meta.url,
  ),
);
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const makeTempDir = trackTempDirs();
const probes: ACPProbe[] = [];
afterEach(async () => {
  await Promise.all(probes.splice(0).map((probe) => probe.dispose()));
});

describe.skipIf(process.platform === 'win32')(
  'the availability probe and client.terminal-facts',
  () => {
    test('answers shell_type during session/new with the bridge grammar', async () => {
      const dir = makeTempDir('station-acp-probe-shell-');
      const record = join(dir, 'record.jsonl');
      writeFileSync(record, '');
      const probe = new ACPProbe(
        {
          id: 'kiro-under-probe',
          name: 'Kiro',
          command: process.execPath,
          args: [FAKE_AGENT, '--engine-profile', PROFILE, '--record', record],
          enabled: true,
        },
        quiet,
        dir,
        (options) => new ACPProcess(options),
        20_000,
      );
      probes.push(probe);
      expect(await probe.probe('request')).toBe(true);
      const answers = readFileSync(record, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.clientRequest === '_kiro/terminal/shell_type');
      expect(answers).toEqual([
        {
          clientRequest: '_kiro/terminal/shell_type',
          phase: 'session/new',
          result: { shellType: 'sh' },
        },
      ]);
    }, 60_000);
  },
);
