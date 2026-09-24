import { useSyncExternalStore } from 'react';
import type { FloatPosition } from './floatLayout';
import { type FloatSource, floatSourceKey } from './floatSource';

/**
 * Float-over-chat state (#90 D9), three kinds with three lifetimes:
 *
 * - WHICH source floats over which conversation: in memory only. One floater
 *   per conversation; a reload starts with none, and auto-float brings back
 *   whatever an agent is still driving.
 * - The player's PLACE (position and width): per device, in localStorage. A
 *   per-viewer convenience — every read and write is guarded, and a storage
 *   that throws or is empty just means the default top-right placement.
 * - What the user DISMISSED in a conversation: per device, in localStorage,
 *   so a session the user closed is never floated into that conversation
 *   again, including after a reload. Bounded, oldest conversation first.
 */

const FRAME_KEY = 'station:float-over-chat:frame:v1';
const DISMISSED_KEY = 'station:float-over-chat:dismissed:v1';
const MAX_DISMISSED_CONVERSATIONS = 50;
const MAX_DISMISSED_PER_CONVERSATION = 50;

export interface FloatPlacement {
  readonly position: FloatPosition | null;
  /** Height always follows the source's aspect ratio. */
  readonly width: number | null;
}

const DEFAULT_PLACEMENT: FloatPlacement = { position: null, width: null };

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readJson(key: string): unknown {
  try {
    const raw = storage()?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    /* per-viewer convenience: an unwritable storage keeps the session copy */
  }
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function parsePlacement(value: unknown): FloatPlacement {
  if (typeof value !== 'object' || value === null) return DEFAULT_PLACEMENT;
  const record = value as Record<string, unknown>;
  const position = record.position as Record<string, unknown> | null;
  return {
    position:
      position && finite(position.x) && finite(position.y)
        ? { x: position.x, y: position.y }
        : null,
    width: finite(record.width) && record.width > 0 ? record.width : null,
  };
}

// ---- state -----------------------------------------------------------------

let placement: FloatPlacement | null = null;
const floating = new Map<string, FloatSource>();
/** Why a floater went away on its own, per conversation (see `setFloatNotice`). */
const notices = new Map<string, FloatNotice>();
let dismissed: Record<string, string[]> | null = null;
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function dismissedRecord(): Record<string, string[]> {
  if (dismissed) return dismissed;
  const raw = readJson(DISMISSED_KEY);
  const next: Record<string, string[]> = {};
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    for (const [conversation, keys] of Object.entries(raw)) {
      if (Array.isArray(keys))
        next[conversation] = keys.filter(
          (key): key is string => typeof key === 'string',
        );
    }
  }
  dismissed = next;
  return next;
}

export function getFloatPlacement(): FloatPlacement {
  placement ??= parsePlacement(readJson(FRAME_KEY));
  return placement;
}

/** Update the placement in memory; `persist` also writes it for this device. */
export function setFloatPlacement(
  next: FloatPlacement,
  options: { persist: boolean },
): void {
  const current = getFloatPlacement();
  if (
    current.width !== next.width ||
    current.position?.x !== next.position?.x ||
    current.position?.y !== next.position?.y
  ) {
    placement = next;
    emit();
  }
  if (options.persist) writeJson(FRAME_KEY, next);
}

export function getFloatingSource(conversation: string): FloatSource | null {
  return floating.get(conversation) ?? null;
}

/**
 * Which float this is, per conversation: a new number whenever a DIFFERENT
 * source starts floating (or any source starts after none). Reads about a
 * float are keyed by it, so a new float is never judged by what was read
 * for an earlier one — its cached list, or its final error. The same
 * source following its reopened surface keeps its number.
 */
const generations = new Map<string, number>();
let lastGeneration = 0;

export function getFloatGeneration(conversation: string): number {
  return generations.get(conversation) ?? 0;
}

