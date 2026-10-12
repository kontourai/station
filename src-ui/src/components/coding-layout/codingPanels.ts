import type {
  CodingSessionPanels,
  CodingSessionPanelsRecord,
} from '@kontourai/station-contracts/device-settings';
import { useCallback, useEffect, useState } from 'react';
import { useDeviceSettings } from '../../contexts/DeviceSettingsContext';
import {
  CLOSED_CODING_SESSION_PANELS,
  readCodingSessionPanels,
  writeCodingSessionPanels,
} from '../../lib/coding-panels-record';
import { deviceSettingsStore } from '../../lib/device-settings-store';

/**
 * The Coding layout's panels (#3040, #3051): on a wide screen a tool opens
 * BESIDE Chat rather than over it, and the Terminal opens in a lower panel
 * under both. This module holds the fold, the sizes and the per-session
 * memory; `CodingWorkbench` renders them.
 *
 * ## The wide fold
 *
 * Chat beside a tool needs the width of both at their floors plus what the
 * shell takes around them: Chat at `CODING_CHAT_MIN_WIDTH` (480px: the
 * inbox's 240px floor and a transcript column no narrower than the dock's
 * own Chat), a tool at `CODING_SIDE_MIN_WIDTH` (320px: a unified diff with
 * its gutter, a file tree with real names), the 8px separator, the 44px
 * rail, and the Project sidebar (240px). That is 1092px; 1280px is the
 * next conventional step (the `xl` width of the common breakpoint scales,
 * and a 13" laptop's scaled width), and leaves Chat 650px with the sidebar
 * open rather than exactly its floor. Below it a tool is a full-page
 * drill-in exactly as before. A viewport query, not a measurement of the
 * workbench: the answer must be the same for every reader of it (the
 * layout host decides where the Terminal renders by it), and a measured
 * fold would move as the panels it governs open.
 */
const CODING_WIDE_MEDIA_QUERY = '(min-width: 1280px)';

const CODING_CHAT_MIN_WIDTH = 480;
export const CODING_SIDE_MIN_WIDTH = 320;
export const CODING_SIDE_DEFAULT_WIDTH = 440;
/**
 * The transcript column — where the reader works — keeps this much beside
 * an open tool, or the inbox folds for the tool's stay (#3046 round).
 * Derived from the transcript's own rules, not from the fold: a message
 * bubble is 80% of its row (`.message`, `max-width: 80%`) with 48px of
 * its own padding, and the row sits inside the column's two 20px gutters
 * (`--chat-message-gutter`). A 640px column is a 600px row, a 480px
 * bubble, 432px of text past the padding: sixty-odd characters of the
 * body, the measure under which a reply's lines break too often to scan.
 * (The design audit's 500px column, beside an unfolded inbox at 1440,
 * showed exactly that: a two-line composer and wrapped cards.)
 */
export const CODING_TRANSCRIPT_MIN_WIDTH = 640;
/** The inbox's own width rule (`ChatDockInboxPanel.css`), for an unmeasured one. */
const CODING_INBOX_WIDTH = { min: 240, fraction: 0.24, max: 360 };
/** Below Chat's transcript and composer, the lower panel stops here. */
const CODING_CHAT_MIN_HEIGHT = 240;
export const CODING_LOWER_MIN_HEIGHT = 160;
/**
 * The lower panel opens at this much of the room: at 860px that is 258px —
 * about eleven terminal rows under the panel's head and the strip — and
 * leaves the transcript seventy percent, which a fixed 280px did not on a
 * laptop. Between its floor and Chat's, as any resize is.
 */
const CODING_LOWER_DEFAULT_FRACTION = 0.3;

/**
 * How long a resized room rests before the inbox fold is judged again, and
 * the room beyond the transcript's floor an unfold waits for, so a width on
 * the line does not flap between folded and unfolded.
 */
export const CODING_FOLD_SETTLE_MS = 150;
export const CODING_FOLD_HYSTERESIS = 24;

/**
 * Whether the pane host draws this pane (#3040): every pane it holds once
 * the reader has drilled in — except the Terminal past the wide fold, which
 * the workbench's lower panel draws instead, so one terminal is never
 * mounted twice.
 */
export function hostRendersCodingPane(
  wide: boolean,
  renderPanes: boolean,
  instanceId: string,
  terminalInstanceId: string | null,
): boolean {
  if (!renderPanes) return false;
  return !(
    wide &&
    terminalInstanceId !== null &&
    instanceId === terminalInstanceId
  );
}

export function codingLowerDefaultHeight(roomHeight: number): number {
  return clampCodingLowerHeight(
    roomHeight * CODING_LOWER_DEFAULT_FRACTION,
    roomHeight,
  );
}

/**
 * The transcript column's width beside an open tool: the room less the rail,
 * the separator, the tool and the inbox — the inbox as measured, or by its
 * own rule when it has no box yet.
 */
