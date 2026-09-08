import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as Hilo3d from 'hilo3d';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('src/content/animatedModels.json', root), 'utf8'));
const args = process.argv.slice(2);
assert.ok(args.length === 0 || args[0] === '--ids', 'Usage: node scripts/test-animated-models.mjs [--ids 001 003 005]');
const ids = args.length ? args.slice(1).map((id) => id.padStart(3, '0')) : Object.keys(manifest);
assert.ok(ids.length > 0, 'No models selected');
const supportedAttributes = new Set(['POSITION', 'NORMAL', 'TANGENT', 'TEXCOORD_0', 'TEXCOORD_1', 'COLOR_0', 'JOINTS_0', 'WEIGHTS_0']);
const supportedAnimations = new Set(['idle', 'walk', 'run', 'attack', 'happy', 'sleep']);
const sampleFrames = 8;
const poseTolerance = 1e-5;
let failures = 0;
let totalVertices = 0;
let totalClips = 0;

function assertClose(actual, expected, message, tolerance = poseTolerance) {
  assert.equal(actual.length, expected.length, `${message}: component count`);
  for (let index = 0; index < actual.length; index++) {
    assert.ok(Number.isFinite(actual[index]), `${message}: finite component ${index}`);
    assert.ok(Math.abs(actual[index] - expected[index]) <= tolerance,
      `${message}: component ${index}, got ${actual[index]}, expected ${expected[index]}`);
  }
}

