import assert from "node:assert/strict";
import test from "node:test";
import Ajv from "ajv";
import { JSDOM } from "jsdom";
import { sensorMainWorld } from "../dist/sensor-main-world.js";
import { inspectInteractionTool } from "../dist/mcp-schema.js";

const validateInspection = new Ajv({ strict: true, allErrors: true })
  .compile(inspectInteractionTool.outputSchema);

// jsdom supplies DOM identity and selectors only. Every hit stack and layout rect
// below is an explicit adapter fixture, not a claim of browser hit-test fidelity.
function fixture(t, markup = '<button id="target">Save</button>') {
  const dom = new JSDOM(`<!doctype html><html><body>${markup}</body></html>`, {
    runScripts: "outside-only",
    url: "https://fixture.invalid/",
  });
  const { window } = dom;
  const { document } = window;
  let pointerListener;
  const eventPrototype = window.EventTarget.prototype;
  const nativeAdd = eventPrototype.addEventListener;
  eventPrototype.addEventListener = function (type, listener, options) {
    if (this === window && /^(pointer|mouse)move$/.test(type)) pointerListener = listener;
    return nativeAdd.call(this, type, listener, options);
  };
  // executeScript serializes a function without its imported/module closure.
  const invoke = window.eval(`(${sensorMainWorld.toString()})`);
  t.after(() => {
    invoke({ operation: "dispose" });
    window.close();
  });
  let hitTest = () => [];
  let hitCalls = 0;
  document.elementsFromPoint = (x, y) => {
    hitCalls += 1;
    return hitTest(x, y);
  };
  function rect(element, x = 20, y = 20, width = 120, height = 60, fragments) {
    const bounding = new window.DOMRect(x, y, width, height);
    element.getBoundingClientRect = () => bounding;
    const boxes = fragments ?? (width > 0 && height > 0 ? [bounding] : []);
    element.getClientRects = () => Object.assign([...boxes], {
      item(index) { return boxes[index] ?? null; },
    });
    return element;
  }
  function capture(x = 40, y = 40) {
    const EventConstructor = typeof window.PointerEvent === "function"
      ? window.PointerEvent : window.MouseEvent;
    // jsdom cannot generate trusted user input. Invoke the registered observer with
    // an explicit trusted-coordinate adapter, just as layout/hits are mocked above.
    // No DOM event is dispatched and this is not a browser fidelity assertion.
    const event = Object.create(EventConstructor.prototype);
    Object.defineProperties(event, {
      isTrusted: { value: true }, clientX: { value: x }, clientY: { value: y },
      pageX: { value: x }, pageY: { value: y }, pointerType: { value: "mouse" },
    });
    assert.equal(typeof pointerListener, "function");
    pointerListener.call(window, event);
  }
  function install() {
    const response = invoke({ operation: "install" });
    assert.equal(response.ok, true, JSON.stringify(response));
  }
  function inspect(options) {
    const response = invoke({ operation: "inspect", ...(options ? { options } : {}) });
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal(validateInspection(response), true, JSON.stringify(validateInspection.errors));
    assert.equal(response.result.schemaVersion, "why-ui/interaction@1");
    return response.result;
  }
  return {
    window, document, invoke, rect, capture, install, inspect,
    setHits(next) { hitTest = next; },
    get hitCalls() { return hitCalls; },
    background: [document.body, document.documentElement],
  };
}

function activate(f, hitTest) {
  f.setHits(hitTest);
  f.install();
  f.capture();
}

test("no pointer and no hit produce explicit safe machine errors", (t) => {
  const f = fixture(t);
  f.install();
  let response = f.invoke({ operation: "inspect" });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "NO_POINTER_CAPTURED");
  f.capture();
  response = f.invoke({ operation: "inspect" });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "NO_TARGET_AT_POINT");
  assert.doesNotThrow(() => JSON.stringify(response));
});

test("nested SVG resolves to its button and descendants are reachable family", (t) => {
  const f = fixture(t, '<button id="target"><svg><path id="icon" /></svg></button>');
  const button = f.rect(f.document.querySelector("button"));
  const svg = f.rect(f.document.querySelector("svg"));
  const path = f.rect(f.document.querySelector("path"));
  activate(f, () => [path, svg, button, ...f.background]);
  const result = f.inspect();
  assert.equal(result.target.rawHit.tagName.toLowerCase(), "path");
  assert.equal(result.target.interactionTarget.tagName.toLowerCase(), "button");
  assert.equal(result.target.interactionTarget.id, "target");
  assert.ok(result.interactionSurface.totalSamples >= 9);
  assert.equal(result.interactionSurface.reachableRatio, 1);
  assert.equal(result.interactionSurface.blockedSamples, 0);
  assert.equal(result.blockers.length, 0);
  assert.equal(result.target.react.detected, false);
});

