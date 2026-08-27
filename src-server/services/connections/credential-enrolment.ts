/**
 * station#3549: enrol an account into a credential profile by delegating the
 * login to the engine's OWN CLI, pointed at a Station-owned app-home.
 *
 * ## Why Station does not implement OAuth
 *
 * The obvious shape — Station runs the OAuth flow and stores the token — forces
 * two policy choices with no good answer: which flows are sanctioned per
 * provider (and who keeps that current as terms change), and whether Station
 * registers its own OAuth client or reuses each CLI's client id.
 *
 * Both dissolve if the CLI does the login. Station already knows how to point
 * an engine at a profile directory — that is exactly what `claudeAppHomeEnv` /
 * `codexAppHomeEnv` do for sessions. The same override applied to the CLI's
 * *login* makes it authenticate INTO that profile. The CLI authenticates as
 * itself, which is what the provider expects; Station chooses no flow, so it
 * cannot choose a wrong one, and it never sees a token.
 *
 * Verified live on macOS — the platform whose Keychain storage makes this
 * non-obvious (`APP_HOME_ENGINES.claude` carries that caveat):
 *
 *   CODEX_HOME=<empty>        codex login status  -> Not logged in
 *                             codex login status  -> Logged in using ChatGPT
 *   CLAUDE_CONFIG_DIR=<empty> claude auth status  -> { "loggedIn": false }
 *                             claude auth status  -> { "loggedIn": true, ... }
 *
 * ## Ask the engine; never infer from an exit code
 *
 * `verifyEnrolment` runs the engine's own status command and reads its answer.
 * A login command exiting 0 means the process ended, not that an account is
 * signed in — a user who closes the browser tab gets a clean exit and no
 * credential. This is also why verification does not reuse the file-reading
 * detectors: on macOS the credential can live in the Keychain, so the file
 * being absent is not proof, and the engine's own answer is the only
 * authority.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type EnrolmentEngine = 'claude' | 'codex';

/** What the caller must run, and in what environment, to sign this profile in. */
export interface EnrolmentCommand {
  command: string;
  args: string[];
  /**
   * Applied ON TOP of the caller's environment. It is only ever the engine's
   * config-home override — Station never injects credentials here.
   */
  env: Record<string, string>;
  /** Shown to the user before anything runs. Never a silent spawn. */
  description: string;
}

export type EnrolmentAuthState =
  | 'authenticated'
  | 'unauthenticated'
  | 'unknown';

export interface EnrolmentVerification {
  state: EnrolmentAuthState;
  /** The engine's own words, when it gave any. Never Station's paraphrase. */
  detail?: string;
}

export interface EnrolmentDeps {
  execFile: (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; timeout: number; windowsHide: boolean },
  ) => Promise<{ stdout: string; stderr: string }>;
  env: NodeJS.ProcessEnv;
}

export function defaultEnrolmentDeps(): EnrolmentDeps {
  return {
    execFile: (command, args, options) =>
      execFileAsync(command, args, options) as Promise<{
        stdout: string;
        stderr: string;
      }>,
    env: process.env,
  };
}

const STATUS_TIMEOUT_MS = 15_000;

/** The engine's config-home override — the same variable its sessions use. */
export function enrolmentHomeEnv(
  engine: EnrolmentEngine,
  profileDir: string,
): Record<string, string> {
  return engine === 'claude'
    ? { CLAUDE_CONFIG_DIR: profileDir }
    : { CODEX_HOME: profileDir };
}

/**
 * The login the USER runs, in a terminal. It is interactive and browser-based,
 * so it is deliberately returned rather than spawned: Station describes what
 * will run and the caller surfaces it, instead of a background process
 * silently opening a browser.
 */
export function enrolmentCommand(
  engine: EnrolmentEngine,
  profileDir: string,
): EnrolmentCommand {
  return engine === 'claude'
    ? {
        command: 'claude',
        args: ['auth', 'login'],
        env: enrolmentHomeEnv(engine, profileDir),
        description:
          "Signs in with Claude Code's own login, storing the account in this credential profile instead of your global Claude config.",
      }
    : {
        command: 'codex',
        args: ['login'],
        env: enrolmentHomeEnv(engine, profileDir),
        description:
          "Signs in with Codex's own login, storing the account in this credential profile instead of your global Codex config.",
      };
}

/**
 * Claude answers `auth status` as JSON. Parse it rather than matching prose:
 * a message string is a UI surface that changes between releases, a
 * `loggedIn` boolean is a contract.
 */
