import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  attachProject,
  getProjectIdentity,
  parseProjectPortableIdentity,
  prepareProjectIdentity,
} from '@kontourai/station-sdk/project-identity';
import {
  type ParsedCoreArgs,
  printFetched,
  printResolvedTarget,
  requirePositional,
} from './core-api.js';

async function readIdentityFile(file: string): Promise<unknown> {
  const handle = await open(resolve(file), 'r');
  try {
    if (!(await handle.stat()).isFile())
      throw new Error('The identity snapshot must be a regular JSON file.');
    const buffer = Buffer.alloc(64 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 64 * 1024)
      throw new Error('The identity snapshot exceeds 64 KiB.');
    return JSON.parse(buffer.subarray(0, length).toString('utf8')) as unknown;
  } finally {
    await handle.close();
  }
}

/** Uses the normal selected-Station credential owner and the public attachment API. */
export async function runProjectIdentityCommand(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  const action = parsed.positionals[0];
  const slug = requirePositional(parsed, 1, 'Project slug');
  if (parsed.positionals.length !== 2)
    throw new Error('Supply exactly one Project slug.');
  const allowed = new Set([
    'api-base',
    'station',
    'credential',
    'json',
    ...(action === 'attach'
      ? ['identity-file', 'name', 'target-workspace']
      : []),
  ]);
  for (const flag of Object.keys(parsed.flags))
    if (!allowed.has(flag))
      throw new Error(`Unsupported Project identity flag: --${flag}`);

  const options = { authentication: 'required' as const };
  if (action === 'identity' || action === 'prepare-identity') {
    if (action === 'prepare-identity') printResolvedTarget();
    const view =
      action === 'identity'
        ? await getProjectIdentity(apiBase, slug, options)
        : await prepareProjectIdentity(apiBase, slug, options);
    printFetched(view.identity);
    return;
  }
  if (action !== 'attach')
    throw new Error('Unsupported Project identity action.');
  const required = (flag: string): string => {
    const value = parsed.flags[flag];
    if (typeof value !== 'string' || !value.trim())
      throw new Error(`Project attachment requires --${flag}=<value>.`);
    return value;
  };
  if (
    parsed.flags.station === undefined &&
    parsed.flags['api-base'] === undefined
  )
    throw new Error(
      'Select the destination explicitly with --station or --api-base.',
    );
  if (parsed.flags.station !== undefined) required('station');
  if (parsed.flags['api-base'] !== undefined) required('api-base');
  const name = required('name');
  const identity = parseProjectPortableIdentity(
    await readIdentityFile(required('identity-file')),
  );
  const workingDirectory =
    parsed.flags['target-workspace'] === undefined
      ? undefined
      : required('target-workspace');
  // This path belongs to the selected Station; do not expand or stat it on the CLI host.
  printResolvedTarget();
  printFetched(
    await attachProject(
      apiBase,
      {
        slug,
        name,
        identity,
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
      },
      options,
    ),
  );
}
