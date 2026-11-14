import {
  EngineStillStartingError,
  TerminalHistoryUnsupportedError,
  TerminalSessionError,
} from '@kontourai/station-sdk';
import { ChatHttpError, StationHttpError } from '@kontourai/station-sdk/client';
import { describe, expect, it } from 'vitest';
import type { StationConnection } from '../../connections/station-connection';
import { StationUiError } from '../StationUiError';
import { describeStationFailure } from '../stationFailure';

const connection = (
  routeKind: StationConnection['routeKind'],
  current = true,
) => ({
  stationName: 'Receiver',
  environmentId: 'receiver',
  routeKind,
  isCurrent: () => current,
});
const refusal = (remoteStatus: 401 | 403 | 409, overrides = {}) =>
  new ChatHttpError(
    new StationHttpError(424, 'insufficient_scope secret_machine_code', {
      code: 'peer_chat_target_refused',
      details: {
        version: 1,
        failureAuthority: 'target',
        environmentId: 'receiver',
        remoteStatus,
        disposition: 'refused-before-dispatch',
        mutationKey: 'original',
        ...(remoteStatus === 409 ? { refusalCode: 'inbox_stale_head' } : {}),
        ...overrides,
      },
    }),
    true,
  );

describe('Station authority failure translation', () => {
  it('keeps curated application copy without accepting lookalike diagnostic fields', () => {
    const local = new StationUiError(
      'Choose another folder before continuing.',
    );
    local.message = 'raw_machine_code';
    const result = describeStationFailure(local);
    expect(result.body).toBe('Choose another folder before continuing.');
    expect(result.delivery).toBe('uncertain');
    const forged = Object.assign(new Error('raw_machine_code'), {
      userMessage: 'raw_machine_code',
    });
    expect(describeStationFailure(forged).body).not.toContain(
      'raw_machine_code',
    );
  });
  it('reconstructs typed engine-start and unsupported-history guidance without the diagnostic message', () => {
    const starting = new EngineStillStartingError('Kiro CLI');
    starting.message = 'raw_machine_code';
    expect(describeStationFailure(starting).body).toContain(
      'Kiro CLI is still starting for the first time.',
    );
    const unsupported = new TerminalHistoryUnsupportedError();
    unsupported.message = 'raw_machine_code';
    expect(describeStationFailure(unsupported).body).toBe(
      'This Station does not report terminal history.',
    );
    expect(describeStationFailure(unsupported).delivery).toBe('uncertain');
  });
  it.each([
    'This Station cannot be forgotten here.',
    "This app's own Station cannot be forgotten.",
    'Learning review is unsupported on this host. Enable its Feature Preview or update this Station.',
  ])('retains exact safe local guidance: %s', (copy) => {
    const failure = describeStationFailure(new Error(copy));
    expect(failure.body).toBe(copy);
    expect(failure.retryable).toBe(false);
    expect(failure.delivery).toBe('uncertain');
    expect(
      describeStationFailure(new Error(`${copy} raw_machine_code`)).body,
    ).not.toContain('raw_machine_code');
  });
  it.each([
    ['raw-egress-unavailable', 'direct Station connection'],
    ['credential-unavailable', 'Reconnect to this Station'],
    ['unsupported-host', 'Update the host'],
    ['refused', 'Terminal access was refused.'],
  ] as const)('keeps safe terminal guidance for %s', (code, copy) => {
    const result = describeStationFailure(
      new TerminalSessionError(code, 'raw_credential_machine_diagnostic'),
    );
    expect(result.body).toContain(copy);
    expect(result.body).not.toContain('raw_credential_machine_diagnostic');
    expect(result.delivery).toBe('uncertain');
  });
  it('does not mistake a credential-management read failure for model authentication', () => {
    expect(
      describeStationFailure(new Error('credential recovery unavailable')).body,
    ).toBe('Try again in a moment.');
  });
  it('keeps approval recovery uncertain and blocks blind retry', () => {
    expect(
      describeStationFailure(
        Object.assign(new Error('raw approval diagnostic'), {
          code: 'approval_delivery_unconfirmed',
        }),
      ),
    ).toMatchObject({
      delivery: 'uncertain',
      recovery: 'check',
      retryable: false,
    });
  });

  it.each(['host', 'direct'] as const)(
    'translates %s authentication and authorization without provider repair guesses',
    (route) => {
      for (const status of [401, 403]) {
        const result = describeStationFailure(
          new ChatHttpError(status, 'insufficient_scope'),
          connection(route),
        );
        expect(result).toMatchObject({
          authority: 'target',
          delivery: 'refused',
          retryable: false,
        });
        expect(result.body).toContain('Receiver');
        expect(JSON.stringify(result)).not.toMatch(
          /insufficient_scope|could not confirm|Model connection/,
        );
      }
    },
  );
  it.each([401, 403])(
    'keeps source %i separate from receiver credentials',
    (status) => {
      const result = describeStationFailure(
        new ChatHttpError(status, 'insufficient_scope'),
        connection('relay'),
      );
      expect(result).toMatchObject({
        authority: 'source',
        delivery: 'refused',
      });
      expect(result.body).toMatch(/source Station/);
    },
  );
  it.each([401, 403, 409] as const)(
    'accepts a bound source-authored target %i observation',
    (status) => {
      const result = describeStationFailure(
        refusal(status),
        connection('relay'),
        'original',
      );
      expect(result).toMatchObject({
        authority: 'target',
        delivery: 'refused',
      });
      expect(JSON.stringify(result)).not.toMatch(
        /insufficient_scope|secret_machine|could not confirm/,
      );
    },
  );
  it.each([
    { environmentId: 'other' },
    { mutationKey: 'another' },
    { disposition: 'unknown' },
    { version: 2 },
    { remoteStatus: 500 },
  ])('rejects an unbound or malformed target observation: %j', (overrides) => {
    expect(
      describeStationFailure(
        refusal(403, overrides),
        connection('relay'),
        'original',
      ).delivery,
    ).toBe('uncertain');
  });
  it('does not turn raw relayed 403 or an unmarked 424 into delivery evidence', () => {
    expect(
      describeStationFailure(
        new ChatHttpError(403, 'insufficient_scope', undefined, false),
        connection('relay'),
      ).delivery,
    ).toBe('uncertain');
    const unmarked = new ChatHttpError(
      new StationHttpError(424, 'peer_chat_target_refused', {
        code: 'peer_chat_target_refused',
        details: refusal(403).details,
      }),
      false,
    );
    expect(
      describeStationFailure(unmarked, connection('relay'), 'original')
        .delivery,
    ).toBe('uncertain');
  });
  it('fences a retired connection', () => {
    expect(
      describeStationFailure(
        refusal(403),
        connection('relay', false),
        'original',
      ).delivery,
    ).toBe('uncertain');
  });
  it.each([
    new TypeError('Failed to fetch'),
    new Error('ECONNRESET internal socket'),
    new SyntaxError('Unexpected token <'),
    new Error('arbitrary_machine_code'),
    'arbitrary_machine_code',
  ])('never treats missing or malformed responses as refusal', (error) => {
    const result = describeStationFailure(error, connection('direct'));
    expect(result.delivery).toBe('uncertain');
    expect(result.recovery).toBe('check');
    expect(result.body).not.toMatch(
      /arbitrary_machine_code|ECONNRESET|Unexpected token|local model/i,
    );
  });
  it('composes typed approval repair and terminal workspace policy', () => {
    const approval = describeStationFailure(
      new ChatHttpError(
        403,
        'raw_machine_code',
        'approval-full-access-not-granted',
      ),
      connection('direct'),
    );
    expect(approval.body).toMatch(/operator/);
    expect(approval.delivery).toBe('refused');
    const terminal = describeStationFailure(
      new ChatHttpError(
        409,
        'The saved workspace was removed.',
        'continuation_workspace_worktree_gone',
      ),
      connection('direct'),
    );
    expect(terminal.terminalSession).toBe(true);
    expect(terminal.hint).toBe('Start a new chat.');
  });
});
