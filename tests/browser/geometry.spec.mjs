import {
  test, expect, openFixture, installSensor, movePointerToTarget, inspect, assertNoSideEffects,
} from './helpers.mjs';

test('native button is reachable after a real pointermove without activating or changing the page', async ({ page }) => {
  await openFixture(page, { html: '<button id="target">Pay now</button>' });
  await installSensor(page);
  const point = await movePointerToTarget(page);
  const result = await inspect(page);

  expect(result.target.interactionTarget).toMatchObject({ id: 'target', tagName: 'button' });
  expect(result.target.selectionMethod).toBe('pointer-hit');
  expect(result.pointer.pointerType).toBe('mouse');
  expect(result.pointer.clientX).toBeCloseTo(point.x, 0);
  expect(result.pointer.clientY).toBeCloseTo(point.y, 0);
  expect(result.interactionSurface.totalSamples).toBeGreaterThan(1);
  expect(result.interactionSurface.reachableRatio).toBeGreaterThan(0.9);
  expect(result.interactionSurface.blockedRatio).toBe(0);
  expect(result.primaryBlocker).toBeUndefined();
  expect(result.diagnosis.cause).toBe('UNKNOWN');
  expect(result.target.react).toEqual({ detected: false });
  await assertNoSideEffects(page);
});

test('a real SVG path hit resolves to its enclosing native button family', async ({ page }) => {
  await openFixture(page, {
    html: '<button id="target"><svg width="40" height="40" viewBox="0 0 40 40"><path id="icon-path" d="M0 0H40V40H0Z" /></svg>Pay</button>',
    css: '#target { display:flex; align-items:center; justify-content:center; gap:8px; }',
  });
  await installSensor(page);
  const point = await movePointerToTarget(page, '#icon-path');
  const firstTag = await page.evaluate(({ x, y }) => document.elementsFromPoint(x, y)[0]?.localName, point);
  expect(['path', 'svg']).toContain(firstTag);

  const result = await inspect(page);
  expect(['path', 'svg']).toContain(result.target.rawHit.tagName);
  expect(result.target.interactionTarget).toMatchObject({ id: 'target', tagName: 'button' });
  expect(result.interactionSurface.reachableRatio).toBeGreaterThan(0.9);
  expect(result.interactionSurface.blockedSamples).toBe(0);
});

test('a full foreign overlay blocks an explicitly identified underlying button', async ({ page }) => {
  await openFixture(page, {
    html: '<button id="target">Pay</button><div id="overlay"></div>',
    css: '#overlay { position:absolute; left:100px; top:100px; width:200px; height:100px; background:red; z-index:2; }',
  });
  await installSensor(page);
  await movePointerToTarget(page);
  const result = await inspect(page, { targetSelector: '#target' });

  expect(result.target.selectionMethod).toBe('selector-hint');
  expect(result.target.rawHit.id).toBe('overlay');
  expect(result.target.interactionTarget.id).toBe('target');
  expect(result.diagnosis.cause).toBe('FOREIGN_OCCLUSION');
  expect(result.interactionSurface.blockedRatio).toBeGreaterThan(0.9);
  expect(result.primaryBlocker.node.id).toBe('overlay');
  const stack = await page.evaluate(({ x, y }) => document.elementsFromPoint(x, y).map(node => node.id), result.primaryBlocker.representativePoint);
  expect(stack.indexOf('overlay')).toBe(0);
  expect(stack.indexOf('target')).toBeGreaterThan(stack.indexOf('overlay'));
  await assertNoSideEffects(page);
});

test('partial coverage is detected even though the target center is reachable', async ({ page }) => {
  await openFixture(page, {
    html: '<button id="target">Pay</button><div id="overlay"></div>',
    css: '#overlay { position:absolute; left:250px; top:100px; width:50px; height:100px; background:red; z-index:2; }',
  });
  await installSensor(page);
  const point = await movePointerToTarget(page);
  expect(await page.evaluate(({ x, y }) => document.elementsFromPoint(x, y)[0]?.id, point)).toBe('target');
  const result = await inspect(page);

  // A center-only implementation passes the center check but fails these assertions.
  expect(result.diagnosis.cause).toBe('PARTIAL_FOREIGN_OCCLUSION');
  expect(result.interactionSurface.reachableSamples).toBeGreaterThan(0);
  expect(result.interactionSurface.blockedSamples).toBeGreaterThan(0);
  expect(result.interactionSurface.blockedRatio).toBeGreaterThan(0);
  expect(result.interactionSurface.blockedRatio).toBeLessThan(1);
  expect(result.primaryBlocker.node.id).toBe('overlay');
});