test("explicit target under a full overlay reports deterministic foreign occlusion", (t) => {
  const f = fixture(t, '<button id="target">Save</button><div id="overlay"></div>');
  const button = f.rect(f.document.querySelector("button"));
  const overlay = f.rect(f.document.querySelector("#overlay"));
  activate(f, () => [overlay, button, ...f.background]);
  const result = f.inspect({ targetSelector: "#target" });
  assert.equal(result.target.rawHit.id, "overlay");
  assert.equal(result.target.selectionMethod, "selector-hint");
  assert.equal(result.diagnosis.cause, "FOREIGN_OCCLUSION");
  assert.equal(result.interactionSurface.blockedRatio, 1);
  assert.equal(result.interactionSurface.reachableRatio, 0);
  assert.equal(result.blockers.length, 1);
  assert.equal(result.primaryBlocker.node.id, "overlay");
  assert.equal(result.primaryBlocker.blockedSamples, result.interactionSurface.blockedSamples);
  assert.equal(typeof result.primaryBlocker.representativePoint.x, "number");
  assert.ok("z-index" in result.primaryBlocker.computed);
  assert.ok(Array.isArray(result.primaryBlocker.ancestors));
});

test("coordinates alone retain the top hit rather than guessing the hidden intended target", (t) => {
  const f = fixture(t, '<button id="target">Save</button><div id="overlay"></div>');
  const button = f.rect(f.document.querySelector("button"));
  const overlay = f.rect(f.document.querySelector("#overlay"));
  activate(f, () => [overlay, button, ...f.background]);
  const result = f.inspect();
  assert.equal(result.target.interactionTarget.id, "overlay");
  assert.equal(result.target.selectionMethod, "pointer-hit");
  assert.ok(result.limitations.length > 0);
});

test("sampling represents partial coverage beyond the captured point", (t) => {
  const f = fixture(t, '<button id="target">Save</button><div id="overlay"></div>');
  const button = f.rect(f.document.querySelector("button"));
  const overlay = f.rect(f.document.querySelector("#overlay"), 80, 20, 60, 60);
  activate(f, (x) => x >= 80 ? [overlay, button, ...f.background] : [button, ...f.background]);
  const result = f.inspect();
  assert.equal(result.diagnosis.cause, "PARTIAL_FOREIGN_OCCLUSION");
  assert.ok(result.interactionSurface.reachableSamples > 0);
  assert.ok(result.interactionSurface.blockedSamples > 0);
  assert.ok(result.interactionSurface.blockedRatio > 0 && result.interactionSurface.blockedRatio < 1);
  assert.ok(Math.abs(result.interactionSurface.blockedRatio + result.interactionSurface.reachableRatio - 1) < 1e-10);
});

test("a bounding-box point missing the target family is outside shape, not proven occlusion", (t) => {
  const f = fixture(t, '<button id="target">Save</button><div id="background"></div>');
  const button = f.rect(f.document.querySelector("button"));
  const background = f.rect(f.document.querySelector("#background"));
  activate(f, (x) => x < 80 ? [button, ...f.background] : [background, ...f.background]);
  const result = f.inspect();
  assert.ok(result.interactionSurface.outsideSamples > 0);
  assert.ok(result.interactionSurface.samples.some((sample) => sample.classification === "outside-target-shape"));
  assert.equal(result.interactionSurface.blockedSamples, 0);
  assert.equal(result.blockers.length, 0);
});

test("blockers aggregate by DOM identity and rank by sampled coverage", (t) => {
  const f = fixture(t, '<button id="target">Save</button><div id="large"></div><div id="small"></div>');
  const button = f.rect(f.document.querySelector("button"));
  const large = f.rect(f.document.querySelector("#large"));
  const small = f.rect(f.document.querySelector("#small"));
  activate(f, (x) => x < 80 ? [large, button, ...f.background]
    : x < 110 ? [small, button, ...f.background] : [button, ...f.background]);
  const result = f.inspect({ targetSelector: "#target" });
  assert.equal(result.blockers.length, 2);
  assert.equal(result.primaryBlocker.node.id, "large");
  assert.ok(result.blockers[0].blockedRatio > result.blockers[1].blockedRatio);
  assert.equal(result.blockers.reduce((sum, blocker) => sum + blocker.blockedSamples, 0), result.interactionSurface.blockedSamples);
  for (const sample of result.interactionSurface.samples) {
    if (sample.classification === "blocked") assert.ok(result.blockers[sample.blockerIndex]);
  }
});

test("explicit pointer-transparent target is diagnosed without changing CSS", (t) => {
  const f = fixture(t, '<button id="target" style="pointer-events:none">Save</button>');
  f.rect(f.document.querySelector("button"));
  activate(f, () => f.background);
  const result = f.inspect({ targetSelector: "#target" });
  assert.equal(result.diagnosis.cause, "TARGET_POINTER_EVENTS_NONE");
  assert.equal(result.target.computed["pointer-events"], "none");
  assert.equal(result.interactionSurface.reachableSamples, 0);
  assert.equal(f.document.querySelector("button").style.pointerEvents, "none");
});

