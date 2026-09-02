import { readFileSync } from 'node:fs';
import {
  INTERNAL_TESTFLIGHT_GPG_SIGNER_EMAIL,
  INTERNAL_TESTFLIGHT_GPG_TAGGER_NAME,
  parseInternalTestFlightAuthorityRef,
} from './ios-testflight-internal-authority.mjs';

function fail(message) {
  throw new Error(
    `Internal iOS TestFlight tag verification failed: ${message}`,
  );
}

export function verifiedGpgFingerprint(status) {
  const matches = [
    ...String(status).matchAll(
      /\[GNUPG(?::|)\]\s+VALIDSIG\s+([A-F0-9]{40})\b/g,
    ),
  ];
  if (matches.length !== 1)
    fail('tag does not have exactly one valid GPG signature');
  return matches[0][1];
}

export function verifyInternalTestFlightTag({
  sourceRef,
  sourceSha,
  channel,
  marketingVersion,
  bundleVersion,
  expectedFingerprint,
  localTagObjectSha,
  githubRef,
  githubTag,
  gpgStatus,
}) {
  const parsed = parseInternalTestFlightAuthorityRef(sourceRef);
  if (
    parsed.channel !== channel ||
    parsed.version !== marketingVersion ||
    parsed.bundleVersion !== bundleVersion
  )
    fail(
      'authority tag channel, version, or build does not match delivery inputs',
    );
  if (!/^[A-F0-9]{40}$/.test(expectedFingerprint ?? ''))
    fail(
      'expected signer fingerprint must be 40 uppercase hexadecimal characters',
    );
  if (
    githubRef?.ref !== sourceRef ||
    githubRef?.object?.type !== 'tag' ||
    githubRef.object.sha !== localTagObjectSha
  )
    fail(
      'authority ref is lightweight, torn, or differs from the fetched annotated tag',
    );
  if (
    githubTag?.tag !== sourceRef.slice('refs/tags/'.length) ||
    githubTag?.object?.type !== 'commit' ||
    githubTag.object.sha !== sourceSha ||
    githubTag?.verification?.verified !== true ||
    githubTag.verification.reason !== 'valid' ||
    typeof githubTag.verification.verified_at !== 'string'
  )
    fail(
      'annotated tag does not exactly bind a GitHub-verified signature to this source',
    );
  if (
    githubTag?.tagger?.name !== INTERNAL_TESTFLIGHT_GPG_TAGGER_NAME ||
    githubTag?.tagger?.email !== INTERNAL_TESTFLIGHT_GPG_SIGNER_EMAIL
  ) {
    fail('annotated tagger identity does not match the internal authority');
  }
  if (verifiedGpgFingerprint(gpgStatus) !== expectedFingerprint)
    fail(
      'tag signature fingerprint does not match the protected authority fingerprint',
    );
  return { sourceRef, sourceSha, channel, marketingVersion, bundleVersion };
}

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const options = Object.fromEntries(
    [
      'source-ref',
      'source-sha',
      'channel',
      'marketing-version',
      'bundle-version',
      'expected-fingerprint',
      'local-tag-object-sha',
      'github-ref',
      'github-tag',
      'gpg-status',
    ].map((name) => [name, option(process.argv, name)]),
  );
  if (Object.values(options).some((value) => !value))
    throw new Error('all tag verification options are required');
  console.log(
    JSON.stringify(
      verifyInternalTestFlightTag({
        sourceRef: options['source-ref'],
        sourceSha: options['source-sha'],
        channel: options.channel,
        marketingVersion: options['marketing-version'],
        bundleVersion: options['bundle-version'],
        expectedFingerprint: options['expected-fingerprint'],
        localTagObjectSha: options['local-tag-object-sha'],
        githubRef: JSON.parse(readFileSync(options['github-ref'], 'utf8')),
        githubTag: JSON.parse(readFileSync(options['github-tag'], 'utf8')),
        gpgStatus: readFileSync(options['gpg-status'], 'utf8'),
      }),
    ),
  );
}
