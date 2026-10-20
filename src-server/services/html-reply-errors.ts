type HtmlReplyRefusalReason =
  | 'HTML reply images must be PNG, JPEG, GIF or WebP'
  | 'HTML reply source exceeds 256 KiB'
  | 'HTML reply height must be an integer from 100 to 2000'
  | 'HTML reply exceeds 32 distinct images'
  | 'HTML reply image is outside the authorized workspace'
  | 'HTML reply image must be a regular file'
  | 'HTML reply image exceeds 2 MiB'
  | 'HTML reply page exceeds 8 MiB'
  | 'HTML preview concurrency limit exceeded'
  | 'HTML preview width must be 320–1920'
  | 'HTML preview needs Chromium. Install it through the Browser workspace first.'
  | 'HTML preview exceeded 15 seconds'
  | 'HTML preview expired'
  | 'HTML preview requires effective WebRTC policy disable_non_proxied_udp without URL overrides. This browser is unsupported or enterprise policy overrides the profile.'
  | 'HTML preview bootstrap failed'
  | 'HTML preview measurement failed'
  | 'HTML preview content height exceeds 2000 pixels or is invalid'
  | 'HTML preview console exceeds 128 entries or 64 KiB'
  | 'HTML preview screenshot exceeds 8 MiB'
  | 'HTML preview console exceeds its limit'
  | 'HTML reply session no longer exists'
  | 'Invalid HTML reply page'
  | 'HTML reply conversation exceeds 32 pages or 32 MiB';

/** Fixed public refusals; arbitrary browser and filesystem errors stay internal. */
export class HtmlReplyRefusal extends Error {
  constructor(readonly reason: HtmlReplyRefusalReason) {
    super(reason);
    this.name = 'HtmlReplyRefusal';
  }
}
