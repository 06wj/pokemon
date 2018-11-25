import assert from 'node:assert/strict';
import * as Hilo3d from 'hilo3d';
import { createPoseBaker } from '../src/hilo/bakePose.ts';

function close(actual, expected, message) {
  assert.equal(actual.length, expected.length, message);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-5,
    `${message}: component ${index}, got ${value}, expected ${expected[index]}`));
}

const root = new Hilo3d.Node({ x: 3 });
const firstJoint = new Hilo3d.Node({ x: 7, scaleX: 2 }).addTo(root);
const secondJoint = new Hilo3d.Node({ x: 11, scaleY: 3 }).addTo(root);
const geometry = new Hilo3d.Geometry({
  vertices: new Hilo3d.GeometryData(new Float32Array([99, 1, 2, 3, 99, 0, 1, 0]), 3, { stride: 16, offset: 4 }),
  normals: new Hilo3d.GeometryData(new Float32Array([1, 1, 0, 0, 0, 1]), 3),
  tangents: new Hilo3d.GeometryData(new Float32Array([1, -1, 0, -1, 1, 0, 0, 1]), 4),
  uvs: new Hilo3d.GeometryData(new Float32Array([0, 0, 1, 1]), 2),
  skinWeights: new Hilo3d.GeometryData(new Uint8Array([128, 128, 0, 0, 0, 0, 0, 0]), 4, { normalized: true }),
  skinIndices: new Hilo3d.GeometryData(new Uint16Array([0, 1, 0, 0, 0, 0, 0, 0]), 4),
});
const skeleton = new Hilo3d.Skeleton({
  jointNodeList: [firstJoint, secondJoint],
  inverseBindMatrices: [new Hilo3d.Matrix4(), new Hilo3d.Matrix4()],
});
const source = new Hilo3d.SkinnedMesh({ name: 'two-bone-pose', geometry, skeleton, x: 5 }).addTo(root);
const child = new Hilo3d.Node({ y: 2 }).addTo(source);
root.updateMatrixWorld(true);
const childWorld = Array.from(child.worldMatrix.elements);
const originalVertices = Array.from(geometry.vertices.data);
const originalMatrix = Array.from(source.matrix.elements);
const baked = createPoseBaker(source).mesh;
assert.equal(baked.isSkinnedMesh, false);
assert.equal(baked.name, source.name);
assert.equal(baked.parent, root);
assert.equal(source.parent, null);
assert.equal(source.isDestroyed, false, 'The caller still owns source disposal');
assert.equal(child.parent, baked);
close(Array.from(child.worldMatrix.elements), childWorld, 'Child world transform is preserved');
close(Array.from(baked.matrix.elements), originalMatrix, 'Mesh local transform is preserved');
assert.notEqual(baked.geometry, source.geometry);
assert.notEqual(baked.geometry.uvs.data, geometry.uvs.data, 'Attribute storage is not shared');
assert.deepEqual(Array.from(geometry.vertices.data), originalVertices, 'Input geometry is unchanged');
assert.equal(baked.geometry.skinWeights, null);
assert.equal(baked.geometry.skinIndices, null);
close(Array.from(baked.geometry.vertices.getCopy(0).elements), [5.5, 4, 3], 'Blended position is mesh-local');
close(Array.from(baked.geometry.vertices.getCopy(1).elements), [0, 1, 0], 'Zero weights preserve the vertex');
close(Array.from(baked.geometry.normals.getCopy(0).elements), [.8, .6, 0], 'Normals use inverse transpose');
close(Array.from(baked.geometry.tangents.getCopy(0).elements), [.6, -.8, 0, -1], 'Tangent direction and handedness');
assert.equal(createPoseBaker(baked).mesh, baked, 'Ordinary meshes pass through unchanged');

const pivotMesh = new Hilo3d.SkinnedMesh({ name: 'pivot-pose', geometry, skeleton }).addTo(root);
pivotMesh.setPosition(2, 3, 4).setRotation(12, 25, -5).setScale(2, 1, 3).setPivot(.5, 1, -.25);
const pivotMatrix = Array.from(pivotMesh.matrix.elements);
const pivotBaked = createPoseBaker(pivotMesh).mesh;
close(Array.from(pivotBaked.matrix.elements), pivotMatrix, 'Pivot, rotation and scale are preserved');

const invalidGeometry = geometry.clone();
invalidGeometry.skinIndices.set(0, new Hilo3d.Vector4(4, 1, 0, 0));
const invalid = new Hilo3d.SkinnedMesh({ name: 'invalid-pose', geometry: invalidGeometry, skeleton }).addTo(root);
assert.throws(() => createPoseBaker(invalid).mesh, /invalid joint/);
assert.equal(invalid.parent, root, 'Validation failures leave the live scene attached');
console.log('Pose baker checks passed: 2-joint blending, normalized/interleaved inputs, normals, tangents, transforms, resource ownership and validation.');
