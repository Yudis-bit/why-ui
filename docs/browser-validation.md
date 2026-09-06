# Browser Validation Findings

Real Chromium validation of the observational sensor and the complete extension/daemon/MCP loop. The original Milestone A suites below remain intact.

---

## Environment

* **Chromium**: `153.0.8010.12` (headless, Playwright-managed)
* **Playwright**: `1.63.0`
* **React 18 Fixture**: `18.3.1` (`react`, `react-dom`)
* **React 19 Fixture**: `19.2.8` (`react`, `react-dom`)

---

## Validated Behavior

The original 32 real-browser cases cover three suites. v0.1 adds source resolution, runtime lifecycle, reconciliation, and causality, bringing `test:browser` to 49 cases. `test:e2e` contains another 17 cases through the production extension.

### 1. Geometry & Hit-Testing (`tests/browser/geometry.spec.mjs` - 16 tests)
* **Native interaction**: Verifies standard `<button>` reachability via real trusted `pointermove` events with zero DOM mutations, zero clicks, and zero focus shifts.
* **Composed family hits**: Confirms nested SVG `<path>` and `<svg>` elements resolve to their enclosing interactive `<button>` family.
* **Full occlusion**: Validates that an overlapping foreign `<div>` overlay is detected as `FOREIGN_OCCLUSION` with `blockedRatio > 0.9` and primary blocker attribution.
* **Partial occlusion**: Verifies detection of `PARTIAL_FOREIGN_OCCLUSION` where target center remains reachable but peripheral samples are covered, defeating center-only detection heuristics.
* **`pointer-events: none`**: Demonstrates that pointer-transparent targets disappear from `elementsFromPoint()` and require explicit selector hints to diagnose `TARGET_POINTER_EVENTS_NONE`.
* **Native disabled**: Verifies `TARGET_DISABLED` diagnosis on `<button disabled>` without triggering interaction or event emission.
* **Inert containment**: Diagnoses `TARGET_INERT` when an ancestor has the HTML `inert` attribute, omitting the target from hit stacks and capturing causal ancestor evidence.
* **Zero geometry**: Identifies `TARGET_ZERO_GEOMETRY` when target bounding rect has 0 width and height with no padding, border, or hittable descendants.
* **Rounded corners**: Verifies that samples outside `border-radius: 50%` boundaries are classified as `outside-target-shape` rather than false blocker occlusion.
* **Clip path**: Verifies CSS `clip-path: polygon(...)` excludes non-rendered regions of the bounding box from target reachability.
* **CSS transforms**: Evaluates `transform: rotate(15deg)`, maintaining fresh bounding box tracking, outside-shape accounting, and partial occlusion detection.
* **Overflow clipping**: Confirms ancestor `overflow: hidden` marks clipped target segments outside the container as `outside-target-shape`.
* **Paint-order fixed blockers**: Accurately classifies `position: fixed` overlays with high `z-index` as foreign blockers according to browser paint order.
* **Pseudo-element hits**: Demonstrates that a blocking `::before` pseudo-element resolves to its originating DOM element.
* **Open Shadow DOM**: Verifies traversing open shadow roots across boundary selectors (`>>>`) to reacquire interactive shadow targets.
* **Multi-rect inline fragments**: Confirms inline wrapping links with multiple `getClientRects()` fragments are sampled within actual fragment geometry rather than an inflated bounding box.

### 2. Quality, Security & Performance (`tests/browser/quality.spec.mjs` - 6 tests)
* **Pre-movement inspection**: Confirms inspection prior to pointer movement safely returns `NO_POINTER_CAPTURED`.
* **Out-of-bounds coordinates**: Confirms pointer coordinates positioned outside a resized viewport return `NO_TARGET_AT_POINT`.
* **Privacy & confidentiality**: Verifies complete omission of form values (`<input>`, `<textarea>`), editable content (`contenteditable`), storage (`localStorage`, `sessionStorage`), and raw HTML strings from serialized output.
* **Dynamic layout recapture**: Rebuilds geometry after the fixture moves and resizes, retaining the non-atomic snapshot limitation. Unit adapters additionally exercise changes during capture.
* **Idempotent lifecycle**: Confirms repeated sensor installation reuses the single capture listener without duplication, and `dispose` cleanly removes listeners and global state.
* **Interactive performance budget**: Confirms sensor execution on a moderate DOM (~900 elements) completes well within an interactive budget (17.8 ms in the v0.1 audit).

