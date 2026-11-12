/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TOUCH_KEYBOARD_QUERY } from '../composerKeys';
import { RoomComposer } from '../RoomComposer';
import {
  type RoomMentionCandidate,
  RoomMentionPicker,
  useRoomMention,
} from '../RoomMentionPicker';
import { useRoomDraft } from '../useRoomDraft';

let touch = false;
beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query === TOUCH_KEYBOARD_QUERY ? touch : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  touch = false;
});

function Composer({
  room,
  onSend,
}: {
  room: string;
  onSend: (text: string) => void;
}) {
  const [value, setValue] = useRoomDraft(`test:${room}`);
  return (
    <RoomComposer
      id="composer"
      label="Message the room"
      placeholder="Message"
      value={value}
      onValueChange={(next) => setValue(next)}
      onSend={() => onSend(value)}
      canSend={!!value.trim()}
      sendLabel="Send message"
    />
  );
}

function Rooms({ onSend }: { onSend: (text: string) => void }) {
  const [room, setRoom] = useState('general');
  return (
    <>
      <button type="button" onClick={() => setRoom('general')}>
        general
      </button>
      <button type="button" onClick={() => setRoom('design')}>
        design
      </button>
      <Composer room={room} onSend={onSend} />
    </>
  );
}

const PICKER_CANDIDATES: RoomMentionCandidate[] = [
  { id: 'scout', name: 'Scout', agent: true, ready: true },
];
function Picker({
  onPick,
  onSend,
}: {
  onPick: (candidate: RoomMentionCandidate) => void;
  onSend: () => void;
}) {
  const [value, setValue] = useState('');
  const mention = useRoomMention({
    candidates: PICKER_CANDIDATES,
    enabled: true,
    onPick,
  });
  return (
    <RoomComposer
      id="picker"
      label="Message the room"
      placeholder="Message"
      value={value}
      onValueChange={(next, caret) => {
        setValue(next);
        mention.find(next, caret);
      }}
      onSend={onSend}
      canSend={!!value.trim()}
      sendLabel="Send message"
      inputProps={{ onKeyDown: mention.onKeyDown }}
      below={
        <RoomMentionPicker
          id="picker-mentions"
          state={mention}
          onClearQuery={() => {}}
        />
      }
    />
  );
}

const field = () =>
  screen.getByRole<HTMLTextAreaElement>('textbox', {
    name: 'Message the room',
  });

describe('RoomComposer', () => {
  test('on a hardware keyboard Enter sends; Shift+Enter and composition do not', () => {
    const onSend = vi.fn();
    render(<Rooms onSend={onSend} />);
    fireEvent.change(field(), { target: { value: 'Ship it' } });
    fireEvent.keyDown(field(), { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(field(), { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
    const enter = fireEvent.keyDown(field(), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledExactlyOnceWith('Ship it');
    // Enter that sends does not also insert a line.
    expect(enter).toBe(false);
  });

  test('on a touch keyboard Return adds a line and only the round button sends', () => {
    touch = true;
    const onSend = vi.fn();
    render(<Rooms onSend={onSend} />);
    fireEvent.change(field(), { target: { value: 'Ship it' } });
    const returned = fireEvent.keyDown(field(), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    // The browser's default (a new line) is left alone.
    expect(returned).toBe(true);
    expect(field().getAttribute('enterkeyhint')).toBe('enter');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith('Ship it');
  });

  test('a draft is kept per room, across switching rooms and a reload', () => {
    const view = render(<Rooms onSend={vi.fn()} />);
    fireEvent.change(field(), { target: { value: 'General draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'design' }));
    expect(field().value).toBe('');
    fireEvent.change(field(), { target: { value: 'Design draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'general' }));
    expect(field().value).toBe('General draft');
    // A reload mounts from nothing but the tab's storage.
    view.unmount();
    render(<Rooms onSend={vi.fn()} />);
    expect(field().value).toBe('General draft');
    fireEvent.click(screen.getByRole('button', { name: 'design' }));
    expect(field().value).toBe('Design draft');
  });

  test('the send button is round and named, and disabled until there is text', () => {
    render(<Rooms onSend={vi.fn()} />);
    const send = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Send message',
    });
    expect(send.disabled).toBe(true);
    fireEvent.change(field(), { target: { value: 'x' } });
    expect(send.disabled).toBe(false);
  });

  test('a composition Enter never picks from the @ list (#4810 review 4)', () => {
    const onPick = vi.fn();
    const onSend = vi.fn();
    render(<Picker onPick={onPick} onSend={onSend} />);
    fireEvent.change(field(), { target: { value: '@' } });
    expect(
      screen.getByRole('option', { name: /^Scout Agent @scout\b/ }),
    ).toBeTruthy();
    // Safari and some IMEs report composition only as keyCode 229.
    fireEvent.keyDown(field(), { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(field(), { key: 'Enter', isComposing: true });
    expect(onPick).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(onPick).toHaveBeenCalledOnce();
  });
});
