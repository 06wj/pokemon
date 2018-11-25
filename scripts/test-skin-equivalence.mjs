// Compare every animation against a pre-compaction models directory, without a GPU.
// Usage: node scripts/test-skin-equivalence.mjs /path/to/original/models
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as Hilo3d from 'hilo3d';
import { createPoseBaker } from '../src/hilo/bakePose.ts';

assert.equal(process.argv.length, 3, 'Pass the models directory saved before skin compaction');
const beforeDirectory = resolve(process.argv[2]);
const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('src/content/animatedModels.json', root), 'utf8'));
const frames = 8;
let totalPoses = 0;
let maxDifference = 0;

async function load(file) {
  const length = file.readUInt32LE(12);
  const document = JSON.parse(file.subarray(20, 20 + length));
  const binary = file.subarray(28 + length);
  const parsed = structuredClone(document);
  parsed.buffers[0].uri = 'model.bin';
  parsed.images = [];
  parsed.textures = [];
  parsed.materials = (document.materials ?? []).map(({ name }) => ({ name }));
  const model = await new Hilo3d.GLTFParser(JSON.stringify(parsed), { isMultiAnim: true }).parse({
    loadRes: async () => binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.length),
  });
  await model.ready;
  const rest = [...new Set(Object.values(model.anim.nodeNameMap))].map((node) => ({
    node, position: node.position.clone(), quaternion: node.quaternion.clone(),
    scale: [node.scaleX, node.scaleY, node.scaleZ],
  }));
  const bakers = model.meshes.map((mesh) => createPoseBaker(mesh, false));
  return {
    model, document, binary, bakers,
    play(name) {
      for (const { node, position, quaternion, scale } of rest) {
        node.position.copy(position); node.quaternion.copy(quaternion); node.setScale(...scale);
      }
      model.anim.play(name); model.anim.stop(); model.anim.resume(); model.anim.updateAnimStates();
    },
    update() {
      model.node.updateMatrixWorld(true);
      for (const baker of bakers) { baker.syncTransform(); baker.update(); }
    },
  };
}

function close(actual, expected, label) {
  assert.equal(actual.length, expected.length, label);
  for (let i = 0; i < actual.length; i++) {
    const delta = Math.abs(actual[i] - expected[i]);
    assert.ok(Number.isFinite(actual[i]) && delta <= 1e-5, `${label}: component ${i}, delta ${delta}`);
    maxDifference = Math.max(maxDifference, delta);
  }
}

for (const [id, asset] of Object.entries(manifest)) {
  const before = await load(await readFile(resolve(beforeDirectory, id, 'model.glb')));
  const after = await load(await readFile(new URL(`public/${asset.model}`, root)));
  try {
    for (const key of ['materials', 'textures', 'samplers', 'scenes', 'scene', 'asset']) {
      assert.deepEqual(after.document[key], before.document[key], `${id}: ${key}`);
    }
    const hierarchy = (document) => document.nodes.map(({ mesh, skin, ...node }) => node);
    assert.deepEqual(hierarchy(after.document), hierarchy(before.document), `${id}: complete bone hierarchy and authored transforms`);
    const images = ({ document, binary }) => (document.images ?? []).map((image) => {
      const view = document.bufferViews[image.bufferView];
      const offset = view.byteOffset ?? 0;
      return binary.subarray(offset, offset + view.byteLength);
    });
    assert.deepEqual(images(after), images(before), `${id}: exact embedded texture bytes`);
    assert.deepEqual(after.model.meshes.map((mesh) => mesh.name), before.model.meshes.map((mesh) => mesh.name), `${id}: draw mesh count and names`);
    assert.deepEqual(Object.keys(after.model.anim.clips), Object.keys(before.model.anim.clips), `${id}: animation clips`);
    for (const name of Object.keys(before.model.anim.clips)) {
      before.play(name); after.play(name);
      const duration = before.model.anim.endTime - before.model.anim.startTime;
      assert.equal(after.model.anim.endTime - after.model.anim.startTime, duration, `${id}: clip duration`);
      for (let frame = 0; frame <= frames; frame++) {
        before.update(); after.update();
        before.bakers.forEach(({ mesh }, index) => {
          const target = after.bakers[index].mesh;
          close(target.worldMatrix.elements, mesh.worldMatrix.elements, `${id}/${name}/${frame}: ${mesh.name} transform`);
          for (const key of ['vertices', 'normals', 'tangents', 'uvs', 'uvs1']) {
            if (mesh.geometry[key]) close(target.geometry[key].data, mesh.geometry[key].data, `${id}/${name}/${frame}: ${mesh.name} ${key}`);
          }
        });
        before.model.anim.tick(duration * 1000 / frames);
        after.model.anim.tick(duration * 1000 / frames);
        totalPoses++;
      }
    }
    console.log(`${id}: all clips preserve vertex poses, shading attributes, transforms, textures and draw meshes`);
  } finally {
    before.model.anim.stop(); after.model.anim.stop();
  }
}
console.log(`${Object.keys(manifest).length} models, ${totalPoses} before/after animation poses passed; maximum numeric difference ${maxDifference}.`);
