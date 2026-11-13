import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CliAuthState } from './cli-auth.js';

/**
 * Muse Code's XDG config ROOT: `XDG_CONFIG_HOME` when set, else
 * `~/.config`. The engine's own folder is `<root>/muse`
 * ({@link defaultMuseGlobalConfigDir}). An app home replaces the root
 * (`museAppHomeEnv`), so this is the value a session's `XDG_CONFIG_HOME`
 * holds when no profile is selected.
 */
export function defaultMuseConfigRoot(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return env.XDG_CONFIG_HOME?.trim() || join(home, '.config');
}

/** Muse's own global config folder (`~/.config/muse`), the app-home import source. */
export function defaultMuseGlobalConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return join(defaultMuseConfigRoot(env, home), 'muse');
}

/**
 * Where the muse CLI stores its credential, honoring XDG. Presence only —
 * the file is never opened, so no secret material is read (the detection line
 * in docs/design/connections-onboarding.md §1).
 */
export function museCredentialPath(env: NodeJS.ProcessEnv): string {
  return join(defaultMuseGlobalConfigDir(env), 'auth.json');
}

/**
 * `authenticated` means "a credential is available to muse", derived from an
 * env key or the presence of the credential file — never from the CLI merely
 * running. Validity is proven on first use, not here.
 */
export function museCredentialState(
  env: NodeJS.ProcessEnv,
  fileExists: (path: string) => boolean,
): CliAuthState {
  if (env.META_API_KEY?.trim()) return 'authenticated';
  return fileExists(museCredentialPath(env))
    ? 'authenticated'
    : 'unauthenticated';
}

/**
 * What every unattended `muse` run Station makes outside a session (the
 * readiness `--version` probe, the sign-in probes and the device login)
 * carries, so the `muse` launcher script cannot block or prompt:
 *
 * - `MUSE_NO_AUTO_UPDATE=1`: with its binary missing, the launcher would
 *   otherwise download one (an account-authenticated download of the whole
 *   binary) before answering; with this it fails at once with "installed
 *   binary is missing; rerun the installer". It also skips the hourly
 *   background update check, which never blocks a run anyway.
 * - `MUSE_LOGIN=0`: a refused download makes the launcher start its OWN
 *   device login when `MUSE_LOGIN=1` or stderr is a terminal. Station's
 *   stderr is a pipe, so this only closes the inherited `MUSE_LOGIN=1` case,
 *   but that case matters: the launcher's login prints a URL and code like
 *   `muse login`, its token is never stored, and a relayed code would sign
 *   nothing in.
 *
 * Read from launcher 3 (`launcher_version="3"`, Muse Code 1.4.18). Sessions
 * do not carry it: starting one is a user action, and a missing binary
 * downloading then is the launcher doing its job.
 */
export const MUSE_UNATTENDED_LAUNCHER_ENV: Readonly<Record<string, string>> =
  Object.freeze({ MUSE_NO_AUTO_UPDATE: '1', MUSE_LOGIN: '0' });