export function openFloat(
  conversation: string,
  source: FloatSource,
  /**
   * `requested`: a person asked for this source (not the float following
   * its own read). A request naming another surface of the SAME source —
   * the device reopened as a new session while it floats — is a new float
   * too, so it is not judged by the old session's cached list (LOW-1).
   */
  options: { requested?: boolean } = {},
): void {
  const current = floating.get(conversation);
  if (
    current &&
    floatSourceKey(current) === floatSourceKey(source) &&
    current.surfaceId === source.surfaceId
  )
    return;
  if (
    !current ||
    floatSourceKey(current) !== floatSourceKey(source) ||
    options.requested === true
  ) {
    lastGeneration += 1;
    generations.set(conversation, lastGeneration);
  }
  floating.set(conversation, source);
  emit();
}

/** The floater went away on its own (its source ended): nothing dismissed. */
export function closeFloat(conversation: string): void {
  if (!floating.delete(conversation)) return;
  emit();
}

/**
 * The user put this source away in this conversation (Close, or Open in
 * right panel): close the floater and never auto-float it here again.
 */
export function dismissFloat(conversation: string, sourceKey: string): void {
  const record = dismissedRecord();
  const keys = record[conversation] ?? [];
  if (!keys.includes(sourceKey)) {
    const next = { ...record };
    // Re-inserting moves the conversation to the end, so trimming from the
    // front drops the one dismissed in longest ago.
    delete next[conversation];
    next[conversation] = [...keys, sourceKey].slice(
      -MAX_DISMISSED_PER_CONVERSATION,
    );
    const conversations = Object.keys(next);
    for (const stale of conversations.slice(
      0,
      Math.max(0, conversations.length - MAX_DISMISSED_CONVERSATIONS),
    ))
      delete next[stale];
    dismissed = next;
    writeJson(DISMISSED_KEY, next);
  }
  floating.delete(conversation);
  emit();
}

/**
 * How long a source handed to a pane (Open in right panel) is kept from
 * floating again while that pane has not yet shown it — its chunk and its
 * first read are in flight. After this, a pane that never showed it does
 * not keep the floater away for good.
 */
const HANDOFF_GRACE_MS = 15_000;
const handoffs = new Map<string, { seen: boolean; at: number }>();
const handoffKey = (conversation: string, sourceKey: string) =>
  `${conversation}\u0000${sourceKey}`;

/**
 * The user moved this source into a pane (Open in right panel). NOT a
 * dismissal: the floater closes, and the source is kept from floating again
 * only while the pane is about to show it or is showing it. Once that pane
 * stops showing it (the user closed it), it may float here again.
 */
export function handOffFloat(
  conversation: string,
  sourceKey: string,
  now = Date.now(),
): void {
  handoffs.set(handoffKey(conversation, sourceKey), { seen: false, at: now });
  floating.delete(conversation);
  emit();
}

/**
 * Whether a hand-off still holds `sourceKey` back here, given whether a pane
 * shows it right now. Records that the pane showed it, and lets go once the
 * pane stops showing it, or when the pane never did within the grace period.
 */
export function isFloatHandedOff(
  conversation: string,
  sourceKey: string,
  shownInPane: boolean,
  now = Date.now(),
): boolean {
  const key = handoffKey(conversation, sourceKey);
  const handoff = handoffs.get(key);
  if (!handoff) return false;
  if (shownInPane) {
    handoff.seen = true;
    return true;
  }
  if (handoff.seen || now - handoff.at > HANDOFF_GRACE_MS) {
    handoffs.delete(key);
    return false;
  }
  return true;
}

/**
 * A person asked for a source to float (the Device pane's "Float over
 * chat"): the pane cannot know which conversation to float into, so the
 * request waits here for a chat's floater to take it. Only a chat that can
 * show a floater (one with a Project, whose floater is mounted) registers,
 * and `requestFloat` refuses when none is mounted — the pane disables its
 * action then, rather than offering one that does nothing. The asker is
 * told when a chat TOOK the request (`onTaken`), so it lets go of the
 * source only once the float has it; a request no chat takes in time is
 * dropped and the asker keeps it.
 */
const REQUEST_TTL_MS = 5_000;
let pendingRequest: {
  source: FloatSource;
  onTaken: (() => void) | undefined;
  at: number;
} | null = null;
let mountedHosts = 0;

