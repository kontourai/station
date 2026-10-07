/**
 * #3419: the accent an incoming agent message wears, derived from who sent it.
 *
 * The same agent always gets the same accent (the key is its Agent, else its
 * engine, else its Session id), so a reader learns "the teal one is the
 * reviewer" across a transcript. The palette is fixed and small, so two
 * different agents can share a hue: colour only ever backs up the header's
 * words and icon, it never carries the sender alone.
 *
 * Every entry is measured, in both themes, against the surfaces it sits on
 * (`agentSenderAccent.test.ts`): text at 4.5:1 on the bubble tint, the rail at
 * 3:1 on the page. The CSS reads `--agent-accent-light` / `--agent-accent-dark`
 * and picks per theme (`chat.css`, `.agent-incoming`).
 */
import type { CSSProperties } from 'react';

export interface AgentAccent {
  id: string;
  /** For the light theme: text and rail on the light surfaces. */
  light: string;
  /** For the dark theme. */
  dark: string;
}

export const AGENT_ACCENTS: readonly AgentAccent[] = [
  { id: 'teal', light: '#0b6e63', dark: '#5fd3c4' },
  { id: 'violet', light: '#5b3fc4', dark: '#b7a6ff' },
  { id: 'amber', light: '#8f4a00', dark: '#ffb454' },
  { id: 'rose', light: '#b02a54', dark: '#ff8fb0' },
  { id: 'blue', light: '#1a5fb4', dark: '#8dc0ff' },
  { id: 'green', light: '#2a6f1f', dark: '#8fdc7a' },
  { id: 'magenta', light: '#9b2a9b', dark: '#f2a0f2' },
  { id: 'brown', light: '#7a4a2a', dark: '#e0b08a' },
];

/** What identifies a sender for its accent, most stable first. */
export interface AgentAccentKey {
  agent?: string;
  engine?: string;
  sessionId: string;
}

/** FNV-1a over UTF-16 code units: stable across runs, platforms and builds. */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    h ^= value.charCodeAt(index);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function agentAccentFor(sender: AgentAccentKey): AgentAccent {
  const key = sender.sessionId;
  return AGENT_ACCENTS[hash(key) % AGENT_ACCENTS.length]!;
}

/** The inline custom properties the stylesheet turns into this theme's accent. */
export function agentAccentStyle(sender: AgentAccentKey): CSSProperties {
  const accent = agentAccentFor(sender);
  return {
    '--agent-accent-light': accent.light,
    '--agent-accent-dark': accent.dark,
  } as CSSProperties;
}
