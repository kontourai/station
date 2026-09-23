import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, test } from 'vitest';
import {
  defaultEnrolmentDeps,
  type EnrolmentEngine,
  verifyEnrolment,
} from '../credential-enrolment.js';

const execFileAsync = promisify(execFile);

/**
 * The mocked tests in `credential-enrolment.test.ts` drive `verifyEnrolment`
 * with a resolving `execFile`. The real CLIs do not resolve: BOTH
 * `claude auth status` and `codex login status` exit **1** when signed out,
 * and `promisify(execFile)` rejects on a non-zero exit.
 *
 * That gap survived four independent review rounds and was only found by
 * running the feature against a live Station: a signed-out profile reported
 * `unknown` ("we could not ask") instead of `unauthenticated` ("this account
 * is signed out") — the exact conflation the module says it does not make,
 * and two states that lead a user to different actions.
 *
 * So this test uses NO mock. It points each real CLI at an empty config home
 * and asserts the verdict. If the mapping regresses, the assertion that
 * catches it must be one that talked to the actual binary.
 *
 * Skipped when the CLI is absent. Vitest records a skipped test, not a passing
 * callback; an absent binary means this proved nothing, which is different
 * from passing.
 */
const homes: string[] = [];
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

async function present(command: string): Promise<boolean> {
  try {
    await execFileAsync(command, ['--version'], { timeout: 20_000 });
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    // A CLI that launches but rejects --version is still present. Let the
    // status assertion report the real failure instead of treating it as an
    // unavailable prerequisite.
    if (typeof code === 'number') return true;
    throw error;
  }
}

function emptyHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'enrolment-int-'));
  homes.push(home);
  return home;
}

/**
 * Real status commands must not inherit the operator's credentials. Keep only
 * executable lookup and the platform variables needed to launch a child;
 * point every user-home variable at the disposable fixture directory.
 */
function isolatedEnv(
  home: string,
  hostEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const pathEntry = Object.entries(hostEnv).find(
    ([key]) => key.toLowerCase() === 'path',
  );
  const env: NodeJS.ProcessEnv = { HOME: home };
  if (pathEntry?.[1]) env[pathEntry[0]] = pathEntry[1];

  if (process.platform === 'win32') {
    for (const key of ['SYSTEMROOT', 'WINDIR', 'PATHEXT'] as const) {
      const entry = Object.entries(hostEnv).find(
        ([name]) => name.toUpperCase() === key,
      );
      if (entry?.[1]) env[entry[0]] = entry[1];
    }
    env.USERPROFILE = home;
    env.APPDATA = join(home, 'AppData', 'Roaming');
    env.LOCALAPPDATA = join(home, 'AppData', 'Local');
    env.TEMP = home;
    env.TMP = home;
  }

  return env;
}

describe('verifyEnrolment against the real engine CLIs', () => {
  for (const [engine, binary] of [
    ['claude', 'claude'],
    ['codex', 'codex'],
  ] as ReadonlyArray<[EnrolmentEngine, string]>) {
    test(`${engine}: an empty config home reads as unauthenticated, not unknown`, async ({
      skip,
    }) => {
      if (!(await present(binary))) {
        skip(`${binary} is not installed; the real-CLI assertion did not run`);
      }
      const home = emptyHome();
      const inheritedEnv: NodeJS.ProcessEnv = {
        ...process.env,
        ANTHROPIC_API_KEY: 'fixture-only-synthetic-value',
        CLAUDE_CODE_OAUTH_TOKEN: 'fixture-only-synthetic-value',
        OPENAI_API_KEY: 'fixture-only-synthetic-value',
        CODEX_API_KEY: 'fixture-only-synthetic-value',
      };
      const fixtureEnv = isolatedEnv(home, inheritedEnv);
      const defaultDeps = defaultEnrolmentDeps();
      let statusEnv: NodeJS.ProcessEnv | undefined;
      const result = await verifyEnrolment(engine, home, {
        ...defaultDeps,
        env: fixtureEnv,
        execFile: (command, args, options) => {
          statusEnv = options.env;
          return defaultDeps.execFile(command, args, options);
        },
      });
      expect(statusEnv).toBeDefined();
      expect(
        Object.entries(statusEnv ?? {}).find(
          ([name]) => name.toLowerCase() === 'path',
        )?.[1],
      ).toBe(
        Object.entries(process.env).find(
          ([name]) => name.toLowerCase() === 'path',
        )?.[1],
      );
      expect(
        Object.keys(statusEnv ?? {}).filter((name) =>
          /(?:API.?KEY|TOKEN|SECRET|CREDENTIAL|AUTH)/i.test(name),
        ),
      ).toEqual([]);
      expect(
        result.state,
        `${binary} exits non-zero when signed out; the exit code must not be mistaken for an unreadable status`,
      ).toBe('unauthenticated');
    }, 60_000);
  }
});
