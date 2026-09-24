/**
 * Refusals Station makes before it runs git with the operator's credentials
 * in a folder other people can write (#2363): where a push may go, and what
 * may be committed.
 *
 * Ported from the reviewed plugin-publish guards of epic #2323 S6 (branch
 * `feat/plugin-publish-git-s6`). Pure, so they can be tested exhaustively and
 * a route can refuse before anything in the folder changes.
 */

/** Why a remote address was refused. Stable codes; the UI words them. */
export type GitRemoteRefusal =
  | 'empty'
  | 'unsupported-transport'
  | 'credentials-in-url'
  | 'local-host'
  | 'malformed';

export type GitRemoteVerdict =
  | { ok: true; transport: 'https' | 'ssh' }
  | { ok: false; code: GitRemoteRefusal };

const MAX_REMOTE_URL_LENGTH = 2048;
// Never starting with `-`: ssh would read `-oProxyCommand=…` as an option.
const SSH_USER = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
// A DNS name or IPv4 address. Deliberately no single-label one-letter host:
// `c:path` is a Windows drive, not an scp-style remote.
const HOST =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
const SCP_LIKE = /^(?:([^@/:\s]+)@)?([^@/:\s]+):(.+)$/;

function validRepositoryPath(path: string): boolean {
  const trimmed = path.replace(/^\/+/, '').replace(/\/+$/, '');
  if (trimmed === '' || trimmed === '.git') return false;
  return trimmed.split('/').every(
    (segment) =>
      segment !== '' &&
      segment !== '.' &&
      segment !== '..' &&
      // An option-looking segment, or an encoded separator that could
      // reassemble into `..` on the far side.
      !segment.startsWith('-') &&
      !/%(?:2f|5c|2e)/i.test(segment),
  );
}

/**
 * Loopback, link-local and unspecified hosts, by ADDRESS. Publishing is
 * pushing to somewhere else; a push to this machine, or to a cloud
 * metadata address, is not that. `hostname` must already be normalized by
 * `normalizedHostname`, which turns every numeric IPv4 spelling
 * (`2130706433`, `0x7f.1`, `017700000001`, `127.1`) into dotted form.
 *
 * The limit, stated: this judges the address as written. A DNS name that
 * resolves to a loopback or private address is not detected, and private
 * ranges (10/8, 192.168/16) are allowed, because a git server on a
 * company network is a legitimate place to push to.
 */
function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '0.0.0.0' ||
    /^127\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^0\./.test(host) ||
    host.startsWith('[')
  );
}

/**
 * WHATWG URL parsing canonicalizes IPv4 only for "special" schemes, so the
 * host is always parsed as https, whatever the transport (review 2 LOW 5:
 * `ssh://git@0x7f.1/…` and `git@2130706433:…` got past an ssh: parse).
 */
function normalizedHostname(host: string): string | null {
  try {
    return new URL(`https://${host}/`).hostname;
  } catch {
    return null;
  }
}

/**
 * Accepts only `https://host/path` and SSH (`ssh://[user@]host/path` or the
 * scp form `[user@]host:path`).
 *
 * Refused: every other transport, including local paths and `file://` (a
 * push to a local path runs that repository's hooks as the operator), git's
 * `<transport>::<address>` remote-helper syntax (`ext::` runs a command),
 * plain `http://`, anything starting with `-` (it would reach git's argv as
 * an option), and any address carrying a password or token. A username is
 * allowed only for SSH, where it names the account (`git@`) and is not a
 * secret.
 */
export function validateGitRemoteUrl(raw: string): GitRemoteVerdict {
  const url = raw.trim();
  if (url === '') return { ok: false, code: 'empty' };
  if (
    url.length > MAX_REMOTE_URL_LENGTH ||
    // Printable ASCII only: no whitespace, no control characters, and no
    // look-alike or zero-width characters that render as a different
    // address than the one git receives.
    /[^\x21-\x7e]/.test(url)
  ) {
    return { ok: false, code: 'malformed' };
  }
  // `<transport>::<address>` is how git names a remote helper (`ext::` runs
  // a command). Git recognises it only as a prefix, which is what this
  // matches; any other `::` (an IPv6 literal) is judged below.
  if (url.startsWith('-') || /^[A-Za-z0-9+.-]+::/.test(url)) {
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
    const normalizedHost = normalizedHostname(parsed.hostname);
    if (normalizedHost === null) return { ok: false, code: 'malformed' };
    if (isLocalHost(normalizedHost)) return { ok: false, code: 'local-host' };
    if (
      !HOST.test(parsed.hostname) ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      !validRepositoryPath(parsed.pathname)
    ) {
      return { ok: false, code: 'malformed' };
    }
    if (protocol === 'https:') {
      return { ok: true, transport: 'https' };
    }
    return { ok: true, transport: 'ssh' };
  }

  // Anything else that is not scp-style is a local path, which git would
  // happily push to; refused as a transport.
  const scp = SCP_LIKE.exec(url);
  if (!scp) return { ok: false, code: 'unsupported-transport' };
  const [, user, host, path] = scp;
  if (user?.includes(':')) {
    return { ok: false, code: 'credentials-in-url' };
  }
  if (user !== undefined && !SSH_USER.test(user)) {
    return { ok: false, code: 'malformed' };
  }
  if (!HOST.test(host) || host.length < 2 || !validRepositoryPath(path)) {
    return { ok: false, code: 'malformed' };
  }
  const normalized = normalizedHostname(host);
  if (normalized === null) return { ok: false, code: 'malformed' };
  if (isLocalHost(normalized)) return { ok: false, code: 'local-host' };
  return { ok: true, transport: 'ssh' };
}

/**
 * A remote address safe to show a person: any userinfo is removed, so a
 * token someone already put in a remote never reaches the page that tells
 * them it will not be used.
 */
export function redactRemoteUrl(raw: string): string {
  // A query or fragment can carry a token (`?access_token=`) as well as
  // userinfo can; neither is part of a repository's address.
  const url = raw.trim().replace(/[?#].*$/s, '');
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
  'id_ecdsa_sk',
  'id_ed25519_sk',
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
  'secrets.json',
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
    (name === '.env' || name.startsWith('.env.') || name.endsWith('.env')) &&
    !ENV_FILE_TEMPLATES.has(name)
  ) {
    return 'environment file';
  }
  if (
    segments.length >= 2 &&
    segments.at(-2) === '.kube' &&
    name === 'config'
  ) {
    return 'Kubernetes config';
  }
  if (name.endsWith('.tfstate') || name.endsWith('.tfstate.backup')) {
    return 'Terraform state';
  }
  if (name.startsWith('service-account') && name.endsWith('.json')) {
    return 'service account key';
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
