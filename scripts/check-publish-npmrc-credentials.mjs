/**
 * Fail-closed npmrc credential preflight for Publish Packages.
 *
 * This intentionally handles only four fixed sources: NPM_CONFIG_USERCONFIG,
 * HOME/.npmrc, RUNNER_TEMP/.npmrc, and GITHUB_WORKSPACE/.npmrc. It never
 * evaluates npmrc text, follows a symlink, or reports paths, values, variable
 * names, or underlying filesystem errors.
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export const PUBLISH_NPMRC_CANDIDATE_SCOPE =
  'NPM_CONFIG_USERCONFIG, HOME/.npmrc, RUNNER_TEMP/.npmrc, and GITHUB_WORKSPACE/.npmrc';

const CANONICAL_CREDENTIAL_KEY = /^\/\/[^\s=]+\/:_auth(?:token)?$/i;
const AUTH_SHAPED_REGISTRY_KEY = /^\/\/[^\s=]*\/:_auth/i;
const EXACT_ENV_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

function defaultFs() {
  return {
    closeSync,
    fstatSync,
    lstatSync,
    openSync,
    readFileSync,
    realpathSync,
  };
}

function configuredUserCandidate(value, { cwd, env, homeDir }) {
  if (typeof value !== 'string' || value.length === 0) return { path: null };
  const homeReference = '$' + '{HOME}/';
  if (value.startsWith(homeReference)) {
    if (env.HOME === undefined) {
      // npm leaves ${HOME} literal when HOME is unset and then resolves the
      // resulting path from cwd. This is not a shell expansion.
      return { path: resolve(cwd, value) };
    }
    if (env.HOME.length === 0) {
      // npm substitutes an explicitly empty HOME before resolving. The slash
      // following ${HOME} therefore makes both single and repeated forms root
      // absolute; preserve that behavior without evaluating arbitrary text.
      return { path: resolve(value.slice(homeReference.length - 1)) };
    }
    const suffix = value.slice(homeReference.length);
    // npm keeps repeated separators after ${HOME}/ home-relative. Prefix a
    // slash-leading suffix with `.` so path.resolve cannot reset to filesystem
    // root; non-leading suffixes retain npm-compatible `..` behavior.
    return {
      path: resolve(env.HOME, suffix.startsWith('/') ? `.${suffix}` : suffix),
    };
  }
  if (value.startsWith('~/')) {
    const suffix = value.slice(2);
    if (env.HOME === '') {
      // npm does not expand tilde against an explicitly empty HOME; it treats
      // the supplied form as a relative path from cwd.
      return { path: resolve(cwd, value) };
    }
    // npm treats ~/x as home-relative but ~//x (and more leading slashes) as
    // root-absolute. Keep this syntax-specific distinction instead of folding
    // tilde and ${HOME} forms into one expansion rule.
    return {
      path: suffix.startsWith('/')
        ? resolve(suffix)
        : resolve(env.HOME ?? homeDir, suffix),
    };
  }
  // npm expands ~/ and ${HOME}/ (including repeated separators, probed with npm
  // 11.17.0); it does not expand $HOME/. Do not evaluate arbitrary shell-like
  // strings here: reject them rather than treating a misconfigured candidate
  // as absent.
  if (value.startsWith('~') || value.includes('$')) {
    return {
      error: 'NPM_CONFIG_USERCONFIG has an unsupported path expansion.',
    };
  }
  return { path: resolve(cwd, value) };
}

function candidatePaths({ cwd, env, homeDir }) {
  const homeCandidate =
    env.HOME === undefined
      ? resolve(homeDir, '.npmrc')
      : env.HOME.length === 0
        ? resolve(cwd, '~/.npmrc')
        : resolve(env.HOME, '.npmrc');
  const runnerTemp = env.RUNNER_TEMP || resolve(cwd, '.npmrc-preflight-absent');
  const workspace = env.GITHUB_WORKSPACE || cwd;
  const configured = configuredUserCandidate(env.NPM_CONFIG_USERCONFIG, {
    cwd,
    env,
    homeDir,
  });
  return {
    errors: configured.error ? [configured.error] : [],
    paths: [
      configured.path,
      homeCandidate,
      resolve(runnerTemp, '.npmrc'),
      resolve(workspace, '.npmrc'),
    ].filter(
      (candidate) => typeof candidate === 'string' && candidate.length > 0,
    ),
  };
}

/**
 * Parses only registry auth entries. A registry-shaped auth key that is not a
 * canonical npm key is a failure rather than an ignored blind spot.
 */
