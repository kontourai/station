/**
 * #4515 fix round 1: an ACP engine the managed policy does not allow is
 * never started. Every ACP launch (sessions, availability and startup
 * probes, sign-in) goes through `ACPProcess.start()`, and the OpenCode model
 * listing runs the program outside it, so both refuse before anything is
 * resolved or spawned. The probe cases run a real executable that leaves a
 * marker when it starts; the allowed control proves the marker would appear.
 */
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseManagedPolicyDocument,
  summarizeManagedPolicy,
} from '@kontourai/station-contracts/managed-policy';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  installManagedEngineLimits,
  isManagedEngineRefusal,
} from '../../../security/managed-engine-limits.js';
import { ACPProbe } from '../acp-probe.js';
import { ACPProcess } from '../acp-process.js';
import { runOpenCodeModelListing } from '../opencode-model-capabilities.js';

const makeTempDir = trackTempDirs();
const posix = process.platform !== 'win32';

afterEach(() => installManagedEngineLimits(null));

function installEngines(engines: Record<string, unknown>) {
  const parsed = parseManagedPolicyDocument({
    schemaVersion: 1,
    organization: 'Acme',
    limits: { engines },
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
  installManagedEngineLimits({
    document: parsed.document,
    summary: summarizeManagedPolicy(parsed.document),
  });
}

/** An executable that records that it ran, then exits. */
function markerProgram() {
  const dir = makeTempDir('station-acp-managed-refusal-');
  const marker = join(dir, 'ran');
  const program = join(dir, 'fake-acp');
  writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
  chmodSync(program, 0o755);
  return { dir, marker, program };
}

const logger = { debug: vi.fn(), warn: vi.fn(), info: vi.fn() };

describe('ACPProcess.start() under limits.engines', () => {
  test('a disallowed ACP engine is refused before its command is resolved', async () => {
    installEngines({ allowed: [] });
    const resolveCommand = vi.fn(async () => '/usr/bin/true');
    const acp = new ACPProcess({
      command: 'fake-acp',
      cwd: makeTempDir('station-acp-managed-cwd-'),
      createClient: () => ({}) as never,
      logger,
      resolveCommand,
    });
    const error = await acp.start().catch((caught: unknown) => caught);
    expect(isManagedEngineRefusal(error)).toBe(true);
    expect(resolveCommand).not.toHaveBeenCalled();
  });

  test('a public-registry agent is refused when the policy stops registry agents', async () => {
    installEngines({ allowed: ['acp'], acpRegistryAgents: false });
    const resolveCommand = vi.fn(async () => null);
    const acp = new ACPProcess({
      command: 'fake-acp',
      cwd: makeTempDir('station-acp-managed-cwd-'),
      createClient: () => ({}) as never,
      logger,
      resolveCommand,
      connection: { publicRegistry: { id: 'x', version: '1' } },
    });
    expect(
      isManagedEngineRefusal(await acp.start().catch((caught) => caught)),
    ).toBe(true);
    expect(resolveCommand).not.toHaveBeenCalled();
  });
});

describe.skipIf(!posix)('ACP probes under limits.engines', () => {
  const config = (program: string) => ({
    id: 'fake',
    name: 'Fake ACP',
    command: program,
    enabled: true,
  });

  test('with no engine allowed, a background probe (startup and periodic) spawns nothing', async () => {
    installEngines({ allowed: [] });
    const { dir, marker, program } = markerProgram();
    const probe = new ACPProbe(config(program), logger, dir);
    try {
      await expect(probe.probe('background')).resolves.toBe(false);
    } finally {
      await probe.dispose();
    }
    expect(existsSync(marker)).toBe(false);
  });

  test('control: with ACP allowed, the same probe runs the program', async () => {
    installEngines({ allowed: ['acp'] });
    const { dir, marker, program } = markerProgram();
    const probe = new ACPProbe(config(program), logger, dir);
    try {
      await probe.probe('background').catch(() => false);
    } finally {
      await probe.dispose();
    }
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true), {
      timeout: 10_000,
    });
  });
});

describe.skipIf(!posix)(
  'the OpenCode model listing under limits.engines',
  () => {
    test('with no engine allowed, it lists nothing and spawns nothing', async () => {
      installEngines({ allowed: [] });
      const { marker, program } = markerProgram();
      await expect(runOpenCodeModelListing(program, {})).resolves.toEqual({
        ok: false,
        reason: 'managed-policy',
      });
      expect(existsSync(marker)).toBe(false);
    });
  },
);
