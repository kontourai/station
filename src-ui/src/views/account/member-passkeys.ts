import { runAccountOperation } from '@kontourai/station-sdk/account-authentication';

export function passkeysSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential === 'function' &&
    !!navigator.credentials
  );
}

/**
 * One two-step ceremony: the provider mints options (and a challenge cookie),
 * the browser's authenticator answers, the provider verifies. Nothing about
 * the credential is kept in the page.
 */
export async function runPasskeyCeremony(input: {
  apiBase: string;
  path: string;
  kind: 'register' | 'authenticate';
  options?: Record<string, unknown>;
  verify?: Record<string, unknown>;
  invitation?: string;
}): Promise<void> {
  const begun = await runAccountOperation(
    input.apiBase,
    input.path,
    { step: 'options', ...input.options },
    input.invitation,
  );
  if (!begun || typeof begun !== 'object' || !('options' in begun))
    throw new Error('Station did not start the passkey request.');
  // Loaded on demand: only people who choose a passkey download it.
  const { startAuthentication, startRegistration } = await import(
    '@simplewebauthn/browser'
  );
  const response =
    input.kind === 'register'
      ? await startRegistration({ optionsJSON: begun.options as never })
      : await startAuthentication({ optionsJSON: begun.options as never });
  await runAccountOperation(
    input.apiBase,
    input.path,
    { step: 'verify', ...input.verify, response },
    input.invitation,
  );
}

const MESSAGES: Record<string, string> = {
  invitation_required:
    'This invitation is no longer open. Ask the inviter for a new link.',
  username_unavailable: 'That username is taken. Choose another.',
  passkey_rejected: 'This passkey cannot sign in to this Station.',
  reauthentication_required: 'Sign out and sign in again to add a passkey.',
  last_sign_in_method: 'Keep at least one way to sign in.',
  recovery_unavailable:
    'This recovery link has expired or was used. Ask the operator for a new one.',
  passkey_origin_unsupported:
    'Passkeys work only at this Station’s sign-in address.',
  passkey_rate_limited: 'Too many attempts. Wait a minute and try again.',
};

/** A plain sentence for a passkey failure, or undefined to use the default. */
export function passkeyFailureMessage(cause: unknown): string | undefined {
  if (cause instanceof Error) {
    if (cause.name === 'NotAllowedError' || cause.name === 'AbortError')
      return 'The passkey request was cancelled or timed out.';
    if (cause.name === 'InvalidStateError')
      return 'This device already has a passkey for this account.';
    if (cause.name === 'SecurityError')
      return 'Passkeys work only at this Station’s sign-in address.';
  }
  const code =
    cause && typeof cause === 'object' && 'code' in cause
      ? String(cause.code)
      : undefined;
  if (!code) return undefined;
  if (MESSAGES[code]) return MESSAGES[code];
  if (code.startsWith('passkey_') && code.endsWith('_refused'))
    return 'The passkey could not be saved. Nothing was changed.';
  return undefined;
}
