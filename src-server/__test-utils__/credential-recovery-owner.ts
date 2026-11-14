import { CredentialProfileRecovery } from '../services/orchestration/credential-profile-recovery.js';

/** Read the actual constructed collaborator without retaining a production test forwarder. */
export function credentialRecoveryOwner(
  service: object,
): CredentialProfileRecovery {
  const owner: unknown = Reflect.get(service, 'credentialProfileRecovery');
  if (!(owner instanceof CredentialProfileRecovery))
    throw new Error('The service has no credential recovery owner.');
  return owner;
}
