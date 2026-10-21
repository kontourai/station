/**
 * #3419: the fixed text that tells a receiving engine a message is another
 * agent's, not the person's.
 *
 * Station delivers `send_to_session` text through a person-shaped channel (a
 * turn start or a steer), so without a frame the receiving model reads another
 * agent's words as the person's request. The frame is generated here, from
 * the server-verified sender, and the sender's text goes under it with every
 * line prefixed `> `.
 *
 * Why the sender cannot forge the frame: the header is one line made only of
 * fixed text and JSON-quoted, flattened sender fields (so no sender-controlled
 * character ends the line or the quote), and the body is only ever lines that
 * start with `> `. Whatever the text says, including a copy of this header or
 * "end of message", it stays inside a quoted line. Every line terminator JS
 * and Unicode know is treated as one, so a lone `\r` or U+2028 cannot start an
 * unquoted line either.
 *
 * `unframeAgentMessage` is the read-side inverse, for showing the sender's
 * own words. It is only ever applied to a turn whose server-recorded
 * `clientOrigin.sender` says another agent sent it; it never decides who sent
 * a message.
 */
import {
  type ClientOriginSender,
  clientOriginSender,
} from '@kontourai/station-contracts/client-origin';

const HEADER_OPEN = '[Station: a message from another agent Session';
const HEADER_CLOSE =
  ', not from the person. Its lines follow, each prefixed "> ".]';
const LINE_TERMINATORS = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/u;
const QUOTE = '> ';
/** A leading `[Timezone: ...]` line some clients prepend to a prompt. */
const TIMEZONE_PREFIX = /^\s*\[Timezone:\s*[^\]\n]*\]\s*/iu;

function header(sender: ClientOriginSender): string {
  const agent = sender.agent ?? sender.engine;
  const title = sender.title ? ` ${JSON.stringify(sender.title)}` : '';
  const who = `${agent ? `agent ${JSON.stringify(agent)}, ` : ''}id ${JSON.stringify(sender.sessionId)}`;
  return `${HEADER_OPEN}${title} (${who})${HEADER_CLOSE}`;
}

/** The text a receiving engine is given: the fixed header, then the quoted message. */
export function frameAgentMessage(
  sender: ClientOriginSender,
  text: string,
): string {
  const verified = clientOriginSender({ sender });
  if (!verified)
    throw new Error('A framed agent message needs a known sender.');
  const lines = text
    .split(LINE_TERMINATORS)
    .map((line) => (line.length === 0 ? '>' : `${QUOTE}${line}`));
  return `${header(verified)}\n${lines.join('\n')}`;
}

const JSON_STRING = '"(?:[^"\\\\]|\\\\.)*"';
const HEADER_LINE = new RegExp(
  `^${escapeRegExp(HEADER_OPEN)}(?: ${JSON_STRING})? \\((?:agent ${JSON_STRING}, )?id ${JSON_STRING}\\)${escapeRegExp(HEADER_CLOSE)}$`,
  'u',
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * The sender's own text out of a framed prompt, or undefined when the prompt
 * is not exactly a frame Station wrote (a person's text, an older turn, a
 * frame edited by something else). Undefined means "show the prompt as it is".
 */
export function unframeAgentMessage(prompt: string): string | undefined {
  const body = prompt.replace(TIMEZONE_PREFIX, '');
  const newline = body.indexOf('\n');
  if (newline < 0 || !HEADER_LINE.test(body.slice(0, newline)))
    return undefined;
  const lines = body.slice(newline + 1).split('\n');
  const unquoted: string[] = [];
  for (const line of lines) {
    if (line === '>') unquoted.push('');
    else if (line.startsWith(QUOTE)) unquoted.push(line.slice(QUOTE.length));
    else return undefined;
  }
  return unquoted.join('\n');
}

/**
 * A turn's input as a reader shows it: when the SERVER's `clientOrigin.sender`
 * says another agent sent it, that sender and the sender's own words out of
 * the frame; otherwise the prompt as it is. A prompt that is not exactly a
 * frame Station wrote still comes back with its sender: the provenance is the
 * claim, the frame is only how the engine was told. Nothing in the prompt
 * can make a message look like an agent's.
 */
export function agentMessageInput(event: {
  prompt?: string;
  threadId?: string;
  clientOrigin?: { sender?: unknown; actor?: { kind?: string } };
}): { sender?: ClientOriginSender; prompt: string | undefined } {
  const sender = clientOriginSender(event.clientOrigin);
  if (!sender)
    return {
      prompt: event.prompt,
      ...(event.clientOrigin?.actor?.kind === 'internal' && event.threadId
        ? {
            sender: {
              kind: 'unattributed' as const,
              sessionId: event.threadId,
            },
          }
        : {}),
    };
  return {
    sender,
    prompt: event.prompt
      ? (unframeAgentMessage(event.prompt) ?? event.prompt)
      : event.prompt,
  };
}