test("pointer-events:none does not disprove reachable descendants that restore auto", (t) => {
  const f = fixture(t, '<button id="target" style="pointer-events:none"><span style="pointer-events:auto">Save</span></button>');
  const button = f.rect(f.document.querySelector("button"));
  const span = f.rect(f.document.querySelector("span"));
  activate(f, () => [span, ...f.background]);
  const result = f.inspect();
  assert.equal(result.target.interactionTarget.id, button.id);
  assert.equal(result.interactionSurface.reachableRatio, 1);
  assert.notEqual(result.diagnosis.cause, "TARGET_POINTER_EVENTS_NONE");
});

test("native disabled button is diagnosed independently of hit reachability", (t) => {
  const f = fixture(t, '<button id="target" disabled>Save</button>');
  const button = f.rect(f.document.querySelector("button"));
  activate(f, () => [button, ...f.background]);
  const result = f.inspect();
  assert.equal(result.target.state.disabled, true);
  assert.equal(result.diagnosis.cause, "TARGET_DISABLED");
});

test("aria-disabled is collected without pretending it natively disables a button", (t) => {
  const f = fixture(t, '<button id="target" aria-disabled="true">Save</button>');
  const button = f.rect(f.document.querySelector("button"));
  activate(f, () => [button, ...f.background]);
  const result = f.inspect();
  assert.equal(result.target.state.ariaDisabled, true);
  assert.equal(result.target.state.disabled, false);
  assert.notEqual(result.diagnosis.cause, "TARGET_DISABLED");
});

