import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import * as Hilo3d from 'hilo3d';

// Exercise the actual controller and GLB animation state without a GPU.
// Vite resolves the application's TypeScript imports; the renderer owns no resources here.
const server = await createServer({
  configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom',
});
const { PokemonStageController } = await server.ssrLoadModule('/src/hilo/PokemonStageController.ts');
const { ToonModel } = await server.ssrLoadModule('/src/hilo/toonRendering.ts');
const { getPoseBounds } = await server.ssrLoadModule('/src/hilo/poseBounds.ts');
const manifest = JSON.parse(await readFile(new URL('../src/content/animatedModels.json', import.meta.url), 'utf8'));
// Idle-pose extents captured with the pre-upgrade pose baker (8e01bc7).
// Bind-pose geometry bounds must never replace these when framing GPU-skinned models.
const idleExtents = {
  '001': [-0.27681974, -0.00047792, -0.37900862, 0.28330085, 0.70879155, 0.47972327],
  '003': [-1.23013210, -0.01024606, -1.20529485, 1.21295989, 1.73659086, 1.31263983],
  '006': [-1.07574797, -0.06543986, -2.10420609, 1.24017847, 1.68064952, 0.89614433],
  '009': [-0.65622175, -0.05306508, -0.89875519, 0.69260198, 1.34143543, 0.72352958],
  '038': [-0.73527986, -0.00078385, -1.05468547, 0.70284402, 1.22977865, 0.65995824],
};
function assertIdleBounds(bounds, id) {
  ['xMin', 'yMin', 'zMin', 'xMax', 'yMax', 'zMax'].forEach((key, index) => {
    assert.ok(Math.abs(bounds[key] - idleExtents[id][index]) < 1e-5,
      `${id}: ${key} frames the animated silhouette, got ${bounds[key]}`);
  });
}
const files = new Map();
async function modelFor(id) {
  let file = files.get(id);
  if (!file) {
    file = await readFile(new URL(`../public/${manifest[id].model}`, import.meta.url));
    files.set(id, file);
  }
  const jsonLength = file.readUInt32LE(12);
  const json = JSON.parse(file.subarray(20, 20 + jsonLength));
  const binary = file.subarray(28 + jsonLength);
  // Image containers and real rendering are covered by models:validate and browser QA.
  json.buffers[0].uri = 'model.bin';
  json.images = [];
  json.textures = [];
  json.materials = json.materials.map(({ name }) => ({ name }));
  const model = await new Hilo3d.GLTFParser(JSON.stringify(json), { isMultiAnim: true }).parse({
    loadRes: async () => binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.length),
  });
  await model.ready;
  return model;
}

const pending = [];
const originalLoad = Hilo3d.GLTFLoader.prototype.load;
const originalError = console.error;
const errors = [];
Hilo3d.GLTFLoader.prototype.load = function ({ src }) {
  return new Promise((resolve, reject) => pending.push({ src, resolve, reject }));
};
console.error = (...args) => errors.push(args.join(' '));

