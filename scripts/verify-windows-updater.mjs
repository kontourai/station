import { verifyTauriUpdaterSignature } from './lib/release-artifacts.mjs';

const [updater, signature] = process.argv.slice(2);
verifyTauriUpdaterSignature({
  updater,
  signature,
  updaterPublicKey: process.env.TAURI_SIGNING_PUBLIC_KEY,
});
