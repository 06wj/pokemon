import * as Hilo3d from 'hilo3d';

/** GeometryData.get() exposes the stored integers, even for normalized GPU attributes. */
function readAttribute(attribute: Hilo3d.GeometryData, index: number, output: number[]): void {
  const value = attribute.get(index);
  const elements = typeof value === 'number' ? [value] : value.elements;
  const storage = attribute.data;
  for (let component = 0; component < attribute.size; component++) {
    let scalar = elements[component] ?? 0;
    if (attribute.normalized) {
      if (storage instanceof Uint8Array || storage instanceof Uint8ClampedArray) scalar /= 255;
      else if (storage instanceof Uint16Array) scalar /= 65535;
      else if (storage instanceof Uint32Array) scalar /= 4294967295;
      else if (storage instanceof Int8Array) scalar = Math.max(-1, scalar / 127);
      else if (storage instanceof Int16Array) scalar = Math.max(-1, scalar / 32767);
      else if (storage instanceof Int32Array) scalar = Math.max(-1, scalar / 2147483647);
    }
    output[component] = scalar;
  }
}

function transformDirection(vector: Hilo3d.Vector3, matrix: Hilo3d.Matrix4): void {
  const { x, y, z } = vector;
  const elements = matrix.elements;
  vector.set(
    elements[0]! * x + elements[4]! * y + elements[8]! * z,
    elements[1]! * x + elements[5]! * y + elements[9]! * z,
    elements[2]! * x + elements[6]! * y + elements[10]! * z,
  ).normalize();
}

/**
 * Reusable CPU skinning for WebGL2 devices whose uniform blocks cannot fit the engine palette.
 * The caller owns the detached source mesh; animation channels continue to target its transforms.
 */
export interface PoseBaker {
  mesh: Hilo3d.Mesh;
  /** Sync an animated source transform before the model's world matrices are updated. */
  syncTransform(): void;
  /** Update vertex streams after world matrices and animation channels have been evaluated. */
  update(): void;
}

