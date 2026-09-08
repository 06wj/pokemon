import assert from 'node:assert/strict';
import { createServer } from 'vite';
import * as Hilo3d from 'hilo3d';

const server = await createServer({ configFile: false,
  server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
const originalLoad = Hilo3d.GLTFLoader.prototype.load;
const originalDocument = globalThis.document;
const responses = [];
const fakeElement = () => ({ dataset: {}, style: {}, append() {}, remove() {}, setAttribute() {} });
globalThis.document = { createElement: fakeElement, removeEventListener() {} };
Hilo3d.GLTFLoader.prototype.load = function ({ src }) {
  return new Promise((resolve, reject) => responses.push({ src, resolve, reject }));
};

try {
  const { EcologyStageController } = await server.ssrLoadModule('/src/hilo/EcologyStageController.ts');
  const { EcologySimulation } = await server.ssrLoadModule('/src/ecology/simulation.ts');
  const { EcologyToon } = await server.ssrLoadModule('/src/hilo/ecologyToon.ts');
  const { ECOLOGY_CAPACITY, POKEMON_SCALE } = await server.ssrLoadModule('/src/ecology/config.ts');
  const { BRIDGE, riverCenterX, terrainBaseHeight, waterSurfaceHeight } = await server.ssrLoadModule('/src/ecology/layout.ts');
  const { pokemon } = await server.ssrLoadModule('/src/content/pokemon.ts');
  const entry = (id) => pokemon.find((item) => item.id === id);
  const fixture = () => {
    const controller = Object.create(EcologyStageController.prototype);
    const stage = new Hilo3d.Node();
    stage.renderer = { resourceManager: { destroyMesh() {} } };
    stage.canvas = { removeEventListener() {}, remove() {} };
    stage.destroy = () => {};
    const snapshots = [];
    const camera = new Hilo3d.PerspectiveCamera({ aspect: 1.5, y: 10, z: 20 });
    Object.assign(controller, {
      simulation: new EcologySimulation(), residents: new Map(), reservations: new Set(),
      events: [], selectedId: null, paused: false, toon: false, destroyed: false, accumulator: 0, eventSequence: 0,
      toonView: new EcologyToon(), visibleMarkerIds: new Set(), point: new Hilo3d.Vector3(),
      camera, followingId: null, followAnchor: new Hilo3d.Vector3(), followPosition: new Hilo3d.Vector3(), followTarget: new Hilo3d.Vector3(),
      queue: Promise.resolve(), stage, markerLayer: fakeElement(), environment: { material: {}, dispose() {} },
      options: { assetBase: '/', container: fakeElement(), onError() {}, onChange(value) { snapshots.push(value); } },
      ticker: { stop() {} }, controls: { target: new Hilo3d.Vector3(), dispose() {}, setView(position, target) {
        camera.position.copy(position); this.target.copy(target); this.lastView = {position: position.clone(), target: target.clone()};
      } }, landscape: { destroy() {} }, atmosphere: { destroy() {} },
    });
    return { controller, snapshots };
  };
  const model = (height = 1) => {
    const node = new Hilo3d.Node();
    const mesh = new Hilo3d.Mesh({ geometry: new Hilo3d.BoxGeometry({ width: 1, height, depth: 1 }),
      material: new Hilo3d.PBRMaterial() }).addTo(node);
    return { node, meshes: [mesh], ready: Promise.resolve() };
  };
  const flushQueue = async () => { await new Promise((resolve) => setImmediate(resolve)); };

  const { controller, snapshots } = fixture();
  const first = controller.addPokemon(entry('001'));
  const queued = controller.addPokemon(entry('007'));
  await flushQueue();
  assert.equal(responses.length, 1, 'Model decoding is queued, preventing a burst of 30 concurrent decoders');
  assert.equal(snapshots.at(-1).pending, 2);
  controller.reset();
  assert.equal(snapshots.at(-1).pending, 0, 'Reset immediately clears in-flight reservations');
  const stale = model(); responses.shift().resolve(stale);
  await Promise.all([first, queued]);
  assert.equal(controller.residents.size, 0, 'A completed pre-reset load cannot repopulate the scene');
  assert.equal(responses.length, 0, 'Reset cancels queued loads before they fetch');
  assert.ok(stale.meshes[0].isDestroyed, 'Stale decoded geometry is released');

  const small = controller.addPokemon(entry('025')); await flushQueue();
  responses.shift().resolve(model(0.6)); await small;
  const large = controller.addPokemon(entry('006')); await flushQueue();
  responses.shift().resolve(model(2.4)); await large;
  const views = [...controller.residents.values()];
  assert.ok(Math.abs(views[1].height / views[0].height - 4) < 1e-6,
    'The original GLB geometry ratio survives independently of canonical Pokédex heights');
  assert.ok(views.every((view) => view.model.node.scaleY === 1), 'Authored model scale is not overwritten');
  assert.ok(Math.abs(views[0].height - 0.6 * POKEMON_SCALE) < 1e-6, 'Displayed measurements use the global 0.9 multiplier');
  assert.equal(controller.simulation.agents.length, 2);
  controller.simulation.agents[0].age = 2;
  controller.updateResident(controller.simulation.agents[0], views[0], 0);
  assert.ok(Math.abs(views[0].rig.scaleY - POKEMON_SCALE) < 1e-6, 'Settled model wrapper uses 0.9 with authored child transforms intact');
  const identity = [...controller.residents.values()];
  controller.setToon(true);
  assert.equal(snapshots.at(-1).toon, true);
  assert.ok(controller.toonView.rendering.model.meshes.has(views[0].model.meshes[0]), 'Live residents join the toon pipeline');
  controller.setToon(false);
  assert.deepEqual([...controller.residents.values()], identity, 'Switching rendering preserves every resident and simulation');
  controller.setToon(true);
  views[0].model.anim = { clips: [{ name: 'happy', start: 3, end: 9, duration: 6 }], stop() {} };
  const pet = controller.simulation.agents[0];
  controller.petPokemon(pet.uid);
  assert.ok(Math.abs(controller.controls.lastView.target.x - pet.x) < 1e-5, 'Petting immediately centers the camera on the touched animal');
  assert.ok(Math.abs(controller.controls.lastView.target.z - pet.z) < 1e-5);
  assert.equal(snapshots.at(-1).followingId, pet.uid, 'Petting starts persistent tracking');
  // Preserve a user-edited orbit/zoom and pan while translating with the resident.
  controller.camera.x += 2; controller.camera.z += 3; controller.controls.target.x += 0.4;
  const cameraBefore = controller.camera.position.clone(), targetBefore = controller.controls.target.clone();
  const oldPosition = { x: pet.x, z: pet.z };
  pet.x += 1.25; pet.z -= 0.75;
  controller.updateFollowCamera();
  assert.ok(Math.abs(controller.camera.x - cameraBefore.x - 1.25) < 1e-5, 'Camera follows actual horizontal displacement');
  assert.ok(Math.abs(controller.camera.z - cameraBefore.z + 0.75) < 1e-5);
  assert.ok(Math.abs(controller.controls.target.x - targetBefore.x - 1.25) < 1e-5, 'Tracking preserves the intentional pan offset');
  assert.ok(Math.abs((controller.camera.z - controller.controls.target.z) - (cameraBefore.z - targetBefore.z)) < 1e-5,
    'Tracking preserves user orbit/zoom rather than repeatedly resetting the camera');
  pet.x = oldPosition.x; pet.z = oldPosition.z; controller.updateFollowCamera();
  controller.resetView();
  assert.equal(controller.followingId, null, 'The panorama button explicitly exits tracking');
  for (let i = 0; i < 150; i++) controller.simulation.update(1 / 30);
  assert.equal(pet.state, 'happy', 'A six-second authored happy clip still plays after five seconds (clip bounds are seconds)');
  for (let i = 0; i < 45; i++) controller.simulation.update(1 / 30);
  assert.notEqual(pet.state, 'happy', 'The animal returns to autonomous life when its happy action ends');
  controller.reset();
  assert.equal(controller.toonView.rendering.model, null, 'Reset clears all toon membership before destroying source models');
  assert.equal(snapshots.at(-1).toon, true, 'Reset preserves the rendering preference');
  assert.equal(snapshots.at(-1).followingId, null, 'Cleared residents cannot remain camera targets');
  assert.equal(controller.simulation.agents.length, 0);
  assert.ok(views.every((view) => view.model.meshes[0].isDestroyed), 'Reset releases all live model geometry');

  const normalUpdate = controller.updateResident;
  const originalError = console.error;
  controller.updateResident = () => { throw new Error('Injected first-frame failure'); };
  console.error = () => {};
  try {
    const failed = controller.addPokemon(entry('007')); await flushQueue();
    const rejectedModel = model(); responses.shift().resolve(rejectedModel); await failed;
    assert.equal(controller.simulation.agents.length, 0, 'Failed presentation cannot leave an invisible collision/social agent');
    assert.equal(controller.residents.size, 0);
    assert.ok(rejectedModel.meshes[0].isDestroyed);
  } finally { controller.updateResident = normalUpdate; console.error = originalError; }

  const cap = fixture().controller;
  const loads = Array.from({ length: ECOLOGY_CAPACITY + 1 }, () => cap.addPokemon(entry('001')));
  assert.equal(cap.reservations.size, 30, 'The 30-resident capacity includes pending loads, including rapid repeated clicks');
  cap.reset(); await Promise.all(loads);
  assert.equal(responses.length, 0);

  const late = controller.addPokemon(entry('007')); await flushQueue();
  controller.destroy();
  const finalCount = snapshots.length;
  const orphan = model(); responses.shift().resolve(orphan); await late;
  assert.equal(snapshots.length, finalCount, 'An unmounted scene never updates React');
  assert.ok(orphan.meshes[0].isDestroyed, 'Unmount also releases late assets');

  const markers = Object.create(EcologyStageController.prototype);
  const markerAgents = Array.from({ length: 7 }, (_, i) => ({ uid: `m${i}`, state: 'socializing', stateTime: 0, pokemon: { name: `Buddy ${i}` } }));
  markerAgents[3].state = 'happy';
  Object.assign(markers, {
    simulation: { agents: markerAgents }, selectedId: 'm3', point: new Hilo3d.Vector3(), visibleMarkerIds: new Set(),
    camera: { isPointVisible: (point) => point.x !== 6, viewProjectionMatrix: new Hilo3d.Matrix4() },
    stage: { width: 800, height: 600 },
    residents: new Map(markerAgents.map((agent, i) => [agent.uid, {
      rig: { x: i, y: 0, z: 0 }, height: 1, marker: fakeElement(), markerX: 0, markerY: 0,
    }])),
  });
  const visible = () => [...markers.residents].filter(([, view]) => !view.marker.hidden).map(([uid]) => uid);
  markers.updateMarkers();
  assert.equal(visible().length, 2, 'Only two head bubbles are visible even with seven simultaneous interactions');
  assert.ok(visible().includes('m3'), 'The newly petted selected resident receives a visible heart');
  assert.ok(!visible().includes('m6'), 'Offscreen residents cannot consume a bubble slot');
  const stable = visible();
  markers.updateMarkers();
  assert.deepEqual(visible(), stable, 'Unchanged interaction priorities do not flicker between residents');
  markerAgents.forEach((agent) => { agent.state = 'sleeping'; });
  markers.updateMarkers();
  assert.equal(visible().length, 2, 'A sleeping group also respects the global two-bubble budget');
  markerAgents.forEach((agent) => { agent.state = 'walking'; });
  markers.updateMarkers();
  assert.deepEqual(visible(), ['m3'], 'Expired emotion bubbles disappear, leaving only the selected name');

  const gaitView = { rig: new Hilo3d.Node(), model: { anim: {
    clips: ['walk', 'run', 'sleep', 'idle'].map((name) => ({ name })), play() {}, stop() {}, pause() {}, update() {},
  } }, restorePose() {}, clip: 'idle', state: 'resting', height: 1, width: 1, depth: 1 };
  const movingAgent = { ...pet, age: 10, stateTime: 0, state: 'walking', gait: 'run', animationRate: 0.8, partnerUid: null };
  controller.updateResident(movingAgent, gaitView, 1 / 30);
  assert.equal(gaitView.clip, 'run', 'The simulation running gait actually selects the run animation');
  assert.equal(gaitView.model.anim.timeScale, 0.8, 'Animation playback uses the simulated travel rate');
  movingAgent.gait = 'walk'; movingAgent.animationRate = 0;
  controller.updateResident(movingAgent, gaitView, 1 / 30);
  assert.equal(gaitView.clip, 'walk');
  assert.equal(gaitView.model.anim.timeScale, 0, 'Blocked animals do not walk in place');
  movingAgent.state = 'sleeping';
  controller.updateResident(movingAgent, gaitView, 1 / 30);
  assert.equal(gaitView.clip, 'sleep', 'A real sleeping state selects the sleep animation');

  // The authored southern estuary lowers both ground and river surfaces. Every
  // locomotion view must follow that actual surface, rather than floating at y=0.
  const slopeAgent = { ...movingAgent, x: -0.5, z: 9.2, state: 'resting',
    profile: { ...movingAgent.profile, locomotion: 'land' } };
  controller.updateResident(slopeAgent, gaitView, 0);
  assert.ok(Math.abs(gaitView.rig.y - terrainBaseHeight(slopeAgent.x, slopeAgent.z) - 0.025) < 1e-6,
    'Ground feet follow the dry estuary slope');
  slopeAgent.profile.locomotion = 'flying'; slopeAgent.state = 'sleeping'; slopeAgent.stateTime = 2;
  controller.updateResident(slopeAgent, gaitView, 0);
  assert.ok(Math.abs(gaitView.rig.y - terrainBaseHeight(slopeAgent.x, slopeAgent.z) - 0.025) < 1e-6,
    'Flying residents land on the actual slope when sleeping');
  slopeAgent.profile.locomotion = 'amphibious'; slopeAgent.state = 'resting'; slopeAgent.z = 8.8; slopeAgent.x = riverCenterX(slopeAgent.z);
  controller.updateResident(slopeAgent, gaitView, 0);
  assert.ok(Math.abs(gaitView.rig.y - (waterSurfaceHeight(slopeAgent.z) - 0.14)) < 1e-6,
    'Amphibious residents follow the descending river surface');
  slopeAgent.profile.locomotion = 'aquatic';
  controller.updateResident(slopeAgent, gaitView, 0);
  assert.ok(Math.abs(gaitView.rig.y - (waterSurfaceHeight(slopeAgent.z) - gaitView.height * 0.3)) < 1e-6,
    'Fish body immersion is relative to the real river surface');
  slopeAgent.profile.locomotion = 'land'; slopeAgent.x = BRIDGE.x; slopeAgent.z = BRIDGE.z;
  controller.updateResident(slopeAgent, gaitView, 0);
  assert.ok(Math.abs(gaitView.rig.y - (BRIDGE.surfaceY + 0.005)) < 1e-6, 'The unchanged bridge deck retains its foot contact height');

  const tracking = fixture().controller;
  slopeAgent.x = -0.5; slopeAgent.z = 9.2;
  tracking.simulation.agents.push(slopeAgent); tracking.residents.set(slopeAgent.uid, gaitView);
  tracking.focusPokemon(slopeAgent.uid);
  const beforeY = tracking.camera.y, beforeTargetY = tracking.controls.target.y;
  const beforeSurface = terrainBaseHeight(slopeAgent.x, slopeAgent.z);
  slopeAgent.z = 9.4;
  tracking.updateFollowCamera();
  const surfaceDelta = terrainBaseHeight(slopeAgent.x, slopeAgent.z) - beforeSurface;
  assert.ok(Math.abs(tracking.camera.y - beforeY - surfaceDelta) < 1e-6, 'Following adds only the terrain elevation change to the camera');
  assert.ok(Math.abs(tracking.controls.target.y - beforeTargetY - surfaceDelta) < 1e-6, 'Terrain following preserves camera-to-target framing');
  console.log('Ecology lifecycle: queued loads, reset races, rapid-click capacity, real scale, geometry release and unmount passed.');
} finally {
  Hilo3d.GLTFLoader.prototype.load = originalLoad;
  globalThis.document = originalDocument;
  await server.close();
}
