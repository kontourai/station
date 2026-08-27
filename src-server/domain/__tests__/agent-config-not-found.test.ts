import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  isAgentConfigNotFound,
  loadAgentConfig,
} from '../config-loader-agents.js';

/**
 * station#3549 review round 3 follow-up.
 *
 * `isAgentConfigNotFound` now carries the entire distinction between "this
 * agent has no spec" (ordinary — every registry default is like this) and
 * "this agent's spec could not be read" (fail closed — we cannot tell whether
 * a credential pin exists). Two regressions came from those being
 * indistinguishable, so the predicate being *reachable from the real loader*
 * is load-bearing.
 *
 * These run against a REAL directory rather than a mocked loader: a unit test
 * that constructs the error itself would prove the predicate matches something
 * this file already knows how to build, not that the production loader emits
 * it. That gap — a fixture agreeing with itself — is exactly what let the
 * earlier fail-closed branch look correct while being unreachable.
 */
describe('the real loader distinguishes absence from unreadability', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agent-config-notfound-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('a missing agent throws an error the predicate recognizes', async () => {
    await expect(loadAgentConfig(home, 'station')).rejects.toSatisfy(
      isAgentConfigNotFound,
    );
  });

  test('a missing agents/ directory entirely is still absence, not a fault', async () => {
    rmSync(home, { recursive: true, force: true });
    await expect(loadAgentConfig(home, 'claude')).rejects.toSatisfy(
      isAgentConfigNotFound,
    );
  });

  // The other half: a spec that EXISTS but cannot be read must NOT read as
  // absence, or the fail-closed branch is unreachable again.
  test('unparseable JSON is NOT absence', async () => {
    mkdirSync(join(home, 'agents', 'broken'), { recursive: true });
    writeFileSync(join(home, 'agents', 'broken', 'agent.json'), '{ not json');
    await expect(loadAgentConfig(home, 'broken')).rejects.not.toSatisfy(
      isAgentConfigNotFound,
    );
  });

  // Review round 4 (Codex), HIGH: `existsSync` returns false for EACCES as
  // well as ENOENT, so a spec that EXISTS under an unreadable directory was
  // manufactured as absence — the branch meaning "no pin is possible,
  // proceed" — and a pinned agent ran on the connection's account.
  test('a spec under an unreadable directory is NOT absence', async () => {
    const dir = join(home, 'agents', 'locked');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'agent.json'),
      JSON.stringify({ name: 'Locked', prompt: '' }),
    );
    chmodSync(dir, 0o000);
    try {
      await expect(loadAgentConfig(home, 'locked')).rejects.not.toSatisfy(
        isAgentConfigNotFound,
      );
    } finally {
      // Restore so afterEach can remove the tree.
      chmodSync(dir, 0o755);
    }
  });

  test('a schema-invalid spec is NOT absence', async () => {
    mkdirSync(join(home, 'agents', 'invalid'), { recursive: true });
    writeFileSync(
      join(home, 'agents', 'invalid', 'agent.json'),
      JSON.stringify({ execution: { agentConnectionId: 'claude' } }),
    );
    await expect(loadAgentConfig(home, 'invalid')).rejects.not.toSatisfy(
      isAgentConfigNotFound,
    );
  });
});
