/**
 * The reaction picker's catalogue: common emoji with the words people search
 * for. Any single emoji the server accepts can still arrive from another
 * client; this list only decides what the picker offers.
 */
export interface RoomEmoji {
  readonly emoji: string;
  /** Lowercase search words; the first is the emoji's name. */
  readonly words: string;
}
export interface RoomEmojiGroup {
  readonly label: string;
  readonly emoji: readonly RoomEmoji[];
}

const group = (label: string, entries: [string, string][]): RoomEmojiGroup => ({
  label,
  emoji: entries.map(([emoji, words]) => ({ emoji, words })),
});

export const ROOM_EMOJI_GROUPS: readonly RoomEmojiGroup[] = [
  group('Reactions', [
    ['👍', 'thumbs up yes approve like agree +1'],
    ['👎', 'thumbs down no disagree -1'],
    ['❤️', 'red heart love like'],
    ['😂', 'laughing tears joy funny lol'],
    ['🎉', 'party popper celebrate tada congrats'],
    ['👀', 'eyes looking watching see'],
    ['✅', 'check mark done complete yes'],
    ['🙏', 'folded hands thanks please pray'],
    ['🔥', 'fire hot lit great'],
    ['🚀', 'rocket ship launch fast'],
    ['💯', 'hundred perfect score'],
    ['👏', 'clapping hands applause bravo'],
    ['🙌', 'raising hands celebrate hooray'],
    ['💪', 'flexed biceps strong'],
    ['🤝', 'handshake deal agree'],
    ['👌', 'ok hand okay fine'],
    ['❌', 'cross mark no wrong cancel'],
    ['⚠️', 'warning caution careful'],
    ['❓', 'question mark ask unsure'],
    ['➕', 'plus add same'],
  ]),
  group('Smileys', [
    ['😀', 'grinning face smile happy'],
    ['😃', 'grinning big eyes smile happy'],
    ['😄', 'grinning smiling eyes happy'],
    ['😁', 'beaming grin'],
    ['😆', 'grinning squinting laugh'],
    ['😅', 'grinning sweat relief phew'],
    ['🤣', 'rolling on the floor laughing rofl'],
    ['😊', 'smiling blush happy'],
    ['😇', 'halo innocent angel'],
    ['🙂', 'slightly smiling'],
    ['🙃', 'upside down silly'],
    ['😉', 'winking wink'],
    ['😌', 'relieved calm'],
    ['😍', 'heart eyes love'],
    ['🥰', 'smiling hearts love'],
    ['😘', 'blowing kiss'],
    ['😋', 'yum tasty delicious'],
    ['😎', 'sunglasses cool'],
    ['🤓', 'nerd glasses geek'],
    ['🤩', 'star struck wow amazing'],
    ['🥳', 'partying face celebrate birthday'],
    ['😏', 'smirking smirk'],
    ['🤔', 'thinking hmm consider'],
    ['🤨', 'raised eyebrow skeptical'],
    ['😐', 'neutral face meh'],
    ['😑', 'expressionless blank'],
    ['😶', 'no mouth speechless'],
    ['🙄', 'rolling eyes eyeroll'],
    ['😬', 'grimacing awkward yikes'],
    ['🤐', 'zipper mouth secret quiet'],
    ['😴', 'sleeping tired zzz'],
    ['🤯', 'exploding head mind blown'],
    ['😳', 'flushed embarrassed'],
    ['🥺', 'pleading puppy eyes please'],
    ['😢', 'crying sad tear'],
    ['😭', 'loudly crying sob'],
    ['😱', 'screaming fear shock'],
    ['😤', 'steam nose frustrated'],
    ['😡', 'pouting angry mad'],
    ['🤗', 'hugging hug'],
    ['🤭', 'hand over mouth oops giggle'],
    ['🫡', 'saluting salute respect'],
    ['🫠', 'melting face'],
    ['😮', 'open mouth surprised wow'],
    ['🥲', 'smiling tear grateful'],
    ['🤷', 'shrug dunno whatever'],
    ['🤦', 'facepalm ugh'],
  ]),
  group('Hands', [
    ['👋', 'waving hand hello hi bye'],
    ['✋', 'raised hand stop wait'],
    ['🤚', 'raised back of hand'],
    ['🖐️', 'hand fingers splayed'],
    ['✌️', 'victory peace'],
    ['🤞', 'crossed fingers luck hope'],
    ['🤟', 'love you gesture'],
    ['🤘', 'horns rock'],
    ['🤙', 'call me hand shaka'],
    ['👈', 'pointing left'],
    ['👉', 'pointing right'],
    ['👆', 'pointing up above'],
    ['👇', 'pointing down below'],
    ['☝️', 'index pointing up one'],
    ['✍️', 'writing hand note'],
    ['🫶', 'heart hands love'],
    ['👐', 'open hands'],
    ['🤲', 'palms up together'],
  ]),
  group('Hearts', [
    ['🧡', 'orange heart'],
    ['💛', 'yellow heart'],
    ['💚', 'green heart'],
    ['💙', 'blue heart'],
    ['💜', 'purple heart'],
    ['🖤', 'black heart'],
    ['🤍', 'white heart'],
    ['💔', 'broken heart sad'],
    ['❤️‍🔥', 'heart on fire passion'],
    ['💖', 'sparkling heart'],
  ]),
  group('Objects', [
    ['⭐', 'star favorite'],
    ['✨', 'sparkles shiny new magic'],
    ['💡', 'light bulb idea'],
    ['📌', 'pushpin pin important'],
    ['📎', 'paperclip attach'],
    ['📝', 'memo note write'],
    ['📣', 'megaphone announce'],
    ['🔔', 'bell notify'],
    ['🔒', 'locked lock secure'],
    ['🔑', 'key access'],
    ['🛠️', 'hammer wrench tools fix'],
    ['🐛', 'bug insect defect'],
    ['🧪', 'test tube experiment'],
    ['📈', 'chart up increase growth'],
    ['📉', 'chart down decrease'],
    ['📅', 'calendar date'],
    ['⏰', 'alarm clock time late'],
    ['⏳', 'hourglass waiting'],
    ['☕', 'coffee break'],
    ['🍕', 'pizza food'],
    ['🎯', 'bullseye target goal'],
    ['🏆', 'trophy win award'],
    ['🎁', 'gift present'],
    ['💰', 'money bag'],
    ['🧠', 'brain smart'],
    ['🤖', 'robot bot agent'],
  ]),
  group('Symbols', [
    ['✔️', 'check mark yes'],
    ['☑️', 'check box ballot'],
    ['❗', 'exclamation important'],
    ['‼️', 'double exclamation'],
    ['🆗', 'ok button'],
    ['🆕', 'new button'],
    ['🔴', 'red circle'],
    ['🟡', 'yellow circle'],
    ['🟢', 'green circle'],
    ['🔵', 'blue circle'],
    ['⬆️', 'up arrow'],
    ['⬇️', 'down arrow'],
    ['➡️', 'right arrow'],
    ['🔁', 'repeat again'],
    ['🚫', 'prohibited no forbidden'],
    ['🛑', 'stop sign'],
    ['🏁', 'checkered flag finish'],
    ['🚩', 'red flag'],
  ]),
];

