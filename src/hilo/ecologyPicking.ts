import * as Hilo3d from 'hilo3d';
import { getPoseBounds } from './poseBounds.ts';

export interface EcologyPickResident {
  uid: string;
  rig: Hilo3d.Node;
  meshes: readonly Hilo3d.Mesh[];
  /** Settled displayed dimensions, including the shared scene scale. */
  width: number;
  height: number;
  depth: number;
}

/**
 * Pick the current animated pose, including sleep, throw and happy transforms.
 * The caller updates the stage's world matrices once before this click-time
 * query. A generous sphere rejects distant residents before CPU skin bounds are
 * measured; pose measurements never run in the frame loop.
 */
export function pickEcologyResident(ray: Hilo3d.Ray, residents: Iterable<EcologyPickResident>): string | null {
  let nearest = Infinity;
  let selected: string | null = null;
  const broadCenter = new Hilo3d.Vector3();
  for (const resident of residents) {
    if (!resident.rig.visible) continue;
    const world = resident.rig.worldMatrix.elements;
    broadCenter.set(world[12]!, world[13]! + resident.height * 0.5, world[14]!);
    // Idle dimensions only bound the inexpensive broad phase. They are never
    // used as the final hit target: a lying body can be wider and off-centre.
    const broadRadius = Math.max(0.6, Math.hypot(resident.width, resident.height, resident.depth) * 1.5);
    if (!ray.intersectsSphere(broadCenter.elements, broadRadius)) continue;
    const bounds = getPoseBounds(resident.meshes);
    if (!bounds) continue;
    const hit = ray.intersectsBox([
      [bounds.xMin, bounds.yMin, bounds.zMin],
      [bounds.xMax, bounds.yMax, bounds.zMax],
    ]);
    if (!hit) continue;
    const distance = Math.hypot(hit.x - ray.origin.x, hit.y - ray.origin.y, hit.z - ray.origin.z);
    if (distance < nearest) { nearest = distance; selected = resident.uid; }
  }
  return selected;
}
