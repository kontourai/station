---
"@kontourai/station-sdk": patch
"@kontourai/station-contracts": patch
---

Share session-list reads across authority-bound shell and Board consumers, use stream invalidation with a 60-second safety poll even with a healthy stream, and share public capability discovery between session history and stream resume.

Notify connected session lists after committed Draft and alias deletion without retaining private thread identity, and refuse ambient host authority when a Board has no request scope.