export function codingTranscriptWidth(
  roomWidth: number,
  sideWidth: number,
  inboxWidth: number | null,
): number {
  const inbox =
    inboxWidth ??
    Math.min(
      CODING_INBOX_WIDTH.max,
      Math.max(CODING_INBOX_WIDTH.min, roomWidth * CODING_INBOX_WIDTH.fraction),
    );
  return (
    roomWidth - CODING_RAIL_WIDTH - CODING_SEPARATOR_SIZE - sideWidth - inbox
  );
}
/** The rail and the separator, which the side panel's room excludes. */
const CODING_RAIL_WIDTH = 44;
const CODING_SEPARATOR_SIZE = 8;

/**
 * Whether the viewport is past the wide fold, subscribed. jsdom-safe: with
 * no `matchMedia` the answer is "not wide", the drill-in behaviour.
 */
export function useCodingWide(): boolean {
  const [wide, setWide] = useState(readCodingWide);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const query = window.matchMedia(CODING_WIDE_MEDIA_QUERY);
    const read = () => setWide(query.matches);
    read();
    query.addEventListener('change', read);
    return () => query.removeEventListener('change', read);
  }, []);
  return wide;
}

function readCodingWide(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(CODING_WIDE_MEDIA_QUERY).matches;
}

/**
 * The side panel's width, held between its floor and what leaves Chat its
 * minimum in `roomWidth` (the pages' row, rail included). When the room
 * cannot fit both floors the floor wins: the panel is never narrower than
 * a tool can use, and Chat's own `min-width` keeps the row from folding.
 */
export function clampCodingSideWidth(width: number, roomWidth: number): number {
  const max = Math.max(
    CODING_SIDE_MIN_WIDTH,
    roomWidth -
      CODING_RAIL_WIDTH -
      CODING_SEPARATOR_SIZE -
      CODING_CHAT_MIN_WIDTH,
  );
  return Math.round(Math.min(max, Math.max(CODING_SIDE_MIN_WIDTH, width)));
}

export function codingSideMaxWidth(roomWidth: number): number {
  return clampCodingSideWidth(Number.POSITIVE_INFINITY, roomWidth);
}

/** The lower panel's height, held between its floor and Chat's floor above it. */
export function clampCodingLowerHeight(
  height: number,
  roomHeight: number,
): number {
  const max = Math.max(
    CODING_LOWER_MIN_HEIGHT,
    roomHeight - CODING_SEPARATOR_SIZE - CODING_CHAT_MIN_HEIGHT,
  );
  return Math.round(Math.min(max, Math.max(CODING_LOWER_MIN_HEIGHT, height)));
}

export function codingLowerMaxHeight(roomHeight: number): number {
  return clampCodingLowerHeight(Number.POSITIVE_INFINITY, roomHeight);
}

const RESIZE_STEP = 16;
const RESIZE_STEP_COARSE = 64;

/**
 * A separator's keyboard: the arrows along its axis nudge the panel (Shift
 * for a coarser step), Home and End go to the floor and the ceiling, Enter
 * returns to the default. A vertical separator sits on the panel's leading
 * edge, so ArrowLeft grows the panel; a horizontal one on its top edge, so
 * ArrowUp grows it. Null when the key is not the separator's.
 */
export function resizeCodingPanelFromKeyboard(
  orientation: 'vertical' | 'horizontal',
  current: number,
  key: string,
  options: { shiftKey?: boolean; min: number; max: number; reset: number },
): number | null {
  const step = options.shiftKey ? RESIZE_STEP_COARSE : RESIZE_STEP;
  const grow = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
  const shrink = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
  const clamp = (value: number) =>
    Math.min(options.max, Math.max(options.min, value));
  if (key === grow) return clamp(current + step);
  if (key === shrink) return clamp(current - step);
  if (key === 'Home') return options.min;
  if (key === 'End') return options.max;
  if (key === 'Enter') return clamp(options.reset);
  return null;
}

/**
 * The session's remembered panels, and a write-through to the device
 * setting. The record is one device setting (`codingPanels`), read through
 * the same store every other per-device UI state uses, so it survives a
 * reload and is bounded there.
 */
export function useCodingSessionPanels(sessionKey: string): {
  panels: CodingSessionPanels;
  update(patch: Partial<Omit<CodingSessionPanels, 'at'>>): void;
} {
  const record: CodingSessionPanelsRecord = useDeviceSettings().codingPanels;
  const panels = sessionKey
    ? readCodingSessionPanels(record, sessionKey)
    : CLOSED_CODING_SESSION_PANELS;
  const update = useCallback(
    (patch: Partial<Omit<CodingSessionPanels, 'at'>>) => {
      if (!sessionKey) return;
      // Read the store at write time, not the render's copy: two writes in
      // one commit (a toggle and the size it restores) must both land.
      const current = deviceSettingsStore.get('codingPanels');
      const next = writeCodingSessionPanels(
        current,
        sessionKey,
        patch,
        Date.now(),
      );
      if (next !== current) deviceSettingsStore.set('codingPanels', next);
    },
    [sessionKey],
  );
  return { panels, update };
}
