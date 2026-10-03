import vm from 'node:vm';
/** @vitest-environment jsdom */
import { afterEach, expect, test, vi } from 'vitest';
import { createSkillExperiencePaneHost } from '../skill-experience-pane';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
});

function transport() {
  const iframe = document.createElement('iframe');
  document.body.append(iframe);
  const target = iframe.contentWindow!;
  const post = vi.spyOn(target, 'postMessage');
  const host = createSkillExperiencePaneHost(target, 'https://frame.test');
  const reply = (
    source: Window,
    origin: string,
    method: string,
    id: string,
    data?: unknown,
  ) =>
    window.dispatchEvent(
      new MessageEvent('message', {
        source,
        origin,
        data: { method, params: { id, data } },
      }),
    );
  return { target, post, host, reply };
}

test('frame reads settle only from the pinned WindowProxy and origin, with a correlated host result', async () => {
  const fixture = transport();
  try {
    const reading = fixture.host.read();
    const message = fixture.post.mock.calls[0]![0] as {
      method: string;
      params: { id: string };
    };
    expect(message.method).toBe('pane-host/experience-read');
    expect(fixture.post.mock.calls[0]![1]).toBe('https://frame.test');
    const json = JSON.stringify({ current: { eventId: 'canonical-event' } });
    fixture.reply(
      window,
      'https://frame.test',
      'pane-host/experience-result',
      message.params.id,
      { viewJson: 'forged sibling' },
    );
    fixture.reply(
      fixture.target,
      'https://other.test',
      'pane-host/experience-result',
      message.params.id,
      { viewJson: 'forged origin' },
    );
    fixture.reply(
      fixture.target,
      'https://frame.test',
      'pane-host/experience-result',
      message.params.id,
      { viewJson: json },
    );
    await expect(reading).resolves.toEqual({ viewJson: json });
  } finally {
    fixture.host.dispose();
  }
});

test('host refusals and frame disposal reject the waiting caller rather than claiming success', async () => {
  const fixture = transport();
  const answer = fixture.host.answer({
    requestId: 'question',
    requestEventId: 'question-event',
    answers: { answer: { optionIds: ['choice'] } },
  });
  const answered = expect(answer).rejects.toThrow('host refused');
  const message = fixture.post.mock.calls[0]![0] as { params: { id: string } };
  fixture.reply(
    fixture.target,
    'https://frame.test',
    'pane-host/refused',
    message.params.id,
  );
  await answered;
  const pending = fixture.host.read();
  const disposed = expect(pending).rejects.toThrow('frame was retired');
  fixture.host.dispose();
  await disposed;
  await expect(fixture.host.read()).rejects.toThrow('host is unavailable');
});

test('an unanswered frame request expires with an observable refusal', async () => {
  vi.useFakeTimers();
  const fixture = transport();
  try {
    const reading = fixture.host.read();
    const expired = expect(reading).rejects.toThrow('did not answer');
    await vi.advanceTimersByTimeAsync(30000);
    await expired;
  } finally {
    fixture.host.dispose();
  }
});

test('the published producer executes after serialization into the isolated document', async () => {
  const fixture = transport();
  fixture.host.dispose();
  const create = vm.runInNewContext(
    `(${createSkillExperiencePaneHost.toString()})`,
    {
      window,
      URL,
      setTimeout,
      clearTimeout,
    },
  ) as typeof createSkillExperiencePaneHost;
  const host = create(fixture.target, 'https://frame.test');
  try {
    const continued = host.continue({
      experienceId: 'next-stage',
      inputs: { idea: 'Review' },
    });
    const message = fixture.post.mock.calls[0]![0] as {
      method: string;
      params: { id: string; experienceId: string };
    };
    expect(message).toMatchObject({
      method: 'pane-host/experience-continue',
      params: { experienceId: 'next-stage' },
    });
    fixture.reply(
      fixture.target,
      'https://frame.test',
      'pane-host/experience-result',
      message.params.id,
    );
    await expect(continued).resolves.toBeUndefined();
  } finally {
    host.dispose();
  }
});
