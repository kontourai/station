/**
 * The two refusals plugin publishing makes before it touches git (epic
 * #2323 S6): where a plugin may be pushed, and what may be committed.
 *
 * Both are pure so they can be tested exhaustively and so the route can
 * refuse before anything in the folder changes.
 */

/** Why a remote address was refused. Stable codes; the UI words them. */
export type PluginPublishRemoteRefusal =
  | 'empty'
  | 'unsupported-transport'
  | 'credentials-in-url'
  | 'malformed';

export type PluginPublishRemoteVerdict =
  | {
      ok: true;
      transport: 'https' | 'ssh';
      /**
       * The address `station plugin install` accepts for this repository:
       * always `https://…/<path>.git`, the form the install path classifies
       * as a git source. For an SSH remote this is DERIVED (same host and
       * path over HTTPS), which assumes the host serves the repository over
       * HTTPS as well; `installSourceDerived` says so.
       */
      installSource: string;
      installSourceDerived: boolean;
    }
  | { ok: false; code: PluginPublishRemoteRefusal };

const MAX_REMOTE_URL_LENGTH = 2048;
const SSH_USER = /^[A-Za-z0-9._-]+$/;
// A DNS name or IPv4 address. Deliberately no single-label one-letter host:
// `c:path` is a Windows drive, not an scp-style remote.
const HOST =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
const SCP_LIKE = /^(?:([^@/:\s]+)@)?([^@/:\s]+):(.+)$/;

function withGitSuffix(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.endsWith('.git') ? trimmed : `${trimmed}.git`;
}

function validRepositoryPath(path: string): boolean {
  const trimmed = path.replace(/^\/+/, '').replace(/\/+$/, '');
  if (trimmed === '' || trimmed === '.git') return false;
  return trimmed
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * Accepts only `https://host/path` and SSH (`ssh://[user@]host/path` or the
 * scp form `[user@]host:path`).
 *
 * Refused: every other transport, including local paths and `file://` (a
 * push that writes somewhere on this machine is not publishing), git's
 * `<transport>::<address>` remote-helper syntax (`ext::` runs a command),
 * plain `http://`, anything starting with `-` (it would reach git's argv as
 * an option), and any address carrying a password or token. A username is
 * allowed only for SSH, where it names the account (`git@`) and is not a
 * secret.
 */
export function validatePluginPublishRemoteUrl(
  raw: string,
): PluginPublishRemoteVerdict {
  const url = raw.trim();
  if (url === '') return { ok: false, code: 'empty' };
  if (
    url.length > MAX_REMOTE_URL_LENGTH ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
    /[\s\u0000-\u001f\u007f]/.test(url)
  ) {
    return { ok: false, code: 'malformed' };
  }
  if (url.startsWith('-') || url.includes('::')) {
    return { ok: false, code: 'unsupported-transport' };
  }

  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, code: 'malformed' };
    }
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== 'https:' && protocol !== 'ssh:') {
      return { ok: false, code: 'unsupported-transport' };
    }
    if (parsed.password !== '')
      return { ok: false, code: 'credentials-in-url' };
    if (protocol === 'https:' && parsed.username !== '') {
      return { ok: false, code: 'credentials-in-url' };
    }
    if (protocol === 'ssh:' && parsed.username !== '') {
      if (!SSH_USER.test(decodeURIComponent(parsed.username))) {
        return { ok: false, code: 'malformed' };
      }
    }
    if (
      !HOST.test(parsed.hostname) ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      !validRepositoryPath(parsed.pathname)
    ) {
      return { ok: false, code: 'malformed' };
    }
    const path = withGitSuffix(parsed.pathname);
    if (protocol === 'https:') {
      return {
        ok: true,
        transport: 'https',
        installSource: `https://${parsed.host}${path}`,
        installSourceDerived: false,
      };
    }
    // The SSH port is not the HTTPS port, so it is dropped with the user.
    return {
      ok: true,
      transport: 'ssh',
      installSource: `https://${parsed.hostname}${path}`,
      installSourceDerived: true,
    };
  }

  // Anything else that is not scp-style is a local path, which git would
  // happily push to; refused as a transport.
  const scp = SCP_LIKE.exec(url);
  if (!scp) return { ok: false, code: 'unsupported-transport' };
  const [, user, host, path] = scp;
  if (user !== undefined && user.includes(':')) {
    return { ok: false, code: 'credentials-in-url' };
  }
  if (user !== undefined && !SSH_USER.test(user)) {
    return { ok: false, code: 'malformed' };
  }
  if (!HOST.test(host) || host.length < 2 || !validRepositoryPath(path)) {
    return { ok: false, code: 'malformed' };
  }
  return {
    ok: true,
    transport: 'ssh',
    installSource: `https://${host}/${withGitSuffix(path.replace(/^\/+/, ''))}`,
    installSourceDerived: true,
  };
}

/**
 * A remote address safe to show a person: any userinfo is removed, so a
 * token someone already put in a remote never reaches the page that tells
 * them it will not be used.
 */
export function redactRemoteUrl(raw: string): string {
  const url = raw.trim();
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url)) {
    try {
      const parsed = new URL(url);
      if (parsed.password !== '' || parsed.username !== '') {
        parsed.username = parsed.protocol === 'ssh:' ? parsed.username : '';
        parsed.password = '';
        return parsed.toString();
      }
    } catch {
      // Unparseable: fall through to the generic strip below.
    }
  }
  return url.replace(/^([^@/]*:\/\/)?[^@/\s]*:[^@/\s]*@/, '$1');
}

const ENV_FILE_TEMPLATES = new Set([
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.dist',
]);
const KEY_FILE_EXTENSIONS = [
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.keystore',
  '.jks',
  '.ppk',
];
const SSH_PRIVATE_KEY_NAMES = new Set([
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);
const CREDENTIAL_FILE_NAMES = new Set([
  '.npmrc',
  '.pypirc',
  '.netrc',
  '_netrc',
  '.git-credentials',
  '.dockercfg',
  '.htpasswd',
  'credentials',
  'credentials.json',
]);

/**
 * Why a path looks like a secret, or `null`. Judged on the path alone, so it
 * holds for a file that is about to be deleted as well as one being added;
 * `privateKeyInContent` covers a key saved under an innocent name.
 */
export function secretLookingPathReason(path: string): string | null {
  const segments = path.split('/');
  const name = (segments.at(-1) ?? '').toLowerCase();
  if (segments.slice(0, -1).some((segment) => segment === '.ssh')) {
    return 'inside an .ssh folder';
  }
  if (
    (name === '.env' || name.startsWith('.env.')) &&
    !ENV_FILE_TEMPLATES.has(name)
  ) {
    return 'environment file';
  }
  if (SSH_PRIVATE_KEY_NAMES.has(name)) return 'SSH private key';
  if (KEY_FILE_EXTENSIONS.some((extension) => name.endsWith(extension))) {
    return 'key or certificate store';
  }
  if (CREDENTIAL_FILE_NAMES.has(name)) return 'credentials file';
  return null;
}

const PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;

export function privateKeyInContent(content: string): boolean {
  return PRIVATE_KEY_BLOCK.test(content);
}
