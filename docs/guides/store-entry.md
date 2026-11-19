# First Play and App Store entry

Owner checklist for getting a signed Station build onto Play Internal testing
and TestFlight. This is not a release-readiness claim. Store consoles remain
the source of truth for whether testers can install a build.

The tag pipeline is documented in [native-releases.md](./native-releases.md)
and [mobile-release.md](./mobile-release.md). Listing copy lives in
[store-listing.md](./store-listing.md).

## Repository and workflow contract

- iOS channel bundle IDs: `io.kontourai.station` and
  `io.kontourai.station.nightly`. They are two installable apps. RC and final
  releases share the Stable app and exact accepted store build; Beta is retired.
- Intended App Store Connect listing names are **Station by Kontour AI** and **Station Nightly by Kontour AI**. Installed app
  names remain Station and Station Nightly. Confirm those records and
  the proposed seller, Kontour AI LLC, in the owner account before submission.
- Privacy policy URL: https://kontourai.io/privacy/station/
- Support URL source: https://kontourai.io/support/ — verify the live response
  before submitting a listing
- Play Data Safety answers: [play-data-safety.md](../reference/play-data-safety.md)
- iOS delivery uses protected GitHub Environments `native-release` (Stable)
  and `ios-nightly`. Each environment owns its matching
  provisioning profile and the non-secret `TESTFLIGHT_INTERNAL_GROUP_ID`.
  The distribution certificate and App Store Connect API key may be shared,
  but every channel preflights its own App Store Connect app and group before
  signing. Query their current protection configuration; this guide does not
  claim live environment state.
- The dispatch-only **Release: Internal TestFlight cohort** runs only from current
  `main`, first proving no-effect admission to both environments. It then
  creates signed, immutable `ios-testflight/<channel>/v<version>/<build>`
  authority tags and calls only the reusable TestFlight delivery workflow in
  Nightly → Stable order. It never calls `release.yml`, publishes a
  GitHub Release/package/container/desktop artifact, changes Play, or submits
  an App Store version for public review.
- Internal Stable retains the dedicated build slot `11100`; ordinary
  tagged releases keep their separately derived candidate/final build numbers. Nightly remains on
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
  tag, and refuses a base with minor above 999 or patch above 99
  ([native releases](native-releases.md)). Do not hand-edit `1` / `1.0` fallbacks in Gradle for a store upload.

