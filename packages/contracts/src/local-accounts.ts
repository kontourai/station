/** Operator-only account projection. No password, session token or device credential. */
export interface LocalAccountView {
  accountId: string;
  name: string;
  email?: string;
  username?: string;
  emailVerified: boolean;
  disabled: boolean;
}
export type LocalAccountAdministrationView =
  | { kind: 'local'; accounts: readonly LocalAccountView[] }
  | { kind: 'external'; provider: string }
  | { kind: 'none' };
export type LocalAccountAction =
  | 'disable'
  | 'enable'
  | 'revoke-sessions'
  | 'create-recovery';
export type LocalAccountActionResult =
  | { changed: true }
  | { recoveryUrl: string };