test("zero geometry target yields finite serializable evidence", (t) => {
  const f = fixture(t);
  f.rect(f.document.querySelector("button"), 20, 20, 0, 0);
  activate(f, () => f.background);
  const result = f.inspect({ targetSelector: "#target" });
  assert.equal(result.diagnosis.cause, "TARGET_ZERO_GEOMETRY");
  assert.equal(result.target.interactionTarget.rect.width, 0);
  assert.equal(result.interactionSurface.totalSamples, 0);
  assert.ok(Number.isFinite(result.interactionSurface.reachableRatio));
  assert.ok(Number.isFinite(result.interactionSurface.blockedRatio));
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("inert and hidden ancestry are available for explicit target diagnosis", (t) => {
  const f = fixture(t, '<section inert><button id="target">Save</button></section>');
  f.rect(f.document.querySelector("button"));
  activate(f, () => f.background);
  const result = f.inspect({ targetSelector: "#target" });
  assert.equal(result.target.state.inert, true);
  assert.equal(result.diagnosis.cause, "TARGET_INERT");
  assert.ok(result.target.ancestors.some((ancestor) => ancestor.state.inert));
});

test("React 18 host source uses bounded runtime metadata with explicit provenance", (t) => {
  const f = fixture(t);
  const button = f.rect(f.document.querySelector("button"));
  const owner = { tag: 0, type: function SaveButton() {}, return: null, _debugOwner: null };
  button.__reactFiber$fixture = {
    tag: 5, type: "button", stateNode: button, key: "save-action", return: owner,
    _debugOwner: owner,
    _debugSource: { fileName: "/src/SaveButton.tsx", lineNumber: 42, columnNumber: 7 },
  };
  activate(f, () => [button, ...f.background]);
  const result = f.inspect();
  const metadata = result.target.react;
  assert.equal(metadata.detected, true);
  assert.equal(metadata.componentName, "SaveButton");
  assert.equal(metadata.reactKey, "save-action");
  assert.ok(metadata.provenance.includes("dom-fiber-property"));
  assert.equal(metadata.source.file, "/src/SaveButton.tsx");
  assert.equal(metadata.source.line, 42);
  assert.equal(metadata.source.column, 7);
  assert.equal(metadata.source.scope, "host-jsx");
  assert.equal(metadata.source.provenance, "fiber-debug-source");
  assert.ok(["exact", "runtime-derived"].includes(metadata.source.certainty));
});

test("React 19 debug stack is a symbolication hint and never an exact source claim", (t) => {
  const f = fixture(t);
  const button = f.rect(f.document.querySelector("button"));
  const debugStack = new f.window.Error();
  debugStack.stack = "Error: react-stack-top-frame\n    at SaveButton (https://fixture.invalid/src/SaveButton.js:17:5)";
  const owner = { tag: 0, type: function SaveButton() {}, return: null, _debugOwner: null };
  button.__reactFiber$fixture = {
    tag: 5, type: "button", stateNode: button, key: null, return: owner,
    _debugOwner: owner, _debugStack: debugStack,
  };
  activate(f, () => [button, ...f.background]);
  const metadata = f.inspect().target.react;
  assert.equal(metadata.detected, true);
  assert.equal(metadata.source.provenance, "fiber-debug-stack");
  assert.equal(metadata.source.certainty, "symbolication-needed");
  assert.equal(metadata.source.scope, "candidate");
  assert.equal(metadata.source.line, 17);
  assert.equal(metadata.source.column, 5);
});

test("a hostile Fiber boundary cannot break browser diagnosis or leak thrown messages", (t) => {
  const f = fixture(t);
  const button = f.rect(f.document.querySelector("button"));
  const secret = "PRIVATE_FIBER_ERROR_92847";
  button.__reactFiber$broken = new Proxy({}, {
    get() { throw new Error(secret); },
    getOwnPropertyDescriptor() { throw new Error(secret); },
  });
  activate(f, () => [button, ...f.background]);
  const result = f.inspect();
  assert.equal(result.interactionSurface.reachableRatio, 1);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("cyclic React owner and return chains terminate and never serialize Fibers", (t) => {
  const f = fixture(t);
  const button = f.rect(f.document.querySelector("button"));
  const owner = { tag: 0, type: function CyclicOwner() {} };
  owner.return = owner;
  owner._debugOwner = owner;
  button.__reactFiber$fixture = {
    tag: 5, type: "button", stateNode: button, return: owner, _debugOwner: owner, key: null,
  };
  activate(f, () => [button, ...f.background]);
  const result = f.inspect();
  assert.equal(result.target.react.detected, true);
  assert.ok((result.target.react.ownerChain ?? []).length <= 32);
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.equal(JSON.stringify(result).includes("stateNode"), false);
});

test("payload omits form values, editable text, storage, URL attributes, and Fiber props", (t) => {
  const f = fixture(t, '<button id="target"><span>Save changes</span><input value="PRIVATE_INPUT_INITIAL"><textarea>PRIVATE_TEXTAREA</textarea><span contenteditable="true">PRIVATE_EDITABLE</span></button><a href="https://private.invalid/?token=PRIVATE_URL">Link</a>');
  const button = f.rect(f.document.querySelector("button"));
  f.document.querySelector("input").value = "PRIVATE_INPUT_LIVE";
  f.document.querySelector("textarea").value = "PRIVATE_TEXTAREA_LIVE";
  f.window.localStorage.setItem("token", "PRIVATE_STORAGE");
  f.window.sessionStorage.setItem("token", "PRIVATE_SESSION");
  f.document.cookie = "auth=PRIVATE_COOKIE";
  button.__reactFiber$fixture = {
    tag: 5, type: "button", stateNode: button, key: null, return: null,
    memoizedProps: { value: "PRIVATE_REACT_PROP" }, memoizedState: { token: "PRIVATE_REACT_STATE" },
  };
  activate(f, () => [button, ...f.background]);
  const result = f.inspect();
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("PRIVATE_"), false, serialized);
  const roundTrip = JSON.parse(serialized);
  assert.equal(roundTrip.inspectionId, result.inspectionId);
  assert.equal(roundTrip.interactionSurface.totalSamples, result.interactionSurface.totalSamples);
  for (const node of [result.target.interactionTarget, ...result.target.ancestors.map((item) => item.node)]) {
    assert.ok((node.textPreview ?? "").length <= 160);
  }
});

test("direct form-control and editable targets never expose their contents", (t) => {
  const f = fixture(t, '<input id="password" type="password" value="PRIVATE_PASSWORD"><input id="input" value="PRIVATE_INPUT"><textarea id="textarea">PRIVATE_TEXTAREA</textarea><div id="editable" contenteditable="true"><span>PRIVATE_EDITABLE</span></div>');
  f.install();
  f.capture();
  for (const id of ["password", "input", "textarea", "editable"]) {
    const target = f.rect(f.document.getElementById(id));
    f.setHits(() => [target, ...f.background]);
    const result = f.inspect({ targetSelector: `#${id}` });
    assert.equal(JSON.stringify(result).includes("PRIVATE_"), false, id);
    assert.equal(result.target.interactionTarget.textPreview, undefined);
  }
});

test("CSS-hidden target returns its runtime cause even though hit testing omits it", (t) => {
  const f = fixture(t, '<section style="display:none"><button id="target">Save</button></section>');
  f.rect(f.document.querySelector("button"), 0, 0, 0, 0);
  activate(f, () => f.background);
  const result = f.inspect({ targetSelector: "#target" });
  assert.equal(result.target.state.hidden, true);
  assert.equal(result.diagnosis.cause, "TARGET_HIDDEN");
});

test("native disabled inheritance respects the first legend exception", (t) => {
  const f = fixture(t, '<fieldset disabled><legend><button id="legend">Legend action</button></legend><button id="target">Save</button></fieldset>');
  const target = f.rect(f.document.querySelector("#target"));
  const legend = f.rect(f.document.querySelector("#legend"));
  activate(f, () => [target, ...f.background]);
  assert.equal(f.inspect().diagnosis.cause, "TARGET_DISABLED");
  f.setHits(() => [legend, ...f.background]);
  const result = f.inspect();
  assert.equal(result.target.state.disabled, false);
  assert.notEqual(result.diagnosis.cause, "TARGET_DISABLED");
});

test("selector hints reject missing and ambiguous identities instead of guessing", (t) => {
  const f = fixture(t, '<button>Save</button><button>Cancel</button>');
  activate(f, () => f.background);
  let response = f.invoke({ operation: "inspect", options: { targetSelector: "#missing" } });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "TARGET_NOT_FOUND");
  response = f.invoke({ operation: "inspect", options: { targetSelector: "button" } });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "TARGET_AMBIGUOUS");
});

test("singleton pointer listeners are passive and inspection has no interaction or DOM side effects", (t) => {
  const f = fixture(t);
  const button = f.rect(f.document.querySelector("button"));
  f.setHits(() => [button, ...f.background]);
  const additions = [];
  const removals = [];
  const prototype = f.window.EventTarget.prototype;
  const originalAdd = prototype.addEventListener;
  const originalRemove = prototype.removeEventListener;
  prototype.addEventListener = function (type, listener, options) {
    if (/^(pointer|mouse)move$/.test(type)) additions.push({ type, listener, options });
    return originalAdd.call(this, type, listener, options);
  };
  prototype.removeEventListener = function (type, listener, options) {
    if (/^(pointer|mouse)move$/.test(type)) removals.push({ type, listener, options });
    return originalRemove.call(this, type, listener, options);
  };
  const enumerableBefore = new Set(Object.keys(f.window));
  const observer = new f.window.MutationObserver(() => {});
  observer.observe(f.document, { subtree: true, attributes: true, childList: true, characterData: true });
  const interactionEvents = [];
  for (const name of ["click", "mousedown", "mouseup", "focus", "blur", "focusin", "focusout"]) {
    f.window.addEventListener(name, () => interactionEvents.push(name), true);
  }
  const focusBefore = f.document.activeElement;
  f.install();
  f.install();
  f.capture();
  f.inspect({ maxSamples: 9, includeReactMetadata: false });
  f.inspect({ maxSamples: 9, includeReactMetadata: false });
  assert.equal(additions.length, 1);
  assert.equal(additions[0].options.passive, true);
  assert.deepEqual(interactionEvents, []);
  assert.equal(f.document.activeElement, focusBefore);
  assert.equal(observer.takeRecords().length, 0);
  assert.deepEqual(Object.keys(f.window).filter((key) => !enumerableBefore.has(key)), []);
  f.invoke({ operation: "dispose" });
  assert.equal(removals.length, 1);
  assert.equal(removals[0].listener, additions[0].listener);
  observer.disconnect();
});

test("sample count stays bounded and malformed options are explicit errors", (t) => {
  const f = fixture(t);
  const button = f.rect(f.document.querySelector("button"));
  activate(f, () => [button, ...f.background]);
  const initialCalls = f.hitCalls;
  const result = f.inspect({ maxSamples: 9, includeReactMetadata: false });
  assert.ok(result.interactionSurface.totalSamples <= 9);
  assert.ok(result.interactionSurface.totalSamples > 1);
  assert.ok(f.hitCalls - initialCalls <= 11);
  assert.equal(result.target.react, undefined);
  for (const maxSamples of [0, 8, 129, 3.5, "64", Number.NaN]) {
    const response = f.invoke({ operation: "inspect", options: { maxSamples } });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "INVALID_OPTIONS");
  }
});

