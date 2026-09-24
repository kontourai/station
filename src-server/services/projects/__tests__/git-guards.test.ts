/**
 * Ported with the guards from the reviewed S6 plugin-publish branch
 * (#2363); the accept cases no longer derive an install source.
 */
import { describe, expect, test } from 'vitest';
import {
  privateKeyInContent,
  redactRemoteUrl,
  secretLookingPathReason,
  validateGitRemoteUrl,
} from '../git-guards.js';

describe('validateGitRemoteUrl', () => {
  test.each([
    ['https://github.com/acme/pulse.git', 'https'],
    ['https://github.com/acme/pulse', 'https'],
    ['https://git.example.com:8443/team/pulse/', 'https'],
    ['git@github.com:acme/pulse.git', 'ssh'],
    ['github.com:acme/pulse', 'ssh'],
    ['ssh://git@github.com:2222/acme/pulse.git', 'ssh'],
  ])('accepts %s over %s', (url, transport) => {
    expect(validateGitRemoteUrl(url)).toEqual({ ok: true, transport });
  });

  test.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['file:///tmp/bare.git', 'unsupported-transport'],
    ['FILE:///tmp/bare.git', 'unsupported-transport'],
    ['/tmp/bare.git', 'unsupported-transport'],
    ['../bare.git', 'unsupported-transport'],
    ['./bare', 'unsupported-transport'],
    ['ext::sh -c touch% /tmp/pwned', 'malformed'],
    ['ext::sh%20-c%20id', 'unsupported-transport'],
    ['fd::17', 'unsupported-transport'],
    ['http://github.com/acme/pulse.git', 'unsupported-transport'],
    ['git://github.com/acme/pulse.git', 'unsupported-transport'],
    ['--upload-pack=touch /tmp/pwned', 'malformed'],
    ['-oProxyCommand=id', 'unsupported-transport'],
    ['https://ghp_abc123@github.com/acme/pulse.git', 'credentials-in-url'],
    ['https://user:secret@github.com/acme/pulse.git', 'credentials-in-url'],
    ['ssh://git:secret@github.com/acme/pulse.git', 'credentials-in-url'],
    ['https://github.com/acme/pulse.git?token=x', 'malformed'],
    ['https://github.com/acme/pulse.git#main', 'malformed'],
    ['https://github.com/', 'malformed'],
    ['github.com:acme/../pulse.git', 'malformed'],
    ['c:repo', 'malformed'],
    // review L3: this machine, local-only, and numeric forms of them
    ['https://localhost/a/b', 'local-host'],
    ['https://api.localhost/a/b', 'local-host'],
    ['https://127.0.0.1/a/b', 'local-host'],
    ['https://2130706433/a/b', 'local-host'],
    ['https://169.254.169.254/a/b', 'local-host'],
    ['https://0.0.0.0/a/b', 'local-host'],
    ['https://[::1]/a/b', 'local-host'],
    ['git@127.0.0.1:a/b.git', 'local-host'],
    ['git@localhost:a/b.git', 'local-host'],
    // review 2 LOW 5: numeric IPv4 spellings over ssh and scp
    ['ssh://git@0x7f.1/a/b.git', 'local-host'],
    ['ssh://git@2130706433/a/b.git', 'local-host'],
    ['ssh://git@017700000001/a/b.git', 'local-host'],
    ['ssh://git@0x7f000001/a/b.git', 'local-host'],
    ['git@0x7f.1:a/b.git', 'local-host'],
    ['git@2130706433:a/b.git', 'local-host'],
    ['git@017700000001:a/b.git', 'local-host'],
    ['git@0x7f000001:a/b.git', 'local-host'],
    // review NIT: an ssh user or path that git or ssh would read as an option
    ['ssh://-oProxyCommand=id@github.com/a/b', 'malformed'],
    ['ssh://-lx@github.com/a/b', 'malformed'],
    ['git@github.com:-u/b', 'malformed'],
    // encoded separators and non-ASCII
    ['https://github.com/a%2F..%2Fb', 'malformed'],
    ['https://github.com/a/b\u200b', 'malformed'],
  ])('refuses %j as %s', (url, code) => {
    expect(validateGitRemoteUrl(url)).toEqual({ ok: false, code });
  });
});

describe('redactRemoteUrl', () => {
  test('removes a token or password and keeps an SSH account name', () => {
    expect(redactRemoteUrl('https://ghp_abc@github.com/a/b.git')).not.toContain(
      'ghp_abc',
    );
    expect(
      redactRemoteUrl('https://user:secret@github.com/a/b.git'),
    ).not.toContain('secret');
    expect(redactRemoteUrl('ssh://git:secret@host.example/a.git')).toBe(
      'ssh://git@host.example/a.git',
    );
    expect(redactRemoteUrl('git@github.com:a/b.git')).toBe(
      'git@github.com:a/b.git',
    );
    // review L4: a token can ride in the query or fragment too.
    expect(redactRemoteUrl('https://github.com/a/b?access_token=abc')).toBe(
      'https://github.com/a/b',
    );
    expect(redactRemoteUrl('https://github.com/a/b#tok')).toBe(
      'https://github.com/a/b',
    );
  });
});

describe('secretLookingPathReason', () => {
  test.each([
    ['.env', 'environment file'],
    ['config/.env.local', 'environment file'],
    ['.ENV.production', 'environment file'],
    ['keys/server.pem', 'key or certificate store'],
    ['tls.key', 'key or certificate store'],
    ['id_ed25519', 'SSH private key'],
    ['.ssh/config', 'inside an .ssh folder'],
    ['.npmrc', 'credentials file'],
    ['.git-credentials', 'credentials file'],
    ['aws/credentials', 'credentials file'],
    // review L1
    ['secrets.json', 'credentials file'],
    ['infra/terraform.tfstate', 'Terraform state'],
    ['terraform.tfstate.backup', 'Terraform state'],
    ['.kube/config', 'Kubernetes config'],
    ['service-account-prod.json', 'service account key'],
    ['id_ed25519_sk', 'SSH private key'],
    ['prod.env', 'environment file'],
  ])('flags %s', (path, reason) => {
    expect(secretLookingPathReason(path)).toBe(reason);
  });

  test.each([
    'plugin.json',
    '.env.example',
    'src/env.ts',
    'id_ed25519.pub',
    'README.md',
    'src/keyboard.tsx',
  ])('does not flag %s', (path) => {
    expect(secretLookingPathReason(path)).toBeNull();
  });
});

test('privateKeyInContent finds PEM private-key blocks only', () => {
  expect(
    privateKeyInContent('x\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc'),
  ).toBe(true);
  expect(privateKeyInContent('-----BEGIN PRIVATE KEY-----')).toBe(true);
  expect(privateKeyInContent('-----BEGIN PUBLIC KEY-----')).toBe(false);
});
