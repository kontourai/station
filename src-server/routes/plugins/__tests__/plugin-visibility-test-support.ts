/**
 * The `visibility` composition the plugin routes require (#2067), for tests
 * whose subject is something else.
 *
 * It states the caller explicitly — the operator, over a real
 * `PluginVisibilityService` on the test's own home — rather than handing the
 * routes a permissive stub. A test that does not say who is calling would be
 * proving the route's behaviour for nobody, and the projection under test
 * elsewhere (`plugin-visibility-routes.test.ts`) depends on those two facts
 * being separable.
 */
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { PluginVisibilityService } from '../../../services/plugins/plugin-visibility-service.js';

export const TEST_OPERATOR_PRINCIPAL: PrincipalRef = {
  id: LOCAL_OPERATOR_PRINCIPAL_ID,
  kind: 'human',
  display: 'Operator',
};

export function operatorPluginVisibility(projectHomeDir: string) {
  return {
    service: new PluginVisibilityService(projectHomeDir),
    resolvePrincipal: () => TEST_OPERATOR_PRINCIPAL,
    listKnownPrincipals: () => [],
  };
}
