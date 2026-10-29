export const OPEN_STATION_DETAILS_EVENT = 'station:open-station-details';

export function openStationDetails() {
  window.dispatchEvent(new Event(OPEN_STATION_DETAILS_EVENT));
}
