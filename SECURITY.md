# Security policy

Report vulnerabilities privately using
[GitHub's private vulnerability form](https://github.com/Yudis-bit/why-ui/security/advisories/new).
Private vulnerability reporting is enabled. Do not put device secrets, pairing tokens,
private page payloads, or exploitable details in a public issue.

Include the why-ui version, OS/Chrome version, affected boundary, and a minimal redacted
reproduction. The current v0.1 line receives security fixes. There is no staffed response
SLA; the maintainer will acknowledge and investigate reports as available.

why-ui binds to loopback, authenticates a paired extension Origin using a local secret
and HMAC, and confines source resolution to the selected workspace. The user's OS
account and MAIN-world browser APIs are trusted. It is not a sandbox for hostile local
processes or a guarantee that application labels contain no private data.

Read the [threat model and regression coverage](docs/security.md).