test("open shadow descendants retain their host's ordering below a foreign overlay", (t) => {
  const f = fixture(t, '<section id="host"></section><div id="overlay"></div>');
  const host = f.rect(f.document.querySelector("#host"));
  const overlay = f.rect(f.document.querySelector("#overlay"), 80, 20, 60, 60);
  const shadow = host.attachShadow({ mode: "open" });
  // Fixture setup only; mutation observation in the safety test starts after setup.
  shadow.innerHTML = '<button id="shadow-target"><svg><path id="shadow-icon" /></svg></button>';
  const button = f.rect(shadow.querySelector("button"));
  const svg = f.rect(shadow.querySelector("svg"));
  const path = f.rect(shadow.querySelector("path"));
  shadow.elementsFromPoint = () => [path, svg, button, host, ...f.background];
  activate(f, (x) => x >= 80 ? [overlay, host, ...f.background] : [host, ...f.background]);
  const result = f.inspect();
  assert.equal(result.target.rawHit.id, "shadow-icon");
  assert.equal(result.target.interactionTarget.id, "shadow-target");
  assert.ok(result.interactionSurface.reachableSamples > 0);
  assert.ok(result.interactionSurface.blockedSamples > 0);
  assert.equal(result.primaryBlocker.node.id, "overlay");
});

