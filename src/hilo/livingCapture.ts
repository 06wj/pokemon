import * as Hilo3d from 'hilo3d';
import { COASTAL_LAYOUT, isInWorld, isInRiver, terrainBaseHeight, waterSurfaceHeight, type EcologyPoint } from '../ecology/layout';

/** Solve against the actual ground/water surface, never the infinite sea. */
export function pickLivingGround(ray: Hilo3d.Ray): EcologyPoint | null {
  if (ray.direction.y >= -0.001) return null;
  let t = -ray.origin.y / ray.direction.y;
  if (t < 0 || !Number.isFinite(t)) return null;
  for (let i = 0; i < 8; i++) {
    const x = ray.origin.x + ray.direction.x * t;
    const z = ray.origin.z + ray.direction.z * t;
    const h = isInRiver(x, z) ? waterSurfaceHeight(z) : terrainBaseHeight(x, z);
    const next = (h - ray.origin.y) / ray.direction.y;
    if (Math.abs(next - t) < .001) { t = next; break; }
    t = next;
  }
  const result = { x: ray.origin.x + ray.direction.x * t, z: ray.origin.z + ray.direction.z * t };
  return t >= 0 && isInWorld(result.x, result.z, .15)
    && (isInRiver(result.x, result.z) || terrainBaseHeight(result.x, result.z) > COASTAL_LAYOUT.coast.seaLevel + .12)
    ? result : null;
}

export interface PhotoBounds {
  xMin: number;
  yMin: number;
  zMin: number;
  xMax: number;
  yMax: number;
  zMax: number;
}

export interface PhotoSubject {
  uid: string;
  pokemonId: string;
  name: string;
  rig: Hilo3d.Node;
  height: number;
  width: number;
  /** Current displayed pose in world coordinates, measured once at shutter time. */
  bounds?: PhotoBounds;
}

function subjectBounds(subject: PhotoSubject): PhotoBounds | null {
  const bounds = subject.bounds ?? {
    xMin: subject.rig.x - subject.width / 2, xMax: subject.rig.x + subject.width / 2,
    yMin: subject.rig.y, yMax: subject.rig.y + subject.height,
    zMin: subject.rig.z - subject.width / 2, zMax: subject.rig.z + subject.width / 2,
  };
  return Object.values(bounds).every(Number.isFinite)
    && bounds.xMax >= bounds.xMin && bounds.yMax >= bounds.yMin && bounds.zMax >= bounds.zMin
    ? bounds : null;
}

/** Ray direction is normalized, so the returned entry parameter is a distance. */
function boundsHitDistance(ray: Hilo3d.Ray, bounds: PhotoBounds): number | null {
  let near = 0, far = Infinity;
  for (const axis of ['x', 'y', 'z'] as const) {
    const origin = ray.origin[axis], direction = ray.direction[axis];
    const minimum = bounds[`${axis}Min`], maximum = bounds[`${axis}Max`];
    if (Math.abs(direction) < 1e-8) {
      if (origin < minimum || origin > maximum) return null;
      continue;
    }
    const first = (minimum - origin) / direction, second = (maximum - origin) / direction;
    near = Math.max(near, Math.min(first, second));
    far = Math.min(far, Math.max(first, second));
    if (near > far) return null;
  }
  return far >= 0 ? near : null;
}

/** Credit a resident only when a head/body/side sample is visible. Current pose
 * bounds keep a sleeping resident's samples on its actual body. The caller owns
 * the one-time pose measurement; this function never skins meshes or updates AI. */
export function subjectIsVisible(subject: PhotoSubject, camera: Hilo3d.PerspectiveCamera,
  occluders: readonly Hilo3d.Mesh[], pixelHeight: number,
  otherSubjects: readonly PhotoSubject[] = []): boolean {
  if (!subject.rig.visible) return false;
  const bounds = subjectBounds(subject);
  if (!bounds) return false;
  const centerX = (bounds.xMin + bounds.xMax) / 2, centerZ = (bounds.zMin + bounds.zMax) / 2;
  const height = bounds.yMax - bounds.yMin, width = bounds.xMax - bounds.xMin, depth = bounds.zMax - bounds.zMin;
  const origin = new Hilo3d.Vector3(camera.x, camera.y, camera.z);
  const p = new Hilo3d.Vector3();
  const direction = new Hilo3d.Vector3();
  const ray = new Hilo3d.Ray();
  // Camera-facing lateral samples stay inside the AABB even for a wide sleeping
  // pose viewed diagonally. This catches a visible shoulder beside a foreground
  // resident instead of rejecting everyone whose center happens to be hidden.
  const viewX = origin.x - centerX, viewZ = origin.z - centerZ;
  const viewLength = Math.hypot(viewX, viewZ);
  const rightX = viewLength > 1e-8 ? viewZ / viewLength : 1;
  const rightZ = viewLength > 1e-8 ? -viewX / viewLength : 0;
  const projectedWidth = Math.abs(rightX) * width + Math.abs(rightZ) * depth;
  const blockers = otherSubjects.flatMap((other) => {
    if (other.uid === subject.uid || !other.rig.visible) return [];
    const otherBounds = subjectBounds(other);
    return otherBounds ? [otherBounds] : [];
  });
  for (const [level, side] of [[.76, 0], [.43, 0], [.48, -1], [.48, 1], [.20, 0]] as const) {
    p.set(centerX + side * rightX * width * .34, bounds.yMin + height * level,
      centerZ + side * rightZ * depth * .34);
    if (!camera.isPointVisible(p)) continue;
    const distance = Math.hypot(p.x - origin.x, p.y - origin.y, p.z - origin.z);
    if (distance < 1e-6) continue;
    const pixels = Math.max(projectedWidth, height) / Math.max(.1, distance)
      * pixelHeight / (2 * Math.tan(camera.fov * Math.PI / 360));
    if (pixels < 6) continue;
    ray.set(origin, direction.set(p.x - origin.x, p.y - origin.y, p.z - origin.z).normalize());
    let hidden = false;
    for (const mesh of occluders) {
      if (!mesh.visible) continue;
      const hits = mesh.raycast(ray, false);
      if (hits?.some((hit) => Math.hypot(hit.x - origin.x, hit.y - origin.y, hit.z - origin.z) < distance - .12)) {
        hidden = true; break;
      }
    }
    if (!hidden) for (const otherBounds of blockers) {
      const hitDistance = boundsHitDistance(ray, otherBounds);
      if (hitDistance !== null && hitDistance < distance - .1) {
        hidden = true; break;
      }
    }
    if (!hidden) return true;
  }
  return false;
}
