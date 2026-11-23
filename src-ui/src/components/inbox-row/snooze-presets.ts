import { clockTime } from '../../utils/relativeTime';

/**
 * THE snooze list, for every surface that snoozes: the dock and phone inbox
 * rows, the phone's bulk Snooze, Home, and the inbox page's attention and
 * notification rows. Each choice is shown with the real time it ends.
 */
export interface SnoozePreset {
  label: string;
  until: Date;
}

/**
 * The choices, in local time, nearest first. Each is a real future instant
 * within the server's 30-day bound, so a preset can never be the one the
 * server refuses; "This evening" only appears while there is still an evening
 * left to wait for.
 */
export function snoozePresets(now = new Date()): SnoozePreset[] {
  const at = (days: number, hour: number) => {
    const date = new Date(now);
    date.setDate(date.getDate() + days);
    date.setHours(hour, 0, 0, 0);
    return date;
  };
  const presets: SnoozePreset[] = [
    { label: 'In 1 hour', until: new Date(now.getTime() + 60 * 60 * 1000) },
  ];
  if (now.getHours() < 17)
    presets.push({ label: 'This evening', until: at(0, 18) });
  presets.push({ label: 'Tomorrow morning', until: at(1, 9) });
  // Next Monday, a full week out when today is Monday.
  const toMonday = (8 - now.getDay()) % 7 || 7;
  presets.push({ label: 'Next week', until: at(toMonday, 9) });
  return presets;
}

/** The list as a row offers it: label, the time it ends, and that instant. */
export function snoozeChoices(
  now: number,
): { label: string; hint: string; wakeAt: number }[] {
  return snoozePresets(new Date(now)).map((preset) => ({
    label: preset.label,
    // "6:00 PM" today, "Mon 9:00 AM" on another day: the work surfaces'
    // one clock-time form.
    hint: clockTime(preset.until.getTime(), now),
    wakeAt: preset.until.getTime(),
  }));
}
