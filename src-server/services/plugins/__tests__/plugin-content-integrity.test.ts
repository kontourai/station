import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  computePluginContentDigest,
  findPluginContentLockCycleError,
  forgetPluginContentDigest,
  PLUGIN_TREE_COPY,
  PluginContentLockCycleError,
  pluginContentDigest,
  pluginContentLockCycleMessage,
  withPluginContentLock,
} from '../plugin-content-integrity.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function makePluginsDir(): string {
  const pluginsDir = mkdtempSync(join(tmpdir(), 'station-content-integrity-'));
  cleanup.push(pluginsDir);
  return pluginsDir;
}

function writePlugin(pluginsDir: string, name: string): string {
  const dir = join(pluginsDir, name);
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), '{"name":"demo"}');
  writeFileSync(join(dir, 'server.mjs'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'lib', 'helper.mjs'), 'export const b = 2;\n');
  return dir;
}

describe('computePluginContentDigest', () => {
  test('is deterministic and changes when ANY file in the tree changes — including a nested non-manifest file', () => {
    const pluginsDir = makePluginsDir();
    const dir = writePlugin(pluginsDir, 'demo');
    const original = computePluginContentDigest(pluginsDir, 'demo');
    expect(original).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(computePluginContentDigest(pluginsDir, 'demo')).toBe(original);
    // The review-HIGH-1 case: a file the manifest projection never covered.
    writeFileSync(join(dir, 'lib', 'helper.mjs'), 'export const b = 666;\n');
    expect(computePluginContentDigest(pluginsDir, 'demo')).not.toBe(original);
  });

  test('content cannot shift between files undetected (NUL-separated path/kind/content framing)', () => {
    const pluginsDir = makePluginsDir();
    const dirA = join(pluginsDir, 'a');
    mkdirSync(dirA, { recursive: true });
    writeFileSync(join(dirA, 'x'), 'onetwo');
    writeFileSync(join(dirA, 'y'), '');
    const digestA = computePluginContentDigest(pluginsDir, 'a');
    const dirB = join(pluginsDir, 'b');
    mkdirSync(dirB, { recursive: true });
    writeFileSync(join(dirB, 'x'), 'one');
    writeFileSync(join(dirB, 'y'), 'two');
    expect(computePluginContentDigest(pluginsDir, 'b')).not.toBe(digestA);
  });

  test('excludes the plugin-root .git (VCS metadata git pull legitimately touches) but digests a nested .git-named path', () => {
    const pluginsDir = makePluginsDir();
    const dir = writePlugin(pluginsDir, 'demo');
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const withGit = computePluginContentDigest(pluginsDir, 'demo');
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/other\n');
    expect(computePluginContentDigest(pluginsDir, 'demo')).toBe(withGit);
    // Nothing stops a manifest pointing serverModule into a nested `.git`
    // directory, so deeper .git-named paths ARE part of the digest.
    mkdirSync(join(dir, 'lib', '.git'), { recursive: true });
    writeFileSync(join(dir, 'lib', '.git', 'evil.mjs'), 'export const e = 1;');
    const withNested = computePluginContentDigest(pluginsDir, 'demo');
    expect(withNested).not.toBe(withGit);
    writeFileSync(join(dir, 'lib', '.git', 'evil.mjs'), 'export const e = 2;');
    expect(computePluginContentDigest(pluginsDir, 'demo')).not.toBe(withNested);
  });

  test('digests a symlink as its target STRING without following it', () => {
    const pluginsDir = makePluginsDir();
    const dir = writePlugin(pluginsDir, 'demo');
    symlinkSync('/outside/target-a', join(dir, 'link'));
    const linkA = computePluginContentDigest(pluginsDir, 'demo');
    expect(linkA).toMatch(/^sha256:/);
    // An identical tree whose link points elsewhere digests differently,
    // even though no file content inside either tree differs.
    const dir2 = join(pluginsDir, 'demo2');
    mkdirSync(join(dir2, 'lib'), { recursive: true });
    writeFileSync(join(dir2, 'plugin.json'), '{"name":"demo"}');
    writeFileSync(join(dir2, 'server.mjs'), 'export const a = 1;\n');
    writeFileSync(join(dir2, 'lib', 'helper.mjs'), 'export const b = 2;\n');
    symlinkSync('/outside/target-b', join(dir2, 'link'));
    expect(computePluginContentDigest(pluginsDir, 'demo2')).not.toBe(linkA);
  });

  test('returns null for an absent tree — an underivable target must refuse, never grant on a partial digest', () => {
    const pluginsDir = makePluginsDir();
    expect(computePluginContentDigest(pluginsDir, 'ghost')).toBeNull();
  });
});

