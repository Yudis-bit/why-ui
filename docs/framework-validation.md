# Development-server validation

Validated on 2026-09-06 with Chromium 153.0.8010.12 on Windows. These are isolated,
minimal application checkouts running the actual framework development servers,
in addition to the lower-level esbuild and plain-DOM fixtures. They are not a claim
that every application or framework configuration works.

| Setup | Target / blocker source | Patch observation | Outcome |
| --- | --- | --- | --- |
| Vite 8.2.2, React 18.3.1, plugin-react 6.1.1 | `src/Checkout.jsx:7` / `:4`, runtime-derived host JSX | Vite HMR; document time origin unchanged | VERIFIED_PASS |
| Next.js 16.3.4, React 19.2.8, App Router + Turbopack | `app/page.jsx:7` / `:4`, symbolicated runtime frames | Next Fast Refresh; document time origin unchanged | VERIFIED_PASS |

Both applications contain a partially covered checkout button in an ancestor with
`transform` and `opacity` context triggers. Real Chromium hits establish the blocker;
the causal report classifies `STACKING_CONTEXT_TRAP`. The test changes the component
source to remove the backdrop, then calls `verify_fix` without manually reloading,
mutating stored evidence, or activating the button. Verification establishes a fresh
stable surface and Safe Core. CSS module declaration locations were unavailable in
these two captures; no exact CSS provenance is claimed.

The small apps use the documented [Vite React setup](https://vite.dev/guide/) and
[Next App Router setup](https://nextjs.org/docs/app/getting-started/installation).
Their ordinary entry/configuration structure also follows the public
[create-vite React template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react)
and [Next hello-world example](https://github.com/vercel/next.js/tree/canary/examples/hello-world).
The checkout reproduction is why-ui test code, not an upstream application bug.
No upstream files or repositories were modified for this validation.

Run `npm run test:dogfood` after installing the normal development dependencies and
Playwright Chromium. Each test copies a version-locked app into an OS temporary
directory, performs `npm ci` there, starts a loopback-only dev server, uses the
production extension and MCP handler, and removes its own app/processes afterward.
Next telemetry is disabled. Framework dependencies are test-only and are not included
in why-ui's runtime package. The CI framework job repeats both checks on Linux.

Server Components without a client host boundary, alternative compilers, authenticated
source-map endpoints, remote maps, closed shadow roots, and iframe interiors are not
certified by these checks. Missing evidence remains UNMAPPED or INCONCLUSIVE.
