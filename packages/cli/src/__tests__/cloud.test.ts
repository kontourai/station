import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
