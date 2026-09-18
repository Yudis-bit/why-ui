# Maintainer response and release notes

Use one tracking issue for a release. Update its checklist instead of creating routine
status issues. No automated community replies, engagement requests, or metric commits.

| Report | First useful response |
| --- | --- |
| Reproducible UI bug | Confirm versions and startup steps; reproduce the browser hit result before proposing a fix. |
| Unsupported framework | Ask for a minimal public app and exact bundler/version; label current coverage honestly. |
| Source mapping failure | Ask for the redacted source reference/certainty and map availability, never a whole private repository. |
| False blocker | Compare fresh `elementsFromPoint` evidence, target family, clipping and sample boundaries; retain UNKNOWN when incomplete. |
| Verification false negative | Inspect reconciliation signals, source/runtime revision and Safe Core reasons; do not lower thresholds just to pass. |
| Security issue | Redirect privately to the Security advisory form; avoid reproducing exploit details in a public reply. |

A helpful response states what was reproduced, what remains unknown, and the next bounded
experiment. Do not promise a response SLA or framework support that has not been tested.
Requests for new diagnostic families can remain proposals while the core interaction
loop is hardened.

For release: merge green CI, keep package/extension versions aligned, write accurate
`docs/releases/vX.Y.Z.md`, and push the version tag. The Release workflow repeats CI,
installs the tarball, loads the archived extension, checks hashes, then publishes assets.
Never move a published version tag or replace released bytes silently.

`private: true` deliberately prevents accidental npm-registry publication; GitHub
tarballs remain installable. `doctor` is read-only and reports UNKNOWN for browser
session status: a responding TCP port is not authenticated service identity.
