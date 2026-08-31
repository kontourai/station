# First Play and App Store entry

Owner checklist for getting a signed Station build onto Play Internal testing
and TestFlight. This is not a release-readiness claim. Store consoles remain
the source of truth for whether testers can install a build.

The tag pipeline is documented in [native-releases.md](./native-releases.md)
and [mobile-release.md](./mobile-release.md). Listing copy lives in
[store-listing.md](./store-listing.md).

## Repository and workflow contract

- iOS channel bundle IDs: `io.kontourai.station`,
  `io.kontourai.station.beta`, and `io.kontourai.station.nightly`. They are
  three installable apps, not TestFlight tracks of one app.
- App Store Connect listing names are **Station by Kontour AI**, **Station Beta
  by Kontour AI**, and **Station Nightly by Kontour AI**. Installed app names
  remain Station, Station Beta, and Station Nightly; seller is Kontour AI LLC.
- Privacy policy URL: https://kontourai.io/privacy/station/
- Support URL source: https://kontourai.io/support/ — verify the live response
  before submitting a listing
- Play Data Safety answers: [play-data-safety.md](../reference/play-data-safety.md)
- iOS delivery uses protected GitHub Environments `native-release` (Stable),
  `ios-beta`, and `ios-nightly`. Each environment owns its matching
  provisioning profile and the non-secret `TESTFLIGHT_INTERNAL_GROUP_ID`.
  The distribution certificate and App Store Connect API key may be shared,
  but every channel preflights its own App Store Connect app and group before
  signing. Query their current protection configuration; this guide does not
  claim live environment state.
- Tag overlay derives Android `versionCode` and iOS `CFBundleVersion` from the
  tag. Do not hand-edit `1` / `1.0` fallbacks in Gradle for a store upload.

Before starting a release train, query current GitHub releases/tags and compare
them with `package.json`; never choose the next version from examples in a
guide. The train must use a new `MAJOR.MINOR.PATCH` base. Preflight requires
both `vMAJOR.MINOR.PATCH-preview.N` and `vMAJOR.MINOR.PATCH` tags to match that
same base version. Preview numbering belongs to the tag/build overlay, so an
accepted preview commit can be promoted to Stable without a source edit.

## 1. Apple (one-time)

1. Register each of the three channel bundle IDs above.
2. Create one matching app record and one explicit internal TestFlight group
   per channel. The API cannot create apps or tester groups.
3. Create an **App Store distribution** provisioning profile per bundle ID. Ad-hoc and
   development profiles fail the release job.
4. Export the iOS Distribution certificate (`.p12`) and its password.
5. Generate an App Store Connect Team API key (App Manager). Download the
   `.p8` once and store it off this repository.

## 2. Google Play (one-time)

1. Create application `io.kontourai.station`.
2. Paste the privacy URL, support URL, and Data Safety answers. Complete
   content rating, target audience, and the ads declaration (no ads).
3. Create a Cloud service account with no project roles, enable the Play
   Developer API, and authorize GitHub through Workload Identity Federation.
   Invite the service account to Play with **Release apps to testing tracks**
   only. Do not create a JSON service-account key.
4. Generate an upload keystore and keep an owner-only recovery copy. Play App
   Signing holds the app-signing key; this replaceable upload key authorizes
   new bundles.

```sh
keytool -genkeypair -v \
  -keystore station-upload.keystore \
  -alias station \
  -storetype PKCS12 \
  -keyalg RSA -keysize 4096 -validity 10000
```

Store its base64 bytes and password in Google Secret Manager as
`station-android-upload-keystore-base64` and
`station-android-upload-keystore-password`. Grant the keyless publisher service
account Secret Accessor on only those two secrets. Set the secret-free GitHub
repository variable `ANDROID_UPLOAD_KEY_ALIAS=station`. Do not put Android
signing material in GitHub secrets.

## 3. Deposit Apple secrets in their matching environments

Use environment secrets, not repository secrets.

```sh
# iOS signing (required for a signed App Store IPA)
for env in native-release ios-beta ios-nightly; do
  gh secret set APPLE_IOS_DISTRIBUTION_CERTIFICATE_BASE64 --repo kontourai/station --env "$env"
  gh secret set APPLE_IOS_DISTRIBUTION_CERTIFICATE_PASSWORD --repo kontourai/station --env "$env"
  gh secret set APPLE_DEVELOPMENT_TEAM --repo kontourai/station --env "$env"
  gh secret set APPLE_IOS_SIGNING_IDENTITY --repo kontourai/station --env "$env"
  gh secret set APPLE_PROVISIONING_PROFILE_BASE64 --repo kontourai/station --env "$env"
done

# TestFlight upload (required for each configured channel; absent credentials
# fail the channel before signing or upload)
for env in native-release ios-beta ios-nightly; do
  gh secret set APPLE_API_KEY_ID --repo kontourai/station --env "$env"
  gh secret set APPLE_API_ISSUER_ID --repo kontourai/station --env "$env"
  gh secret set APPLE_API_PRIVATE_KEY --repo kontourai/station --env "$env"
  gh variable set TESTFLIGHT_INTERNAL_GROUP_ID --repo kontourai/station --env "$env"
done
```

Desktop Developer ID, Authenticode, and Tauri updater keys are a separate
product. Skip them if this month is mobile beta only; those desktop jobs will
fail closed until they exist.

## 4. First binaries

Play will not accept an API upload until one AAB has been uploaded by hand.
After the first signed AAB exists (local `tauri android build` or the first
tag that gets past Android signing):

1. Upload that AAB to Play → Testing → Internal testing.
2. Add testers.
3. Later tags use the keyless GitHub OIDC service account.

Stable tags call the Stable delivery lane; preview tags call the Beta lane;
the scheduled Nightly uses the same reserved day/index build number as its
Android build. Every lane first reconciles the exact App Store build number:
an absent build uploads once, PROCESSING is polled, VALID is receipted without
a duplicate upload, and any other or ambiguous state fails closed. Receipts
retain the source SHA, IPA digest, provider app/build IDs, processing state,
and workflow URL. Tester email lists remain in Apple custody, never this
public repository.

For an owner-side, no-upload readiness check, decode the channel profile only
through the repository command (it verifies the channel's fixed bundle/listing
authority and group ID before any App Store request):

```sh
node scripts/ios-testflight-readiness.mjs --channel beta \
  --station /owner-only/Station-Beta.mobileprovision \
  --team TEAM_ID --group-id APP_STORE_CONNECT_GROUP_ID
```

Run it once per `stable`, `beta`, and `nightly`; it never contains tester
emails or credentials in source or output.

## 5. Tag only after secrets exist

```sh
git fetch origin main
git switch --detach origin/main
# package.json must carry this release train's unused stable base version
release_version=X.Y.Z # replace with the unused package.json version
git tag -s "v$release_version" -m "Station v$release_version"
git push origin "v$release_version"
```

Confirm in the job logs that Play / TestFlight either uploaded or printed the
documented skip notice — not a missing-keystore or missing-environment
failure. Then confirm the build in the consoles.

## Not this checklist

- Making the GitHub repository public (#1978)
- Custom `updates.kontourai.io` feed (#2211)
- Wrapping this process in a Flow (#1769)
- Apple 4.2 unpaired first-launch for **external** review (#1772)
