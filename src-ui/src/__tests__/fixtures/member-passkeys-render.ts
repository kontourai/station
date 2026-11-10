import {
  DEPLOYMENT_AUTHENTICATION_VERSION,
  type DeploymentAuthenticationDescriptor,
} from '@kontourai/station-contracts/deployment-authentication';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import type { AccountSessionView } from '@kontourai/station-sdk/account-authentication';

export const accountDescriptor = {
  version: DEPLOYMENT_AUTHENTICATION_VERSION,
  issuer: 'station:passkey-render',
  displayName: 'Passkey fixture Station',
  sessionCookies: ['account_session'],
  login: { kind: 'username-password', signInPath: '/sign-in/username' },
  endpoints: [
    { path: '/sign-in/username', methods: ['POST'], operation: 'begin-login' },
    { path: '/sign-out', methods: ['POST'], operation: 'logout' },
    { path: '/passkey/list', methods: ['POST'], operation: 'passkey-list' },
    { path: '/passkey/remove', methods: ['POST'], operation: 'passkey-remove' },
  ],
} satisfies DeploymentAuthenticationDescriptor;

export const accountSession = {
  principal: humanPrincipal('deployment', 'passkey-render', 'Casey'),
  issuer: accountDescriptor.issuer,
  expiresAt: '2099-01-01T00:00:00.000Z',
  contacts: [],
} satisfies AccountSessionView;

export interface RenderPasskey {
  id: string;
  name: string;
  createdAt: string;
  synced: boolean;
}

export function initialPasskeys(): RenderPasskey[] {
  return ['A', 'B', 'C'].map((id) => ({
    id,
    name: `Laptop ${id}`,
    createdAt: '2026-10-01T00:00:00.000Z',
    synced: false,
  }));
}

export interface AccountReply<T> {
  data: T;
}
export interface PasskeyListReply {
  passkeys: RenderPasskey[];
}
export interface RemovePasskeyRequest {
  id: string;
}
export const removalSuccess = {
  data: { success: true },
} satisfies AccountReply<{
  success: boolean;
}>;
export const removalRefusal = {
  error: {
    code: 'account_operation_unavailable',
    message: 'Passkey removal unavailable.',
  },
};
