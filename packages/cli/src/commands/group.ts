import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  cancelCliSessionGroup,
  createCliSessionGroup,
  getCliSessionGroup,
  listCliSessionGroups,
  parseCliSessionGroupInput,
  parseCliSessionGroupSyncInput,
  runCliSessionGroup,
  syncCliSessionGroup,
} from '@kontourai/station-sdk/client';
import { optionalValueFlag, type ParsedCoreArgs } from './core-api.js';
import { terminalSafeJson, terminalSafeText } from './terminal-safe.js';

async function withGroupInterrupt<T>(
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const stop = new AbortController();
  const interrupt = () => stop.abort();
  process.once('SIGINT', interrupt);
  try {
    return await action(stop.signal);
  } finally {
    process.removeListener('SIGINT', interrupt);
  }
}

export async function runGroupCommand(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  const [action, groupId, ...extra] = parsed.positionals;
  const create = action === 'session-create';
  const list = action === 'session-list';
  const sync = action === 'session-sync';
  const fromFile = create || sync;
  const inspect = list || action === 'session-get';
  if (
    ![
      'session-create',
      'session-get',
      'session-list',
      'session-run',
      'session-cancel',
      'session-sync',
    ].includes(action ?? '') ||
    extra.length ||
    (create || list ? groupId !== undefined : !groupId)
  )
    throw new Error(
      'Expected group session-create --file=<path>, session-list [--after=<group>], session-sync <group> --file=<path>, or session-get|session-run|session-cancel <group>.',
    );
  for (const flag of Object.keys(parsed.flags)) {
    if (
      ![
        'json',
        'api-base',
        'station',
        'credential',
        ...(fromFile ? ['file'] : []),
        ...(list ? ['after'] : []),
        ...(inspect ? ['include-context-sync'] : []),
      ].includes(flag) ||
      (parsed.repeatedFlags[flag]?.length ?? 0) > 1
    )
      throw new Error(`Unsupported or repeated session-group flag --${flag}.`);
  }
  const inspectReceipt = parsed.flags['include-context-sync'];
  if (typeof inspectReceipt === 'string')
    throw new Error('--include-context-sync does not take a value.');
  let result: unknown;
  if (fromFile) {
    const file = optionalValueFlag(parsed, 'file');
    if (!file) throw new Error('--file=<path> is required.');
    const descriptor = openSync(
      resolve(file),
      constants.O_RDONLY | constants.O_NONBLOCK,
    );
    let bytes: Buffer;
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size > 262_144)
        throw new Error(
          'Session group input must be a regular JSON file of at most 256 KiB.',
        );
      const buffer = Buffer.alloc(262_145);
      let length = 0;
      while (length < buffer.length) {
        const read = readSync(
          descriptor,
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (!read) break;
        length += read;
      }
      if (length > 262_144)
        throw new Error('Session group input exceeds 256 KiB.');
      bytes = buffer.subarray(0, length);
    } finally {
      closeSync(descriptor);
    }
    const input: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
    if (create) {
      result = await createCliSessionGroup(
        apiBase,
        parseCliSessionGroupInput(input),
      );
    } else {
      const syncInput = parseCliSessionGroupSyncInput(input);
      result = await withGroupInterrupt((signal) =>
        syncCliSessionGroup(apiBase, groupId!, syncInput, { signal }),
      );
    }
  } else if (list)
    result = await listCliSessionGroups(apiBase, {
      afterGroupId: optionalValueFlag(parsed, 'after'),
      includeContextSync: inspectReceipt === true,
    });
  else if (action === 'session-get')
    result = await getCliSessionGroup(apiBase, groupId!, {
      includeContextSync: inspectReceipt === true,
    });
  else if (action === 'session-cancel')
    result = await cancelCliSessionGroup(apiBase, groupId!);
  else
    result = await withGroupInterrupt((signal) =>
      runCliSessionGroup(apiBase, groupId!, { signal }),
    );
  console.log(
    terminalSafeJson(result).split('\n').map(terminalSafeText).join('\n'),
  );
}
