import { ActionOperationProtocolError } from '@kontourai/station-sdk/action-operations';
import {
  AnswerSupportRequestError,
  DelegationApiError,
  StationHttpError,
} from '@kontourai/station-sdk/client';
import { describe, expect, test } from 'vitest';
import { userFacingErrorMessage } from '../errorText';

/**
 * #2708: a thrown StationHttpError carries a field-qualified message for CLI
 * and agent readers. The UI reads the server's reasons from `details` instead,
 * so a schema key such as `secretEnvKey` never becomes copy.
 */
describe('userFacingErrorMessage', () => {
  const refusal = new StationHttpError(
    400,
    'Validation failed: command Required, secretEnvKey Required',
    {
      code: 'validation_failed',
      details: {
        formErrors: ['Choose an environment name.'],
        fieldErrors: { command: ['Required'], secretEnvKey: ['Required'] },
      },
    },
  );

  test('reads the reasons from details: no prefix, no keys, each said once', () => {
    const text = userFacingErrorMessage(refusal);
    expect(text).toBe('Choose an environment name. Required');
    expect(text).not.toContain('secretEnvKey');
    expect(text).not.toContain('Validation failed');
  });

  test('keeps the message when details carry no reasons', () => {
    expect(
      userFacingErrorMessage(
        new StationHttpError(409, 'Binding revision changed', {
          details: { current: 4 },
        }),
      ),
    ).toBe('Binding revision changed');
    expect(userFacingErrorMessage(new StationHttpError(502))).toBe('HTTP 502');
  });

  // #2708 A-3b: the SDK's family errors that extend Error carry the same
  // details, and read the same way.
  test.each([
    ['DelegationApiError', () => new DelegationApiError(refusal)],
    ['AnswerSupportRequestError', () => new AnswerSupportRequestError(refusal)],
    [
      'ActionOperationProtocolError',
      () => new ActionOperationProtocolError(refusal),
    ],
  ])('%s reads its reasons from details too', (_name, make) => {
    const error = make();
    expect(error.message).toContain('secretEnvKey');
    expect(userFacingErrorMessage(error)).toBe(
      'Choose an environment name. Required',
    );
  });

  test('any other error reads as its message, and a non-error as the shared fallback', () => {
    expect(userFacingErrorMessage(new Error('Read-only skill'))).toBe(
      'Read-only skill',
    );
    expect(userFacingErrorMessage('nope')).toBe('Something went wrong.');
  });
});
