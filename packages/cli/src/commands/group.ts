import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  cancelCliSessionGroup,
  cancelDelegationGroup,
  createCliSessionGroup,
  createDelegationGroup,
  createEnsembleCliSessionGroup,
  getCliSessionGroup,
  getDelegationGroup,
  launchDelegationGroup,
  listCliSessionGroups,
  listDelegationGroups,
  parseCliSessionGroupInput,
  parseEnsembleCliSessionGroupInput,
  readDelegationGroupEvents,
  readDelegationGroupMemberEvents,
  readDelegationGroupMemberOutput,
  runCliSessionGroup,
  subscribeDelegationGroupEvents,
  subscribeDelegationGroupMemberEvents,
} from '@kontourai/station-sdk/client';
import { optionalValueFlag, type ParsedCoreArgs } from './core-api.js';
import { terminalSafeJson, terminalSafeText } from './terminal-safe.js';

function cursor(parsed: ParsedCoreArgs, key: string): number | undefined {
  const value = optionalValueFlag(parsed, key);
  if (value === undefined) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error(`--${key} must be a nonnegative safe integer.`);
  return Number(value);
}

function required(parsed: ParsedCoreArgs, key: string): string {
  const value = optionalValueFlag(parsed, key);
  if (!value) throw new Error(`--${key}=<value> is required.`);
  return value;
}

export async function runGroupCommand(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  const [action, groupId, seatId, ...extra] = parsed.positionals;
  if (action?.startsWith('session-'))
    return runSessionGroupCommand(apiBase, parsed);

  const common = new Set(['json', 'api-base', 'station', 'credential']);
  const actionFlags: Record<string, string[]> = {
    create: ['preparation', 'operation'],
    get: [],
    list: ['after-group'],
    events: ['after-revision', 'follow'],
    cancel: ['operation', 'revision'],
    run: ['operation', 'revision'],
    'member-events': ['after-sequence', 'follow'],
    'member-output': [],
  };
  const allowed = actionFlags[action ?? ''];
  if (!allowed)
    throw new Error(
      'Expected group create|get|list|events|cancel|run|member-events|member-output.',
    );
  for (const flag of Object.keys(parsed.flags)) {
    if (!common.has(flag) && !allowed.includes(flag))
      throw new Error(`Unsupported group flag --${flag}.`);
    if ((parsed.repeatedFlags[flag]?.length ?? 0) > 1)
      throw new Error(`Repeated group flag --${flag}.`);
  }
  const member = action === 'member-events' || action === 'member-output';
  const noGroup = action === 'create' || action === 'list';
  if (
    extra.length ||
    (noGroup ? groupId !== undefined : !groupId) ||
    (member ? !seatId : seatId !== undefined)
  )
    throw new Error('Unexpected or missing group arguments.');
  if (parsed.flags.follow !== undefined) {
    if (parsed.flags.follow !== true || !groupId)
      throw new Error('--follow is a boolean event-stream option.');
    const stop = new AbortController();
    const cancel = () => stop.abort();
    process.once('SIGINT', cancel);
    let failure: unknown;
    const callbacks = {
      onPage(page: unknown) {
        console.log(
          terminalSafeJson(page).split('\n').map(terminalSafeText).join('\n'),
        );
      },
      onTerminal(error: unknown) {
        failure = error;
        stop.abort();
      },
    };
    try {
      const stream =
        action === 'events'
          ? subscribeDelegationGroupEvents(
              apiBase,
              groupId,
              cursor(parsed, 'after-revision') ?? 0,
              callbacks,
              { signal: stop.signal },
            )
          : subscribeDelegationGroupMemberEvents(
              apiBase,
              groupId,
              requiredSeat(seatId),
              cursor(parsed, 'after-sequence') ?? 0,
              callbacks,
              { signal: stop.signal },
            );
      await stream.completed;
      if (failure !== undefined) throw failure;
    } finally {
      stop.abort();
      process.removeListener('SIGINT', cancel);
    }
    return;
  }
  let result: unknown;
  if (action === 'create')
    result = await createDelegationGroup(apiBase, {
      preparationId: required(parsed, 'preparation'),
      operationId: required(parsed, 'operation'),
    });
  else if (action === 'list')
    result = await listDelegationGroups(apiBase, {
      afterGroupId: optionalValueFlag(parsed, 'after-group'),
    });
  else if (groupId !== undefined) {
    if (action === 'get') result = await getDelegationGroup(apiBase, groupId);
    else if (action === 'events')
      result = await readDelegationGroupEvents(apiBase, groupId, {
        afterRevision: cursor(parsed, 'after-revision'),
      });
    else if (action === 'cancel' || action === 'run') {
      const expectedRevision = cursor(parsed, 'revision');
      if (expectedRevision === undefined)
        throw new Error('--revision=<number> is required.');
      const input = {
        operationId: required(parsed, 'operation'),
        expectedRevision,
      };
      result =
        action === 'cancel'
          ? await cancelDelegationGroup(apiBase, groupId, input)
          : await launchDelegationGroup(apiBase, groupId, input);
    } else if (seatId !== undefined) {
      result =
        action === 'member-events'
          ? await readDelegationGroupMemberEvents(apiBase, groupId, seatId, {
              afterSequence: cursor(parsed, 'after-sequence'),
            })
          : await readDelegationGroupMemberOutput(apiBase, groupId, seatId);
    }
  }
  console.log(
    terminalSafeJson(result).split('\n').map(terminalSafeText).join('\n'),
  );
}

function requiredSeat(seatId: string | undefined): string {
  if (!seatId) throw new Error('Member events require a seat ID.');
  return seatId;
}

async function runSessionGroupCommand(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  const [action, groupId, ...extra] = parsed.positionals;
  const fromEnsemble = action === 'session-from-ensemble';
  const create = action === 'session-create' || fromEnsemble;
  const list = action === 'session-list';
  if (
    ![
      'session-create',
      'session-from-ensemble',
      'session-list',
      'session-get',
      'session-run',
      'session-cancel',
    ].includes(action ?? '') ||
    extra.length ||
    (create || list ? groupId !== undefined : !groupId)
  )
    throw new Error(
      'Expected group session-create --file=<path> or session-get|session-run|session-cancel <group>.',
    );
  for (const flag of Object.keys(parsed.flags)) {
    if (
      ![
        'json',
        'api-base',
        'station',
        'credential',
        ...(create ? ['file'] : []),
        ...(list ? ['after-group'] : []),
      ].includes(flag) ||
      (parsed.repeatedFlags[flag]?.length ?? 0) > 1
    )
      throw new Error(`Unsupported or repeated session-group flag --${flag}.`);
  }
  let result: unknown;
  if (create) {
    const descriptor = openSync(
      resolve(required(parsed, 'file')),
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
    result = fromEnsemble
      ? await createEnsembleCliSessionGroup(
          apiBase,
          parseEnsembleCliSessionGroupInput(input),
        )
      : await createCliSessionGroup(apiBase, parseCliSessionGroupInput(input));
  } else if (list)
    result = await listCliSessionGroups(apiBase, {
      afterGroupId: optionalValueFlag(parsed, 'after-group'),
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
