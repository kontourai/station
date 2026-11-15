/** A person picked from the `@` list while writing (#4799). */
export interface RoomMentionPerson {
  readonly id: string;
  readonly name: string;
}

/**
 * The structured mentions of `text`: each `@Name` of a person picked while
 * writing, in text order and never overlapping. A name typed by hand is
 * text, not a mention, and a picked name the writer then deleted names
 * nobody. Longer names win where one name starts another (`@Ann Lee` over
 * `@Ann`).
 */
export function roomMentionsIn(
  text: string,
  people: readonly RoomMentionPerson[] | undefined,
) {
  if (!people?.length) return undefined;
  const found: {
    kind: 'person';
    actorId: string;
    display: string;
    offset: number;
  }[] = [];
  const ordered = [...people].sort((a, b) => b.name.length - a.name.length);
  const taken: [number, number][] = [];
  for (const person of ordered) {
    const token = `@${person.name}`;
    for (
      let at = text.indexOf(token);
      at >= 0;
      at = text.indexOf(token, at + token.length)
    ) {
      const end = at + token.length;
      // A whole name: not the start of a longer word.
      if (/[\p{L}\p{N}_]/u.test(text.charAt(end))) continue;
      if (at > 0 && /[\p{L}\p{N}_]/u.test(text.charAt(at - 1))) continue;
      if (taken.some(([start, stop]) => at < stop && end > start)) continue;
      taken.push([at, end]);
      found.push({
        kind: 'person',
        actorId: person.id,
        display: person.name,
        offset: at,
      });
    }
  }
  found.sort((a, b) => a.offset - b.offset);
  return found.length ? found.slice(0, 32) : undefined;
}

/** "Lin is typing…", "Lin and Ada are typing…", "Several people are typing…". */
export function roomTypingLabel(names: readonly string[]) {
  if (!names.length) return '';
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return 'Several people are typing…';
}
