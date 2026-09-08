import { ECOLOGY_OBSTACLES, SEA_LEVEL, WORLD_BOUNDS, isInWorld, isOnBridge, riverBankClearance, riverCenterX, riverHalfWidth, terrainBaseHeight, type EcologyPoint } from './layout.ts';
import type { Locomotion } from './profiles.ts';

export function isTraversable(point: EcologyPoint, radius: number, locomotion: Locomotion): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.z) || !isInWorld(point.x, point.z, radius + 0.08)) return false;
  const riverDistance = Math.abs(point.x - riverCenterX(point.z));
  // Bound the actual Hermite slope across this body's full depth. Tight new
  // bends need more clearance than the former fixed 1.07 multiplier provided.
  const bankClearance = riverBankClearance(point.z, radius);
  if (locomotion === 'aquatic' && riverDistance > riverHalfWidth - bankClearance) return false;
  if (locomotion === 'land' && riverDistance < riverHalfWidth + bankClearance && !isOnBridge(point.x, point.z, radius + 0.04)) return false;
  // The southern notch reaches sea level inside the old ellipse. Ground bodies
  // stay on its dry lip; amphibians may still follow the actual river channel.
  if ((locomotion === 'land' || (locomotion === 'amphibious' && riverDistance >= riverHalfWidth))
    && terrainBaseHeight(point.x, point.z) < SEA_LEVEL + 0.12) return false;
  return ECOLOGY_OBSTACLES.every((obstacle) => Math.hypot(point.x - obstacle.x, point.z - obstacle.z) >= radius + obstacle.radius + 0.07);
}

export function canTraverseSegment(from: EcologyPoint, to: EcologyPoint, radius: number, locomotion: Locomotion): boolean {
  const distance = Math.hypot(to.x - from.x, to.z - from.z);
  const steps = Math.max(1, Math.ceil(distance / 0.12));
  for (let step = 0; step <= steps; step++) {
    const t = step / steps;
    if (!isTraversable({ x: from.x + (to.x - from.x) * t, z: from.z + (to.z - from.z) * t }, radius, locomotion)) return false;
  }
  return true;
}

const SPACING = 0.5;
const COLUMNS = Math.round(WORLD_BOUNDS.x * 2 / SPACING) + 1;
const ROWS = Math.round(WORLD_BOUNDS.z * 2 / SPACING) + 1;
const POINTS: EcologyPoint[] = Array.from({ length: COLUMNS * ROWS }, (_, id) => ({
  x: id % COLUMNS * SPACING - WORLD_BOUNDS.x,
  z: Math.floor(id / COLUMNS) * SPACING - WORLD_BOUNDS.z,
}));
const NEIGHBORS = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]] as const;

class MinHeap {
  items: { id: number; cost: number }[] = [];
  push(item: { id: number; cost: number }): void {
    let index = this.items.length;
    this.items.push(item);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      const above = this.items[parent]!;
      if (above.cost <= item.cost) break;
      this.items[index] = above;
      index = parent;
    }
    this.items[index] = item;
  }
  pop(): { id: number; cost: number } | undefined {
    const top = this.items[0];
    const tail = this.items.pop();
    if (!tail || this.items.length === 0) return top;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.items.length) break;
      const next = right < this.items.length && this.items[right]!.cost < this.items[left]!.cost ? right : left;
      if (this.items[next]!.cost >= tail.cost) break;
      this.items[index] = this.items[next]!;
      index = next;
    }
    this.items[index] = tail;
    return top;
  }
}

