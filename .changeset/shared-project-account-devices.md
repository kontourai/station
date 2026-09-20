---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
"@kontourai/station-cli": minor
---

Add explicit account-bound Device approval and guest-only Project view contracts.
Expose validated Project view APIs while keeping personal full-configuration APIs
separate. Require deliberate operator approval mode selection in the pairing UI
and CLI, and retain current account and Project membership as independent access
requirements. This is a view-only pilot; shared execution and complete guest
onboarding retain their separate delivery requirements.