test("slotted content belongs to its composed interactive ancestor", (t) => {
  const f = fixture(t, '<section id="host"><span id="slotted" slot="action">Save</span></section>');
  const host = f.rect(f.document.querySelector("#host"));
  const span = f.rect(f.document.querySelector("#slotted"));
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = '<button id="shadow-target"><slot name="action"></slot></button>';
  const button = f.rect(shadow.querySelector("button"));
  const slot = f.rect(shadow.querySelector("slot"));
  shadow.elementsFromPoint = () => [span, slot, button, host, ...f.background];
  activate(f, () => [span, host, ...f.background]);
  const result = f.inspect();
  assert.equal(result.target.rawHit.id, "slotted");
  assert.equal(result.target.interactionTarget.id, "shadow-target");
  assert.equal(result.interactionSurface.reachableRatio, 1);
});

test("sampling uses separate wrapping client rects and fresh geometry on every inspection", (t) => {
  const f = fixture(t, '<a id="target" href="/save">Save changes</a>');
  const firstLine = new f.window.DOMRect(20, 20, 120, 20);
  const secondLine = new f.window.DOMRect(20, 60, 80, 20);
  const target = f.rect(f.document.querySelector("a"), 20, 20, 120, 60, [firstLine, secondLine]);
  activate(f, (x, y) => ((x >= 20 && x < 140 && y >= 20 && y < 40)
    || (x >= 20 && x < 100 && y >= 60 && y < 80)) ? [target, ...f.background] : f.background);
  f.capture(40, 30);
  const initial = f.inspect();
  assert.equal(initial.interactionSurface.sampledClientRects, 2);
  assert.ok(initial.interactionSurface.samples.some((sample) => sample.y >= 20 && sample.y < 40));
  assert.ok(initial.interactionSurface.samples.some((sample) => sample.y >= 60 && sample.y < 80));
  f.rect(target, 200, 100, 200, 80);
  f.setHits(() => [target, ...f.background]);
  const current = f.inspect({ targetSelector: "#target" });
  assert.equal(current.target.interactionTarget.rect.x, 200);
  assert.equal(current.target.interactionTarget.rect.width, 200);
  assert.equal(current.interactionSurface.sampledClientRects, 1);
  assert.ok(current.interactionSurface.samples.some((sample) => sample.x > 200));
  assert.notEqual(current.inspectionId, initial.inspectionId);
});

test("a fully offscreen explicit target is outside viewport, not a failed sample hit", (t) => {
  const f = fixture(t);
  f.rect(f.document.querySelector("button"), -200, -100, 120, 60);
  activate(f, () => f.background);
  const result = f.inspect({ targetSelector: "#target" });
  assert.equal(result.diagnosis.cause, "OUTSIDE_VIEWPORT");
  assert.equal(result.interactionSurface.reachableSamples, 0);
  assert.equal(result.interactionSurface.blockedSamples, 0);
});

test("eligible descendants beneath an overlay prove occlusion despite inherited suppression styles", (t) => {
  const f = fixture(t, '<button id="target"><span>Save</span></button><div id="overlay"></div>');
  const button = f.rect(f.document.querySelector("button"));
  const span = f.rect(f.document.querySelector("span"));
  const overlay = f.rect(f.document.querySelector("#overlay"));
  activate(f, () => [overlay, span, ...f.background]);
  for (const [property, suppressed, restored] of [["pointerEvents", "none", "auto"], ["visibility", "hidden", "visible"]]) {
    button.style[property] = suppressed;
    span.style[property] = restored;
    const result = f.inspect({ targetSelector: "#target" });
    assert.equal(result.interactionSurface.blockedRatio, 1);
    assert.equal(result.diagnosis.cause, "FOREIGN_OCCLUSION", property);
    button.style[property] = "";
    span.style[property] = "";
  }
});

test("CSS URL redaction handles closing parentheses inside quoted URLs", (t) => {
  const f = fixture(t);
  const button = f.rect(f.document.querySelector("button"));
  button.style.filter = 'url("https://fixture.invalid/)?auth=PRIVATE_FILTER")';
  button.style.clipPath = 'url("https://fixture.invalid/)?auth=PRIVATE_CLIP")';
  assert.ok(f.window.getComputedStyle(button).filter.includes("PRIVATE_FILTER"));
  activate(f, () => [button, ...f.background]);
  const result = f.inspect();
  assert.equal(JSON.stringify(result).includes("PRIVATE_"), false);
});

test("privacy traversal limits cannot expose deeply nested editable contents", (t) => {
  const markup = `<div contenteditable="true">${"<span>".repeat(70)}<button id="target">PRIVATE_DEEP_EDITABLE</button>${"</span>".repeat(70)}</div>`;
  const f = fixture(t, markup);
  const button = f.rect(f.document.querySelector("button"));
  activate(f, () => [button, ...f.background]);
  assert.equal(JSON.stringify(f.inspect()).includes("PRIVATE_DEEP_EDITABLE"), false);
});