/** A chat's floater is mounted and can take a request; returns its release. */
export function registerFloatHost(): () => void {
  mountedHosts += 1;
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    mountedHosts -= 1;
    if (mountedHosts === 0) pendingRequest = null;
    emit();
  };
}

/** Whether any chat's floater could take a request right now. */
export function isFloatHostAvailable(): boolean {
  return mountedHosts > 0;
}

/**
 * Ask a mounted chat to float `source`; false when no chat can. `onTaken`
 * runs once a chat has taken it (and is floating it).
 */
export function requestFloat(
  source: FloatSource,
  onTaken?: () => void,
  now = Date.now(),
): boolean {
  if (mountedHosts === 0) return false;
  pendingRequest = { source, onTaken, at: now };
  emit();
  return true;
}

/** The waiting request, taken (so exactly one chat floats it). */
export function takeFloatRequest(
  now = Date.now(),
): { source: FloatSource; onTaken: (() => void) | undefined } | null {
  const request = pendingRequest;
  pendingRequest = null;
  if (!request || now - request.at > REQUEST_TTL_MS) return null;
  return { source: request.source, onTaken: request.onTaken };
}

/**
 * Why a floater went away on its own, per conversation, until the person
 * dismisses it or asks for something else to float there: a source that
 * cannot be shown here is never dropped silently. An auto-float that
 * follows does not clear it (the person has not seen it yet).
 */

export interface FloatNotice {
  /** What went away: names the notice ("Floating device notice"). */
  readonly subject: 'device' | 'browser';
  readonly text: string;
  /** The device that could not float here, so its pane is one click away. */
  readonly device?: {
    readonly hostId: string;
    readonly platform: 'ios' | 'android';
    readonly deviceId: string;
  };
}

export function setFloatNotice(
  conversation: string,
  notice: FloatNotice,
): void {
  notices.set(conversation, notice);
  emit();
}

export function getFloatNotice(conversation: string): FloatNotice | null {
  return notices.get(conversation) ?? null;
}

export function clearFloatNotice(conversation: string): void {
  if (notices.delete(conversation)) emit();
}

/** {@link isFloatHostAvailable}, re-rendered as chats mount and unmount. */
export function useFloatHostAvailable(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => mountedHosts > 0,
    () => false,
  );
}

export function isFloatDismissed(
  conversation: string,
  sourceKey: string,
): boolean {
  return dismissedRecord()[conversation]?.includes(sourceKey) ?? false;
}

/**
 * A chat's key moved: a new chat is keyed by its tab id until the server
 * gives it a conversation id, and then by that (#90 D9 SF1). Carry what was
 * recorded under the old key — the floating source, the dismissals, any
 * hand-off — to the new one, so a session closed in the first moments of a
 * chat stays closed after the chat's first reply lands.
 */
export function migrateFloatConversation(from: string, to: string): void {
  if (from === to) return;
  let changed = false;
  const source = floating.get(from);
  if (source) {
    floating.delete(from);
    if (!floating.has(to)) {
      floating.set(to, source);
      const generation = generations.get(from);
      if (generation !== undefined) generations.set(to, generation);
    }
    generations.delete(from);
    changed = true;
  }
  const record = dismissedRecord();
  const moved = record[from];
  if (moved) {
    const next = { ...record };
    delete next[from];
    next[to] = [...new Set([...(record[to] ?? []), ...moved])].slice(
      -MAX_DISMISSED_PER_CONVERSATION,
    );
    dismissed = next;
    writeJson(DISMISSED_KEY, next);
    changed = true;
  }
  const prefix = handoffKey(from, '');
  for (const [key, handoff] of [...handoffs]) {
    if (!key.startsWith(prefix)) continue;
    handoffs.delete(key);
    handoffs.set(handoffKey(to, key.slice(prefix.length)), handoff);
    changed = true;
  }
  if (changed) emit();
}

/** Re-render on any float-over-chat state change. */
export function useFloatStoreVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
}

/** Test seam: forget everything held in memory (storage is the test's). */
export function resetFloatStoreForTests(): void {
  placement = null;
  dismissed = null;
  floating.clear();
  handoffs.clear();
  pendingRequest = null;
  mountedHosts = 0;
  notices.clear();
  generations.clear();
  emit();
}
