import { describe, expect, it } from 'vitest';
import { Announcer, newLines } from '../../terminal-view/a11y/announcer';

function harness(intervalMs = 1000) {
  let now = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const spoken: string[] = [];
  const announcer = new Announcer((text) => spoken.push(text), {
    intervalMs,
    maxLength: 60,
    now: () => now,
    schedule: (fn, ms) => {
      const timer = { at: now + ms, fn };
      timers.push(timer);
      return timer;
    },
    cancel: (handle) => timers.splice(timers.indexOf(handle as never), 1),
  });
  const advance = (ms: number) => {
    now += ms;
    for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
      if (timer.at > now) continue;
      timers.splice(timers.indexOf(timer), 1);
      timer.fn();
    }
  };
  return { announcer, spoken, advance };
}

describe('Announcer', () => {
  it('coalesces a burst of output into one announcement', () => {
    const { announcer, spoken, advance } = harness();
    announcer.output(['first']);
    announcer.output(['second']);
    announcer.output(['third']);
    advance(0);
    expect(spoken).toEqual(['first second third']);
  });

  it('rate-limits a flood and summarizes what it dropped', () => {
    const { announcer, spoken, advance } = harness();
    announcer.output(['start']);
    advance(0);
    // A flooding command: hundreds of lines inside one interval.
    for (let i = 0; i < 500; i += 1) announcer.output([`y line ${i}`]);
    advance(500);
    expect(spoken).toHaveLength(1);
    advance(500);
    expect(spoken).toHaveLength(2);
    expect(spoken[1]!.length).toBeLessThan(120);
    expect(spoken[1]).toMatch(/\d+ more lines$/);
    // Nothing else queued: the flood produced exactly one more announcement.
    advance(5000);
    expect(spoken).toHaveLength(2);
  });

  it('never drops bell and exit events and does not repeat them', () => {
    const { announcer, spoken, advance } = harness();
    for (let i = 0; i < 300; i += 1) announcer.output([`noise ${i}`]);
    announcer.event('Bell');
    announcer.event('Bell');
    announcer.event('Process exited');
    advance(0);
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toMatch(/^Bell\. Process exited\./);
    expect(spoken[0]!.match(/Bell/g)).toHaveLength(1);
  });
});

describe('newLines', () => {
  it('announces only what scrolled in', () => {
    expect(newLines(['a', 'b', 'c', '$'], ['c', '$ ls', 'x', 'y'])).toEqual([
      '$ ls',
      'x',
      'y',
    ]);
    expect(newLines(['a', 'b', 'c'], ['b', 'c', 'd'])).toEqual(['d']);
  });

  it('announces only the rows a redraw in place changed', () => {
    expect(
      newLines(['top', 'progress 10%', 'end'], ['top', 'progress 20%', 'end']),
    ).toEqual(['progress 20%']);
    expect(newLines(['same', 'rows'], ['same', 'rows'])).toEqual([]);
  });
});
