# Fix verification

`verify_fix` checks a previously diagnosed runtime failure against an immutable baseline.
why-ui observes source edits made by the coding agent; it never edits source itself.

## Readiness and revision

Inspection stores the browser session, raw target and blocker evidence, source hints,
interaction surface, diagnosis, selection UV, git HEAD when available, and SHA-256 hashes
of relevant source files. Hashes, rather than mtimes alone, establish content changes.
When there are no mapped source files, a bounded workspace source snapshot is used.
A truncated/inaccessible snapshot cannot establish readiness.

Verification has a bounded 100–10,000 ms readiness deadline (default 3,000 ms). It polls
at roughly 100 ms intervals while requested, checking:

1. The baseline browser session remains armed and connected.
2. Relevant source contents changed since inspection.
3. The browser document, revision counter, or captured runtime evidence changed.
4. The target reconciles and its fresh geometry/hit surface is identical across three
   consecutive observations, with the document no longer loading.

This does not wait for network idle or use a fixed sleep as proof of readiness. Long-lived
WebSockets, polling, SSE, and analytics do not prevent verification. Source lookup and
filesystem operations have their own small bounds; the readiness timeout is not a
hard real-time scheduling guarantee. The full-loop fixture rebuilds actual JSX/CSS and
notifies the browser to reload over SSE. Same-document mutations are also observed;
there is no framework-specific HMR adapter or build-completion oracle.

An unrelated source edit plus an unrelated browser mutation is not proof of handler
correctness. PASS still requires fresh runtime assertions. If a patch only changes a
file outside the baseline's relevant snapshot, inspect again to establish that scope.

## Target reconciliation

A live, bounded weak identity in the same document is `EXACT` when its tag and stable
ID or label still agree. After replacement/reload, inspect at most 256 elements of the
expected tag in the prior light/open-shadow scope. No full-DOM wildcard search or LLM
selection is used. Excess candidates are `AMBIGUOUS`.

| Matching signal | Score contribution |
| --- | --- |
| Runtime source file and line | 35 |
| Component owner | 20 |
| React key | 35 |
| Tag / role | 10 / 5 |
| Accessible-name hint | 25 |
| Stable ID | 50 |
| Stable classes | 8 |
| Ancestry fingerprint | 8 |
| Text fingerprint | 5 |
| Relative structure | 2 |

Scores are deterministic ranking values, not model confidence. A candidate needs at
least 50 points and a meaningful ID, runtime source, React key, or label match. The
best candidate must lead the second by at least 15 points. A near-equal pair remains
`AMBIGUOUS`; nth-of-type cannot quietly resolve a tie. The result retains matched and
unmatched signals. No qualifying candidate is `NOT_FOUND`. In either case verification
is INCONCLUSIVE. Name/text are bounded hints, not full accessible-name computation.

## Fresh geometry and interaction surface

A reconciled target receives new client rects, adaptive cells, and actual browser hit
tests. The old normalized UV point is projected only as a continuity hint. A geometry
change marks `INVALIDATED_BY_REFLOW`; this is compatible with PASS. The original point
is never the primary verification assertion.

Results include reachable, blocked, and outside-shape sample counts and area-weighted
reachable/blocked ratios. Those ratios are conditional on samples where target-family
membership is established. Offscreen, clipped, unresolved, or absent target-family
samples do not become invented blockers. See [browser validation](browser-validation.md).

## Safe Core

Safe Core is a conservative sample-derived interior estimate:

- Keep reachable cells, with a reachable neighbor on each of their four sides.
- Exclude cells whose center has less than 4 px clearance from sampled non-reachable
  cells or the captured bounding edge.
- Find connected retained regions; use the largest.
- Require at least four interior cells, 64 px² estimated area, and 4 px minimum clearance.

Missing cell geometry, unresolved samples, truncated fragments, or overlapping fragments
prevent a Safe Core assertion. This is not exact polygon geometry and can miss obstacles
between samples. A small or thin control can therefore be INCONCLUSIVE even when its
center is reachable. Increasing the sample budget can help, without changing thresholds.

## Result semantics

| Result | Requirement |
| --- | --- |
| `VERIFIED_PASS` | Unique reconciled target, changed source/runtime, three stable fresh observations, enabled/non-inert state, no supported failure or sampled foreign blocker, meaningful Safe Core |
| `VERIFIED_FAIL` | Fresh, stable browser evidence still establishes a supported failure or foreign occlusion |
| `VERIFY_INCONCLUSIVE` | Changed session, ambiguous/missing identity, absent source/runtime update, unstable capture, or insufficient safe interior evidence |

A missing/evicted baseline returns the explicit `INVALID_OPTIONS` tool error. A baseline
with `diagnosis.cause: UNKNOWN` did not establish a supported failure and cannot yield
PASS. Native disabled, inert, hidden, pointer-suppression, zero-geometry, and offscreen
failures remain failures when proved by fresh evidence. ARIA-only disabled declarations
prevent PASS but do not manufacture a native failure.

`originalBlockerPresent` is separate from blocking. Its value is null unless the original
blocker's identity can be established. Removing that blocker while adding another returns
FAIL with the replacement in `current.primaryBlocker`. Reflow never overrides this check.

Inspection/verification never call click, focus, blur, scroll, or dispatch activation
events. A PASS proves only the documented sampled runtime assertions, not application
business logic, event listeners, keyboard navigation, accessibility, or exact coverage.