describe('withPluginContentLock', () => {
  test('serializes critical sections per plugin (FIFO) while distinct plugins run concurrently', async () => {
    const events: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withPluginContentLock('/plugins', 'demo', async () => {
      events.push('first-enter');
      await firstGate;
      events.push('first-exit');
    });
    const second = withPluginContentLock('/plugins', 'demo', async () => {
      events.push('second-enter');
    });
    // A DIFFERENT plugin's lock is independent: it runs while demo is held.
    await withPluginContentLock('/plugins', 'other', async () => {
      events.push('other-ran');
    });
    expect(events).toEqual(['first-enter', 'other-ran']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual([
      'first-enter',
      'other-ran',
      'first-exit',
      'second-enter',
    ]);
  });

  test('releases the lock when the held section throws', async () => {
    await expect(
      withPluginContentLock('/plugins', 'demo', async () => {
        throw new Error('mutation failed');
      }),
    ).rejects.toThrow('mutation failed');
    let ran = false;
    await withPluginContentLock('/plugins', 'demo', async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});

describe('PLUGIN_TREE_COPY (station#4288, review MEDIUM 2)', () => {
  /**
   * A backup and a restore have to be the SAME tree, and "same" here means
   * same digest — the rollback's whole purpose is that a failed update leaves
   * the plugin exactly as it was, permissions included.
   *
   * `cpSync` defaults to `verbatimSymlinks: false`, which resolves a relative
   * link and writes an ABSOLUTE target into the copy. `node_modules/.bin/*`
   * shims are relative links and `ensurePluginDeps` creates them, so this is
   * what an ordinary plugin with dependencies looks like.
   */
  function seedTreeWithRelativeSymlink(pluginsDir: string, name: string) {
    const dir = join(pluginsDir, name);
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'tool'), { recursive: true });
    writeFileSync(join(dir, 'plugin.json'), `{"name":"${name}"}`);
    writeFileSync(
      join(dir, 'node_modules', 'tool', 'cli.js'),
      '#!/usr/bin/env node\n',
    );
    symlinkSync('../tool/cli.js', join(dir, 'node_modules', '.bin', 'tool'));
    return dir;
  }

  test('a backup/restore round trip preserves the digest, so a failed update cannot strip a plugin', () => {
    const pluginsDir = makePluginsDir();
    const dir = seedTreeWithRelativeSymlink(pluginsDir, 'symlinked');
    const backup = join(makePluginsDir(), 'backup');
    const before = computePluginContentDigest(pluginsDir, 'symlinked');

    cpSync(dir, backup, PLUGIN_TREE_COPY);
    rmSync(dir, { recursive: true, force: true });
    cpSync(backup, dir, PLUGIN_TREE_COPY);

    expect(computePluginContentDigest(pluginsDir, 'symlinked')).toBe(before);
  });

  test('the fixture has power: the same round trip WITHOUT verbatimSymlinks changes the digest', () => {
    const pluginsDir = makePluginsDir();
    const dir = seedTreeWithRelativeSymlink(pluginsDir, 'symlinked');
    const backup = join(makePluginsDir(), 'backup');
    const before = computePluginContentDigest(pluginsDir, 'symlinked');

    // Exactly what the code did before this fix.
    cpSync(dir, backup, { recursive: true });
    rmSync(dir, { recursive: true, force: true });
    cpSync(backup, dir, { recursive: true });

    expect(computePluginContentDigest(pluginsDir, 'symlinked')).not.toBe(
      before,
    );
  });
});

describe('withPluginContentLock re-entrancy (station#4288, review HIGH 3)', () => {
  /**
   * Installing plugin A takes A's lock and then installs A's dependencies,
   * and a dependency that is already installed is REBUILT in place under its
   * own lock. A manifest naming itself as a dependency — or a cycle that
   * comes back round to A — asks for the same key twice from one async
   * context, which a plain FIFO mutex can never satisfy.
   */
  test('a nested acquire of a key the same async context holds runs inline instead of deadlocking', async () => {
    const order: string[] = [];
    const result = await Promise.race([
      withPluginContentLock('/plugins', 'self-dep', async () => {
        order.push('outer');
        await withPluginContentLock('/plugins', 'self-dep', async () => {
          order.push('inner');
        });
        order.push('outer-done');
        return 'completed';
      }),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve('DEADLOCKED'), 1000),
      ),
    ]);

    expect(result).toBe('completed');
    expect(order).toEqual(['outer', 'inner', 'outer-done']);
  });

  test('a DIFFERENT key nested inside a held lock still serializes against its own queue', async () => {
    const order: string[] = [];
    let releaseB: () => void = () => {};
    const bHeld = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    // Somebody else is holding B.
    const holder = withPluginContentLock('/plugins', 'b', async () => {
      order.push('holder-enter');
      await bHeld;
      order.push('holder-exit');
    });
    const nested = withPluginContentLock('/plugins', 'a', async () => {
      order.push('a-enter');
      await withPluginContentLock('/plugins', 'b', async () => {
        order.push('b-nested');
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['holder-enter', 'a-enter']);
    releaseB();
    await Promise.all([holder, nested]);
    expect(order).toEqual([
      'holder-enter',
      'a-enter',
      'holder-exit',
      'b-nested',
    ]);
  });

  test('the OUTER release forgets the memo once, covering the whole nested span', async () => {
    const pluginsDir = makePluginsDir();
    const dir = writePlugin(pluginsDir, 'demo');
    const before = pluginContentDigest(pluginsDir, 'demo');

    await withPluginContentLock(pluginsDir, 'demo', async () => {
      await withPluginContentLock(pluginsDir, 'demo', async () => {
        writeFileSync(join(dir, 'server.mjs'), 'export const a = 99;\n');
      });
      // Still inside the outer span: the memo has not been dropped yet.
      expect(pluginContentDigest(pluginsDir, 'demo')).toBe(before);
    });

    expect(pluginContentDigest(pluginsDir, 'demo')).not.toBe(before);
  });
});

describe('withPluginContentLock deadlock safety (station#4288, delta review MEDIUM 3)', () => {
  /**
   * `buildDependencyIfNeeded` takes a DEPENDENCY's lock from inside the
   * installing plugin's own lock, so one context can hold two keys. Two
   * concurrent installs of mutually dependent plugins (P depends on Q, Q
   * depends on P) then take them in opposite orders and wait on each other.
   * Re-entrancy cannot help: these are sibling contexts, not nested ones. The
   * mutex has no timeout, so before this both keys stayed held for the life
   * of the process and every later consent decision, update and uninstall
   * for either plugin hung behind them.
   */
  test('an AB-BA acquire from two concurrent contexts throws instead of hanging forever', async () => {
    let bothHold!: () => void;
    const gate = new Promise<void>((resolve) => {
      let seen = 0;
      bothHold = () => {
        seen += 1;
        if (seen === 2) resolve();
      };
    });

    const installP = withPluginContentLock('/plugins', 'p', async () => {
      bothHold();
      await gate;
      // P's dependency loop reaches Q, which Q's own install is holding.
      await withPluginContentLock('/plugins', 'q', async () => undefined);
      return 'p-done';
    });
    const installQ = withPluginContentLock('/plugins', 'q', async () => {
      bothHold();
      await gate;
      await withPluginContentLock('/plugins', 'p', async () => undefined);
      return 'q-done';
    });

    const settled = await Promise.race([
      Promise.allSettled([installP, installQ]),
      new Promise<'DEADLOCKED'>((resolve) =>
        setTimeout(() => resolve('DEADLOCKED'), 2000),
      ),
    ]);
    expect(settled).not.toBe('DEADLOCKED');
    const outcomes = settled as PromiseSettledResult<string>[];
    // One of the two loses the race and is refused; the other completes.
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      PluginContentLockCycleError,
    );
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
  });

  /**
   * The keys stay usable afterwards: a refusal that leaked a queue slot or a
   * wait-for edge would convert an immediate failure into the same permanent
   * hang, one operation later.
   */
  test('both plugin keys are still acquirable after a refused cycle', async () => {
    let bothHold!: () => void;
    const gate = new Promise<void>((resolve) => {
      let seen = 0;
      bothHold = () => {
        seen += 1;
        if (seen === 2) resolve();
      };
    });
    await Promise.allSettled([
      withPluginContentLock('/plugins', 'm', async () => {
        bothHold();
        await gate;
        await withPluginContentLock('/plugins', 'n', async () => undefined);
      }),
      withPluginContentLock('/plugins', 'n', async () => {
        bothHold();
        await gate;
        await withPluginContentLock('/plugins', 'm', async () => undefined);
      }),
    ]);

    const order: string[] = [];
    const reused = await Promise.race([
      (async () => {
        await withPluginContentLock('/plugins', 'm', async () => {
          order.push('m');
        });
        await withPluginContentLock('/plugins', 'n', async () => {
          order.push('n');
        });
        return 'reacquired';
      })(),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve('STILL HELD'), 2000),
      ),
    ]);
    expect(reused).toBe('reacquired');
    expect(order).toEqual(['m', 'n']);
  });
});

