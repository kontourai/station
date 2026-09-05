import { writeFileSync } from 'node:fs';
import {
  prepareCloudEnvironment,
  previewCloudMove,
} from '@kontourai/station-shared/cloud-move';
import { parseCoreArgs } from './core-api.js';

export function runCloudCommand(args: string[]): void {
  const { flags, positionals } = parseCoreArgs(args);
  const action = positionals[0];
  if (positionals.length !== 1 || !['preview', 'template'].includes(action))
    throw new Error(
      'Usage: station cloud <preview|template> --provider=aws-ec2 --region=<region> --instance-type=<type> [options]',
    );
  const allowed = new Set([
    'provider',
    'region',
    'instance-type',
    ...(action === 'preview' ? ['home', 'json'] : ['image', 'output']),
  ]);
  for (const flag of Object.keys(flags))
    if (!allowed.has(flag))
      throw new Error(`Unsupported cloud ${action} option: --${flag}`);
  const required = (key: string) => {
    const value = flags[key];
    if (typeof value !== 'string' || !value.trim())
      throw new Error(`Cloud ${action} requires --${key}=<value>`);
    return value;
  };
  const home = action === 'preview' ? required('home') : undefined;
  const target = {
    providerId: required('provider'),
    region: required('region'),
    instanceType: required('instance-type'),
  };
  if (action === 'template') {
    const output = required('output');
    const template = prepareCloudEnvironment({
      target,
      image: required('image'),
    });
    writeFileSync(output, `${JSON.stringify(template, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    console.log(
      'Prepared deployment template. No cloud resources created or local setup transferred.',
    );
    return;
  }
  const result = previewCloudMove({ homeDir: home as string, target });
  if (flags.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(
      'Cloud move preview — no files transferred, credential stores accessed, or resources created.',
    );
    for (const item of result.items)
      console.log(
        `${item.kind} ${item.id}: ${item.disposition}\n  ${item.reasons.join(' ')}`,
      );
    for (const warning of result.warnings) console.log(`Review: ${warning}`);
    for (const blocker of result.blockers) console.log(`Not ready: ${blocker}`);
  }
}