for (const id of ids) {
  let animation;
  let model;
  try {
    const asset = manifest[id];
    assert.ok(asset, `No manifest entry for ${id}`);
    const file = await readFile(new URL(`public/${asset.model}`, root));
    assert.equal(file.length, asset.bytes, 'Manifest byte length matches the shipped GLB');
    assert.equal(file.readUInt32LE(0), 0x46546c67, 'GLB magic');
    assert.equal(file.readUInt32LE(4), 2, 'GLB version');
    assert.equal(file.readUInt32LE(8), file.length, 'GLB declared byte length');
    assert.equal(file.readUInt32LE(16), 0x4e4f534a, 'First chunk must contain JSON');
    const jsonLength = file.readUInt32LE(12);
    const json = JSON.parse(file.subarray(20, 20 + jsonLength));
    assert.equal(file.readUInt32LE(24 + jsonLength), 0x004e4942, 'Second chunk must contain binary');
    const binaryLength = file.readUInt32LE(20 + jsonLength);
    const binary = file.subarray(28 + jsonLength, 28 + jsonLength + binaryLength);
    assert.equal(binary.length, binaryLength, 'Complete binary chunk');
    assert.equal(json.buffers.length, 1, 'One embedded binary buffer');
    assert.equal(json.buffers[0].uri, undefined, 'Model must be self-contained');
    assert.ok(json.buffers[0].byteLength <= binary.length, 'Binary buffer length is valid');
    for (const view of json.bufferViews ?? []) {
      assert.equal(view.buffer, 0, 'Buffer view uses embedded binary');
      assert.ok((view.byteOffset ?? 0) + view.byteLength <= binary.length, 'Buffer view is in range');
    }
    for (const mesh of json.meshes) {
      for (const primitive of mesh.primitives) {
        for (const attribute of Object.keys(primitive.attributes)) {
          assert.ok(supportedAttributes.has(attribute), `Hilo3D does not support ${attribute}`);
        }
      }
    }
    for (const skin of json.skins ?? []) {
      assert.ok(skin.joints.length > 0 && skin.joints.length <= 128, 'Each exported skin fits the GPU joint palette');
    }
    assert.ok(json.images?.length > 0, 'Embedded texture images are present');
    for (const texture of json.textures ?? []) assert.ok(json.images[texture.source], 'Texture image reference exists');
    for (const image of json.images) {
      assert.equal(image.uri, undefined, 'Texture must be embedded');
      const view = json.bufferViews[image.bufferView];
      assert.ok(view, 'Embedded image buffer view exists');
      const bytes = binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
      if (image.mimeType === 'image/png') assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
      else if (image.mimeType === 'image/jpeg') assert.equal(bytes.subarray(0, 2).toString('hex'), 'ffd8', 'JPEG signature');
      else if (image.mimeType === 'image/webp') {
        assert.equal(bytes.subarray(0, 4).toString(), 'RIFF', 'WebP container');
        assert.equal(bytes.subarray(8, 12).toString(), 'WEBP', 'WebP signature');
      } else assert.fail(`Unsupported embedded image MIME ${image.mimeType}`);
    }
    assert.ok(Array.isArray(asset.animations) && asset.animations.length > 0, 'Manifest contains animation metadata');
    const clipNames = asset.animations.map((clip) => clip.name);
    assert.equal(new Set(clipNames).size, clipNames.length, 'Manifest animation names are unique');
    assert.equal(asset.idleAnimation, 'idle', 'Default animation uses the canonical idle name');
    assert.ok(clipNames.includes(asset.idleAnimation), 'Manifest includes the default idle animation');
    for (const clip of asset.animations) {
      assert.ok(supportedAnimations.has(clip.name), `Unsupported animation name ${clip.name}`);
      assert.ok(typeof clip.label === 'string' && clip.label.length > 0, `${clip.name}: menu label exists`);
      assert.ok(Number.isFinite(clip.duration) && clip.duration > 0, `${clip.name}: positive manifest duration`);
    }
    assert.deepEqual((json.animations ?? []).map((clip) => clip.name).sort(), [...clipNames].sort(),
      'GLB clips exactly match the manifest menu');

    // Node has no browser image decoder. Validate embedded image containers above, then parse the
    // original geometry, skinning and animation through Hilo3D with neutral materials. Real texture
    // decoding, material rendering and each graphics backend are exercised by browser playtesting.
    const parsingJson = structuredClone(json);
    parsingJson.buffers[0].uri = 'model.bin';
    parsingJson.images = [];
    parsingJson.textures = [];
    parsingJson.materials = (json.materials ?? []).map((material) => ({ name: material.name }));
    model = await new Hilo3d.GLTFParser(JSON.stringify(parsingJson)).parse({
      loadRes: async () => binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.length),
    });
    await model.ready;
    for (const mesh of model.meshes) if (mesh instanceof Hilo3d.SkinnedMesh) {
      assert.doesNotThrow(() => mesh.getRenderOption(), 'Hilo3D accepts the GPU skinning palette');
      const indices = mesh.geometry.skinIndices.data;
      assert.ok(indices.every((joint) => joint >= 0 && joint < mesh.skeleton.jointCount), 'All joint slots, including zero weights, remain in range');
    }
    animation = model.anim;
    assert.ok(animation, 'Hilo3D parsed an animation');
    assert.deepEqual(animation.clips.map((clip) => clip.name).sort(), [...clipNames].sort(), 'Hilo3D parsed every manifest clip');
    const targetIds = new Set(animation.clips.flatMap((clip) => clip.tracks.map((track) => track.target)));
    const restPose = [];
    const origins = [];
    model.node.traverse((node) => {
      if (node !== model.node && (targetIds.has(node.animationId) || targetIds.has(node.name))) restPose.push({ node });
      if (/^origin$/i.test(node.name)) origins.push(node);
    });
    const playClip = (name) => {
      animation.stop(true);
      animation.play(name, { loop: true });
      animation.pause();
      animation.update(0);
    };
    playClip(asset.idleAnimation);
    model.node.updateMatrixWorld(true);
    const sourceGeometry = model.meshes.map((mesh) => ({ geometry: mesh.geometry, stream: mesh.geometry.vertices.data, vertices: mesh.geometry.vertices.data.slice() }));
    const updatePose = () => {
      model.node.updateMatrixWorld(true);
    };
    const snapshot = () => ({
      palettes: model.meshes.map((mesh) => (
        mesh instanceof Hilo3d.SkinnedMesh ? mesh.getJointMat().slice() : mesh.worldMatrix.elements.slice()
      )),
      transforms: model.meshes.map((mesh) => mesh.worldMatrix.elements.slice()),
      joints: restPose.map(({ node }) => node.matrix.elements.slice()),
    });
    const assertPoseMatches = (expected, message) => {
      model.meshes.forEach((mesh, index) => {
        const palette = mesh instanceof Hilo3d.SkinnedMesh ? mesh.getJointMat() : mesh.worldMatrix.elements;
        assertClose(palette, expected.palettes[index], `${message}: ${mesh.name} GPU palette`);
        assertClose(mesh.worldMatrix.elements, expected.transforms[index], `${message}: ${mesh.name} transform`);
      });
      restPose.forEach(({ node }, index) => assertClose(node.matrix.elements, expected.joints[index], `${message}: ${node.name} local pose`));
    };
    const checkPose = (reference, name) => {
      let maxChange = 0;
      model.meshes.forEach((mesh, index) => {
        const palette = mesh instanceof Hilo3d.SkinnedMesh ? mesh.getJointMat() : mesh.worldMatrix.elements;
        for (let component = 0; component < palette.length; component++) {
          const value = palette[component];
          assert.ok(Number.isFinite(value), `${name}: non-finite GPU palette in ${mesh.name}`);
          maxChange = Math.max(maxChange, Math.abs(value - reference.palettes[index][component]));
        }
        for (let component = 0; component < 16; component++) {
          const value = mesh.worldMatrix.elements[component];
          assert.ok(Number.isFinite(value), `${name}: finite animated world matrix`);
          maxChange = Math.max(maxChange, Math.abs(value - reference.transforms[index][component]));
        }
        for (const attribute of [mesh.geometry.vertices, mesh.geometry.normals, mesh.geometry.uvs ? mesh.geometry.tangents : null, mesh.geometry.uvs1 ? mesh.geometry.tangents1 : null]) {
          assert.ok(!attribute || attribute.data.every(Number.isFinite), `${name}: finite animated normals/tangents`);
        }
      });
      for (const { node } of restPose) assert.ok(node.matrix.elements.every(Number.isFinite), `${name}: finite local matrix for ${node.name}`);
      return maxChange;
    };
    updatePose();
    const initialIdle = snapshot();
    const clipReports = [];
    for (const clip of asset.animations) {
      playClip(clip.name);
      updatePose();
      const duration = animation.clips.find((item) => item.name === clip.name).duration;
      assert.ok(Number.isFinite(duration) && duration > 0, `${clip.name}: positive Hilo3D clip duration`);
      assert.ok(Math.abs(duration - clip.duration) <= 1 / asset.fps + 1e-5, `${clip.name}: duration matches manifest within one frame`);
      const initial = snapshot();
      checkPose(initial, clip.name);
      const stationary = clip.name === 'walk' || clip.name === 'run';
      if (stationary) assert.ok(origins.length > 0, `${clip.name}: Origin/origin bone exists`);
      const originPositions = origins.map((node) => [node.matrix.elements[12], node.matrix.elements[14]]);
      const checkOrigin = () => {
        if (stationary) origins.forEach((node, index) => assertClose(
          [node.matrix.elements[12], node.matrix.elements[14]], originPositions[index],
          `${clip.name}: ${node.name} stays in place horizontally`,
        ));
      };
      let phasePose;
      let maxChange = 0;
      for (let frame = 1; frame <= sampleFrames; frame++) {
        animation.update(duration / sampleFrames);
        updatePose();
        maxChange = Math.max(maxChange, checkPose(initial, clip.name));
        checkOrigin();
        if (frame === sampleFrames / 4) phasePose = snapshot();
      }
      assert.ok(maxChange > 1e-6, `${clip.name}: animation changes the visible pose`);
      // The layered mixer wraps continuously. Return to quarter phase, then advance
      // complete cycles to detect accumulating root offsets.
      animation.update(duration * 0.25);
      for (let cycle = 0; cycle < 2; cycle++) {
        animation.update(duration);
        updatePose();
        checkPose(initial, clip.name);
        checkOrigin();
        assertPoseMatches(phasePose, `${clip.name}: repeated cycle ${cycle + 1}`);
      }
      playClip(asset.idleAnimation);
      updatePose();
      assertPoseMatches(initialIdle, `${clip.name} → idle restores the original first frame`);
      clipReports.push(`${clip.name} ${duration.toFixed(2)}s Δ${maxChange.toFixed(4)}`);
    }
    model.meshes.forEach((mesh, index) => {
      assert.equal(mesh.geometry, sourceGeometry[index].geometry, 'Source geometry ownership is preserved');
      assert.equal(mesh.geometry.vertices.data, sourceGeometry[index].stream, 'Source vertex storage is preserved');
      assert.deepEqual(mesh.geometry.vertices.data, sourceGeometry[index].vertices, 'Source vertices stay unchanged');
    });
    const vertices = model.meshes.reduce((sum, mesh) => sum + mesh.geometry.vertices.count, 0);
    totalVertices += vertices;
    totalClips += clipReports.length;
    console.log(`${id}: ${vertices} vertices, ${model.meshes.length} GPU-skinned meshes, ${clipReports.join(', ')}`);
  } catch (error) {
    failures++;
    console.error(`${id}: ${error instanceof Error ? error.stack : String(error)}`);
  } finally {
    animation?.stop();
    // No renderer or GPU resources exist in this Node check; the scoped model and its detached
    // source meshes are garbage-collected once the animation leaves Hilo3D's global ticker.
  }
}
console.log(`${ids.length - failures}/${ids.length} animated models passed; ${totalClips} clips, ${totalVertices} vertices. GPU rendering still requires browser verification.`);
if (failures) process.exitCode = 1;
