# Contributing

Start with a small reproducible interaction bug. Reports that reveal missing evidence,
incorrect source certainty, or a false verification result are especially useful.

```sh
npm ci
npx playwright install --with-deps chromium
npm run typecheck
npm test
npm run test:browser
npm run test:e2e
npm run test:package
```

`npm run test:dogfood` also validates real Vite and Next development servers. It installs
their pinned dependencies in temporary applications. Node 22.13+ is required; CI uses
Node 22 on Linux and Node 24 on Windows. No credentials are required for tests.

Browser hit testing is ground truth. why-ui collects bounded evidence and explains it;
the coding agent reasons about and edits source. Do not add activating probes, LLM
runtime guesses, broad extension permissions, or a compiler transform requirement.
Missing source evidence is UNMAPPED. Ambiguous identity is INCONCLUSIVE. Sampling ratios
are estimates. Preserve the original sensor tests.

For a regression, add the smallest case to `tests/browser` for browser behavior, or
`tests/e2e` for transport/patch lifecycle. Use the production unpacked extension for E2E.
Patch a real fixture source file to test verification; do not alter stored telemetry.
Add unit tests when they establish a meaningful boundary or deterministic calculation.

Open a focused PR describing the observed bug, resulting behavior, and checks run.
Main requires the Linux, Windows, and framework checks; no second maintainer approval
is required. Keep unrelated formatting and generated artifacts out of the diff.

See [architecture](docs/architecture.md), [verification](docs/verification.md), and
[security reporting](SECURITY.md). New diagnostic families belong in a scoped proposal;
the launch focus remains “Why can't I click this?”