/** A* over a shared half-metre grid, with sampled edges and line-of-sight smoothing. */
export function findEcologyPath(from: EcologyPoint, to: EcologyPoint, radius: number, locomotion: Locomotion): EcologyPoint[] {
  if (!isTraversable(from, radius, locomotion) || !isTraversable(to, radius, locomotion)) return [];
  if (canTraverseSegment(from, to, radius, locomotion)) return [{ ...to }];
  if (locomotion === 'aquatic') {
    // A channel follower also serves broad-bodied swimmers for whom a fixed
    // half-metre grid has no cell at a narrow bend. Preserve bank-relative
    // offsets while sampling the actual curve; every edge remains validated.
    const path: EcologyPoint[] = [];
    const steps = Math.max(1, Math.ceil(Math.abs(to.z - from.z) / 0.3));
    const fromOffset = from.x - riverCenterX(from.z);
    const toOffset = to.x - riverCenterX(to.z);
    let previous = from;
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      const z = from.z + (to.z - from.z) * t;
      const point = { x: riverCenterX(z) + fromOffset + (toOffset - fromOffset) * t, z };
      if (!canTraverseSegment(previous, point, radius, locomotion)) return [];
      path.push(point);
      previous = point;
    }
    return path;
  }
  const walkable = new Uint8Array(POINTS.length);
  let start = -1;
  let goal = -1;
  let startDistance = Infinity;
  let goalDistance = Infinity;
  for (let id = 0; id < POINTS.length; id++) {
    const point = POINTS[id]!;
    if (!isTraversable(point, radius, locomotion)) continue;
    walkable[id] = 1;
    const fromDistance = Math.hypot(from.x - point.x, from.z - point.z);
    const toDistance = Math.hypot(to.x - point.x, to.z - point.z);
    if (fromDistance < startDistance && canTraverseSegment(from, point, radius, locomotion)) {
      start = id;
      startDistance = fromDistance;
    }
    if (toDistance < goalDistance && canTraverseSegment(point, to, radius, locomotion)) {
      goal = id;
      goalDistance = toDistance;
    }
  }
  if (start < 0 || goal < 0) return [];
  const frontier = new MinHeap();
  const costs = new Float64Array(POINTS.length).fill(Infinity);
  const previous = new Int32Array(POINTS.length).fill(-1);
  const closed = new Uint8Array(POINTS.length);
  costs[start] = 0;
  frontier.push({ id: start, cost: 0 });
  while (frontier.items.length) {
    const current = frontier.pop()!.id;
    if (closed[current]) continue;
    if (current === goal) break;
    closed[current] = 1;
    const column = current % COLUMNS;
    const row = Math.floor(current / COLUMNS);
    for (const [dx, dz] of NEIGHBORS) {
      const nx = column + dx;
      const nz = row + dz;
      if (nx < 0 || nx >= COLUMNS || nz < 0 || nz >= ROWS) continue;
      const neighbor = nz * COLUMNS + nx;
      if (!walkable[neighbor] || closed[neighbor]) continue;
      const candidate = costs[current]! + Math.hypot(dx, dz) * SPACING;
      if (candidate >= costs[neighbor]! || !canTraverseSegment(POINTS[current]!, POINTS[neighbor]!, radius, locomotion)) continue;
      previous[neighbor] = current;
      costs[neighbor] = candidate;
      const point = POINTS[neighbor]!;
      frontier.push({ id: neighbor, cost: candidate + Math.hypot(point.x - POINTS[goal]!.x, point.z - POINTS[goal]!.z) });
    }
  }
  if (start !== goal && previous[goal] === -1) return [];
  const raw: EcologyPoint[] = [{ ...to }];
  for (let cursor = goal; cursor !== start; cursor = previous[cursor]!) raw.push(POINTS[cursor]!);
  raw.push(POINTS[start]!);
  raw.reverse();
  const smooth: EcologyPoint[] = [];
  let anchor = from;
  for (let index = 0; index < raw.length;) {
    let farthest = index;
    for (let next = index + 1; next < raw.length; next++) {
      if (canTraverseSegment(anchor, raw[next]!, radius, locomotion)) farthest = next;
    }
    anchor = raw[farthest]!;
    smooth.push({ ...anchor });
    index = farthest + 1;
  }
  return smooth;
}
