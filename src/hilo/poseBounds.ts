import * as Hilo3d from 'hilo3d';

/** Measure the displayed pose once for framing, without replacing GPU-skinned geometry.
 * Call after updating the model's world matrices and before attaching it to the gallery rig.
 */
export function getPoseBounds(meshes: readonly Hilo3d.Mesh[]): Hilo3d.Bounds | undefined {
  let xMin = Infinity, yMin = Infinity, zMin = Infinity;
  let xMax = -Infinity, yMax = -Infinity, zMax = -Infinity;
  const vertex = new Hilo3d.Vector3();
  const weights = new Hilo3d.Vector4();
  const indices = new Hilo3d.Vector4();
  const blended = new Hilo3d.Matrix4();
  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    const positions = geometry?.vertices;
    if (!geometry || !positions) continue;
    const palette = mesh instanceof Hilo3d.SkinnedMesh && mesh.skeleton ? mesh.getJointMat() : null;
    const skinWeights = geometry.skinWeights;
    const skinIndices = geometry.skinIndices;
    if (palette && (!skinWeights || !skinIndices)) throw new Error(`Missing skin attributes for ${mesh.name}`);
    const decode = geometry.positionDecodeMat ? new Hilo3d.Matrix4().fromArray(geometry.positionDecodeMat) : null;
    for (let index = 0; index < positions.count; index++) {
      // GeometryData getters reuse scratch vectors: copy before reading another attribute.
      vertex.copy(positions.get(index) as Hilo3d.Vector3);
      if (decode) vertex.transformMat4(decode);
      if (palette && skinWeights && skinIndices) {
        weights.copy(skinWeights.get(index) as Hilo3d.Vector4);
        indices.copy(skinIndices.get(index) as Hilo3d.Vector4);
        const total = weights.x + weights.y + weights.z + weights.w;
        if (total > 1e-8) {
          for (let component = 0; component < 16; component++) blended.elements[component] = 0;
          for (let influence = 0; influence < 4; influence++) {
            const weight = weights.elements[influence]! / total;
            if (weight === 0) continue;
            const joint = indices.elements[influence]!;
            if (!Number.isInteger(joint) || joint < 0 || (joint + 1) * 16 > palette.length) {
              throw new Error(`Invalid skin joint for ${mesh.name}`);
            }
            for (let component = 0; component < 16; component++) {
              blended.elements[component] = blended.elements[component]! + palette[joint * 16 + component]! * weight;
            }
          }
          vertex.transformMat4(blended);
        }
      }
      vertex.transformMat4(mesh.worldMatrix);
      if (!Number.isFinite(vertex.x) || !Number.isFinite(vertex.y) || !Number.isFinite(vertex.z)) {
        throw new Error(`Invalid pose bounds for ${mesh.name}`);
      }
      xMin = Math.min(xMin, vertex.x); yMin = Math.min(yMin, vertex.y); zMin = Math.min(zMin, vertex.z);
      xMax = Math.max(xMax, vertex.x); yMax = Math.max(yMax, vertex.y); zMax = Math.max(zMax, vertex.z);
    }
  }
  if (xMin === Infinity) return undefined;
  return {
    xMin, yMin, zMin, xMax, yMax, zMax,
    x: (xMin + xMax) / 2, y: (yMin + yMax) / 2, z: (zMin + zMax) / 2,
    width: xMax - xMin, height: yMax - yMin, depth: zMax - zMin,
  };
}