/** What Recent starts with before this viewer has picked anything. */
export const ROOM_DEFAULT_RECENT_EMOJI: readonly string[] = [
  '👍',
  '❤️',
  '😂',
  '🎉',
  '👀',
  '✅',
  '🙏',
  '🔥',
];

/** Emoji whose name or keywords start a word with each part of `query`. */
export function searchRoomEmoji(query: string): RoomEmoji[] {
  const parts = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!parts.length) return [];
  const seen = new Set<string>();
  const found: RoomEmoji[] = [];
  for (const { emoji } of ROOM_EMOJI_GROUPS)
    for (const entry of emoji) {
      if (seen.has(entry.emoji)) continue;
      const words = entry.words.split(' ');
      if (
        parts.every(
          (part) =>
            entry.emoji === part || words.some((word) => word.startsWith(part)),
        )
      ) {
        seen.add(entry.emoji);
        found.push(entry);
      }
    }
  return found;
}

const RECENT_KEY = 'station.room.recent-emoji';
const RECENT_LIMIT = 8;

/** This viewer's recent picks, newest first, padded with the defaults. */
export function readRecentRoomEmoji(): string[] {
  let stored: string[] = [];
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    if (Array.isArray(raw))
      stored = raw.filter(
        (value): value is string =>
          typeof value === 'string' && value.length <= 32,
      );
  } catch {
    // Storage may be unavailable (a private window); the defaults stand in.
  }
  return [...new Set([...stored, ...ROOM_DEFAULT_RECENT_EMOJI])].slice(
    0,
    RECENT_LIMIT,
  );
}

export function rememberRoomEmoji(emoji: string): void {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    const stored = Array.isArray(raw)
      ? raw.filter((value): value is string => typeof value === 'string')
      : [];
    localStorage.setItem(
      RECENT_KEY,
      JSON.stringify(
        [emoji, ...stored.filter((value) => value !== emoji)].slice(
          0,
          RECENT_LIMIT,
        ),
      ),
    );
  } catch {
    // A convenience only.
  }
}
