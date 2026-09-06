import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  SUPPORTED_HILO_VERSION, patchInstalledHilo3d, patchShadowUpdatesSource,
} from './patch-hilo-shadow-updates.mjs';

const require = createRequire(import.meta.url);
const packageDirectory = dirname(require.resolve('hilo3d/package.json'));
const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));
const installedSource = await readFile(join(packageDirectory, 'dist/Hilo3d.js'), 'utf8');
assert.equal(manifest.version, SUPPORTED_HILO_VERSION);

// Execute the installed engine's actual class, including its private state and helpers.
// Only extraction and transaction inputs are fixtures; no engine implementation is copied.
function residencyClass(source) {
  const start = source.indexOf('//#region src/render/renderer/ShadowAtlasPageResidency.ts');
  const end = source.indexOf('}, wR = Object.freeze', start);
  assert.ok(start >= 0 && end > start, 'The pinned bundle contains the expected residency module');
  return new Function(`${source.slice(start, end)}}; return CR;`)();
}

const viewport = { x: 0, y: 0, width: 2048, height: 2048 };
const plan = { slices: [{ viewport }] };
const totalPages = 256;
const pageBudget = 16;

function transaction() {
  const participants = new Set();
  return {
    enlist(owner) { participants.add(owner); },
    commit() {
      for (const owner of participants) owner.prepareCommit(this);
      for (const owner of participants) owner.commit(this);
    },
    rollback() { for (const owner of participants) owner.rollback(this); },
  };
}

function stage(residency, updateId, reason, options = {}) {
  const activePlan = options.plan ?? plan;
  const count = activePlan.slices.length;
  const tx = transaction();
  const result = residency.stage(activePlan, {
    sliceCount: count,
    dirtySlices: options.dirty ?? Array(count).fill(true),
    reasons: Array(count).fill(reason),
    updateIds: Array(count).fill(updateId),
  }, options.scheduled ?? Array(count).fill(true), tx);
  // The engine reuses its result object and arrays on the next stage.
  const snapshot = {
    requested: result.requestedPageCount,
    scheduled: result.scheduledPageCount,
    deferred: result.deferredPageCount,
    mandatory: result.mandatoryPageCount,
    overflow: result.budgetOverflowCount,
    complete: [...result.completedSlices],
    regions: result.updateRegions.map((region) => ({ ...region })),
  };
  return { ...snapshot, tx };
}

function assertComplete(result, expectedSlice = 0, expectedViewport = viewport) {
  assert.equal(result.requested, totalPages);
  assert.equal(result.scheduled, totalPages, 'A moving caster updates every page in the same frame');
  assert.equal(result.deferred, 0, 'No pages may retain an older pose');
  assert.equal(result.mandatory, totalPages);
  assert.equal(result.overflow, totalPages - pageBudget);
  assert.equal(result.complete[expectedSlice], true);
  assert.deepEqual(result.regions, [{
    slicePhysicalIndex: expectedSlice, pageX: 0, pageY: 0, ...expectedViewport,
  }], 'Complete pages coalesce into one draw region for the whole slice');
}

function assertIdle(result) {
  assert.equal(result.requested, 0);
  assert.equal(result.scheduled, 0);
  assert.equal(result.deferred, 0);
  assert.equal(result.mandatory, 0);
  assert.equal(result.overflow, 0);
  assert.deepEqual(result.regions, []);
}

const patched = patchShadowUpdatesSource(installedSource, manifest.version);
assert.equal(typeof patched.changed, 'boolean');
const repeated = patchShadowUpdatesSource(patched.source, manifest.version);
assert.equal(repeated.changed, false, 'The compatibility patch is idempotent');
assert.equal(repeated.source, patched.source);
assert.throws(() => patchShadowUpdatesSource(installedSource, '2.0.0-alpha.6'), /supports only 2\.0\.0-alpha\.5/);
assert.throws(() => patchShadowUpdatesSource('export {};', manifest.version), /expected exactly one .* region/);
assert.throws(() => patchShadowUpdatesSource(installedSource + installedSource, manifest.version),
  /expected exactly one .* region/,
  'An ambiguous duplicate engine module must fail closed');
const eligibility = 'if (t.dirtySlices[r] !== !0 || n[r] !== !0) continue;';
assert.ok(installedSource.includes(eligibility));
assert.throws(() => patchShadowUpdatesSource(installedSource.replace(eligibility, ''), manifest.version),
  /expected exactly one dirty and scheduled slice guard/,
  'The patch must reject a bundle that lost the dirty/scheduled guard');
const originalPolicy = 'f = d === "allocation" || d === "layout" || d === "light"';
const patchedPolicy = 'f = !0 /* pokemon: update dirty shadow slices atomically */';
assert.ok(patched.source.includes(patchedPolicy));
for (const policy of [originalPolicy, patchedPolicy]) {
  const duplicate = patched.source.replace(patchedPolicy, `${policy}, ${policy}`);
  assert.throws(() => patchShadowUpdatesSource(duplicate, manifest.version),
    /expected exactly one original or patched force-complete predicate/,
    'Duplicate predicates inside the correct module must also fail closed');
}
const misplaced = `${patched.source.replace(patchedPolicy, 'f = !0')}\n${patchedPolicy};`;
assert.throws(() => patchShadowUpdatesSource(misplaced, manifest.version),
  /force-complete predicate is outside the expected region/);

