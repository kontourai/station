---
'@kontourai/station-cli': minor
---

Run an installed release archive's service through a fixed launcher that
trials an update and rolls it back when the new version does not start;
back up and restore the Station home around it (`station service
update-home`); pass the launcher's context only to the server it supervises;
and show a launcher-run service's update, including one that needs an
operator and how to recover it, in `station service status`.
