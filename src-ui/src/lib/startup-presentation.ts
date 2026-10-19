import { startStartupAnimation } from './startup-animation';

const surface = globalThis.document?.querySelector<HTMLElement>(
  '#root .station-startup',
);
const root = globalThis.document?.getElementById('root');
const frame = surface ? document.createElement('dialog') : undefined;
const pending = new Map<symbol, string>();
const completionListeners = new Set<() => void>();
const FADE_MS = 150;
let mounted = false;
let visible = false;
let painted = false;
let elapsed = 0;
let leaving = false;
let fadeTimer: number | undefined;
let stopAnimation: (() => void) | undefined;
let recoveryObserver: MutationObserver | undefined;

function finish() {
  if (!surface?.isConnected) return;
  window.clearTimeout(fadeTimer);
  stopAnimation?.();
  stopAnimation = undefined;
  frame?.close();
  frame?.remove();
  pending.clear();
  if (root) {
    root.inert = false;
    root.removeAttribute('aria-hidden');
  }
  document.removeEventListener('visibilitychange', reconsider);
  motion?.removeEventListener('change', reconsider);
  recoveryObserver?.disconnect();
  for (const listener of completionListeners) listener();
  completionListeners.clear();
}

const motion = surface
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : undefined;

function reconsider() {
  if (!surface?.isConnected || !mounted || pending.size > 0) return;
  if (!painted || !visible || document.hidden || motion?.matches) {
    finish();
    return;
  }
  if (elapsed < 950 || leaving) return;
  leaving = true;
  surface.style.setProperty('--startup-fade', `${FADE_MS}ms`);
  surface.classList.add('station-startup--leaving');
  fadeTimer = window.setTimeout(finish, FADE_MS);
}

/** A cold launch is over once the committed tree has no startup waits. */
export function commitInitialStartup() {
  mounted = true;
  queueMicrotask(reconsider);
}

export function retainInitialStartup(message: string) {
  if (!surface?.isConnected) return;
  if (leaving) {
    window.clearTimeout(fadeTimer);
    leaving = false;
    surface.classList.remove('station-startup--leaving');
  }
  const key = Symbol();
  pending.set(key, message);
  let label = surface.querySelector('.station-startup__message');
  if (!label) {
    label = document.createElement('span');
    label.className = 'station-startup__message';
    surface.append(label);
  }
  label.textContent = message;
  surface.setAttribute('aria-label', message);
  return () => {
    pending.delete(key);
    const current = [...pending.values()].at(-1);
    if (current) {
      label.textContent = current;
      surface.setAttribute('aria-label', current);
    } else {
      label.remove();
      surface.setAttribute('aria-label', 'Station');
    }
    queueMicrotask(reconsider);
  };
}

export function allowInitialStartupAnimation() {
  visible = true;
}

export function initialStartupIsActive() {
  return surface?.isConnected === true;
}

/** Retain initial focus intent while the launch dialog makes the app inert. */
export function afterInitialStartup(listener: () => void) {
  completionListeners.add(listener);
  return () => {
    completionListeners.delete(listener);
  };
}

/** Recovery must never wait for branding or an animation asset. */
export function dismissInitialStartup() {
  finish();
}

if (surface && root) {
  // React replaces the root's children; the one launch presentation survives
  // those bootstrap handoffs and fades over the committed application.
  frame!.className = 'station-startup-frame';
  frame!.setAttribute('aria-label', 'Starting Station');
  frame!.append(surface);
  document.body.append(frame!);
  frame!.addEventListener('cancel', finish);
  frame!.showModal();
  root.inert = true;
  root.setAttribute('aria-hidden', 'true');
  const canvas = surface.querySelector<HTMLCanvasElement>('canvas');
  if (canvas) {
    stopAnimation = startStartupAnimation(canvas, {
      isVisible: () => visible && !leaving,
      onFrame(time) {
        painted = true;
        elapsed = time;
        reconsider();
      },
      onUnavailable: finish,
    });
  }
  if (!surface.isConnected) {
    stopAnimation?.();
    stopAnimation = undefined;
  } else {
    document.addEventListener('visibilitychange', reconsider);
    motion?.addEventListener('change', reconsider);
    recoveryObserver = new MutationObserver(() => {
      if (root.querySelector('[role="alert"]')) finish();
    });
    recoveryObserver.observe(root, { childList: true, subtree: true });
  }
}