describe('the re-entrancy key is cleared on release (station#4288, delta review LOW 1)', () => {
  /**
   * `heldLockKeys` was populated at acquire and never cleared, so the
   * predicate meant "my async ancestry ONCE held this key" rather than "holds
   * it now". A task created inside the span but still running after the
   * release then took the re-entrant branch and ran with no lock at all —
   * mutating a plugin tree while a concurrent consent decision held the very
   * lock it thought it was inside.
   */
  test('a task created inside the span but running after the release waits for the lock again', async () => {
    const order: string[] = [];
    let startDetached!: () => void;
    const startGate = new Promise<void>((resolve) => {
      startDetached = resolve;
    });
    let detached!: Promise<void>;

    await withPluginContentLock('/plugins', 'late', async () => {
      order.push('span-enter');
      // Started INSIDE the span, so its continuation resumes in this async
      // context and reads this span's held-key set — but it does not reach
      // its own acquire until long after the span released. A lexical
      // closure called from outside would not model this: AsyncLocalStorage
      // follows the execution context, not the scope chain.
      detached = (async () => {
        await startGate;
        await withPluginContentLock('/plugins', 'late', async () => {
          order.push('detached-body');
        });
      })();
      order.push('span-exit');
    });

    // Somebody else now holds the key. If the detached task still believed it
    // held the lock, it would take the re-entrant branch and run right
    // through this — mutating the tree with no lock at all.
    let releaseContender!: () => void;
    const contenderGate = new Promise<void>((resolve) => {
      releaseContender = resolve;
    });
    const contender = withPluginContentLock('/plugins', 'late', async () => {
      order.push('contender-enter');
      await contenderGate;
      order.push('contender-exit');
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    startDetached();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['span-enter', 'span-exit', 'contender-enter']);

    releaseContender();
    await contender;
    await detached;
    expect(order).toEqual([
      'span-enter',
      'span-exit',
      'contender-enter',
      'contender-exit',
      'detached-body',
    ]);
  });
});

describe('the memo staleness boundary is real (station#4288, review HIGH 3)', () => {
  /**
   * Every other `changed` test in this repo mutates through
   * {@link withPluginContentLock}, whose release forgets the memo — so none
   * of them covers a mutation that SKIPS the lock, which is the case the
   * memo's docblock makes a promise about. This pins that promise in both
   * directions: an out-of-band write is NOT seen in-process, and IS seen
   * after a restart.
   *
   * It is a boundary, not a defect to be silently tolerated: it is why the
   * two Station-mediated mutators found outside the lock (the install path
   * and the already-installed dependency rebuild) had to be moved inside it
   * rather than left to be noticed at the next restart.
   */
  test('an out-of-band writeFileSync keeps serving the memoized digest, and is detected on the next restart', () => {
    const pluginsDir = makePluginsDir();
    const dir = writePlugin(pluginsDir, 'demo');
    const before = pluginContentDigest(pluginsDir, 'demo');
    expect(before).toBe(computePluginContentDigest(pluginsDir, 'demo'));

    // No lock, no Station involvement: an operator running `git pull` inside
    // `<home>/plugins/demo`, or another process writing there.
    writeFileSync(join(dir, 'server.mjs'), 'export const a = 1234;\n');

    // The unmemoized truth has moved...
    const truth = computePluginContentDigest(pluginsDir, 'demo');
    expect(truth).not.toBe(before);
    // ...and the memo has not, which is exactly what the docblock says.
    expect(pluginContentDigest(pluginsDir, 'demo')).toBe(before);

    // A server restart (or any Station-mediated mutation) closes it.
    forgetPluginContentDigest(pluginsDir, 'demo');
    expect(pluginContentDigest(pluginsDir, 'demo')).toBe(truth);
  });
});

/**
 * Both of these are regressions the second fix round introduced and a delta
 * review caught. They share one cause: that round shared a single mutable
 * held-key Set across a span's descendants, so that a release could be seen by
 * a task still running. Copying the map per acquire and comparing a holder
 * token is what closes them together.
 */
describe('withPluginContentLock bookkeeping (station#4288, delta review)', () => {
  test('a task that outlives its span does not leak a wait-for edge', async () => {
    const dir = '/probe';
    let freeX!: () => void;
    const xHeld = new Promise<void>((resolve) => {
      freeX = resolve;
    });

    // Someone else holds X for a while.
    const xHolder = withPluginContentLock(dir, 'X', async () => {
      await xHeld;
    });

    // A span holds L and starts a task that wants X, then exits without
    // awaiting it. The task inserts the edge L -> X while parked.
    let detached!: Promise<void>;
    await withPluginContentLock(dir, 'L', async () => {
      detached = withPluginContentLock(dir, 'X', async () => {});
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    freeX();
    await xHolder;
    await detached;

    // Nothing is concurrent now. A plain X-then-L acquire must simply run: a
    // surviving L -> X edge would read as a cycle and refuse it, for the life
    // of the process, with a message claiming two operations hold each other's
    // locks when nothing holds anything.
    await expect(
      withPluginContentLock(dir, 'X', async () =>
        withPluginContentLock(dir, 'L', async () => 'ran'),
      ),
    ).resolves.toBe('ran');
  });

  test('two concurrent acquires of one key inside a span still serialize', async () => {
    const dir = '/probe';
    const order: string[] = [];
    await withPluginContentLock(dir, 'outer', async () => {
      const first = withPluginContentLock(dir, 'inner', async () => {
        order.push('first-enter');
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push('first-exit');
      });
      // Let the first sibling actually TAKE the lock before the second asks.
      // Without this the second's synchronous prefix runs before the first
      // resumes from `await previous`, so it queues normally and the test
      // passes whether or not siblings are isolated -- which is exactly what
      // it is here to detect.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = withPluginContentLock(dir, 'inner', async () => {
        order.push('second-enter');
      });
      await Promise.all([first, second]);
    });

    // Siblings are not each other's re-entrancy. If they were, `second-enter`
    // would land between the first pair and two bodies would be mutating one
    // tree with the mutex believing it was held once.
    expect(order).toEqual(['first-enter', 'first-exit', 'second-enter']);
  });
});

/**
 * station#4309 follow-up, defect 1. The refusal has to be RECOGNISABLE after
 * every layer above it has rewrapped it, and it has to name plugins rather
 * than lock keys — a route re-deriving names from the key format is the
 * second reader of an encoding it does not own.
 */
describe('recognising a refused content lock after it has been rewrapped', () => {
  const cycle = new PluginContentLockCycleError([
    '/home/plugins/app',
    '/home/plugins/shared-lib',
    '/home/plugins/app',
  ]);

  test('the distinct plugin names are derived from the lock keys', () => {
    expect(cycle.plugins).toEqual(['app', 'shared-lib']);
    expect(cycle.cycle).toHaveLength(3);
  });

  test('the operator message names every plugin in the cycle', () => {
    const message = pluginContentLockCycleMessage(cycle);
    expect(message).toContain('app');
    expect(message).toContain('shared-lib');
    expect(message).toContain('refused');
  });

  test('it is found through a cause chain and through an AggregateError', () => {
    const wrapped = new Error('dependency failed', { cause: cycle });
    expect(findPluginContentLockCycleError(wrapped)).toBe(cycle);
    expect(
      findPluginContentLockCycleError(
        new AggregateError(
          [new Error('rollback failed'), wrapped],
          'Plugin install and rollback both failed.',
        ),
      ),
    ).toBe(cycle);
  });

  test('the install failure is answered, not the rollback failure beside it', () => {
    // `AggregateError([error, rollbackError])` is how the install reports "the
    // install failed AND undoing it failed" — primary first, by construction.
    // A depth-first walk pops the LAST entry, so it answers for the rollback
    // and a request gets a status code derived from the wrong failure
    // (station#4309 follow-up review, LOW).
    const primary = new PluginContentLockCycleError([
      '/home/plugins/app',
      '/home/plugins/shared-lib',
      '/home/plugins/app',
    ]);
    const duringRollback = new PluginContentLockCycleError([
      '/home/plugins/other',
      '/home/plugins/third',
      '/home/plugins/other',
    ]);
    const aggregate = new AggregateError(
      [
        new Error('dependency failed', { cause: primary }),
        new Error('rollback failed', { cause: duringRollback }),
      ],
      'Plugin install and rollback both failed.',
    );

    expect(findPluginContentLockCycleError(aggregate)).toBe(primary);
  });

  test('a shallow match wins over a deeper one', () => {
    const shallow = new PluginContentLockCycleError([
      '/home/plugins/a',
      '/home/plugins/b',
      '/home/plugins/a',
    ]);
    const deep = new PluginContentLockCycleError([
      '/home/plugins/c',
      '/home/plugins/d',
      '/home/plugins/c',
    ]);
    // Order matters for the power of this test: with `shallow` LAST, a
    // depth-first walker pops it first and returns it, so the assertion holds
    // under both orders and proves nothing. Putting the deep branch first
    // means only a breadth-first walker reaches `shallow` before `deep`.
    const aggregate = new AggregateError([
      shallow,
      new Error('outer', { cause: new Error('inner', { cause: deep }) }),
    ]);

    expect(findPluginContentLockCycleError(aggregate)).toBe(shallow);
  });

  test('three plugins in a cycle are not described as a pair', () => {
    const message = pluginContentLockCycleMessage(
      new PluginContentLockCycleError([
        '/home/plugins/a',
        '/home/plugins/b',
        '/home/plugins/c',
        '/home/plugins/a',
      ]),
    );
    expect(message).toContain('a, b and c');
    expect(message).not.toContain('the other');
    expect(message).toContain('another holds');
  });

  test('the message makes no claim about what the request changed', () => {
    expect(pluginContentLockCycleMessage(cycle)).not.toMatch(
      /nothing was changed/i,
    );
  });

  test('an unrelated failure is not reported as a refused lock, and a self-referential chain terminates', () => {
    expect(findPluginContentLockCycleError(new Error('disk full'))).toBeNull();
    expect(findPluginContentLockCycleError(undefined)).toBeNull();
    const looping = new Error('loop');
    (looping as { cause?: unknown }).cause = looping;
    expect(findPluginContentLockCycleError(looping)).toBeNull();
  });
});