test('pointer-events:none requires an identity hint because Chromium omits the target', async ({ page }) => {
  await openFixture(page, {
    html: '<button id="target">Pay</button>',
    css: '#target { pointer-events:none; }',
  });
  await installSensor(page);
  const point = await movePointerToTarget(page);
  expect(await page.evaluate(({ x, y }) => document.elementsFromPoint(x, y).some(node => node.id === 'target'), point)).toBe(false);

  // Without prior evidence the contract reports the actual hit, not an invented target.
  const unhinted = await inspect(page);
  expect(unhinted.target.interactionTarget.id).not.toBe('target');
  expect(unhinted.target.selectionMethod).toBe('pointer-hit');
  expect(unhinted.limitations.join(' ')).toContain('prior identity evidence');
  const result = await inspect(page, { targetSelector: '#target' });
  expect(result.target.interactionTarget.id).toBe('target');
  expect(result.target.computed['pointer-events']).toBe('none');
  expect(result.diagnosis.cause).toBe('TARGET_POINTER_EVENTS_NONE');
  expect(result.interactionSurface.reachableSamples).toBe(0);
  expect(result.primaryBlocker).toBeUndefined();
});

test('Chromium native disabled state is diagnosed without activating the control', async ({ page }) => {
  await openFixture(page, { html: '<button id="target" disabled>Pay</button>' });
  await installSensor(page);
  await movePointerToTarget(page);
  const result = await inspect(page);

  expect(result.target.interactionTarget.id).toBe('target');
  expect(result.target.state.disabled).toBe(true);
  expect(result.diagnosis.cause).toBe('TARGET_DISABLED');
  await assertNoSideEffects(page);
});

test('an inert ancestor suppresses target hits and is retained as causal evidence', async ({ page }) => {
  await openFixture(page, { html: '<div id="inert-container" inert><button id="target">Pay</button></div>' });
  await installSensor(page);
  const point = await movePointerToTarget(page);
  expect(await page.evaluate(({ x, y }) => document.elementsFromPoint(x, y).some(node => node.id === 'target'), point)).toBe(false);
  const result = await inspect(page, { targetSelector: '#target' });

  expect(result.diagnosis.cause).toBe('TARGET_INERT');
  expect(result.target.state.inert).toBe(true);
  expect(result.target.ancestors.find(value => value.node.id === 'inert-container')?.state.inert).toBe(true);
  expect(result.interactionSurface.reachableSamples).toBe(0);
  expect(result.primaryBlocker).toBeUndefined();
  await assertNoSideEffects(page);
});

test('a zero-sized target with no padding, border, or descendants has zero geometry', async ({ page }) => {
  await openFixture(page, {
    html: '<button id="target" aria-label="Pay"></button>',
    css: '#target { width:0; height:0; min-width:0; min-height:0; padding:0; border:0; }',
  });
  await installSensor(page);
  await page.mouse.move(100, 100);
  const result = await inspect(page, { targetSelector: '#target' });

  expect(result.target.interactionTarget.rect.width).toBe(0);
  expect(result.target.interactionTarget.rect.height).toBe(0);
  expect(result.diagnosis.cause).toBe('TARGET_ZERO_GEOMETRY');
  expect(result.interactionSurface.totalSamples).toBe(0);
});

