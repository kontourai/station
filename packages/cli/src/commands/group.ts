import {
  cancelDelegationGroup,
  createDelegationGroup,
  getDelegationGroup,
  launchDelegationGroup,
  listDelegationGroups,
  readDelegationGroupEvents,
  readDelegationGroupMemberEvents,
  readDelegationGroupMemberOutput,
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