function readClaudeStatus(stdout: string): EnrolmentVerification {
  try {
    const parsed = JSON.parse(stdout) as {
      loggedIn?: unknown;
      authMethod?: unknown;
      email?: unknown;
    };
    if (typeof parsed.loggedIn !== 'boolean') {
      return {
        state: 'unknown',
        detail: 'The engine did not report a status.',
      };
    }
    const email = typeof parsed.email === 'string' ? parsed.email : undefined;
    const method =
      typeof parsed.authMethod === 'string' ? parsed.authMethod : undefined;
    return {
      state: parsed.loggedIn ? 'authenticated' : 'unauthenticated',
      ...(parsed.loggedIn && (email || method)
        ? { detail: email ? `${email}${method ? ` (${method})` : ''}` : method }
        : {}),
    };
  } catch {
    return {
      state: 'unknown',
      detail: 'The engine did not report a status.',
    };
  }
}

/**
 * Codex answers in prose ("Logged in using ChatGPT" / "Not logged in"), so the
 * NEGATIVE is matched explicitly and anything unrecognized is `unknown` rather
 * than assumed signed-in. Guessing in the optimistic direction here would
 * report an account Station cannot actually use.
 */
function readCodexStatus(stdout: string): EnrolmentVerification {
  const text = stdout.trim();
  if (!text) {
    return { state: 'unknown', detail: 'The engine did not report a status.' };
  }
  const first = text.split('\n')[0].trim();
  // Independent review (Codex) found the original pair of loose matchers
  // reported "You are not currently logged in" as AUTHENTICATED: the negative
  // required the words adjacent, while the positive matched "logged in"
  // anywhere. Any negation between "not" and the phrase defeated it, which is
  // the precise failure this function claims it cannot have.
  //
  // Now: a negation ANYWHERE before the phrase wins, and the positive must
  // START the line. "Last logged in attempt failed" therefore does not
  // authenticate, because the affirmative reading is not the line's subject.
  if (/\bno(t|n)\b[^.]{0,40}logged\s+in/i.test(first)) {
    return { state: 'unauthenticated' };
  }
  if (/^logged\s+in\b/i.test(first)) {
    return { state: 'authenticated', detail: first };
  }
  return { state: 'unknown', detail: first };
}

/**
 * Claude reports on STDOUT as JSON; Codex reports in prose and writes its
 * signed-out message to STDERR ("Not logged in") while writing the signed-in
 * one to stdout. Both were captured live. Reading only stdout made a
 * signed-out Codex profile unreadable.
 */
function readStatus(
  engine: EnrolmentEngine,
  stdout: string,
  stderr: string,
): EnrolmentVerification {
  if (engine === 'claude') {
    const fromStdout = readClaudeStatus(stdout);
    return fromStdout.state === 'unknown'
      ? readClaudeStatus(stderr)
      : fromStdout;
  }
  const fromStdout = readCodexStatus(stdout);
  return fromStdout.state === 'unknown' ? readCodexStatus(stderr) : fromStdout;
}

/**
 * Ask the engine whether this profile is signed in.
 *
 * A non-zero exit is `unknown`, never `unauthenticated`: a missing binary and
 * a signed-out account are different facts, and reporting the first as the
 * second would tell a user to sign in again when the real problem is that the
 * CLI is not installed.
 */
export async function verifyEnrolment(
  engine: EnrolmentEngine,
  profileDir: string,
  deps: EnrolmentDeps = defaultEnrolmentDeps(),
): Promise<EnrolmentVerification> {
  const [command, args] =
    engine === 'claude'
      ? ['claude', ['auth', 'status']]
      : ['codex', ['login', 'status']];
  try {
    const { stdout, stderr } = await deps.execFile(
      command as string,
      args as string[],
      {
        env: { ...deps.env, ...enrolmentHomeEnv(engine, profileDir) },
        timeout: STATUS_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    return readStatus(engine, stdout, stderr);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return {
        state: 'unknown',
        detail: `The ${command} command was not found on this host.`,
      };
    }
    // End-to-end finding: BOTH CLIs exit 1 when signed out, and
    // `promisify(execFile)` rejects on a non-zero exit — so the original code
    // discarded a perfectly good report and called a signed-out account
    // `unknown`. That is precisely the conflation this function claims it does
    // not make: "signed out" and "we could not ask" are different facts that
    // lead a user to different actions.
    //
    // A non-zero exit is how these CLIs SIGNAL signed-out, so the payload is
    // still authoritative. Only an unusable payload is genuinely unknown.
    const failure = error as { stdout?: unknown; stderr?: unknown };
    const parsed = readStatus(
      engine,
      typeof failure.stdout === 'string' ? failure.stdout : '',
      typeof failure.stderr === 'string' ? failure.stderr : '',
    );
    if (parsed.state !== 'unknown') return parsed;
    return {
      state: 'unknown',
      detail: 'The engine could not report a status.',
    };
  }
}
