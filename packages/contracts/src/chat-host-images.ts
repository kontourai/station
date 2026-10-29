import type {
  ChatImageMimeType,
  PersistedChatAttachment,
} from './chat-attachment.js';

/**
 * Images an agent's reply names by host path (`![alt](/abs/path.png)`).
 *
 * The bytes live on the Station host, so a phone or any remote client cannot
 * read the path itself. When the `chat-host-images` Feature Preview is on,
 * Station reads each such image once, when the turn settles, from an admitted
 * location only, stores the bytes as a chat attachment bound to the thread,
 * and records which path became which attachment. The client then shows the
 * stored copy through `GET /api/attachments/:ref`, the same route and the same
 * read authorization as an image the user attached.
 */
export const CHAT_HOST_IMAGES_PREVIEW_ID = 'chat-host-images';

/** Why Station did not keep an image a reply named. Closed vocabulary. */
export type ChatHostImageRefusal =
  /** Not a plain absolute path: `..`, NUL, or longer than the path bound. */
  | 'invalid-path'
  /** Outside the session's working directory, verified worktrees and temp folder. */
  | 'outside-allowed-roots'
  | 'not-found'
  /** A directory, device or other non-regular file. */
  | 'not-a-file'
  /** The bytes are not a PNG, JPEG, GIF or WebP image (by content, not name). */
  | 'unsupported-image'
  /** Larger than the per-image byte limit. */
  | 'too-large'
  /** Wider, taller or more pixels than the decode limit. */
  | 'too-many-pixels'
  /** The reply named more images than one turn keeps. */
  | 'limit-reached'
  /** Inside a folder every user on the host can write to. */
  | 'shared-folder'
  /** The file has more than one hard link, so it may also live elsewhere. */
  | 'hard-linked'
  /** The read failed or the file changed while it was being read. */
  | 'unreadable'
  /** Read and valid, but the chat's attachment storage did not keep it. */
  | 'not-stored';

export const CHAT_HOST_IMAGE_REFUSALS: readonly ChatHostImageRefusal[] = [
  'invalid-path',
  'outside-allowed-roots',
  'not-found',
  'not-a-file',
  'unsupported-image',
  'too-large',
  'too-many-pixels',
  'limit-reached',
  'shared-folder',
  'hard-linked',
  'unreadable',
  'not-stored',
];

/**
 * One image destination the reply named, in reply order. Exactly one of
 * `attachmentIndex` (into the event's `attachments`) and `refused` is set.
 */
export interface ChatHostImageSource {
  /** The host path, as {@link hostImagePathFromDestination} normalizes it. */
  path: string;
  attachmentIndex?: number;
  refused?: ChatHostImageRefusal;
}

/** What the client needs to show one captured image. */
export interface ChatHostImage {
  blobRef: string;
  mimeType: ChatImageMimeType;
  name: string;
}

/** A turn's captured images and refusals, keyed by normalized host path. */
export interface ChatHostImageMap {
  images: Record<string, ChatHostImage>;
  refused: Record<string, ChatHostImageRefusal>;
}

/** Longest host path Station considers, matching the workspace preview bound. */
export const CHAT_HOST_IMAGE_MAX_PATH_LENGTH = 1024;

const RASTER_EXTENSION = /\.(?:png|jpe?g|gif|webp)$/i;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The host path an image destination names, or null when it names none.
 *
 * Shared by the server, which scans the raw markdown, and the client, which
 * sees the destination after the markdown renderer percent-encoded it: both
 * decode once, so a path with a space resolves to the same key on each side.
 * Accepts an absolute POSIX or Windows-drive path and a `file:` URL with an
 * empty or `localhost` host; drops a `#fragment`. Only raster extensions are
 * considered — the bytes are still checked by content before anything is kept.
 */
export function hostImagePathFromDestination(
  destination: string | undefined,
): string | null {
  if (!destination) return null;
  let value = destination.trim();
  if (/^file:/i.test(value)) {
    const match = /^file:\/\/(localhost)?(\/.*)$/i.exec(value);
    if (!match) return null;
    value = match[2];
    // `file:///C:/x` names a Windows drive path.
    if (/^\/[A-Za-z]:[\\/]/.test(value)) value = value.slice(1);
  } else if (
    /^[a-z][a-z0-9+.-]*:/i.test(value) &&
    !WINDOWS_ABSOLUTE.test(value)
  ) {
    return null;
  }
  const hash = value.indexOf('#');
  if (hash >= 0) value = value.slice(0, hash);
  value = decoded(value);
  if (value.startsWith('//')) return null;
  if (!value.startsWith('/') && !WINDOWS_ABSOLUTE.test(value)) return null;
  return RASTER_EXTENSION.test(value) ? value : null;
}

/** A turn's map from the `content.host-images` event that recorded it. */
export function chatHostImageMapFromEvent(event: {
  attachments?: PersistedChatAttachment[];
  sources?: ChatHostImageSource[];
}): ChatHostImageMap {
  const map: ChatHostImageMap = { images: {}, refused: {} };
  for (const source of event.sources ?? []) {
    if (typeof source?.path !== 'string') continue;
    const attachment =
      source.attachmentIndex === undefined
        ? undefined
        : event.attachments?.[source.attachmentIndex];
    if (attachment?.blobRef && attachment.kind === 'image') {
      map.images[source.path] = {
        blobRef: attachment.blobRef,
        mimeType: attachment.mimeType as ChatImageMimeType,
        name: attachment.name,
      };
    } else if (source.refused) {
      map.refused[source.path] = source.refused;
    } else if (attachment) {
      // An attachment the store kept as a descriptor only (no reference).
      map.refused[source.path] = 'not-stored';
    }
  }
  return map;
}

/** Plain-language reason, completing "Image not available on this device: …". */
export function chatHostImageRefusalText(
  reason: ChatHostImageRefusal | undefined,
): string {
  switch (reason) {
    case 'invalid-path':
      return 'the path is not a plain absolute path.';
    case 'outside-allowed-roots':
      return "it is outside this chat's working folder and temporary folder.";
    case 'not-found':
      return 'the file did not exist on the host when the reply finished.';
    case 'not-a-file':
      return 'the path is not a regular file.';
    case 'unsupported-image':
      return 'the file is not a PNG, JPEG, GIF or WebP image.';
    case 'too-large':
      return 'the image is larger than 512 KiB.';
    case 'too-many-pixels':
      return 'the image has too many pixels to show.';
    case 'limit-reached':
      return 'the reply named more images than one turn keeps.';
    case 'shared-folder':
      return 'it is in a folder every user on the host can write to.';
    case 'hard-linked':
      return 'the file has more than one hard link.';
    case 'unreadable':
      return 'the host could not read the file.';
    case 'not-stored':
      return "this chat's attachment storage could not keep it.";
    default:
      return 'Station did not copy it from the host.';
  }
}
