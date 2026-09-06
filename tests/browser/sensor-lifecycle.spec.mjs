import { test, expect, openFixture, installSensor, movePointerToTarget, inspect, invokeSensor } from "./helpers.mjs";
test("re-arming upgrades an older sensor without activation or DOM mutation", async ({ page }) => {
  await openFixture(page); await installSensor(page); await movePointerToTarget(page);
  await page.evaluate(() => { const state = window[Symbol.for("why-ui.sensor.main-world.v1")]; delete state.identities; delete state.tokens; });
  expect(await invokeSensor(page, { operation:"inspect" })).toMatchObject({ok:false,error:{code:"SENSOR_NOT_AVAILABLE"}});
  await installSensor(page);
  expect(await invokeSensor(page, { operation:"inspect" })).toMatchObject({ok:false,error:{code:"NO_POINTER_CAPTURED"}});
  await movePointerToTarget(page, "#target", {u:0.6,v:0.5});
  expect((await inspect(page)).target.interactionTarget.id).toBe("target");
});