test('rounded corners are excluded from the sampled interaction shape', async ({ page }) => {
  await openFixture(page, {
    html: '<button id="target">Pay</button>',
    css: '#target { width:120px; height:120px; border-radius:50%; }',
  });
  await installSensor(page);
  await movePointerToTarget(page);
  const result = await inspect(page);

  expect(result.interactionSurface.reachableSamples).toBeGreaterThan(0);
  const excluded = result.interactionSurface.samples.filter(sample => sample.classification === 'outside-target-shape');
  expect(excluded.length).toBeGreaterThan(0);
  expect(result.interactionSurface.reachableSamples).toBeLessThan(result.interactionSurface.totalSamples);
  expect(result.interactionSurface.blockedSamples).toBe(0);
  expect(await page.evaluate(samples => samples.every(({ x, y }) => !document.elementsFromPoint(x, y).some(node => node.id === 'target')), excluded)).toBe(true);
});

test('clip-path removes a substantial part of the bounding box from target reachability', async ({ page }) => {
  await openFixture(page, {
    html: '<button id="target">Pay</button>',
    css: '#target { width:160px; height:160px; clip-path:polygon(50% 0,100% 100%,0 100%); }',
  });
  await installSensor(page);
  await movePointerToTarget(page);
  const result = await inspect(page);

  expect(result.target.computed['clip-path']).toContain('polygon');
  expect(result.interactionSurface.reachableSamples).toBeGreaterThan(0);
  expect(result.interactionSurface.outsideSamples).toBeGreaterThan(result.interactionSurface.totalSamples / 4);
  expect(result.interactionSurface.samples.some(sample => sample.classification === 'outside-target-shape')).toBe(true);
  expect(result.interactionSurface.blockedSamples).toBe(0);
});

test('rotated fresh geometry retains outside-shape samples and detects partial coverage', async ({ page }) => {
  await openFixture(page, {
    html: '<button id="target">Pay</button><div id="overlay"></div>',
    css: '#target { transform:rotate(15deg); } #overlay { position:absolute; left:250px; top:60px; width:100px; height:200px; background:red; z-index:2; }',
  });
  await installSensor(page);
  await movePointerToTarget(page);
  const result = await inspect(page);
  const fresh = await page.locator('#target').evaluate(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }));

  expect(result.target.interactionTarget.rect.width).toBeCloseTo(fresh.width, 4);
  expect(result.target.interactionTarget.rect.height).toBeCloseTo(fresh.height, 4);
  expect(result.target.interactionTarget.rect.height).toBeGreaterThan(100);
  expect(result.target.computed.transform).toContain('matrix');
  expect(result.diagnosis.cause).toBe('PARTIAL_FOREIGN_OCCLUSION');
  expect(result.interactionSurface.reachableSamples).toBeGreaterThan(0);
  expect(result.interactionSurface.blockedSamples).toBeGreaterThan(0);
  expect(result.interactionSurface.samples.some(sample => sample.classification === 'outside-target-shape')).toBe(true);
  expect(result.primaryBlocker.node.id).toBe('overlay');
});

test('ancestor overflow clipping is excluded from reachable samples', async ({ page }) => {
  await openFixture(page, {
    html: '<div id="clip-container"><button id="target">Pay</button></div>',
    css: '#clip-container { position:absolute; left:100px; top:100px; width:120px; height:100px; overflow:hidden; } #target { left:0; top:0; width:200px; height:100px; }',
  });
  await installSensor(page);
  await movePointerToTarget(page, '#target', { u: 0.25, v: 0.5 });
  const result = await inspect(page);

  expect(result.interactionSurface.reachableSamples).toBeGreaterThan(0);
  expect(result.interactionSurface.outsideSamples).toBeGreaterThan(0);
  const outsideClip = result.interactionSurface.samples.filter(sample => sample.x > 220);
  expect(outsideClip.length).toBeGreaterThan(0);
  expect(outsideClip.every(sample => sample.classification === 'outside-target-shape')).toBe(true);
  expect(result.interactionSurface.blockedSamples).toBe(0);
  expect(result.target.ancestors.find(value => value.node.id === 'clip-container')?.computed.overflow).toBe('hidden');
});

test('a fixed overlay is a foreign blocker in actual browser paint order', async ({ page }) => {
  await openFixture(page, {
    html: '<button id="target">Pay</button><div id="overlay"></div>',
    css: '#overlay { position:fixed; left:100px; top:100px; width:200px; height:100px; background:red; z-index:20; }',
  });
  await installSensor(page);
  await movePointerToTarget(page);
  const result = await inspect(page, { targetSelector: '#target' });

  expect(result.diagnosis.cause).toBe('FOREIGN_OCCLUSION');
  expect(result.primaryBlocker.node.id).toBe('overlay');
  expect(result.primaryBlocker.computed.position).toBe('fixed');
  expect(result.primaryBlocker.computed['z-index']).toBe('20');
});

