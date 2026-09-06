import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as Hilo3d from 'hilo3d';
import { pickEcologyResident } from '../src/hilo/ecologyPicking.ts';
import { getPoseBounds } from '../src/hilo/poseBounds.ts';
import { POKEMON_SCALE } from '../src/ecology/config.ts';

const rayTo = (from, to) => new Hilo3d.Ray({ origin: new Hilo3d.Vector3(...from),
  direction: new Hilo3d.Vector3(to[0] - from[0], to[1] - from[1], to[2] - from[2]).normalize() });

// Parse the shipped skin and animations, replacing only texture decoding so the
// regression runs headlessly with the same public Hilo3D pose/bounds path.
const bytes = await readFile(new URL('../public/models/143/model.glb', import.meta.url));
const jsonLength = bytes.readUInt32LE(12);
const json = JSON.parse(bytes.subarray(20, 20 + jsonLength));
const binary = bytes.subarray(28 + jsonLength, 28 + jsonLength + bytes.readUInt32LE(20 + jsonLength));
json.buffers[0].uri = 'model.bin';
json.images = [];
json.textures = [];
json.materials = json.materials.map((material) => ({ name: material.name }));
const model = await new Hilo3d.GLTFParser(JSON.stringify(json), { isMultiAnim: true }).parse({
  loadRes: async () => binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.length),
});
await model.ready;
const animation = model.anim;
assert.ok(animation?.clips.sleep, 'The actual Snorlax model contains its authored sleep clip');
const targets = [...new Set(Object.values(animation.clips).flatMap((clip) =>
  clip.animStatesList.map((state) => animation.nodeNameMap[state.nodeName])))].filter(Boolean);
const authoredPose = targets.filter((node) => node !== model.node).map((node) => ({ node,
  position: node.position.clone(), quaternion: node.quaternion.clone(),
  scale: new Hilo3d.Vector3(node.scaleX, node.scaleY, node.scaleZ) }));
function play(name) {
  for (const { node, position, quaternion, scale } of authoredPose) {
    node.position.copy(position); node.quaternion.copy(quaternion); node.setScale(scale.x, scale.y, scale.z);
  }
  animation.play(name); animation.stop(); animation.resume(); animation.updateAnimStates();
  model.node.updateMatrixWorld(true);
}
play('idle');
const idle = getPoseBounds(model.meshes);
assert.ok(idle);
model.node.x -= idle.x;
model.node.y -= idle.yMin;
model.node.z -= idle.z;
const rig = new Hilo3d.Node({ name: 'sleeping-snorlax' });
rig.setScale(POKEMON_SCALE);
model.node.addTo(rig);
const resident = { uid: 'snorlax', rig, meshes: model.meshes,
  width: idle.width * POKEMON_SCALE, height: idle.height * POKEMON_SCALE, depth: idle.depth * POKEMON_SCALE };
play('sleep');
animation.tick((animation.clips.sleep.end - animation.clips.sleep.start) * 500);
rig.updateMatrixWorld(true);

// This is a measured surface point on the real sleeping mesh. The former idle
// ellipsoid rejects this ray although the current visible body occupies it.
const from = [0, 4, -5];
const point = [0.091, 0.69, -1.101];
const ray = rayTo(from, point);
const rx = Math.max(0.24, resident.width * 0.5);
const ry = Math.max(0.28, resident.height * 0.55);
const rz = Math.max(0.24, resident.depth * 0.5);
const oldOrigin = [ray.origin.x / rx, (ray.origin.y - resident.height * 0.5) / ry, ray.origin.z / rz];
const oldDirection = [ray.direction.x / rx, ray.direction.y / ry, ray.direction.z / rz];
const a = oldDirection.reduce((sum, value) => sum + value * value, 0);
const b = oldDirection.reduce((sum, value, index) => sum + 2 * value * oldOrigin[index], 0);
const c = oldOrigin.reduce((sum, value) => sum + value * value, 0) - 1;
assert.ok(b * b - 4 * a * c < 0, 'The authored sleeping-body click reproduces the old collider miss');
assert.equal(pickEcologyResident(ray, [resident]), 'snorlax', 'The same ray hits the current sleeping pose');

// Move and turn the exact same 0.9-scale instance, transforming the ray in scene
// space as a camera orbit would. World bounds include every wrapper transform.
const turn = Math.PI * 0.37;
rig.x = 4.2; rig.y = 0.025; rig.z = -2.7; rig.rotationY = turn * 180 / Math.PI;
rig.updateMatrixWorld(true);
const transformed = ([x, y, z]) => [4.2 + Math.cos(turn) * x + Math.sin(turn) * z,
  0.025 + y, -2.7 - Math.sin(turn) * x + Math.cos(turn) * z];
assert.equal(pickEcologyResident(rayTo(transformed(from), transformed(point)), [resident]), 'snorlax',
  'Sleeping picking follows global scale, model heading and scene position');
animation.stop();

const boxResident = (uid, z) => {
  const boxRig = new Hilo3d.Node({ z });
  const mesh = new Hilo3d.Mesh({ geometry: new Hilo3d.BoxGeometry({ width: 1, height: 1, depth: 1 }),
    material: new Hilo3d.PBRMaterial() }).addTo(boxRig);
  boxRig.updateMatrixWorld(true);
  return { uid, rig: boxRig, meshes: [mesh], width: 1, height: 1, depth: 1 };
};
const close = boxResident('close', 2);
const far = boxResident('far', -2);
const centerRay = rayTo([0, 0, 8], [0, 0, 0]);
assert.equal(pickEcologyResident(centerRay, [far, close]), 'close', 'The nearest current bounds win independently of iteration order');
assert.equal(pickEcologyResident(centerRay, [close, far]), 'close');
assert.equal(pickEcologyResident(rayTo([0, 0, 2], [0, 0, 0]), [close]), 'close', 'A zoomed camera inside a hit volume still selects its positive exit');
assert.equal(pickEcologyResident(rayTo([20, 4, 8], [20, 4, 0]), [close, far]), null, 'Empty-space clicks remain misses');
assert.equal(pickEcologyResident(rayTo([0, 0, 8], [0, 0, 12]), [close, far]), null, 'Residents behind the camera are ignored');
close.rig.visible = false;
assert.equal(pickEcologyResident(centerRay, [close, far]), 'far', 'Hidden residents cannot capture a click');
assert.equal(pickEcologyResident(centerRay, []), null);

// The broad phase must avoid skinning every distant resident on each click.
const distantRig = new Hilo3d.Node({ x: 100 });
distantRig.updateMatrixWorld(true);
const distant = { uid: 'distant', rig: distantRig, width: 1, height: 1, depth: 1,
  get meshes() { throw new Error('The distant resident should be rejected before measuring its pose'); } };
assert.equal(pickEcologyResident(centerRay, [distant]), null);
console.log('Ecology picking: actual sleeping Snorlax regression, authored 0.9 scale, yaw/translation, nearest hit, close zoom, misses and click-time broad phase passed.');
