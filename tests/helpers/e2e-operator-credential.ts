import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const OPERATOR_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function requireE2EOperatorCredential(credential: unknown): string {
  if (
    typeof credential !== 'string' ||
    !OPERATOR_CREDENTIAL_PATTERN.test(credential) ||
    Buffer.from(credential, 'base64url').byteLength !== 32
  ) {
    throw new Error('E2E operator credential is missing or malformed');
  }
  return credential;
}

export function e2eOperatorAuthorizationHeaders(credential: unknown) {
  return {
    Authorization: `Bearer ${requireE2EOperatorCredential(credential)}`,
  };
}

export function requireE2EBrowserSessionCredential(
  credential: unknown,
): string {
  try {
    return requireE2EOperatorCredential(credential);
  } catch (error) {
    throw new Error('E2E browser session credential is missing or malformed', {
      cause: error,
    });
  }
}

export function readE2EOperatorCredential(home: string): string {
  let record: unknown;
  try {
    record = JSON.parse(
      readFileSync(join(home, 'security', 'environment.json'), 'utf8'),
    );
  } catch (error) {
    throw new Error(
      `Station security record under ${home} did not publish a valid operator credential`,
      { cause: error },
    );
  }
  try {
    return requireE2EOperatorCredential(
      (record as { credential?: unknown }).credential,
    );
  } catch (error) {
    throw new Error(
      `Station security record under ${home} did not publish a valid operator credential`,
      { cause: error },
    );
  }
}
