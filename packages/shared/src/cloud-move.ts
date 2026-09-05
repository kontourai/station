import { type Dirent, lstatSync, opendirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  CloudMoveItem,
  CloudMovePreview,
  CloudMoveTarget,
} from '@kontourai/station-contracts/cloud-move';
import { awsEc2EnvironmentTemplate } from './cloud-aws-ec2.js';
import {
  readRegularFileNoFollow,
  readStationHomeSchemaVersion,
  STATION_HOME_SCHEMA_VERSION,
} from './station-home-schema.js';

/** Infrastructure adapters advertise only their currently validated preview inputs. */
export interface CloudMovePreviewProvider {
  readonly id: string;
  validateTarget(target: CloudMoveTarget): readonly string[];
  environmentTemplate?(input: {
    target: CloudMoveTarget;
    image: string;
  }): Record<string, unknown>;
}

export const awsEc2PreviewProvider: CloudMovePreviewProvider = {
  id: 'aws-ec2',
  environmentTemplate: awsEc2EnvironmentTemplate,
  validateTarget(target) {
    if (!/^[a-z]{2}(?:-[a-z]+)+-[1-9][0-9]*$/.test(target.region))
      throw new Error('Specify an AWS region identifier');
    if (!['t3.micro', 't3.small', 't3.medium'].includes(target.instanceType))
      throw new Error('Unsupported EC2 preview instance type');
    return [
      'AWS account access, regional availability, image compatibility, and cost have not been verified.',
      ...(target.instanceType === 't3.micro'
        ? [
            'The 1-GiB memory limit has not been qualified for Station and agent tools.',
          ]
        : []),
    ];
  },
};

/** GCP preparation currently exposes inventory only; provisioning follows the
 * separately documented, owner-selected development recipe. */
export const gcpComputePreviewProvider: CloudMovePreviewProvider = {
  id: 'gcp-compute',
  validateTarget(target) {
    if (!/^[a-z]+(?:-[a-z]+)+[1-9][0-9]*$/.test(target.region))
      throw new Error('Specify a GCP region identifier, not a zone');
    if (!['e2-micro', 'e2-small', 'e2-medium'].includes(target.instanceType))
      throw new Error('Unsupported GCP preview machine type');
    return [
      'Preview does not inspect Google credentials, project billing, quotas, or target readiness.',
      'Shared-core capacity and any free-tier allowance must be checked for the selected billing account and workload.',
    ];
  },
};

/** Read selected configuration metadata only; never read credential payloads,
 * provider homes, plugin journals, or session databases. Unknown state cannot
 * turn this observational preview into a transferable setup or resume claim. */
