/**
 * TimezoneContextProvider — injects the browser's IANA timezone into messages.
 *
 * Always-on; no user permission required. Injects "[Timezone: America/New_York]"
 * as a lightweight context hint for scheduling/calendar-aware queries.
 */
import type { MessageContextProvider } from '@kontourai/station-sdk';
import { ListenerManager } from '@kontourai/station-sdk';

class TimezoneContextProvider
  extends ListenerManager
  implements MessageContextProvider
{
  readonly id = 'timezone';
  readonly name = 'Timezone';
  readonly description =
    'Tells the model your IANA timezone (e.g. America/Denver) so it can give time-aware answers.';

  private _enabled = true;

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(value: boolean) {
    if (value === this._enabled) return;
    this._enabled = value;
    this._notify();
  }

  getContext(): string | null {
    if (!this._enabled) return null;
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return `[Timezone: ${tz}]`;
    } catch {
      return null;
    }
  }

  destroy(): void {
    this._clearListeners();
  }
}

export const timezoneContextProvider = new TimezoneContextProvider();
