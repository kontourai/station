import type { WorkspaceHomeProjectionField } from '@kontourai/station-contracts/workspace-home-role';
import type { HomeWorkItem } from './home-view-model';

/**
 * The derivation coupling behind the Home role consent page (archive#3122
 *).
 *
 * The canonical projection record — field names AND user-readable claims —
 * lives in `@kontourai/station-contracts/workspace-home-role`
 * (`WORKSPACE_HOME_PROJECTION_FIELD_DESCRIPTIONS`), because the server
 * stamps its field list onto every grant and the future distinct-origin
 * consent surface will render it (as what the BUILT-IN Home shows — see
 * that record's docblock). Contracts cannot see this package's `HomeWorkItem` view-model
 * type, so THIS file is where the record is held to the type, in both
 * directions, at compile time:
 *
 * - {@link _EveryHomeWorkItemFieldIsDescribed}: adding a field to
 *   `HomeWorkItem` fails typecheck here until the contracts record names it
 * and that same change widens the stored field list, which invalidates
 *   existing grants (`workspaceHomeRoleGrantCoversProjection`). "A widened
 *   projection is a new grant" stays mechanical.
 * - {@link _NoDescribedFieldIsMissingFromHomeWorkItem}: the record cannot
 *   claim a field Home does not actually carry — the consent page cannot
 *   over-claim.
 */
type AssertEmpty<T extends never> = T;

export type _EveryHomeWorkItemFieldIsDescribed = AssertEmpty<
  Exclude<keyof HomeWorkItem, WorkspaceHomeProjectionField>
>;

export type _NoDescribedFieldIsMissingFromHomeWorkItem = AssertEmpty<
  Exclude<WorkspaceHomeProjectionField, keyof HomeWorkItem>
>;

export {
  describeWorkspaceHomeProjection,
  describeWorkspaceHomeProjectionField,
  WORKSPACE_HOME_PROJECTION_FIELD_DESCRIPTIONS,
  WORKSPACE_HOME_PROJECTION_FIELDS,
} from '@kontourai/station-contracts/workspace-home-role';