export function credentialValuesFromNpmrc(source) {
  const values = [];
  let malformedCredentialKey = false;
  for (const line of source.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (CANONICAL_CREDENTIAL_KEY.test(key)) {
      values.push(value);
    } else if (AUTH_SHAPED_REGISTRY_KEY.test(key)) {
      malformedCredentialKey = true;
    }
  }
  return { malformedCredentialKey, values };
}

export function credentialValueIsUsable(value, env) {
  // npmrc uses INI-style comments. A credential assignment whose trimmed
  // value is a comment or an empty quoted string cannot name a usable bearer;
  // reject it rather than treating comment punctuation as a literal token.
  if (
    value.length === 0 ||
    value === '""' ||
    value === "''" ||
    value.startsWith('#') ||
    value.startsWith(';')
  ) {
    return false;
  }
  if (!value.includes('${')) return true;
  const match = EXACT_ENV_REFERENCE.exec(value);
  return Boolean(
    match && typeof env[match[1]] === 'string' && env[match[1]].length > 0,
  );
}

/**
 * Returns only redacted diagnostics. `fs` is injectable so failure paths can
 * be proven without opening a FIFO or depending on host permission behavior.
 */
export function scanPublishNpmrcCredentials({
  cwd = process.cwd(),
  env = process.env,
  fs = defaultFs(),
  homeDir = homedir(),
} = {}) {
  const { errors, paths } = candidatePaths({ cwd, env, homeDir });
  const seen = new Set();
  let credentialEntries = 0;
  let scannedFiles = 0;

  for (const candidate of paths) {
    let stat;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT')
        continue;
      errors.push('A configured npmrc candidate could not be inspected.');
      continue;
    }
    if (stat.isSymbolicLink()) {
      errors.push('A configured npmrc candidate is a symlink.');
      continue;
    }
    if (!stat.isFile()) {
      errors.push('A configured npmrc candidate is not a regular file.');
      continue;
    }
    let identity;
    try {
      identity = fs.realpathSync(candidate);
    } catch {
      errors.push('A configured npmrc candidate could not be canonicalized.');
      continue;
    }
    if (seen.has(identity)) continue;
    seen.add(identity);
    const noFollow = constants.O_NOFOLLOW;
    const nonBlocking = constants.O_NONBLOCK;
    if (typeof noFollow !== 'number' || typeof nonBlocking !== 'number') {
      errors.push('This runner cannot safely inspect npmrc candidates.');
      continue;
    }
    let descriptor;
    let source;
    try {
      // `O_NONBLOCK` prevents a race that swaps the verified leaf for a FIFO
      // from hanging the publish job before fstat can reject it.
      descriptor = fs.openSync(
        identity,
        constants.O_RDONLY | noFollow | nonBlocking,
      );
      if (!fs.fstatSync(descriptor).isFile()) {
        errors.push('A configured npmrc candidate is not a regular file.');
        continue;
      }
      source = fs.readFileSync(descriptor, 'utf8');
    } catch {
      errors.push('A configured npmrc candidate could not be opened safely.');
      continue;
    } finally {
      if (descriptor !== undefined) {
        try {
          fs.closeSync(descriptor);
        } catch {
          errors.push(
            'A configured npmrc candidate could not be closed safely.',
          );
        }
      }
    }
    scannedFiles += 1;
    const { malformedCredentialKey, values } =
      credentialValuesFromNpmrc(source);
    if (malformedCredentialKey) {
      errors.push('A registry credential key has unsupported syntax.');
      continue;
    }
    credentialEntries += values.length;
    for (const value of values) {
      if (!credentialValueIsUsable(value, env)) {
        errors.push(
          'A registry credential is empty or uses an unsupported expansion.',
        );
      }
    }
  }
  return { credentialEntries, errors, scannedFiles };
}

export function publishNpmrcSuccess({ credentialEntries, scannedFiles }) {
  return (
    `Publish npmrc credential preflight: scanned ${scannedFiles} unique readable regular file(s) from ${PUBLISH_NPMRC_CANDIDATE_SCOPE}; ` +
    `inspected ${credentialEntries} registry credential entry/entries; no unresolvable registry credential configured.`
  );
}

export function runPublishNpmrcCredentialCheck(options = {}) {
  const result = scanPublishNpmrcCredentials(options);
  if (result.errors.length > 0) {
    options.writeError?.(
      'Publish npmrc credential preflight failed. Correct the npmrc configuration before publishing.',
    );
    return 1;
  }
  options.writeOutput?.(publishNpmrcSuccess(result));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = runPublishNpmrcCredentialCheck({
    writeError: (message) => process.stderr.write(`${message}\n`),
    writeOutput: (message) => process.stdout.write(`${message}\n`),
  });
}
