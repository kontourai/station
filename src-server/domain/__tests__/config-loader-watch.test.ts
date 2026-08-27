/**
 * The one place in the config-loader suites that watches the filesystem for
 * real. Everything else models the watcher deterministically; this file is
 * deliberately the exception, because somebody has to check that the watch
 * *form* Station uses still works against the real library and the real OS.
 *
 * It is split accordingly. The structural guard needs no notification at all
 * and is asserted unconditionally. The delivery guard needs the host's
 * notification stream to be alive, which — per #970, where FSEvents delivered
 * zero directory events to any process for hours — is not something a test can
 * assume. See `armWatcher` for exactly how the two are told apart.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FSWatcher, watch } from 'chokidar';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isAgentOrIntegrationConfigPath,
  isWatchedConfigPath,
} from '../config-loader.js';

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'config-watch-spec-'));
  for (const dir of ['config', 'agents', 'integrations']) {
    mkdirSync(join(home, dir), { recursive: true });
  }
  return home;
}

describe('isWatchedConfigPath', () => {
  it('matches the three config shapes the loader cares about', () => {
    const root = '/home/project';

    expect(isWatchedConfigPath(root, '/home/project/config/app.json')).toBe(
      true,
    );
    expect(isWatchedConfigPath(root, '/home/project/config/mcp.json')).toBe(
      true,
    );
    expect(
      isWatchedConfigPath(root, '/home/project/agents/writer/agent.json'),
    ).toBe(true);
    expect(
      isWatchedConfigPath(
        root,
        '/home/project/integrations/slack/integration.json',
      ),
    ).toBe(true);
  });

  it('rejects paths the glob patterns never matched', () => {
    const root = '/home/project';

    // Wrong depth: globs used a single `*`, not `**`.
    expect(
      isWatchedConfigPath(root, '/home/project/agents/writer/sub/agent.json'),
    ).toBe(false);
    expect(
      isWatchedConfigPath(root, '/home/project/config/nested/app.json'),
    ).toBe(false);
    // Wrong filename.
    expect(
      isWatchedConfigPath(root, '/home/project/agents/writer/notes.json'),
    ).toBe(false);
    expect(
      isWatchedConfigPath(root, '/home/project/integrations/slack/agent.json'),
    ).toBe(false);
    // Wrong extension.
    expect(isWatchedConfigPath(root, '/home/project/config/app.yaml')).toBe(
      false,
    );
    // Directory itself, not a file in it.
    expect(isWatchedConfigPath(root, '/home/project/config')).toBe(false);
    // Outside the home entirely.
    expect(isWatchedConfigPath(root, '/etc/passwd')).toBe(false);
    expect(
      isWatchedConfigPath(root, '/home/project-other/config/app.json'),
    ).toBe(false);
  });
});

/**
 * One budget shared by every wait in the delivery test, so no step can starve a
 * later one and the total is provably inside the test timeout. An earlier shape
 * summed four independent bounds past its own test timeout, so a
 * slow-but-recoverable step was killed by vitest with an unattributable
 * "test timed out" instead of the assertion's own message.
 *
 * The budget is deliberately generous rather than tight. The documented worst
 * case is an 11.6s arming gap under load, and a budget that expires while the
 * stream is merely late would skip the delivery assertion on a host that could
 * have answered — trading a slow test for a quiet loss of coverage, which is
 * the worse bargain. Sized at roughly twice the measured worst case; on a
 * healthy host this test finishes in 2-3s and never approaches it.
 *
 * Measured while writing this: at a 15s budget, two runs in three skipped on a
 * loaded machine that then delivered in 2.3s on the third. That is the failure
 * mode this number exists to avoid.
 */
const WATCH_BUDGET_MS = 25_000;
const WATCH_TEST_TIMEOUT_MS = 40_000;

/**
 * Regression guard for the chokidar v4 glob removal: watching
 * `agents/&#42;/agent.json` resolves to watching *nothing* — `getWatched()` returns
 * `{}` and no event ever fires — which is indistinguishable from a quiet
 * system. The two halves of that are asserted separately below, because only
 * one of them is within the test's power to guarantee.
 *
 * One watcher serves both. Standing up a second watcher in this file doubled
 * the filesystem-notification load, and each close is a synchronous 0.5-17s
 * block of the JS thread (#956), for no extra coverage.
 */
