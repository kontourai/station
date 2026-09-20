import type { MemberProjectView } from '@kontourai/station-contracts/project';
import { PROJECT_MEMBER_ACTIONS } from '@kontourai/station-contracts/project-membership';

const KEYS = new Set([
  'version',
  'kind',
  'id',
  'slug',
  'name',
  'icon',
  'description',
  'actions',
]);

export function parseMemberProjectView(value: unknown): MemberProjectView {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(
      'This Station returned an unsupported member Project view.',
    );
  const view = value as Record<string, unknown>;
  const valid =
    Object.keys(view).every((key) => KEYS.has(key)) &&
    view.version === 'station.member-project/v1' &&
    view.kind === 'member-project' &&
    typeof view.id === 'string' &&
    typeof view.slug === 'string' &&
    typeof view.name === 'string' &&
    (view.icon === undefined || typeof view.icon === 'string') &&
    (view.description === undefined || typeof view.description === 'string') &&
    Array.isArray(view.actions) &&
    view.actions.every(
      (action) =>
        typeof action === 'string' &&
        (PROJECT_MEMBER_ACTIONS as readonly string[]).includes(action),
    );
  if (!valid)
    throw new Error(
      'This Station returned an unsupported member Project view.',
    );
  return value as MemberProjectView;
}
