import { describe, expect, test, vi } from 'vitest';
import {
  type EnrolmentDeps,
  enrolmentCommand,
  enrolmentHomeEnv,
  verifyEnrolment,
} from '../credential-enrolment.js';

/**
 * archive#3549. The status outputs below are the LIVE strings each CLI emits,
 * captured on macOS against a real and an empty config home:
 *
 *   claude auth status  -> {"loggedIn":true,"authMethod":"claude.ai","email":…}
 *                       -> {"loggedIn":false,"authMethod":"none",…}
 *   codex login status  -> "Logged in using ChatGPT" / "Not logged in"
 */
function deps(
  result: { stdout: string } | { throws: Error & { code?: string } } = {
    stdout: '',
  },
): EnrolmentDeps {
  return {
    env: { PATH: '/usr/bin' },
    execFile: vi.fn(async () => {
      if ('throws' in result) throw result.throws;
      return { stdout: result.stdout, stderr: '' };
    }) as never,
  };
}

describe('enrolment command composition', () => {
  test('points each engine at the profile home with its own config-home variable', () => {
    expect(enrolmentHomeEnv('claude', '/p')).toEqual({
      CLAUDE_CONFIG_DIR: '/p',
    });
    expect(enrolmentHomeEnv('codex', '/p')).toEqual({ CODEX_HOME: '/p' });
  });

  // Station delegates the login; it does not implement OAuth and must never
  // put a credential in the environment it hands the CLI.
  test("runs the engine's own login and injects only the config-home override", () => {
    for (const engine of ['claude', 'codex'] as const) {
      const composed = enrolmentCommand(engine, '/profile');
      expect(composed.command).toBe(engine);
      expect(Object.keys(composed.env)).toHaveLength(1);
      expect(JSON.stringify(composed.env)).not.toMatch(
        /token|key|secret|password/i,
      );
      expect(composed.description).toMatch(/instead of your global/i);
    }
    expect(enrolmentCommand('claude', '/p').args).toEqual(['auth', 'login']);
    expect(enrolmentCommand('codex', '/p').args).toEqual(['login']);
  });
});

describe('verification asks the engine', () => {
  test('reads Claude’s JSON contract, not its prose', async () => {
    const signedIn = await verifyEnrolment(
      'claude',
      '/p',
      deps({
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod: 'claude.ai',
          email: 'someone@example.com',
        }),
      }),
    );
    expect(signedIn.state).toBe('authenticated');
    expect(signedIn.detail).toBe('someone@example.com (claude.ai)');

    const signedOut = await verifyEnrolment(
      'claude',
      '/p',
      deps({ stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }) }),
    );
    expect(signedOut.state).toBe('unauthenticated');
  });

  test('reads Codex’s prose, matching the negative explicitly', async () => {
    expect(
      (await verifyEnrolment('codex', '/p', deps({ stdout: 'Not logged in' })))
        .state,
    ).toBe('unauthenticated');
    const yes = await verifyEnrolment(
      'codex',
      '/p',
      deps({ stdout: 'Logged in using ChatGPT' }),
    );
    expect(yes.state).toBe('authenticated');
    expect(yes.detail).toBe('Logged in using ChatGPT');
  });

  // Guessing optimistically would report an account Station cannot use.
  test('unrecognized output is unknown, never assumed signed in', async () => {
    for (const stdout of ['', 'something else entirely', '{"nope":1}']) {
      const claude = await verifyEnrolment('claude', '/p', deps({ stdout }));
      const codex = await verifyEnrolment('codex', '/p', deps({ stdout }));
      expect(claude.state).toBe('unknown');
      // Independent review (Codex): `not.toBe('authenticated')` let an
      // implementation returning `unauthenticated` for EVERY unrecognized
      // response pass a test whose title demands `unknown`. Assert the verdict
      // the title claims.
      expect(codex.state).toBe('unknown');
    }
  });

  // Independent review (Codex): the original matchers reported "You are not
  // currently logged in" as AUTHENTICATED, because the negative required
  // adjacency while the positive matched anywhere in the string.
  test('a negated status is never read as signed in', async () => {
    for (const stdout of [
      'You are not currently logged in',
      'Login expired; not logged in',
      'Not logged in',
    ]) {
      const result = await verifyEnrolment('codex', '/p', deps({ stdout }));
      expect(result.state).toBe('unauthenticated');
    }
    // An affirmative that is not the line's subject is not an authentication.
    const incidental = await verifyEnrolment(
      'codex',
      '/p',
      deps({ stdout: 'Last logged in attempt failed' }),
    );
    expect(incidental.state).toBe('unknown');
  });

  // A missing binary and a signed-out account are different facts. Reporting
  // the first as the second tells a user to sign in again when the real
  // problem is that the CLI is not installed.
  test('a missing CLI is unknown with a naming reason, not unauthenticated', async () => {
    const error = Object.assign(new Error('spawn ENOENT'), {
      code: 'ENOENT',
    });
    const result = await verifyEnrolment(
      'codex',
      '/p',
      deps({ throws: error }),
    );
    expect(result.state).toBe('unknown');
    expect(result.detail).toMatch(/codex command was not found/i);
  });

  test('any other failure is unknown, never a verdict', async () => {
    const result = await verifyEnrolment(
      'claude',
      '/p',
      deps({
        throws: Object.assign(new Error('timed out'), { code: 'ETIME' }),
      }),
    );
    expect(result.state).toBe('unknown');
  });

  test('verification runs against the PROFILE home, not the global one', async () => {
    const d = deps({ stdout: 'Not logged in' });
    await verifyEnrolment('codex', '/station/profiles/work', d);
    const call = (d.execFile as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(call[0]).toBe('codex');
    expect(call[1]).toEqual(['login', 'status']);
    expect(call[2].env.CODEX_HOME).toBe('/station/profiles/work');
    // The ambient environment is preserved, not replaced.
    expect(call[2].env.PATH).toBe('/usr/bin');
  });
});