describe('isAgentOrIntegrationConfigPath (station#983 scoped advance)', () => {
  it('matches an agent.json path', () => {
    const root = '/home/project';
    expect(
      isAgentOrIntegrationConfigPath(
        root,
        '/home/project/agents/writer/agent.json',
      ),
    ).toBe(true);
  });

  it('matches an integration.json path', () => {
    const root = '/home/project';
    expect(
      isAgentOrIntegrationConfigPath(
        root,
        '/home/project/integrations/slack/integration.json',
      ),
    ).toBe(true);
  });

  it('rejects config/*.json — app.json has its own dedicated launchability path, and other files (hosts.json, host-credentials.json) are unrelated to agent/integration reload', () => {
    const root = '/home/project';
    expect(
      isAgentOrIntegrationConfigPath(root, '/home/project/config/app.json'),
    ).toBe(false);
    expect(
      isAgentOrIntegrationConfigPath(root, '/home/project/config/hosts.json'),
    ).toBe(false);
  });

  it('rejects anything isWatchedConfigPath itself would reject', () => {
    const root = '/home/project';
    expect(
      isAgentOrIntegrationConfigPath(
        root,
        '/home/project/agents/writer/notes.json',
      ),
    ).toBe(false);
    expect(
      isAgentOrIntegrationConfigPath(
        root,
        '/home/project/agents/writer/sub/agent.json',
      ),
    ).toBe(false);
    expect(isAgentOrIntegrationConfigPath(root, '/etc/passwd')).toBe(false);
  });
});

describe('config watch roots', () => {
  let root: string;
  let agentDir: string;
  let watcher: FSWatcher;
  const seen: Array<[string, string]> = [];

  beforeAll(async () => {
    root = makeHome();
    // Created before the watcher starts, deliberately — see `armReal`.
    agentDir = join(root, 'agents', 'writer');
    mkdirSync(agentDir, { recursive: true });

    watcher = watch(
      [join(root, 'config'), join(root, 'agents'), join(root, 'integrations')],
      { persistent: true, ignoreInitial: true, depth: 1 },
    );
    watcher.on('add', (path) => seen.push(['add', path]));
    watcher.on('change', (path) => seen.push(['change', path]));
    await new Promise<void>((ready) => watcher.on('ready', () => ready()));
  }, 60_000);

  // Closing an FSEvents watcher and removing its tree is real work, and on a
  // loaded parallel run it does not reliably finish inside vitest's default
  // 10s hook budget. The timeout here is chosen rather than inherited.
  afterAll(async () => {
    await watcher?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  }, 60_000);

  // Half one of the glob guard, and the half that matters: it needs no
  // notification at all, so it holds on every host including a #970 one. A glob
  // watch resolves to an empty watched set; the directory form must resolve to
  // the three roots *and* recurse one level into `agents/writer`.
  it('resolves the directory watch form to real config directories', () => {
    expect(Object.keys(watcher.getWatched())).toEqual(
      expect.arrayContaining([
        join(root, 'config'),
        join(root, 'agents'),
        join(root, 'integrations'),
        agentDir,
      ]),
    );
  });

  // Half two: real notifications from the real library on the real OS. Nothing
  // is faked here, and nothing about it is conditional except whether the host
  // is capable of answering at all — see `armReal`.
  it(
    'delivers real events for top-level and nested config files',
    async (ctx) => {
      const deadline = Date.now() + WATCH_BUDGET_MS;
      const appConfig = join(root, 'config', 'app.json');
      const agentConfig = join(agentDir, 'agent.json');

      const delivered = await armReal({
        deadline,
        seen,
        arm: () => {
          writeFileSync(appConfig, '{}');
          writeFileSync(agentConfig, JSON.stringify({ version: 1 }));
        },
        armed: () =>
          seen.some(([, path]) => path === appConfig) &&
          seen.some(([, path]) => path === agentConfig),
        what: 'add events for the top-level and nested config files',
      });

      if (delivered === 'host-delivered-nothing') {
        // The watch form is already proven correct by the test above, so this
        // can only be the host's stream, not Station's use of it. Reporting it
        // as a Station regression would be false, and burning the budget on it
        // every run is what turned a dead FSEvents layer into a red suite.
        ctx.skip(
          `host delivered no filesystem events in ${WATCH_BUDGET_MS}ms; ` +
            'the watch form is verified structurally above (#970)',
        );
        return;
      }

      // A modification of an already-watched file must report as `change`
      // rather than a second `add`, since that is the distinction the loader's
      // forwarding and dedup logic is built on. No liveness escape from here
      // on: the host has demonstrably delivered, so silence is a real defect.
      await armReal({
        deadline,
        seen,
        arm: () => writeFileSync(agentConfig, JSON.stringify({ version: 2 })),
        armed: () =>
          seen.some(
            ([event, path]) => event === 'change' && path === agentConfig,
          ),
        what: 'a change event for the nested config file',
      });

      // Every delivered event survives the predicate the loader filters with.
      for (const [, path] of seen) {
        expect(isWatchedConfigPath(root, path)).toBe(true);
      }
    },
    WATCH_TEST_TIMEOUT_MS,
  );
});