export function createPoseBaker(mesh: Hilo3d.Mesh, replace = true): PoseBaker {
  if (!(mesh instanceof Hilo3d.SkinnedMesh)) return { mesh, syncTransform() {}, update() {} };
  const source = mesh.geometry;
  const vertices = source?.vertices;
  const weights = source?.skinWeights;
  const indices = source?.skinIndices;
  if (!source || !vertices || !weights || !indices) {
    throw new Error(`Cannot bake ${mesh.name}: missing skinning geometry.`);
  }
  if (vertices.size !== 3 || weights.size !== 4 || indices.size !== 4
    || weights.count !== vertices.count || indices.count !== vertices.count) {
    throw new Error(`Cannot bake ${mesh.name}: inconsistent skinning attributes.`);
  }

  // getJointMat() supplies inverse(meshWorld) × jointWorld × inverseBind, in mesh-local space.
  let root: Hilo3d.Node = mesh;
  while (root.parent) root = root.parent;
  root.updateMatrixWorld(true);
  let joints = mesh.getJointMat();
  const normals = source.normals;
  // Missing tangent streams are generated lazily by these getters and require their UV set.
  const tangents = source.uvs ? source.tangents : null;
  const tangents1 = source.uvs1 ? source.tangents1 : null;
  const geometry = source.clone();
  const positionsOut = new Hilo3d.GeometryData(new Float32Array(vertices.count * 3), 3);
  const normalsOut = normals ? new Hilo3d.GeometryData(new Float32Array(vertices.count * 3), 3) : null;
  const tangentsOut = tangents ? new Hilo3d.GeometryData(new Float32Array(vertices.count * 4), 4) : null;
  const tangents1Out = tangents1 ? new Hilo3d.GeometryData(new Float32Array(vertices.count * 4), 4) : null;
  const positionDecode = source.positionDecodeMat ? new Hilo3d.Matrix4().fromArray(source.positionDecodeMat) : null;
  const normalDecode = source.normalDecodeMat ? new Hilo3d.Matrix4().fromArray(source.normalDecodeMat) : null;
  const blended = new Hilo3d.Matrix4();
  const normalMatrix = new Hilo3d.Matrix4();
  const position = new Hilo3d.Vector3();
  const normal = new Hilo3d.Vector3();
  const tangent = new Hilo3d.Vector3();
  const tangentOutput = new Hilo3d.Vector4();
  const vertexValues: number[] = [];
  const weightValues: number[] = [];
  const indexValues: number[] = [];
  const normalValues: number[] = [];
  const tangentValues: number[] = [];
  const tangentStreams = [[tangents, tangentsOut], [tangents1, tangents1Out]] as const;

  const updateVertices = (): void => {
    joints = mesh.getJointMat();
    for (let vertex = 0; vertex < vertices.count; vertex++) {
      // Copy each getter result immediately: Hilo3D reuses its temporary vector between attributes.
      readAttribute(weights, vertex, weightValues);
      readAttribute(indices, vertex, indexValues);
      const weightTotal = weightValues.reduce((sum, weight) => sum + weight, 0);
      for (let component = 0; component < 16; component++) blended.elements[component] = 0;
      if (!Number.isFinite(weightTotal) || weightValues.some((weight) => weight < 0)) {
        throw new Error(`Cannot bake ${mesh.name}: invalid weights at vertex ${vertex}.`);
      }
      if (weightTotal <= 1e-8) blended.identity();
      else {
        for (let influence = 0; influence < 4; influence++) {
          const weight = weightValues[influence]! / weightTotal;
          if (weight === 0) continue;
          const joint = indexValues[influence]!;
          if (!Number.isInteger(joint) || joint < 0 || (joint + 1) * 16 > joints.length) {
            throw new Error(`Cannot bake ${mesh.name}: invalid joint at vertex ${vertex}.`);
          }
          for (let component = 0; component < 16; component++) {
            blended.elements[component] = blended.elements[component]! + joints[joint * 16 + component]! * weight;
          }
        }
      }

      readAttribute(vertices, vertex, vertexValues);
      position.set(vertexValues[0]!, vertexValues[1]!, vertexValues[2]!);
      if (positionDecode) position.transformMat4(positionDecode);
      position.transformMat4(blended);
      (positionsOut.data as Float32Array).set(position.elements, vertex * 3);

      if (normals && normalsOut) {
        // Authored idle clips can collapse unused vines with zero-scale bones.
        if (Math.abs(blended.determinant()) < 1e-12) normalMatrix.copy(blended);
        else normalMatrix.invert(blended).transpose();
        readAttribute(normals, vertex, normalValues);
        normal.set(normalValues[0]!, normalValues[1]!, normalValues[2]!);
        if (normalDecode) normal.transformMat4(normalDecode);
        transformDirection(normal, normalMatrix);
        (normalsOut.data as Float32Array).set(normal.elements, vertex * 3);
      }

      for (const [input, output] of tangentStreams) {
        if (!input || !output) continue;
        readAttribute(input, vertex, tangentValues);
        tangent.set(tangentValues[0]!, tangentValues[1]!, tangentValues[2]!);
        transformDirection(tangent, blended);
        tangentOutput.set(tangent.x, tangent.y, tangent.z, tangentValues[3] ?? 1);
        (output.data as Float32Array).set(tangentOutput.elements, vertex * 4);
      }
    }

    for (const attribute of [positionsOut, normalsOut, tangentsOut, tangents1Out]) {
      if (attribute) attribute.isDirty = true;
    }
    geometry.isDirty = true;
    geometry.getLocalBounds(true);
  };
  // Validate and bake before replacing any live node, preserving transactional loading.
  updateVertices();

  geometry.vertices = positionsOut;
  geometry.normals = normalsOut;
  geometry.tangents = tangentsOut;
  geometry.tangents1 = tangents1Out;
  geometry.skinWeights = null;
  geometry.skinIndices = null;
  geometry.positionDecodeMat = null;
  geometry.normalDecodeMat = null;
  geometry.isDirty = true;
  geometry.getLocalBounds(true);

  const baked = new Hilo3d.Mesh({
    name: mesh.name,
    geometry,
    material: mesh.material,
    visible: mesh.visible,
    layer: mesh.layer,
    renderOrder: mesh.renderOrder,
    castShadows: mesh.castShadows,
    receiveShadows: mesh.receiveShadows,
    useInstanced: mesh.useInstanced,
    instanceCount: mesh.instanceCount,
    frustumTest: mesh.frustumTest,
    pointerEnabled: mesh.pointerEnabled,
    pointerChildren: mesh.pointerChildren,
    userData: mesh.userData,
  });
  const syncTransform = (): void => {
    // Copy TRS directly: decomposing a zero-scale mesh matrix produces invalid rotations.
    baked.pivot.copy(mesh.pivot);
    baked.position.copy(mesh.position);
    baked.quaternion.copy(mesh.quaternion);
    baked.setScale(mesh.scaleX, mesh.scaleY, mesh.scaleZ);
  };
  syncTransform();
  if (replace) {
    for (const child of [...mesh.children]) child.addTo(baked);
    if (mesh.parent) baked.addTo(mesh.parent);
    mesh.removeFromParent();
    baked.updateMatrixWorld(true);
  } else baked.worldMatrix.copy(mesh.worldMatrix);
  return {
    mesh: baked,
    syncTransform,
    update(): void {
      // The source remains detached but is still targeted by glTF animation channels.
      // Its skin palette must use the replacement's complete world transform.
      mesh.worldMatrix.copy(baked.worldMatrix);
      updateVertices();
    },
  };
}
