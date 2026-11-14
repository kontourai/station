import { REPORT_GROUP_CONTEXT_LIMITS } from '@kontourai/station-contracts/report-group';
import {
  cancelReportGroup,
  continueReportGroupReport,
  createReportGroup,
  finalizeReportGroupCancel,
  finalizeReportGroupSync,
  getClientRequestTimeout,
  getReportGroup,
  listReportGroups,
  narrowReportGroupAfterInput,
  parseReportGroupContextSyncInput,
  parseReportGroupInput,
  readReportGroupEvents,
  readReportGroupResult,
  recoverReportGroupAccounting,
  subscribeReportGroupEvents,
  syncReportGroupAfterInput,
  syncReportGroupContext,
} from '@kontourai/station-sdk/client';
import { optionalValueFlag, type ParsedCoreArgs } from './core-api.js';
import { readGroupInput } from './group-input.js';
import { terminalSafeJson, terminalSafeText } from './terminal-safe.js';

const actions: Record<string, string[]> = {
  'report-recover': ['operation'],
  'report-create': ['file'],
  'report-continue': [
    'operation',
    'revision',
    'seat',
    'flow-head',
    'sync-operation',
    'previous-invocation',
    'retry-ref',
  ],
  'report-sync': ['file'],
  'report-narrow-input': ['operation', 'revision', 'seat'],
  'report-sync-input': [
    'operation',
    'revision',
    'seat',
    'flow-head',
    'renewal-operation',
  ],
  'report-finalize-sync': [
    'operation',
    'revision',
    'sync-operation',
    'prepared-digest',
  ],
  'report-list': ['after-group'],
  'report-get': [],
  'report-events': ['after-revision', 'follow'],
  'report-result': ['after-offset'],
  'report-cancel': ['operation', 'revision'],
  'report-finalize-cancel': ['operation', 'revision', 'cancel-operation'],
};
function required(parsed: ParsedCoreArgs, key: string) {
  const value = optionalValueFlag(parsed, key);
  if (!value) throw new Error(`--${key}=<value> is required.`);
  return value;
}
function number(parsed: ParsedCoreArgs, key: string) {
  const value = optionalValueFlag(parsed, key);
  if (value === undefined) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error(`--${key} must be a nonnegative safe integer.`);
  return Number(value);
}
function print(value: unknown) {
  console.log(
    terminalSafeJson(value).split('\n').map(terminalSafeText).join('\n'),
  );
}
export async function runReportGroupCommand(
  apiBase: string,
  parsed: ParsedCoreArgs,
) {
  const [action, groupId, seatId, invocationId, ...extra] = parsed.positionals;
  const allowed = actions[action ?? ''];
  const noGroup = action === 'report-create' || action === 'report-list';
  const member = action === 'report-result' || action === 'report-recover';
  if (
    !allowed ||
    extra.length ||
    (noGroup ? groupId !== undefined : !groupId) ||
    (member
      ? !seatId || !invocationId
      : seatId !== undefined || invocationId !== undefined)
  )
    throw new Error(
      'Expected group report-create|report-list|report-get|report-events|report-result|report-recover|report-cancel|report-finalize-cancel|report-sync|report-finalize-sync|report-narrow-input|report-sync-input|report-continue with its required arguments.',
    );
  for (const flag of Object.keys(parsed.flags)) {
    if (
      (!['json', 'api-base', 'station', 'credential'].includes(flag) &&
        !allowed.includes(flag)) ||
      (parsed.repeatedFlags[flag]?.length ?? 0) > 1
    )
      throw new Error(`Unsupported or repeated report-group flag --${flag}.`);
  }
  if (parsed.flags.follow !== undefined && parsed.flags.follow !== true)
    throw new Error('--follow is a boolean option.');
  const afterRevision = number(parsed, 'after-revision') ?? 0;
  const afterOffset = number(parsed, 'after-offset') ?? 0;
  const revision = number(parsed, 'revision');
  const isCancellation =
    action === 'report-cancel' || action === 'report-finalize-cancel';
  const isSync = action === 'report-sync' || action === 'report-finalize-sync';
  const isFinalizeSync = action === 'report-finalize-sync';
  const isNarrow = action === 'report-narrow-input';
  const isInputSync = action === 'report-sync-input';
  const isContinue = action === 'report-continue';
  const isRecovery = action === 'report-recover';
  const operation =
    isCancellation ||
    isFinalizeSync ||
    isNarrow ||
    isInputSync ||
    isContinue ||
    isRecovery
      ? required(parsed, 'operation')
      : undefined;
  const cancelOperation =
    action === 'report-finalize-cancel'
      ? required(parsed, 'cancel-operation')
      : undefined;
  if (
    (isCancellation ||
      isFinalizeSync ||
      isNarrow ||
      isInputSync ||
      isContinue) &&
    revision === undefined
  )
    throw new Error('--revision=<number> is required.');
  const input =
    action === 'report-create'
      ? parseReportGroupInput(
          readGroupInput(required(parsed, 'file'), 'Report group'),
        )
      : undefined;
  const contextSync =
    action === 'report-sync'
      ? parseReportGroupContextSyncInput(
          readGroupInput(
            required(parsed, 'file'),
            'Report context',
            REPORT_GROUP_CONTEXT_LIMITS.requestBytes,
          ),
        )
      : undefined;
  const finalizeSync = isFinalizeSync
    ? {
        operationKey: operation!,
        expectedRevision: revision!,
        syncOperationKey: required(parsed, 'sync-operation'),
        preparedDigest: required(parsed, 'prepared-digest'),
      }
    : undefined;
  const stop = new AbortController();
  const interrupt = () => stop.abort();
  process.once('SIGINT', interrupt);
  try {
    const finiteRead =
      action !== 'report-create' &&
      !isCancellation &&
      !isSync &&
      !isNarrow &&
      !isInputSync &&
      !isContinue &&
      !isRecovery &&
      !(action === 'report-events' && parsed.flags.follow === true);
    const options = {
      signal: stop.signal,
      ...(finiteRead ? { timeoutMs: getClientRequestTimeout() ?? null } : {}),
    };
    if (action === 'report-events' && parsed.flags.follow === true) {
      let failure: unknown;
      const stream = subscribeReportGroupEvents(
        apiBase,
        groupId!,
        afterRevision,
        {
          onPage: print,
          onTerminal: (error) => {
            failure = error;
          },
        },
        options,
      );
      try {
        await stream.completed;
        if (failure !== undefined) throw failure;
      } finally {
        stream.close();
      }
      return;
    }
    if (action === 'report-create')
      print(await createReportGroup(apiBase, input!, options));
    else if (isRecovery)
      print(
        await recoverReportGroupAccounting(
          apiBase,
          groupId!,
          {
            seatId: seatId!,
            invocationId: invocationId!,
            operationKey: operation!,
          },
          options,
        ),
      );
    else if (isNarrow)
      print(
        await narrowReportGroupAfterInput(
          apiBase,
          groupId!,
          {
            operationKey: operation!,
            expectedRevision: revision!,
            seatId: required(parsed, 'seat'),
          },
          options,
        ),
      );
    else if (isContinue)
      print(
        await continueReportGroupReport(
          apiBase,
          groupId!,
          {
            operationKey: operation!,
            expectedRevision: revision!,
            seatId: required(parsed, 'seat'),
            flowHead: required(parsed, 'flow-head'),
            syncOperationKey: required(parsed, 'sync-operation'),
            previousInvocationId: required(parsed, 'previous-invocation'),
            retryRef: required(parsed, 'retry-ref'),
          },
          options,
        ),
      );
    else if (isInputSync)
      print(
        await syncReportGroupAfterInput(
          apiBase,
          groupId!,
          {
            operationKey: operation!,
            expectedRevision: revision!,
            seatId: required(parsed, 'seat'),
            flowHead: required(parsed, 'flow-head'),
            renewalOperationKey: required(parsed, 'renewal-operation'),
          },
          options,
        ),
      );
    else if (action === 'report-sync')
      print(
        await syncReportGroupContext(apiBase, groupId!, contextSync!, options),
      );
    else if (action === 'report-finalize-sync')
      print(
        await finalizeReportGroupSync(
          apiBase,
          groupId!,
          finalizeSync!,
          options,
        ),
      );
    else if (action === 'report-list')
      print(
        await listReportGroups(
          apiBase,
          optionalValueFlag(parsed, 'after-group'),
          options,
        ),
      );
    else if (action === 'report-get')
      print(await getReportGroup(apiBase, groupId!, options));
    else if (action === 'report-events')
      print(
        await readReportGroupEvents(apiBase, groupId!, afterRevision, options),
      );
    else if (action === 'report-result')
      print(
        await readReportGroupResult(
          apiBase,
          groupId!,
          seatId!,
          invocationId!,
          afterOffset,
          options,
        ),
      );
    else if (action === 'report-finalize-cancel')
      print(
        await finalizeReportGroupCancel(
          apiBase,
          groupId!,
          {
            operationKey: operation!,
            expectedRevision: revision!,
            cancelOperationKey: cancelOperation!,
          },
          options,
        ),
      );
    else
      print(
        await cancelReportGroup(
          apiBase,
          groupId!,
          { operationKey: operation!, expectedRevision: revision! },
          options,
        ),
      );
  } finally {
    stop.abort();
    process.removeListener('SIGINT', interrupt);
  }
}
