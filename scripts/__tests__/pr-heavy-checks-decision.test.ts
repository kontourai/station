import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSON_SCHEMA, load } from 'js-yaml';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { EXPECTED_LABEL_NAMES } from '../label-manifest.mjs';
import {
  decideHeavyChecks,
  HEAD_STATUS_PERMISSION,
  HEAVY_CHECKS_OPT_IN_LABEL,
  main,
} from '../pr-heavy-checks-decision.mjs';

const REPOSITORY = 'kontourai/station';
const HEAD = 'a'.repeat(40);

/** The pull request object as a pull_request_target webhook carries it. */
function pullRequest(
  overrides: {
    autoMerge?: boolean;
    labels?: readonly string[];
    draft?: boolean;
    fork?: boolean;
  } = {},
) {
  return {
    number: 4242,
    state: 'open',
    draft: overrides.draft ?? false,
    head: {
      sha: HEAD,
      ref: 'feature',
      repo: {
        id: overrides.fork ? 2 : 1,
        full_name: overrides.fork ? 'someone/station' : REPOSITORY,
      },
    },
    base: {
      sha: 'b'.repeat(40),
      ref: 'main',
      repo: { id: 1, full_name: REPOSITORY },
    },
    labels: (overrides.labels ?? []).map((name, id) => ({
      id,
      name,
      color: 'ededed',
    })),
    auto_merge: overrides.autoMerge
      ? {
          enabled_by: { login: 'author', type: 'User' },
          merge_method: 'squash',
          commit_title: 'feat: x',
          commit_message: '',
        }
      : null,
  };
}

const decide = (
  input: Partial<Parameters<typeof decideHeavyChecks>[0]> & {
    pr?: ReturnType<typeof pullRequest>;
  },
) =>
  decideHeavyChecks({
    mode: 'when-armed',
    eventName: 'pull_request_target',
    action: 'synchronize',
    runAttempt: '1',
    repository: REPOSITORY,
    live: null,
    pullRequest: input.pr ?? pullRequest(),
    ...input,
  });

describe('heavy pull-request check decision', () => {
  test.each([undefined, '', 'every-push'])(
    'switch %j keeps every push heavy, for every event',
    (mode) => {
      for (const [eventName, action] of [
        ['pull_request_target', 'synchronize'],
        ['pull_request_target', 'opened'],
        ['pull_request_target', 'auto_merge_enabled'],
        ['merge_group', undefined],
        ['push', undefined],
      ])
        expect(decide({ mode, eventName, action }).heavy).toBe(true);
    },
  );

  test('the opt-in label is a managed repository label', () => {
    expect(EXPECTED_LABEL_NAMES).toContain(HEAVY_CHECKS_OPT_IN_LABEL);
    expect(HEAVY_CHECKS_OPT_IN_LABEL).toBe('full-checks');
  });

  test('an unknown switch value fails towards heavy and says so', () => {
    const decision = decide({ mode: 'sometimes' });
    expect(decision).toMatchObject({ heavy: true });
    expect(decision.reason).toContain('unknown value');
  });

  test.each([
    // An unarmed push, open, reopen or base retarget: cheap only.
    ['synchronize', {}, false],
    ['opened', {}, false],
    ['reopened', {}, false],
    ['edited', {}, false],
    // A draft cannot be armed; it stays cheap until armed after ready.
    ['synchronize', { draft: true }, false],
    // Arming (by a person or the automation App, same event).
    ['auto_merge_enabled', {}, true],
    ['auto_merge_enabled', { autoMerge: true }, true],
    // A push to an already armed pull request.
    ['synchronize', { autoMerge: true }, true],
    // The opt-in label before arming.
    ['synchronize', { labels: ['bug', HEAVY_CHECKS_OPT_IN_LABEL] }, true],
    ['synchronize', { labels: ['bug'] }, false],
    // Forks keep their own isolated smoke; never split.
    ['synchronize', { fork: true }, true],
  ] as const)('when-armed: %s %j -> heavy %s', (action, shape, expected) => {
    expect(decide({ action, pr: pullRequest(shape) }).heavy).toBe(expected);
  });

  test('a re-arm of a head the source policy already verified skips the heavy part', () => {
    const armedPr = pullRequest({ autoMerge: true });
    expect(
      decide({ action: 'auto_merge_enabled', pr: armedPr, headVerified: true }),
    ).toMatchObject({ heavy: false });
    for (const headVerified of [false, undefined])
      expect(
        decide({ action: 'auto_merge_enabled', pr: armedPr, headVerified })
          .heavy,
      ).toBe(true);
    // Only arming consults it: a push to an armed, verified head is a new
    // head, so it is never verified already.
    expect(
      decide({ action: 'synchronize', pr: armedPr, headVerified: true }).heavy,
    ).toBe(true);
  });

  test('merge groups and other events are always heavy under when-armed', () => {
    for (const eventName of ['merge_group', 'push', 'workflow_dispatch'])
      expect(decide({ eventName }).heavy).toBe(true);
  });

  test('a re-run reads the live auto-merge state, since its payload is the original event', () => {
    // Pushed unarmed, armed later, then the cheap run is re-run.
    expect(
      decide({
        runAttempt: '2',
        live: pullRequest({ autoMerge: true }),
      }).heavy,
    ).toBe(true);
    expect(decide({ runAttempt: '2', live: pullRequest() }).heavy).toBe(false);
    // Unreadable live state on a re-run fails towards heavy.
    expect(decide({ runAttempt: '2', live: null }).heavy).toBe(true);
  });

  test('a first attempt does not let a live arm turn a push run heavy (the arming run owns it)', () => {
    // 149 of 155 arms land while the push run is still starting: both runs
    // would otherwise spend the heavy checks on the same head.
    expect(decide({ live: pullRequest({ autoMerge: true }) }).heavy).toBe(
      false,
    );
  });

  test('the opt-in label added after the push is read live', () => {
    expect(
      decide({
        runAttempt: '2',
        live: pullRequest({ labels: [HEAVY_CHECKS_OPT_IN_LABEL] }),
      }).heavy,
    ).toBe(true);
  });

  test.each([
    [
      'no auto_merge key',
      () => {
        const pr: Record<string, unknown> = pullRequest();
        delete pr.auto_merge;
        return pr;
      },
    ],
    ['no number', () => ({ ...pullRequest(), number: undefined })],
    ['labels not a list', () => ({ ...pullRequest(), labels: 'bug' })],
  ])('an unreadable payload (%s) fails towards heavy', (_name, build) => {
    expect(
      decide({ pr: build() as ReturnType<typeof pullRequest> }).heavy,
    ).toBe(true);
  });
});

