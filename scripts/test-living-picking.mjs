import assert from 'node:assert/strict';
import { createServer } from 'vite';
import * as Hilo3d from 'hilo3d';

const server = await createServer({ configFile: false, server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
try {
  const { pickLivingGround, subjectIsVisible } = await server.ssrLoadModule('/src/hilo/livingCapture.ts');
  const { terrainBaseHeight, riverCenterX } = await server.ssrLoadModule('/src/ecology/layout.ts');
  const down = (x, z) => new Hilo3d.Ray({ origin: new Hilo3d.Vector3(x, 12, z), direction: new Hilo3d.Vector3(0, -1, 0) });
  assert.deepEqual(pickLivingGround(down(-2, 4)), { x: -2, z: 4 });
  assert.equal(pickLivingGround(down(40, 10)), null, 'The infinite sea is not a fruit target');
  assert.ok(pickLivingGround(down(riverCenterX(4), 4)), 'A real shallow-water target can receive floating fruit');
  assert.equal(pickLivingGround(new Hilo3d.Ray({ origin: new Hilo3d.Vector3(0, 4, 0), direction: new Hilo3d.Vector3(0, 1, 0) })), null);
  const coast = pickLivingGround(down(0, 8));
  assert.ok(coast && Number.isFinite(terrainBaseHeight(coast.x, coast.z)));

  const camera = new Hilo3d.PerspectiveCamera({ x: 0, y: 1, z: 10, aspect: 1.5, fov: 40, near: .04, far: 100 });
  camera.lookAt({ x: 0, y: .5, z: 0 }); camera.updateMatrixWorld(true); camera.updateViewProjectionMatrix();
  const rig = new Hilo3d.Node(); rig.updateMatrixWorld(true);
  const subject = { uid: 'subject', pokemonId: '001', name: '妙蛙种子', rig, height: 1, width: 1 };
  assert.equal(subjectIsVisible(subject, camera, [], 800), true, 'An unobstructed resident can be recorded');
  const blocker = new Hilo3d.Mesh({ geometry: new Hilo3d.BoxGeometry({ width: 3, height: 3, depth: 1 }), material: new Hilo3d.PBRMaterial(), z: 4, y: 1 });
  blocker.updateMatrixWorld(true);
  assert.equal(subjectIsVisible(subject, camera, [blocker], 800), false, 'A resident hidden by scenery is not credited to a photo');
  blocker.x = 8; blocker.updateMatrixWorld(true);
  assert.equal(subjectIsVisible(subject, camera, [blocker], 800), true);
  rig.x = 100; rig.updateMatrixWorld(true);
  assert.equal(subjectIsVisible(subject, camera, [], 800), false, 'Offscreen residents are not credited');
  rig.x = 0; rig.updateMatrixWorld(true);

  const posed = { ...subject, bounds: { xMin: -.5, yMin: 0, zMin: -.4, xMax: .5, yMax: 1, zMax: .4 } };
  const foregroundRig = new Hilo3d.Node({ z: 4 }); foregroundRig.updateMatrixWorld(true);
  const foreground = { uid: 'snorlax', pokemonId: '143', name: '卡比兽', rig: foregroundRig, width: 3.2, height: 2.5,
    bounds: { xMin: -1.6, yMin: 0, zMin: 3, xMax: 1.6, yMax: 2.5, zMax: 4.8 } };
  assert.equal(subjectIsVisible(posed, camera, [], 800, [foreground]), false,
    'A large foreground resident can completely hide another resident');
  const narrowResident = { ...foreground, uid: 'narrow',
    bounds: { ...foreground.bounds, xMin: -.10, xMax: .10 } };
  assert.equal(subjectIsVisible(posed, camera, [], 800, [narrowResident]), true,
    'A shoulder visible beside the occluder still counts, even when both center samples are hidden');
  const narrowScenery = new Hilo3d.Mesh({ geometry: new Hilo3d.BoxGeometry({ width: .2, height: 3, depth: 1 }),
    material: new Hilo3d.PBRMaterial(), z: 4, y: 1 }); narrowScenery.updateMatrixWorld(true);
  assert.equal(subjectIsVisible(posed, camera, [narrowScenery], 800), true,
    'Side samples also retain a partly visible resident behind thin scenery');
  assert.equal(subjectIsVisible(posed, camera, [], 800, [{ ...foreground, uid: posed.uid }]), true,
    'A subject never occludes itself, including another record with the same UID');
  assert.equal(subjectIsVisible(posed, camera, [], 800, [{ ...foreground,
    bounds: { ...foreground.bounds, zMin: -6, zMax: -4 } }]), true,
    'A resident behind the target does not occlude it');
  foregroundRig.visible = false;
  assert.equal(subjectIsVisible(posed, camera, [], 800, [foreground]), true,
    'Hidden residents do not become invisible photo blockers');
  foregroundRig.visible = true;

  const sleeping = { ...subject, height: 3,
    bounds: { xMin: -.8, yMin: 0, zMin: -.65, xMax: .8, yMax: .22, zMax: .65 } };
  const lowWall = new Hilo3d.Mesh({ geometry: new Hilo3d.BoxGeometry({ width: 5, height: .70, depth: 1 }),
    material: new Hilo3d.PBRMaterial(), y: .35, z: 4 }); lowWall.updateMatrixWorld(true);
  assert.equal(subjectIsVisible(sleeping, camera, [], 800), true, 'A low sleeping pose can be visible without a blocker');
  assert.equal(subjectIsVisible(sleeping, camera, [lowWall], 800), false,
    'Current sleeping bounds keep every sample below a low wall instead of sampling an imaginary standing head');
  assert.equal(subjectIsVisible({ ...sleeping, bounds: undefined }, camera, [lowWall], 800), true,
    'Legacy callers retain their standing-dimensions fallback');
  const smallSleepingPose = { ...subject, width: 8, height: 8,
    bounds: { xMin: -.01, yMin: 0, zMin: -.01, xMax: .01, yMax: .02, zMax: .01 } };
  assert.equal(subjectIsVisible(smallSleepingPose, camera, [], 800), false,
    'The minimum screen-size threshold uses the current pose dimensions');
  assert.equal(subjectIsVisible({ ...posed, bounds: { ...posed.bounds, xMin: 100, xMax: 101 } }, camera, [], 800), false,
    'An offscreen posed body is excluded even when its rig origin remains onscreen');
  assert.equal(subjectIsVisible({ ...posed, bounds: { ...posed.bounds, xMin: 4.4, xMax: 8 } }, camera, [], 800), true,
    'A side still inside the photo can count when the center lies outside the frame');
  console.log('Living capture: legal ground/water picking and current-pose, partial, resident-occluded, sleeping, tiny, offscreen attribution passed.');
} finally { await server.close(); }
