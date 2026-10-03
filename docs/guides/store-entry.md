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
- Intended App Store Connect listing names are **Station by Kontour AI**, **Station Beta
  by Kontour AI**, and **Station Nightly by Kontour AI**. Installed app names
  remain Station, Station Beta, and Station Nightly. Confirm those records and
  the proposed seller, Kontour AI LLC, in the owner account before submission.
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
- The dispatch-only **Release: Internal TestFlight cohort** runs only from current
  `main`, first proving no-effect admission to all three environments. It then
  creates signed, immutable `ios-testflight/<channel>/v<version>/<build>`
  authority tags and calls only the reusable TestFlight delivery workflow in
  Nightly → Beta → Stable order. It never calls `release.yml`, publishes a
  GitHub Release/package/container/desktop artifact, changes Play, or submits
  an App Store version for public review.
- Internal Stable and Beta use the dedicated build slot `11100`; ordinary
  release authority keeps slots `11101` through `11199`. Nightly remains on
  the globally monotonic allocator, which considers both normal Nightly and
  internal-authority tags. This deliberately avoids moving or reusing the
  immutable `v0.1.10` release tag.
- Before the first cohort, every channel environment must explicitly admit the
  `main` branch and one active, unbypassed tag ruleset must deny both deletion
  and non-fast-forward changes to `refs/tags/ios-testflight/**`. Do not weaken
  either policy to recover a partial run: inspect the retained authority and
  provider receipts first.
- The authority key's public half must be registered on GitHub account
  `briananderson1222` before a cohort is dispatched. The planning job proves
  that GitHub's exact public key has the protected fingerprint and the UID
  email that `scripts/ios-testflight-internal-authority.mjs` pins as the
  signer, and the cohort workflow configures that same identity as its
  annotated tagger; `scripts/verify-ios-testflight-internal-tag.mjs` rejects a
  pushed tag whose tagger differs from the pinned constant. The address is
  deliberately not repeated in this guide: change it in the authority script
  and the workflow together, never in one alone. A missing key (the normal
  first-run state) fails before any tag or provider mutation.
- Tag overlay derives Android `versionCode` and iOS `CFBundleVersion` from the
  tag. Do not hand-edit `1` / `1.0` fallbacks in Gradle for a store upload.

Before starting a release train, query current GitHub releases/tags and compare
them with `package.json`; never choose the next version from examples in a
guide. The train must use a new `MAJOR.MINOR.PATCH` base. Preflight requires
both `vMAJOR.MINOR.PATCH-preview.N` and `vMAJOR.MINOR.PATCH` tags to match that
same base version. Preview numbering belongs to the tag/build overlay, so an
accepted preview commit can be promoted to Stable without a source edit.

## 1. Apple (one-time)

1. Register each of the three channel app bundle IDs above. Beta and Nightly
   also need their `.AgentActivity` and `.NotificationService` extension App
   IDs; see [the extension signing contract](mobile-release.md#live-activity-in-beta-and-nightly).
2. Create one matching app record and one explicit internal TestFlight group
   per channel. Station requires these existing records; Apple exposes a
   [beta-group creation API](https://developer.apple.com/documentation/appstoreconnectapi/post-v1-betagroups),
   so group creation is not universally a manual-only API limitation.
3. Create an **App Store distribution** provisioning profile for each app and
   required extension bundle ID. Ad-hoc and
   development profiles fail the release job.
4. Export the iOS Distribution certificate (`.p12`) and its password.
5. Generate an App Store Connect Team API key (App Manager). Download the
   `.p8` once and store it off this repository.

## 2. Google Play (one-time)

1. Create the intended channel application: Stable `io.kontourai.station`,
   Beta `io.kontourai.station.beta`, or Nightly `io.kontourai.station.nightly`.
   Each package needs its own provider setup and tester access.
2. Review the privacy URL, support URL, and Data Safety answers for the exact
   build and configured services before submitting them. Complete content
   rating, target audience, and the ads declaration; “no ads” is the proposed
   answer, not a declaration established by this checklist.
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

# Separate App Store profiles for both extensions (Beta and Nightly only;
# see mobile-release.md "Live Activity in Beta and Nightly")
for env in ios-beta ios-nightly; do
  gh secret set APPLE_AGENT_ACTIVITY_PROVISIONING_PROFILE_BASE64 --repo kontourai/station --env "$env"
  gh secret set APPLE_NOTIFICATION_SERVICE_PROVISIONING_PROFILE_BASE64 --repo kontourai/station --env "$env"
done

# Internal authority signatures are verified in every delivery environment.
# Only native-release can read the private key because only the planning job
# creates a new authority tag.
for env in native-release ios-beta ios-nightly; do
  gh variable set TESTFLIGHT_AUTHORITY_GPG_PUBLIC_KEY --repo kontourai/station --env "$env"
  gh variable set TESTFLIGHT_AUTHORITY_GPG_FINGERPRINT --repo kontourai/station --env "$env"
done
gh secret set TESTFLIGHT_AUTHORITY_GPG_PRIVATE_KEY --repo kontourai/station --env native-release
gh secret set TESTFLIGHT_AUTHORITY_GPG_PASSPHRASE --repo kontourai/station --env native-release

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
retain candidate identity, provider app/build IDs, processing state and workflow
URL. For a newly uploaded build the receipt records its candidate association;
for a reconciled existing build its provider SHA/digest remain unverified.
Do not mistake a new local candidate hash for the existing provider bytes. Tester email lists remain in Apple custody, never this
public repository.

For an owner-side, no-upload readiness check, decode the channel profile only
through the repository command (it checks the local profile against the
channel's bundle ID and validates group-ID syntax):

```sh
node scripts/ios-testflight-readiness.mjs --channel beta \
  --station /owner-only/Station-Beta.mobileprovision \
  --team TEAM_ID --group-id APP_STORE_CONNECT_GROUP_ID
```

Run it once per `stable`, `beta`, and `nightly`. This command makes no App Store
request and does not verify that the named app/group exists or that a tester
can install. The delivery workflow performs those separate provider preflights.
Treat decoded profile metadata/output as operator evidence, not public listing copy.

## 5. Tag only after secrets exist

```sh
git fetch origin main
git switch --detach origin/main
# package.json must carry this release train's unused stable base version
release_version=X.Y.Z # replace with the unused package.json version
git tag -s "v$release_version" -m "Station v$release_version"
git push origin "v$release_version"
```

Required delivery must have its upload/reconciliation and provider receipts.
A missing-keystore, environment refusal or skipped required delivery is not
success. Confirm the channel-specific build and group/track state in the consoles.

## Not this checklist

- Making the GitHub repository public (#1978)
- Custom `updates.kontourai.io` feed (#2211)
- Wrapping this process in a Flow (#1769)
- Unpaired first-launch for **external** review ([historical finding](https://github.com/kontourai/station-archive/issues/1772)); a source change or closed backlog item does not establish reviewer access