describe('heavy pull-request check decision entry point', () => {
  const makeTempDir = trackTempDirs();
  afterEach(() => vi.restoreAllMocks());
  const run = async (
    mode: string | undefined,
    event: Record<string, unknown>,
    read: () => Promise<unknown>,
    attempt = '1',
  ) => {
    const dir = makeTempDir('heavy-decision-');
    const eventPath = join(dir, 'event.json');
    const output = join(dir, 'output');
    writeFileSync(eventPath, JSON.stringify(event));
    writeFileSync(output, '');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const decision = await main(
      {
        GITHUB_EVENT_NAME: 'pull_request_target',
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_RUN_ATTEMPT: attempt,
        GITHUB_REPOSITORY: REPOSITORY,
        GITHUB_OUTPUT: output,
        ...(mode === undefined ? {} : { STATION_PR_HEAVY_CHECKS: mode }),
      },
      read,
    );
    return {
      decision,
      output: readFileSync(output, 'utf8'),
      logged: log.mock.calls.flat().join('\n'),
    };
  };

  test('writes heavy=false with its reason for an unarmed push under when-armed', async () => {
    const result = await run(
      'when-armed',
      { action: 'synchronize', pull_request: pullRequest() },
      async () => pullRequest(),
    );
    expect(result.output).toBe('heavy=false\n');
    expect(result.logged).toContain('Heavy pull-request checks: deferred');
  });

  test('writes heavy=true for arming, and never reads the API with the switch off', async () => {
    const read = vi.fn(async () => pullRequest());
    expect(
      (
        await run(
          'when-armed',
          {
            action: 'auto_merge_enabled',
            pull_request: pullRequest({ autoMerge: true }),
          },
          read,
        )
      ).output,
    ).toBe('heavy=true\n');
    const off = await run(
      undefined,
      { action: 'synchronize', pull_request: pullRequest() },
      read,
    );
    expect(off.output).toBe('heavy=true\n');
    expect(read).toHaveBeenCalledTimes(1);
  });

  test('prints whether the event carried pull_request.auto_merge, and reads the head status only when arming', async () => {
    const verified = vi.fn(async () => true);
    const dir = makeTempDir('heavy-decision-');
    const output = join(dir, 'output');
    const eventPath = join(dir, 'event.json');
    writeFileSync(output, '');
    writeFileSync(
      eventPath,
      JSON.stringify({
        action: 'auto_merge_enabled',
        pull_request: pullRequest({ autoMerge: true }),
      }),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const decision = await main(
      {
        GITHUB_EVENT_NAME: 'pull_request_target',
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_REPOSITORY: REPOSITORY,
        GITHUB_OUTPUT: output,
        STATION_PR_HEAVY_CHECKS: 'when-armed',
      },
      async () => pullRequest({ autoMerge: true }),
      verified,
    );
    expect(log.mock.calls.flat().join('\n')).toContain(
      'Event pull_request_target/auto_merge_enabled: pull_request.auto_merge populated',
    );
    expect(verified).toHaveBeenCalledWith(expect.anything(), HEAD);
    expect(decision.heavy).toBe(false);
    expect(readFileSync(output, 'utf8')).toBe('heavy=false\n');
    const pushed = await run(
      undefined,
      { action: 'synchronize', pull_request: pullRequest() },
      async () => pullRequest(),
    );
    expect(pushed.logged).toContain('pull_request.auto_merge null');
    expect(verified).toHaveBeenCalledTimes(1);
  });

  test('the admission job grants the permission the arming status read needs', () => {
    const workflow = load(
      readFileSync(
        new URL('../../.github/workflows/ci.yml', import.meta.url),
        'utf8',
      ),
      { schema: JSON_SCHEMA },
    ) as { jobs: Record<string, { permissions?: Record<string, string> }> };
    const granted = workflow.jobs['pr-admission'].permissions ?? {};
    for (const [scope, level] of Object.entries(HEAD_STATUS_PERMISSION))
      expect(
        level === 'read' ? ['read', 'write'] : [level],
        `pr-admission ${scope}`,
      ).toContain(granted[scope]);
    expect(HEAD_STATUS_PERMISSION).toEqual({ statuses: 'read' });
  });

  test.each([
    [
      'verified',
      async (): Promise<boolean> => true,
      'Arming: head already verified: cheap',
      false,
    ],
    [
      'not verified',
      async (): Promise<boolean> => false,
      'Arming: not verified: heavy',
      true,
    ],
    [
      'unreadable',
      async (): Promise<boolean> => {
        throw new Error('GitHub API 403');
      },
      'Arming: status unreadable: heavy',
      true,
    ],
  ] as const)(
    'arming prints the path it took when the head status is %s',
    async (_name, readVerified, line, heavy) => {
      const dir = makeTempDir('heavy-decision-');
      const eventPath = join(dir, 'event.json');
      writeFileSync(
        eventPath,
        JSON.stringify({
          action: 'auto_merge_enabled',
          pull_request: pullRequest({ autoMerge: true }),
        }),
      );
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const decision = await main(
        {
          GITHUB_EVENT_NAME: 'pull_request_target',
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_RUN_ATTEMPT: '1',
          GITHUB_REPOSITORY: REPOSITORY,
          STATION_PR_HEAVY_CHECKS: 'when-armed',
        },
        async () => pullRequest({ autoMerge: true }),
        readVerified,
      );
      expect(log.mock.calls.flat().join('\n')).toContain(line);
      expect(decision.heavy).toBe(heavy);
    },
  );

  test('a failed live read on a re-run, or an unreadable event file, decides heavy', async () => {
    const failing = async () => {
      throw new Error('GitHub API 502');
    };
    expect(
      (
        await run(
          'when-armed',
          { action: 'synchronize', pull_request: pullRequest() },
          failing,
          '2',
        )
      ).output,
    ).toBe('heavy=true\n');
    const dir = makeTempDir('heavy-decision-');
    const output = join(dir, 'output');
    writeFileSync(join(dir, 'event.json'), '{not json');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(
      {
        GITHUB_EVENT_NAME: 'pull_request_target',
        GITHUB_EVENT_PATH: join(dir, 'event.json'),
        GITHUB_OUTPUT: output,
        STATION_PR_HEAVY_CHECKS: 'when-armed',
      },
      failing,
    );
    expect(readFileSync(output, 'utf8')).toBe('heavy=true\n');
  });
});
