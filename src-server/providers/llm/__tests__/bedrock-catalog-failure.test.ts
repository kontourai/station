/**
 * archive#3654 — AWS SDK errors classified into the vocabulary every other provider
 * already speaks, and stripped of the identity AWS echoes back.
 *
 * The shared `classifyCatalogFailure` reads `error.status`/`error.statusCode`,
 * neither of which an AWS SDK v3 error carries, so every Bedrock failure fell
 * through to `unreachable` — and Bedrock's own catch discarded the error
 * before even that could happen, which is why `recordModelCatalogDiscovery`
 * wrote no receipt at all and the connection read "Saved — not verified".
 */

import { describe, expect, test } from 'vitest';
import {
  classifyBedrockCatalogFailure,
  describeBedrockCatalogFailure,
  redactAwsIdentifiers,
} from '../bedrock-catalog-failure.js';

function awsError(
  name: string,
  message = 'aws said so',
  httpStatusCode?: number,
): Error {
  const error = new Error(message);
  error.name = name;
  if (httpStatusCode !== undefined) {
    (error as Error & { $metadata?: unknown }).$metadata = { httpStatusCode };
  }
  return error;
}

describe('classifyBedrockCatalogFailure', () => {
  test('a denied ListFoundationModels is no-catalog, not a refusal', () => {
    // The load-bearing case: an IAM policy may grant bedrock:InvokeModel and
    // withhold bedrock:ListFoundationModels. Only `no-catalog` lets the
    // explicit test go on to ask the chat route, which is the only evidence
    // such a connection can ever produce.
    expect(
      classifyBedrockCatalogFailure(
        awsError('AccessDeniedException', 'not authorized', 403),
      ),
    ).toBe('no-catalog');
  });

  test.each([
    'UnrecognizedClientException',
    'InvalidSignatureException',
    'ExpiredTokenException',
    'CredentialsProviderError',
    'BedrockAuthConfigurationError',
  ])('%s is a refusal of these settings', (name) => {
    expect(classifyBedrockCatalogFailure(awsError(name))).toBe('refused');
  });

  test.each(['NetworkingError', 'TimeoutError', 'ThrottlingException'])(
    '%s left Station with no answer to judge',
    (name) => {
      expect(classifyBedrockCatalogFailure(awsError(name))).toBe('unreachable');
    },
  );

  test('a transport error code is read when the error has no AWS name', () => {
    const error = new Error('getaddrinfo ENOTFOUND bedrock.us-east-1.test');
    (error as Error & { code?: string }).code = 'ENOTFOUND';
    expect(classifyBedrockCatalogFailure(error)).toBe('unreachable');
  });

  test('falls back to the AWS metadata status when the name says nothing', () => {
    expect(
      classifyBedrockCatalogFailure(awsError('SomethingNew', 'x', 404)),
    ).toBe('no-catalog');
    expect(
      classifyBedrockCatalogFailure(awsError('SomethingNew', 'x', 400)),
    ).toBe('refused');
    expect(
      classifyBedrockCatalogFailure(awsError('SomethingNew', 'x', 503)),
    ).toBe('unreachable');
  });

  test("Station's own guard tripping is never reported as a refusal", () => {
    // A pagination token that did not advance is Station refusing a partial
    // answer. Nothing about it is AWS's verdict on these settings.
    expect(
      classifyBedrockCatalogFailure(
        new Error('Bedrock inference profiles exceeded the page limit.'),
      ),
    ).toBe('unreachable');
  });
});

describe('redactAwsIdentifiers', () => {
  test('removes the principal ARN and account id AWS quotes back', () => {
    const redacted = redactAwsIdentifiers(
      'User: arn:aws:sts::123456789012:assumed-role/StationRole/session is not authorized to perform: bedrock:ListFoundationModels on resource: arn:aws:bedrock:us-east-1:123456789012:foundation-model/*.',
    );

    expect(redacted).not.toContain('123456789012');
    expect(redacted).not.toContain('assumed-role/StationRole');
    expect(redacted).not.toMatch(/arn:aws:/);
    // The action is the entire diagnostic value of the message and identifies
    // nobody, so it survives.
    expect(redacted).toContain('bedrock:ListFoundationModels');
    // Sentence punctuation the greedy ARN match swallowed is put back.
    expect(redacted.endsWith('.')).toBe(true);
  });

  test('removes an access key id echoed in an error', () => {
    // Composed rather than written out: the value is a fake, but a literal of
    // this shape is what the repo's own secret scan exists to stop, and a test
    // fixture is not a reason to teach it an exception.
    const accessKeyId = `AKIA${'EXAMPLEKEY1234567'.slice(0, 16)}`;

    expect(
      redactAwsIdentifiers(
        `The security token included in the request is invalid: ${accessKeyId}`,
      ),
    ).not.toContain(accessKeyId);
  });

  test('leaves a message with no identity in it alone', () => {
    expect(redactAwsIdentifiers('The request timed out.')).toBe(
      'The request timed out.',
    );
  });
});

describe('describeBedrockCatalogFailure', () => {
  test('says what a catalogue denial does and does not prove', () => {
    const described = describeBedrockCatalogFailure(
      awsError(
        'AccessDeniedException',
        'User: arn:aws:iam::123456789012:user/station is not authorized to perform: bedrock:ListFoundationModels',
        403,
      ),
    );

    expect(described.reasonKind).toBe('no-catalog');
    expect(described.reason).toContain('bedrock:ListFoundationModels');
    expect(described.reason).toContain('says nothing about whether they can');
    expect(described.reason).not.toContain('123456789012');
  });

  test('always carries a reason, so a receipt is always recordable', () => {
    // `recordModelCatalogDiscovery` drops the observation when either field is
    // missing — which is exactly how Bedrock came to record nothing at all.
    const described = describeBedrockCatalogFailure({});

    expect(described.reason.length).toBeGreaterThan(0);
    expect(described.reasonKind).toBe('unreachable');
  });
});