test("existing React hook enriches only the renderer that recognizes the target", (t) => {
  const f = fixture(t);
  const button = f.rect(f.document.querySelector("button"));
  const fiber = {
    tag: 5, type: "button", stateNode: button, key: null, return: null,
    _debugOwner: { name: "ModernOwner", owner: null },
  };
  const renderers = new f.window.Map([
    [1, { version: "unrelated-renderer", findFiberByHostInstance: () => null }],
    [2, { version: "19.1.0", findFiberByHostInstance: (node) => node === button ? fiber : null }],
  ]);
  f.window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { renderers };
  activate(f, () => [button, ...f.background]);
  const metadata = f.inspect().target.react;
  assert.equal(metadata.detected, true);
  assert.equal(metadata.version, "19.1.0");
  assert.equal(metadata.componentName, "ModernOwner");
  assert.ok(metadata.provenance.includes("devtools-hook"));
  renderers.delete(2);
  assert.equal(f.inspect().target.react.detected, false);
});

test("a colliding sensor namespace is preserved and reported without installing a listener", (t) => {
  const f = fixture(t);
  const key = f.window.Symbol.for("why-ui.sensor.main-world.v1");
  const applicationValue = { applicationOwned: true };
  Object.defineProperty(f.window, key, { value: applicationValue, configurable: true });
  const response = f.invoke({ operation: "install" });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "SENSOR_NOT_AVAILABLE");
  assert.equal(f.window[key], applicationValue);
});

test("a target disconnected during sampling produces a safe capture error", (t) => {
  const f = fixture(t);
  const button = f.rect(f.document.querySelector("button"));
  let calls = 0;
  activate(f, () => {
    // Deliberately simulate a runtime replacement in the browser adapter.
    if (++calls === 2) button.remove();
    return [button, ...f.background];
  });
  const response = f.invoke({ operation: "inspect" });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "RUNTIME_CHANGED_DURING_CAPTURE");
  assert.equal(validateInspection(response), true, JSON.stringify(validateInspection.errors));
});

test("a React error message that resembles a source path is not a stack frame", (t) => {
  const f = fixture(t);
  const button = f.rect(f.document.querySelector("button"));
  button.__reactFiber$fixture = {
    tag: 5, type: "button", stateNode: button, key: null, return: null,
    _debugStack: "Error: /PRIVATE_ERROR_MESSAGE.tsx:12:4",
  };
  activate(f, () => [button, ...f.background]);
  const result = f.inspect();
  assert.equal(result.target.react.detected, true);
  assert.equal(result.target.react.source, undefined);
  assert.equal(JSON.stringify(result).includes("PRIVATE_ERROR_MESSAGE"), false);
});

test("zero target boxes do not disprove a directly observed reachable descendant", (t) => {
  const f = fixture(t, '<div id="target" role="button" style="display:contents"><span>Save</span></div>');
  f.rect(f.document.querySelector("#target"), 0, 0, 0, 0);
  const span = f.rect(f.document.querySelector("span"));
  activate(f, () => [span, ...f.background]);
  const result = f.inspect();
  assert.equal(result.target.interactionTarget.id, "target");
  assert.equal(result.interactionSurface.totalSamples, 0);
  assert.equal(result.diagnosis.cause, "UNKNOWN");
});

test("a capped fragment scan cannot prove zero geometry in uninspected fragments", (t) => {
  const f = fixture(t);
  const fragments = Array.from({ length: 256 }, () => new f.window.DOMRect(20, 20, 0, 0));
  fragments.push(new f.window.DOMRect(20, 20, 120, 60));
  f.rect(f.document.querySelector("button"), 20, 20, 120, 60, fragments);
  activate(f, () => f.background);
  const result = f.inspect({ targetSelector: "#target" });
  assert.equal(result.interactionSurface.clientRectsTruncated, true);
  assert.equal(result.diagnosis.cause, "UNKNOWN");
});

test("unavailable shadow hit-testing preserves document-level inspection with a limitation", (t) => {
  const f = fixture(t, '<section id="host"></section>');
  const host = f.rect(f.document.querySelector("#host"));
  const shadow = host.attachShadow({ mode: "open" });
  shadow.elementsFromPoint = () => { throw new Error("PRIVATE_SHADOW_EXCEPTION"); };
  activate(f, () => [host, ...f.background]);
  const result = f.inspect();
  assert.equal(result.target.interactionTarget.id, "host");
  assert.ok(result.limitations.some((limitation) => /shadow/i.test(limitation)));
  assert.equal(JSON.stringify(result).includes("PRIVATE_SHADOW_EXCEPTION"), false);
});

