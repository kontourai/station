import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENT_MAX_COUNT,
  CHAT_ATTACHMENT_MAX_NAME_LENGTH,
  CHAT_ATTACHMENT_MAX_TOTAL_BYTES,
  CHAT_IMAGE_MIME_TYPES,
} from '@kontourai/station-contracts/chat-attachment';
import { describe, expect, it } from 'vitest';

/**
 * A drift pin, not behavior proof: the native plugins cannot import the
 * contract, so they copy its bounds and image types. This holds each copy to
 * the contract value. The bounds' behavior is proven by the Kotlin unit tests
 * (ImageIntakeTest) and the iOS build; the web layer validates every payload
 * again with `parseNativeSharedImagePayload`.
 */
const plugin = resolve(
  import.meta.dirname,
  '../../../../../src-desktop/plugins/media-intake',
);
const kotlin = readFileSync(
  `${plugin}/android/src/main/java/io/kontourai/station/mediaintake/ImageIntake.kt`,
  'utf8',
);
const swift = readFileSync(
  `${plugin}/ios/Sources/MediaIntakePlugin.swift`,
  'utf8',
);

function evaluate(expression: string | undefined): number {
  if (!expression || !/^[\d\s*]+$/.test(expression))
    throw new Error(`not a literal product: ${expression}`);
  return expression
    .split('*')
    .map((factor) => Number(factor.trim()))
    .reduce((product, factor) => product * factor, 1);
}

const kotlinConst = (name: string) =>
  evaluate(new RegExp(`const val ${name} = ([^\\n]+)`).exec(kotlin)?.[1]);
const swiftLet = (name: string) =>
  evaluate(new RegExp(`let ${name} = ([^\\n]+)`).exec(swift)?.[1]);

describe('media-intake native copies of the chat-attachment contract', () => {
  it('pins the contract literals these copies are compared with', () => {
    expect(CHAT_ATTACHMENT_MAX_COUNT).toBe(5);
    expect(CHAT_ATTACHMENT_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(CHAT_ATTACHMENT_MAX_TOTAL_BYTES).toBe(15 * 1024 * 1024);
    expect(CHAT_ATTACHMENT_MAX_NAME_LENGTH).toBe(160);
  });

  it('Kotlin bounds equal the contract', () => {
    expect(kotlinConst('MAX_IMAGE_COUNT')).toBe(CHAT_ATTACHMENT_MAX_COUNT);
    expect(kotlinConst('MAX_IMAGE_BYTES')).toBe(CHAT_ATTACHMENT_MAX_BYTES);
    expect(kotlinConst('MAX_TOTAL_IMAGE_BYTES')).toBe(
      CHAT_ATTACHMENT_MAX_TOTAL_BYTES,
    );
    expect(kotlinConst('MAX_IMAGE_NAME_LENGTH')).toBe(
      CHAT_ATTACHMENT_MAX_NAME_LENGTH,
    );
  });

  it('Swift bounds equal the contract', () => {
    expect(swiftLet('maxImageCount')).toBe(CHAT_ATTACHMENT_MAX_COUNT);
    expect(swiftLet('maxImageBytes')).toBe(CHAT_ATTACHMENT_MAX_BYTES);
    expect(swiftLet('maxTotalImageBytes')).toBe(
      CHAT_ATTACHMENT_MAX_TOTAL_BYTES,
    );
  });

  it('both sniffers deliver exactly the contract image types', () => {
    const delivered = (source: string) =>
      [...source.matchAll(/return "(image\/[a-z]+)"/g)]
        .map((match) => match[1])
        .sort();
    const contract = [...CHAT_IMAGE_MIME_TYPES].sort();
    expect(delivered(kotlin)).toEqual(contract);
    expect(delivered(swift)).toEqual(contract);
  });
});
