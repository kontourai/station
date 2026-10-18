import {
  constants,
  createHash,
  generateKeyPairSync,
  privateEncrypt,
  sign,
  verify,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import forgery from './fixtures/node-forge-public-only-forgery.json';

interface Digest {
  update(message: string): Digest;
  digest(): { getBytes(): string };
}
interface ForgeApi {
  md: { sha256: { create(): Digest } };
  pki: {
    publicKeyFromPem(pem: string): {
      verify(digest: string, signature: string): boolean;
    };
  };
}

const require = createRequire(resolve('package.json'));
const root = dirname(require.resolve('node-forge/package.json'));
const source: ForgeApi = require('node-forge');
function bundle(file: string): ForgeApi {
  const window: { forge?: ForgeApi } = {};
  runInNewContext(readFileSync(join(root, file), 'utf8'), {
    window,
    jQuery: null,
    setTimeout,
    clearTimeout,
  });
  if (!window.forge) throw new Error(`${file} did not load its public API`);
  return window.forge;
}
const entrypoints = [
  { name: 'package entrypoint', forge: source },
  { name: 'browser bundle', forge: bundle('dist/forge.min.js') },
  { name: 'full browser bundle', forge: bundle('dist/forge.all.min.js') },
];
const keys = [3, 65537].map((publicExponent) => ({
  publicExponent,
  ...generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent }),
}));

describe.each(entrypoints)('installed node-forge $name', ({ forge }) => {
  it('preserves DigestAlgorithm with omitted optional NULL parameters', () => {
    const message = 'RSA DigestAlgorithm without parameters';
    const digest = createHash('sha256').update(message).digest();
    const signature = privateEncrypt(
      { key: keys[1].privateKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.concat([
        Buffer.from('302f300b06096086480165030402010420', 'hex'),
        digest,
      ]),
    );
    const key = forge.pki.publicKeyFromPem(
      keys[1].publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    );
    expect(
      key.verify(digest.toString('binary'), signature.toString('binary')),
    ).toBe(true);
  });
  it.each(keys)(
    'preserves valid SHA-256 signatures with exponent $publicExponent',
    ({ publicKey, privateKey }) => {
      const message = 'Station RSA compatibility';
      const signature = sign('sha256', Buffer.from(message), privateKey);
      expect(verify('sha256', Buffer.from(message), publicKey, signature)).toBe(
        true,
      );
      const key = forge.pki.publicKeyFromPem(
        publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      );
      const digest = (text: string) =>
        forge.md.sha256.create().update(text).digest().getBytes();
      expect(key.verify(digest(message), signature.toString('binary'))).toBe(
        true,
      );
      expect(
        key.verify(digest(`${message}!`), signature.toString('binary')),
      ).toBe(false);
    },
  );

  it('rejects the public-key-only nested DigestAlgorithm forgery', () => {
    const signature = Buffer.from(forgery.signature, 'hex');
    expect(
      verify(
        'sha256',
        Buffer.from(forgery.message),
        forgery.publicKey,
        signature,
      ),
    ).toBe(false);
    const key = forge.pki.publicKeyFromPem(forgery.publicKey);
    const digest = forge.md.sha256
      .create()
      .update(forgery.message)
      .digest()
      .getBytes();
    expect(() => key.verify(digest, signature.toString('binary'))).toThrow(
      /valid RSASSA-PKCS1-v1_5 DigestInfo/,
    );
  });
});
