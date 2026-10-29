import {
  cancelCliSessionGroup,
  createCliSessionGroup,
  createEnsembleCliSessionGroup,
  getCliSessionGroup,
  listCliSessionGroups,
  parseCliSessionGroupInput,
  parseCliSessionGroupSyncInput,
  parseEnsembleCliSessionGroupInput,
  readCliSessionGroupEvents,
  runCliSessionGroup,
  subscribeCliSessionGroupEvents,
  syncCliSessionGroup,
} from '@kontourai/station-sdk/client';
import { optionalValueFlag, type ParsedCoreArgs } from './core-api.js';
import { readGroupInput } from './group-input.js';
import { runReportGroupCommand } from './report-group.js';
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
  const [action] = parsed.positionals;
  if (action?.startsWith('report-'))
    return runReportGroupCommand(apiBase, parsed);
  if (action?.startsWith('session-'))
    return runSessionGroupCommand(apiBase, parsed);

  throw new Error('Expected group session-* or report-* action.');
}

async function runSessionGroupCommand(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  const [action, groupId, ...extra] = parsed.positionals;
  const sync = action === 'session-sync';
  const fromEnsemble = action === 'session-from-ensemble';
  const create = action === 'session-create' || fromEnsemble;
  const list = action === 'session-list';
  if (
    ![
      'session-create',
      'session-from-ensemble',
      'session-list',
      'session-get',
      'session-events',
      'session-run',
      'session-cancel',
      'session-sync',
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
        ...(create || sync ? ['file'] : []),
        ...(list ? ['after-group'] : []),
        ...(action === 'session-events' ? ['after-revision', 'follow'] : []),
      ].includes(flag) ||
      (parsed.repeatedFlags[flag]?.length ?? 0) > 1
    )
      throw new Error(`Unsupported or repeated session-group flag --${flag}.`);
  }
  let result: unknown;
  if (action === 'session-events' && parsed.flags.follow !== undefined) {
    if (parsed.flags.follow !== true)
      throw new Error('--follow is a boolean option.');
    const stop = new AbortController();
    const interrupt = () => stop.abort();
    process.once('SIGINT', interrupt);
    let failure: unknown;
    try {
      const stream = subscribeCliSessionGroupEvents(
        apiBase,
        groupId!,
        cursor(parsed, 'after-revision') ?? 0,
        {
          onPage(page) {
            console.log(
              terminalSafeJson(page)
                .split('\n')
                .map(terminalSafeText)
                .join('\n'),
            );
          },
          onTerminal(error) {
            failure = error;
          },
        },
        { signal: stop.signal },
      );
      await stream.completed;
      if (failure) throw failure;
    } finally {
      stop.abort();
      process.removeListener('SIGINT', interrupt);
    }
    return;
  }
  if (create || sync) {
    const input = readGroupInput(required(parsed, 'file'), 'Session group');
    if (sync) {
      const stop = new AbortController();
      const interrupt = () => stop.abort();
      process.once('SIGINT', interrupt);
      try {
        result = await syncCliSessionGroup(
          apiBase,
          groupId!,
          parseCliSessionGroupSyncInput(input),
          { signal: stop.signal },
        );
      } finally {
        process.removeListener('SIGINT', interrupt);
      }
    } else {
      result = fromEnsemble
        ? await createEnsembleCliSessionGroup(
            apiBase,
            parseEnsembleCliSessionGroupInput(input),
          )
        : await createCliSessionGroup(
            apiBase,
            parseCliSessionGroupInput(input),
          );
    }
  } else if (list)
    result = await listCliSessionGroups(apiBase, {
      afterGroupId: optionalValueFlag(parsed, 'after-group'),
    });
  else if (action === 'session-events')
    result = await readCliSessionGroupEvents(
      apiBase,
      groupId!,
      cursor(parsed, 'after-revision') ?? 0,
    );
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
