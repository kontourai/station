import { readFileSync } from 'node:fs';

export const INTERNAL_TESTFLIGHT_GPG_GITHUB_LOGIN = 'briananderson1222';
export const INTERNAL_TESTFLIGHT_GPG_SIGNER_EMAIL =
  'brian.anderson1222@gmail.com';

function fail(message) {
  throw new Error(
    `Internal iOS TestFlight GPG registration verification failed: ${message}`,
  );
}

function gpgFields(source, type) {
  return String(source)
    .split(/\r?\n/)
    .map((line) => line.split(':'))
    .filter((fields) => fields[0] === type);
}

function decodeUid(value) {
  try {
    return decodeURIComponent(value.replace(/\\x3a/gi, ':'));
  } catch {
    return value;
  }
}

export function gpgIdentity(source) {
  const fingerprints = gpgFields(source, 'fpr').map((fields) => fields[9]);
  const uids = gpgFields(source, 'uid').map((fields) => decodeUid(fields[9]));
  if (
    fingerprints.length === 0 ||
    fingerprints.some((value) => !/^[A-F0-9]{40}$/.test(value ?? ''))
  )
    fail('GPG key listing has no valid fingerprint');
  return { fingerprint: fingerprints[0], uids };
}

export function verifyInternalTestFlightGpgRegistration({
  expectedFingerprint,
  authorityColons,
  githubColons,
}) {
  if (!/^[A-F0-9]{40}$/.test(expectedFingerprint ?? ''))
    fail(
      'expected signer fingerprint must be 40 uppercase hexadecimal characters',
    );
  const authority = gpgIdentity(authorityColons);
  const github = gpgIdentity(githubColons);
  if (authority.fingerprint !== expectedFingerprint)
    fail('protected environment authority key does not match its fingerprint');
  if (github.fingerprint !== expectedFingerprint)
    fail(
      'GitHub-registered public key does not exactly match the authority key',
    );
  const email = INTERNAL_TESTFLIGHT_GPG_SIGNER_EMAIL;
  const hasExactEmail = (uids) =>
    uids.some((uid) => /<([^<>]+)>$/.exec(uid)?.[1] === email);
  if (!hasExactEmail(authority.uids) || !hasExactEmail(github.uids))
    fail(`authority key must carry exact UID email ${email}`);
  return {
    schemaVersion: 1,
    kind: 'ios-testflight-gpg-registration',
    githubLogin: INTERNAL_TESTFLIGHT_GPG_GITHUB_LOGIN,
    signerEmail: INTERNAL_TESTFLIGHT_GPG_SIGNER_EMAIL,
    fingerprint: expectedFingerprint,
    status: 'registered-and-identity-matched',
  };
}

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const expectedFingerprint = option(process.argv, 'expected-fingerprint');
  const authorityPath = option(process.argv, 'authority-colons');
  const githubPath = option(process.argv, 'github-colons');
  if (!expectedFingerprint || !authorityPath || !githubPath)
    throw new Error(
      'usage: --expected-fingerprint <fingerprint> --authority-colons <path> --github-colons <path>',
    );
  console.log(
    JSON.stringify(
      verifyInternalTestFlightGpgRegistration({
        expectedFingerprint,
        authorityColons: readFileSync(authorityPath, 'utf8'),
        githubColons: readFileSync(githubPath, 'utf8'),
      }),
    ),
  );
}
