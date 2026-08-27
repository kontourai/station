import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { listAwsProfiles } from '../aws-profiles.js';

describe('listAwsProfiles', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'station-aws-profiles-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('parses [profile X] and [default] section names from the config file', async () => {
    const configPath = join(dir, 'config');
    await writeFile(
      configPath,
      [
        '[default]',
        'region = us-east-1',
        '',
        '[profile work]',
        'region = us-west-2',
        '',
        '[profile personal-account]',
        'region = eu-west-1',
      ].join('\n'),
    );

    const result = await listAwsProfiles({ configPath });

    expect(result.profiles).toEqual(['default', 'personal-account', 'work']);
    expect(result.available).toBe(true);
  });

  test('parses bare [X] section names from the credentials file without stripping', async () => {
    const credentialsPath = join(dir, 'credentials');
    await writeFile(
      credentialsPath,
      [
        '[default]',
        'aws_access_key_id = AKIAEXAMPLE',
        'aws_secret_access_key = shh',
        '',
        '[work]',
        'aws_access_key_id = AKIAEXAMPLE2',
      ].join('\n'),
    );

    const result = await listAwsProfiles({ credentialsPath });

    expect(result.profiles).toEqual(['default', 'work']);
    expect(result.available).toBe(true);
  });

  test('never returns key=value line content, only section names', async () => {
    const configPath = join(dir, 'config');
    const credentialsPath = join(dir, 'credentials');
    await writeFile(
      configPath,
      '[profile work]\naws_access_key_id = AKIASECRETVALUE\n',
    );
    await writeFile(
      credentialsPath,
      '[work]\naws_secret_access_key = supersecretvalue\n',
    );

    const result = await listAwsProfiles({ configPath, credentialsPath });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('AKIASECRETVALUE');
    expect(serialized).not.toContain('supersecretvalue');
    expect(result.profiles).toEqual(['work']);
  });

  test('merges and de-duplicates profile names across both files', async () => {
    const configPath = join(dir, 'config');
    const credentialsPath = join(dir, 'credentials');
    await writeFile(configPath, '[profile shared]\n[profile config-only]\n');
    await writeFile(credentialsPath, '[shared]\n[creds-only]\n');

    const result = await listAwsProfiles({ configPath, credentialsPath });

    expect(result.profiles).toEqual(['config-only', 'creds-only', 'shared']);
  });

  test('reports unavailable when neither file exists', async () => {
    const result = await listAwsProfiles({
      configPath: join(dir, 'missing-config'),
      credentialsPath: join(dir, 'missing-credentials'),
    });

    expect(result).toEqual({ profiles: [], available: false });
  });

  test('reports available when only one of the two files exists', async () => {
    const configPath = join(dir, 'config');
    await writeFile(configPath, '[profile only-one]\n');

    const result = await listAwsProfiles({
      configPath,
      credentialsPath: join(dir, 'missing-credentials'),
    });

    expect(result).toEqual({ profiles: ['only-one'], available: true });
  });

  test('ignores malformed / non-section lines and blank brackets', async () => {
    const configPath = join(dir, 'config');
    await writeFile(
      configPath,
      [
        'not a section at all',
        '[]',
        '  ',
        '# [profile commented-out]',
        '; [profile also-commented]',
        '[profile   spaced-out]',
        'region=us-east-1',
      ].join('\n'),
    );

    const result = await listAwsProfiles({ configPath });

    expect(result.profiles).toEqual(['spaced-out']);
  });

  // HIGH-1 (review fix round): a header line with anything past the closing
  // bracket — including secret-shaped content — must never surface any of
  // that trailing content as (part of) a profile name. The whole line is
  // rejected outright rather than partially parsed.
  test('rejects a header line carrying secret-shaped trailing content instead of leaking it', async () => {
    const configPath = join(dir, 'config');
    const credentialsPath = join(dir, 'credentials');
    await writeFile(
      configPath,
      '[profile work] aws_secret_access_key = [supersecret]\n[profile safe]\n',
    );
    await writeFile(
      credentialsPath,
      '[work] aws_secret_access_key = [supersecret]\n[safe]\n',
    );

    const result = await listAwsProfiles({ configPath, credentialsPath });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('supersecret');
    expect(serialized).not.toContain('aws_secret_access_key');
    // The malformed line is entirely rejected — "work" never appears, from
    // either file — while a well-formed header on its own line still does.
    expect(result.profiles).toEqual(['safe']);
  });

  test('excludes non-profile config section kinds (sso-session, services)', async () => {
    const configPath = join(dir, 'config');
    await writeFile(
      configPath,
      [
        '[sso-session my-sso]',
        'sso_region = us-east-1',
        '',
        '[services my-services]',
        's3 =',
        '  endpoint_url = https://example.test',
        '',
        '[profile real-profile]',
        'region = us-east-1',
      ].join('\n'),
    );

    const result = await listAwsProfiles({ configPath });

    expect(result.profiles).toEqual(['real-profile']);
  });

  test('never mistakes a bracketed value inside a credential line for a section header', async () => {
    const credentialsPath = join(dir, 'credentials');
    await writeFile(
      credentialsPath,
      [
        '[default]',
        'x_forwarded_headers = [a, b, c]',
        'token = [abc123]',
        '',
        '[work]',
      ].join('\n'),
    );

    const result = await listAwsProfiles({ credentialsPath });

    expect(result.profiles).toEqual(['default', 'work']);
  });

  test('rejects a header line with a trailing inline comment rather than matching it loosely', async () => {
    const configPath = join(dir, 'config');
    await writeFile(
      configPath,
      '[profile with-comment] # trailing comment\n[profile clean]\n',
    );

    const result = await listAwsProfiles({ configPath });

    // The commented header is rejected outright (strict whole-line match);
    // a standalone comment line never interferes with a following header.
    expect(result.profiles).toEqual(['clean']);
  });

  test('a standalone comment line does not interfere with the header that follows it', async () => {
    const configPath = join(dir, 'config');
    await writeFile(
      configPath,
      '# a leading comment\n[profile after-comment]\n; another comment\nregion = us-east-1\n',
    );

    const result = await listAwsProfiles({ configPath });

    expect(result.profiles).toEqual(['after-comment']);
  });
});