// When dependencies are already patched (for example by postinstall), the tests below
// still execute the installed implementation; this baseline runs on a clean installation.
if (patched.changed) {
  const Original = residencyClass(installedSource);
  const original = new Original({ pageSize: 128, maxPageUpdatesPerFrame: pageBudget });
  let result = stage(original, 1, 'allocation');
  assertComplete(result);
  result.tx.commit();
  result = stage(original, 2, 'caster-deformation');
  assert.equal(result.scheduled, pageBudget, 'The original engine reproduces the partial-pose regression');
  assert.equal(result.deferred, totalPages - pageBudget);
  assert.equal(result.complete[0], false);
  result.tx.commit();
  original.destroy();
}

const Patched = residencyClass(patched.source);
const residency = new Patched({ pageSize: 128, maxPageUpdatesPerFrame: pageBudget });
let result = stage(residency, 1, 'allocation');
assertComplete(result);
result.tx.commit();

// A new bone pose arrives every frame, faster than the original page budget can finish.
for (let frame = 2; frame <= 5; frame++) {
  result = stage(residency, frame, 'caster-deformation');
  assertComplete(result);
  result.tx.commit();
}
result = stage(residency, 5, null, { dirty: [false] });
assertIdle(result);
result.tx.commit();
result = stage(residency, 5, 'caster-deformation');
assertIdle(result);
assert.deepEqual(result.complete, [true], 'The frozen pose already occupies every page');
result.tx.commit();

let updateId = 6;
for (const reason of ['caster-transform', 'caster-geometry', 'caster-material', 'caster-set', 'light', 'layout']) {
  result = stage(residency, updateId++, reason);
  assertComplete(result);
  result.tx.commit();
}

result = stage(residency, updateId, 'caster-deformation');
assertComplete(result);
result.tx.rollback();
result = stage(residency, updateId - 1, 'caster-deformation');
assertIdle(result);
assert.deepEqual(result.complete, [true], 'Rollback preserves the last committed pose');
result.tx.commit();
result = stage(residency, updateId, 'caster-deformation');
assertComplete(result);
result.tx.commit();

const secondViewport = { ...viewport, x: 2048 };
const twoSlices = { slices: [{ viewport }, { viewport: secondViewport }] };
result = stage(residency, ++updateId, 'caster-deformation', {
  plan: twoSlices, scheduled: [true, false],
});
assertComplete(result);
assert.deepEqual(result.complete, [true, false], 'An unscheduled dirty slice is not forced to draw');
result.tx.commit();
result = stage(residency, updateId, 'caster-deformation', {
  plan: twoSlices, scheduled: [false, true], dirty: [false, true],
});
assertComplete(result, 1, secondViewport);
result.tx.commit();
result = stage(residency, updateId, null, { plan: twoSlices, dirty: [false, false] });
assertIdle(result);
result.tx.commit();
residency.destroy();

// File mutation is tested only in a temporary package; installed dependencies stay untouched.
const temporary = await mkdtemp(join(tmpdir(), 'pokemon-shadow-patch-'));
try {
  const bundlePath = join(temporary, 'dist/Hilo3d.js');
  const manifestPath = join(temporary, 'package.json');
  await mkdir(join(temporary, 'dist'));
  await writeFile(manifestPath, JSON.stringify({ name: 'hilo3d', version: manifest.version }));
  await writeFile(bundlePath, installedSource);
  const firstWrite = await patchInstalledHilo3d(temporary);
  assert.equal(firstWrite.changed, patched.changed);
  assert.equal(await readFile(bundlePath, 'utf8'), patched.source);
  assert.equal((await patchInstalledHilo3d(temporary)).changed, false);
  assert.equal(await readFile(bundlePath, 'utf8'), patched.source);
  await writeFile(manifestPath, JSON.stringify({ name: 'hilo3d', version: '2.0.0-alpha.6' }));
  await assert.rejects(() => patchInstalledHilo3d(temporary), /supports only 2\.0\.0-alpha\.5/);
  assert.equal(await readFile(bundlePath, 'utf8'), patched.source, 'Version mismatch leaves the file untouched');
  await writeFile(manifestPath, JSON.stringify({ name: 'hilo3d', version: manifest.version }));
  await writeFile(bundlePath, 'export {};');
  await assert.rejects(() => patchInstalledHilo3d(temporary), /expected exactly one .* region/);
  assert.equal(await readFile(bundlePath, 'utf8'), 'export {};', 'Unexpected bundle structure is never overwritten');
} finally {
  await rm(temporary, { recursive: true, force: true });
}

console.log('Hilo3D shadow update regression checks passed.');
