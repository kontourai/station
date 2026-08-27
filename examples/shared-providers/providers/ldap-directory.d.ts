/**
 * LDAP Directory Provider — user lookup via a directory service.
 */
import type { UserDetailVM } from '@kontourai/station-shared';
export default function createLdapDirectoryProvider(): {
  lookupPerson(alias: string): Promise<UserDetailVM>;
  searchPeople(query: string): Promise<UserDetailVM[]>;
};