Before starting a release train, query current GitHub releases/tags and compare
them with `package.json`; never choose the next version from examples in a
guide. The train must use a new `MAJOR.MINOR.PATCH` base. Preflight requires
both release-candidate `vMAJOR.MINOR.PATCH-rc.N` and final `vMAJOR.MINOR.PATCH`
tags to match that same base version. Both build the Stable app at that bare
base version; the candidate number only selects the store build slot, so an
accepted candidate needs no source edit
([#4929](https://github.com/kontourai/station/issues/4929)).

## 1. Apple (one-time)

1. Register both current channel app bundle IDs above. Nightly
   also needs their `.AgentActivity` and `.NotificationService` extension App
   IDs; Stable needs the same pair before opting in to push. Follow the
   [Stable owner checklist](mobile-release.md#stable-push-owner-checklist) and see [the extension signing contract](mobile-release.md#live-activity-in-stable-and-nightly).
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

1. Create the intended channel application: Stable `io.kontourai.station`
   or Nightly `io.kontourai.station.nightly`.
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
repository variable `ANDROID_UPLOAD_KEY_ALIAS=station`. Set
`ANDROID_UPLOAD_CERT_SHA256` to the SHA-256 fingerprint of the upload
certificate shown in Play Console. Tagged Stable and Nightly builds check
both the APK and the bundle against this fingerprint before staging them.
Do not put Android signing material in GitHub secrets.

## 3. Deposit Apple secrets in their matching environments

Use environment secrets, not repository secrets.

```sh
# iOS signing (required for a signed App Store IPA)
for env in native-release ios-nightly; do
  gh secret set APPLE_IOS_DISTRIBUTION_CERTIFICATE_BASE64 --repo kontourai/station --env "$env"
  gh secret set APPLE_IOS_DISTRIBUTION_CERTIFICATE_PASSWORD --repo kontourai/station --env "$env"
  gh secret set APPLE_DEVELOPMENT_TEAM --repo kontourai/station --env "$env"
  gh secret set APPLE_IOS_SIGNING_IDENTITY --repo kontourai/station --env "$env"
  gh secret set APPLE_PROVISIONING_PROFILE_BASE64 --repo kontourai/station --env "$env"
done

# Separate App Store profiles for both Nightly extensions;
# opted-in Stable uses native-release after the Stable owner checklist.
for env in ios-nightly; do
  gh secret set APPLE_AGENT_ACTIVITY_PROVISIONING_PROFILE_BASE64 --repo kontourai/station --env "$env"
  gh secret set APPLE_NOTIFICATION_SERVICE_PROVISIONING_PROFILE_BASE64 --repo kontourai/station --env "$env"
done

# Internal authority signatures are verified in every delivery environment.
# Only native-release can read the private key because only the planning job
# creates a new authority tag.
for env in native-release ios-nightly; do
  gh variable set TESTFLIGHT_AUTHORITY_GPG_PUBLIC_KEY --repo kontourai/station --env "$env"
  gh variable set TESTFLIGHT_AUTHORITY_GPG_FINGERPRINT --repo kontourai/station --env "$env"
done
gh secret set TESTFLIGHT_AUTHORITY_GPG_PRIVATE_KEY --repo kontourai/station --env native-release
gh secret set TESTFLIGHT_AUTHORITY_GPG_PASSPHRASE --repo kontourai/station --env native-release

# TestFlight upload (required for each configured channel; absent credentials
# fail the channel before signing or upload)
for env in native-release ios-nightly; do
  gh secret set APPLE_API_KEY_ID --repo kontourai/station --env "$env"
  gh secret set APPLE_API_ISSUER_ID --repo kontourai/station --env "$env"
  gh secret set APPLE_API_PRIVATE_KEY --repo kontourai/station --env "$env"
  gh variable set TESTFLIGHT_INTERNAL_GROUP_ID --repo kontourai/station --env "$env"
done

# Ordinary Nightly only: existing external tester group for the Nightly app.
# Missing configuration warns without failing internal TestFlight delivery.
gh variable set TESTFLIGHT_EXTERNAL_GROUP_NAME --repo kontourai/station --env ios-nightly --body "External Testers"
# Alternatively, set TESTFLIGHT_EXTERNAL_GROUP_ID to pin the existing group by ID.
```

Complete the [external TestFlight setup](mobile-release.md#nightly-external-testflight-distribution)
for beta review information, reviewer access and tester automatic updates.
Internal cohort dispatches remain internal-only.

Desktop Developer ID and Tauri updater keys are a separate product. Skip them
for an internal mobile-only cohort; those desktop jobs will fail closed until
they exist. Windows Authenticode is optional: without it the tagged Windows MSI
ships unsigned and records that state
([#3591](https://github.com/kontourai/station/issues/3591)).

## 4. First binaries

Play will not accept an API upload until one AAB has been uploaded by hand.
After the first signed AAB exists (local `tauri android build` or the first
tag that gets past Android signing):

1. Upload that AAB to Play → Testing → Internal testing.
2. Add testers.
3. Later tags use the keyless GitHub OIDC service account.

Release-candidate and final tags call the Stable delivery lane (Beta `-preview`
tags are retired); the scheduled Nightly uses the same reserved day/index build number as its
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
node scripts/ios-testflight-readiness.mjs --channel stable \
  --station /owner-only/Station.mobileprovision \
  --team TEAM_ID --group-id APP_STORE_CONNECT_GROUP_ID
```

Run it once per `stable` and `nightly`. This command makes no App Store
request and does not verify that the named app/group exists or that a tester
can install. The delivery workflow performs those separate provider preflights.
Treat decoded profile metadata/output as operator evidence, not public listing copy.

## 5. Cut and accept an RC after prerequisites exist

Use a clean sibling worktree and exact reviewed main SHA with successful full
qualification. The private root package must carry the unused release base;
choose it from live repository/provider state, not this example:

```sh
release_version=X.Y.Z
reviewed_sha=<exact-reviewed-qualified-main-commit>
git tag -s "v$release_version-rc.1" "$reviewed_sha" -m "Station v$release_version-rc.1"
git push origin "v$release_version-rc.1"
```

Follow [RC publication](release-rings.md#publish-a-release-candidate) for the
protected `mode=rc` dispatch. Required delivery must have exact upload and
provider receipts. A missing keystore, environment refusal, skipped delivery
or ambiguous reconciliation is not success. Confirm the Stable build and
internal group/track state in both consoles; record device installation and
acceptance separately. Then use the
[release-cut command](native-releases.md#product-version-and-release-cut) to
advance main's development base through ordinary review.

## Same-build production promotion

`mode=promote` consumes the accepted public RC, creates the final GitHub tag
without rebuilding, promotes the original Stable Play version code to
production, and submits the exact existing Apple build for App Review.
Promotion retains slot N, not direct-final slot 99. It never replaces the AAB
or IPA. Original RC assets remain public while the unchanged host payload
references their URLs.

Before approving this operation:

- Provision `GCP_PLAY_PROMOTION_WORKLOAD_IDENTITY_PROVIDER` and
  `GCP_PLAY_PROMOTION_SERVICE_ACCOUNT` for the main-branch
  `publish-release.yml` workflow and protected `native-release-publish`
  environment. Grant the intended Stable production-track permission. Keep
  Stage's `GCP_PLAY_WORKLOAD_IDENTITY_PROVIDER` / `GCP_PLAY_SERVICE_ACCOUNT`
  limited to its existing tag/Nightly testing-upload trust; promotion does not
  need Android signing-key access.
- Put `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID` and `APPLE_API_PRIVATE_KEY` in
  `native-release-publish`. Prepare the matching App Store version, listing,
  review information and metadata with manual release. The workflow selects
  the exact authenticated build and submits it; it does not create a missing
  listing or authorize automatic public release after approval.
- Require `station-release-store-authority.json` and its producer attestation,
  source/tag binding and artifact hashes. Apple lineage must be a definitive
  acknowledged upload from that candidate; a reconciled existing build with
  unknown provider SHA/digest is insufficient. Apple does not expose a byte
  download readback here, so upload lineage must not be described as one.
  After a successful Play upload, Stage obtains a fresh observation token.
  If the readback or edit cleanup fails, use the separate
  `station-android-play-observation-<version-code>` journal to reconcile the
  existing upload. Its operation outcomes and available HTTP status codes
  provide diagnostic evidence. Promotion still requires a verified authority
  receipt, and a failed observation does not justify uploading again.
- Select `android_rollout_fraction=1` for a first production launch. Later
  updates may stage below 1. Existing completed rollout is a no-op, an active
  rollout cannot shrink, unrelated/newer rollouts refuse, and country-targeted
  completion requires a separately reviewed geography disposition.

The workflow plans both providers before publication effects, then applies the
exact operations. Play planning/observation itself creates and deletes bounded
temporary Edits API resources; it is not a no-provider-call dry run. Store
journals record attempted operations before requests, keep unknown outcomes
and perform provider readback. Inspect retained run artifacts and actual store
state after interruption or response loss; never treat a repeat dispatch as
proof the earlier attempt did nothing.

These are source-defined prerequisites. Their live IAM, secrets, listing,
protected approvals, production release and physical installation remain
separate verification work.

## App Store review and a held update feed

The [store engine](../../scripts/promote-store-release.mjs) keeps fresh release
readback separate from submission. App Review submission is separate from public App Store release. Other Stable
artifacts may publish while Apple reviews the selected build. If an App Store
action custom feed is enabled, publication reads Apple with the protected API
key and requires the exact version, linked RC build, bundle and processed build
identity. `WAITING_FOR_REVIEW`, `IN_REVIEW` and approved-but-not-manually-released
states retain the previous feed (or its known absence) with
`DEFERRED_APP_STORE`; there is no feed PUT or announcement of the pending version
from that feed. A first listing may still return 404 while pending. A matching
released build must also pass the App Store URL/HTML checks before the feed
advances. Unknown provider state, mismatched builds or missing credentials
refuse publication rather than claiming pending or released.

The feed is one `{channel, version, releaseUrl}` resource. Clients sharing it
cannot advance independently by platform. This App Store gate currently uses
the attested RC upload authority retained by `mode=promote`; direct-final and
Nightly builds without that authority must keep App Store/TestFlight as their
update authority rather than publishing an App Store-action custom feed.
Artifact-action feeds keep their existing publication path.

After Apple approves the version, release that exact build manually. Then run
an explicit feed-only repair from the original public RC:

```sh
gh workflow run publish-release.yml --repo kontourai/station --ref main \
  -f mode=promote -f tag=v0.2.0-rc.1 -F repair_app_store_feed_only=true
```

Use the actual accepted tag, not this example. The final release must already
be public with its completed, attested promotion receipt and unchanged assets.
This operation revalidates those bytes and performs fresh Apple readback; it
creates no tag, resubmits no store build, and changes no desktop/host pointer,
container alias, deploy ledger or issue label. It is separate from desktop
`allow_published_pointer_repair` and cannot be combined with it. While review
remains pending, it retains the feed again. Inspect `native-feed.json` in the
retained store-effects artifact for the actual outcome; a readback or feed
failure is not completion. Keep the source RC release and assets public.

## Not this checklist

- Making the GitHub repository public (#1978)
- Custom `updates.kontourai.io` feed (#2211)
- Wrapping this process in a Flow (#1769)
- Unpaired first-launch for **external** review ([historical finding](https://github.com/kontourai/station-archive/issues/1772)); a source change or closed backlog item does not establish reviewer access