export function previewCloudMove(input: {
  homeDir: string;
  target: CloudMoveTarget;
  providers?: readonly CloudMovePreviewProvider[];
}): CloudMovePreview {
  const provider = selectProvider(input.target, input.providers);
  const target = { ...input.target };
  const warnings = [...provider.validateTarget(target)];
  const home = resolve(input.homeDir);
  function directory(path: string, optional = false): boolean {
    try {
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error('Unsafe directory');
      return true;
    } catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT')
        return false;
      throw new Error(
        'Cloud preview cannot inspect a selected configuration directory',
      );
    }
  }
  directory(home);
  let sourceSchemaVersion: number;
  try {
    sourceSchemaVersion = readStationHomeSchemaVersion(home);
    if (sourceSchemaVersion !== STATION_HOME_SCHEMA_VERSION)
      throw new Error('Unsupported schema');
  } catch {
    throw new Error(
      'Cloud preview requires a readable, supported Station home schema; it does not migrate or reset a home',
    );
  }
  const items: CloudMoveItem[] = [];
  let inspectedBytes = 0;
  function record(path: string): Record<string, unknown> {
    try {
      const source = readRegularFileNoFollow(home, path, {
        maxBytes: 256 * 1024,
      });
      inspectedBytes += Buffer.byteLength(source);
      if (inspectedBytes > 4 * 1024 * 1024)
        throw new Error('Preview byte bound');
      const value: unknown = JSON.parse(source);
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid configuration');
      return value as Record<string, unknown>;
    } catch {
      throw new Error(
        'Cloud preview cannot read a bounded configuration record',
      );
    }
  }
  for (const section of ['agents', 'projects'] as const) {
    const root = join(home, section);
    if (!directory(root, true)) continue;
    const entries: Dirent[] = [];
    const handle = opendirSync(root, { bufferSize: 1 });
    try {
      for (
        let entry = handle.readSync();
        entry !== null;
        entry = handle.readSync()
      ) {
        if (entries.length === 1000)
          throw new Error(
            'Cloud preview configuration inventory exceeds its bound',
          );
        entries.push(entry);
      }
    } finally {
      handle.closeSync();
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink())
        throw new Error(
          'Cloud preview refuses linked configuration directories',
        );
      if (!entry.isDirectory()) continue;
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(entry.name))
        throw new Error(
          'Cloud preview found an unsupported configuration identifier',
        );
      const path = join(root, entry.name);
      directory(path);
      const value = record(
        join(path, section === 'agents' ? 'agent.json' : 'project.json'),
      );
      if (section === 'agents') {
        const execution = value.execution;
        if (
          execution !== undefined &&
          (!execution ||
            typeof execution !== 'object' ||
            Array.isArray(execution))
        )
          throw new Error(
            'Cloud preview found invalid Agent execution configuration',
          );
        items.push({
          kind: 'agent',
          id: entry.name,
          disposition: 'review-required',
          reasons: [
            'Validate the target engine, model, tools, and path bindings; configuration presence is not compatibility evidence.',
          ],
        });
      } else {
        if (
          typeof value.id !== 'string' ||
          typeof value.slug !== 'string' ||
          value.slug !== entry.name ||
          (value.workingDirectory !== undefined &&
            typeof value.workingDirectory !== 'string')
        )
          throw new Error('Cloud preview found invalid Project configuration');
        items.push({
          kind: 'project',
          id: entry.name,
          disposition: 'review-required',
          reasons: [
            value.workingDirectory
              ? 'Select and verify a target workspace mapping, including uncommitted files; source workspace bytes were not scanned.'
              : 'Select a target workspace before execution.',
          ],
        });
      }
    }
  }
  items.push(
    {
      kind: 'plugin',
      id: 'plugin-inventory',
      disposition: 'review-required',
      reasons: [
        'Active plugin inventory has not been queried from its lifecycle owner. Reinstall and obtain fresh target grants; storage directories, compatibility links, and journals do not establish portable authority.',
      ],
    },
    {
      kind: 'credentials',
      id: 'credential-enrollment',
      disposition: 'reauthentication-required',
      reasons: [
        'Dedicated credential stores, OS keychains, and provider login directories are not accessed. Selected configuration bytes may contain sensitive fields; those fields are not projected. Enroll credentials on the target through supported provider flows.',
      ],
    },
    {
      kind: 'history',
      id: 'historical-state',
      disposition: 'review-required',
      reasons: [
        'Historical state requires consistent capture and a validated import contract; copying a database does not move authority.',
      ],
    },
    {
      kind: 'execution',
      id: 'active-work',
      disposition: 'not-transferable',
      reasons: [
        'Live process state and server-only capabilities cannot be serialized. Resume requires provider support, fresh target admission, and a fenced source owner.',
      ],
    },
  );
  return {
    schemaVersion: 'station.cloud-move-preview/v1',
    target,
    sourceSchemaVersion,
    observation: 'non-atomic-preview',
    transferAvailable: false,
    executionResumeAvailable: false,
    items,
    blockers: [
      'Cloud provisioning and target verification are not implemented by this preview.',
      'Consistent setup capture and credential enrollment must complete before transfer.',
      'Source fencing and target execution admission must complete before resuming work.',
    ],
    warnings,
  };
}

function selectProvider(
  target: CloudMoveTarget,
  registered?: readonly CloudMovePreviewProvider[],
) {
  const providers = registered ?? [
    awsEc2PreviewProvider,
    gcpComputePreviewProvider,
  ];
  if (
    new Set(providers.map((provider) => provider.id)).size !== providers.length
  )
    throw new Error('Duplicate cloud provider registration');
  const provider = providers.find((entry) => entry.id === target.providerId);
  if (!provider) throw new Error('Unsupported cloud provider');
  return provider;
}

export function prepareCloudEnvironment(input: {
  target: CloudMoveTarget;
  image: string;
  providers?: readonly CloudMovePreviewProvider[];
}): Record<string, unknown> {
  const provider = selectProvider(input.target, input.providers);
  provider.validateTarget(input.target);
  if (!provider.environmentTemplate)
    throw new Error('Cloud provider does not support environment preparation');
  return provider.environmentTemplate({
    target: { ...input.target },
    image: input.image,
  });
}
