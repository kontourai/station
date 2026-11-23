import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  cancelCliSessionGroup,
  createCliSessionGroup,
  getCliSessionGroup,
  listCliSessionGroups,
  parseCliSessionGroupInput,
  runCliSessionGroup,
} from '@kontourai/station-sdk/client';
import { optionalValueFlag, type ParsedCoreArgs } from './core-api.js';
import { terminalSafeJson, terminalSafeText } from './terminal-safe.js';

export async function runGroupCommand(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  const [action, groupId, ...extra] = parsed.positionals;
  const create = action === 'session-create';
  const list = action === 'session-list';
  if (
    ![
      'session-create',
      'session-get',
      'session-list',
      'session-run',
      'session-cancel',
    ].includes(action ?? '') ||
    extra.length ||
    (create || list ? groupId !== undefined : !groupId)
  )
    throw new Error(
      'Expected group session-create --file=<path>, session-list [--after=<group>], or session-get|session-run|session-cancel <group>.',
    );
  for (const flag of Object.keys(parsed.flags)) {
    if (
      ![
        'json',
        'api-base',
        'station',
        'credential',
        ...(create ? ['file'] : []),
        ...(list ? ['after'] : []),
      ].includes(flag) ||
      (parsed.repeatedFlags[flag]?.length ?? 0) > 1
    )
      throw new Error(`Unsupported or repeated session-group flag --${flag}.`);
  }
  let result: unknown;
  if (create) {
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
    const input = parseCliSessionGroupInput(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
    result = await createCliSessionGroup(apiBase, input);
  } else if (list)
    result = await listCliSessionGroups(apiBase, {
      afterGroupId: optionalValueFlag(parsed, 'after'),
    });
  else if (action === 'session-get')
    result = await getCliSessionGroup(apiBase, groupId!);
  else if (action === 'session-cancel')
    result = await cancelCliSessionGroup(apiBase, groupId!);
  else {
    const stop = new AbortController();
    const interrupt = () => stop.abort();
    process.once('SIGINT', interrupt);
    try {
      result = await runCliSessionGroup(apiBase, groupId!, {
        signal: stop.signal,
      });
    } finally {
      process.removeListener('SIGINT', interrupt);
    }
  }
  console.log(
    terminalSafeJson(result).split('\n').map(terminalSafeText).join('\n'),
  );
}
