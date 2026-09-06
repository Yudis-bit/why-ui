import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { WorkspaceObserver } from "../dist/daemon/workspace.js";
import { InspectionStore } from "../dist/daemon/inspection-store.js";
import { sourceFixture } from "./source-fixture.mjs";
test("workspace hashes observe real source edits; touching a file is not a patch", async () => {
  const fixture = await sourceFixture();
  try {
    const observer = new WorkspaceObserver(fixture.root);
    const baseline = await observer.capture(["src/Payment.jsx", "src/styles.module.css"]);
    assert.equal(baseline.complete, true); assert.equal(baseline.files.length, 2);
    fs.utimesSync(path.join(fixture.root, "src/Payment.jsx"), new Date(), new Date());
    assert.equal((await observer.capture(baseline.files.map(f => f.file))).fingerprint, baseline.fingerprint);
    await fixture.patch("good");
    const current = await observer.capture(baseline.files.map(f => f.file));
    assert.notEqual(current.fingerprint, baseline.fingerprint);
    assert.ok(current.files.every(f => !path.isAbsolute(f.file)));
  } finally { await fixture.close(); }
});
test("inspection snapshots and lifecycle baselines are immutable and evict together", () => {
  const store = new InspectionStore(1);
  const result = { inspectionId: "one", diagnosis: { cause: "FOREIGN_OCCLUSION" } };
  const meta = { revision: { fingerprint: "original" } };
  store.set("one", result); store.setBaseline("one", meta);
  result.diagnosis.cause = "UNKNOWN"; meta.revision.fingerprint = "modified";
  assert.equal(store.get("one").diagnosis.cause, "FOREIGN_OCCLUSION");
  assert.equal(store.baseline("one").revision.fingerprint, "original");
  store.get("one").diagnosis.cause = "UNKNOWN";
  store.setBaseline("one", meta); assert.equal(store.baseline("one").revision.fingerprint, "original");
  store.set("two", result); assert.equal(store.baseline("one"), undefined);
});