### 3. React Development Runtimes (`tests/browser/react.spec.mjs` - 10 tests)
* **React 18 enrichment**: Extracts host fiber metadata (`_debugSource`, component owner chain `PaymentButton`, provenance `dom-fiber-property`).
* **React 18 SVG resolution**: Verifies SVG child hits correctly identify the parent `PaymentButton` React owner.
* **React 18 blocker attribution**: Distinguishes target owner (`CheckoutButton`) from blocker owner (`ModalBackdrop`).
* **React 18 fault tolerance**: Confirms throwing Fiber property proxies are safely caught without breaking hit-testing or throwing unhandled errors.
* **React 19 enrichment**: Confirms host fiber detection and component owner resolution without relying on legacy `_debugSource`.
* **React 19 SVG resolution**: Verifies SVG child hit attributes correctly to parent `PaymentButton`.
* **React 19 blocker attribution**: Distinguishes target owner (`CheckoutButton`) from blocker owner (`ModalBackdrop`).
* **React 19 fault tolerance**: Confirms throwing Fiber property proxies fail gracefully to `{ detected: false }`.
* **React 19 debug stack parsing**: Confirms modern `_debugStack` is parsed defensively as a candidate frame with certainty `symbolication-needed`.
* **Optional metadata exclusion**: Verifies `includeReactMetadata: false` completely omits React metadata while leaving interaction reachability diagnosis unchanged.

---

## Important Findings

1. **Pseudo-element attribution**: Pseudo-elements (`::before`, `::after`) are represented in browser hit testing (`document.elementsFromPoint()`) by their originating element rather than a standalone pseudo-element DOM node. The blocker descriptor reports the originating element's tag and bounding rect.
2. **`pointer-events: none` absence**: Targets styled with `pointer-events: none` are completely absent from `document.elementsFromPoint()`. Without an explicit identity hint (such as `targetSelector`), the sensor identifies whatever element actually received the pointer hit; it does not guess hidden targets.
3. **Inert target absence**: Elements within an `inert` subtree are omitted from browser hit stacks. The sensor detects inert ancestry when evaluating an explicit target or inspecting ancestor state, recording `TARGET_INERT`.
4. **Closed Shadow DOM opacity**: Closed shadow roots (`attachShadow({ mode: "closed" })`) remain completely opaque to main-world script. Descendant elements cannot be inspected or traversed, and closed shadow boundaries are reported as limitations.
5. **Frame isolation**: Iframe and cross-origin frame inspection is not implemented. Sensor execution and hit-testing evidence apply exclusively to the current document.
6. **React metadata variability**: React runtime metadata is best-effort, internal, and version-dependent. React 18 exposes `_debugSource` (yielding `runtime-derived` file/line hints), whereas React 19 uses `_debugStack` (yielding `candidate` frames requiring symbolication) and owner structures. If Fiber structures throw or diverge, the sensor falls back safely to `{ detected: false }`.
7. **Non-atomic capture**: Sensor capture is synchronous, but compositor animations, concurrent layout updates, and reflow mean inspection is not an atomic browser snapshot. Geometry changes observed between the start and end of capture trigger `RUNTIME_CHANGED_DURING_CAPTURE`.
8. **Sampled ratio approximations**: Sampling ratios (`reachableRatio`, `blockedRatio`) are area-weighted estimates across recursive fragment bisections (9–128 samples), not exact analytical pixel-area or polygon-union measurements. Overlapping rects and non-rectangular shapes are bounded and recorded as limitations.

---

## Performance

Observed execution in moderate-DOM smoke test (`tests/browser/quality.spec.mjs`):

* **DOM Size**: 900 rendered elements
* **Sample Count**: 64 sample points
* **Observed Duration**: 17.8 ms in the v0.1 audit; Milestone A observations were approximately 13–16 ms (Chromium 153.0.8010.12, Windows x64)
* **Smoke Budget**: < 5000 ms; this generous guard detects hangs and is not a latency guarantee

