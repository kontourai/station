import { writeFileSync } from 'node:fs';
import {
  prepareCloudEnvironment,
  previewCloudMove,
} from '@kontourai/station-shared/cloud-move';
import {
  createWorkspacePackageKey,
  inspectWorkspacePackage,
  packWorkspace,
  unpackWorkspace,
} from '@kontourai/station-shared/workspace-package';
import { runCloudProjectImport } from './cloud-project-import.js';
import { parseCoreArgs } from './core-api.js';

export function runCloudCommand(args: string[]): void | Promise<void> {
  const parsed = parseCoreArgs(args);
  const { flags, positionals } = parsed;
  const action = positionals[0];
  const actionOptions: Record<string, string[]> = {
    preview: ['provider', 'region', 'instance-type', 'home', 'json'],
    template: ['provider', 'region', 'instance-type', 'image', 'output'],
    keygen: ['output'],
    'import-project': [
      'archive',
      'key-file',
      'destination',
      'target-workspace',
      'name',
      'slug',
      'station',
      'api-base',
      'json',
    ],
    'pack-workspace': [
      'workspace',
      'key-file',
      'output',
      'source-paused',
      'json',
    ],
    'inspect-workspace': ['archive', 'key-file', 'json'],
    'unpack-workspace': ['archive', 'key-file', 'destination', 'json'],
  };
  if (positionals.length !== 1 || !Object.hasOwn(actionOptions, action))
    throw new Error(
      'Usage: station cloud <preview|template|keygen|pack-workspace|inspect-workspace|unpack-workspace|import-project> [options]',
    );
  const allowed = new Set(actionOptions[action]);
  for (const flag of Object.keys(flags))
    if (!allowed.has(flag))
      throw new Error(`Unsupported cloud ${action} option: --${flag}`);
  if (action === 'import-project') return runCloudProjectImport(parsed);
  const required = (key: string) => {
    const value = flags[key];
    if (typeof value !== 'string' || !value.trim())
      throw new Error(`Cloud ${action} requires --${key}=<value>`);
    return value;
  };
  if (action === 'keygen') {
    createWorkspacePackageKey(required('output'));
    console.log(
      'Created a workspace encryption key file. Keep it separate from the package and source checkout.',
    );
    return;
  }
  if (action.endsWith('-workspace')) {
    const keyFile = required('key-file');
    const result =
      action === 'pack-workspace'
        ? packWorkspace({
            workspace: required('workspace'),
            output: required('output'),
            keyFile,
            sourcePaused: flags['source-paused'] === true,
          })
        : action === 'inspect-workspace'
          ? inspectWorkspacePackage({ archive: required('archive'), keyFile })
          : unpackWorkspace({
              archive: required('archive'),
              keyFile,
              destination: required('destination'),
            });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
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
