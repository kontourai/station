import { useConnections } from '@kontourai/station-connect';
import { useEffect, useState } from 'react';
import {
  BANNER_IDS,
  BANNER_PRIORITY,
  type BannerItem,
  useBanners,
} from '../../contexts/banner-store';
import {
  OPEN_CONNECTIONS_MODAL_EVENT,
  openConnectionsModal,
} from '../../lib/connectionModalEvents';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import {
  OPEN_STATION_DETAILS_EVENT,
  openStationDetails,
} from './stationDetailsEvents';
import './StationConditions.css';

function isStationCondition(item: BannerItem) {
  return (
    item.id.startsWith('chrome:connection:') ||
    item.id.startsWith('chrome:onboarding:') ||
    item.id === BANNER_IDS.homeRecovery ||
    item.id.startsWith(`${BANNER_IDS.deferredCapability}:`)
  );
}

export function useStationConditions() {
  return useBanners().filter(isStationCondition);
}

function Condition({
  item,
  onOpenDialog,
}: {
  item: BannerItem;
  onOpenDialog?: () => void;
}) {
  return (
    <section
      className="station-condition"
      aria-label={item.badge ?? 'Station status'}
    >
      <p>{item.message}</p>
      {item.detail && (
        <p className="station-condition__detail">{item.detail}</p>
      )}
      {item.actions?.length ? (
        <div className="station-condition__actions">
          {item.actions.map((action) =>
            action.href ? (
              <a key={action.label} href={action.href}>
                {action.label}
              </a>
            ) : (
              <Button
                key={action.label}
                variant={action.variant === 'danger' ? 'danger' : 'secondary'}
                aria-label={action.ariaLabel}
                onClick={() => {
                  if (action.opensDialog) onOpenDialog?.();
                  action.onClick?.();
                }}
                onBlur={action.onBlur}
              >
                {action.label}
              </Button>
            ),
          )}
        </div>
      ) : null}
    </section>
  );
}

/** Local connection facts remain readable when the selected server is unavailable. */
export function StationDetailsHost() {
  const { activeConnection, apiBase } = useConnections();
  const conditions = useStationConditions();
  const scope = JSON.stringify([activeConnection?.id, apiBase]);
  const [openScope, setOpenScope] = useState<string | null>(null);
  useEffect(() => {
    const show = () => setOpenScope(scope);
    window.addEventListener(OPEN_STATION_DETAILS_EVENT, show);
    const close = () => setOpenScope(null);
    window.addEventListener(OPEN_CONNECTIONS_MODAL_EVENT, close);
    return () => {
      window.removeEventListener(OPEN_STATION_DETAILS_EVENT, show);
      window.removeEventListener(OPEN_CONNECTIONS_MODAL_EVENT, close);
    };
  }, [scope]);
  useEffect(() => {
    setOpenScope((current) => (current === scope ? current : null));
  }, [scope]);
  if (openScope !== scope) return null;
  return (
    <Dialog
      title="Station details"
      closeLabel="Close Station details"
      onClose={() => setOpenScope(null)}
      size="sm"
      footer={
        !conditions.some((item) =>
          item.actions?.some((action) => action.label === 'Manage Stations'),
        ) && (
          <Button onClick={() => openConnectionsModal({ mode: 'list' })}>
            Manage Stations
          </Button>
        )
      }
    >
      <p>{activeConnection?.name || 'Selected Station'}</p>
      <p className="station-condition__detail">
        {activeConnection?.url ?? apiBase}
      </p>
      {conditions.length ? (
        conditions.map((item) => (
          <Condition
            key={item.id}
            item={item}
            onOpenDialog={() => setOpenScope(null)}
          />
        ))
      ) : (
        <p>No additional Station notices.</p>
      )}
    </Dialog>
  );
}

/** Explain a restriction where it affects work; details and repair stay in the Station control. */
export function WorkspaceStationState() {
  const conditions = useStationConditions();
  const condition = conditions.find(
    (item) =>
      item.id === BANNER_IDS.homeRecovery ||
      item.id === BANNER_IDS.compat ||
      item.id.startsWith(`${BANNER_IDS.deferredCapability}:`) ||
      (item.priority >= BANNER_PRIORITY.connectionBlocking &&
        item.tone !== 'info'),
  );
  if (!condition) return null;
  return (
    <div className="workspace-station-state" role="status">
      <span>{condition.message}</span>
      <Button size="sm" onClick={openStationDetails}>
        Review Station
      </Button>
    </div>
  );
}

export function SetupReturnNotice() {
  const items = useBanners().filter((item) =>
    item.id.startsWith('chrome:new-chat:setup-return:'),
  );
  if (!items.length) return null;
  return (
    <div className="setup-return-notice">
      {items.map((item) => (
        <Condition key={item.id} item={item} />
      ))}
    </div>
  );
}
