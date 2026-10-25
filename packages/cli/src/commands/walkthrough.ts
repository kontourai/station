import { randomUUID } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { basename, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import {
  getWalkthrough,
  getWalkthroughImport,
  importWalkthrough,
  listWalkthroughs,
} from '@kontourai/station-sdk/client';
import {
  configureApiCredential,
  parseCoreArgs,
  printJson,
  resolveApiBase,
} from './core-api.js';

/** Accept the spec's space-separated --project as well as the shared = form. */
export async function runWalkthroughCommand(args: string[]) {
  const normalized: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project') {
      const slug = args[++i];
      if (!slug || slug.startsWith('--'))
        throw new Error('--project requires a slug');
      normalized.push(`--project=${slug}`);
    } else normalized.push(args[i]!);
  }
  const parsed = parseCoreArgs(normalized);
  const project = parsed.flags.project;
  if (typeof project !== 'string' || !project)
    throw new Error('Use --project <slug>');
  const base = resolveApiBase(parsed);
  configureApiCredential(parsed, base);
  const [action, value] = parsed.positionals;
  if (action === 'list') {
    printJson(
      await listWalkthroughs(base, project, {
        ...(typeof parsed.flags.cursor === 'string'
          ? { cursor: parsed.flags.cursor }
          : {}),
      }),
    );
    return;
  }
  if (action === 'show' && value) {
    printJson(await getWalkthrough(base, project, value));
    return;
  }
  if (action !== 'import' || !value)
    throw new Error(
      'Usage: station walkthrough import <file> | list | show <id> --project <slug>',
    );
  const file = await openAsBlob(resolve(value));
  const requestId = randomUUID();
  let status = await importWalkthrough(
    base,
    project,
    file,
    basename(value),
    requestId,
    { timeoutMs: null },
  );
  // The request id is the resume coordinate if this CLI disconnects.
  console.error(`Walkthrough import ${requestId}`);
  const deadline = Date.now() + 45 * 60_000;
  while (!status.outcome) {
    if (Date.now() > deadline)
      throw new Error(
        `Import still pending; inspect /api/projects/${encodeURIComponent(project)}/walkthroughs/imports/${requestId}`,
      );
    await setTimeout(500);
    status = await getWalkthroughImport(base, project, requestId);
  }
  const outcome = status.outcome;
  if (outcome.status === 'imported') {
    console.log(outcome.id);
    return;
  }
  if (outcome.status === 'unavailable') {
    if (outcome.reason === 'needs-consent')
      throw new Error(
        `Media tools unavailable: ${outcome.downloads.map((d) => `${d.component} ${d.version} (${d.bytes} bytes)`).join(', ')}. Run station media-tools download --yes`,
      );
    throw new Error(
      `Media tools unavailable: unsupported platform ${outcome.platform}`,
    );
  }
  throw new Error(outcome.reason);
}
