/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FOCUSABLE_SELECTOR, wrapTabFocus } from '../focusable';

function mount(html: string): HTMLElement[] {
  document.body.innerHTML = html;
  return Array.from(
    document.body.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  );
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('FOCUSABLE_SELECTOR', () => {
  it('reaches every form control and link, and skips disabled or unfocusable ones', () => {
    const controls = mount(`
      <button id="b">b</button>
      <button id="off" disabled>off</button>
      <a id="a" href="/x">a</a>
      <input id="i" />
      <select id="s"><option>one</option></select>
      <textarea id="t"></textarea>
      <fieldset disabled><input id="inside-disabled-fieldset" /></fieldset>
      <div id="tab" tabindex="0"></div>
      <div id="skipped" tabindex="-1"></div>
    `);
    expect(controls.map((control) => control.id)).toEqual([
      'b',
      'a',
      'i',
      's',
      't',
      'tab',
    ]);
  });
});

describe('wrapTabFocus', () => {
  const tab = (shiftKey: boolean) => ({ shiftKey, preventDefault: vi.fn() });

  it('wraps Tab on the last control to the first, and Shift+Tab on the first to the last', () => {
    const controls = mount(
      '<button id="first">1</button><button id="mid">2</button><button id="last">3</button>',
    );
    const [first, , last] = controls;

    last.focus();
    const forward = tab(false);
    expect(wrapTabFocus(forward, controls)).toBe(true);
    expect(forward.preventDefault).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(first);

    const backward = tab(true);
    expect(wrapTabFocus(backward, controls)).toBe(true);
    expect(backward.preventDefault).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(last);
  });

  it('leaves a Tab between the ends, or with nothing to reach, to the browser', () => {
    const controls = mount(
      '<button id="first">1</button><button id="mid">2</button><button id="last">3</button>',
    );
    controls[1].focus();
    const middle = tab(false);
    expect(wrapTabFocus(middle, controls)).toBe(false);
    expect(middle.preventDefault).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(controls[1]);

    const empty = tab(false);
    expect(wrapTabFocus(empty, [])).toBe(false);
    expect(empty.preventDefault).not.toHaveBeenCalled();
  });
});
