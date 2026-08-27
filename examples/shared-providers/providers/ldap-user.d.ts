/**
 * LDAP User Identity Provider — enriches user identity via directory lookup.
 */
import type { UserIdentity } from '@kontourai/station-shared';
export default function createLdapUserProvider(): {
  getIdentity(): Promise<UserIdentity>;
  enrichIdentity(user: UserIdentity): Promise<UserIdentity>;
};
