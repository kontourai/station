import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HTML_REPLY_LIMITS,
  type HtmlReplyPage,
} from '@kontourai/station-contracts/html-reply';
import { HtmlReplyRefusal } from './html-reply-errors.js';

function imageMime(bytes: Buffer): string {
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return 'image/jpeg';
  if (/^GIF8[79]a/.test(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  throw new HtmlReplyRefusal(
    'HTML reply images must be PNG, JPEG, GIF or WebP',
  );
}

/**
 * Prepare immutable page bytes before persistence. The caller owns imageRoot;
 * it must come from the authorized workspace, never from public tool input.
 * Quoted absolute image paths work in src, CSS url(), and JS strings. This
 * deliberately does not evaluate JavaScript or fetch remote resources.
 */
export async function prepareHtmlReply(
  input: { html: string; height: number },
  imageRoot: string,
): Promise<HtmlReplyPage> {
  if (Buffer.byteLength(input.html) > HTML_REPLY_LIMITS.sourceBytes)
    throw new HtmlReplyRefusal('HTML reply source exceeds 256 KiB');
  if (
    !Number.isInteger(input.height) ||
    input.height < HTML_REPLY_LIMITS.minHeight ||
    input.height > HTML_REPLY_LIMITS.maxHeight
  )
    throw new HtmlReplyRefusal(
      'HTML reply height must be an integer from 100 to 2000',
    );
  const root = await realpath(imageRoot);
  const images = new Map<string, string>();
  // Only literal, quoted image references are supported. No HTML/JS execution
  // is involved in reading files. Unrecognized references remain CSP-blocked.
  const references = [
    ...input.html.matchAll(
      /(["'`])((?:file:\/\/\/|\/|[A-Za-z]:[\\/])[^"'`\r\n<>]*?\.(?:png|jpe?g|gif|webp))\1/gi,
    ),
  ];
  let pageBytes = Buffer.byteLength(input.html);
  for (const match of references) {
    const source = match[2];
    if (source.startsWith('//')) continue;
    let embedded = images.get(source);
    if (!embedded) {
      if (images.size >= HTML_REPLY_LIMITS.images)
        throw new HtmlReplyRefusal('HTML reply exceeds 32 distinct images');
      const path = source.startsWith('file:') ? fileURLToPath(source) : source;
      const canonical = await realpath(path);
      const within = relative(root, canonical);
      if (
        isAbsolute(within) ||
        within === '..' ||
        within.startsWith(`..${sep}`)
      )
        throw new HtmlReplyRefusal(
          'HTML reply image is outside the authorized workspace',
        );
      const file = await open(
        canonical,
        constants.O_RDONLY |
          (constants.O_NONBLOCK ?? 0) |
          (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const stat = await file.stat();
        if (!stat.isFile())
          throw new HtmlReplyRefusal('HTML reply image must be a regular file');
        if (stat.size > HTML_REPLY_LIMITS.imageBytes)
          throw new HtmlReplyRefusal('HTML reply image exceeds 2 MiB');
        // One extra byte catches growth after stat; never publish a prefix.
        const bytes = Buffer.alloc(HTML_REPLY_LIMITS.imageBytes + 1);
        let length = 0;
        while (length < bytes.length) {
          const result = await file.read(
            bytes,
            length,
            bytes.length - length,
            null,
          );
          if (!result.bytesRead) break;
          length += result.bytesRead;
        }
        if (length > HTML_REPLY_LIMITS.imageBytes)
          throw new HtmlReplyRefusal('HTML reply image exceeds 2 MiB');
        const content = bytes.subarray(0, length);
        embedded = `data:${imageMime(content)};base64,${content.toString('base64')}`;
        images.set(source, embedded);
      } finally {
        await file.close();
      }
    }
    pageBytes += Buffer.byteLength(embedded) - Buffer.byteLength(source);
    if (pageBytes > HTML_REPLY_LIMITS.pageBytes)
      throw new HtmlReplyRefusal('HTML reply page exceeds 8 MiB');
  }
  const html = input.html.replace(
    /(["'`])((?:file:\/\/\/|\/|[A-Za-z]:[\\/])[^"'`\r\n<>]*?\.(?:png|jpe?g|gif|webp))\1/gi,
    (whole, quote: string, source: string) =>
      images.has(source) ? `${quote}${images.get(source)}${quote}` : whole,
  );
  return { version: 1, html, height: input.height };
}
