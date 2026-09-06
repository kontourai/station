import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureStationHomeSchemaSync } from '@kontourai/station-shared/station-home-schema';
import { describe, expect, test, vi } from 'vitest';
import { runCloudCommand } from '../commands/cloud.js';

describe('cloud preview command', () => {
  test('prints a real home preview as JSON without claiming transfer readiness', () => {
    const home = mkdtempSync(join(tmpdir(), 'station-cloud-cli-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      ensureStationHomeSchemaSync(home);
      runCloudCommand([
        'preview',
        `--home=${home}`,
        '--provider=aws-ec2',
        '--region=us-east-1',
        '--instance-type=t3.small',
        '--json',
      ]);
      const result = JSON.parse(log.mock.calls.at(-1)?.[0] as string);
      expect(result.target.instanceType).toBe('t3.small');
      expect(result.transferAvailable).toBe(false);
    } finally {
      log.mockRestore();
      rmSync(home, { recursive: true, force: true });
    }
  });
  test('renders the selected AWS profile to a new private file and refuses overwrite or shell injection', () => {
    const home = mkdtempSync(join(tmpdir(), 'station-cloud-template-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const image = `ghcr.io/example/station@sha256:${'a'.repeat(64)}`;
    const output = join(home, 'template.json');
    const args = [
      'template',
      '--provider=aws-ec2',
      '--region=us-east-1',
      '--instance-type=t3.micro',
      `--image=${image}`,
      `--output=${output}`,
    ];
    try {
      runCloudCommand(args);
      const template = JSON.parse(readFileSync(output, 'utf8'));
      const instance = template.Resources.Station.Properties;
      expect(instance.InstanceType).toBe('t3.micro');
      expect(instance.MetadataOptions.HttpTokens).toBe('required');
      expect(instance.BlockDeviceMappings[0].Ebs.DeleteOnTermination).toBe(
        false,
      );
      expect(
        template.Resources.SecurityGroup.Properties.SecurityGroupIngress,
      ).toEqual([]);
      expect(instance.UserData['Fn::Base64']['Fn::Sub']).toContain(image);
      expect(instance.UserData['Fn::Base64']['Fn::Sub']).toContain(
        'ALLOWED_ORIGINS=http://127.0.0.1:' + '$' + '{LocalUiPort}',
      );
      expect(template.Parameters.LocalUiPort.MinValue).toBe(1024);
      expect(template.Parameters.LocalUiPort.MaxValue).toBe(65535);
      expect(() => runCloudCommand(args)).toThrow();
      expect(() =>
        runCloudCommand(
          args.map((arg) =>
            arg.startsWith('--image=')
              ? "--image=image'; touch /tmp/unsafe"
              : arg,
          ),
        ),
      ).toThrow('digest-pinned');
      expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(template);
    } finally {
      log.mockRestore();
      rmSync(home, { recursive: true, force: true });
    }
  });
  test('refuses unsupported actions and flags instead of creating resources', () => {
    expect(() => runCloudCommand(['move'])).toThrow('Usage');
    expect(() => runCloudCommand(['preview', '--include-secrets'])).toThrow(
      'Unsupported',
    );
    expect(() => runCloudCommand(['preview'])).toThrow('--home');
  });
});

test('cloud CLI packages and restores a checkout through its public flags', {
  timeout: 30000,
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'station-cloud-workspace-cli-'));
  const source = join(root, 'source');
  mkdirSync(source);
  const git = (args: string[]) =>
    execFileSync('git', ['-C', source, ...args], {
      windowsHide: true,
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    git(['init', '--template=', '--initial-branch=main']);
    writeFileSync(join(source, 'hello.txt'), 'before\n');
    git(['add', '.']);
    git([
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'Initial',
    ]);
    writeFileSync(join(source, 'hello.txt'), 'after\n');
    const key = `--key-file=${join(root, 'key')}`;
    const archive = `--archive=${join(root, 'workspace.enc')}`;
    runCloudCommand(['keygen', `--output=${join(root, 'key')}`]);
    const args = [
      'pack-workspace',
      `--workspace=${source}`,
      key,
      `--output=${join(root, 'workspace.enc')}`,
    ];
    expect(() => runCloudCommand(args)).toThrow('source-paused');
    expect(() => runCloudCommand([...args, '--source-paused=false'])).toThrow(
      'source-paused',
    );
    runCloudCommand([...args, '--source-paused', '--json']);
    runCloudCommand(['inspect-workspace', archive, key, '--json']);
    const inspection = JSON.parse(log.mock.calls.at(-1)?.[0] as string);
    expect(inspection.files.map((file: { path: string }) => file.path)).toEqual(
      ['hello.txt'],
    );
    expect(inspection.executionAuthorityTransferred).toBe(false);
    runCloudCommand([
      'unpack-workspace',
      archive,
      key,
      `--destination=${join(root, 'restored')}`,
      '--json',
    ]);
    const result = JSON.parse(log.mock.calls.at(-1)?.[0] as string);
    expect(readFileSync(join(result.workspace, 'hello.txt'), 'utf8')).toBe(
      'after\n',
    );
    runCloudCommand([
      'verify-workspace',
      archive,
      key,
      `--workspace=${result.workspace}`,
      '--workspace-paused',
    ]);
    expect(JSON.parse(log.mock.calls.at(-1)?.[0] as string).verified).toBe(
      true,
    );

    expect(() =>
      runCloudCommand([
        'unpack-workspace',
        archive,
        key,
        `--destination=${join(root, 'restored')}`,
      ]),
    ).toThrow();
    expect(() =>
      runCloudCommand([
        'inspect-workspace',
        archive,
        key,
        '--provider=aws-ec2',
      ]),
    ).toThrow('Unsupported');
  } finally {
    log.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
