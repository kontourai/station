/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  getShortcutContext,
  isModalDialogOpen,
} from '../contexts/KeyboardShortcutsContext';

/**
 * station#3767: `dialogOpen` used to be a reference-counted CLAIM, and the
 * claim was made by exactly one component in the app — every hand-rolled
 * modal (the command launcher, the shortcuts cheatsheet, the command palette,
 * the task switcher) left the app's global chords live underneath it. It is
 * derived from the document now, so the fact and the rendering cannot drift.
 */
describe('dialogOpen is derived from the document', () => {
  function openModal(label: string) {
    const node = document.createElement('div');
    node.setAttribute('role', 'dialog');
    node.setAttribute('aria-modal', 'true');
    node.setAttribute('data-label', label);
    document.body.append(node);
    return () => node.remove();
  }

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('reads false with nothing modal in the document', () => {
    expect(isModalDialogOpen()).toBe(false);
    expect(getShortcutContext('dialogOpen')).toBe(false);
  });

  it('reads true for ANY aria-modal surface, not only the shared one', () => {
    const close = openModal('hand-rolled');
    expect(getShortcutContext('dialogOpen')).toBe(true);
    close();
    expect(getShortcutContext('dialogOpen')).toBe(false);
  });

  it('stays true while a second stacked dialog is still open', () => {
    // The case the reference count existed for. Two dialogs, the first
    // closing: the count could get this wrong, a DOM query cannot.
    const closeA = openModal('a');
    const closeB = openModal('b');
    expect(getShortcutContext('dialogOpen')).toBe(true);
    closeA();
    expect(getShortcutContext('dialogOpen')).toBe(true);
    closeB();
    expect(getShortcutContext('dialogOpen')).toBe(false);
  });

  it('a non-modal dialog (aria-modal="false") leaves the shortcuts live', () => {
    // `first-run/Coachmark.tsx` annotates the page rather than trapping it.
    const node = document.createElement('div');
    node.setAttribute('role', 'dialog');
    node.setAttribute('aria-modal', 'false');
    document.body.append(node);
    expect(getShortcutContext('dialogOpen')).toBe(false);
  });
});
