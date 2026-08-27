/**
 * GeolocationContextProvider — injects GPS location into outgoing messages.
 *
 * Wraps navigator.geolocation.watchPosition. Disabled by default; the user
 * must enable it in Settings (privacy-sensitive).
 *
 * Extracted from useLocationContext.ts.
 */
import type { MessageContextProvider } from '@kontourai/station-sdk';
import { ListenerManager } from '@kontourai/station-sdk';

class GeolocationContextProvider
  extends ListenerManager
  implements MessageContextProvider
{
  readonly id = 'geolocation';
  readonly name = 'Geolocation';
  readonly description =
    'Shares your GPS coordinates with the model for location-aware answers. Requires browser permission.';

  private _enabled = false;
  private _coords: { lat: number; lng: number } | null = null;
  private _watchId: number | null = null;

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(value: boolean) {
    if (value === this._enabled) return;
    this._enabled = value;
    if (value) {
      this._startWatch();
    } else {
      this._stopWatch();
    }
    this._notify();
  }

  get isSupported(): boolean {
    return 'geolocation' in navigator;
  }

  getContext(): string | null {
    if (!this._enabled || !this._coords) return null;
    return `[My location: ${this._coords.lat.toFixed(5)}, ${this._coords.lng.toFixed(5)}]`;
  }

  destroy(): void {
    this._stopWatch();
    this._clearListeners();
  }

  private _startWatch(): void {
    if (!this.isSupported || this._watchId !== null) return;
    this._watchId = navigator.geolocation.watchPosition(
      (pos) => {
        this._coords = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        };
        this._notify();
      },
      () => {
        // Permission denied or error — leave coords as-is
      },
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: 60_000 },
    );
  }

  private _stopWatch(): void {
    if (this._watchId !== null) {
      navigator.geolocation.clearWatch(this._watchId);
      this._watchId = null;
    }
  }
}

export const geolocationContextProvider = new GeolocationContextProvider();
