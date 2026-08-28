// The UI owns only presentation and subscription. Pairing-link admission is a
// shared Connect contract so CLI, QR, and native delivery cannot drift.
export {
  encodePairingDeepLink,
  type PairingDeepLinkChannel,
  type PairingDeepLinkParseResult,
  parsePairingDeepLink,
} from '@kontourai/station-connect';
