// @vitest-environment jsdom

import { describe, expect, test } from 'vitest';
import {
  captureChatScrollAnchor,
  restoreChatScrollAnchor,
} from '../components/chat/chatScrollAnchor';

function rect(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: 0,
    right: 100,
    width: 100,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('mobile chat scroll anchor', () => {
  test('restores the same visible message and pixel offset after layout movement', () => {
    const container = document.createElement('div');
    const before = document.createElement('div');
    const anchor = document.createElement('div');
    before.dataset.chatMessageKey = 'before';
    anchor.dataset.chatMessageKey = 'anchor';
    container.append(before, anchor);
    container.getBoundingClientRect = () => rect(100, 500);
    before.getBoundingClientRect = () => rect(20, 90);
    let anchorTop = 115;
    anchor.getBoundingClientRect = () => rect(anchorTop, anchorTop + 80);
    container.scrollTop = 240;

    const saved = captureChatScrollAnchor(container);
    expect(saved).toEqual({ key: 'anchor', offset: 15 });
    anchorTop = 147;
    expect(restoreChatScrollAnchor(container, saved!)).toBe(true);
    expect(container.scrollTop).toBe(272);
  });
});