/**
 * END-TO-END FINDING (live, against a real Station instance). Four review
 * rounds could not see this: every test drove `verifyEnrolment` with a
 * RESOLVING `execFile`, and the real CLIs reject.
 *
 * Both `claude auth status` and `codex login status` exit **1** when signed
 * out. `promisify(execFile)` rejects on a non-zero exit, so the original code
 * discarded a perfectly good report and called a signed-out account
 * `unknown` — the exact conflation this module claims it does not make.
 *
 * Captured live on macOS:
 *   claude, signed out -> exit 1, stdout '{"loggedIn":false,...}', stderr ''
 *   codex,  signed out -> exit 1, stdout '',   stderr 'Not logged in'
 *   codex,  signed in  -> exit 0, stdout 'Logged in using ChatGPT'
 */
function rejectingDeps(result: {
  stdout?: string;
  stderr?: string;
  code?: string;
}): EnrolmentDeps {
  return {
    env: { PATH: '/usr/bin' },
    execFile: vi.fn(async () => {
      throw Object.assign(new Error('Command failed'), {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        ...(result.code ? { code: result.code } : {}),
      });
    }) as never,
  };
}

describe('a non-zero exit is how these CLIs signal signed-out', () => {
  test('claude: exit 1 with its JSON on stdout reads as unauthenticated', async () => {
    const result = await verifyEnrolment(
      'claude',
      '/p',
      rejectingDeps({
        stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }),
      }),
    );
    expect(result.state).toBe('unauthenticated');
  });

  test('codex: exit 1 with its message on STDERR reads as unauthenticated', async () => {
    const result = await verifyEnrolment(
      'codex',
      '/p',
      rejectingDeps({ stdout: '', stderr: 'Not logged in' }),
    );
    expect(result.state).toBe('unauthenticated');
  });

  // The distinction the exit-code fix must not erase: a genuinely unusable
  // result is still unknown.
  test('a non-zero exit with no usable payload is still unknown', async () => {
    for (const engine of ['claude', 'codex'] as const) {
      const result = await verifyEnrolment(
        engine,
        '/p',
        rejectingDeps({ stdout: '', stderr: '' }),
      );
      expect(result.state).toBe('unknown');
    }
  });

  test('a missing binary is still unknown, not unauthenticated', async () => {
    const result = await verifyEnrolment(
      'codex',
      '/p',
      rejectingDeps({ code: 'ENOENT', stderr: 'spawn ENOENT' }),
    );
    expect(result.state).toBe('unknown');
    expect(result.detail).toMatch(/not found on this host/i);
  });
});