test('a covering ::before hit is attributed to its originating element, not a pseudo DOM node', async ({ page }) => {
  await openFixture(page, {
    html: '<button id="target">Pay</button><div id="overlay"></div>',
    css: '#overlay { position:fixed; left:0; top:0; width:0; height:0; z-index:20; } #overlay::before { content:""; position:absolute; left:100px; top:100px; width:200px; height:100px; background:red; }',
  });
  await installSensor(page);
  const point = await movePointerToTarget(page);
  expect(await page.evaluate(({ x, y }) => document.elementsFromPoint(x, y)[0]?.id, point)).toBe('overlay');
  const result = await inspect(page, { targetSelector: '#target' });

  expect(result.diagnosis.cause).toBe('FOREIGN_OCCLUSION');
  expect(result.primaryBlocker.node).toMatchObject({ id: 'overlay', tagName: 'div' });
  expect(result.primaryBlocker.node.rect.width).toBe(0);
  expect(result.primaryBlocker.node.rect.height).toBe(0);
  expect(result.primaryBlocker.node.selectorHint).not.toContain('::before');
  await assertNoSideEffects(page);
});

test('an open shadow button is reacquired from the host hit in the same page world', async ({ page }) => {
  await openFixture(page, {
    html: '<div id="shadow-host"></div><script>document.getElementById("shadow-host").attachShadow({mode:"open"}).innerHTML = `<button id="target" style="width:200px;height:100px;border:0;padding:0">Pay</button>`;</script>',
    css: '#shadow-host { position:absolute; left:100px; top:100px; width:200px; height:100px; }',
  });
  await installSensor(page);
  const point = await movePointerToTarget(page);
  // Document hit-testing exposes the host; the sensor expands the open root's real stack.
  expect(await page.evaluate(({ x, y }) => document.elementsFromPoint(x, y)[0]?.id, point)).toBe('shadow-host');
  const result = await inspect(page);

  expect(result.target.interactionTarget).toMatchObject({ id: 'target', tagName: 'button' });
  expect(result.target.interactionTarget.selectorHint).toContain('>>>');
  expect(result.target.ancestors.some(value => value.node.id === 'shadow-host')).toBe(true);
  expect(result.interactionSurface.reachableRatio).toBeGreaterThan(0.9);
  expect(result.interactionSurface.blockedSamples).toBe(0);
  expect(result.limitations.join(' ')).toContain('Closed shadow');
  await assertNoSideEffects(page);
});

test('a wrapping inline link is sampled across its actual client rect fragments', async ({ page }) => {
  await openFixture(page, {
    html: '<div id="wrap">Hello <a id="target" href="#unused">Pay for a longer subscription safely</a> today</div>',
    css: '#wrap { position:absolute; left:100px; top:100px; width:145px; font:20px/28px Arial,sans-serif; } #target { position:static; display:inline; width:auto; height:auto; }',
  });
  await installSensor(page);
  const fragments = await page.locator('#target').evaluate(node => Array.from(node.getClientRects(), rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })));
  expect(fragments.length).toBeGreaterThan(1);
  await page.mouse.move(fragments[0].x + fragments[0].width / 2, fragments[0].y + fragments[0].height / 2);
  const result = await inspect(page);

  expect(result.target.interactionTarget).toMatchObject({ id: 'target', tagName: 'a' });
  expect(result.interactionSurface.sampledClientRects).toBe(fragments.length);
  expect(result.interactionSurface.reachableRatio).toBeGreaterThan(0.9);
  expect(result.interactionSurface.blockedSamples).toBe(0);
  // Fragment gaps must not be sampled as though the bounding rectangle were one box.
  expect(result.interactionSurface.samples.every(sample => fragments.some(rect =>
    sample.x >= rect.x && sample.x <= rect.x + rect.width && sample.y >= rect.y && sample.y <= rect.y + rect.height,
  ))).toBe(true);
});