function fixture(backend) {
  const controller = Object.create(PokemonStageController.prototype);
  const events = [];
  const loading = [];
  const stage = new Hilo3d.Node();
  stage.renderer = { backend, clearColor: new Hilo3d.Color(), resourceManager: { destroyMesh() {} } };
  stage.canvas = { remove() {} };
  const world = new Hilo3d.Node().addTo(stage);
  Object.assign(controller, {
    stage, world, rig: new Hilo3d.Node().addTo(world), current: null, loadSequence: 0,
    habitatKey: 'grove', habitatNode: null, habitatMeshes: [], habitatToon: null, lagoonWater: null,
    toonRendering: { enabled: false },
    keyLight: { color: new Hilo3d.Color() }, fillLight: { color: new Hilo3d.Color() },
    material: 'original', destroyed: false, environments: new Map(),
    controls: { dispose() {} }, ticker: { stop() {} }, backdrop: { dispose() {} }, habitatEffects: { dispose() {} },
    options: {
      container: { dataset: {} }, assetBase: '/', onLoadingChange: (value) => loading.push(value),
      onSceneError() {}, onAnimationChange: (name, pokemonId) => events.push({ pokemonId, name }),
    },
    getEnvironment: async () => ({ material: {}, dispose() {} }),
  });
  return { controller, events, loading };
}
function request(controller, id) {
  const promise = controller.loadPokemon({ id, types: ['grass'], ...manifest[id] });
  const response = pending.shift();
  assert.ok(response?.src.includes(`/models/${id}/`), 'Expected the selected model request');
  return { promise, ...response };
}
async function complete(controller, id) {
  const loading = request(controller, id);
  loading.resolve(await modelFor(id));
  await loading.promise;
}
function pose(meshes) {
  return meshes.map((mesh) => [...(
    mesh instanceof Hilo3d.SkinnedMesh ? mesh.getJointMat() : mesh.worldMatrix.elements
  )]);
}
function closePose(actual, expected) {
  assert.equal(actual.length, expected.length);
  actual.forEach((mesh, index) => mesh.forEach((value, component) => {
    assert.ok(Number.isFinite(value) && Math.abs(value - expected[index][component]) < 1e-5,
      `Retained action is visible on the first committed frame (${index}, ${component})`);
  }));
}

