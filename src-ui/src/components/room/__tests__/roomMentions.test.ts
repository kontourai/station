import { expect, test } from 'vitest';
import { roomMentionsIn, roomTypingLabel } from '../roomMentions';

const ann = { id: 'human:x:ann', name: 'Ann' };
const annLee = { id: 'human:x:annlee', name: 'Ann Lee' };

test('only picked people become mentions, in text order, by whole name', () => {
  expect(roomMentionsIn('@Ann and @Bob', [ann])).toEqual([
    { kind: 'person', actorId: ann.id, display: 'Ann', offset: 0 },
  ]);
  // A deleted mention names nobody; a name inside a word is not a mention.
  expect(roomMentionsIn('hi everyone', [ann])).toBeUndefined();
  expect(roomMentionsIn('@Annabel', [ann])).toBeUndefined();
  expect(roomMentionsIn('mail@Ann', [ann])).toBeUndefined();
  // The longer name wins where one starts another.
  expect(roomMentionsIn('@Ann Lee, then @Ann', [ann, annLee])).toEqual([
    { kind: 'person', actorId: annLee.id, display: 'Ann Lee', offset: 0 },
    { kind: 'person', actorId: ann.id, display: 'Ann', offset: 15 },
  ]);
});

test('typing reads as a short sentence', () => {
  expect(roomTypingLabel([])).toBe('');
  expect(roomTypingLabel(['Lin'])).toBe('Lin is typing…');
  expect(roomTypingLabel(['Lin', 'Ada'])).toBe('Lin and Ada are typing…');
  expect(roomTypingLabel(['Lin', 'Ada', 'Jo'])).toBe(
    'Several people are typing…',
  );
});
