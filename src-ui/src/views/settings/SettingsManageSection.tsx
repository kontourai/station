import { APP_DESTINATION_REGISTRY } from '../../app-shell/destination-registry';
import { destinationIcon } from '../../components/project-sidebar/nav-items';
import { useNavigationActions } from '../../contexts/NavigationContext';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';
import './SettingsManageSection.css';

/**
 * The gear's half of #2059 (design record D3). Agents, Guidance, Connections,
 * Registry, Plugins, Schedule and Developer used to take rows in the left
 * panel beside the places; they are configuration, visited to set Station up
 * rather than to work in. They are reached from here and from the command
 * palette now.
 *
 * Review was in that list until #2065 retired `/review-queue`, and this
 * paragraph kept naming it afterwards. It is not a destination any more —
 * it is a layout kind a Project opens — so the registry carries no
 * `management` slot for it (order 50 is vacant between Registry and Plugins)
 * and this group cannot render a row for it. A comment that still advertises
 * it describes a way back that does not exist.
 *
 * These are not settings SECTIONS: each one is a destination with its own
 * route and page, so this is a navigation group, not a `?view=` deep link into
 * this page. It is therefore deliberately outside `SETTINGS_SECTIONS` and
 * outside the filter the settings search applies — a search that hid the only
 * way back to Agents would be worse than one that does not match it.
 *
 * The list, its order and its flag gating all come from the registry
 * (`management`), the same authority the panel reads for its own rows, so a
 * destination cannot be removed from the panel without landing here.
 */
export function SettingsManageSection() {
  const { navigate } = useNavigationActions();
  const destinations = APP_DESTINATION_REGISTRY.getManagement(
    // Developer advertises only while the developer-tools device setting is
    // on (archive#3313). Its route stays deep-linkable either way; this is
    // advertisement, exactly as it was in the panel.
    useSurfaceVisibilityFlags(),
  );

  return (
    <section
      aria-labelledby="settings-manage-heading"
      className="settings__manage"
    >
      <h2 className="settings__manage-heading" id="settings-manage-heading">
        Manage
      </h2>
      <div className="settings__manage-grid">
        {destinations.map((destination) => {
          const label = destination.label();
          return (
            <button
              className="settings__manage-item"
              key={destination.id}
              onClick={() => navigate(destination.route)}
              type="button"
            >
              {destination.icon ? destinationIcon(destination.icon) : null}
              <span>{label}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