try {
  for (const id of Object.keys(idleExtents)) {
    const model = await modelFor(id);
    try {
      model.anim.play('idle'); model.anim.stop(); model.anim.resume(); model.anim.updateAnimStates();
      model.node.updateMatrixWorld(true);
      const geometry = model.meshes.map((mesh) => mesh.geometry);
      const vertices = geometry.map((item) => item.vertices.data.slice());
      assertIdleBounds(getPoseBounds(model.meshes), id);
      model.meshes.forEach((mesh, index) => {
        assert.equal(mesh.geometry, geometry[index], 'Measuring the pose keeps the GPU geometry');
        assert.deepEqual(mesh.geometry.vertices.data, vertices[index], 'Measuring the pose does not bake into source vertices');
      });
    } finally { model.anim.stop(); }
  }
  assert.equal(getPoseBounds([]), undefined, 'An empty model has no framing bounds');
  const sharedTexture = new Hilo3d.Texture({ width: 1, height: 1, image: new Uint8Array([120, 200, 160, 255]) });
  const shiftedUV = new Hilo3d.Matrix3();
  shiftedUV.elements[6] = 0.25;
  const petalMaterials = [
    new Hilo3d.PBRMaterial({ baseColorMap: sharedTexture, roughness: 0.4 }),
    new Hilo3d.PBRMaterial({ baseColorMap: sharedTexture, roughness: 0.8 }),
    new Hilo3d.PBRMaterial({ baseColorMap: { texture: sharedTexture, transform: shiftedUV } }),
  ];
  const petals = petalMaterials.map((material) => new Hilo3d.Mesh({ geometry: new Hilo3d.BoxGeometry(), material }));
  const grouped = new ToonModel(petals);
  assert.equal(grouped.surfaces.length, 2, 'Identical pigment shares a pass, while different UV transforms remain separate');
  assert.equal(grouped.surfaces[0].meshes.size, 2, 'Separate petal geometry can share pigment rendering');
  petals.forEach((mesh, index) => assert.equal(mesh.material, petalMaterials[index], 'Grouping preserves original material responses'));
  grouped.dispose();
  assert.equal(grouped.meshes.size, 0);
  for (const backend of ['webgl2', 'webgpu']) {
    const { controller, events, loading } = fixture(backend);
    for (const [id, maxJoints] of [['003', 33], ['038', 28]]) {
      await complete(controller, id);
      assertIdleBounds(controller.current.bounds, id);
      assert.ok(controller.current.meshes.every((mesh) => mesh instanceof Hilo3d.SkinnedMesh), `${id}: ${backend} keeps GPU-skinned meshes`);
      assert.equal(Math.max(...controller.current.meshes.map((mesh) => mesh.skeleton.jointCount)), maxJoints);
      controller.setAnimation('attack');
      const expected = await modelFor(id);
      expected.anim.play('attack'); expected.anim.stop(); expected.anim.resume(); expected.anim.updateAnimStates();
      expected.node.updateMatrixWorld(true);
      closePose(pose(controller.current.meshes), pose(expected.meshes));
      expected.anim.stop();
    }
    await complete(controller, '001');
    assertIdleBounds(controller.current.bounds, '001');
    controller.setAnimation('sleep');
    await complete(controller, '002');
    assert.equal(controller.current.animationName, 'sleep', 'A supported action survives a species change');
    assert.deepEqual(events.at(-1), { pokemonId: '002', name: 'sleep' }, 'UI receives the committed model and action together');
    const reference = await modelFor('002');
    reference.anim.play('sleep'); reference.anim.stop(); reference.anim.resume(); reference.anim.updateAnimStates();
    reference.node.updateMatrixWorld(true);
    closePose(pose(controller.current.meshes), pose(reference.meshes));
    const sleepBounds = [controller.current.bounds.width, controller.current.bounds.height, controller.current.bounds.depth];
    await complete(controller, '011');
    assert.equal(controller.current.animationName, 'idle', 'A model without sleep falls back to idle');
    await complete(controller, '002');
    assert.equal(controller.current.animationName, 'idle', 'A successful fallback becomes the retained action');
    assert.deepEqual([controller.current.bounds.width, controller.current.bounds.height, controller.current.bounds.depth], sleepBounds,
      'Framing still uses idle regardless of the retained action');

    controller.setAnimation('sleep');
    const beforeFailure = controller.current;
    const eventCount = events.length;
    const failed = request(controller, '011'); failed.reject(new Error('Expected network failure')); await failed.promise;
    assert.equal(controller.current, beforeFailure, 'A failed load keeps the displayed model');
    assert.equal(controller.current.animationName, 'sleep', 'A failed fallback does not erase the action');
    assert.equal(events.length, eventCount, 'A failed load does not publish speculative UI state');
    await complete(controller, '001');
    assert.equal(controller.current.animationName, 'sleep');

    const stale = request(controller, '011');
    const fresh = request(controller, '002');
    fresh.resolve(await modelFor('002')); await fresh.promise;
    const freshModel = controller.current;
    const staleModel = await modelFor('011');
    const committedCount = events.length;
    const loadingCount = loading.length;
    stale.resolve(staleModel); await stale.promise;
    assert.equal(controller.current, freshModel, 'A late unsupported model cannot replace the latest model');
    assert.equal(controller.current.animationName, 'sleep');
    assert.equal(events.length, committedCount, 'A stale completion cannot change UI selection');
    assert.equal(loading.length, loadingCount, 'A stale completion cannot end another load');
    assert.ok(staleModel.meshes.every((mesh) => mesh.isDestroyed), 'Stale candidate meshes are released');

    const staleFailure = request(controller, '011');
    await complete(controller, '001');
    const beforeStaleFailure = events.length;
    const beforeStaleLoading = loading.length;
    staleFailure.reject(new Error('Expected stale failure')); await staleFailure.promise;
    assert.equal(events.length, beforeStaleFailure, 'A stale failure cannot reset playback');
    assert.equal(loading.length, beforeStaleLoading, 'A stale failure cannot change current loading state');
    assert.equal(controller.current.animationName, 'sleep');

    const duringLoad = request(controller, '001');
    controller.setAnimation('walk');
    duringLoad.resolve(await modelFor('001')); await duringLoad.promise;
    assert.equal(controller.current.animationName, 'walk', 'Loading reads the latest displayed action before commit');
    const beforeInvalid = events.length;
    controller.setAnimation('missing');
    assert.equal(controller.current.animationName, 'walk');
    assert.equal(events.length, beforeInvalid, 'An invalid action cannot desynchronize UI state');

    const authored = controller.current.originalMaterials;
    const texture = new Hilo3d.Texture({ width: 1, height: 1, image: new Uint8Array([180, 230, 210, 255]) });
    const surface = new Hilo3d.PBRMaterial({
      roughness: 0.37, metallic: 0.24, normalScale: 0.72,
      clearcoatFactor: 0.43, anisotropyStrength: 0.61, iridescenceFactor: 0.28,
      baseColorMap: texture, normalMap: texture,
    });
    authored[0] = surface;
    controller.current.meshes[0].material = surface;
    const fields = ['roughness', 'metallic', 'normalScale', 'clearcoatFactor', 'anisotropyStrength', 'iridescenceFactor'];
    const parameters = fields.map((field) => surface[field]);
    const textureSlots = ['baseColor', 'normal'].map((slot) => surface.getTextureSlot(slot));
    const rock = new Hilo3d.Mesh({ name: 'habitat rock', geometry: new Hilo3d.BoxGeometry(), material: new Hilo3d.PBRMaterial() });
    controller.habitatMeshes = [rock];
    const rockMaterial = rock.material;
    const waterModes = [];
    controller.lagoonWater = { setToon(value) { waterModes.push(value); }, dispose() {} };
    controller.setMaterial('toon');
    const cachedToon = controller.current.toon;
    const cachedHabitatToon = controller.habitatToon;
    assert.ok(cachedHabitatToon.meshes.has(rock), 'Solid habitat props join the toon rendering');
    for (const material of ['original', 'glass', 'toon', 'original', 'toon']) controller.setMaterial(material);
    assert.equal(controller.current.toon, cachedToon, 'Switching reuses the prepared model resources');
    assert.equal(controller.habitatToon, cachedHabitatToon, 'Switching reuses the prepared scenery resources');
    assert.equal(controller.current.animationName, 'walk', 'Material changes preserve the selected action');
    controller.current.meshes.forEach((mesh, index) => assert.equal(mesh.material, authored[index], 'Toon renders the exact original material'));
    assert.deepEqual(fields.map((field) => surface[field]), parameters, 'Authored optical parameters survive mode round trips');
    ['baseColor', 'normal'].forEach((slot, index) => assert.equal(surface.getTextureSlot(slot), textureSlots[index], 'Authored texture bindings survive'));
    assert.equal(rock.material, rockMaterial, 'Toon leaves the original habitat material intact');
    controller.setMaterial('original');
    assert.equal(controller.toonRendering.enabled, false);
    assert.equal(controller.toonRendering.habitat, null);
    assert.deepEqual(waterModes, [true, false, false, true, false, true, false], 'Water follows every material transition');
    controller.lagoonWater = null;

    const validMaterialPreparation = controller.applyMaterial;
    controller.applyMaterial = () => { throw new Error('Expected material preparation failure'); };
    const beforePreparationFailure = controller.current;
    await complete(controller, '011');
    assert.equal(controller.current, beforePreparationFailure, 'Material preparation fails before destroying the old display');
    assert.equal(controller.current.animationName, 'walk');
    controller.applyMaterial = validMaterialPreparation;

    const afterDestroy = request(controller, '002');
    const finalEventCount = events.length;
    controller.destroy();
    const lateModel = await modelFor('002');
    afterDestroy.resolve(lateModel); await afterDestroy.promise;
    assert.equal(events.length, finalEventCount, 'An unmounted controller cannot update UI playback');
    assert.ok(lateModel.meshes.every((mesh) => mesh.isDestroyed));
    console.log(`${backend}: action retention, fallback, first-frame pose, framing, failures, racing loads, toon/material preservation, habitat/water switching and disposal passed.`);
  }
  assert.equal(errors.length, 6, 'Only the injected network/material failures and invalid actions were logged');
} finally {
  Hilo3d.GLTFLoader.prototype.load = originalLoad;
  console.error = originalError;
  await server.close();
}
