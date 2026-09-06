# Architecture

why-ui observes one explicitly armed Chrome tab and connects its browser evidence to a
local coding agent. The agent owns source edits. Browser hit tests own runtime truth.

## Components

| Component | Responsibility |
| --- | --- |
| `extension/service-worker.ts` | Action/shortcut arming, MAIN injection, one BrowserSession, bounded capture requests |
| `extension/bridge.ts` | Pairing, Web Crypto HMAC, session authentication, heartbeat and reconnect |
| `src/sensor-main-world.ts` | Pointer observation, geometry, hit testing, runtime descriptors, reconciliation |
| `src/daemon/bridge-server.ts` | Loopback WebSocket, Origin/auth enforcement, correlation, schema revalidation |
| `src/daemon/mcp-server.ts` | The two MCP handlers, compact results and baseline creation |
| `src/daemon/source-resolver.ts` | Confined local paths, source maps, CSS candidates, bounded static correlation |
| `src/daemon/workspace.ts` | Relevant file hashes and browser revision comparisons |
| `src/daemon/verification.ts` | Patch readiness, fresh captures, independent verification semantics |
| `src/daemon/safe-core.ts` | Connected, eroded sample-region estimates |
| `src/daemon/causality.ts` | Conservative explanation of an observed browser winner |

## Browser capture

An extension action or keyboard shortcut supplies Chrome's `activeTab` grant. The
service worker installs `sensorMainWorld` with `chrome.scripting.executeScript`,
`world: "MAIN"`. Its executable helpers live inside the function because Chrome
serializes the function rather than its module closure.

A passive capture listener retains only the last trusted movement coordinates. A
MutationObserver increments a revision counter without retaining mutation contents.
At most 100 weak element identities support same-document verification. Disarming
removes the listener, observer, and sensor namespace. Same-origin reloads install into
the new document on the next request; cross-origin navigation disarms the tab.

`elementsFromPoint` establishes hit order. The top hit resolves through bounded composed
ancestry to an interaction target, including nested SVG. An explicit unique light-DOM
selector is necessary when browser hits cannot identify the intended underlying target.
Open shadow results retain their host's position in document hit order.

The sampler bisects visible client-rect cells and rebuilds them on every capture. A
foreign hit counts as a blocker only when the hit stack also establishes target-family
membership beneath it. Missing membership, unavailable shadow evidence, and exhausted
bounds do not invent occlusion. Zero eligible samples means unknown reachability.

## Evidence and source

React is optional enrichment. Known DOM Fiber properties and an existing DevTools hook
are checked defensively. `_debugSource`, `_debugStack`, `_debugOwner`, owner chains, and
keys are read through guarded boundaries. Fibers, props, state, and raw stacks never
cross the bridge. Runtime host/owner sources take priority over generated-frame
symbolication. React 19 can supply several frames so a bundled JSX-runtime frame does
not mask the actual owner frame.

The resolver recognizes local paths, Vite `/@fs/`, webpack/webpack-internal paths, and
Turbopack `[project]` paths. Linked and inline source maps use `@jridgewell/trace-mapping`.
Every returned file must exist within the workspace after normalization and realpath
checks. Missing maps produce `UNMAPPED`; a unique static ID/class/component correlation
is explicitly `heuristic`. The tests cover path forms, not complete Vite/Next builds.

CSSOM can expose matching declaration candidates, including accessible stylesheets and
Vite style paths. The resolver can symbolicate a uniquely located declaration into local
CSS/module source. A candidate is not proof that the declaration won the cascade.
Inaccessible sheets, ambiguous locations, and inline declarations without source stay
unmapped. Exact source certainty is never inferred from a filename resemblance.

## MCP and baselines

The daemon validates the sensor response against the canonical schema before use.
`inspectInteractionTool.outputSchema` remains the complete sensor contract used by the
original browser validation. The MCP server advertises
`inspectInteractionMcpOutputSchema`, its compact projection: two node descriptions,
computed state, surface counts, diagnosis, causality, sources, and limitations. Samples,
full ancestor arrays, and Fiber enrichment remain outside the default MCP response.

A successful inspection creates a daemon-owned UUID and immutable in-memory baseline:
raw runtime evidence, target/blocker identity, source references, selection UV, session,
and a relevant-workspace revision. The insertion-ordered cache retains at most 100
inspections. Verification never replaces its baseline. Daemon restart loses baselines
but preserves pairing. No database or background source watcher is used.

Source resolution has a three-second lookup budget, bounded local reads, and at most
16 cached assets. Runtime evidence can be returned with `UNMAPPED` sources. Verification
polls only while requested; see [verification](verification.md).

## Causality

Browser hit order is established before explanation. The target and blocker ancestor
chains are inspected for position/z-index, fixed/sticky, opacity, transform, filter,
perspective, isolation, contain, will-change, blend mode, and clipping. Independent
transforms, backdrop filters, masks, and detectable top-layer state are also retained.
All active captured triggers are reported together.

The classifications are `DIRECT_Z_INDEX`, `STACKING_CONTEXT_TRAP`,
`SAME_CONTEXT_PAINT_ORDER`, `TOP_LAYER`, `PSEUDO_ELEMENT_ORIGIN`, and
`UNKNOWN_PAINT_CAUSE`. A trap identifies a `constrainingStackingContext`; contexts are
not inherited properties. An incomplete ancestor chain or `preserve-3d` leaves the
paint cause unknown. Top-layer evidence uses browser modal/popover/fullscreen state.
Pseudo-element attribution is limited to an observed hit outside an empty origin
box with active generated content; the content itself is never serialized.

This engine does not reproduce Blink's complete paint algorithm, animation history,
or every possible context trigger. Its explanation is subordinate to captured hits.

## Resource bounds

| Resource | Limit |
| --- | --- |
| Hit samples | 9–128; default 64 |
| Client rects | 256 examined, 16 retained |
| Hit stack / composed ancestry / Fiber traversal | 64 per traversal |
| Ancestor evidence / named React owners | 12 / 16 |
| Described blockers / weak target identities | 16 / 100 |
| Reconciliation candidates | 256 of the expected tag; excess is ambiguous |
| Inspection cache / pending bridge requests | 100 / 16 |
| Concurrent MCP inspections / verifications | 4 / 4 |
| Outstanding extension captures | 16, including frozen MAIN-world requests |
| Bridge connections / inbound message | 4 accepted / 512 KiB |
| WebSocket queued-output guard | 512 KiB before another send |
| Source index | 2,000 entries, 200 source files |
| Source scan / revision hashing | 16 MiB / 8 MiB; 512 KiB per file |
| Source asset / cached assets | 2 MiB / 16 |
| Source-map sections / nesting / sources | 32 total / 4 / 4,096 |

The native browser can search internally for hit tests and selectors; normal inspection
does not enumerate the whole DOM in JavaScript. The 900-node timing in
[browser validation](browser-validation.md) is a practical smoke result, not a benchmark.
