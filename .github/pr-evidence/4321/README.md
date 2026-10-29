# Project sharing with local accounts setting captures — PR #4321

Retention: source-pinned visual evidence for this PR; retain with its review history.
Captured in headless Chromium from an isolated, supervised Station
(`./station start --instance=sharing-4305 --temp-home`, ports 3462/5492). The
theme is Station's own `data-theme`. These show UI state only, not native shell
rendering. Builds: `dde260ada73e01fb0154f6d3a837b26ac993876c` for 01–08,
`b79e239eb1eeccfe30cb69ae2876ab414fcad9f3` for 09 and
`1cd3c90c366e3b9fd85db0564fac369c461d8aab` for 10.

The 01–10 captures are historical: the earlier in-app confirmation was
replaced by a separate consent page. The PR body links four later captures
inspected at source revision `50f3c065f09`, at 390 and 1440 CSS pixels in
both themes. They show an isolated, unsupervised `--watch` instance on ports
39261/39271, with only loopback offered and Review change disabled. They do
not establish reachable HTTPS or consent-page behavior. The temporary image
commit remains in PR history because the reviewed branch cannot be rewritten;
the new images are not present in the branch's final tree.

- `01-off-1440-dark.jpg`: Settings → System, sharing off.
- `02-choose-origin-1440-dark.jpg`, `02-choose-origin-390-light.jpg`: turned on
  with the offered sign-in addresses; the first selectable one is preselected.
- `03-confirm-on-1440-dark.jpg`: the restart confirmation naming the address.
- `04-on-1440-light.jpg`: after the supervised restart, the section reports On.
- `06-confirm-off-1440-dark.jpg`, `07-off-again-390-light.jpg`: turning it off
  and the result after the restart.
- `08-locked-1440-dark.jpg`, `08-locked-390-light.jpg`: started with
  `STATION_PROJECT_SHARING=1 STATION_LOCAL_ACCOUNTS=1 STATION_AUTHENTICATION_ORIGIN=…`;
  Set by the deployment, no control.
- `09-unsupervised-1440-light.jpg`, `09-unsupervised-390-dark.jpg`: started with
  `STATION_DIRECT_LAUNCH=1`; Apply is disabled with the supervisor hint.
- `10-feature-preview-off-1440-dark.jpg`: Advanced → Feature previews listing
  Project sharing setting, off.
