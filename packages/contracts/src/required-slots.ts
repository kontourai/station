/** Required surfaces cannot be removed. Approval-slot separation remains OPEN-1. */
export const REQUIRED_SLOT_DEFAULTS = {
  home: 'builtin:workspace-home',
  chat: 'builtin:workspace-chat',
} as const;

export type RequiredSlot = keyof typeof REQUIRED_SLOT_DEFAULTS;
export type RequiredSlotAssignments = Partial<Record<RequiredSlot, string>>;

/** Omission removes an override; an explicit empty filler is never valid. */
export function parseRequiredSlotAssignments(
  value: unknown,
): RequiredSlotAssignments {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Required slots must be an object');
  }
  const result: RequiredSlotAssignments = {};
  for (const [slot, filler] of Object.entries(value)) {
    if (slot !== 'home' && slot !== 'chat') {
      throw new Error(`Unknown required slot: ${slot}`);
    }
    if (
      typeof filler !== 'string' ||
      filler.trim() !== filler ||
      filler.length === 0 ||
      filler.toLowerCase() === 'none'
    ) {
      throw new Error(
        `Required slot '${slot}' needs a non-empty filler; remove the override to restore its default`,
      );
    }
    result[slot] = filler;
  }
  return result;
}

export function assertRequiredSlotDefaultMutable(
  id: string,
  action: 'uninstall' | 'disable',
): void {
  if (
    Object.values(REQUIRED_SLOT_DEFAULTS).some((defaultId) => defaultId === id)
  ) {
    throw new Error(`Cannot ${action} required-slot default filler '${id}'`);
  }
}

export interface RequiredSlotFiller<T> {
  id: string;
  /** Fresh host observation, including installation, enablement and load status. */
  available: boolean;
  value: T;
}

export type RequiredSlotResolution<T> =
  | {
      state: 'resolved';
      slot: RequiredSlot;
      source: 'default' | 'override';
      filler: RequiredSlotFiller<T>;
      safeMode: false;
    }
  | {
      state: 'safe-mode';
      slot: RequiredSlot;
      defaultFiller: string;
      safeMode: true;
    };

/** Pure decision only. Callers must observe live standing before each read/render. */
export function resolveRequiredSlot<T>(
  slot: RequiredSlot,
  defaultFiller: RequiredSlotFiller<T>,
  override?: RequiredSlotFiller<T>,
): RequiredSlotResolution<T> {
  // The failed-default rule covers load/selection failures only.
  // Default render failures belong to pane recovery.
  if (!defaultFiller.available) {
    return {
      state: 'safe-mode',
      slot,
      defaultFiller: defaultFiller.id,
      safeMode: true,
    };
  }
  return {
    state: 'resolved',
    slot,
    safeMode: false,
    source: override?.available ? 'override' : 'default',
    filler: override?.available ? override : defaultFiller,
  };
}
