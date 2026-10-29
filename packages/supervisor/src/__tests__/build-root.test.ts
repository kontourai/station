/**
 * A handoff may only run a .js/.mjs entry inside the supervisor's build root.
 * A token holder must not be able to start an arbitrary program as the
 * Station server, and a refused request must start no process at all.
 */
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.ts';
import { getBoot, startSupervisor, writeCoreVariant } from './harness.ts';

const makeTempDir = trackTempDirs();

function layout() {
  const base = makeTempDir('sup-root-');
  const root = join(base, 'build');
  const sibling = join(base, 'build2'); // shares the root's string prefix
  const outside = join(base, 'outside');
  for (const dir of [root, sibling, outside, join(root, 'next')])
    mkdirSync(dir);
  const core = writeCoreVariant(root, 'core', {});
  const evil = writeCoreVariant(outside, 'evil', {});
  return { base, root, sibling, outside, core, evil };
}

describe('handoff entry boundary (real processes)', () => {
  it('refuses entries outside the build root without starting a process', async () => {
    const { root, sibling, core, evil } = layout();
    const siblingEntry = writeCoreVariant(sibling, 'core', {});
    // A non-JS file with valid module content, inside the root.
    writeFileSync(join(root, 'core.txt'), 'process.exit(0);\n');
    const refusals: Array<[string, string]> = [
      ['relative ../ traversal', `..${sep}outside${sep}evil.mjs`],
      [
        'absolute path with ../ traversal',
        `${root}${sep}..${sep}outside${sep}evil.mjs`,
      ],
      ['absolute path outside the root', evil],
      ['sibling directory sharing the prefix', siblingEntry],
      ['non-JS file inside the root', join(root, 'core.txt')],
      ['missing file inside the root', join(root, 'missing.mjs')],
      ['the build root itself', root],
    ];
    if (process.platform !== 'win32') {
      symlinkSync(evil, join(root, 'link.mjs'));
      refusals.push([
        'symlink inside the root pointing outside',
        join(root, 'link.mjs'),
      ]);
    }

    const supervisor = await startSupervisor({
      home: makeTempDir('sup-root-home-'),
      entry: core,
    });
    const before = await supervisor.status();
    expect(before.active?.generation).toBe(1);

    // Every case is tried and recorded, so a failure names all the cases it lets through.
    const outcomes: Array<Record<string, unknown>> = [];
    for (const [name, entry] of refusals) {
      const result = await supervisor.handoff({ entry });
      const status = await supervisor.status();
      outcomes.push({
        name,
        outcome: result.outcome,
        reason: result.reason,
        state: status.state,
        trial: status.trial,
        activeGeneration: status.active?.generation,
        activePid: status.active?.pid,
      });
    }
    expect(outcomes).toEqual(
      refusals.map(([name]) => ({
        name,
        outcome: 'refused',
        reason: 'entry-outside-build-root',
        state: 'serving',
        trial: null,
        activeGeneration: 1,
        activePid: before.active?.pid,
      })),
    );
    expect((await supervisor.status()).active?.bootId).toBe(
      before.active?.bootId,
    );
    // No generation was ever forked for a refusal.
    expect(supervisor.output().match(/generation \d+ started/g)).toHaveLength(
      1,
    );

    // Inside the root, absolute and relative entries are accepted. Generation
    // ids are consumed per launch, so 2 and 3 prove the refusals launched nothing.
    const next = realpathSync(writeCoreVariant(join(root, 'next'), 'core', {}));
    expect(await supervisor.handoff({ entry: next })).toMatchObject({
      outcome: 'committed',
      generation: 2,
    });
    expect((await supervisor.status()).active?.entry).toBe(next);
    expect((await getBoot(supervisor.port)).entry).toBe(next);
    expect(await supervisor.handoff({ entry: 'core.mjs' })).toMatchObject({
      outcome: 'committed',
      generation: 3,
    });
    expect((await supervisor.status()).active?.entry).toBe(realpathSync(core));
  }, 90_000);

  it('refuses to start when --entry is outside --build-root', async () => {
    const { root, evil } = layout();
    const supervisor = await startSupervisor({
      home: makeTempDir('sup-root-home-'),
      entry: evil,
      args: ['--build-root', root],
      waitForServing: false,
    });
    expect(await supervisor.exited).toEqual({ code: 2, signal: null });
    expect(supervisor.output()).toContain(
      '--entry must be a .js or .mjs file inside --build-root',
    );
    expect(supervisor.output()).not.toMatch(/generation \d+ started/);
  }, 60_000);
});