/**
 * Repeats a filesystem mutation until the watcher reports it, the shared budget
 * runs out, or the host proves it is delivering nothing to anyone.
 *
 * On macOS every `fs.watch` handle in a process shares one libuv FSEvents
 * stream, and adding a handle tears that stream down and recreates it on a
 * CFRunLoop thread. chokidar's `ready` fires when its own initial directory
 * scan finishes — it does not wait for that stream to go live. Anything written
 * in the gap is not delayed, it is *lost*: an FSEvents stream reports from the
 * moment it starts, so no later notification ever mentions it. Measured on this
 * repo's own suite, the gap ran to 11.6s under load, and 6 of 30 single-write
 * probes were never reported at all within 25s.
 *
 * So the deterministic signal is not "wait longer", it is "keep making the
 * change until the watcher answers". Re-mutating regenerates a notification
 * that a live stream must deliver, and the failure mode this file guards — a
 * watch form that resolves to nothing, so *no* notification is ever produced —
 * still fails, because no number of repeats can produce an event from a
 * directory nobody is watching.
 *
 * # Telling a broken host from a broken watch form
 *
 * That last claim held right up until #970, where FSEvents delivered zero
 * directory events to *any* process on the machine for several hours — against
 * `fs.watch` recursive, `fs.watch` non-recursive, and the native `fsevents`
 * module alike — and then recovered with no code change. On such a host this
 * loop cannot succeed, and no amount of budget helps.
 *
 * The discriminator is `seen`, and it is exact rather than heuristic:
 *
 *   - **Nothing at all was delivered.** Combined with the structural test above,
 *     which has already proven the watch resolved to real directories, the only
 *     remaining explanation is the host's stream. Reported as
 *     `host-delivered-nothing` so the caller can skip rather than lie.
 *   - **Something was delivered, but not this.** The stream is demonstrably
 *     alive, so a missing event is a real defect in the watch form — a depth
 *     that does not recurse, a root that resolved to nothing, a filename the
 *     predicate rejects. Thrown, exactly as before.
 *
 * A partial regression therefore still fails hard, which is precisely the case
 * that a blanket "skip when slow" would have hidden.
 *
 * The one thing this cannot recover is a lost *directory-creation* notification:
 * chokidar caches directory listings, so if it never learns a subdirectory
 * exists it never watches it, and re-writing a file inside it produces nothing
 * (measured: 5 of 40 runs, 0 recovered by re-writing the file). That is why
 * `agents/writer` is created before the watcher starts rather than after
 * `ready`. The cost is stated plainly: this test no longer covers auto-discovery
 * of a directory created while the watcher is running. That behaviour is not
 * reliable on macOS, and the production watcher's answer to it — the bounded
 * post-`ready` reconciliation of #952 — is covered deterministically in
 * `config-loader-reconcile.test.ts` rather than by a test that fails 1 run in 8.
 */
async function armReal({
  deadline,
  seen,
  arm,
  armed,
  what,
}: {
  deadline: number;
  seen: ReadonlyArray<[string, string]>;
  arm: () => void;
  armed: () => boolean;
  what: string;
}): Promise<'delivered' | 'host-delivered-nothing'> {
  const started = Date.now();
  let attempts = 0;
  let nextAttempt = 0;
  while (Date.now() < deadline) {
    if (armed()) return 'delivered';
    if (Date.now() >= nextAttempt) {
      arm();
      attempts += 1;
      nextAttempt = Date.now() + 250;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (seen.length === 0) return 'host-delivered-nothing';
  throw new Error(
    `watcher never reported ${what} after ${attempts} attempts over ` +
      `${Date.now() - started}ms, though it did deliver ${seen.length} other ` +
      "event(s) — the host's notification stream is alive, so this is a " +
      `watch-form defect: ${JSON.stringify(seen)}`,
  );
}
