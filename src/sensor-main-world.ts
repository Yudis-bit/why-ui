import type {
  CapturedPointer, InteractionBlocker, InteractionCause, InteractionInspectionResult,
  InteractionSample, ReactProvenance, ReactRuntimeMetadata, ReactSourceHint,
  RelevantComputedStyles, RuntimeElementState, RuntimeNodeDescriptor, RuntimeNodeEvidence,
  RuntimeNodePathSegment, RuntimeRect, SensorRequest, SensorResponse, WhyUiErrorCode,
  CssDeclarationCandidate, RuntimePaintEvidence,
  TargetIdentityBaseline, TargetReconciliationResult,
} from "./types.js";

/**
 * Pass this function itself to chrome.scripting.executeScript({ world: "MAIN", func,
 * args: [{ operation: "install" }] }), then invoke with operation: "inspect".
 * ALL executable dependencies deliberately live inside this function: Chrome copies
 * function source, not its module closure. Type-only imports disappear at build time.
 * Retains scalar pointer/revision data and at most 100 weak node identities. No
 * results, strong DOM references, application props, or Fibers are retained.
 */
export function sensorMainWorld(request: SensorRequest = { operation: "inspect" }): SensorResponse {
  const KEY = Symbol.for("why-ui.sensor.main-world.v1");
  const MAX_DEPTH = 64;
  const MAX_ANCESTORS = 12;
  const MAX_STACK = 64;
  const MAX_RECTS = 16;
  const MAX_BLOCKERS = 16;
  const STYLE_KEYS = [
    "display", "visibility", "opacity", "pointer-events", "position", "z-index",
    "transform", "filter", "perspective", "isolation", "contain", "will-change",
    "mix-blend-mode", "clip-path", "overflow", "overflow-x", "overflow-y", "content-visibility",
  ] as const;
  interface SensorState {
    version: 1;
    pointer: CapturedPointer | null;
    eventName: "pointermove" | "mousemove";
    listener: EventListener;
    documentId: string;
    revision: number;
    observer?: MutationObserver;
    identities: Map<string, WeakRef<Element>>;
    tokens: WeakMap<Element, string>;
    nextToken: number;
  }
  interface Cell { left: number; top: number; right: number; bottom: number; area: number }
  interface MeasuredSample { sample: InteractionSample; blocker?: Element }
  const fail = (code: WhyUiErrorCode, message: string): SensorResponse => ({ ok: false, error: { code, message } });
  const clean = (value: string, limit = 160): string => value.slice(0, limit * 2)
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
  const finite = (value: number, fallback = 0): number => Number.isFinite(value) ? value : fallback;
  const object = (value: unknown): value is object => (typeof value === "object" && value !== null) || typeof value === "function";
  // React internals are the only untyped boundary. Never inspect props/state/children.
  const read = (value: unknown, key: PropertyKey): unknown => {
    try { return object(value) ? Reflect.get(value, key) : undefined; } catch { return undefined; }
  };
  const ownValue = (value: unknown, key: PropertyKey): unknown => {
    try { return object(value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined; } catch { return undefined; }
  };
  const composedParent = (element: Element): Element | null => {
    if (element.assignedSlot) return element.assignedSlot;
    if (element.parentElement) return element.parentElement;
    const root = element.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  };
  const within = (element: Element, ancestor: Element): boolean | undefined => {
    if (ancestor.contains(element)) return true;
    const seen = new Set<Element>();
    let current: Element | null = element;
    for (let depth = 0; current && depth < MAX_DEPTH && !seen.has(current); depth++) {
      if (current === ancestor) return true;
      seen.add(current);
      current = composedParent(current);
    }
    // Exhausting a composed-ancestry bound is unknown, never proof of foreign identity.
    return current ? undefined : false;
  };
  const semantic = (element: Element): boolean => {
    const tag = element.localName;
    if (["button", "select", "textarea", "summary", "option"].includes(tag)) return true;
    if (tag === "input") return element.getAttribute("type")?.toLowerCase() !== "hidden";
    if (["a", "area"].includes(tag) && element.hasAttribute("href")) return true;
    if (["audio", "video"].includes(tag) && element.hasAttribute("controls")) return true;
    const role = element.getAttribute("role")?.slice(0, 64).trim().split(/\s+/)[0];
    if (role && ["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox",
      "menuitemradio", "option", "combobox", "textbox", "searchbox", "slider", "spinbutton", "treeitem"].includes(role)) return true;
    const tabIndex = element.getAttribute("tabindex");
    if (tabIndex !== null && /^-?\d+$/.test(tabIndex)) return true;
    const editable = element.getAttribute("contenteditable");
    return editable === "" || editable === "true" || editable === "plaintext-only";
  };
  function findInteractionTarget(raw: Element): Element {
    let current: Element | null = raw;
    for (let depth = 0; current && depth < MAX_ANCESTORS; depth++) {
      if (semantic(current)) return current;
      // A label is itself a native interaction surface. Its control may be elsewhere;
      // measuring that control would measure a different surface than the hovered label.
      if (current.localName === "label") return current;
      if (["body", "html"].includes(current.localName)) break;
      current = composedParent(current);
    }
    return raw;
  }
  function rectOf(rect: DOMRect | DOMRectReadOnly): RuntimeRect {
    return { x: finite(rect.x), y: finite(rect.y), width: Math.max(0, finite(rect.width)),
      height: Math.max(0, finite(rect.height)), top: finite(rect.top), right: finite(rect.right),
      bottom: finite(rect.bottom), left: finite(rect.left) };
  }

  try {
    if (typeof window === "undefined" || typeof document === "undefined" || typeof ShadowRoot === "undefined") {
      return fail("UNSUPPORTED_RUNTIME", "A browser document in the MAIN world is required.");
    }
    if (!request || !["install", "inspect", "verify", "dispose"].includes(request.operation)) {
      return fail("INVALID_OPTIONS", "Unknown sensor operation.");
    }
    const existing = ownValue(window, KEY);
    let state: SensorState | undefined;
    if (existing !== undefined) {
      if (read(existing, "version") !== 1 || typeof read(existing, "listener") !== "function" ||
        !["pointermove", "mousemove"].includes(String(read(existing, "eventName")))) {
        return fail("SENSOR_NOT_AVAILABLE", "The sensor namespace is unavailable.");
      }
      state = existing as SensorState;
    }
    if (request.operation === "dispose") {
      if (state) {
        state.observer?.disconnect();
        window.removeEventListener(state.eventName, state.listener, true);
        Reflect.deleteProperty(window, KEY);
      }
      return { ok: true, result: { installed: false } };
    }
    if (state && (!(state.identities instanceof Map) || !(state.tokens instanceof WeakMap) || typeof state.documentId !== "string")) {
      if (request.operation !== "install") return fail("SENSOR_NOT_AVAILABLE", "Re-arm this tab to update its sensor.");
      // Upgrade an older sensor in an already-open document without duplicate listeners.
      state.observer?.disconnect();
      window.removeEventListener(state.eventName, state.listener, true);
      if (!Reflect.deleteProperty(window, KEY)) return fail("SENSOR_NOT_AVAILABLE", "The sensor namespace cannot be updated.");
      state = undefined;
    }
    if (!state) {
      const installed: SensorState = {
        version: 1, pointer: null,
        documentId: `${performance.timeOrigin}-${Date.now()}`, revision: 0,
        identities: new Map(), tokens: new WeakMap(), nextToken: 0,
        eventName: typeof window.PointerEvent === "function" ? "pointermove" : "mousemove",
        listener: () => {},
      };
      installed.listener = (event: Event): void => {
        // Reading coordinates only: no event cancellation, propagation changes, or focus.
        if (!event.isTrusted || !(event instanceof MouseEvent)) return;
        if (![event.clientX, event.clientY, event.pageX, event.pageY].every(Number.isFinite)) return;
        const pointerType = read(event, "pointerType");
        installed.pointer = { clientX: event.clientX, clientY: event.clientY,
          pageX: event.pageX, pageY: event.pageY,
          pointerType: typeof pointerType === "string" ? clean(pointerType, 24) : "mouse", timestamp: Date.now() };
      };
      Object.defineProperty(window, KEY, { value: installed, configurable: true, enumerable: false, writable: false });
      try { window.addEventListener(installed.eventName, installed.listener, { passive: true, capture: true }); }
      catch { Reflect.deleteProperty(window, KEY); return fail("SENSOR_NOT_AVAILABLE", "Pointer tracking could not be installed."); }
      state = installed;
      if (typeof MutationObserver === "function") {
        installed.observer = new MutationObserver(() => { installed.revision++; });
        installed.observer.observe(document, { subtree: true, attributes: true, childList: true, characterData: true });
      }
    }
    if (request.operation === "install") return { ok: true, result: { installed: true } };
    const options = request.options ?? {};
    const maxSamples = options.maxSamples ?? 64;
    if (!Number.isInteger(maxSamples) || maxSamples < 9 || maxSamples > 128 ||
      (options.includeReactMetadata !== undefined && typeof options.includeReactMetadata !== "boolean") ||
      (options.targetSelector !== undefined && (typeof options.targetSelector !== "string" ||
        options.targetSelector.length === 0 || options.targetSelector.length > 1024))) {
      return fail("INVALID_OPTIONS", "Invalid sampling, metadata, or selector option.");
    }
    // Verification carries the baseline pointer only as a continuity anchor. It does
    // not overwrite captured input or synthesize a new user movement after reload.
    const captured: unknown = request.operation === "verify" ? request.baseline?.pointer : read(state, "pointer");
    const clientX = read(captured, "clientX"), clientY = read(captured, "clientY");
    const pageX = read(captured, "pageX"), pageY = read(captured, "pageY");
    const pointerType = read(captured, "pointerType"), timestamp = read(captured, "timestamp");
    if (typeof clientX !== "number" || typeof clientY !== "number" || typeof pageX !== "number" ||
      typeof pageY !== "number" || typeof timestamp !== "number" || typeof pointerType !== "string" ||
      ![clientX, clientY, pageX, pageY, timestamp].every(Number.isFinite) || timestamp < 0) {
      return fail("NO_POINTER_CAPTURED", "Move the pointer over the intended interaction surface first.");
    }
    if (typeof document.elementsFromPoint !== "function") return fail("UNSUPPORTED_RUNTIME", "Browser hit-testing is unavailable.");
    // Whitelist scalar fields even from our own page-visible namespace; never spread it.
    const pointer: CapturedPointer = { clientX, clientY, pageX, pageY, pointerType: clean(pointerType, 24), timestamp };
    const viewport = { width: Math.max(0, finite(window.innerWidth)), height: Math.max(0, finite(window.innerHeight)),
      devicePixelRatio: finite(window.devicePixelRatio, 1), scrollX: finite(window.scrollX), scrollY: finite(window.scrollY) };
    const limitations = new Set<string>([
      "Coverage is a bounded, area-weighted sample estimate, not exact pixel or polygon coverage.",
      "User intent cannot be inferred beneath an overlay. Pointer-transparent, hidden, or absent targets require prior identity evidence.",
      "Closed shadow interiors and frame contents are not inspected; evidence applies to this document only.",
      "Reachability does not prove application event-handler behavior. A healthy sampled surface has cause UNKNOWN.",
      "Descriptions are bounded hints, not guaranteed unique selectors or complete accessible names.",
    ]);
    const computedCache = new WeakMap<Element, RelevantComputedStyles>();
    const styleCache = new WeakMap<Element, CSSStyleDeclaration>();
    const descriptorCache = new WeakMap<Element, RuntimeNodeDescriptor>();
    function getRelevantComputedStyles(element: Element): RelevantComputedStyles {
      const cached = computedCache.get(element);
      if (cached) return cached;
      const style = window.getComputedStyle(element);
      styleCache.set(element, style);
      const result = {} as RelevantComputedStyles;
      for (const key of STYLE_KEYS) {
        // URLs can contain credentials/tokens and quoted closing parentheses. Redact
        // the entire URL-bearing value; a partial regex replacement can leak suffixes.
        const value = style.getPropertyValue(key);
        result[key] = /url\s*\(/i.test(value) ? "url([redacted])" : clean(value, 256);
      }
      computedCache.set(element, result);
      return result;
    }
    function getState(element: Element): RuntimeElementState {
      const result: RuntimeElementState = { disabled: element.matches(":disabled"), inert: false,
        ariaDisabled: element.getAttribute("aria-disabled") === "true", hidden: false };
      let current: Element | null = element;
      for (let depth = 0; current && depth < MAX_ANCESTORS; depth++) {
        const style = getRelevantComputedStyles(current);
        result.inert ||= current.hasAttribute("inert");
        // hidden="until-found" and overridden [hidden] are not unconditional hit suppression.
        result.hidden ||= style.display === "none" || style["content-visibility"] === "hidden";
        current = composedParent(current);
      }
      return result;
    }
    const sensitive = (element: Element): boolean => {
      let current: Element | null = element;
      for (let depth = 0; current && depth < MAX_DEPTH; depth++) {
        if (["input", "textarea", "select", "option"].includes(current.localName)) return true;
        const editable = current.getAttribute("contenteditable");
        if (editable !== null && editable !== "false") return true;
        current = composedParent(current);
      }
      // An unexamined ancestor might be editable. Omit text when the bound is exhausted.
      return current !== null;
    };
    function textHint(element: Element): string {
      if (sensitive(element) || !(semantic(element) || element.localName === "label")) return "";
      let text = "";
      let visited = 0;
      const visit = (node: Node, depth: number): void => {
        if (++visited > 48 || depth > 6 || text.length >= 160) return;
        if (node.nodeType === Node.TEXT_NODE) { text += ` ${node.nodeValue?.slice(0, 160) ?? ""}`; return; }
        if (!(node instanceof Element) || ["script", "style", "template", "noscript"].includes(node.localName) || sensitive(node)) return;
        for (let child = node.firstChild; child && visited < 48 && text.length < 160; child = child.nextSibling) visit(child, depth + 1);
      };
      visit(element, 0);
      return clean(text);
    }
    function segment(element: Element): RuntimeNodePathSegment {
      const result: RuntimeNodePathSegment = { tagName: clean(element.localName, 64) };
      const id = element.getAttribute("id");
      if (id) result.id = clean(id);
      const classes: string[] = [];
      for (let index = 0; index < Math.min(element.classList.length, 6); index++) {
        const value = clean(element.classList.item(index) ?? "", 64);
        if (value) classes.push(value);
      }
      if (classes.length) result.classes = classes;
      let nth = 1;
      let siblings = 0;
      let previous = element.previousElementSibling;
      while (previous && siblings++ < 128) {
        if (previous.localName === element.localName) nth++;
        previous = previous.previousElementSibling;
      }
      if (!previous) result.nthOfType = nth;
      return result;
    }
    function buildNodeDescriptor(element: Element): RuntimeNodeDescriptor {
      const cached = descriptorCache.get(element);
      if (cached) return cached;
      const own = segment(element);
      const domPath: RuntimeNodePathSegment[] = [];
      const selectors: string[] = [];
      const escape = (value: string): string => typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, char => `\\${char.codePointAt(0)?.toString(16)} `);
      let current: Element | null = element;
      for (let depth = 0; current && depth < 8; depth++) {
        const part = segment(current);
        domPath.unshift(part);
        selectors.unshift(part.id ? `#${escape(part.id)}` : `${part.tagName}${part.nthOfType ? `:nth-of-type(${part.nthOfType})` : ""}`);
        const parent = composedParent(current);
        if (parent && !current.parentElement && current.getRootNode() instanceof ShadowRoot) selectors.unshift(">>>");
        else if (parent) selectors.unshift(">");
        current = parent;
      }
      if (selectors[0] === ">" || selectors[0] === ">>>") selectors.shift();
      const result: RuntimeNodeDescriptor = { tagName: own.tagName,
        selectorHint: clean(selectors.join(" "), 1024), rect: rectOf(element.getBoundingClientRect()), domPath };
      if (own.id) result.id = own.id;
      if (own.classes) result.classes = own.classes;
      const role = element.getAttribute("role");
      if (role) result.role = clean(role, 64);
      if (!sensitive(element)) {
        const preview = textHint(element);
        if (preview) result.textPreview = preview;
        const label = element.getAttribute("aria-label");
        if (label && semantic(element)) result.name = clean(label);
        else if (preview) result.name = preview;
      }
      const attributes: Record<string, string> = {};
      for (const key of ["type", "role", "aria-disabled", "aria-hidden", "disabled", "hidden", "inert", "tabindex", "contenteditable"]) {
        const value = element.getAttribute(key);
        if (value !== null) attributes[key] = clean(value);
      }
      if (Object.keys(attributes).length) result.attributes = attributes;
      descriptorCache.set(element, result);
      return result;
    }
    function paintEvidence(element: Element, point?: { x: number; y: number }): RuntimePaintEvidence {
      const result: RuntimePaintEvidence = {};
      try {
        if (element.localName === "dialog" && element.matches(":modal")) result.topLayer = "modal";
        else if (element.hasAttribute("popover") && element.matches(":popover-open")) result.topLayer = "popover";
        else if (document.fullscreenElement === element) result.topLayer = "fullscreen";
      } catch { /* Unsupported selectors must not break diagnosis. */ }
      try {
        getRelevantComputedStyles(element);
        const style = styleCache.get(element)!;
        result.extraTriggers = [];
        for (const property of ["translate", "rotate", "scale", "backdrop-filter", "mask-image"]) {
          const value = style.getPropertyValue(property);
          if (value && value !== "none") result.extraTriggers.push({ property, value: /url\s*\(/i.test(value) ? "url([redacted])" : clean(value, 256) });
        }
        result.uncertain3D = style.transformStyle === "preserve-3d";
        const rect = buildNodeDescriptor(element).rect;
        if (point && element.childNodes.length === 0 && element.namespaceURI === "http://www.w3.org/1999/xhtml" &&
          style.display !== "list-item" && (point.x < rect.left || point.x >= rect.right || point.y < rect.top || point.y >= rect.bottom)) {
          result.pseudoElementOrigin = ["::before", "::after"].some(pseudo => {
            const value = getComputedStyle(element, pseudo);
            return !["none", "normal", ""].includes(value.content) && value.display !== "none" && value.pointerEvents !== "none";
          });
        }
      } catch { /* Optional paint evidence is not hit-test truth. */ }
      return result;
    }
    const evidenceFor = (element: Element): RuntimeNodeEvidence => ({ node: buildNodeDescriptor(element),
      computed: getRelevantComputedStyles(element), state: getState(element), paint: paintEvidence(element) });
    function ancestorsOf(element: Element): RuntimeNodeEvidence[] {
      const ancestors: RuntimeNodeEvidence[] = [];
      let current = composedParent(element);
      while (current && ancestors.length < MAX_ANCESTORS) {
        const evidence = evidenceFor(current);
        if (ancestors.length < 3 && options.includeReactMetadata !== false && !["html", "body"].includes(current.localName)) evidence.react = getReactRuntimeMetadata(current);
        ancestors.push(evidence);
        current = composedParent(current);
      }
      if (current) limitations.add("Ancestor evidence is depth-limited; distant inherited suppression may be unavailable.");
      return ancestors;
    }
    let hitStackIncomplete = false;
    function hitStack(x: number, y: number): Element[] {
      hitStackIncomplete = false;
      const expanded: Element[] = [];
      const seen = new Set<Element>();
      const roots = new Set<ShadowRoot>();
      const append = (element: Element, depth: number): void => {
        if (expanded.length >= MAX_STACK) { hitStackIncomplete = true; return; }
        if (seen.has(element)) return;
        seen.add(element);
        const shadow = element.shadowRoot;
        if (shadow && depth < 8 && !roots.has(shadow)) {
          roots.add(shadow);
          // This ShadowRoot API is feature-detected: it is not uniformly standardized.
          const fromPoint = read(shadow, "elementsFromPoint");
          if (typeof fromPoint === "function") {
            try {
              const inner: unknown = fromPoint.call(shadow, x, y);
              if (Array.isArray(inner)) for (const candidate of inner.slice(0, MAX_STACK)) {
                // Some implementations return ancestors/outside elements: preserve paint order.
                if (candidate instanceof Element && candidate !== element && within(candidate, element)) append(candidate, depth + 1);
              }
              if (!Array.isArray(inner) || inner.length > MAX_STACK) hitStackIncomplete = true;
            } catch {
              hitStackIncomplete = true;
              limitations.add("Open shadow-root hit-testing failed; host-level evidence may be incomplete.");
            }
          } else {
            hitStackIncomplete = true;
            limitations.add("Open shadow-root hit-testing is unavailable; host-level evidence may be incomplete.");
          }
        } else if (shadow && depth >= 8) {
          hitStackIncomplete = true;
          limitations.add("Open shadow expansion is depth-limited; deeper interaction identity may be unavailable.");
        }
        if (expanded.length < MAX_STACK) expanded.push(element);
      };
      const stack = document.elementsFromPoint(x, y);
      if (stack.length > MAX_STACK) {
        hitStackIncomplete = true;
        limitations.add("Hit stacks are capped; deeper target-family membership may be unavailable.");
      }
      for (const element of stack.slice(0, MAX_STACK)) append(element, 0);
      return expanded;
    }
    function reconcileTarget(baseline: TargetIdentityBaseline): { element?: Element; result: TargetReconciliationResult } {
      const absent = (message: string): { result: TargetReconciliationResult } => ({ result: { status: "NOT_FOUND", candidateCount: 0,
        signals: [{ signal: "tag", matched: false, evidence: message }] } });
      if (!baseline?.node || !/^[a-z][a-z0-9-]{0,63}$/i.test(baseline.node.tagName)) return absent("The baseline identity is unavailable.");
      const expected = baseline.node;
      const score = (element: Element): { score: number; signals: TargetReconciliationResult["signals"]; node: RuntimeNodeDescriptor } => {
        const node = buildNodeDescriptor(element);
        const react = baseline.react?.detected ? getReactRuntimeMetadata(element) : undefined;
        const signals: TargetReconciliationResult["signals"] = [];
        let total = 0;
        const add = (signal: TargetReconciliationResult["signals"][number]["signal"], matched: boolean, weight: number): void => {
          signals.push({ signal, matched, evidence: `Deterministic identity weight ${weight}.` });
          if (matched) total += weight;
        };
        const source = baseline.react?.source, currentSource = react?.source;
        add("source-runtime-identity", !!source?.file && !!source.line && source.certainty !== "symbolication-needed" && currentSource?.certainty !== "symbolication-needed" && source.file === currentSource?.file && source.line === currentSource?.line, 35);
        add("component-owner", !!baseline.react?.componentName && baseline.react.componentName === react?.componentName, 20);
        add("react-key", baseline.react?.reactKey != null && baseline.react.reactKey === react?.reactKey, 35);
        add("tag", expected.tagName === node.tagName, 10);
        add("role", !!expected.role && expected.role === node.role, 5);
        add("accessible-name", !!expected.name && expected.name === node.name, 25);
        add("stable-id", !!expected.id && expected.id === node.id, 50);
        add("stable-classes", !!expected.classes?.length && expected.classes.every(c => node.classes?.includes(c)), 8);
        const ancestry = (value: RuntimeNodeDescriptor): string => JSON.stringify(value.domPath.slice(0, -1).map(p => [p.tagName, p.id ?? ""]));
        add("ancestry-fingerprint", expected.domPath.length > 1 && ancestry(expected) === ancestry(node), 8);
        add("text-fingerprint", !!expected.textPreview && expected.textPreview === node.textPreview, 5);
        const structure = (value: RuntimeNodeDescriptor): string => JSON.stringify(value.domPath.map(p => [p.tagName, p.nthOfType ?? 0]));
        add("relative-structure", structure(expected) === structure(node), 2);
        return { score: total, signals, node };
      };
      const retained = baseline.documentId === state!.documentId && baseline.runtimeTargetId
        ? state!.identities.get(baseline.runtimeTargetId)?.deref() : undefined;
      if (retained?.isConnected && retained.localName === expected.tagName) {
        const evidence = score(retained);
        if (!expected.name || expected.name === evidence.node.name || (!!expected.id && expected.id === evidence.node.id)) {
          return { element: retained, result: { status: "EXACT", candidateCount: 1, signals: evidence.signals, target: evidence.node } };
        }
      }
      let root: Document | ShadowRoot = document;
      // Reuse only the shadow-root scope of the diagnostic path, never nth-of-type as identity proof.
      const shadowParts = expected.selectorHint.split(" >>> ");
      for (const hostSelector of shadowParts.slice(0, -1).slice(0, 8)) {
        try {
          const hosts: NodeListOf<Element> = root.querySelectorAll(hostSelector);
          if (hosts.length !== 1 || !hosts[0]?.shadowRoot) return absent("The original open shadow scope cannot be uniquely reacquired.");
          root = hosts[0].shadowRoot;
        } catch { return absent("The original shadow scope is unavailable."); }
      }
      const elements = root.querySelectorAll(expected.tagName);
      if (elements.length > 256) return { result: { status: "AMBIGUOUS", candidateCount: elements.length,
        signals: [{ signal: "tag", matched: true, evidence: "The 256-candidate bound prevents a unique identity decision." }] } };
      const candidates = Array.from(elements).map(element => ({ element, ...score(element) }))
        .filter(c => c.score >= 50 && c.signals.some(s => s.matched && ["stable-id", "source-runtime-identity", "react-key", "accessible-name"].includes(s.signal)))
        .sort((a, b) => b.score - a.score);
      const best = candidates[0];
      if (!best) return absent("No candidate meets the documented identity threshold.");
      const near = candidates.filter(c => best.score - c.score < 15);
      if (near.length > 1) return { result: { status: "AMBIGUOUS", candidateCount: near.length, signals: best.signals } };
      return { element: best.element, result: { status: "MATCHED", candidateCount: 1, signals: best.signals, target: best.node } };
    }
    const originalStack = hitStack(pointer.clientX, pointer.clientY);
    const rawHit = originalStack[0] ?? null;
    let target: Element;
    let reconciliation: TargetReconciliationResult | undefined;
    if (request.operation === "verify") {
      const resolved = reconcileTarget(request.baseline);
      reconciliation = resolved.result;
      if (!resolved.element) return { ok: true, result: { reconciliation } };
      target = resolved.element;
    } else if (options.targetSelector !== undefined) {
      let matches: NodeListOf<Element>;
      try { matches = document.querySelectorAll(options.targetSelector); }
      catch { return fail("INVALID_OPTIONS", "The target selector is invalid."); }
      if (!matches.length) return fail("TARGET_NOT_FOUND", "The target selector did not match an element.");
      if (matches.length !== 1) return fail("TARGET_AMBIGUOUS", "The target selector matched multiple elements.");
      const match = matches[0];
      if (!match) return fail("TARGET_NOT_FOUND", "The target could not be reacquired.");
      target = match;
    } else {
      if (!rawHit) return fail("NO_TARGET_AT_POINT", "There is no hit-test target at the captured pointer position.");
      target = findInteractionTarget(rawHit);
    }
    if (!target.isConnected) return fail("RUNTIME_CHANGED_DURING_CAPTURE", "The selected target disconnected during capture.");
    const capturedAt = Date.now();
    const initialRect = rectOf(target.getBoundingClientRect());
    const rawRects = target.getClientRects();
    const rects: RuntimeRect[] = [];
    const capturedRects: RuntimeRect[] = [];
    let positiveRectCount = 0;
    // DOMRectList can be huge for wrapping text. Bound both retained and inspected rects.
    for (let index = 0; index < Math.min(rawRects.length, 256); index++) {
      const item = rawRects[index];
      if (!item) continue;
      const rect = rectOf(item);
      capturedRects.push(rect);
      if (rect.width <= 0 || rect.height <= 0) continue;
      positiveRectCount++;
      const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
      const right = Math.min(viewport.width, rect.right), bottom = Math.min(viewport.height, rect.bottom);
      if (right > left && bottom > top && rects.length < MAX_RECTS) {
        // Avoid duplicate fragment area, but do not pretend overlapping rects form an exact union.
        if (!rects.some(value => value.left === left && value.top === top && value.right === right && value.bottom === bottom)) {
          rects.push({ x: left, y: top, left, top, right, bottom, width: right - left, height: bottom - top });
        }
      }
    }
    const clientRectsTruncated = rawRects.length > 256 || positiveRectCount > MAX_RECTS || rects.length > maxSamples;
    if (clientRectsTruncated) limitations.add("Client rects are capped; the surface may omit fragments.");
    const sampledRects = rects.slice(0, Math.min(MAX_RECTS, maxSamples));
    if (sampledRects.some((a, index) => sampledRects.slice(index + 1).some(b =>
      Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top)))) {
      limitations.add("Overlapping client rects can double-weight overlap; ratios are not exact union-area measurements.");
    }
    // Split the largest cell until the budget is filled. Every represented fragment gets
    // a sample, and successive bisections refine the whole surface without adaptive bias.
    // Unlike classification-biased refinement, area weights remain interpretable.
    const cells: Cell[] = sampledRects.map(rect => ({ left: rect.left, top: rect.top, right: rect.right,
      bottom: rect.bottom, area: rect.width * rect.height }));
    const initialSamples = Math.min(16, maxSamples);
    const subdivide = (budget: number): void => {
      while (cells.length && cells.length < budget) {
        let largest = 0;
        for (let index = 1; index < cells.length; index++) if ((cells[index]?.area ?? 0) > (cells[largest]?.area ?? 0)) largest = index;
        const cell = cells[largest];
        if (!cell || cell.area < 0.000001) break;
        const width = cell.right - cell.left, height = cell.bottom - cell.top;
        const midX = (cell.left + cell.right) / 2, midY = (cell.top + cell.bottom) / 2;
        const a: Cell = width >= height ? { ...cell, right: midX, area: cell.area / 2 } : { ...cell, bottom: midY, area: cell.area / 2 };
        const b: Cell = width >= height ? { ...cell, left: midX, area: cell.area / 2 } : { ...cell, top: midY, area: cell.area / 2 };
        cells.splice(largest, 1, a, b);
      }
    };
    subdivide(initialSamples);
    subdivide(maxSamples);
    const totalArea = cells.reduce((sum, cell) => sum + cell.area, 0);
    const familyCache = new WeakMap<Element, boolean | undefined>();
    const family = (element: Element): boolean | undefined => {
      const cached = familyCache.get(element);
      if (familyCache.has(element)) return cached;
      const result = within(element, target);
      if (result === undefined) limitations.add("Composed target-family traversal was truncated; affected samples are unresolved.");
      familyCache.set(element, result);
      return result;
    };
    function classifySample(x: number, y: number, weight: number): MeasuredSample {
      if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) {
        return { sample: { x, y, weight, classification: "outside-viewport" } };
      }
      const stack = hitStack(x, y);
      const first = stack[0];
      const firstMembership = first ? family(first) : false;
      if (firstMembership === true) return { sample: { x, y, weight, classification: "reachable" } };
      if (firstMembership === undefined) return { sample: { x, y, weight, classification: "unresolved" } };
      const memberships = stack.map(family);
      if (first && memberships.includes(true)) return { sample: { x, y, weight, classification: "blocked" }, blocker: first };
      if (hitStackIncomplete || memberships.includes(undefined)) return { sample: { x, y, weight, classification: "unresolved" } };
      // AABB containment cannot prove target coverage for rounded/clipped/transformed shapes,
      // nor can it prove occlusion when pointer-events/inert removes a target from the stack.
      return { sample: { x, y, weight, classification: "outside-target-shape" } };
    }
    const measured = cells.map(cell => {
      const measured = classifySample((cell.left + cell.right) / 2, (cell.top + cell.bottom) / 2, totalArea > 0 ? cell.area / totalArea : 0);
      measured.sample.cell = { left: cell.left, top: cell.top, right: cell.right, bottom: cell.bottom };
      return measured;
    });
    const samples = measured.map(value => value.sample);
    const count = (classification: InteractionSample["classification"]): number => samples.filter(sample => sample.classification === classification).length;
    const reachableSamples = count("reachable"), blockedSamples = count("blocked");
    const eligibleWeight = samples.reduce((sum, sample) => sum + (["reachable", "blocked"].includes(sample.classification) ? sample.weight : 0), 0);
    const ratio = (weight: number): number => eligibleWeight > 0 ? Math.max(0, Math.min(1, weight / eligibleWeight)) : 0;
    const blockedWeight = samples.reduce((sum, sample) => sum + (sample.classification === "blocked" ? sample.weight : 0), 0);
    const surface = { totalSamples: samples.length, reachableSamples, blockedSamples,
      outsideSamples: samples.length - reachableSamples - blockedSamples, eligibleSamples: reachableSamples + blockedSamples,
      reachableRatio: ratio(eligibleWeight - blockedWeight), blockedRatio: ratio(blockedWeight),
      sampledClientRects: sampledRects.length, clientRectsTruncated, samples };
    if (surface.eligibleSamples === 0) limitations.add("No sampled target-family hit exists; reachability ratios of zero do not establish either reachability or foreign occlusion.");

    function getReactRuntimeMetadata(element: Element): ReactRuntimeMetadata {
      try {
        const provenance = new Set<ReactProvenance>();
        let fiber: unknown;
        let version: string | undefined;
        const fiberLike = (candidate: unknown): boolean => {
          const tag = read(candidate, "tag");
          return object(candidate) && typeof tag === "number" && Number.isInteger(tag) && tag >= 0 && tag <= 40;
        };
        const keys = Object.getOwnPropertyNames(element).slice(0, 128);
        for (const key of keys) if (/^__(?:reactFiber|reactInternalInstance)\$/.test(key) || key === "_reactInternalFiber") {
          const candidate = ownValue(element, key);
          if (fiberLike(candidate)) { fiber = candidate; provenance.add("dom-fiber-property"); break; }
        }
        const hook = ownValue(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__");
        const renderers = read(hook, "renderers");
        // The hook is never installed/modified. Consult at most eight existing renderers;
        // merely finding the hook does not prove ownership or a target React version.
        if (renderers instanceof Map) {
          let visited = 0;
          for (const renderer of renderers.values()) {
            if (++visited > 8) break;
            const find = read(renderer, "findFiberByHostInstance");
            if (typeof find !== "function") continue;
            let candidate: unknown;
            try { candidate = find.call(renderer, element); } catch { continue; }
            if (!fiberLike(candidate) || (fiber && candidate !== fiber && candidate !== read(fiber, "alternate"))) continue;
            fiber ??= candidate;
            provenance.add("devtools-hook");
            const foundVersion = read(renderer, "version");
            if (typeof foundVersion === "string") version = clean(foundVersion, 64);
            break;
          }
        }
        if (!fiber) return { detected: false };
        const result: ReactRuntimeMetadata = { detected: true, provenance: [] };
        if (version) result.version = version;
        const key = read(fiber, "key");
        if (key === null || typeof key === "string") result.reactKey = key === null ? null : clean(key);
        const fileHint = (value: string): string => clean(value.split(/[?#]/, 1)[0] ?? "", 1024)
          .replace(/(\w+:\/\/)[^/]*@/, "$1[redacted]@");
        const stackCandidates: ReactSourceHint[] = [];
        function sourceOf(candidate: unknown, host: boolean): ReactSourceHint | undefined {
          const debug = read(candidate, "_debugSource");
          const file = read(debug, "fileName"), line = read(debug, "lineNumber"), column = read(debug, "columnNumber");
          if (typeof file === "string" && fileHint(file)) {
            const source: ReactSourceHint = { file: fileHint(file), scope: host ? "host-jsx" : "component-owner",
              certainty: "runtime-derived", provenance: "fiber-debug-source" };
            if (typeof line === "number" && Number.isInteger(line) && line > 0 && line <= 1e9) source.line = line;
            if (typeof column === "number" && Number.isInteger(column) && column >= 0 && column <= 1e9) source.column = column;
            return source;
          }
          const debugStack = read(candidate, "_debugStack");
          const stack = typeof debugStack === "string" ? debugStack : read(debugStack, "stack");
          if (typeof stack !== "string") return undefined;
          // Never return the raw Error/stack (messages can include page data). A frame is
          // only a candidate until symbolicated; React 19 stacks often point into bundles.
          let firstFrame: ReactSourceHint | undefined;
          for (const frame of stack.slice(0, 8192).split("\n").slice(0, 16)) {
            // Skip Error messages even if they happen to end in file:line:column.
            if (!/^\s+at\s/.test(frame) && !/^[^\s@]*@(?:https?|file|webpack(?:-internal)?|turbopack|vite):\/\//.test(frame)) continue;
            let location = frame.trim();
            if (location.startsWith("at ")) {
              location = location.slice(3);
              const wrapper = location.indexOf(" (");
              if (wrapper >= 0 && location.endsWith(")")) location = location.slice(wrapper + 2, -1);
            } else location = location.slice(location.indexOf("@") + 1);
            // Paths can themselves contain parentheses (for example Next route groups).
            const match = /^((?:[a-zA-Z]:[\\/]|(?:https?|file|webpack(?:-internal)?|turbopack|vite):\/\/|\/)[^\n]*):(\d+):(\d+)$/.exec(location);
            if (!match?.[1] || !match[2] || !match[3]) continue;
            const frameFile = fileHint(match[1]);
            if (/react-dom|react-jsx|node_modules[\\/]react[\\/]/.test(frameFile)) continue;
            const frameLine = Number(match[2]), frameColumn = Number(match[3]);
            if (!Number.isSafeInteger(frameLine) || !Number.isSafeInteger(frameColumn) || frameLine <= 0 || frameColumn < 0 || frameLine > 1e9 || frameColumn > 1e9) continue;
            const candidate: ReactSourceHint = { file: frameFile, line: frameLine, column: frameColumn, scope: "candidate",
              certainty: "symbolication-needed", provenance: "fiber-debug-stack" };
            firstFrame ??= candidate;
            if (stackCandidates.length < 8 && !stackCandidates.some(s => s.file === frameFile && s.line === frameLine && s.column === frameColumn)) stackCandidates.push(candidate);
          }
          return firstFrame;
        }
        function componentName(candidate: unknown): string | undefined {
          let type = read(candidate, "type");
          if (!type) type = read(candidate, "elementType");
          if (typeof type === "string") return undefined;
          const seenTypes = new Set<unknown>();
          for (let depth = 0; object(type) && depth < 4 && !seenTypes.has(type); depth++) {
            seenTypes.add(type);
            const display = read(type, "displayName"), name = read(type, "name");
            if (typeof display === "string" && display) return clean(display);
            if (typeof name === "string" && name) return clean(name);
            type = read(type, "render") ?? read(type, "type");
          }
          // Modern React owner metadata may be a debug-info object instead of a Fiber.
          const name = read(candidate, "name");
          return typeof name === "string" && name ? clean(name) : undefined;
        }
        const source = sourceOf(fiber, true);
        if (source) result.source = source;
        const sources: ReactSourceHint[] = source ? [source] : [];
        const owners: string[] = [];
        const visited = new Set<unknown>([fiber]);
        const initialOwner = read(fiber, "_debugOwner");
        let current: unknown = initialOwner ?? read(fiber, "return");
        if (object(current)) provenance.add(initialOwner ? "fiber-debug-owner" : "fiber-return-chain");
        for (let depth = 0; object(current) && depth < MAX_DEPTH && owners.length < 16 && !visited.has(current); depth++) {
          visited.add(current);
          const name = componentName(current);
          if (name) { owners.push(name); provenance.add("fiber-type"); }
          if (sources.length < 8) {
            const found = sourceOf(current, false);
            if (found && !sources.some(s => s.file === found.file && s.line === found.line && s.column === found.column)) {
              sources.push(found);
              if (!result.source || (result.source.certainty === "symbolication-needed" && found.certainty === "runtime-derived")) result.source = found;
            }
          }
          const owner = read(current, "_debugOwner") ?? read(current, "owner");
          const next = owner ?? read(current, "return");
          if (object(next)) provenance.add(owner ? "fiber-debug-owner" : "fiber-return-chain");
          current = next;
        }
        const nearestOwner = owners[0];
        if (nearestOwner) { result.componentName = nearestOwner; result.ownerChain = owners; }
        if (result.source) provenance.add(result.source.provenance);
        for (const candidate of stackCandidates) {
          if (sources.length < 8 && !sources.some(s => s.file === candidate.file && s.line === candidate.line && s.column === candidate.column)) sources.push(candidate);
        }
        if (sources.length) result.sources = sources;
        result.provenance = [...provenance];
        return result;
      } catch { return { detected: false }; }
    }
    function cssCandidates(element: Element): CssDeclarationCandidate[] {
      const found: CssDeclarationCandidate[] = [];
      let examined = 0;
      const add = (style: CSSStyleDeclaration, selector: string, stylesheet?: string): void => {
        for (const property of STYLE_KEYS) {
          if (found.length >= 8) break;
          const raw = style.getPropertyValue(property);
          if (!raw) continue;
          const candidate: CssDeclarationCandidate = { property, value: /url\s*\(/i.test(raw) ? "url([redacted])" : clean(raw, 256), selector: clean(selector, 256), certainty: "runtime-derived" };
          if (stylesheet) candidate.stylesheet = clean(stylesheet.split(/[?#]/, 1)[0] ?? "", 1024).replace(/(\w+:\/\/)[^/]*@/, "$1[redacted]@");
          found.push(candidate);
        }
      };
      const inline = read(element, "style");
      if (inline && typeof read(inline, "getPropertyValue") === "function") add(inline as CSSStyleDeclaration, "[inline]");
      const visit = (rules: CSSRuleList, stylesheet: string | undefined, depth: number): void => {
        for (let i = 0; i < rules.length && examined < 512 && found.length < 8; i++) {
          examined++;
          const rule = rules[i];
          if (!rule) continue;
          if (typeof CSSStyleRule !== "undefined" && rule instanceof CSSStyleRule) {
            try { if (!/[\[\]"\']/.test(rule.selectorText) && element.matches(rule.selectorText)) add(rule.style, rule.selectorText, stylesheet); } catch {}
          } else if (depth < 4) {
            // Conditional rules are candidates; CSSOM matching does not prove cascade priority.
            if (typeof CSSMediaRule !== "undefined" && rule instanceof CSSMediaRule && !matchMedia(rule.conditionText).matches) continue;
            if (typeof CSSSupportsRule !== "undefined" && rule instanceof CSSSupportsRule && !CSS.supports(rule.conditionText)) continue;
            const nested = read(rule, "cssRules");
            if (nested) visit(nested as CSSRuleList, stylesheet, depth + 1);
          }
        }
      };
      try {
        for (let i = 0; i < Math.min(document.styleSheets.length, 16) && examined < 512 && found.length < 8; i++) {
          const sheet = document.styleSheets[i];
          if (!sheet || sheet.disabled || (sheet.media.mediaText && !matchMedia(sheet.media.mediaText).matches)) continue;
          try {
            const vitePath = sheet.ownerNode instanceof Element ? sheet.ownerNode.getAttribute("data-vite-dev-id") : null;
            visit(sheet.cssRules, sheet.href ?? vitePath ?? undefined, 0);
          } catch { limitations.add("Some stylesheet rules are inaccessible; CSS provenance is incomplete."); }
        }
      } catch { /* CSS enrichment must never interrupt hit testing. */ }
      return found;
    }
    function aggregateBlockers(): InteractionBlocker[] {
      const aggregated = new Map<Element, { count: number; weight: number; first: number; point: { x: number; y: number } }>();
      measured.forEach(({ sample, blocker }, index) => {
        if (!blocker) return;
        const existing = aggregated.get(blocker);
        if (existing) { existing.count++; existing.weight += sample.weight; }
        else aggregated.set(blocker, { count: 1, weight: sample.weight, first: index, point: { x: sample.x, y: sample.y } });
      });
      const ranked = [...aggregated].sort((a, b) => b[1].weight - a[1].weight || b[1].count - a[1].count || a[1].first - b[1].first);
      if (ranked.length > MAX_BLOCKERS) limitations.add("Only the sixteen highest-coverage blockers are described; all blocked samples still contribute to ratios.");
      const indexByElement = new Map<Element, number>();
      const result = ranked.slice(0, MAX_BLOCKERS).map(([element, aggregate], index): InteractionBlocker => {
        indexByElement.set(element, index);
        const blocker: InteractionBlocker = { ...evidenceFor(element), blockedSamples: aggregate.count,
          blockedRatio: ratio(aggregate.weight), representativePoint: aggregate.point,
          ancestors: index === 0 ? ancestorsOf(element) : [] };
        blocker.paint = paintEvidence(element, aggregate.point);
        if (options.includeReactMetadata !== false) blocker.react = getReactRuntimeMetadata(element);
        if (index === 0) blocker.css = cssCandidates(element);
        return blocker;
      });
      for (const { sample, blocker } of measured) {
        const index = blocker ? indexByElement.get(blocker) : undefined;
        if (index !== undefined) sample.blockerIndex = index;
      }
      return result;
    }
    const blockers = aggregateBlockers();
    const computed = getRelevantComputedStyles(target);
    const targetState = getState(target);
    const originalMemberships = originalStack.map(family);
    const knownFamilyHit = originalMemberships.includes(true) || surface.eligibleSamples > 0;
    const uncertainFamily = originalMemberships.includes(undefined) || count("unresolved") > 0;
    let cause: InteractionCause = "UNKNOWN";
    const evidence: string[] = [];
    if (targetState.disabled) { cause = "TARGET_DISABLED"; evidence.push("The target matches the browser's native :disabled state."); }
    else if (targetState.inert && !knownFamilyHit && !uncertainFamily) { cause = "TARGET_INERT"; evidence.push("The target or a captured composed ancestor has inert, with no sampled target-family hits."); }
    else if ((targetState.hidden || computed.visibility === "hidden" || computed.visibility === "collapse") && !knownFamilyHit && !uncertainFamily) {
      cause = "TARGET_HIDDEN"; evidence.push("Computed display, visibility, or content-visibility suppresses the target and no sampled target-family hit was found.");
    } else if (computed["pointer-events"] === "none" && !knownFamilyHit && !uncertainFamily) {
      cause = "TARGET_POINTER_EVENTS_NONE"; evidence.push("The target computes to pointer-events:none and no sampled target-family hit was found.");
    } else if (positiveRectCount === 0 && rawRects.length <= 256) {
      if (knownFamilyHit || uncertainFamily) {
        evidence.push(knownFamilyHit
          ? "The target has no positive-area client rect but the original hit stack includes its family; descendant surface geometry is unavailable."
          : "The target has no positive-area client rect and bounded traversal left family membership unresolved.");
        limitations.add("Targets without their own boxes can have hittable overflowing descendants. Their descendant surfaces are not reconstructed in this version.");
      } else {
        cause = "TARGET_ZERO_GEOMETRY"; evidence.push("No positive-area client rect or original target-family hit was observed.");
      }
    } else if (!sampledRects.length && rawRects.length <= 256) {
      if (knownFamilyHit || uncertainFamily) {
        evidence.push("The target's own client rects are offscreen, but a visible descendant interaction cannot be ruled out.");
        limitations.add("Offscreen targets can have hittable overflowing descendants whose surfaces are not reconstructed in this version.");
      } else {
        cause = "OUTSIDE_VIEWPORT"; evidence.push("All inspected positive-area client rects are outside the viewport, with no original target-family hit.");
      }
    } else if (blockedSamples > 0) {
      cause = reachableSamples > 0 ? "PARTIAL_FOREIGN_OCCLUSION" : "FOREIGN_OCCLUSION";
      evidence.push(`${blockedSamples} samples contain a foreign hit ahead of the target family; ${reachableSamples} are reachable.`);
    } else evidence.push(reachableSamples > 0 ? "The sampled target family is reachable; no supported interaction failure was proved." : "The available samples do not establish a supported cause.");
    if (targetState.ariaDisabled) evidence.push("aria-disabled=true is declared; ARIA alone does not prove native interaction suppression.");
    const result: InteractionInspectionResult = {
      schemaVersion: "why-ui/interaction@1", inspectionId: "", capturedAt, pointer, viewport,
      target: { rawHit: rawHit ? buildNodeDescriptor(rawHit) : null, interactionTarget: buildNodeDescriptor(target),
        selectionMethod: options.targetSelector === undefined ? "pointer-hit" : "selector-hint", computed,
        state: targetState, ancestors: ancestorsOf(target), paint: paintEvidence(target) },
      interactionSurface: surface, blockers, diagnosis: { cause, evidence }, limitations: [],
    };
    if (options.includeReactMetadata !== false) result.target.react = getReactRuntimeMetadata(target);
    if (state.observer?.takeRecords().length) state.revision++;
    result.runtime = { documentId: clean(state.documentId, 128), revision: state.revision, readyState: document.readyState };
    let token = state.tokens.get(target);
    if (!token) { token = String(++state.nextToken); state.tokens.set(target, token); }
    if (!state.identities.has(token) && state.identities.size >= 100) state.identities.delete(state.identities.keys().next().value!);
    state.identities.set(token, new WeakRef(target));
    result.runtimeTargetId = token;
    if (reconciliation) result.target.selectionMethod = "reconciled";
    result.target.css = cssCandidates(target);
    if (blockers[0]) result.primaryBlocker = blockers[0];
    try { result.inspectionId = window.crypto.randomUUID(); }
    catch { result.inspectionId = `why-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${Math.random().toString(36).slice(2, 12)}`; }
    const finalRect = rectOf(target.getBoundingClientRect());
    const moved = (Object.keys(initialRect) as Array<keyof RuntimeRect>).some(key => Math.abs(initialRect[key] - finalRect[key]) > 0.5);
    const finalRects = target.getClientRects();
    const fragmentsChanged = rawRects.length !== finalRects.length || capturedRects.some((rect, index) => {
      const current = finalRects[index];
      if (!current) return true;
      const fresh = rectOf(current);
      return (Object.keys(rect) as Array<keyof RuntimeRect>).some(key => Math.abs(rect[key] - fresh[key]) > 0.5);
    });
    if (!target.isConnected || moved || fragmentsChanged || measured.some(value => value.blocker && !value.blocker.isConnected) ||
      viewport.width !== window.innerWidth || viewport.height !== window.innerHeight ||
      viewport.scrollX !== window.scrollX || viewport.scrollY !== window.scrollY) {
      return fail("RUNTIME_CHANGED_DURING_CAPTURE", "Target geometry or viewport changed during capture; retry after layout settles.");
    }
    limitations.add("Capture is synchronous but compositor animations and changing hit stacks are not an atomic browser snapshot.");
    result.limitations = [...limitations].slice(0, 16);
    if (reconciliation && request.operation === "verify") {
      let originalBlockerPresent: boolean | null = null;
      const original = request.baseline.blocker;
      if (original?.id && !original.selectorHint.includes(" >>> ")) {
        const matches = document.querySelectorAll(`#${CSS.escape(original.id)}`);
        if (!matches.length) originalBlockerPresent = false;
        else if (matches.length === 1 && matches[0]?.localName === original.tagName) originalBlockerPresent = true;
      }
      return { ok: true, result: { reconciliation, inspection: result, originalBlockerPresent } };
    }
    return { ok: true, result };
  } catch { return fail("INTERNAL_SENSOR_ERROR", "The browser could not complete this observational inspection."); }
}