test("application-synthesized movement cannot overwrite the captured user pointer", (t) => {
  const f = fixture(t);
  const button = f.rect(f.document.querySelector("button"));
  activate(f, () => [button, ...f.background]);
  const EventConstructor = f.window.PointerEvent ?? f.window.MouseEvent;
  const type = f.window.PointerEvent ? "pointermove" : "mousemove";
  // Test-only hostile application input; the production sensor never dispatches events.
  f.document.body.dispatchEvent(new EventConstructor(type, { clientX: 900, clientY: 700, bubbles: true }));
  const result = f.inspect();
  assert.equal(result.pointer.clientX, 40);
  assert.equal(result.pointer.clientY, 40);
});

test("page-visible pointer state cannot add private or cyclic fields to the payload", (t) => {
  const f = fixture(t);
  const button = f.rect(f.document.querySelector("button"));
  activate(f, () => [button, ...f.background]);
  const state = f.window[Symbol.for("why-ui.sensor.main-world.v1")];
  state.pointer.extra = { secret: "PRIVATE_POINTER_DATA", node: button };
  state.pointer.cycle = state.pointer;
  const serialized = JSON.stringify(f.inspect());
  assert.equal(serialized.includes("PRIVATE_POINTER_DATA"), false);
  assert.equal(serialized.includes('"cycle"'), false);
});

test("deep native descendants remain family and exhausted shadow ancestry stays unresolved", (t) => {
  const f = fixture(t, `<button id="target">${"<span>".repeat(70)}<b id="leaf">Save</b>${"</span>".repeat(70)}</button>`);
  const button = f.rect(f.document.querySelector("button"));
  const leaf = f.rect(f.document.querySelector("#leaf"));
  activate(f, () => [leaf, button, ...f.background]);
  assert.equal(f.inspect({ targetSelector: "#target" }).interactionSurface.reachableRatio, 1);

  const shadowFixture = fixture(t, '<div id="target" role="button"></div>');
  const host = shadowFixture.rect(shadowFixture.document.querySelector("#target"));
  const shadow = host.attachShadow({ mode: "open" });
  // Test-only fixture construction, before inspection.
  shadow.innerHTML = `${"<span>".repeat(70)}<b id="leaf">Save</b>${"</span>".repeat(70)}`;
  const shadowLeaf = shadowFixture.rect(shadow.querySelector("#leaf"));
  activate(shadowFixture, () => [shadowLeaf, host, ...shadowFixture.background]);
  const result = shadowFixture.inspect({ targetSelector: "#target" });
  assert.equal(result.interactionSurface.blockedSamples, 0);
  assert.ok(result.interactionSurface.samples.every(sample => sample.classification === "unresolved"));
  assert.equal(result.diagnosis.cause, "UNKNOWN");
});

test("React stack paths retain route-group parentheses and redact URL credentials", (t) => {
  const f = fixture(t);
  const button = f.rect(f.document.querySelector("button"));
  button.__reactFiber$fixture = {
    tag: 5, type: "button", stateNode: button, key: null,
    _debugStack: "Error\n    at Save (webpack-internal:///(app-pages-browser)/./app/(auth)/page.tsx:17:5)",
  };
  activate(f, () => [button, ...f.background]);
  assert.equal(f.inspect().target.react.source.file, "webpack-internal:///(app-pages-browser)/./app/(auth)/page.tsx");
  button.__reactFiber$fixture._debugStack = "Error\n    at Save (https://PRIVATE_USER:PRIVATE_PASSWORD@fixture.invalid/page.js?token=PRIVATE_TOKEN:17:5)";
  const result = f.inspect();
  assert.equal(result.target.react.source.file, "https://[redacted]@fixture.invalid/page.js");
  assert.equal(JSON.stringify(result).includes("PRIVATE_"), false);
});

test("changing fragments with a stable bounding box invalidates capture", (t) => {
  const f = fixture(t);
  const button = f.rect(f.document.querySelector("button"));
  let reads = 0;
  button.getClientRects = () => [new f.window.DOMRect(20, ++reads === 1 ? 20 : 40, 120, 20)];
  activate(f, () => [button, ...f.background]);
  const response = f.invoke({ operation: "inspect" });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "RUNTIME_CHANGED_DURING_CAPTURE");
});

test("an offscreen wrapper does not disprove a visible overflowing descendant", (t) => {
  const f = fixture(t, '<div id="target" role="button"><span id="leaf">Save</span></div>');
  const target = f.rect(f.document.querySelector("#target"), -200, -100, 120, 60);
  const leaf = f.rect(f.document.querySelector("#leaf"));
  activate(f, () => [leaf, ...f.background]);
  const result = f.inspect({ targetSelector: "#target" });
  assert.equal(target.contains(leaf), true);
  assert.equal(result.diagnosis.cause, "UNKNOWN");
  assert.equal(result.interactionSurface.totalSamples, 0);
});
