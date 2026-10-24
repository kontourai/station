/**
 * A software WebAuthn authenticator that produces real `attestation: none`
 * registration responses (#3257). It builds the same bytes a platform
 * authenticator does: CBOR attestation object, authenticator data with the
 * RP ID hash and the user-present/user-verified flags, a COSE ES256 public
 * key, and the client data JSON. `@simplewebauthn/server` verifies them
 * through its normal path, so a test that passes here proves the real
 * verification, not a stub.
 *
 * Every knob a negative test needs is a parameter, so a test varies exactly
 * one thing: the origin the browser claims, the RP ID the authenticator
 * hashed, whether the user was verified, and the challenge signed.
 */
import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
} from 'node:crypto';

export interface RegistrationOptionsLike {
  readonly challenge: string;
  readonly rp: { readonly id?: string };
}

export interface SoftwareRegistrationInput {
  /** The origin the (honest or lying) browser puts in clientDataJSON. */
  readonly origin: string;
  /** Defaults to the options' RP ID; set to model a wrong-RP authenticator. */
  readonly rpId?: string;
  /** Defaults to true. False models an authenticator that skipped UV. */
  readonly userVerified?: boolean;
  /** Defaults to the options' challenge. */
  readonly challenge?: string;
  /** Sets `crossOrigin: true` in clientDataJSON (a framed ceremony). */
  readonly crossOrigin?: boolean;
}

function cborLength(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  return Buffer.from([(major << 5) | 25, length >> 8, length & 0xff]);
}

const cborBytes = (value: Buffer) =>
  Buffer.concat([cborLength(2, value.length), value]);
const cborText = (value: string) =>
  Buffer.concat([cborLength(3, value.length), Buffer.from(value, 'utf8')]);

export class SoftwareAuthenticator {
  readonly credentialId = randomBytes(32);
  readonly #privateKey: KeyObject;
  /** The ES256 public key as a DER SPKI, for assertions about what is stored. */
  readonly publicKeyDer: Buffer;
  readonly privateKeyDer: Buffer;
  readonly #x: Buffer;
  readonly #y: Buffer;

  constructor() {
    const { publicKey, privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
    });
    this.#privateKey = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.#x = Buffer.from(jwk.x as string, 'base64url');
    this.#y = Buffer.from(jwk.y as string, 'base64url');
    this.publicKeyDer = publicKey.export({ format: 'der', type: 'spki' });
    this.privateKeyDer = this.#privateKey.export({
      format: 'der',
      type: 'pkcs8',
    });
  }

  get credentialIdBase64Url(): string {
    return this.credentialId.toString('base64url');
  }

  authenticate(
    options: { challenge: string; rpId?: string },
    input: {
      origin: string;
      rpId?: string;
      userVerified?: boolean;
      userPresent?: boolean;
      counter?: number;
      challenge?: string;
    },
  ) {
    const clientData = Buffer.from(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: input.challenge ?? options.challenge,
        origin: input.origin,
        crossOrigin: false,
      }),
    );
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(input.counter ?? 1);
    const authenticatorData = Buffer.concat([
      createHash('sha256')
        .update(input.rpId ?? options.rpId ?? '')
        .digest(),
      Buffer.from([
        (input.userPresent === false ? 0 : 1) |
          (input.userVerified === false ? 0 : 4),
      ]),
      counter,
    ]);
    const signature = sign(
      'sha256',
      Buffer.concat([
        authenticatorData,
        createHash('sha256').update(clientData).digest(),
      ]),
      this.#privateKey,
    );
    return {
      id: this.credentialIdBase64Url,
      rawId: this.credentialIdBase64Url,
      type: 'public-key' as const,
      response: {
        clientDataJSON: clientData.toString('base64url'),
        authenticatorData: authenticatorData.toString('base64url'),
        signature: signature.toString('base64url'),
      },
      clientExtensionResults: {},
    };
  }

  register(
    options: RegistrationOptionsLike,
    input: SoftwareRegistrationInput,
  ): {
    id: string;
    rawId: string;
    type: 'public-key';
    response: {
      clientDataJSON: string;
      attestationObject: string;
      transports: string[];
    };
    clientExtensionResults: Record<string, never>;
  } {
    const rpId = input.rpId ?? options.rp.id ?? '';
    const flags =
      0x01 /* UP */ | (input.userVerified === false ? 0 : 0x04) | 0x40; /* AT */
    const coseKey = Buffer.concat([
      Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01]),
      Buffer.from([0x21]),
      cborBytes(this.#x),
      Buffer.from([0x22]),
      cborBytes(this.#y),
    ]);
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      createHash('sha256').update(rpId).digest(),
      Buffer.from([flags]),
      Buffer.alloc(4), // sign counter 0
      Buffer.alloc(16), // AAGUID: attestation none
      idLength,
      this.credentialId,
      coseKey,
    ]);
    const attestationObject = Buffer.concat([
      Buffer.from([0xa3]),
      cborText('fmt'),
      cborText('none'),
      cborText('attStmt'),
      Buffer.from([0xa0]),
      cborText('authData'),
      cborBytes(authData),
    ]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: 'webauthn.create',
        challenge: input.challenge ?? options.challenge,
        origin: input.origin,
        crossOrigin: input.crossOrigin ?? false,
      }),
      'utf8',
    );
    return {
      id: this.credentialIdBase64Url,
      rawId: this.credentialIdBase64Url,
      type: 'public-key',
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        attestationObject: attestationObject.toString('base64url'),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    };
  }
}