*Note: This is a quality smoke-test result to ensure algorithmic bounds prevent main-thread hangs. It is not presented as a formal benchmark.*

## v0.1 added browser coverage

| Suite | Cases | Evidence |
| --- | --- | --- |
| `source-resolution.spec.mjs` | 4 | Real React 18/19 host and blocker source maps, local CSS source, missing map, plain DOM/unmapped |
| `lifecycle.spec.mjs` | 2 | Actual source rebuild/reload, fresh document/geometry, same-document revision observation |
| `reconciliation.spec.mjs` | 4 | EXACT after reflow, MATCHED after reload, ambiguous duplicates, removed target |
| `causality.spec.mjs` | 6 | Multi-trigger ancestor trap, direct z-index, same context, top-layer popover, pseudo origin, unknown 3D cause |
| `sensor-lifecycle.spec.mjs` | 1 | Older sensor replacement through re-arming with no activation or DOM mutation |

The trap fixture initially had no overlap: collapsed margins placed its target at y=200
and blocker at y=100. Actual Chromium rects exposed the fixture error. The fixture was
corrected to overlap; no hit-test or causal heuristic was changed to manufacture a win.

## Production extension and MCP E2E

`npm run test:e2e` builds and loads `dist/extension` in a Playwright-managed Chromium
persistent context. It uses the real service worker, actual MAIN-world sensor, a real
loopback WebSocket server, HMAC pairing/authentication, and the registered MCP handlers.
Two tests spawn the CLI with the SDK's real stdio transport; the remaining transport
harness uses SDK InMemoryTransport around the same MCP server and a physical WebSocket.

The test driver uses Chromium's `Extensions.triggerAction` to invoke the actual toolbar
action and obtain `activeTab`. It targets a browser-level tab target and requires the
test-only `--enable-unsafe-extension-debugging` flag. No production worker hooks bypass
arming, injection, pairing, or transport. Normal Chrome usage needs no debugging flag.

| Suite | Cases | Evidence |
| --- | --- | --- |
| `mcp-pipeline.spec.mjs` | 11 | Partial occlusion without hint; full occlusion with selector; disconnected/no-arm/no-pointer; invalid payload; privacy sentinel; mid-request disconnect; 31-second idle and reconnect; real worker stop/restart; disarm/forget |
| `full-loop.spec.mjs` | 4 | JSX/CSS patch and rebuild/reload → PASS; replacement blocker → FAIL; duplicate targets → INCONCLUSIVE; no patch → INCONCLUSIVE |
| `stdio-loop.spec.mjs` | 2 | Actual CLI/MCP inspect → source patch → PASS; first-time pair command exits and a new agent process reuses saved authentication |

The full-loop fixture uses real React 19 and esbuild source maps. MCP identifies the
modal backdrop and resolves it to `src/Payment.jsx`. The test writes new source and CSS,
rebuilds, and signals a reload over an open SSE connection. A good patch moves/resizes
the payment button; fresh sampling finds a meaningful Safe Core and PASS despite an
invalidated old anchor. A bad patch removes the backdrop and adds another blocker;
verification returns FAIL with the replacement identity. Duplicate targets remain
ambiguous. Sensor results are never directly fabricated to simulate a patch.

The CLI loop additionally covers real React 18. Chromium fixtures instrument activation
and DOM mutations where applicable; application inspection and verification never
activate the payment button. Only extension settings/action controls are activated by
the E2E driver.

## Reproduce

```sh
npm ci
npx playwright install --with-deps chromium
npm run typecheck
npm test
npm run test:browser
npm run test:e2e
npm run build
```

No account, cloud service, test secret, local auth file, browser profile, or remote-debugging
Chrome instance is required. Auth and source fixtures use isolated temporary directories.
Screenshots, video, and traces are disabled; generated test results are gitignored.
Tests use the Playwright Chromium channel, which supports unpacked extensions in headless
mode. The configured CI runs the same commands on Linux/Node 22 and Windows/Node 24.
